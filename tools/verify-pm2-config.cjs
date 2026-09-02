const assert = require("node:assert/strict");
const path = require("node:path");

process.env.SHORTENER_PM2_MODE = "development";
delete process.env.IMAGE_JOB_TIMEOUT_MS;
delete process.env.IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS;
delete process.env.REDIS_CONNECT_TIMEOUT_MS;
delete process.env.REDIS_COMMAND_TIMEOUT_MS;
delete process.env.WEB_INSTANCES;
delete process.env.WEB_MAX_MEMORY_MB;
delete process.env.IMAGE_WORKER_MAX_MEMORY_MB;
process.env.PM2_PROCESS_PREFIX = "pilot-multi";
process.env.PM2_VERSION = "6.2.0";
process.env.NODE_BINARY = process.execPath;
process.env.WEB_MAX_MEMORY = "999999G";
process.env.IMAGE_WORKER_MAX_MEMORY = "999999G";
const config = require(path.resolve("ecosystem.config.cjs"));
assert.ok(Array.isArray(config.apps), "PM2 config must export an apps array.");
assert.equal(config.apps.length, 2, "PM2 must define exactly web and image-worker processes.");
const web = config.apps.find((app) => app.name === "pilot-multi-web");
const worker = config.apps.find((app) => app.name === "pilot-multi-image-worker");
assert.ok(web, "PM2 web process is missing.");
assert.ok(worker, "PM2 image worker is missing.");
assert.equal(config.apps[0].name, "pilot-multi-image-worker",
  "The singleton worker must be declared before web listener admission.");
assert.equal(web.env.NODE_ENV, "production", "Default PM2 web startup must fail closed as production.");
assert.equal(worker.env.NODE_ENV, "production", "Default PM2 worker startup must fail closed as production.");
assert.equal(web.env.PM2_PROCESS_PREFIX, "pilot-multi");
assert.equal(worker.env.PM2_PROCESS_PREFIX, "pilot-multi");
assert.equal(web.env.PM2_VERSION, "6.2.0");
assert.equal(worker.env.PM2_VERSION, "6.2.0");
assert.equal(web.interpreter, process.execPath);
assert.equal(worker.interpreter, process.execPath);
assert.equal(web.env.NODE_ENV, web.env_production.NODE_ENV,
  "No environment override may bypass production startup for the PM2 web process.");
assert.equal(worker.env.NODE_ENV, worker.env_production.NODE_ENV,
  "No environment override may bypass production startup for the PM2 worker.");
assert.equal(worker.instances, 1, "There must be exactly one image worker.");
assert.equal(web.max_memory_restart, "384M", "Unvalidated legacy web memory input must be ignored.");
assert.equal(worker.max_memory_restart, "512M", "Unvalidated legacy worker memory input must be ignored.");
assert.equal(web.env.WEB_INSTANCES, "1");
assert.equal(web.env.WEB_MAX_MEMORY_MB, "384");
assert.equal(worker.env.IMAGE_WORKER_MAX_MEMORY_MB, "512");
assert.ok(web.instances >= 1 && web.instances <= 4, "Web instances must stay within the measured 1-4 bound.");
assert.equal(worker.env.IMAGE_EXECUTOR, "bullmq", "The PM2 worker must use BullMQ.");
assert.equal(web.wait_ready, true);
assert.equal(worker.wait_ready, true);
assert.equal(web.instance_var, "NODE_APP_INSTANCE", "Recovery ownership must use PM2's stable instance id.");
assert.equal(web.env.IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS, "5000");
assert.equal(web.env.IMAGE_JOB_TIMEOUT_MS, "30000");
assert.equal(worker.env.IMAGE_JOB_TIMEOUT_MS, web.env.IMAGE_JOB_TIMEOUT_MS,
  "Web and worker must receive the same timeout used by the PM2 formulas.");
assert.equal(worker.env.REDIS_CONNECT_TIMEOUT_MS, web.env.REDIS_CONNECT_TIMEOUT_MS);
assert.equal(worker.env.REDIS_COMMAND_TIMEOUT_MS, web.env.REDIS_COMMAND_TIMEOUT_MS);
for (const key of [
  "IMAGE_JOB_TIMEOUT_MS",
  "REDIS_CONNECT_TIMEOUT_MS",
  "REDIS_COMMAND_TIMEOUT_MS",
]) {
  assert.equal(web.env_production[key], web.env[key], `Production web ${key} must match its PM2 timeout formula.`);
  assert.equal(worker.env_production[key], worker.env[key], `Production worker ${key} must match web/PM2.`);
}
assert.equal(web.listen_timeout, 35000,
  "Web listen timeout must cover preflight, the 12s readiness wait, one bounded probe and startup margin.");
assert.equal(worker.listen_timeout, 15700,
  "Worker listen timeout must cover Redis connection, first heartbeat command and startup margin.");
assert.equal(web.kill_timeout, 85000,
  "Web shutdown must cover two execution windows, ten submission deadlines and cleanup margin.");
assert.ok(worker.kill_timeout >= 45000 && worker.kill_timeout <= 315000,
  "Worker shutdown must cover one bounded image job plus margin.");
assert.equal(web.min_uptime, "30s");
assert.equal(worker.min_uptime, "30s");
assert.equal(web.max_restarts, 240);
assert.equal(worker.max_restarts, 240);
assert.equal(web.restart_delay, 30000);
assert.equal(worker.restart_delay, 30000);
assert.equal(web.exp_backoff_restart_delay, undefined);
assert.equal(worker.exp_backoff_restart_delay, undefined);
assert.ok(web.max_restarts * web.restart_delay >= 2 * 60 * 60 * 1000,
  "web must keep retrying for a prolonged dependency-late provider boot");
assert.ok(worker.max_restarts * worker.restart_delay >= 2 * 60 * 60 * 1000,
  "worker must keep retrying for a prolonged dependency-late provider boot");
const simulatedDependencyReadyAtMs = 20 * 60 * 1000;
const simulatedSuccessfulAttempt = Math.ceil(simulatedDependencyReadyAtMs / web.restart_delay) + 1;
assert.ok(simulatedSuccessfulAttempt < web.max_restarts,
  "a dependency restored after twenty minutes must still have a scheduled web retry");
assert.ok(simulatedSuccessfulAttempt < worker.max_restarts,
  "a dependency restored after twenty minutes must still have a scheduled worker retry");

process.env.IMAGE_JOB_TIMEOUT_MS = "300000";
process.env.IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS = "30000";
process.env.REDIS_CONNECT_TIMEOUT_MS = "10000";
process.env.REDIS_COMMAND_TIMEOUT_MS = "5000";
process.env.WEB_INSTANCES = "4";
process.env.WEB_MAX_MEMORY_MB = "4096";
process.env.IMAGE_WORKER_MAX_MEMORY_MB = "4096";
delete require.cache[require.resolve(path.resolve("ecosystem.config.cjs"))];
const maximumConfig = require(path.resolve("ecosystem.config.cjs"));
const maximumWeb = maximumConfig.apps.find((app) => app.name === "pilot-multi-web");
const maximumWorker = maximumConfig.apps.find((app) => app.name === "pilot-multi-image-worker");
assert.equal(maximumWeb.listen_timeout, 60000,
  "Maximum web listen timeout must remain derived from preflight plus bounded readiness.");
assert.equal(maximumWorker.listen_timeout, 30000,
  "Maximum worker listen timeout must remain derived from Redis bounds.");
assert.equal(maximumWeb.kill_timeout, 815000,
  "Maximum web shutdown must remain derived from execution and Redis deadline bounds.");
assert.equal(maximumWeb.env.IMAGE_JOB_TIMEOUT_MS, "300000");
assert.equal(maximumWorker.env.IMAGE_JOB_TIMEOUT_MS, "300000");
assert.equal(maximumWeb.instances, 4);
assert.equal(maximumWeb.max_memory_restart, "4096M");
assert.equal(maximumWorker.max_memory_restart, "4096M");
assert.equal(maximumWeb.env.WEB_INSTANCES, "4");
assert.equal(maximumWorker.env.WEB_INSTANCES, "4");

process.env.WEB_MAX_MEMORY_MB = "383";
delete require.cache[require.resolve(path.resolve("ecosystem.config.cjs"))];
assert.throws(
  () => require(path.resolve("ecosystem.config.cjs")),
  /WEB_MAX_MEMORY_MB must be an integer between 384 and 4096 MiB/,
  "A cap below the web heap plus native-memory floor must fail closed.",
);
process.env.WEB_MAX_MEMORY_MB = "4096";
process.env.IMAGE_WORKER_MAX_MEMORY_MB = "511";
delete require.cache[require.resolve(path.resolve("ecosystem.config.cjs"))];
assert.throws(
  () => require(path.resolve("ecosystem.config.cjs")),
  /IMAGE_WORKER_MAX_MEMORY_MB must be an integer between 512 and 4096 MiB/,
  "A cap below the Sharp worker heap plus native-memory floor must fail closed.",
);
process.env.IMAGE_WORKER_MAX_MEMORY_MB = "4096";

process.env.WEB_INSTANCES = "0";
delete require.cache[require.resolve(path.resolve("ecosystem.config.cjs"))];
assert.throws(
  () => require(path.resolve("ecosystem.config.cjs")),
  /WEB_INSTANCES must be an integer between 1 and 4/,
  "An explicit invalid web topology must not silently become the default.",
);
process.env.WEB_INSTANCES = "4";
process.env.REDIS_COMMAND_TIMEOUT_MS = "5001";
delete require.cache[require.resolve(path.resolve("ecosystem.config.cjs"))];
assert.throws(
  () => require(path.resolve("ecosystem.config.cjs")),
  /REDIS_COMMAND_TIMEOUT_MS must be an integer between 50 and 5000/,
  "An explicit invalid PM2 timeout must not silently become the default.",
);
process.env.REDIS_COMMAND_TIMEOUT_MS = "5000";

process.env.PM2_PROCESS_PREFIX = "../unsafe name";
delete require.cache[require.resolve(path.resolve("ecosystem.config.cjs"))];
assert.throws(
  () => require(path.resolve("ecosystem.config.cjs")),
  /present but invalid/,
  "An explicitly unsafe PM2 prefix must fail instead of colliding with the default app.",
);

delete process.env.PM2_PROCESS_PREFIX;
delete process.env.PM2_VERSION;
delete process.env.NODE_BINARY;
delete require.cache[require.resolve(path.resolve("ecosystem.config.cjs"))];
const defaultPrefixConfig = require(path.resolve("ecosystem.config.cjs"));
assert.ok(defaultPrefixConfig.apps.some((app) => app.name === "shortener-web"),
  "The bounded default is allowed only when PM2_PROCESS_PREFIX is absent.");
assert.ok(defaultPrefixConfig.apps.some((app) => app.name === "shortener-image-worker"));

delete process.env.SHORTENER_PM2_MODE;
delete process.env.WEB_MAX_MEMORY;
delete process.env.IMAGE_WORKER_MAX_MEMORY;

process.stdout.write("PM2 config verified: bounded preflight + singleton background recovery + one BullMQ worker.\n");
