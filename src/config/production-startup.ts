import { createHash } from "node:crypto";
import {
  readFileSync,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import sharp from "sharp";
import type { RuntimeConfig } from "./runtime.js";

const sha256Pattern = /^[a-f0-9]{64}$/;
const gateIdPattern = /^[a-z0-9-]+$/;
const checkIdPattern = /^[a-z0-9-]+$/;
const activationKind = "nodejs-shortener-production-activation";
const artifactManifestKind = "nodejs-shortener-artifact-manifest";
const readinessReceiptKind = "nodejs-shortener-readiness-receipt";
const pilotReadinessGateIds = [
  "exact-schema-db-redis-parity",
  "redirect-shadow-parity",
  "delivered-country-and-reporting-parity",
  "operator-feature-parity",
  "image-crash-recovery",
  "country-fallback-policy",
  "all-source-runtime-tests",
  "owner-pilot-deployment-authorization",
] as const;
const releaseReadinessGateIds = [
  "exact-schema-db-redis-parity",
  "redirect-shadow-parity",
  "delivered-country-and-reporting-parity",
  "operator-feature-parity",
  "image-crash-recovery",
  "cloudways-proxy-and-storage-proof",
  "country-fallback-policy",
  "all-source-runtime-tests",
  "same-size-performance-proof",
  "one-writer-cutover-and-rollback",
  "owner-pilot-deployment-authorization",
  "owner-production-deployment-authorization",
] as const;
interface ReadinessGateDefinition {
  readonly requiredBefore: "pilot" | "release";
  readonly evidenceStage: "pilot" | "release";
  readonly checks: readonly string[];
}
const readinessGateDefinitions: ReadonlyMap<string, ReadinessGateDefinition> = new Map([
  ["exact-schema-db-redis-parity", {
    requiredBefore: "pilot", evidenceStage: "pilot",
    checks: ["schema-fingerprint", "database-contract", "redis-contract"],
  }],
  ["redirect-shadow-parity", {
    requiredBefore: "pilot", evidenceStage: "pilot",
    checks: ["php-node-shadow-diff", "redirect-failure-matrix"],
  }],
  ["delivered-country-and-reporting-parity", {
    requiredBefore: "pilot", evidenceStage: "pilot",
    checks: ["delivered-country-contract", "reporting-completeness"],
  }],
  ["operator-feature-parity", {
    requiredBefore: "pilot", evidenceStage: "pilot",
    checks: ["dashboard-admin-registration", "single-and-multi-domain"],
  }],
  ["image-crash-recovery", {
    requiredBefore: "pilot", evidenceStage: "pilot",
    checks: ["atomic-admission", "restart-reconciliation", "disk-backup-restore"],
  }],
  ["cloudways-proxy-and-storage-proof", {
    requiredBefore: "release", evidenceStage: "pilot",
    checks: ["proxy-header-proof", "storage-persistence", "pm2-restart"],
  }],
  ["country-fallback-policy", {
    requiredBefore: "pilot", evidenceStage: "pilot",
    checks: ["privacy-availability-rate-limit-policy"],
  }],
  ["all-source-runtime-tests", {
    requiredBefore: "pilot", evidenceStage: "pilot",
    checks: ["clean-install-tests", "coverage-threshold", "runtime-failure-tests"],
  }],
  ["same-size-performance-proof", {
    requiredBefore: "release", evidenceStage: "pilot",
    checks: ["feature-equivalent-benchmark", "resource-acceptance"],
  }],
  ["one-writer-cutover-and-rollback", {
    requiredBefore: "release", evidenceStage: "release",
    checks: ["release-config-compatibility", "one-writer-proof", "rollback-rehearsal"],
  }],
  ["owner-pilot-deployment-authorization", {
    requiredBefore: "pilot", evidenceStage: "pilot",
    checks: ["exact-pilot-target-authorization"],
  }],
  ["owner-production-deployment-authorization", {
    requiredBefore: "release", evidenceStage: "release",
    checks: ["exact-production-target-authorization"],
  }],
]);
export const productionReadinessContract = Object.freeze({
  receiptSchemaVersion: 2,
  pilotGateIds: Object.freeze([...pilotReadinessGateIds]),
  releaseGateIds: Object.freeze([...releaseReadinessGateIds]),
  gates: Object.freeze([...readinessGateDefinitions].map(([id, definition]) => Object.freeze({
    id,
    requiredBefore: definition.requiredBefore,
    evidenceStage: definition.evidenceStage,
    checks: Object.freeze([...definition.checks]),
  }))),
});
const requiredArtifactFiles = [
  "dist/config/production-startup.js",
  "dist/server.js",
  "dist/workers/image-worker.js",
  "ecosystem.config.cjs",
  "config/required-schema-contract.json",
  "database/001_image_job_ledger.sql",
  "database/002_links_recent_activity_epochs.sql",
  "database/003_runtime_schema_contract_marker.sql",
  "package.json",
  "package-lock.json",
] as const;

/**
 * Return the exact release-file set enforced again at production startup.
 * Deployment tooling imports the built copy of this function so generation and
 * startup cannot silently drift onto different artifact rules.
 */
export function productionArtifactManifestPaths(projectRoot: string): readonly string[] {
  const root = resolve(projectRoot);
  const required = new Set<string>(requiredArtifactFiles);
  for (const directory of ["dist", "data", "public/assets"] as const) {
    for (const path of collectRegularFiles(root, directory)) required.add(path);
  }
  return Object.freeze([...required].sort());
}

export const productionStartupBlockedMessage =
  "Production startup requires a valid activation bound to one exact target, artifact and runtime configuration.";

interface ProductionStartupOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: Date;
  readonly projectRoot?: string;
}

type StartupConfig = Pick<RuntimeConfig, "environment"> & Partial<Omit<RuntimeConfig, "environment">>;

/**
 * Production stays fail-closed without an expiring activation document. Unlike
 * the old source lock, enabling one deployment never removes protection from
 * other targets: the activation binds the stage, target id, canonical hosts,
 * complete runtime digest and a verified release-file manifest.
 */
export function assertProductionStartupAllowed(
  config: StartupConfig,
  options: ProductionStartupOptions = {},
): void {
  if (config.environment !== "production") return;

  try {
    const environment = options.environment ?? process.env;
    const now = options.now ?? new Date();
    const root = resolve(options.projectRoot ?? resolve(import.meta.dirname, "../.."));
    const stage = requiredStage(environment.NODE_SHORTENER_DEPLOYMENT_STAGE);
    const targetId = requiredTargetId(environment.NODE_SHORTENER_DEPLOYMENT_TARGET_ID);
    const activationPath = requiredActivationPath(environment.NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE);
    const activationSha256 = requiredSha256(
      environment.NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256,
      "activation digest",
    );
    const runtimeConfig = requireCompleteRuntimeConfig(config);
    const deploymentRoots = requiredDeploymentRoots(environment, root);
    const activation = readBoundPrivateJson(root, activationPath, activationSha256, "production activation");
    validateActivation(activation, {
      stage,
      targetId,
      canonicalHosts: runtimeConfig.registry.all().map((domain) => domain.canonicalHost).sort(),
      runtimeConfigurationSha256: productionRuntimeConfigurationSha256(runtimeConfig),
      pm2DeploymentConfigurationSha256: productionPm2DeploymentConfigurationSha256(
        runtimeConfig,
        requiredPm2Home(environment.PM2_HOME),
        requiredNodeBinary(environment.NODE_BINARY),
        deploymentRoots.privateRoot,
        deploymentRoots.releaseRoot,
        requiredAbsoluteFile(environment.PM2_CLI_SCRIPT, "PM2_CLI_SCRIPT"),
        requiredPm2Version(environment.PM2_VERSION),
      ),
      now,
      root,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 500) : "invalid activation";
    throw new Error(`${productionStartupBlockedMessage} ${reason}`, { cause: error });
  }
}

export function productionRuntimeConfigurationSha256(config: RuntimeConfig): string {
  const domains = config.registry.all()
    .map((domain) => ({
      id: domain.id,
      key: domain.key,
      canonicalHost: domain.canonicalHost,
      aliases: [...domain.aliases].sort(),
      label: domain.label,
      surface: domain.surface,
      active: domain.active,
      allowCreate: domain.allowCreate,
      diversionCampaign: domain.diversionCampaign,
      reportTimezone: domain.reportTimezone,
      publicBaseUrl: domain.publicBaseUrl,
      imageBaseUrl: domain.imageBaseUrl,
      emitLocalImageAlt: domain.emitLocalImageAlt,
      compactNoImagePreview: domain.compactNoImagePreview,
      creationFallback: domain.creationFallback,
      acceptUnprovenDeliveredClaim: domain.acceptUnprovenDeliveredClaim,
    }))
    .sort((left, right) => left.id - right.id || left.canonicalHost.localeCompare(right.canonicalHost));
  const binding = {
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      sharpVersions: Object.fromEntries(Object.entries(sharp.versions).sort(([left], [right]) => (
        left.localeCompare(right)
      ))),
    },
    environment: config.environment,
    appNamespace: config.appNamespace,
    logLevel: config.logLevel,
    listen: { host: config.host, port: config.port },
    operations: config.operations,
    domains,
    proxy: {
      trustProxy: config.trustProxy,
      trustCloudflareHeaders: config.trustCloudflareHeaders,
      cloudflareHeaderSanitizationVerified: config.cloudflareHeaderSanitizationVerified,
      proxyChainVerified: config.proxyChainVerified,
      originAuthEnabled: config.originAuth.enabled,
      originAuthHeader: config.originAuth.header,
      originAuthSha256: config.originAuth.expectedSha256,
    },
    secrets: {
      ipHashSecretSha256: sha256(config.ipHashSecret),
      cookieSigningSecretSha256: sha256(config.cookieSigningSecret),
    },
    storage: {
      driver: config.storageDriver,
      mysql: {
        host: config.mysql.host,
        port: config.mysql.port,
        database: config.mysql.database,
        user: config.mysql.user,
        passwordSha256: sha256(config.mysql.password),
        connectionLimit: config.mysql.connectionLimit,
        queueLimit: config.mysql.queueLimit,
      },
      redis: {
        urlSha256: sha256(config.redis.url),
        keyPrefix: config.redis.keyPrefix,
        connectTimeoutMs: config.redis.connectTimeoutMs,
        commandTimeoutMs: config.redis.commandTimeoutMs,
      },
    },
    reporting: {
      deliveredCountryDomainIds: [...config.reporting.deliveredCountryDomainIds].sort(
        (left, right) => left - right,
      ),
    },
    sessionTtlSeconds: config.sessionTtlSeconds,
    links: {
      codeLength: config.links.codeLength,
      maxBulkLinks: config.links.maxBulkLinks,
      maxBulkImages: config.links.maxBulkImages,
    },
    browserScopedDefaultUsers: [...config.browserScopedDefaultUsers]
      .map((user) => ({ id: user.id, username: user.username, role: user.role }))
      .sort((left, right) => left.id - right.id || left.username.localeCompare(right.username)),
    image: {
      executor: config.image.executor,
      privateTempDir: config.image.privateTempDir,
      publicUploadDir: config.image.publicUploadDir,
      maxUploadBytes: config.image.maxUploadBytes,
      maxImagePixels: config.image.maxImagePixels,
      readyPerSession: config.image.readyPerSession,
      readyTotal: config.image.readyTotal,
      ownershipTtlSeconds: config.image.ownershipTtlSeconds,
      jobTimeoutMs: config.image.jobTimeoutMs,
      serveStaticUploads: config.image.serveStaticUploads,
    },
    developmentSeedEnabled: config.developmentSeed.username.length > 0 || config.developmentSeed.password.length > 0,
    redirectEngine: config.redirectEngine,
    datacenterRangesFile: config.datacenterRangesFile,
    pilotDiagnostics: {
      enabled: config.pilotDiagnostics.enabled,
      tokenSha256: config.pilotDiagnostics.expectedTokenSha256,
    },
    analytics: {
      enabled: config.analytics.enabled,
      measurementId: config.analytics.measurementId,
      siteKey: config.analytics.siteKey,
    },
  };
  return sha256(JSON.stringify(binding));
}

/**
 * Explicit PM2/process-topology binding. The activation also binds the complete
 * runtime digest and manifest (including ecosystem.config.cjs); this dedicated
 * digest makes deployment knob drift independently auditable.
 */
export function productionPm2DeploymentConfigurationSha256(
  config: RuntimeConfig,
  pm2Home: string,
  nodeBinary: string,
  applicationPrivateRoot: string,
  applicationReleaseRoot: string,
  pm2CliScript: string,
  pm2Version: string,
): string {
  const resolvedNodeBinary = realpathSync(nodeBinary);
  const resolvedPm2CliScript = realpathSync(pm2CliScript);
  return sha256(JSON.stringify({
    applicationPrivateRootSha256: sha256(resolve(applicationPrivateRoot)),
    applicationReleaseRootSha256: sha256(resolve(applicationReleaseRoot)),
    pm2HomeSha256: sha256(resolve(pm2Home)),
    nodeBinaryPathSha256: sha256(resolvedNodeBinary),
    nodeBinarySha256: sha256(readFileSync(resolvedNodeBinary)),
    pm2CliScriptPathSha256: sha256(resolvedPm2CliScript),
    pm2CliScriptSha256: sha256(readFileSync(resolvedPm2CliScript)),
    pm2Version,
    processPrefix: config.operations.pm2ProcessPrefix,
    webInstances: config.operations.webInstances,
    webMaxMemoryMb: config.operations.webMaxMemoryMb,
    imageWorkerMaxMemoryMb: config.operations.imageWorkerMaxMemoryMb,
    imageJobTimeoutMs: config.image.jobTimeoutMs,
    imageRecoveryPreflightTimeoutMs: config.operations.imageRecoveryPreflightTimeoutMs,
    redisConnectTimeoutMs: config.redis.connectTimeoutMs,
    redisCommandTimeoutMs: config.redis.commandTimeoutMs,
    restartPolicy: {
      minUptimeMs: 30_000,
      maxRestarts: 240,
      restartDelayMs: 30_000,
    },
  }));
}

interface ActivationExpectation {
  readonly stage: "pilot" | "release";
  readonly targetId: string;
  readonly canonicalHosts: readonly string[];
  readonly runtimeConfigurationSha256: string;
  readonly pm2DeploymentConfigurationSha256: string;
  readonly now: Date;
  readonly root: string;
}

function validateActivation(value: unknown, expected: ActivationExpectation): void {
  assertObject(value, "production activation");
  assertExactKeys(value, [
    "schemaVersion",
    "kind",
    "stage",
    "targetId",
    "issuedAt",
    "expiresAt",
    "canonicalHosts",
    "runtimeConfigurationSha256",
    "pm2DeploymentConfigurationSha256",
    "readinessDocument",
    "artifactManifest",
  ], "production activation");
  if (value.schemaVersion !== 1 || value.kind !== activationKind
    || value.stage !== expected.stage || value.targetId !== expected.targetId
    || !isCanonicalTimestamp(value.issuedAt) || !isCanonicalTimestamp(value.expiresAt)
    || value.runtimeConfigurationSha256 !== expected.runtimeConfigurationSha256
    || value.pm2DeploymentConfigurationSha256 !== expected.pm2DeploymentConfigurationSha256
    || !Array.isArray(value.canonicalHosts)
    || !value.canonicalHosts.every((host): host is string => typeof host === "string")
    || JSON.stringify([...value.canonicalHosts].sort()) !== JSON.stringify(expected.canonicalHosts)) {
    throw new Error("Activation subject does not match this runtime.");
  }
  const nowMs = expected.now.getTime();
  const issuedMs = Date.parse(value.issuedAt);
  const expiresMs = Date.parse(value.expiresAt);
  const maximumLifetimeMs = (expected.stage === "pilot" ? 30 : 400) * 24 * 60 * 60 * 1_000;
  if (!Number.isFinite(nowMs) || issuedMs > nowMs + 5 * 60 * 1_000 || expiresMs <= nowMs
    || expiresMs <= issuedMs || expiresMs - issuedMs > maximumLifetimeMs) {
    throw new Error("Activation is expired, future-dated or exceeds its bounded lifetime.");
  }

  assertObject(value.artifactManifest, "activation artifact manifest reference");
  assertExactKeys(value.artifactManifest, ["path", "sha256"], "activation artifact manifest reference");
  const manifestPath = requiredArtifactManifestPath(value.artifactManifest.path);
  const manifestSha256 = requiredSha256(value.artifactManifest.sha256, "artifact manifest digest");
  validateArtifactManifest(readBoundPrivateJson(
    expected.root,
    manifestPath,
    manifestSha256,
    "artifact manifest",
  ), expected.root);
  assertObject(value.readinessDocument, "activation readiness document reference");
  assertExactKeys(value.readinessDocument, ["path", "sha256"], "activation readiness document reference");
  const readinessDocumentPath = requiredArtifactManifestPath(value.readinessDocument.path);
  const readinessDocumentSha256 = requiredSha256(value.readinessDocument.sha256, "readiness document digest");
  validateReadinessBinding(readBoundPrivateJson(
    expected.root,
    readinessDocumentPath,
    readinessDocumentSha256,
    "production-readiness document",
  ), {
    stage: expected.stage,
    targetId: expected.targetId,
    artifactSha256: manifestSha256,
    configurationSha256: expected.runtimeConfigurationSha256,
    // Freshness authorizes issuance of this immutable activation. Rechecking
    // receipt wall-clock expiry on every PM2 reboot would make a still-valid
    // activation fail to resurrect after routine server maintenance.
    evidenceAsOf: new Date(issuedMs),
    root: expected.root,
  });
}

interface ReadinessDeployment {
  readonly targetId: string;
  readonly artifactSha256: string;
  readonly configurationSha256: string;
}

interface ReadinessReceiptPolicy {
  readonly maxAgeHours: number;
  readonly futureSkewMinutes: number;
}

interface ReadinessReceipt {
  readonly stage: "pilot" | "release";
  readonly capturedAt: string;
  readonly expiresAt: string;
  readonly subject: ReadinessDeployment & { readonly project: "nodejs-shortener" };
  readonly relatedPilotConfigurationSha256: string | null;
  readonly checks: readonly { readonly id: string }[];
}

function validateReadinessBinding(value: unknown, expected: {
  readonly stage: "pilot" | "release";
  readonly targetId: string;
  readonly artifactSha256: string;
  readonly configurationSha256: string;
  readonly evidenceAsOf: Date;
  readonly root: string;
}): void {
  assertObject(value, "production-readiness document");
  assertExactKeys(value, ["schemaVersion", "project", "receiptPolicy", "deployments", "gates"],
    "production-readiness document");
  if (value.schemaVersion !== 2 || value.project !== "nodejs-shortener") {
    throw new Error("Production-readiness document has the wrong schema or project.");
  }

  const receiptPolicy = validateReadinessReceiptPolicy(value.receiptPolicy);
  assertObject(value.deployments, "readiness deployment bindings");
  assertExactKeys(value.deployments, ["pilot", "release"], "readiness deployment bindings");
  const deployments = {
    pilot: validateReadinessDeployment(value.deployments.pilot, "pilot"),
    release: validateReadinessDeployment(value.deployments.release, "release"),
  };
  const binding = deployments[expected.stage];
  if (binding === null) throw new Error(`${expected.stage} readiness deployment binding is missing.`);
  if (binding.targetId !== expected.targetId || binding.artifactSha256 !== expected.artifactSha256
    || binding.configurationSha256 !== expected.configurationSha256) {
    throw new Error("Readiness deployment binding does not match this activation.");
  }
  if (expected.stage === "release" && deployments.pilot !== null
    && deployments.pilot.artifactSha256 !== binding.artifactSha256) {
    throw new Error("Pilot and release readiness bindings use different artifacts.");
  }

  if (!Array.isArray(value.gates) || value.gates.length !== readinessGateDefinitions.size) {
    throw new Error("Production-readiness document does not contain the canonical gate count.");
  }
  const seen = new Set<string>();
  const receipts = new Map<string, readonly ReadinessReceipt[]>();
  const gates = new Map<string, { readonly status: unknown }>();
  for (const gate of value.gates) {
    assertObject(gate, "production-readiness gate");
    assertExactKeys(gate, ["id", "requiredBefore", "status", "description", "evidence"],
      "production-readiness gate");
    const definition = typeof gate.id === "string" ? readinessGateDefinitions.get(gate.id) : undefined;
    if (typeof gate.id !== "string" || !gateIdPattern.test(gate.id) || seen.has(gate.id)
      || definition === undefined || gate.requiredBefore !== definition.requiredBefore
      || !["pending", "verified"].includes(String(gate.status))
      || typeof gate.description !== "string" || gate.description.trim().length === 0
      || gate.description.length > 2_000 || !Array.isArray(gate.evidence)) {
      throw new Error("Invalid production-readiness gate.");
    }
    const gateId = gate.id;
    const evidence = gate.evidence;
    seen.add(gateId);
    if (gate.status === "verified" && evidence.length === 0) {
      throw new Error(`Verified gate ${gateId} must include evidence receipts.`);
    }
    const paths = new Set<string>();
    const gateReceipts = evidence.map((reference) => {
      assertObject(reference, `gate ${gateId} receipt reference`);
      assertExactKeys(reference, ["path", "sha256"], `gate ${gateId} receipt reference`);
      const path = requiredReadinessPath(reference.path);
      if (paths.has(path)) throw new Error(`Gate ${gateId} repeats evidence path ${path}.`);
      paths.add(path);
      return validateReadinessReceipt(readBoundReadinessJson(
        expected.root,
        path,
        requiredSha256(reference.sha256, `gate ${gateId} evidence digest`),
        `gate ${gateId} evidence receipt`,
      ), gateId);
    });
    receipts.set(gateId, gateReceipts);
    gates.set(gateId, { status: gate.status });
  }
  if ([...readinessGateDefinitions.keys()].some((id) => !seen.has(id))) {
    throw new Error("Production-readiness document does not contain the canonical gate set.");
  }

  const requiredIds = expected.stage === "pilot" ? pilotReadinessGateIds : releaseReadinessGateIds;
  for (const gateId of requiredIds) {
    const definition = readinessGateDefinitions.get(gateId);
    const gate = gates.get(gateId);
    const evidenceStage = definition?.evidenceStage;
    const deployment = evidenceStage === undefined ? null : deployments[evidenceStage];
    if (definition === undefined || gate?.status !== "verified" || deployment === null) {
      throw new Error(`Production-readiness gate ${gateId} is not evidence-backed and verified.`);
    }
    const matching = (receipts.get(gateId) ?? []).filter((receipt) => receipt.stage === evidenceStage
      && readinessSubjectsMatch(receipt.subject, deployment)
      && (gateId !== "one-writer-cutover-and-rollback"
        || receipt.relatedPilotConfigurationSha256 === deployments.pilot?.configurationSha256)
      && readinessReceiptIsFresh(receipt, receiptPolicy, expected.evidenceAsOf));
    const observedChecks = new Set(matching.flatMap((receipt) => receipt.checks.map((check) => check.id)));
    if (matching.length === 0 || definition.checks.some((check) => !observedChecks.has(check))) {
      throw new Error(`Production-readiness gate ${gateId} lacks fresh target-bound canonical evidence.`);
    }
  }
}

function validateReadinessReceiptPolicy(value: unknown): ReadinessReceiptPolicy {
  assertObject(value, "readiness receipt policy");
  assertExactKeys(value, ["maxAgeHours", "futureSkewMinutes"], "readiness receipt policy");
  if (!Number.isInteger(value.maxAgeHours) || Number(value.maxAgeHours) < 1 || Number(value.maxAgeHours) > 720
    || !Number.isInteger(value.futureSkewMinutes) || Number(value.futureSkewMinutes) < 0
    || Number(value.futureSkewMinutes) > 15) {
    throw new Error("Invalid production-readiness receipt freshness policy.");
  }
  return { maxAgeHours: Number(value.maxAgeHours), futureSkewMinutes: Number(value.futureSkewMinutes) };
}

function validateReadinessDeployment(value: unknown, stage: "pilot" | "release"): ReadinessDeployment | null {
  if (value === null) return null;
  assertObject(value, `${stage} readiness deployment binding`);
  assertExactKeys(value, ["targetId", "artifactSha256", "configurationSha256"],
    `${stage} readiness deployment binding`);
  if (!isSpecificTargetId(value.targetId) || typeof value.artifactSha256 !== "string"
    || !sha256Pattern.test(value.artifactSha256) || typeof value.configurationSha256 !== "string"
    || !sha256Pattern.test(value.configurationSha256)) {
    throw new Error(`Invalid ${stage} readiness deployment binding.`);
  }
  return {
    targetId: value.targetId,
    artifactSha256: value.artifactSha256,
    configurationSha256: value.configurationSha256,
  };
}

function validateReadinessReceipt(value: unknown, gateId: string): ReadinessReceipt {
  assertObject(value, `gate ${gateId} evidence receipt`);
  assertExactKeys(value, [
    "schemaVersion", "kind", "gateId", "stage", "result", "capturedAt", "expiresAt", "subject", "related", "checks",
  ], `gate ${gateId} evidence receipt`);
  if (value.schemaVersion !== productionReadinessContract.receiptSchemaVersion
    || value.kind !== readinessReceiptKind || value.gateId !== gateId
    || (value.stage !== "pilot" && value.stage !== "release") || value.result !== "pass"
    || !isCanonicalTimestamp(value.capturedAt) || !isCanonicalTimestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.capturedAt)
    || !Array.isArray(value.checks) || value.checks.length === 0) {
    throw new Error(`Gate ${gateId} has an invalid evidence receipt.`);
  }
  assertObject(value.subject, `gate ${gateId} receipt subject`);
  assertExactKeys(value.subject, ["project", "targetId", "artifactSha256", "configurationSha256"],
    `gate ${gateId} receipt subject`);
  if (value.subject.project !== "nodejs-shortener" || !isSpecificTargetId(value.subject.targetId)
    || typeof value.subject.artifactSha256 !== "string" || !sha256Pattern.test(value.subject.artifactSha256)
    || typeof value.subject.configurationSha256 !== "string"
    || !sha256Pattern.test(value.subject.configurationSha256)) {
    throw new Error(`Gate ${gateId} receipt has an invalid bound subject.`);
  }
  assertObject(value.related, `gate ${gateId} receipt related binding`);
  assertExactKeys(value.related, ["pilotConfigurationSha256"], `gate ${gateId} receipt related binding`);
  if (value.related.pilotConfigurationSha256 !== null
    && (typeof value.related.pilotConfigurationSha256 !== "string"
      || !sha256Pattern.test(value.related.pilotConfigurationSha256))) {
    throw new Error(`Gate ${gateId} receipt has an invalid related binding.`);
  }
  const seen = new Set<string>();
  const checks = value.checks.map((check) => {
    assertObject(check, `gate ${gateId} receipt check`);
    assertExactKeys(check, ["id", "result", "observed"], `gate ${gateId} receipt check`);
    if (typeof check.id !== "string" || !checkIdPattern.test(check.id) || seen.has(check.id)
      || check.result !== "pass" || typeof check.observed !== "string"
      || check.observed.trim().length === 0 || check.observed.length > 4_000) {
      throw new Error(`Gate ${gateId} receipt contains an invalid check.`);
    }
    seen.add(check.id);
    return { id: check.id };
  });
  return {
    stage: value.stage,
    capturedAt: value.capturedAt,
    expiresAt: value.expiresAt,
    subject: {
      project: "nodejs-shortener",
      targetId: value.subject.targetId,
      artifactSha256: value.subject.artifactSha256,
      configurationSha256: value.subject.configurationSha256,
    },
    relatedPilotConfigurationSha256: value.related.pilotConfigurationSha256,
    checks,
  };
}

function readinessSubjectsMatch(subject: ReadinessReceipt["subject"], deployment: ReadinessDeployment): boolean {
  return subject.targetId === deployment.targetId
    && subject.artifactSha256 === deployment.artifactSha256
    && subject.configurationSha256 === deployment.configurationSha256;
}

function readinessReceiptIsFresh(
  receipt: ReadinessReceipt,
  policy: ReadinessReceiptPolicy,
  now: Date,
): boolean {
  const nowMs = now.getTime();
  const capturedMs = Date.parse(receipt.capturedAt);
  const expiresMs = Date.parse(receipt.expiresAt);
  const maxAgeMs = policy.maxAgeHours * 60 * 60 * 1_000;
  const futureSkewMs = policy.futureSkewMinutes * 60 * 1_000;
  return Number.isFinite(nowMs) && capturedMs <= nowMs + futureSkewMs
    && capturedMs >= nowMs - maxAgeMs && expiresMs > nowMs
    && expiresMs - capturedMs <= maxAgeMs;
}

function validateArtifactManifest(value: unknown, root: string): void {
  assertObject(value, "artifact manifest");
  assertExactKeys(value, ["schemaVersion", "kind", "files"], "artifact manifest");
  if (value.schemaVersion !== 1 || value.kind !== artifactManifestKind
    || !Array.isArray(value.files) || value.files.length === 0) {
    throw new Error("Invalid artifact manifest.");
  }
  const seen = new Set<string>();
  for (const file of value.files) {
    assertObject(file, "artifact manifest file");
    assertExactKeys(file, ["path", "sha256"], "artifact manifest file");
    const path = requiredArtifactPath(file.path);
    if (seen.has(path)) throw new Error("Artifact manifest repeats a file path.");
    seen.add(path);
    readBoundFile(root, path, requiredSha256(file.sha256, "artifact file digest"), "artifact file");
  }

  if (productionArtifactManifestPaths(root).some((path) => !seen.has(path))) {
    throw new Error("Artifact manifest omits a required runtime file.");
  }
}

function collectRegularFiles(root: string, directory: string): string[] {
  const directoryPath = resolve(root, directory);
  const rootRealPath = realpathSync(root);
  const result: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Runtime artifact directories may not contain symbolic links.");
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        assertContainedPath(rootRealPath, realpathSync(path), "runtime artifact file");
        result.push(relative(root, path).replaceAll("\\", "/"));
      }
    }
  };
  visit(directoryPath);
  return result.sort();
}

function readBoundPrivateJson(root: string, path: string, expectedSha256: string, context: string): unknown {
  let current = resolve(root);
  for (const part of path.split("/")) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`${context} path may not contain symbolic links.`);
    }
  }
  const privateRootRealPath = realpathSync(resolve(root, "private/activation"));
  const candidateRealPath = realpathSync(current);
  assertContainedPath(privateRootRealPath, candidateRealPath, context);
  const bytes = readFileSync(candidateRealPath);
  if (bytes.byteLength > 1_048_576) throw new Error(`${context} exceeds the 1 MiB safety limit.`);
  if (sha256(bytes) !== expectedSha256) throw new Error(`${context} digest does not match.`);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${context}.`);
  }
}

function readBoundReadinessJson(root: string, path: string, expectedSha256: string, context: string): unknown {
  const rootRealPath = realpathSync(root);
  const readinessRealPath = realpathSync(resolve(root, "evidence/readiness"));
  const candidateRealPath = realpathSync(resolve(root, ...path.split("/")));
  assertContainedPath(rootRealPath, candidateRealPath, context);
  assertContainedPath(readinessRealPath, candidateRealPath, context);
  const bytes = readFileSync(candidateRealPath);
  if (bytes.byteLength > 1_048_576) throw new Error(`${context} exceeds the 1 MiB safety limit.`);
  if (sha256(bytes) !== expectedSha256) throw new Error(`${context} digest does not match.`);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${context}.`);
  }
}

function readBoundFile(root: string, path: string, expectedSha256: string, context: string): Buffer {
  const rootRealPath = realpathSync(root);
  const candidate = resolve(root, ...path.split("/"));
  const candidateRealPath = realpathSync(candidate);
  assertContainedPath(rootRealPath, candidateRealPath, context);
  const bytes = readFileSync(candidateRealPath);
  if (sha256(bytes) !== expectedSha256) throw new Error(`${context} digest does not match.`);
  return bytes;
}

function requireCompleteRuntimeConfig(config: StartupConfig): RuntimeConfig {
  const candidate = config as Partial<RuntimeConfig>;
  if (typeof candidate.appNamespace !== "string" || typeof candidate.registry?.all !== "function"
    || candidate.mysql === undefined || candidate.redis === undefined || candidate.image === undefined
    || candidate.originAuth === undefined || candidate.developmentSeed === undefined
    || candidate.pilotDiagnostics === undefined) {
    throw new Error("Production runtime configuration is incomplete.");
  }
  return candidate as RuntimeConfig;
}

function requiredStage(value: string | undefined): "pilot" | "release" {
  if (value === "pilot" || value === "release") return value;
  throw new Error("NODE_SHORTENER_DEPLOYMENT_STAGE must be pilot or release.");
}

function requiredPm2Home(value: string | undefined): string {
  if (typeof value === "string" && isAbsolute(value) && value.length <= 500) return resolve(value);
  throw new Error("PM2_HOME must be one exact absolute private directory.");
}

function requiredNodeBinary(value: string | undefined): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 500) {
    throw new Error("NODE_BINARY must be one exact absolute executable path.");
  }
  const selected = realpathSync(value);
  if (selected !== realpathSync(process.execPath)) {
    throw new Error("NODE_BINARY does not match the running Node executable.");
  }
  return selected;
}

function requiredAbsoluteFile(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 500) {
    throw new Error(`${name} must be one exact absolute regular-file path.`);
  }
  const metadata = lstatSync(value);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${name} must be one exact non-symlink regular file.`);
  }
  return realpathSync(value);
}

function requiredPm2Version(value: string | undefined): string {
  if (typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value)
    && value.length <= 64) return value;
  throw new Error("PM2_VERSION must be one exact semantic version.");
}

function requiredDeploymentRoot(value: string | undefined, name: string): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 500) {
    throw new Error(`${name} must be one exact absolute directory.`);
  }
  return realpathSync(value);
}

function requiredDeploymentRoots(environment: NodeJS.ProcessEnv, root: string): {
  readonly privateRoot: string;
  readonly releaseRoot: string;
} {
  const privateRoot = requiredDeploymentRoot(environment.APP_PRIVATE_ROOT, "APP_PRIVATE_ROOT");
  const releaseRoot = requiredDeploymentRoot(environment.APP_RELEASE_ROOT, "APP_RELEASE_ROOT");
  const releasesRoot = realpathSync(resolve(privateRoot, "releases"));
  if (releaseRoot !== realpathSync(root) || dirname(releaseRoot) !== releasesRoot) {
    throw new Error("APP_RELEASE_ROOT must be this exact direct APP_PRIVATE_ROOT/releases child.");
  }
  return { privateRoot, releaseRoot };
}

function requiredTargetId(value: string | undefined): string {
  if (isSpecificTargetId(value)) return value;
  throw new Error("NODE_SHORTENER_DEPLOYMENT_TARGET_ID must identify one exact deployment.");
}

function isSpecificTargetId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    && /[0-9]/.test(value)
    && !/(?:^|[._:/-])(?:all|any|default|global|localhost|pending|tbd|unknown|unset|wildcard)(?:$|[._:/-])/i.test(value);
}

function requiredActivationPath(value: string | undefined): string {
  if (isSafeRelativePath(value) && value.startsWith("private/activation/") && value.endsWith(".json")) return value;
  throw new Error("NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE must be a private activation JSON path.");
}

function requiredArtifactManifestPath(value: unknown): string {
  if (isSafeRelativePath(value) && value.startsWith("private/activation/") && value.endsWith(".json")) return value;
  throw new Error("Artifact manifest must be a private activation JSON path.");
}

function requiredReadinessPath(value: unknown): string {
  if (isSafeRelativePath(value) && value.startsWith("evidence/readiness/") && value.endsWith(".json")) {
    return value;
  }
  throw new Error("Readiness evidence must be a safe JSON path under evidence/readiness.");
}

function requiredArtifactPath(value: unknown): string {
  if (!isSafeRelativePath(value) || /^(?:private|node_modules|coverage|evidence|\.git|\.local-evidence)(?:\/|$)/.test(value)
    || value === ".env" || value.startsWith(".env.") || value.startsWith("public/uploads/")) {
    throw new Error("Artifact manifest contains an unsafe file path.");
  }
  return value;
}

function isSafeRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500
    && !value.includes("\\") && !value.includes("//")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..")
    && !isAbsolute(value);
}

function requiredSha256(value: unknown, context: string): string {
  if (typeof value === "string" && sha256Pattern.test(value)) return value;
  throw new Error(`Invalid ${context}.`);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function assertObject(value: unknown, context: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${context}.`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) throw new Error(`Invalid fields in ${context}.`);
}

function assertContainedPath(root: string, candidate: string, context: string): void {
  const child = relative(root, candidate);
  if (child.length === 0 || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`${context} escapes the project directory.`);
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
