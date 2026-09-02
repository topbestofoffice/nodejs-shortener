import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseEnv } from "node:util";

const assignmentPattern = /^([A-Z][A-Z0-9_]*)\s*=/;
const placeholderPattern = /__[A-Z0-9_]+__/;
const activationKeys = new Set([
  "NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE",
  "NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256",
]);

export async function readRenderedCloudwaysEnvironment(path) {
  if (!isAbsolute(path)) throw new Error("The rendered environment path must be absolute.");
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The rendered environment must be a regular non-symlink file.");
  }
  if (metadata.size > 262_144) throw new Error("The rendered environment exceeds the 256 KiB limit.");
  const bytes = await readFile(path);
  const environment = parseExactEnvironment(bytes.toString("utf8"), "rendered environment");
  return Object.freeze({
    environment,
    metadata,
    realPath: await realpath(path),
  });
}

export async function readCloudwaysEnvironmentTemplate(projectRoot) {
  const bytes = await readFile(resolve(projectRoot, "deploy/cloudways/pilot.env.example"));
  if (bytes.byteLength > 262_144) throw new Error("The Cloudways environment template exceeds 256 KiB.");
  return parseExactEnvironment(bytes.toString("utf8"), "Cloudways environment template");
}

export function parseExactEnvironment(source, context = "environment") {
  const keys = new Set();
  for (const [index, rawLine] of source.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = assignmentPattern.exec(line);
    if (match === null) throw new Error(`${context} has an invalid entry at line ${index + 1}.`);
    const key = match[1];
    if (keys.has(key)) throw new Error(`${context} repeats ${key}.`);
    keys.add(key);
  }
  let parsed;
  try {
    parsed = parseEnv(source);
  } catch {
    throw new Error(`${context} is not valid Node environment-file syntax.`);
  }
  return Object.freeze(Object.fromEntries(Object.entries(parsed)));
}

export function assertRenderedEnvironmentShape(environment, template, options = {}) {
  const allowMissingActivation = options.allowMissingActivation === true;
  const expected = new Set(Object.keys(template));
  const actual = new Set(Object.keys(environment));
  for (const key of expected) {
    if (!actual.has(key) && !(allowMissingActivation && activationKeys.has(key))) {
      throw new Error(`The rendered environment is missing ${key}.`);
    }
  }
  for (const key of actual) {
    if (!expected.has(key)) throw new Error(`The rendered environment contains unexpected key ${key}.`);
  }
  for (const [key, value] of Object.entries(environment)) {
    if (placeholderPattern.test(value)) throw new Error(`The rendered environment still contains a placeholder in ${key}.`);
  }
}

export function assertPortablePrivateOwnership(metadata, context) {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return "not-portable";
  }
  if (metadata.uid !== process.getuid()) throw new Error(`${context} is not owned by the application user.`);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${context} must be owner-only (mode 0600 or stricter).`);
  return "verified";
}

export function assertPortablePublicConfigOwnership(metadata, context) {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return "not-portable";
  }
  if (metadata.uid !== process.getuid()) throw new Error(`${context} is not owned by the application user.`);
  if ((metadata.mode & 0o022) !== 0) throw new Error(`${context} must not be group/other writable.`);
  if ((metadata.mode & 0o400) === 0) throw new Error(`${context} must be owner-readable.`);
  return "verified";
}

export function assertNoTemplatePlaceholder(value, context) {
  if (containsPlaceholder(value)) throw new Error(`${context} contains an unresolved template placeholder.`);
}

/** Plaintext data transports are accepted only on this dedicated server's loopback. */
export function assertLocalPilotTransports(environment) {
  if (environment.MYSQL_HOST !== "127.0.0.1") {
    throw new Error("MYSQL_HOST must be exact loopback until verified MariaDB TLS is implemented.");
  }
  let redis;
  try {
    redis = new URL(environment.REDIS_URL);
  } catch {
    throw new Error("REDIS_URL is invalid.");
  }
  if (redis.protocol !== "redis:" || redis.hostname !== "127.0.0.1") {
    throw new Error("REDIS_URL must use plaintext only on exact loopback until verified Redis TLS is implemented.");
  }
}

export function containsPlaceholder(value) {
  if (typeof value === "string") return placeholderPattern.test(value);
  if (Array.isArray(value)) return value.some(containsPlaceholder);
  if (value !== null && typeof value === "object") return Object.values(value).some(containsPlaceholder);
  return false;
}

export function isStrictChild(parent, candidate) {
  const child = relative(resolve(parent), resolve(candidate));
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}

export async function regularRealPath(path, context) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error(`${context} must be a regular non-symlink file.`);
  return { metadata, realPath: await realpath(path) };
}

export async function directoryRealPath(path, context) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${context} must be a real non-symlink directory.`);
  }
  return { metadata: await stat(path), realPath: await realpath(path) };
}

export async function exactDeploymentRoots(environment, projectRoot) {
  if (!isAbsolute(environment.APP_PRIVATE_ROOT ?? "") || !isAbsolute(environment.APP_RELEASE_ROOT ?? "")) {
    throw new Error("APP_PRIVATE_ROOT and APP_RELEASE_ROOT must be exact absolute paths.");
  }
  const privateRoot = await directoryRealPath(environment.APP_PRIVATE_ROOT, "APP_PRIVATE_ROOT");
  const releaseRoot = await directoryRealPath(environment.APP_RELEASE_ROOT, "APP_RELEASE_ROOT");
  const selectedRoot = await directoryRealPath(projectRoot, "selected release root");
  if (releaseRoot.realPath !== selectedRoot.realPath) {
    throw new Error("APP_RELEASE_ROOT must equal this exact colocated Node release.");
  }
  const releasesRoot = await directoryRealPath(resolve(privateRoot.realPath, "releases"), "APP_PRIVATE_ROOT/releases");
  if (dirname(releaseRoot.realPath) !== releasesRoot.realPath) {
    throw new Error("APP_RELEASE_ROOT must be one direct immutable child of APP_PRIVATE_ROOT/releases.");
  }
  return Object.freeze({ privateRoot, releaseRoot, releasesRoot });
}
