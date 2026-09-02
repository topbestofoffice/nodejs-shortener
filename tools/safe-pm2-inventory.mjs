import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPortablePrivateOwnership,
  assertRenderedEnvironmentShape,
  directoryRealPath,
  exactDeploymentRoots,
  isStrictChild,
  readCloudwaysEnvironmentTemplate,
  readRenderedCloudwaysEnvironment,
  regularRealPath,
} from "./cloudways-rendered-env.mjs";

const boundProcessEnvironmentKeys = Object.freeze([
  "NODE_SHORTENER_DEPLOYMENT_STAGE",
  "NODE_SHORTENER_DEPLOYMENT_TARGET_ID",
  "NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE",
  "NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256",
  "APP_PRIVATE_ROOT",
  "APP_RELEASE_ROOT",
  "NODE_BINARY",
  "PM2_HOME",
  "PM2_CLI_SCRIPT",
  "PM2_VERSION",
  "PM2_PROCESS_PREFIX",
  "WEB_INSTANCES",
  "WEB_MAX_MEMORY_MB",
  "IMAGE_WORKER_MAX_MEMORY_MB",
  "IMAGE_JOB_TIMEOUT_MS",
  "IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS",
  "REDIS_CONNECT_TIMEOUT_MS",
  "REDIS_COMMAND_TIMEOUT_MS",
  "ANALYTICS_MEASUREMENT_ID",
  "ANALYTICS_SITE_KEY",
]);

export async function safePm2Inventory(options) {
  const expectation = requiredExpectation(options.expect);
  const root = resolve(options.projectRoot);
  const rendered = await readRenderedCloudwaysEnvironment(options.environmentFile);
  const template = await readCloudwaysEnvironmentTemplate(root);
  assertRenderedEnvironmentShape(rendered.environment, template);
  assertPortablePrivateOwnership(rendered.metadata, "The rendered environment");
  const deploymentRoots = await exactDeploymentRoots(rendered.environment, root);
  if (!isStrictChild(deploymentRoots.privateRoot.realPath, rendered.realPath)) {
    throw new Error("The rendered environment is outside APP_PRIVATE_ROOT.");
  }
  const prefix = rendered.environment.PM2_PROCESS_PREFIX;
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(prefix ?? "")) {
    throw new Error("PM2_PROCESS_PREFIX is invalid.");
  }
  const cli = await regularRealPath(options.pm2Cli, "The PM2 CLI script");
  const boundCli = await regularRealPath(rendered.environment.PM2_CLI_SCRIPT, "PM2_CLI_SCRIPT");
  if (cli.realPath !== boundCli.realPath) {
    throw new Error("The selected PM2 CLI does not match the activation-bound PM2_CLI_SCRIPT.");
  }
  const nodeBinary = await regularRealPath(rendered.environment.NODE_BINARY, "NODE_BINARY");
  if (nodeBinary.realPath !== await realpath(process.execPath)) {
    throw new Error("NODE_BINARY does not match the running Node executable.");
  }
  const pm2Home = await directoryRealPath(rendered.environment.PM2_HOME, "PM2_HOME");
  assertPortablePrivateOwnership(pm2Home.metadata, "PM2_HOME");
  if (!isStrictChild(deploymentRoots.privateRoot.realPath, pm2Home.realPath)
    || isStrictChild(deploymentRoots.releasesRoot.realPath, pm2Home.realPath)) {
    throw new Error("PM2_HOME is not the stable private application daemon home.");
  }
  const childEnvironment = { ...process.env, PM2_HOME: pm2Home.realPath };
  const expectedProcessFingerprint = processEnvironmentFingerprint(
    rendered.environment,
    nodeBinary.realPath,
  );
  const result = spawnSync(nodeBinary.realPath, [cli.realPath, "jlist"], {
    cwd: root,
    env: childEnvironment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0 || result.error !== undefined) {
    throw new Error("PM2 inventory could not be captured safely.");
  }
  let processes;
  try {
    processes = JSON.parse(String(result.stdout));
  } catch {
    throw new Error("PM2 returned an invalid or oversized inventory.");
  }
  if (!Array.isArray(processes) || processes.length > 1_000) {
    throw new Error("PM2 returned an invalid or oversized inventory.");
  }
  const expectedDefinitions = [
    { name: `${prefix}-image-worker`, count: 1, script: resolve(root, "dist/workers/image-worker.js") },
    { name: `${prefix}-web`, count: Number(rendered.environment.WEB_INSTANCES), script: resolve(root, "dist/server.js") },
  ];
  const expected = [];
  for (const definition of expectedDefinitions) {
    const matches = processes.filter((process_) => process_?.name === definition.name);
    const item = Object.freeze({
      name: definition.name,
      expectedCount: definition.count,
      count: matches.length,
      countMatchesExpected: matches.length === definition.count,
      instances: Object.freeze(matches.map((process_) => {
        const cwdMatchesRelease = typeof process_?.pm2_env?.pm_cwd === "string"
          && resolve(process_.pm2_env.pm_cwd) === root;
        const scriptMatchesRelease = typeof process_?.pm2_env?.pm_exec_path === "string"
          && resolve(process_.pm2_env.pm_exec_path) === definition.script;
        const belongsToLineage = belongsToApplicationLineage(
          process_?.pm2_env?.pm_cwd,
          process_?.pm2_env?.pm_exec_path,
          deploymentRoots.releasesRoot.realPath,
          definition.script.endsWith("image-worker.js")
            ? "dist/workers/image-worker.js"
            : "dist/server.js",
        );
        const processFingerprint = processEnvironmentFingerprint(
          process_?.pm2_env,
          typeof process_?.pm2_env?.exec_interpreter === "string"
            ? process_.pm2_env.exec_interpreter
            : "",
        );
        return Object.freeze({
          pmId: safeInteger(process_?.pm_id),
          pid: safeInteger(process_?.pid),
          status: safeStatus(process_?.pm2_env?.status),
          cwdMatchesRelease,
          scriptMatchesRelease,
          belongsToApplicationLineage: belongsToLineage,
          releaseCwdSha256: belongsToLineage ? sha256(resolve(process_.pm2_env.pm_cwd)) : null,
          environmentFingerprintSha256: processFingerprint.sha256,
          environmentMatchesRendered: processFingerprint.sha256 === expectedProcessFingerprint.sha256,
          nodeInterpreterMatches: processFingerprint.interpreterMatches,
          releaseClassification: cwdMatchesRelease && scriptMatchesRelease
            ? "current-release"
            : belongsToLineage ? "same-lineage-old-release" : "foreign",
        });
      })),
    });
    if (item.count > 0 && (!item.countMatchesExpected
      || item.instances.some((instance) => !instance.belongsToApplicationLineage))) {
      throw new Error("An expected PM2 name collides with a different release, script, or process count.");
    }
    expected.push(item);
  }
  const activeReleaseCwds = new Set(expected.flatMap((item) => item.instances)
    .map((instance) => instance.releaseCwdSha256)
    .filter((value) => value !== null));
  if (activeReleaseCwds.size > 1) {
    throw new Error("Expected PM2 processes span multiple application release roots.");
  }
  assertExpectedState(expected, expectation);
  const versionResult = spawnSync(nodeBinary.realPath, [cli.realPath, "--version"], {
    cwd: root,
    env: childEnvironment,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  const pm2Version = versionResult.status === 0 ? extractVersion(String(versionResult.stdout)) : null;
  if (pm2Version === null) throw new Error("The exact PM2 CLI version could not be proven safely.");
  if (pm2Version !== rendered.environment.PM2_VERSION) {
    throw new Error("The exact PM2 CLI version does not match activation-bound PM2_VERSION.");
  }
  return Object.freeze({
    totalProcessCount: processes.length,
    otherProcessCount: processes.length - expected.reduce((total, item) => total + item.count, 0),
    applicationPrivateRootSha256: sha256(deploymentRoots.privateRoot.realPath),
    releaseCwdSha256: sha256(root),
    pm2HomeSha256: sha256(pm2Home.realPath),
    nodeVersion: process.version,
    nodeBinaryPathSha256: sha256(nodeBinary.realPath),
    nodeBinarySha256: sha256(await readFile(nodeBinary.realPath)),
    pm2CliVersion: pm2Version,
    pm2CliPathSha256: sha256(cli.realPath),
    pm2CliSha256: sha256(await readFile(cli.realPath)),
    expectedProcessEnvironmentSha256: expectedProcessFingerprint.sha256,
    expectation,
    expected: Object.freeze(expected),
  });
}

function requiredExpectation(value) {
  const selected = value ?? "neutral";
  if (["neutral", "absent", "current-online", "same-lineage-old-online"].includes(selected)) {
    return selected;
  }
  throw new Error("PM2 inventory expectation must be neutral, absent, current-online, or same-lineage-old-online.");
}

function assertExpectedState(expected, expectation) {
  if (expectation === "neutral") return;
  if (expectation === "absent") {
    if (expected.some((process_) => process_.count !== 0)) {
      throw new Error("PM2 inventory does not match the asserted absent state.");
    }
    return;
  }
  const requiredClass = expectation === "current-online"
    ? "current-release"
    : "same-lineage-old-release";
  if (expected.some((process_) => !process_.countMatchesExpected
    || process_.instances.some((instance) => instance.status !== "online"
      || instance.releaseClassification !== requiredClass
      || !instance.nodeInterpreterMatches
      || (expectation === "current-online"
        && !instance.environmentMatchesRendered)))) {
    throw new Error(`PM2 inventory does not match the asserted ${expectation} state.`);
  }
}

function processEnvironmentFingerprint(environment, interpreter) {
  const values = Object.fromEntries(boundProcessEnvironmentKeys.map((key) => [
    key,
    typeof environment?.[key] === "string" ? environment[key] : null,
  ]));
  const normalizedInterpreter = typeof interpreter === "string" && isAbsolute(interpreter)
    ? resolve(interpreter)
    : null;
  return Object.freeze({
    sha256: sha256(JSON.stringify({ values, nodeInterpreter: normalizedInterpreter })),
    interpreterMatches: normalizedInterpreter !== null
      && values.NODE_BINARY !== null
      && resolve(values.NODE_BINARY) === normalizedInterpreter,
  });
}

function belongsToApplicationLineage(cwd, script, releasesRoot, expectedRelativeScript) {
  if (typeof cwd !== "string" || typeof script !== "string") return false;
  const resolvedCwd = resolve(cwd);
  const child = relative(releasesRoot, resolvedCwd);
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child)
    && !child.includes("/") && !child.includes("\\")
    && resolve(script) === resolve(resolvedCwd, ...expectedRelativeScript.split("/"));
}

function extractVersion(source) {
  const matches = source.match(/(?:^|\s)([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)(?=\s|$)/g) ?? [];
  const candidate = matches.at(-1)?.trim();
  return candidate !== undefined && candidate.length <= 64 ? candidate : null;
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeStatus(value) {
  return ["online", "stopped", "errored", "launching", "one-launch-status"].includes(value)
    ? value
    : "unknown";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(arguments_) {
  const result = {
    projectRoot: resolve(fileURLToPath(new URL("..", import.meta.url))),
    environmentFile: "",
    pm2Cli: "",
    expect: "neutral",
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    const [name, inline] = argument.split("=", 2);
    const value = inline ?? arguments_[index + 1];
    if (!["--env-file", "--pm2-cli", "--expect"].includes(name) || value === undefined || value.length === 0) {
      throw new Error("Usage: safe-pm2-inventory.mjs --env-file=<absolute> --pm2-cli=<absolute> [--expect=neutral|absent|current-online|same-lineage-old-online]");
    }
    if (inline === undefined) index += 1;
    if (!isAbsolute(value)) throw new Error(`${name} must use an absolute path.`);
    if (name === "--env-file") result.environmentFile = resolve(value);
    if (name === "--pm2-cli") result.pm2Cli = resolve(value);
    if (name === "--expect") result.expect = value;
  }
  if (result.environmentFile.length === 0 || result.pm2Cli.length === 0) {
    throw new Error("Both --env-file and --pm2-cli are required.");
  }
  return result;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    const inventory = await safePm2Inventory(parseArguments(process.argv.slice(2)));
    process.stdout.write(
      `PM2 inventory (secret-safe): total=${inventory.totalProcessCount}, `
      + `other=${inventory.otherProcessCount}, expectation=${inventory.expectation}, `
      + `release-cwd-sha256=${inventory.releaseCwdSha256}.\n`,
    );
    process.stdout.write(
      `runtime: node=${inventory.nodeVersion}, node-sha256=${inventory.nodeBinarySha256}, `
      + `node-path-sha256=${inventory.nodeBinaryPathSha256}, pm2=${inventory.pm2CliVersion}, `
      + `pm2-cli-sha256=${inventory.pm2CliSha256}, pm2-cli-path-sha256=${inventory.pm2CliPathSha256}, `
      + `pm2-home-sha256=${inventory.pm2HomeSha256}, `
      + `app-private-root-sha256=${inventory.applicationPrivateRootSha256}.\n`,
    );
    for (const process_ of inventory.expected) {
      if (process_.count === 0) {
        process.stdout.write(`${process_.name}: absent, expected-count=${process_.expectedCount}.\n`);
      } else {
        process.stdout.write(
          `${process_.name}: count=${process_.count}, expected-count=${process_.expectedCount}, `
          + `count-match=${process_.countMatchesExpected}.\n`,
        );
        for (const instance of process_.instances) {
          process.stdout.write(
            `${process_.name}: pm-id=${instance.pmId ?? "unknown"}, pid=${instance.pid ?? "unknown"}, `
            + `status=${instance.status}, cwd-match=${instance.cwdMatchesRelease}, `
            + `script-match=${instance.scriptMatchesRelease}, `
            + `lineage-match=${instance.belongsToApplicationLineage}, `
            + `release-class=${instance.releaseClassification}, `
            + `env-match=${instance.environmentMatchesRendered}, `
            + `interpreter-match=${instance.nodeInterpreterMatches}, `
            + `env-sha256=${instance.environmentFingerprintSha256}.\n`,
          );
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 1_000)
      : "unknown PM2 inventory failure";
    process.stderr.write(`Safe PM2 inventory BLOCKED: ${message}\n`);
    process.exitCode = 1;
  }
}
