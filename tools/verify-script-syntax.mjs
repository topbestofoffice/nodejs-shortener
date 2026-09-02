import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const scripts = [
  "ecosystem.config.cjs",
  "eslint.config.js",
  ...readdirSync(resolve(projectRoot, "tools"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /[.](?:cjs|mjs)$/.test(entry.name))
    .map((entry) => `tools/${entry.name}`),
].sort();

const failures = [];
for (const script of scripts) {
  const result = spawnSync(process.execPath, ["--check", resolve(projectRoot, script)], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`${script}: ${(result.stderr || result.stdout).trim()}`);
}
if (failures.length > 0) {
  process.stderr.write(`Script syntax verification failed:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Script syntax verified: ${scripts.length} files\n`);
}
