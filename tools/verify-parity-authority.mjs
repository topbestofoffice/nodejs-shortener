import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const descriptorPath = resolve(projectRoot, "evidence", "parity-authority-2026-09-01.json");
const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
const failures = [];

expect(descriptor.schemaVersion === 1, "schemaVersion must be 1");
expect(descriptor.purpose?.includes("not a live-production drift receipt") === true,
  "purpose must retain the non-live-evidence boundary");
expect(/^[a-f0-9]{40}$/.test(descriptor.portableSource?.commit ?? ""),
  "portable source commit must be a full lowercase Git SHA");
expect(descriptor.portableSource?.sourceFileCount === 28,
  "portable source inventory must contain 28 files");
for (const [label, value] of [
  ["source manifest", descriptor.portableSource?.sourceManifestSha256],
  ["source provenance", descriptor.portableSource?.provenanceSha256],
  ["R4 runbook", descriptor.mutableOperationalOverlay?.runbookSha256],
  ["R4 lib", descriptor.mutableOperationalOverlay?.d3LibSha256],
  ["R4 redirect", descriptor.mutableOperationalOverlay?.d3RedirectSha256],
]) {
  expect(/^[a-f0-9]{64}$/.test(value ?? ""), `${label} digest must be a lowercase SHA-256`);
}
expect(descriptor.mutableOperationalOverlay?.warning?.includes("Never hardcode 2/36") === true,
  "mutable D3 report maturity must remain explicitly non-constant");

const topology = descriptor.topologyContract;
expect(topology?.controlPlaneDomainId === 1, "D1 must remain the control plane");
expect(topology?.fallbackCreateDomainId === 2, "D2 must remain the create fallback");
expect(JSON.stringify(topology?.selectableCreateDomainIds) === JSON.stringify([2, 3]),
  "only D2 and D3 must be selectable for creation");
const domains = new Map((topology?.domains ?? []).map((domain) => [domain.id, domain]));
expect(domains.size === 3, "the current multi-domain contract must contain exactly D1, D2 and D3");
expect(domains.get(1)?.active === true && domains.get(1)?.allowCreate === false
  && domains.get(1)?.surface === "dashboard", "D1 topology mismatch");
expect(domains.get(2)?.active === true && domains.get(2)?.allowCreate === true
  && domains.get(2)?.surface === "redirect", "D2 topology mismatch");
expect(domains.get(3)?.hostname === "plays9x.com" && domains.get(3)?.active === true
  && domains.get(3)?.allowCreate === true && domains.get(3)?.surface === "redirect"
  && domains.get(3)?.wwwConfigured === false && domains.get(3)?.aliases?.length === 0,
"D3 must be active, creatable, redirect-only and apex-only");

verifyOptionalFile("PHP_PARITY_SOURCE_MANIFEST", descriptor.portableSource?.sourceManifestSha256);
verifyOptionalFile("PHP_PARITY_PROVENANCE", descriptor.portableSource?.provenanceSha256);
verifyOptionalFile("PHP_D3_R4_RUNBOOK", descriptor.mutableOperationalOverlay?.runbookSha256);
verifyOptionalFile("PHP_D3_R4_LIB", descriptor.mutableOperationalOverlay?.d3LibSha256);
verifyOptionalFile("PHP_D3_R4_REDIRECT", descriptor.mutableOperationalOverlay?.d3RedirectSha256);

if (failures.length > 0) {
  process.stderr.write(`Current parity authority verification failed:\n- ${failures.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Current D1/D2/D3 parity authority descriptor: valid\n");
  process.stdout.write("Current live drift and mutable D3 report maturity: NOT VERIFIED by this local check\n");
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function verifyOptionalFile(environmentName, expectedDigest) {
  const filePath = process.env[environmentName];
  if (filePath === undefined || filePath.trim() === "") return;
  try {
    const actual = createHash("sha256").update(readFileSync(resolve(filePath))).digest("hex");
    expect(actual === expectedDigest, `${environmentName} does not match the frozen descriptor`);
  } catch (error) {
    failures.push(`${environmentName} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}
