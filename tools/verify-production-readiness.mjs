import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

const projectId = "nodejs-shortener";
const receiptKind = "nodejs-shortener-readiness-receipt";
const sha256Pattern = /^[a-f0-9]{64}$/;
const gateIdPattern = /^[a-z0-9-]+$/;
const checkIdPattern = /^[a-z0-9-]+$/;
const canonicalGateDefinitions = new Map([
  ["exact-schema-db-redis-parity", {
    requiredBefore: "pilot",
    evidenceStage: "pilot",
    checks: ["schema-fingerprint", "database-contract", "redis-contract"],
  }],
  ["redirect-shadow-parity", {
    requiredBefore: "pilot",
    evidenceStage: "pilot",
    checks: ["php-node-shadow-diff", "redirect-failure-matrix"],
  }],
  ["delivered-country-and-reporting-parity", {
    requiredBefore: "pilot",
    evidenceStage: "pilot",
    checks: ["delivered-country-contract", "reporting-completeness"],
  }],
  ["operator-feature-parity", {
    requiredBefore: "pilot",
    evidenceStage: "pilot",
    checks: ["dashboard-admin-registration", "single-and-multi-domain"],
  }],
  ["image-crash-recovery", {
    requiredBefore: "pilot",
    evidenceStage: "pilot",
    checks: ["atomic-admission", "restart-reconciliation", "disk-backup-restore"],
  }],
  ["cloudways-proxy-and-storage-proof", {
    requiredBefore: "release",
    evidenceStage: "pilot",
    checks: ["proxy-header-proof", "storage-persistence", "pm2-restart"],
  }],
  ["country-fallback-policy", {
    requiredBefore: "pilot",
    evidenceStage: "pilot",
    checks: ["privacy-availability-rate-limit-policy"],
  }],
  ["all-source-runtime-tests", {
    requiredBefore: "pilot",
    evidenceStage: "pilot",
    checks: ["clean-install-tests", "coverage-threshold", "runtime-failure-tests"],
  }],
  ["same-size-performance-proof", {
    requiredBefore: "release",
    evidenceStage: "pilot",
    checks: ["feature-equivalent-benchmark", "resource-acceptance"],
  }],
  ["one-writer-cutover-and-rollback", {
    requiredBefore: "release",
    evidenceStage: "release",
    checks: ["release-config-compatibility", "one-writer-proof", "rollback-rehearsal"],
  }],
  ["owner-pilot-deployment-authorization", {
    requiredBefore: "pilot",
    evidenceStage: "pilot",
    checks: ["exact-pilot-target-authorization"],
  }],
  ["owner-production-deployment-authorization", {
    requiredBefore: "release",
    evidenceStage: "release",
    checks: ["exact-production-target-authorization"],
  }],
]);

export async function verifyProductionReadiness(options) {
  const bytes = await readFile(options.documentPath);
  if (bytes.byteLength > 1_048_576) {
    throw new Error("Production-readiness document exceeds the 1 MiB safety limit.");
  }
  const document = parseJson(bytes, "production-readiness document");
  const validated = validateDocument(document);
  const verifiedReceipts = new Map();

  for (const gate of validated.gates) {
    const paths = new Set();
    const receipts = [];
    for (const reference of gate.evidence) {
      if (paths.has(reference.path)) {
        throw new Error(`Gate ${gate.id} repeats evidence path ${reference.path}.`);
      }
      paths.add(reference.path);
      receipts.push(await readAndValidateReceipt(options.projectRoot, gate.id, reference));
    }
    verifiedReceipts.set(gate.id, receipts);
  }

  const requiredGates = validated.gates.filter((gate) => options.requestedStage === "release"
    || gate.requiredBefore === "pilot");
  const blockers = [];
  const evidenceStages = new Set(requiredGates.map((gate) => canonicalGateDefinitions.get(gate.id)?.evidenceStage));
  for (const stage of evidenceStages) {
    if (stage !== undefined && validated.deployments[stage] === null) blockers.push(`${stage}-deployment-binding`);
  }
  if (options.requestedStage === "release" && validated.deployments.pilot !== null
    && validated.deployments.release !== null
    && validated.deployments.pilot.artifactSha256 !== validated.deployments.release.artifactSha256) {
    blockers.push("pilot-release-artifact-binding");
  }

  for (const gate of requiredGates) {
    const evidenceStage = canonicalGateDefinitions.get(gate.id)?.evidenceStage;
    const deployment = evidenceStage === undefined ? null : validated.deployments[evidenceStage];
    if (gate.status !== "verified" || evidenceStage === undefined || deployment === null) {
      blockers.push(gate.id);
      continue;
    }
    const matching = (verifiedReceipts.get(gate.id) ?? []).filter((receipt) => (
      receipt.stage === evidenceStage
      && subjectsMatch(receipt.subject, deployment)
      && (gate.id !== "one-writer-cutover-and-rollback"
        || receipt.related.pilotConfigurationSha256 === validated.deployments.pilot?.configurationSha256)
      && receiptIsFresh(receipt, validated.receiptPolicy, options.now)
    ));
    const observedChecks = new Set(matching.flatMap((receipt) => receipt.checks.map((check) => check.id)));
    const requiredChecks = canonicalGateDefinitions.get(gate.id)?.checks ?? [];
    if (matching.length === 0 || requiredChecks.some((check) => !observedChecks.has(check))) {
      blockers.push(gate.id);
    }
  }

  return { blockers, requiredGateCount: requiredGates.length };
}

function validateDocument(value) {
  assertObject(value, "production-readiness document");
  assertExactKeys(value, ["schemaVersion", "project", "receiptPolicy", "deployments", "gates"],
    "production-readiness document");
  if (value.schemaVersion !== 2 || value.project !== projectId) {
    throw new Error("Unsupported production-readiness schema or project identity.");
  }

  assertObject(value.receiptPolicy, "receipt policy");
  assertExactKeys(value.receiptPolicy, ["maxAgeHours", "futureSkewMinutes"], "receipt policy");
  if (!Number.isInteger(value.receiptPolicy.maxAgeHours)
    || value.receiptPolicy.maxAgeHours < 1 || value.receiptPolicy.maxAgeHours > 720
    || !Number.isInteger(value.receiptPolicy.futureSkewMinutes)
    || value.receiptPolicy.futureSkewMinutes < 0 || value.receiptPolicy.futureSkewMinutes > 15) {
    throw new Error("Invalid production-readiness receipt freshness policy.");
  }

  assertObject(value.deployments, "deployment bindings");
  assertExactKeys(value.deployments, ["pilot", "release"], "deployment bindings");
  const deployments = {
    pilot: validateDeployment(value.deployments.pilot, "pilot"),
    release: validateDeployment(value.deployments.release, "release"),
  };

  if (!Array.isArray(value.gates) || value.gates.length !== canonicalGateDefinitions.size) {
    throw new Error("Production-readiness document does not contain the canonical gate count.");
  }
  const seen = new Set();
  const gates = value.gates.map((gate) => {
    assertObject(gate, "production-readiness gate");
    assertExactKeys(gate, ["id", "requiredBefore", "status", "description", "evidence"],
      "production-readiness gate");
    const definition = typeof gate.id === "string" ? canonicalGateDefinitions.get(gate.id) : undefined;
    if (typeof gate.id !== "string" || !gateIdPattern.test(gate.id) || seen.has(gate.id)
      || definition === undefined || gate.requiredBefore !== definition.requiredBefore
      || !["pending", "verified"].includes(gate.status)
      || typeof gate.description !== "string" || gate.description.trim().length === 0
      || gate.description.length > 2_000 || !Array.isArray(gate.evidence)) {
      throw new Error("Invalid production-readiness gate.");
    }
    seen.add(gate.id);
    const evidence = gate.evidence.map((reference) => validateReceiptReference(gate.id, reference));
    if (gate.status === "verified" && evidence.length === 0) {
      throw new Error(`Verified gate ${gate.id} must include evidence receipts.`);
    }
    return { ...gate, evidence };
  });
  if ([...canonicalGateDefinitions.keys()].some((id) => !seen.has(id))) {
    throw new Error("Production-readiness document does not contain the canonical gate set.");
  }
  return { receiptPolicy: value.receiptPolicy, deployments, gates };
}

function validateDeployment(value, stage) {
  if (value === null) return null;
  assertObject(value, `${stage} deployment binding`);
  assertExactKeys(value, ["targetId", "artifactSha256", "configurationSha256"],
    `${stage} deployment binding`);
  if (!isSpecificTargetId(value.targetId)
    || !sha256Pattern.test(value.artifactSha256 ?? "")
    || !sha256Pattern.test(value.configurationSha256 ?? "")) {
    throw new Error(`Invalid ${stage} deployment binding.`);
  }
  return value;
}

function validateReceiptReference(gateId, value) {
  assertObject(value, `gate ${gateId} receipt reference`);
  assertExactKeys(value, ["path", "sha256"], `gate ${gateId} receipt reference`);
  if (!isReadinessPath(value.path) || !sha256Pattern.test(value.sha256 ?? "")) {
    throw new Error(`Gate ${gateId} has an invalid evidence reference.`);
  }
  return value;
}

async function readAndValidateReceipt(root, gateId, reference) {
  const rootRealPath = await realpath(root);
  const readinessRoot = resolve(root, "evidence/readiness");
  const receiptPath = resolve(root, ...reference.path.split("/"));
  const receiptRealPath = await realpath(receiptPath);
  assertContainedPath(rootRealPath, receiptRealPath, `Gate ${gateId} evidence`);
  assertContainedPath(await realpath(readinessRoot), receiptRealPath, `Gate ${gateId} evidence`);
  const bytes = await readFile(receiptRealPath);
  if (bytes.byteLength > 1_048_576) {
    throw new Error(`Gate ${gateId} evidence receipt exceeds the 1 MiB safety limit.`);
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== reference.sha256) {
    throw new Error(`Gate ${gateId} evidence digest does not match ${reference.path}.`);
  }
  return validateReceipt(parseJson(bytes, `gate ${gateId} evidence receipt`), gateId);
}

function validateReceipt(value, gateId) {
  assertObject(value, `gate ${gateId} evidence receipt`);
  assertExactKeys(value, [
    "schemaVersion", "kind", "gateId", "stage", "result", "capturedAt", "expiresAt", "subject", "related", "checks",
  ], `gate ${gateId} evidence receipt`);
  if (value.schemaVersion !== 2 || value.kind !== receiptKind || value.gateId !== gateId
    || !["pilot", "release"].includes(value.stage) || value.result !== "pass"
    || !isCanonicalTimestamp(value.capturedAt) || !isCanonicalTimestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.parse(value.capturedAt)
    || !Array.isArray(value.checks) || value.checks.length === 0) {
    throw new Error(`Gate ${gateId} has an invalid evidence receipt.`);
  }
  assertObject(value.subject, `gate ${gateId} receipt subject`);
  assertExactKeys(value.subject, ["project", "targetId", "artifactSha256", "configurationSha256"],
    `gate ${gateId} receipt subject`);
  if (value.subject.project !== projectId || !isSpecificTargetId(value.subject.targetId)
    || !sha256Pattern.test(value.subject.artifactSha256 ?? "")
    || !sha256Pattern.test(value.subject.configurationSha256 ?? "")) {
    throw new Error(`Gate ${gateId} receipt has an invalid bound subject.`);
  }
  assertObject(value.related, `gate ${gateId} receipt related binding`);
  assertExactKeys(value.related, ["pilotConfigurationSha256"], `gate ${gateId} receipt related binding`);
  if (value.related.pilotConfigurationSha256 !== null
    && !sha256Pattern.test(value.related.pilotConfigurationSha256 ?? "")) {
    throw new Error(`Gate ${gateId} receipt has an invalid related binding.`);
  }
  const seen = new Set();
  const checks = value.checks.map((check) => {
    assertObject(check, `gate ${gateId} receipt check`);
    assertExactKeys(check, ["id", "result", "observed"], `gate ${gateId} receipt check`);
    if (typeof check.id !== "string" || !checkIdPattern.test(check.id) || seen.has(check.id)
      || check.result !== "pass" || typeof check.observed !== "string"
      || check.observed.trim().length === 0 || check.observed.length > 4_000) {
      throw new Error(`Gate ${gateId} receipt contains an invalid check.`);
    }
    seen.add(check.id);
    return check;
  });
  return { ...value, relatedPilotConfigurationSha256: value.related.pilotConfigurationSha256, checks };
}

function receiptIsFresh(receipt, policy, now) {
  const nowMs = now.getTime();
  const capturedMs = Date.parse(receipt.capturedAt);
  const expiresMs = Date.parse(receipt.expiresAt);
  const maxAgeMs = policy.maxAgeHours * 60 * 60 * 1_000;
  const futureSkewMs = policy.futureSkewMinutes * 60 * 1_000;
  return Number.isFinite(nowMs)
    && capturedMs <= nowMs + futureSkewMs
    && capturedMs >= nowMs - maxAgeMs
    && expiresMs > nowMs
    && expiresMs - capturedMs <= maxAgeMs;
}

function subjectsMatch(subject, deployment) {
  return subject.targetId === deployment.targetId
    && subject.artifactSha256 === deployment.artifactSha256
    && subject.configurationSha256 === deployment.configurationSha256;
}

function isReadinessPath(value) {
  return typeof value === "string" && value.startsWith("evidence/readiness/")
    && value.endsWith(".json") && !value.includes("\\") && !value.includes("//")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function isSpecificTargetId(value) {
  return typeof value === "string" && value.length >= 8 && value.length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    && /[0-9]/.test(value)
    && !/(?:^|[._:/-])(?:all|any|default|global|localhost|pending|tbd|unknown|unset|wildcard)(?:$|[._:/-])/i.test(value);
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function assertObject(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${context}.`);
  }
}

function assertExactKeys(value, expected, context) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(canonical)) {
    throw new Error(`Invalid fields in ${context}.`);
  }
}

function assertContainedPath(root, candidate, context) {
  const child = relative(root, candidate);
  if (child.length === 0 || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`${context} escapes its allowed directory.`);
  }
}

function parseJson(bytes, context) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Invalid JSON in ${context}.`);
  }
}

function parseRequestedStage(arguments_) {
  if (arguments_.length === 0) return "release";
  if (arguments_.length === 1 && arguments_[0] === "--stage=pilot") return "pilot";
  if (arguments_.length === 1 && arguments_[0] === "--stage=release") return "release";
  throw new Error("Usage: verify-production-readiness.mjs [--stage=pilot|--stage=release]");
}

function serializedReadinessContract() {
  const gates = [...canonicalGateDefinitions].map(([id, definition]) => ({ id, ...definition }));
  return {
    receiptSchemaVersion: 2,
    pilotGateIds: gates.filter((gate) => gate.requiredBefore === "pilot").map((gate) => gate.id),
    releaseGateIds: gates.map((gate) => gate.id),
    gates,
  };
}

function safeError(error) {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1_000) : "unknown error";
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === resolve(import.meta.filename)) {
  const projectRoot = resolve(import.meta.dirname, "..");
  const documentPath = resolve(projectRoot, "config/production-readiness.json");
  const cliArguments = process.argv.slice(2);
  const printContract = cliArguments.length === 1 && cliArguments[0] === "--print-contract";
  try {
    if (printContract) {
      console.log(JSON.stringify(serializedReadinessContract()));
    } else {
      const requestedStage = parseRequestedStage(cliArguments);
      const result = await verifyProductionReadiness({
        projectRoot,
        documentPath,
        requestedStage,
        now: new Date(),
      });
      if (result.blockers.length > 0) {
        const label = requestedStage === "pilot" ? "PILOT CANDIDATE" : "PRODUCTION";
        console.error(`${label} BLOCKED: ${result.blockers.length} readiness blocker(s) remain.`);
        for (const blocker of result.blockers) console.error(`- ${blocker}`);
        process.exitCode = 1;
      } else {
        const label = requestedStage === "pilot" ? "PILOT CANDIDATE" : "PRODUCTION";
        console.log(`${label} READY: ${result.requiredGateCount} fresh, target-bound gates verified.`);
      }
    }
  } catch (error) {
    console.error(`Production-readiness verification failed: ${safeError(error)}`);
    process.exitCode = 1;
  }
}
