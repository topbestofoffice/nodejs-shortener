import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProductionStartupAllowed,
  productionPm2DeploymentConfigurationSha256,
  productionRuntimeConfigurationSha256,
} from "../src/config/production-startup.js";
import { loadRuntimeConfig, type RuntimeConfig } from "../src/config/runtime.js";

const roots: string[] = [];
const targetId = "cloudways-app-6598284";
const now = new Date("2026-09-01T12:00:00.000Z");
const readinessRequiredChecks: Readonly<Record<string, readonly string[]>> = {
  "exact-schema-db-redis-parity": ["schema-fingerprint", "database-contract", "redis-contract"],
  "redirect-shadow-parity": ["php-node-shadow-diff", "redirect-failure-matrix"],
  "delivered-country-and-reporting-parity": ["delivered-country-contract", "reporting-completeness"],
  "operator-feature-parity": ["dashboard-admin-registration", "single-and-multi-domain"],
  "image-crash-recovery": ["atomic-admission", "restart-reconciliation", "disk-backup-restore"],
  "cloudways-proxy-and-storage-proof": ["proxy-header-proof", "storage-persistence", "pm2-restart"],
  "country-fallback-policy": ["privacy-availability-rate-limit-policy"],
  "all-source-runtime-tests": ["clean-install-tests", "coverage-threshold", "runtime-failure-tests"],
  "same-size-performance-proof": ["feature-equivalent-benchmark", "resource-acceptance"],
  "one-writer-cutover-and-rollback": ["release-config-compatibility", "one-writer-proof", "rollback-rehearsal"],
  "owner-pilot-deployment-authorization": ["exact-pilot-target-authorization"],
  "owner-production-deployment-authorization": ["exact-production-target-authorization"],
};
const releaseEvidenceGates = new Set([
  "one-writer-cutover-and-rollback",
  "owner-production-deployment-authorization",
]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("target-scoped production startup activation", () => {
  it("allows only the exact production target, artifact and runtime configuration", async () => {
    const fixture = await activatedFixture();

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).not.toThrow();
  });

  it("restarts under a still-valid activation after its issuance-time receipts expire", async () => {
    const fixture = await activatedFixture({
      activationExpiresAt: "2026-09-20T12:00:00.000Z",
    });

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now: new Date("2026-09-10T12:00:00.000Z"),
      projectRoot: fixture.root,
    })).not.toThrow();
  });

  it("does not let an old receipt authorize a newly issued activation", async () => {
    const fixture = await activatedFixture({
      activationIssuedAt: "2026-09-10T11:59:00.000Z",
      activationExpiresAt: "2026-09-20T12:00:00.000Z",
    });

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now: new Date("2026-09-10T12:00:00.000Z"),
      projectRoot: fixture.root,
    })).toThrow(/lacks fresh target-bound canonical evidence/);
  });

  it("accepts release activation only when pilot- and release-bound receipts use their canonical stages", async () => {
    const fixture = await activatedFixture({ stage: "release" });

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).not.toThrow();

    const wrongStage = await activatedFixture({
      stage: "release",
      wrongEvidenceStageGate: "one-writer-cutover-and-rollback",
    });
    expect(() => assertProductionStartupAllowed(wrongStage.config, {
      environment: wrongStage.environment,
      now,
      projectRoot: wrongStage.root,
    })).toThrow("one-writer-cutover-and-rollback lacks fresh target-bound canonical evidence");

    const missingCompatibility = await activatedFixture({
      stage: "release",
      omittedCheck: "release-config-compatibility",
    });
    expect(() => assertProductionStartupAllowed(missingCompatibility.config, {
      environment: missingCompatibility.environment,
      now,
      projectRoot: missingCompatibility.root,
    })).toThrow("one-writer-cutover-and-rollback lacks fresh target-bound canonical evidence");

    const wrongPilotBinding = await activatedFixture({
      stage: "release",
      relatedPilotConfigurationSha256: "d".repeat(64),
    });
    expect(() => assertProductionStartupAllowed(wrongPilotBinding.config, {
      environment: wrongPilotBinding.environment,
      now,
      projectRoot: wrongPilotBinding.root,
    })).toThrow("one-writer-cutover-and-rollback lacks fresh target-bound canonical evidence");
  });

  it("rejects reuse for another deployment target or a generic target id", async () => {
    const fixture = await activatedFixture();

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: { ...fixture.environment, NODE_SHORTENER_DEPLOYMENT_TARGET_ID: "cloudways-app-6639209" },
      now,
      projectRoot: fixture.root,
    })).toThrow("Activation subject does not match this runtime.");
    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: { ...fixture.environment, NODE_SHORTENER_DEPLOYMENT_TARGET_ID: "all" },
      now,
      projectRoot: fixture.root,
    })).toThrow("must identify one exact deployment");
  });

  it("rejects runtime drift after activation", async () => {
    const fixture = await activatedFixture();
    const drifted = { ...fixture.config, appNamespace: "different-production-namespace" } as RuntimeConfig;

    expect(() => assertProductionStartupAllowed(drifted, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).toThrow("Activation subject does not match this runtime.");
  });

  it("binds link and upload capacity limits into the activated runtime digest", async () => {
    const fixture = await activatedFixture();
    const drifted = {
      ...fixture.config,
      links: { ...fixture.config.links, maxBulkLinks: fixture.config.links.maxBulkLinks + 1 },
      image: { ...fixture.config.image, readyTotal: fixture.config.image.readyTotal + 1 },
    } as RuntimeConfig;

    expect(() => assertProductionStartupAllowed(drifted, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).toThrow("Activation subject does not match this runtime.");
  });

  it("binds logging and effective PM2 resource settings into the activated runtime digest", async () => {
    const fixture = await activatedFixture();
    const loggingDrift = { ...fixture.config, logLevel: "trace" } as RuntimeConfig;
    const processDrift = {
      ...fixture.config,
      operations: { ...fixture.config.operations, webInstances: 2 },
    } as RuntimeConfig;

    for (const drifted of [loggingDrift, processDrift]) {
      expect(() => assertProductionStartupAllowed(drifted, {
        environment: fixture.environment,
        now,
        projectRoot: fixture.root,
      })).toThrow("Activation subject does not match this runtime.");
    }
  });

  it("rejects drift in the exact activation-bound PM2 CLI file", async () => {
    const fixture = await activatedFixture();
    await writeFile(fixture.environment.PM2_CLI_SCRIPT!, "changed PM2 CLI bytes", "utf8");
    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).toThrow("Activation subject does not match this runtime.");
  });

  it("binds reporting, trusted-header proof and domain reporting semantics", async () => {
    const fixture = await activatedFixture();
    const definitions = fixture.config.registry.all();
    const registry = {
      all: () => definitions.map((domain) => ({
        ...domain,
        diversionCampaign: `${domain.diversionCampaign}-changed`,
        reportTimezone: domain.reportTimezone === "UTC" ? "Asia/Kolkata" as const : "UTC" as const,
        emitLocalImageAlt: !domain.emitLocalImageAlt,
        compactNoImagePreview: !domain.compactNoImagePreview,
        creationFallback: !domain.creationFallback,
        acceptUnprovenDeliveredClaim: !domain.acceptUnprovenDeliveredClaim,
      })),
    } as unknown as RuntimeConfig["registry"];
    const drifts = [
      { ...fixture.config, reporting: { deliveredCountryDomainIds: [1] } } as RuntimeConfig,
      { ...fixture.config, cloudflareHeaderSanitizationVerified: true } as RuntimeConfig,
      {
        ...fixture.config,
        analytics: { enabled: true, measurementId: "G-ABC123", siteKey: "shortener_pilot" },
      } as RuntimeConfig,
      { ...fixture.config, registry } as RuntimeConfig,
    ];

    for (const drifted of drifts) {
      expect(productionRuntimeConfigurationSha256(drifted)).not.toBe(
        productionRuntimeConfigurationSha256(fixture.config),
      );
      expect(() => assertProductionStartupAllowed(drifted, {
        environment: fixture.environment,
        now,
        projectRoot: fixture.root,
      })).toThrow("Activation subject does not match this runtime.");
    }
  });

  it("rejects artifact drift even when the activation file itself is unchanged", async () => {
    const fixture = await activatedFixture();
    await writeFile(join(fixture.root, "dist/server.js"), "tampered server", "utf8");

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).toThrow("artifact file digest does not match");
  });

  it.each([
    "package.json",
    "public/assets/dashboard-shell.css",
    "public/assets/dashboard-shell.js",
  ])("binds runtime metadata and UI asset %s to the activation", async (path) => {
    const fixture = await activatedFixture();
    await writeFile(join(fixture.root, ...path.split("/")), "tampered runtime artifact", "utf8");

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).toThrow("artifact file digest does not match");
  });

  it("rejects a correctly hashed activation while readiness gates are still pending", async () => {
    const fixture = await activatedFixture({ verifiedReadiness: false });

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).toThrow("is not evidence-backed and verified");
  });

  it("rejects a missing readiness receipt even when the signed document calls the gate verified", async () => {
    const fixture = await activatedFixture();
    await rm(join(fixture.root, "evidence/readiness/exact-schema-db-redis-parity.json"));

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).toThrow(/ENOENT/u);
  });

  it("rejects readiness receipt bytes that no longer match their signed digest", async () => {
    const fixture = await activatedFixture();
    await writeFile(
      join(fixture.root, "evidence/readiness/exact-schema-db-redis-parity.json"),
      "tampered receipt",
      "utf8",
    );

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).toThrow("evidence receipt digest does not match");
  });

  it("rejects an arbitrary hashed JSON file instead of accepting it as proof", async () => {
    const fixture = await activatedFixture({ arbitraryReceiptGate: "exact-schema-db-redis-parity" });

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).toThrow("Invalid gate exact-schema-db-redis-parity evidence receipt");
  });

  it.each([
    [{ receiptTargetId: "cloudways-app-6639209" }, "exact-schema-db-redis-parity"],
    [{ capturedAt: "2026-08-20T12:00:00.000Z", expiresAt: "2026-08-21T12:00:00.000Z" },
      "exact-schema-db-redis-parity"],
    [{ omittedCheck: "restart-reconciliation" }, "image-crash-recovery"],
  ] as const)("rejects target-mismatched, stale, or incomplete readiness evidence", async (options, gateId) => {
    const fixture = await activatedFixture(options);

    expect(() => assertProductionStartupAllowed(fixture.config, {
      environment: fixture.environment,
      now,
      projectRoot: fixture.root,
    })).toThrow(`Production-readiness gate ${gateId} lacks fresh target-bound canonical evidence.`);
  });
});

interface ActivatedFixture {
  readonly root: string;
  readonly config: RuntimeConfig;
  readonly environment: NodeJS.ProcessEnv;
}

interface ActivatedFixtureOptions {
  readonly verifiedReadiness?: boolean;
  readonly stage?: "pilot" | "release";
  readonly arbitraryReceiptGate?: string;
  readonly wrongEvidenceStageGate?: string;
  readonly receiptTargetId?: string;
  readonly capturedAt?: string;
  readonly expiresAt?: string;
  readonly omittedCheck?: string;
  readonly relatedPilotConfigurationSha256?: string;
  readonly activationIssuedAt?: string;
  readonly activationExpiresAt?: string;
}

async function activatedFixture(options: ActivatedFixtureOptions = {}): Promise<ActivatedFixture> {
  const privateRoot = await mkdtemp(join(tmpdir(), "node-shortener-activation-"));
  roots.push(privateRoot);
  const root = resolve(privateRoot, "releases/release-a");
  await mkdir(root, { recursive: true });
  const files: Readonly<Record<string, string>> = {
    "config/domains.json": JSON.stringify([{
      id: 1,
      key: "url6x",
      canonicalHost: "url6x.example",
      aliases: ["www.url6x.example"],
      label: "URL6X",
      surface: "dashboard",
      active: true,
      allowCreate: false,
      publicBaseUrl: "https://url6x.example",
      imageBaseUrl: "https://url6x.example",
    }]),
    "data/datacenter-ranges.json": "[]",
    "dist/config/production-startup.js": "synthetic startup module",
    "dist/server.js": "synthetic server",
    "dist/workers/image-worker.js": "synthetic worker",
    "ecosystem.config.cjs": "synthetic pm2 configuration",
    "config/required-schema-contract.json": "synthetic schema contract",
    "database/001_image_job_ledger.sql": "synthetic image ledger schema",
    "database/002_links_recent_activity_epochs.sql": "synthetic activity delta",
    "database/003_runtime_schema_contract_marker.sql": "synthetic schema marker delta",
    "package.json": JSON.stringify({ name: "nodejs-shortener", type: "module" }),
    "package-lock.json": "synthetic package lock",
    "public/assets/dashboard-shell.css": "synthetic dashboard stylesheet",
    "public/assets/dashboard-shell.js": "synthetic dashboard client",
  };
  for (const [path, content] of Object.entries(files)) await writeProjectFile(root, path, content);

  const config = await loadRuntimeConfig({
    NODE_ENV: "production",
    DOMAIN_CONFIG_FILE: "config/domains.json",
    APP_NAMESPACE: "url6x-production",
    ORIGIN_AUTH_ENABLED: "true",
    ORIGIN_AUTH_SHA256: "a".repeat(64),
    IP_HASH_SECRET: "i".repeat(32),
    COOKIE_SIGNING_SECRET: "c".repeat(32),
    STORAGE_DRIVER: "mysql",
    MYSQL_DATABASE: "url6x_production",
    MYSQL_PASSWORD: "synthetic-database-password",
    IMAGE_EXECUTOR: "bullmq",
    PROXY_CHAIN_VERIFIED: "true",
    TRUST_PROXY: "loopback",
    REDIRECT_ENGINE: "current",
    DATACENTER_RANGES_FILE: "data/datacenter-ranges.json",
  }, root);

  const artifactPaths = Object.keys(files).filter((path) => path !== "config/domains.json");
  const artifactManifest = {
    schemaVersion: 1,
    kind: "nodejs-shortener-artifact-manifest",
    files: artifactPaths.map((path) => ({ path, sha256: digest(files[path] ?? "") })),
  };
  const artifactManifestPath = "private/activation/artifact-manifest.json";
  const artifactManifestJson = JSON.stringify(artifactManifest);
  await writeProjectFile(root, artifactManifestPath, artifactManifestJson);

  const runtimeConfigurationSha256 = productionRuntimeConfigurationSha256(config);
  const pm2Home = resolve(privateRoot, "pm2");
  await mkdir(pm2Home, { recursive: true });
  const pm2CliScript = resolve(privateRoot, "runtime/pm2-cli.js");
  await mkdir(dirname(pm2CliScript), { recursive: true });
  await writeFile(pm2CliScript, "synthetic external PM2 CLI", "utf8");
  const pm2DeploymentConfigurationSha256 = productionPm2DeploymentConfigurationSha256(
    config,
    pm2Home,
    process.execPath,
    privateRoot,
    root,
    pm2CliScript,
    "6.2.0",
  );
  const artifactManifestSha256 = digest(artifactManifestJson);
  const stage = options.stage ?? "pilot";
  const pilotTargetId = stage === "release" ? "cloudways-pilot-app-6598283" : targetId;
  const pilotConfigurationSha256 = stage === "release" ? "c".repeat(64) : runtimeConfigurationSha256;
  const readiness = JSON.parse(await readFile(
    resolve(import.meta.dirname, "../config/production-readiness.json"),
    "utf8",
  )) as {
    deployments: { pilot: unknown; release: unknown };
    gates: { id: string; requiredBefore: string; status: string; evidence: unknown[] }[];
  };
  readiness.deployments.pilot = {
    targetId: pilotTargetId,
    artifactSha256: artifactManifestSha256,
    configurationSha256: pilotConfigurationSha256,
  };
  if (stage === "release") {
    readiness.deployments.release = {
      targetId,
      artifactSha256: artifactManifestSha256,
      configurationSha256: runtimeConfigurationSha256,
    };
  }
  for (const gate of readiness.gates) {
    if ((stage === "release" || gate.requiredBefore === "pilot") && options.verifiedReadiness !== false) {
      gate.status = "verified";
      const checks = readinessRequiredChecks[gate.id];
      if (checks === undefined) throw new Error(`Missing fixture checks for ${gate.id}.`);
      const canonicalEvidenceStage = releaseEvidenceGates.has(gate.id) ? "release" : "pilot";
      const receiptStage = options.wrongEvidenceStageGate === gate.id
        ? canonicalEvidenceStage === "pilot" ? "release" : "pilot"
        : canonicalEvidenceStage;
      const receiptTargetId = receiptStage === "release" ? targetId : pilotTargetId;
      const receiptConfigurationSha256 = receiptStage === "release"
        ? runtimeConfigurationSha256
        : pilotConfigurationSha256;
      const receipt = options.arbitraryReceiptGate === gate.id
        ? "arbitrary JSON with a valid outer digest"
        : {
            schemaVersion: 2,
            kind: "nodejs-shortener-readiness-receipt",
            gateId: gate.id,
            stage: receiptStage,
            result: "pass",
            capturedAt: options.capturedAt ?? "2026-09-01T11:00:00.000Z",
            expiresAt: options.expiresAt ?? "2026-09-02T11:00:00.000Z",
            subject: {
              project: "nodejs-shortener",
              targetId: options.receiptTargetId ?? receiptTargetId,
              artifactSha256: artifactManifestSha256,
              configurationSha256: receiptConfigurationSha256,
            },
            related: {
              pilotConfigurationSha256: receiptStage === "release"
                ? options.relatedPilotConfigurationSha256 ?? pilotConfigurationSha256
                : null,
            },
            checks: checks
              .filter((id) => id !== options.omittedCheck)
              .map((id) => ({ id, result: "pass", observed: `Synthetic startup proof for ${id}.` })),
          };
      const receiptJson = JSON.stringify(receipt);
      const receiptPath = `evidence/readiness/${gate.id}.json`;
      await writeProjectFile(root, receiptPath, receiptJson);
      gate.evidence = [{ path: receiptPath, sha256: digest(receiptJson) }];
    }
  }
  const readinessJson = JSON.stringify(readiness);
  await writeProjectFile(root, "config/production-readiness.json", readinessJson);
  const immutableReadinessPath = "private/activation/readiness.json";
  await writeProjectFile(root, immutableReadinessPath, readinessJson);

  const activation = {
    schemaVersion: 1,
    kind: "nodejs-shortener-production-activation",
    stage,
    targetId,
    issuedAt: options.activationIssuedAt ?? "2026-09-01T11:59:00.000Z",
    expiresAt: options.activationExpiresAt ?? "2026-09-02T12:00:00.000Z",
    canonicalHosts: ["url6x.example"],
    runtimeConfigurationSha256,
    pm2DeploymentConfigurationSha256,
    readinessDocument: { path: immutableReadinessPath, sha256: digest(readinessJson) },
    artifactManifest: { path: artifactManifestPath, sha256: artifactManifestSha256 },
  };
  const activationPath = `private/activation/${stage}.json`;
  const activationJson = JSON.stringify(activation);
  await writeProjectFile(root, activationPath, activationJson);

  return {
    root,
    config,
    environment: {
      NODE_SHORTENER_DEPLOYMENT_STAGE: stage,
      NODE_SHORTENER_DEPLOYMENT_TARGET_ID: targetId,
      APP_PRIVATE_ROOT: privateRoot,
      APP_RELEASE_ROOT: root,
      PM2_HOME: pm2Home,
      NODE_BINARY: process.execPath,
      PM2_CLI_SCRIPT: pm2CliScript,
      PM2_VERSION: "6.2.0",
      NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE: activationPath,
      NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256: digest(activationJson),
    },
  };
}

async function writeProjectFile(root: string, path: string, content: string): Promise<void> {
  const absolutePath = join(root, ...path.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
