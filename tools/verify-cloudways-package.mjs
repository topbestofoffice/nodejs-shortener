import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const packagePaths = Object.freeze({
  readme: "deploy/cloudways/README.md",
  environment: "deploy/cloudways/pilot.env.example",
  htaccess: "deploy/cloudways/public_html.htaccess.example",
});

const activationKeys = Object.freeze([
  "NODE_SHORTENER_DEPLOYMENT_STAGE",
  "NODE_SHORTENER_DEPLOYMENT_TARGET_ID",
  "NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE",
  "NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256",
]);

const runtimeKeys = Object.freeze([
  "NODE_ENV",
  "APP_PRIVATE_ROOT",
  "APP_RELEASE_ROOT",
  "NODE_BINARY",
  "APP_NAMESPACE",
  "HOST",
  "PORT",
  "LOG_LEVEL",
  "DOMAIN_CONFIG_FILE",
  "TRUST_PROXY",
  "TRUST_CLOUDFLARE_HEADERS",
  "CLOUDFLARE_HEADER_SANITIZATION_VERIFIED",
  "PROXY_CHAIN_VERIFIED",
  "ORIGIN_AUTH_ENABLED",
  "ORIGIN_AUTH_HEADER",
  "ORIGIN_AUTH_SHA256",
  "STORAGE_DRIVER",
  "MYSQL_HOST",
  "MYSQL_PORT",
  "MYSQL_DATABASE",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_CONNECTION_LIMIT",
  "MYSQL_QUEUE_LIMIT",
  "REDIS_URL",
  "REDIS_KEY_PREFIX",
  "REDIS_CONNECT_TIMEOUT_MS",
  "REDIS_COMMAND_TIMEOUT_MS",
  "DELIVERED_COUNTRY_DOMAIN_IDS",
  "IP_HASH_SECRET",
  "COOKIE_SIGNING_SECRET",
  "SESSION_TTL_SECONDS",
  "PM2_PROCESS_PREFIX",
  "PM2_HOME",
  "PM2_CLI_SCRIPT",
  "PM2_VERSION",
  "WEB_INSTANCES",
  "WEB_MAX_MEMORY_MB",
  "IMAGE_WORKER_MAX_MEMORY_MB",
  "IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS",
  "CODE_LENGTH",
  "MAX_BULK_LINKS",
  "MAX_BULK_IMAGES",
  "BROWSER_SCOPED_DEFAULT_USERS",
  "IMAGE_EXECUTOR",
  "PRIVATE_TEMP_DIR",
  "PUBLIC_UPLOAD_DIR",
  "MAX_UPLOAD_BYTES",
  "MAX_IMAGE_PIXELS",
  "MAX_READY_UPLOADS_PER_SESSION",
  "MAX_READY_UPLOADS_TOTAL",
  "UPLOAD_OWNERSHIP_TTL_SECONDS",
  "IMAGE_JOB_TIMEOUT_MS",
  "SERVE_STATIC_UPLOADS",
  "DEV_SEED_USERNAME",
  "DEV_SEED_PASSWORD",
  "REDIRECT_ENGINE",
  "DATACENTER_RANGES_FILE",
  "PILOT_HEADER_DIAGNOSTICS",
  "PILOT_DIAGNOSTIC_TOKEN_SHA256",
  "ANALYTICS_MEASUREMENT_ID",
  "ANALYTICS_SITE_KEY",
]);

const exactEnvironmentValues = Object.freeze({
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  NODE_SHORTENER_DEPLOYMENT_STAGE: "pilot",
  TRUST_PROXY: "loopback",
  TRUST_CLOUDFLARE_HEADERS: "false",
  CLOUDFLARE_HEADER_SANITIZATION_VERIFIED: "false",
  PROXY_CHAIN_VERIFIED: "true",
  ORIGIN_AUTH_ENABLED: "true",
  STORAGE_DRIVER: "mysql",
  IMAGE_EXECUTOR: "bullmq",
  SERVE_STATIC_UPLOADS: "false",
  DEV_SEED_USERNAME: "",
  DEV_SEED_PASSWORD: "",
  REDIRECT_ENGINE: "current",
  PILOT_HEADER_DIAGNOSTICS: "false",
  ANALYTICS_MEASUREMENT_ID: "",
  ANALYTICS_SITE_KEY: "",
});

const exactPlaceholders = Object.freeze({
  APP_NAMESPACE: "__UNIQUE_APP_NAMESPACE__",
  APP_PRIVATE_ROOT: "__APP_PRIVATE_ROOT_ABSOLUTE_PATH__",
  APP_RELEASE_ROOT: "__APP_RELEASE_ROOT_ABSOLUTE_PATH__",
  NODE_BINARY: "__ABSOLUTE_NODE_BINARY__",
  PORT: "__UNIQUE_LOOPBACK_PORT__",
  NODE_SHORTENER_DEPLOYMENT_TARGET_ID: "__EXACT_CLOUDWAYS_DEPLOYMENT_TARGET_ID__",
  MYSQL_DATABASE: "__UNIQUE_MYSQL_DATABASE__",
  MYSQL_USER: "__UNIQUE_MYSQL_USER__",
  REDIS_KEY_PREFIX: "__UNIQUE_REDIS_KEY_PREFIX__",
  PM2_PROCESS_PREFIX: "__UNIQUE_PM2_PROCESS_PREFIX__",
  PM2_HOME: "__PRIVATE_PM2_HOME_ABSOLUTE_PATH__",
  PM2_CLI_SCRIPT: "__ABSOLUTE_PM2_CLI_SCRIPT__",
  PM2_VERSION: "__EXACT_PM2_VERSION__",
  PRIVATE_TEMP_DIR: "__PRIVATE_HTML_TEMP_ABSOLUTE_PATH__",
  PUBLIC_UPLOAD_DIR: "__PUBLIC_HTML_UPLOADS_ABSOLUTE_PATH__",
});

const privateValueKeys = Object.freeze([
  "NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256",
  "ORIGIN_AUTH_SHA256",
  "MYSQL_HOST",
  "MYSQL_PORT",
  "MYSQL_PASSWORD",
  "REDIS_URL",
  "IP_HASH_SECRET",
  "COOKIE_SIGNING_SECRET",
  "PILOT_DIAGNOSTIC_TOKEN_SHA256",
]);

export async function verifyCloudwaysPackage(projectRoot) {
  const root = resolve(projectRoot);
  const failures = [];
  const contents = {};

  for (const [name, path] of Object.entries(packagePaths)) {
    try {
      contents[name] = normalize(await readFile(resolve(root, path), "utf8"));
    } catch (error) {
      failures.push(`${path} is missing or unreadable: ${errorCode(error)}`);
    }
  }

  if (typeof contents.environment !== "string"
    || typeof contents.htaccess !== "string"
    || typeof contents.readme !== "string") {
    return Object.freeze({ failures: Object.freeze(failures), environmentEntryCount: 0 });
  }

  const environment = parseEnvironment(contents.environment, failures);
  validateEnvironment(environment, failures);
  validateHtaccess(contents.htaccess, environment, failures);
  validateReadme(contents.readme, failures);
  validateNoEmbeddedCredentials(contents, failures);

  return Object.freeze({
    failures: Object.freeze([...new Set(failures)]),
    environmentEntryCount: environment.size,
  });
}

function parseEnvironment(source, failures) {
  const environment = new Map();
  for (const [offset, rawLine] of source.split("\n").entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null) {
      failures.push(`${packagePaths.environment}:${offset + 1} is not a KEY=value entry.`);
      continue;
    }
    const [, key, value] = match;
    if (environment.has(key)) failures.push(`${packagePaths.environment} repeats ${key}.`);
    environment.set(key, value);
  }
  return environment;
}

function validateEnvironment(environment, failures) {
  for (const key of [...runtimeKeys, ...activationKeys]) {
    if (!environment.has(key)) failures.push(`${packagePaths.environment} is missing ${key}.`);
  }

  for (const [key, expected] of Object.entries(exactEnvironmentValues)) {
    if (environment.get(key) !== expected) {
      failures.push(`${packagePaths.environment} must keep ${key}=${expected}.`);
    }
  }

  for (const [key, expected] of Object.entries(exactPlaceholders)) {
    if (environment.get(key) !== expected) {
      failures.push(`${packagePaths.environment} must keep ${key} as ${expected}.`);
    }
  }

  for (const key of privateValueKeys) {
    const value = environment.get(key);
    if (typeof value !== "string" || !isPlaceholder(value)) {
      failures.push(`${packagePaths.environment} must keep ${key} as a non-secret placeholder.`);
    }
  }

  const activationPath = environment.get("NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE") ?? "";
  if (!/^private\/activation\/__[A-Z0-9_]+__\.json$/.test(activationPath)) {
    failures.push("The activation file example must remain a relative private/activation placeholder path.");
  }
  const domainConfigPath = environment.get("DOMAIN_CONFIG_FILE") ?? "";
  if (!/^\.\/config\/__[A-Z0-9_]+__\.json$/.test(domainConfigPath)) {
    failures.push("The domain configuration example must remain an artifact-local config placeholder path.");
  }
  if (environment.has("BROWSER_SCOPED_DEFAULT_USER_IDS")) {
    failures.push("The unsafe BROWSER_SCOPED_DEFAULT_USER_IDS setting must not appear in the pilot template.");
  }
  for (const [key, value] of environment) {
    if (/\s/.test(key) || /[\r\n]/.test(value)) {
      failures.push(`${packagePaths.environment} contains malformed whitespace in ${key}.`);
    }
    if (/^[A-Za-z]:[\\/]/.test(value) || /^\/(?!\/)/.test(value)) {
      failures.push(`${packagePaths.environment} must not embed a real absolute path in ${key}.`);
    }
  }
}

function validateHtaccess(source, environment, failures) {
  const activeLines = source.split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const uploadsIndex = activeLines.findIndex((line) => /^RewriteRule \^uploads\(\?:\//.test(line));
  const dotfileIndex = activeLines.findIndex((line) => /^RewriteRule \(\?:\^\|\/\)\\\./.test(line));
  const sensitiveFileIndex = activeLines.findIndex((line) => /^RewriteRule \(\?:\^\|\/\)\[\^\/\]\*\\\./.test(line));
  const executableUploadIndex = activeLines.findIndex((line) => /^RewriteRule \^uploads\/\.\*\\\.\(\?:php/.test(line));
  const fileIndex = activeLines.findIndex((line) => /REQUEST_FILENAME}\s+-f/.test(line));
  const directoryIndex = activeLines.findIndex((line) => /REQUEST_FILENAME}\s+-d/.test(line));
  const proxyIndexes = activeLines
    .map((line, index) => (/\[[^\]]*\bP\b[^\]]*\]/.test(line) ? index : -1))
    .filter((index) => index >= 0);
  const proxyIndex = proxyIndexes[0] ?? -1;

  if (!activeLines.includes("RewriteEngine On")) failures.push("The .htaccess example must enable rewriting.");
  if (uploadsIndex < 0 || !/\[(?=[^\]]*\bEND\b)(?=[^\]]*\bNC\b)[^\]]*\]/.test(activeLines[uploadsIndex] ?? "")) {
    failures.push("The .htaccess example needs an unconditional END upload exclusion.");
  }
  if (dotfileIndex < 0 || sensitiveFileIndex < 0 || executableUploadIndex < 0
    || dotfileIndex > uploadsIndex || sensitiveFileIndex > uploadsIndex || executableUploadIndex > uploadsIndex) {
    failures.push("Nested dotfiles, sensitive files and executable uploads must be denied before the upload exclusion.");
  }
  if (fileIndex >= 0 || directoryIndex >= 0) {
    failures.push("Manifest-bound UI assets must not bypass Node through existing-file rules.");
  }
  if (proxyIndexes.length !== 1 || proxyIndex < 0) {
    failures.push("The .htaccess example must contain exactly one proxy rule.");
  }
  if (proxyIndex >= 0 && uploadsIndex >= proxyIndex) {
    failures.push("The upload exclusion must remain before the proxy rule.");
  }

  const proxyLine = proxyIndex >= 0 ? activeLines[proxyIndex] ?? "" : "";
  if (!proxyLine.includes("http://127.0.0.1:__UNIQUE_LOOPBACK_PORT__/")) {
    failures.push("The proxy destination must stay on the unique loopback-port placeholder.");
  }
  if (environment.get("PORT") !== "__UNIQUE_LOOPBACK_PORT__") {
    failures.push("The environment and .htaccess templates must share the loopback-port placeholder.");
  }
  if (activeLines.some((line) => /\b(?:ProxyPreserveHost|RequestHeader)\b/i.test(line))) {
    failures.push("Vhost-only host/header directives must not be active in public .htaccess.");
  }
  if (activeLines.some((line) => /origin[-_]?auth|0\.0\.0\.0|\[::\]|https?:\/\/localhost/i.test(line))) {
    failures.push("The public .htaccess must not contain origin credentials or a public/ambiguous backend bind.");
  }
}

function validateReadme(source, failures) {
  const requiredSections = [
    "## 3. Install and build",
    "## 4. Activate",
    "## 5. Start PM2",
    "## 6. Verify",
    "## 7. Roll back",
    "## Provider-only checks still NOT VERIFIED",
  ];
  for (const section of requiredSections) {
    if (!source.includes(section)) failures.push(`${packagePaths.readme} is missing the ${section} section.`);
  }

  const requiredEvidence = [
    "127.0.0.1:<unique port>",
    "mod_proxy",
    "mod_proxy_http",
    "mod_headers",
    "ProxyPreserveHost On",
    "MAX_UPLOAD_BYTES + 4 MiB",
    "90 seconds",
    "public_html/uploads",
    "Do not copy UI assets",
    "disallows per-directory `.htaccess`/`.user.ini` overrides",
    "pm2 startup",
    "pm2 save",
    "pm2-logrotate",
    "node --env-file=",
    "same filesystem",
    "EXDEV",
    "CF-Connecting-IP",
    "CF-IPCountry",
    "X-Forwarded-For",
    "X-Forwarded-Proto",
    "single-domain",
    "multi-domain",
    "run verify:pilot-candidate",
    "tools/generate-production-activation.mjs --plan",
    "tools/generate-production-activation.mjs --activate",
    "tools/verify-cloudways-installed.mjs",
    "tools/safe-pm2-inventory.mjs",
    "current system UTC",
    "evidence/readiness/",
    "run verify:schema:database -- --target-id=",
    "directory listing/autoindex",
    "bare `/uploads/`",
    "APP_PRIVATE_ROOT/releases/",
    "same-lineage-old-release",
    "roughly two hours",
  ];
  for (const phrase of requiredEvidence) {
    if (!source.includes(phrase)) failures.push(`${packagePaths.readme} is missing required guidance: ${phrase}.`);
  }
  if (/127\.0\.0\.1:\d{2,5}/.test(source)) {
    failures.push(`${packagePaths.readme} must not hard-code a Node port.`);
  }
  if (/cloudways-app-\d+/i.test(source)) {
    failures.push(`${packagePaths.readme} must not contain an actual-looking deployment target ID.`);
  }
  if (/`pm2 jlist`/.test(source)) {
    failures.push(`${packagePaths.readme} must not instruct operators to print raw pm2 jlist output.`);
  }
  if (/^\s*(?:node|npm|npx|pm2)(?:\s|$)/m.test(source)) {
    failures.push(`${packagePaths.readme} contains a PATH-selected Node/npm/PM2 operational command.`);
  }
}

function validateNoEmbeddedCredentials(contents, failures) {
  const combined = Object.values(contents).join("\n");
  const suspiciousPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
    /\bsk_live_[A-Za-z0-9]{16,}\b/,
    /(?:redis|rediss|mysql):\/\/[^\s/:@]+:[^\s/@]+@/i,
  ];
  if (suspiciousPatterns.some((pattern) => pattern.test(combined))) {
    failures.push("The Cloudways package contains an actual-looking credential or private key.");
  }
}

function isPlaceholder(value) {
  return /^__[A-Z0-9_]+__$/.test(value);
}

function normalize(value) {
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "read-error";
}

function requestedRoot(arguments_) {
  let root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument?.startsWith("--root=")) {
      root = resolve(argument.slice("--root=".length));
    } else if (argument === "--root" && arguments_[index + 1] !== undefined) {
      root = resolve(arguments_[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${argument ?? ""}`);
    }
  }
  return root;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    const root = requestedRoot(process.argv.slice(2));
    const result = await verifyCloudwaysPackage(root);
    if (result.failures.length > 0) {
      process.stderr.write(`Cloudways package verification failed (${result.failures.length}):\n`);
      for (const failure of result.failures) process.stderr.write(`- ${failure}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `Cloudways package verified: ${Object.keys(packagePaths).length} files, `
        + `${activationKeys.length} activation variables, ${result.environmentEntryCount} environment entries.\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown verifier failure";
    process.stderr.write(`Cloudways package verification could not run: ${message}\n`);
    process.exitCode = 1;
  }
}
