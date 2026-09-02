const { readFileSync } = require("node:fs");
const { isAbsolute, resolve } = require("node:path");

const pm2EnvironmentKeys = new Set([
  "PM2_PROCESS_PREFIX",
  "PM2_VERSION",
  "NODE_BINARY",
  "WEB_INSTANCES",
  "WEB_MAX_MEMORY_MB",
  "IMAGE_WORKER_MAX_MEMORY_MB",
  "IMAGE_JOB_TIMEOUT_MS",
  "IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS",
  "REDIS_CONNECT_TIMEOUT_MS",
  "REDIS_COMMAND_TIMEOUT_MS",
]);
const privatePm2Values = readWhitelistedEnvironment(resolve(__dirname, ".env"), pm2EnvironmentKeys);
const effectiveValue = (key) => process.env[key] ?? privatePm2Values[key];

const processPrefix = boundedProcessPrefix(effectiveValue("PM2_PROCESS_PREFIX"), "shortener");
const pm2Version = optionalSemanticVersion(effectiveValue("PM2_VERSION"));
const nodeBinary = requiredNodeBinary(effectiveValue("NODE_BINARY"));
const webInstances = boundedPositiveInteger(effectiveValue("WEB_INSTANCES"), 1, 4, "WEB_INSTANCES");
const webMaxMemoryMb = boundedMemoryInteger(effectiveValue("WEB_MAX_MEMORY_MB"), 384, 384, 4096, "WEB_MAX_MEMORY_MB");
const imageWorkerMaxMemoryMb = boundedMemoryInteger(
  effectiveValue("IMAGE_WORKER_MAX_MEMORY_MB"), 512, 512, 4096, "IMAGE_WORKER_MAX_MEMORY_MB",
);
// Keep explicit non-V8 headroom below PM2's RSS restart cap. The worker also
// owns Sharp/libvips buffers, so its minimum is intentionally higher.
const webOldSpaceMb = Math.min(256, webMaxMemoryMb - 128);
const imageWorkerOldSpaceMb = Math.min(384, imageWorkerMaxMemoryMb - 128);
const imageJobTimeoutMs = boundedInteger(
  effectiveValue("IMAGE_JOB_TIMEOUT_MS"), 30000, 1000, 300000, "IMAGE_JOB_TIMEOUT_MS",
);
const recoveryPreflightTimeoutMs = boundedInteger(
  effectiveValue("IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS"),
  5000,
  1000,
  30000,
  "IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS",
);
const redisConnectTimeoutMs = boundedInteger(
  effectiveValue("REDIS_CONNECT_TIMEOUT_MS"), 500, 50, 10000, "REDIS_CONNECT_TIMEOUT_MS",
);
const redisCommandTimeoutMs = boundedInteger(
  effectiveValue("REDIS_COMMAND_TIMEOUT_MS"), 200, 50, 5000, "REDIS_COMMAND_TIMEOUT_MS",
);
const imageSubmissionTimeoutMs = Math.min(
  imageJobTimeoutMs,
  Math.max(1000, redisConnectTimeoutMs + redisCommandTimeoutMs * 2),
);
const startupSafetyMarginMs = 15000;
const initialReadinessWaitMs = 12000;
const maximumReadinessProbeMs = 3000;
const webListenTimeoutMs = recoveryPreflightTimeoutMs
  + initialReadinessWaitMs
  + maximumReadinessProbeMs
  + startupSafetyMarginMs;
const workerListenTimeoutMs = redisConnectTimeoutMs
  + redisCommandTimeoutMs
  + startupSafetyMarginMs;
// A background recovery pass handles one job at a time. BullMQ may wait two
// image-job windows and at most ten sequential submission/state deadlines on
// its longest retained-job path. Cover that bound plus cleanup margin.
const webKillTimeoutMs = imageJobTimeoutMs * 2
  + imageSubmissionTimeoutMs * 10
  + startupSafetyMarginMs;
// This file is server-only and always exercises the production startup gates.
// Local development launches dist/server.js directly and must never weaken the
// checked PM2 process definition through an environment override.
const runtimeEnvironment = "production";
// Keep retrying at a bounded, low-frequency cadence while MariaDB/Redis finish
// a delayed provider boot. 240 attempts at 30 seconds cover roughly two hours;
// after that PM2 remains failed for explicit operator investigation.
const processRestartPolicy = Object.freeze({
  min_uptime: "30s",
  max_restarts: 240,
  restart_delay: 30000,
});

module.exports = {
  apps: [
    {
      name: `${processPrefix}-image-worker`,
      script: "dist/workers/image-worker.js",
      interpreter: nodeBinary,
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      ...processRestartPolicy,
      wait_ready: true,
      listen_timeout: workerListenTimeoutMs,
      // Give the singleton worker one bounded job window plus shutdown margin.
      kill_timeout: imageJobTimeoutMs + 15000,
      max_memory_restart: `${imageWorkerMaxMemoryMb}M`,
      node_args: `--enable-source-maps --max-old-space-size=${imageWorkerOldSpaceMb}`,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: runtimeEnvironment,
        PM2_PROCESS_PREFIX: processPrefix,
        ...(pm2Version === undefined ? {} : { PM2_VERSION: pm2Version }),
        NODE_BINARY: nodeBinary,
        WEB_INSTANCES: String(webInstances),
        WEB_MAX_MEMORY_MB: String(webMaxMemoryMb),
        IMAGE_WORKER_MAX_MEMORY_MB: String(imageWorkerMaxMemoryMb),
        IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS: String(recoveryPreflightTimeoutMs),
        IMAGE_EXECUTOR: "bullmq",
        IMAGE_JOB_TIMEOUT_MS: String(imageJobTimeoutMs),
        REDIS_CONNECT_TIMEOUT_MS: String(redisConnectTimeoutMs),
        REDIS_COMMAND_TIMEOUT_MS: String(redisCommandTimeoutMs),
      },
      env_production: {
        NODE_ENV: "production",
        PM2_PROCESS_PREFIX: processPrefix,
        ...(pm2Version === undefined ? {} : { PM2_VERSION: pm2Version }),
        NODE_BINARY: nodeBinary,
        WEB_INSTANCES: String(webInstances),
        WEB_MAX_MEMORY_MB: String(webMaxMemoryMb),
        IMAGE_WORKER_MAX_MEMORY_MB: String(imageWorkerMaxMemoryMb),
        IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS: String(recoveryPreflightTimeoutMs),
        IMAGE_EXECUTOR: "bullmq",
        IMAGE_JOB_TIMEOUT_MS: String(imageJobTimeoutMs),
        REDIS_CONNECT_TIMEOUT_MS: String(redisConnectTimeoutMs),
        REDIS_COMMAND_TIMEOUT_MS: String(redisCommandTimeoutMs),
      },
    },
    {
      name: `${processPrefix}-web`,
      script: "dist/server.js",
      interpreter: nodeBinary,
      cwd: __dirname,
      instances: webInstances,
      exec_mode: webInstances > 1 ? "cluster" : "fork",
      instance_var: "NODE_APP_INSTANCE",
      autorestart: true,
      ...processRestartPolicy,
      wait_ready: true,
      listen_timeout: webListenTimeoutMs,
      kill_timeout: webKillTimeoutMs,
      max_memory_restart: `${webMaxMemoryMb}M`,
      node_args: `--enable-source-maps --max-old-space-size=${webOldSpaceMb}`,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: runtimeEnvironment,
        PM2_PROCESS_PREFIX: processPrefix,
        ...(pm2Version === undefined ? {} : { PM2_VERSION: pm2Version }),
        NODE_BINARY: nodeBinary,
        WEB_INSTANCES: String(webInstances),
        WEB_MAX_MEMORY_MB: String(webMaxMemoryMb),
        IMAGE_WORKER_MAX_MEMORY_MB: String(imageWorkerMaxMemoryMb),
        IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS: String(recoveryPreflightTimeoutMs),
        IMAGE_JOB_TIMEOUT_MS: String(imageJobTimeoutMs),
        REDIS_CONNECT_TIMEOUT_MS: String(redisConnectTimeoutMs),
        REDIS_COMMAND_TIMEOUT_MS: String(redisCommandTimeoutMs),
      },
      env_production: {
        NODE_ENV: "production",
        PM2_PROCESS_PREFIX: processPrefix,
        ...(pm2Version === undefined ? {} : { PM2_VERSION: pm2Version }),
        NODE_BINARY: nodeBinary,
        WEB_INSTANCES: String(webInstances),
        WEB_MAX_MEMORY_MB: String(webMaxMemoryMb),
        IMAGE_WORKER_MAX_MEMORY_MB: String(imageWorkerMaxMemoryMb),
        IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS: String(recoveryPreflightTimeoutMs),
        IMAGE_JOB_TIMEOUT_MS: String(imageJobTimeoutMs),
        REDIS_CONNECT_TIMEOUT_MS: String(redisConnectTimeoutMs),
        REDIS_COMMAND_TIMEOUT_MS: String(redisCommandTimeoutMs),
      },
    },
  ],
};

function boundedPositiveInteger(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum) return parsed;
  throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
}

function boundedProcessPrefix(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)) return value;
  throw new Error("PM2_PROCESS_PREFIX is present but invalid; refusing an ambiguous process name.");
}

function optionalSemanticVersion(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value)
    && value.length <= 64) return value;
  throw new Error("PM2_VERSION must be one exact semantic version when present.");
}

function requiredNodeBinary(value) {
  const selected = value ?? process.execPath;
  if (!isAbsolute(selected) || resolve(selected) !== resolve(process.execPath)) {
    throw new Error("NODE_BINARY must be the exact absolute Node executable running PM2.");
  }
  return resolve(selected);
}

function boundedInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
}

function boundedMemoryInteger(value, fallback, minimum, maximum, name) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  throw new Error(`${name} must be an integer between ${minimum} and ${maximum} MiB.`);
}

/** Read only non-secret PM2 sizing values; never export the rest of .env. */
function readWhitelistedEnvironment(path, allowedKeys) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return Object.freeze({});
    throw error;
  }
  if (Buffer.byteLength(text, "utf8") > 262144) {
    throw new Error("Private .env is too large for the bounded PM2 whitelist reader.");
  }
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null || !allowedKeys.has(match[1])) continue;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new Error(`Private .env repeats PM2 whitelist key ${key}.`);
    }
    result[key] = match[2].trim();
  }
  return Object.freeze(result);
}
