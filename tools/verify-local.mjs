import { spawnSync } from "node:child_process";

const checks = [
  ["historical August PHP source and schema evidence", ["run", "verify:evidence"]],
  ["current D1/D2/D3 parity authority descriptor", ["run", "verify:authority"]],
  ["PM2 process configuration", ["run", "verify:pm2"]],
  ["type, lint, script syntax and tests", ["run", "check"]],
  ["production build", ["run", "build"]],
  ["local HTTP smoke", ["run", "smoke:local"]],
  ["single-domain local HTTP smoke", ["run", "smoke:single-local"]],
  ["all-source coverage", ["run", "test:coverage"]],
  ["production dependency audit", ["audit", "--omit=dev"]],
];

const results = checks.map(([label, args]) => ({ label, status: runNpm(args) }));
process.stdout.write("\nLocal verification summary:\n");
for (const result of results) process.stdout.write(`- ${result.status === 0 ? "PASS" : "FAIL"}: ${result.label}\n`);
process.exitCode = results.every((result) => result.status === 0) ? 0 : 1;

function runNpm(args) {
  const npmEntrypoint = process.env.npm_execpath;
  const result = npmEntrypoint === undefined
    ? spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { stdio: "inherit" })
    : spawnSync(process.execPath, [npmEntrypoint, ...args], { stdio: "inherit" });
  if (result.error !== undefined) {
    process.stderr.write(`Could not run npm ${args.join(" ")}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}
