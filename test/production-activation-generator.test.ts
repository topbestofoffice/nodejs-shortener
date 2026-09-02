import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildProductionActivationPlan,
  createProductionActivation,
} from "../tools/generate-production-activation.mjs";
import { pm2DeploymentConfigurationSha256 } from "../tools/verify-cloudways-installed.mjs";
import { parseExactEnvironment } from "../tools/cloudways-rendered-env.mjs";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production activation generator", () => {
  it("stamps current UTC, binds PM2/readiness/artifacts and publishes owner-only files once", async () => {
    const fixture = await activationFixture();
    const startup = vi.fn((_: unknown, options: { environment: NodeJS.ProcessEnv; projectRoot: string }) => {
      const activationPath = resolve(
        options.projectRoot,
        ...(options.environment.NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE ?? "").split("/"),
      );
      const activation = JSON.parse(readFileSync(activationPath, "utf8")) as Record<string, unknown>;
      expect(activation.issuedAt).toBe("2026-09-01T12:34:56.789Z");
      expect(activation.pm2DeploymentConfigurationSha256).toBe(fixture.pm2Sha256);
      expect(existsSync(resolve(options.projectRoot, String(
        (activation.artifactManifest as { path: string }).path,
      )))).toBe(true);
    });
    const plan = await buildProductionActivationPlan(fixture.planOptions);

    const result = await createProductionActivation(plan, {
      clock: () => new Date("2026-09-01T12:34:56.789Z"),
      verifyProductionReadiness: async () => ({ blockers: [], requiredGateCount: 8 }),
      assertProductionStartupAllowed: startup,
    });

    expect(startup).toHaveBeenCalledOnce();
    expect(result.issuedAt).toBe("2026-09-01T12:34:56.789Z");
    expect(result.expiresAt).toBe("2026-09-08T12:34:56.789Z");
    expect(result.pm2DeploymentConfigurationSha256).toBe(fixture.pm2Sha256);
    expect(result.activationPath).toMatch(/^private\/activation\/activation\.pilot\./);
    expect(result.artifactManifestPath).toMatch(/^private\/activation\/artifact-manifest\.pilot\./);
    expect(digest(await readFile(resolve(fixture.root, result.activationPath)))).toBe(result.activationSha256);
    expect(digest(await readFile(resolve(fixture.root, result.artifactManifestPath))))
      .toBe(result.artifactManifestSha256);

    await expect(createProductionActivation(plan, {
      clock: () => new Date("2026-09-01T12:34:56.789Z"),
      verifyProductionReadiness: async () => ({ blockers: [], requiredGateCount: 8 }),
      assertProductionStartupAllowed: startup,
    })).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("writes nothing when readiness is stale/unbound and rejects secret-looking receipt observations", async () => {
    const fixture = await activationFixture();
    const plan = await buildProductionActivationPlan(fixture.planOptions);

    await expect(createProductionActivation(plan, {
      clock: () => new Date("2026-09-01T12:34:56.789Z"),
      verifyProductionReadiness: async () => ({ blockers: ["exact-schema-db-redis-parity"], requiredGateCount: 8 }),
      assertProductionStartupAllowed: vi.fn(),
    })).rejects.toThrow("Readiness is not green");
    expect(existsSync(resolve(fixture.root, "private/activation"))).toBe(false);

    const receipt = {
      checks: [{ id: "database-contract", result: "pass", observed: "password=super-secret-password" }],
    };
    const receiptBytes = Buffer.from(JSON.stringify(receipt));
    await writeProjectFile(fixture.root, "evidence/readiness/secret.json", receiptBytes);
    const documentPath = resolve(fixture.root, "config/production-readiness.json");
    const document = JSON.parse(await readFile(documentPath, "utf8")) as { gates: unknown[] };
    document.gates = [{ evidence: [{ path: "evidence/readiness/secret.json", sha256: digest(receiptBytes) }] }];
    await writeFile(documentPath, JSON.stringify(document), "utf8");

    await expect(createProductionActivation(plan, {
      clock: () => new Date("2026-09-01T12:34:56.789Z"),
      verifyProductionReadiness: vi.fn(),
      assertProductionStartupAllowed: vi.fn(),
    })).rejects.toThrow("appears to contain secret material");
  });

  it("rejects an unresolved environment and an exact-target binding mismatch", async () => {
    const placeholder = await activationFixture({ keepPlaceholder: true });
    await expect(buildProductionActivationPlan(placeholder.planOptions)).rejects.toThrow(
      "still contains a placeholder",
    );

    const fixture = await activationFixture();
    const plan = await buildProductionActivationPlan(fixture.planOptions);
    const documentPath = resolve(fixture.root, "config/production-readiness.json");
    const document = JSON.parse(await readFile(documentPath, "utf8")) as {
      deployments: { pilot: { targetId: string } };
    };
    document.deployments.pilot.targetId = "cloudways-other-999999";
    await writeFile(documentPath, JSON.stringify(document), "utf8");

    await expect(createProductionActivation(plan, {
      clock: () => new Date("2026-09-01T12:34:56.789Z"),
      verifyProductionReadiness: vi.fn(),
      assertProductionStartupAllowed: vi.fn(),
    })).rejects.toThrow("not bound to this exact target");
  });

  it("does not allow a colocated tool to generate against a different --root contract", () => {
    const tool = resolve(import.meta.dirname, "../tools/generate-production-activation.mjs");
    const result = spawnSync(process.execPath, [tool, "--root=C:/different-release", "--plan"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: generate-production-activation.mjs");
  });

  it("never follows a swapped private-directory symlink while publishing", async () => {
    const fixture = await activationFixture();
    const plan = await buildProductionActivationPlan(fixture.planOptions);
    const outside = await mkdtemp(join(tmpdir(), "node-shortener-activation-outside-"));
    roots.push(outside);
    await symlink(outside, resolve(fixture.root, "private"), process.platform === "win32" ? "junction" : "dir");

    await expect(createProductionActivation(plan, {
      clock: () => new Date("2026-09-01T12:34:56.789Z"),
      verifyProductionReadiness: async () => ({ blockers: [], requiredGateCount: 8 }),
      assertProductionStartupAllowed: vi.fn(),
    })).rejects.toThrow("private directory must be a real directory");
    expect(existsSync(resolve(outside, "activation"))).toBe(false);
  });

  it("never publishes through a symlinked release root", async () => {
    const fixture = await activationFixture();
    const aliasContainer = await mkdtemp(join(tmpdir(), "node-shortener-release-alias-"));
    roots.push(aliasContainer);
    const alias = resolve(aliasContainer, "release");
    await symlink(fixture.root, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(buildProductionActivationPlan({ ...fixture.planOptions, projectRoot: alias }))
      .rejects.toThrow("selected release root must be a real non-symlink directory");
  });
});

async function activationFixture(options: { keepPlaceholder?: boolean } = {}) {
  const container = await mkdtemp(join(tmpdir(), "node-shortener-activation-generator-"));
  roots.push(container);
  const privateRoot = resolve(container, "app-private");
  const root = resolve(privateRoot, "releases/release-a");
  const pm2Cli = resolve(privateRoot, "runtime/pm2-cli.js");
  await mkdir(root, { recursive: true });
  const sourceTemplate = await readFile(resolve(import.meta.dirname, "../deploy/cloudways/pilot.env.example"), "utf8");
  await Promise.all([
    writeProjectFile(root, "dist/server.js", "server"),
    writeProjectFile(root, "package.json", "{}"),
    writeProjectFile(root, ".gitignore", "/evidence/readiness/\nprivate/\n"),
    writeProjectFile(root, "deploy/cloudways/pilot.env.example", sourceTemplate),
    mkdir(resolve(privateRoot, "tmp"), { recursive: true }),
    mkdir(resolve(privateRoot, "pm2"), { recursive: true }),
    mkdir(dirname(pm2Cli), { recursive: true }).then(() => writeFile(pm2Cli, "synthetic pm2 cli\n")),
    mkdir(resolve(root, "public/uploads"), { recursive: true }),
  ]);
  const replacements = new Map<string, string>([
    ["__UNIQUE_APP_NAMESPACE__", options.keepPlaceholder ? "__UNIQUE_APP_NAMESPACE__" : "pilot-shortener"],
    ["__APP_PRIVATE_ROOT_ABSOLUTE_PATH__", privateRoot],
    ["__APP_RELEASE_ROOT_ABSOLUTE_PATH__", root],
    ["__ABSOLUTE_NODE_BINARY__", process.execPath],
    ["__ABSOLUTE_PM2_CLI_SCRIPT__", pm2Cli],
    ["__EXACT_PM2_VERSION__", "6.2.0"],
    ["__UNIQUE_LOOPBACK_PORT__", "3107"],
    ["__EXACT_DOMAIN_CONFIG_FILE__", "domains.pilot"],
    ["__EXACT_CLOUDWAYS_DEPLOYMENT_TARGET_ID__", "cloudways-pilot-123456"],
    ["__PRIVATE_ORIGIN_AUTH_SHA256__", "a".repeat(64)],
    ["__PRIVATE_MYSQL_HOST__", "127.0.0.1"],
    ["__PRIVATE_MYSQL_PORT__", "3306"],
    ["__UNIQUE_MYSQL_DATABASE__", "pilot_shortener"],
    ["__UNIQUE_MYSQL_USER__", "pilot_user"],
    ["__PRIVATE_MYSQL_PASSWORD__", "private-mysql-password-123456"],
    ["__PRIVATE_REDIS_URL__", "redis://127.0.0.1:6379"],
    ["__UNIQUE_REDIS_KEY_PREFIX__", "pilot-shortener"],
    ["__PRIVATE_32_PLUS_CHARACTER_IP_HASH_SECRET__", "i".repeat(40)],
    ["__PRIVATE_32_PLUS_CHARACTER_COOKIE_SIGNING_SECRET__", "c".repeat(40)],
    ["__UNIQUE_PM2_PROCESS_PREFIX__", "pilot-shortener"],
    ["__PRIVATE_PM2_HOME_ABSOLUTE_PATH__", resolve(privateRoot, "pm2")],
    ["__PRIVATE_HTML_TEMP_ABSOLUTE_PATH__", resolve(privateRoot, "tmp")],
    ["__PUBLIC_HTML_UPLOADS_ABSOLUTE_PATH__", resolve(root, "public/uploads")],
    ["__PRIVATE_DIAGNOSTIC_TOKEN_SHA256_WHEN_ENABLED__", ""],
  ]);
  let renderedSource = sourceTemplate
    .replace(/^NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE=.*\r?\n/m, "")
    .replace(/^NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256=.*\r?\n/m, "");
  for (const [placeholder, value] of replacements) renderedSource = renderedSource.replaceAll(placeholder, value);
  const environmentFile = resolve(privateRoot, "config/pilot.env");
  await mkdir(dirname(environmentFile), { recursive: true });
  await writeFile(environmentFile, renderedSource);
  if (process.platform !== "win32") {
    await chmod(environmentFile, 0o600);
    await chmod(resolve(privateRoot, "tmp"), 0o700);
    await chmod(resolve(privateRoot, "pm2"), 0o700);
  }
  const environment = parseExactEnvironment(renderedSource);
  const pm2Sha256 = pm2DeploymentConfigurationSha256(environment);
  const runtimeSha256 = "b".repeat(64);
  const artifactPaths = ["dist/server.js", "package.json"];
  const manifest = {
    schemaVersion: 1,
    kind: "nodejs-shortener-artifact-manifest",
    files: await Promise.all(artifactPaths.sort().map(async (path) => ({
      path,
      sha256: digest(await readFile(resolve(root, path))),
    }))),
  };
  const artifactSha256 = digest(Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  await writeProjectFile(root, "config/production-readiness.json", JSON.stringify({
    schemaVersion: 2,
    project: "nodejs-shortener",
    deployments: {
      pilot: {
        targetId: "cloudways-pilot-123456",
        artifactSha256,
        configurationSha256: runtimeSha256,
      },
      release: null,
    },
    gates: [],
  }));
  const runtimeConfig = {
    registry: { all: () => [{ canonicalHost: "go.example.test" }, { canonicalHost: "manage.example.test" }] },
  };
  return {
    root,
    pm2Sha256,
    planOptions: {
      projectRoot: root,
      environmentFile,
      loadRuntimeConfig: async () => runtimeConfig,
      productionArtifactManifestPaths: () => artifactPaths,
      productionRuntimeConfigurationSha256: () => runtimeSha256,
      productionPm2DeploymentConfigurationSha256: () => pm2Sha256,
    },
  };
}

async function writeProjectFile(root: string, path: string, contents: string | Buffer) {
  const target = resolve(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
