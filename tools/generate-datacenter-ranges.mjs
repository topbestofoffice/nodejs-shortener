import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const sourceRelativePath = "data/datacenter_ranges.php";
const sourcePath = resolve(projectRoot, ".local-evidence", "php-current", sourceRelativePath);
const manifestPath = resolve(projectRoot, "evidence", "php-source-hashes.json");
const outputPath = resolve(projectRoot, "data", "datacenter-ranges.json");

const [source, manifestRaw] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(manifestPath, "utf8"),
]);
const manifest = JSON.parse(manifestRaw);
const expectedHash = manifest?.files?.[sourceRelativePath];
const sourceHash = createHash("sha256").update(source).digest("hex");
if (typeof expectedHash !== "string" || expectedHash !== sourceHash) {
  throw new Error("Refusing to generate ranges from PHP evidence with an unverified hash.");
}

const starts = extractArray(source, "v4s", "v4e");
const ends = extractArray(source, "v4e", "meta");
if (starts.length === 0 || starts.length !== ends.length) {
  throw new Error("Datacenter range arrays are empty or misaligned.");
}
for (let index = 0; index < starts.length; index += 1) {
  const start = starts[index];
  const end = ends[index];
  if (start === undefined || end === undefined || start > end
    || (index > 0 && start <= (ends[index - 1] ?? -1))) {
    throw new Error(`Datacenter range ${index} is malformed, overlapping, or unsorted.`);
  }
}

const policyHash = /policy_sha=([a-f0-9]{64})/.exec(source)?.[1];
const builtAt = /built_at=([^\s*]+)/.exec(source)?.[1];
if (policyHash === undefined || builtAt === undefined) {
  throw new Error("Datacenter source metadata is missing.");
}

const output = {
  schema_version: 1,
  source: {
    relative_path: sourceRelativePath,
    sha256: sourceHash,
    policy_sha256: policyHash,
    built_at_utc: builtAt,
    ipv4_range_count: starts.length,
  },
  starts,
  ends,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output)}\n`, { encoding: "utf8", mode: 0o644 });
process.stdout.write(`Generated ${starts.length} verified datacenter IPv4 ranges.\n`);

function extractArray(php, key, nextKey) {
  const startMarker = new RegExp(`['\"]${key}['\"]\\s*=>\\s*array\\s*\\(`);
  const nextMarker = new RegExp(`['\"]${nextKey}['\"]\\s*=>`);
  const startMatch = startMarker.exec(php);
  if (startMatch === null) throw new Error(`Missing ${key} range array.`);
  const remainder = php.slice(startMatch.index + startMatch[0].length);
  const nextMatch = nextMarker.exec(remainder);
  if (nextMatch === null) throw new Error(`Missing marker after ${key} range array.`);
  const section = remainder.slice(0, nextMatch.index);
  const values = [];
  for (const match of section.matchAll(/^\s*\d+\s*=>\s*(\d+),\s*$/gm)) {
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new Error(`Invalid unsigned IPv4 value in ${key}.`);
    }
    values.push(value);
  }
  return values;
}
