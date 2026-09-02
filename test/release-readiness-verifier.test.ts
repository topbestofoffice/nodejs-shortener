import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { productionReadinessContract } from "../src/config/production-startup.js";

const roots: string[] = [];
const targetId = "cloudways-pilot-app-6598284";
const artifactSha256 = "a".repeat(64);
const configurationSha256 = "b".repeat(64);
const requiredChecks: Readonly<Record<string, readonly string[]>> = {
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

describe("production-readiness receipt validation", () => {
  it("keeps the runtime-startup and CLI canonical contracts identical", () => {
    const result = spawnSync(process.execPath, [
      resolve(import.meta.dirname, "../tools/verify-production-readiness.mjs"),
      "--print-contract",
    ], { encoding: "utf8" });
    if (result.error !== undefined) throw result.error;
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(productionReadinessContract);
  });
  it("accepts a complete set of fresh receipts bound to one pilot target and artifact", async () => {
    const fixture = await readinessFixture();
    const result = runVerifier(fixture.root);

    expect(result.status).toBe(0);
    expect(result.output).toContain("PILOT CANDIDATE READY: 8 fresh, target-bound gates verified.");
  });

  it("rejects an arbitrary hashed file instead of treating its bytes as proof", async () => {
    const fixture = await readinessFixture();
    const gate = fixture.document.gates.find((candidate) => candidate.id === "exact-schema-db-redis-parity");
    if (gate === undefined) throw new Error("Missing fixture gate.");
    const reference = gate.evidence[0];
    if (reference === undefined) throw new Error("Missing fixture receipt.");
    const arbitrary = JSON.stringify("arbitrary bytes with a valid outer digest");
    await writeProjectFile(fixture.root, reference.path, arbitrary);
    reference.sha256 = digest(arbitrary);
    await writeDocument(fixture);

    const result = runVerifier(fixture.root);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Invalid gate exact-schema-db-redis-parity evidence receipt");
  });

  it("keeps a verified label red when receipts belong to another target", async () => {
    const fixture = await readinessFixture({ receiptTargetId: "cloudways-pilot-app-6639209" });
    const result = runVerifier(fixture.root);

    expect(result.status).toBe(1);
    expect(result.output).toContain("PILOT CANDIDATE BLOCKED");
    expect(result.output).toContain("- exact-schema-db-redis-parity");
    expect(result.output).not.toContain("PILOT CANDIDATE READY");
  });

  it("keeps stale receipts and receipts missing canonical checks red", async () => {
    const stale = await readinessFixture({ capturedOffsetHours: -192, expiresOffsetHours: -168 });
    const staleResult = runVerifier(stale.root);
    expect(staleResult.status).toBe(1);
    expect(staleResult.output).toContain("- all-source-runtime-tests");

    const incomplete = await readinessFixture();
    const gate = incomplete.document.gates.find((candidate) => candidate.id === "image-crash-recovery");
    if (gate === undefined) throw new Error("Missing fixture gate.");
    const reference = gate.evidence[0];
    if (reference === undefined) throw new Error("Missing fixture receipt.");
    const receiptPath = join(incomplete.root, ...reference.path.split("/"));
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Receipt;
    receipt.checks = receipt.checks.filter((check) => check.id !== "restart-reconciliation");
    const receiptJson = JSON.stringify(receipt);
    await writeFile(receiptPath, receiptJson, "utf8");
    reference.sha256 = digest(receiptJson);
    await writeDocument(incomplete);

    const incompleteResult = runVerifier(incomplete.root);
    expect(incompleteResult.status).toBe(1);
    expect(incompleteResult.output).toContain("- image-crash-recovery");
  });

  it("verifies all 12 release gates against their canonical pilot or release deployment", async () => {
    const fixture = await readinessFixture({ stage: "release" });
    const result = runVerifier(fixture.root, "release");

    expect(result.status).toBe(0);
    expect(result.output).toContain("PRODUCTION READY: 12 fresh, target-bound gates verified.");

    const wrongStage = await readinessFixture({
      stage: "release",
      wrongEvidenceStageGate: "one-writer-cutover-and-rollback",
    });
    const rejected = runVerifier(wrongStage.root, "release");
    expect(rejected.status).toBe(1);
    expect(rejected.output).toContain("- one-writer-cutover-and-rollback");

    const missingCompatibility = await readinessFixture({
      stage: "release",
      omittedCheck: "release-config-compatibility",
    });
    const missingCheckResult = runVerifier(missingCompatibility.root, "release");
    expect(missingCheckResult.status).toBe(1);
    expect(missingCheckResult.output).toContain("- one-writer-cutover-and-rollback");

    const wrongPilotBinding = await readinessFixture({
      stage: "release",
      relatedPilotConfigurationSha256: "d".repeat(64),
    });
    const wrongPilotResult = runVerifier(wrongPilotBinding.root, "release");
    expect(wrongPilotResult.status).toBe(1);
    expect(wrongPilotResult.output).toContain("- one-writer-cutover-and-rollback");
  });
});

interface ReceiptReference {
  path: string;
  sha256: string;
}

interface Gate {
  id: string;
  requiredBefore: "pilot" | "release";
  status: "pending" | "verified";
  description: string;
  evidence: ReceiptReference[];
}

interface ReadinessDocument {
  schemaVersion: number;
  project: string;
  receiptPolicy: { maxAgeHours: number; futureSkewMinutes: number };
  deployments: {
    pilot: null | { targetId: string; artifactSha256: string; configurationSha256: string };
    release: null | { targetId: string; artifactSha256: string; configurationSha256: string };
  };
  gates: Gate[];
}

interface Receipt {
  schemaVersion: number;
  kind: string;
  gateId: string;
  stage: string;
  result: string;
  capturedAt: string;
  expiresAt: string;
  subject: { project: string; targetId: string; artifactSha256: string; configurationSha256: string };
  related: { pilotConfigurationSha256: string | null };
  checks: { id: string; result: string; observed: string }[];
}

interface Fixture {
  readonly root: string;
  readonly document: ReadinessDocument;
}

interface FixtureOptions {
  readonly stage?: "pilot" | "release";
  readonly receiptTargetId?: string;
  readonly wrongEvidenceStageGate?: string;
  readonly omittedCheck?: string;
  readonly relatedPilotConfigurationSha256?: string;
  readonly capturedOffsetHours?: number;
  readonly expiresOffsetHours?: number;
}

async function readinessFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "node-shortener-readiness-"));
  roots.push(root);
  const toolSource = await readFile(resolve(import.meta.dirname, "../tools/verify-production-readiness.mjs"), "utf8");
  await writeProjectFile(root, "tools/verify-production-readiness.mjs", toolSource);
  const template = JSON.parse(await readFile(
    resolve(import.meta.dirname, "../config/production-readiness.json"),
    "utf8",
  )) as ReadinessDocument;
  const stage = options.stage ?? "pilot";
  const pilotTargetId = stage === "release" ? "cloudways-pilot-app-6598283" : targetId;
  const pilotConfigurationSha256 = stage === "release" ? "c".repeat(64) : configurationSha256;
  template.deployments.pilot = {
    targetId: pilotTargetId,
    artifactSha256,
    configurationSha256: pilotConfigurationSha256,
  };
  if (stage === "release") {
    template.deployments.release = { targetId, artifactSha256, configurationSha256 };
  }
  const current = Date.now();
  const capturedAt = new Date(current + (options.capturedOffsetHours ?? -1) * 60 * 60 * 1_000).toISOString();
  const expiresAt = new Date(current + (options.expiresOffsetHours ?? 24) * 60 * 60 * 1_000).toISOString();

  for (const gate of template.gates) {
    const checks = requiredChecks[gate.id];
    if (checks === undefined || (stage === "pilot" && gate.requiredBefore !== "pilot")) continue;
    gate.status = "verified";
    const canonicalEvidenceStage = releaseEvidenceGates.has(gate.id) ? "release" : "pilot";
    const receiptStage = options.wrongEvidenceStageGate === gate.id
      ? canonicalEvidenceStage === "pilot" ? "release" : "pilot"
      : canonicalEvidenceStage;
    const receiptTargetId = receiptStage === "release" ? targetId : pilotTargetId;
    const receiptConfigurationSha256 = receiptStage === "release"
      ? configurationSha256
      : pilotConfigurationSha256;
    const receipt: Receipt = {
      schemaVersion: 2,
      kind: "nodejs-shortener-readiness-receipt",
      gateId: gate.id,
      stage: receiptStage,
      result: "pass",
      capturedAt,
      expiresAt,
      subject: {
        project: "nodejs-shortener",
        targetId: options.receiptTargetId ?? receiptTargetId,
        artifactSha256,
        configurationSha256: receiptConfigurationSha256,
      },
      related: {
        pilotConfigurationSha256: receiptStage === "release"
          ? options.relatedPilotConfigurationSha256 ?? pilotConfigurationSha256
          : null,
      },
      checks: checks
        .filter((id) => id !== options.omittedCheck)
        .map((id) => ({ id, result: "pass", observed: `Synthetic test proof for ${id}.` })),
    };
    const path = `evidence/readiness/${gate.id}.json`;
    const json = JSON.stringify(receipt);
    await writeProjectFile(root, path, json);
    gate.evidence = [{ path, sha256: digest(json) }];
  }
  const fixture = { root, document: template };
  await writeDocument(fixture);
  return fixture;
}

async function writeDocument(fixture: Fixture): Promise<void> {
  await writeProjectFile(fixture.root, "config/production-readiness.json", JSON.stringify(fixture.document));
}

function runVerifier(
  root: string,
  stage: "pilot" | "release" = "pilot",
): { readonly status: number | null; readonly output: string } {
  const result = spawnSync(process.execPath, [
    join(root, "tools/verify-production-readiness.mjs"),
    `--stage=${stage}`,
  ], { cwd: root, encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function writeProjectFile(root: string, path: string, content: string): Promise<void> {
  const absolutePath = join(root, ...path.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
