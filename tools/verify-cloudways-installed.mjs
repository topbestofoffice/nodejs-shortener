import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoTemplatePlaceholder,
  assertLocalPilotTransports,
  assertPortablePrivateOwnership,
  assertPortablePublicConfigOwnership,
  assertRenderedEnvironmentShape,
  directoryRealPath,
  exactDeploymentRoots,
  isStrictChild,
  readCloudwaysEnvironmentTemplate,
  readRenderedCloudwaysEnvironment,
  regularRealPath,
} from "./cloudways-rendered-env.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/;
const exactTargetPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,159}$/;

export async function verifyInstalledCloudways(options) {
  const root = resolve(options.projectRoot);
  const rendered = await readRenderedCloudwaysEnvironment(options.environmentFile);
  const templateEnvironment = await readCloudwaysEnvironmentTemplate(root);
  assertRenderedEnvironmentShape(rendered.environment, templateEnvironment);
  const environmentPermission = assertPortablePrivateOwnership(
    rendered.metadata,
    "The rendered environment",
  );
  validateProductionEnvironmentInvariants(rendered.environment);
  assertLocalPilotTransports(rendered.environment);

  const installedHtaccess = await regularRealPath(options.htaccessFile, "The installed .htaccess");
  if (basename(installedHtaccess.realPath) !== ".htaccess") {
    throw new Error("The installed proxy configuration must be the exact .htaccess file.");
  }
  const htaccessPermission = assertPortablePublicConfigOwnership(
    installedHtaccess.metadata,
    "The installed .htaccess",
  );
  const webRoot = dirname(installedHtaccess.realPath);
  const rootRealPath = await realpath(root);
  if (rootRealPath === webRoot || isStrictChild(webRoot, rootRealPath)) {
    throw new Error("The Node release root must remain outside public_html.");
  }
  const deploymentRoots = await exactDeploymentRoots(rendered.environment, rootRealPath);
  assertPortablePublicConfigOwnership(deploymentRoots.privateRoot.metadata, "APP_PRIVATE_ROOT");
  assertPortablePublicConfigOwnership(deploymentRoots.releaseRoot.metadata, "APP_RELEASE_ROOT");
  if (!isStrictChild(deploymentRoots.privateRoot.realPath, rendered.realPath)) {
    throw new Error("The rendered environment must stay inside this exact APP_PRIVATE_ROOT.");
  }
  if (rendered.realPath === installedHtaccess.realPath || isStrictChild(webRoot, rendered.realPath)) {
    throw new Error("The rendered environment must remain outside the public webroot.");
  }

  const [installedSource, templateSource] = await Promise.all([
    readBoundedText(installedHtaccess.realPath, 131_072, "installed .htaccess"),
    readBoundedText(resolve(root, "deploy/cloudways/public_html.htaccess.example"), 131_072,
      "Cloudways .htaccess template"),
  ]);
  validateInstalledHtaccess(installedSource, templateSource, rendered.environment.PORT);

  const uploadDirectory = await directoryRealPath(
    rendered.environment.PUBLIC_UPLOAD_DIR,
    "PUBLIC_UPLOAD_DIR",
  );
  const expectedUploadDirectory = await directoryRealPath(resolve(webRoot, "uploads"), "public_html/uploads");
  if (uploadDirectory.realPath !== expectedUploadDirectory.realPath) {
    throw new Error("PUBLIC_UPLOAD_DIR must be this installed webroot's uploads directory.");
  }
  assertPortablePublicConfigOwnership(uploadDirectory.metadata, "PUBLIC_UPLOAD_DIR");
  const temporaryDirectory = await directoryRealPath(
    rendered.environment.PRIVATE_TEMP_DIR,
    "PRIVATE_TEMP_DIR",
  );
  if (temporaryDirectory.realPath === webRoot || isStrictChild(webRoot, temporaryDirectory.realPath)) {
    throw new Error("PRIVATE_TEMP_DIR must remain outside the public webroot.");
  }
  if (!isStrictChild(deploymentRoots.privateRoot.realPath, temporaryDirectory.realPath)
    || isStrictChild(deploymentRoots.releasesRoot.realPath, temporaryDirectory.realPath)) {
    throw new Error("PRIVATE_TEMP_DIR must stay inside this exact APP_PRIVATE_ROOT.");
  }
  assertPortablePrivateOwnership(temporaryDirectory.metadata, "PRIVATE_TEMP_DIR");
  if (temporaryDirectory.metadata.dev !== uploadDirectory.metadata.dev) {
    throw new Error("PRIVATE_TEMP_DIR and PUBLIC_UPLOAD_DIR are not on the same filesystem.");
  }
  const pm2Home = await directoryRealPath(rendered.environment.PM2_HOME, "PM2_HOME");
  assertPortablePrivateOwnership(pm2Home.metadata, "PM2_HOME");
  if (pm2Home.realPath === webRoot || isStrictChild(webRoot, pm2Home.realPath)) {
    throw new Error("PM2_HOME must remain outside the public webroot.");
  }
  if (!isStrictChild(deploymentRoots.privateRoot.realPath, pm2Home.realPath)
    || isStrictChild(deploymentRoots.releasesRoot.realPath, pm2Home.realPath)) {
    throw new Error("PM2_HOME must stay inside this exact APP_PRIVATE_ROOT.");
  }

  let runtimeConfig;
  try {
    runtimeConfig = await options.loadRuntimeConfig(rendered.environment, root);
  } catch {
    throw new Error("The rendered environment does not satisfy the production runtime contract.");
  }
  try {
    options.assertProductionStartupAllowed(runtimeConfig, {
      environment: rendered.environment,
      projectRoot: root,
    });
  } catch {
    throw new Error("The activation is not valid for this exact runtime, target and readiness material.");
  }
  const runtimePm2Sha256 = options.productionPm2DeploymentConfigurationSha256(
    runtimeConfig,
    rendered.environment.PM2_HOME,
    rendered.environment.NODE_BINARY,
    rendered.environment.APP_PRIVATE_ROOT,
    rendered.environment.APP_RELEASE_ROOT,
    rendered.environment.PM2_CLI_SCRIPT,
    rendered.environment.PM2_VERSION,
  );
  if (runtimePm2Sha256 !== pm2DeploymentConfigurationSha256(rendered.environment)) {
    throw new Error("The rendered PM2 knobs do not match the activation-bound runtime topology.");
  }

  return Object.freeze({
    activationSha256: rendered.environment.NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256,
    htaccessSha256: sha256(installedSource),
    runtimeConfigurationSha256: options.productionRuntimeConfigurationSha256(runtimeConfig),
    pm2DeploymentConfigurationSha256: runtimePm2Sha256,
    portablePermissions: environmentPermission === "verified" && htaccessPermission === "verified"
      ? "verified"
      : "not-portable",
  });
}

function validateProductionEnvironmentInvariants(environment) {
  const exact = {
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    TRUST_PROXY: "loopback",
    PROXY_CHAIN_VERIFIED: "true",
    ORIGIN_AUTH_ENABLED: "true",
    STORAGE_DRIVER: "mysql",
    IMAGE_EXECUTOR: "bullmq",
    SERVE_STATIC_UPLOADS: "false",
    DEV_SEED_USERNAME: "",
    DEV_SEED_PASSWORD: "",
    REDIRECT_ENGINE: "current",
    PILOT_HEADER_DIAGNOSTICS: "false",
  };
  for (const [key, expected] of Object.entries(exact)) {
    if (environment[key] !== expected) throw new Error(`The rendered environment must set ${key}=${expected}.`);
  }
  if (environment.NODE_SHORTENER_DEPLOYMENT_STAGE !== "pilot"
    && environment.NODE_SHORTENER_DEPLOYMENT_STAGE !== "release") {
    throw new Error("NODE_SHORTENER_DEPLOYMENT_STAGE must be pilot or release.");
  }
  const target = environment.NODE_SHORTENER_DEPLOYMENT_TARGET_ID;
  if (!exactTargetPattern.test(target ?? "") || !/[0-9]/.test(target)
    || /(?:^|[._:/-])(?:all|any|default|global|localhost|pending|tbd|unknown|unset|wildcard)(?:$|[._:/-])/i.test(target)) {
    throw new Error("NODE_SHORTENER_DEPLOYMENT_TARGET_ID must identify one exact target.");
  }
  if (!/^[1-9][0-9]{0,4}$/.test(environment.PORT ?? "") || Number(environment.PORT) > 65_535) {
    throw new Error("PORT must be one exact non-zero loopback port.");
  }
  if (!/^private\/activation\/[A-Za-z0-9._-]+\.json$/.test(
    environment.NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE ?? "",
  )) {
    throw new Error("The activation file must be one safe private/activation JSON path.");
  }
  if (!sha256Pattern.test(environment.NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256 ?? "")) {
    throw new Error("NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256 must be one exact digest.");
  }
  validatePm2DeploymentEnvironment(environment);
}

export function validatePm2DeploymentEnvironment(environment) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(environment.PM2_PROCESS_PREFIX ?? "")) {
    throw new Error("PM2_PROCESS_PREFIX must be one exact bounded process prefix.");
  }
  if (!isAbsolute(environment.PM2_HOME ?? "") || environment.PM2_HOME.length > 500) {
    throw new Error("PM2_HOME must be one exact absolute private directory.");
  }
  if (!isAbsolute(environment.NODE_BINARY ?? "") || environment.NODE_BINARY.length > 500) {
    throw new Error("NODE_BINARY must be one exact absolute executable path.");
  }
  let nodeBinary;
  try {
    nodeBinary = realpathSync(environment.NODE_BINARY);
  } catch {
    throw new Error("NODE_BINARY must resolve to the running Node executable.");
  }
  if (nodeBinary !== realpathSync(process.execPath)) {
    throw new Error("NODE_BINARY does not match the running Node executable.");
  }
  requiredRegularFile(environment.PM2_CLI_SCRIPT, "PM2_CLI_SCRIPT");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(environment.PM2_VERSION ?? "")
    || environment.PM2_VERSION.length > 64) {
    throw new Error("PM2_VERSION must be one exact semantic version.");
  }
  for (const [key, minimum, maximum] of [
    ["WEB_INSTANCES", 1, 4],
    ["WEB_MAX_MEMORY_MB", 128, 4_096],
    ["IMAGE_WORKER_MAX_MEMORY_MB", 128, 4_096],
    ["IMAGE_JOB_TIMEOUT_MS", 1_000, 300_000],
    ["IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS", 1_000, 30_000],
    ["REDIS_CONNECT_TIMEOUT_MS", 50, 10_000],
    ["REDIS_COMMAND_TIMEOUT_MS", 50, 5_000],
  ]) {
    if (!boundedInteger(environment[key], minimum, maximum)) {
      throw new Error(`${key} must be an explicit whole number from ${minimum} to ${maximum}.`);
    }
  }
}

export function pm2DeploymentConfigurationSha256(environment) {
  validatePm2DeploymentEnvironment(environment);
  const nodeBinary = realpathSync(environment.NODE_BINARY);
  const pm2CliScript = requiredRegularFile(environment.PM2_CLI_SCRIPT, "PM2_CLI_SCRIPT");
  const binding = {
    applicationPrivateRootSha256: sha256(resolve(environment.APP_PRIVATE_ROOT)),
    applicationReleaseRootSha256: sha256(resolve(environment.APP_RELEASE_ROOT)),
    pm2HomeSha256: sha256(resolve(environment.PM2_HOME)),
    nodeBinaryPathSha256: sha256(nodeBinary),
    nodeBinarySha256: sha256(readFileSync(nodeBinary)),
    pm2CliScriptPathSha256: sha256(pm2CliScript),
    pm2CliScriptSha256: sha256(readFileSync(pm2CliScript)),
    pm2Version: environment.PM2_VERSION,
    processPrefix: environment.PM2_PROCESS_PREFIX,
    webInstances: Number(environment.WEB_INSTANCES),
    webMaxMemoryMb: Number(environment.WEB_MAX_MEMORY_MB),
    imageWorkerMaxMemoryMb: Number(environment.IMAGE_WORKER_MAX_MEMORY_MB),
    imageJobTimeoutMs: Number(environment.IMAGE_JOB_TIMEOUT_MS),
    imageRecoveryPreflightTimeoutMs: Number(environment.IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS),
    redisConnectTimeoutMs: Number(environment.REDIS_CONNECT_TIMEOUT_MS),
    redisCommandTimeoutMs: Number(environment.REDIS_COMMAND_TIMEOUT_MS),
    restartPolicy: {
      minUptimeMs: 30_000,
      maxRestarts: 240,
      restartDelayMs: 30_000,
    },
  };
  return sha256(JSON.stringify(binding));
}

function requiredRegularFile(value, name) {
  if (!isAbsolute(value ?? "") || value.length > 500) {
    throw new Error(`${name} must be one exact absolute regular-file path.`);
  }
  let metadata;
  try {
    metadata = lstatSync(value);
  } catch {
    throw new Error(`${name} must resolve to one exact regular file.`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${name} must be one exact non-symlink regular file.`);
  }
  return realpathSync(value);
}

function boundedInteger(value, minimum, maximum) {
  return /^(?:0|[1-9][0-9]*)$/.test(value ?? "")
    && Number.isSafeInteger(Number(value)) && Number(value) >= minimum && Number(value) <= maximum;
}

function validateInstalledHtaccess(installedSource, templateSource, port) {
  assertNoTemplatePlaceholder(installedSource, "The installed .htaccess");
  const expectedSource = templateSource.replaceAll("__UNIQUE_LOOPBACK_PORT__", port);
  const installedLines = activeDirectives(installedSource);
  const expectedLines = activeDirectives(expectedSource);
  if (JSON.stringify(installedLines) !== JSON.stringify(expectedLines)) {
    throw new Error("The installed .htaccess has missing, reordered, or unexpected proxy/static directives.");
  }
  const proxyRules = installedLines.filter((line) => /\[[^\]]*\bP\b[^\]]*\]/.test(line));
  if (proxyRules.length !== 1
    || !proxyRules[0].includes(`http://127.0.0.1:${port}/`)
    || installedLines.some((line) => /\b(?:ProxyPreserveHost|RequestHeader)\b/i.test(line))) {
    throw new Error("The installed .htaccess does not contain the one exact loopback proxy boundary.");
  }
}

function activeDirectives(source) {
  return source.replace(/^\uFEFF/, "").split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

async function readBoundedText(path, limit, context) {
  const bytes = await readFile(path);
  if (bytes.byteLength > limit) throw new Error(`${context} exceeds its bounded size.`);
  return bytes.toString("utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(arguments_) {
  const result = {
    projectRoot: resolve(fileURLToPath(new URL("..", import.meta.url))),
    environmentFile: "",
    htaccessFile: "",
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    const [name, inline] = argument.split("=", 2);
    const value = inline ?? arguments_[index + 1];
    if (!["--env-file", "--htaccess"].includes(name) || value === undefined || value.length === 0) {
      throw new Error("Usage: verify-cloudways-installed.mjs --env-file=<absolute> --htaccess=<absolute>");
    }
    if (inline === undefined) index += 1;
    if (!isAbsolute(value)) throw new Error(`${name} must use an absolute path.`);
    if (name === "--env-file") result.environmentFile = resolve(value);
    if (name === "--htaccess") result.htaccessFile = resolve(value);
  }
  if (result.environmentFile.length === 0 || result.htaccessFile.length === 0) {
    throw new Error("Both --env-file and --htaccess are required.");
  }
  return result;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const [{ loadRuntimeConfig }, startup] = await Promise.all([
      import(new URL("../dist/config/runtime.js", import.meta.url)),
      import(new URL("../dist/config/production-startup.js", import.meta.url)),
    ]);
    const result = await verifyInstalledCloudways({
      ...options,
      loadRuntimeConfig,
      assertProductionStartupAllowed: startup.assertProductionStartupAllowed,
      productionRuntimeConfigurationSha256: startup.productionRuntimeConfigurationSha256,
      productionPm2DeploymentConfigurationSha256: startup.productionPm2DeploymentConfigurationSha256,
    });
    process.stdout.write(
      "Installed Cloudways preflight VERIFIED: "
      + `activation=${result.activationSha256}, artifact-runtime=${result.runtimeConfigurationSha256}, `
      + `pm2-config=${result.pm2DeploymentConfigurationSha256}, htaccess=${result.htaccessSha256}, `
      + `portable-permissions=${result.portablePermissions}.\n`,
    );
  } catch (error) {
    process.stderr.write(`Installed Cloudways preflight BLOCKED: ${safeError(error)}\n`);
    process.exitCode = 1;
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : "unknown preflight failure";
  return message.replace(/(?:redis|rediss|mysql):\/\/[^\s/@:]+:[^\s/@]+@/gi, "$&".replace(/.*/, "[redacted-uri]"))
    .replace(/[\r\n]+/g, " ").slice(0, 1_000);
}
