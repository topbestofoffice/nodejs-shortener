import { spawnSync } from "node:child_process";

const results = [runNpmScript("verify:local"), runNpmScript("verify:readiness")];
process.exitCode = results.every((status) => status === 0) ? 0 : 1;

function runNpmScript(script) {
  const npmEntrypoint = process.env.npm_execpath;
  const result = npmEntrypoint === undefined
    ? spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], { stdio: "inherit" })
    : spawnSync(process.execPath, [npmEntrypoint, "run", script], { stdio: "inherit" });
  if (result.error !== undefined) {
    process.stderr.write(`Could not run npm script ${script}: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}
