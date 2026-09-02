import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoTemplatePlaceholder,
  assertLocalPilotTransports,
  assertPortablePrivateOwnership,
  assertPortablePublicConfigOwnership,
  assertRenderedEnvironmentShape,
  containsPlaceholder,
  directoryRealPath,
  exactDeploymentRoots,
  isStrictChild,
  readCloudwaysEnvironmentTemplate,
  readRenderedCloudwaysEnvironment,
} from "./cloudways-rendered-env.mjs";
import { verifyProductionReadiness } from "./verify-production-readiness.mjs";
import {
  pm2DeploymentConfigurationSha256,
  validatePm2DeploymentEnvironment,
} from "./verify-cloudways-installed.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/;
const exactTargetPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,159}$/;
const secretObservationPatterns = Object.freeze([
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:redis|rediss|mysql):\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\b(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key)\s*[:=]\s*(?!\[?redacted\]?|none\b|absent\b|disabled\b)["']?[^\s,;"']{8,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
]);

export async function buildProductionActivationPlan(options) {
  const root = resolve(options.projectRoot);
  const rendered = await readRenderedCloudwaysEnvironment(options.environmentFile);
  const template = await readCloudwaysEnvironmentTemplate(root);
  assertRenderedEnvironmentShape(rendered.environment, template, { allowMissingActivation: true });
  assertPortablePrivateOwnership(rendered.metadata, "The rendered environment");
  validateGenerationEnvironment(rendered.environment);
  assertLocalPilotTransports(rendered.environment);
  const deploymentRoots = await exactDeploymentRoots(rendered.environment, root);
  assertPortablePublicConfigOwnership(deploymentRoots.privateRoot.metadata, "APP_PRIVATE_ROOT");
  assertPortablePublicConfigOwnership(deploymentRoots.releaseRoot.metadata, "APP_RELEASE_ROOT");
  const rootRealPath = deploymentRoots.releaseRoot.realPath;
  if (!isStrictChild(deploymentRoots.privateRoot.realPath, rendered.realPath)) {
    throw new Error("The rendered environment must stay inside this exact APP_PRIVATE_ROOT.");
  }
  const temporaryDirectory = await directoryRealPath(rendered.environment.PRIVATE_TEMP_DIR, "PRIVATE_TEMP_DIR");
  if (!isStrictChild(deploymentRoots.privateRoot.realPath, temporaryDirectory.realPath)
    || isStrictChild(deploymentRoots.releasesRoot.realPath, temporaryDirectory.realPath)) {
    throw new Error("PRIVATE_TEMP_DIR must stay inside this exact APP_PRIVATE_ROOT.");
  }
  assertPortablePrivateOwnership(temporaryDirectory.metadata, "PRIVATE_TEMP_DIR");
  const pm2Home = await directoryRealPath(rendered.environment.PM2_HOME, "PM2_HOME");
  if (!isStrictChild(deploymentRoots.privateRoot.realPath, pm2Home.realPath)
    || isStrictChild(deploymentRoots.releasesRoot.realPath, pm2Home.realPath)) {
    throw new Error("PM2_HOME must stay inside this exact APP_PRIVATE_ROOT.");
  }
  assertPortablePrivateOwnership(pm2Home.metadata, "PM2_HOME");

  let runtimeConfig;
  try {
    runtimeConfig = await options.loadRuntimeConfig(rendered.environment, root);
  } catch {
    throw new Error("The rendered environment does not satisfy the production runtime contract.");
  }
  const artifactPaths = [...options.productionArtifactManifestPaths(root)];
  if (artifactPaths.length === 0 || new Set(artifactPaths).size !== artifactPaths.length) {
    throw new Error("The built production artifact contract is empty or duplicated.");
  }
  const files = [];
  for (const path of [...artifactPaths].sort()) {
    if (!isSafeArtifactPath(path)) throw new Error("The built production artifact contract contains an unsafe path.");
    const candidate = resolve(root, ...path.split("/"));
    const metadata = await lstat(candidate);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Required runtime artifact ${path} must be a regular non-symlink file.`);
    }
    const candidateRealPath = await realpath(candidate);
    assertStrictChild(await realpath(root), candidateRealPath, "runtime artifact");
    files.push(Object.freeze({ path, sha256: sha256(await readFile(candidateRealPath)) }));
  }
  const manifest = Object.freeze({
    schemaVersion: 1,
    kind: "nodejs-shortener-artifact-manifest",
    files: Object.freeze(files),
  });
  const manifestBytes = canonicalJson(manifest);
  const runtimeConfigurationSha256 = options.productionRuntimeConfigurationSha256(runtimeConfig);
  if (!sha256Pattern.test(runtimeConfigurationSha256)) {
    throw new Error("The built runtime configuration digest is invalid.");
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
    throw new Error("The rendered PM2 knobs do not match the built runtime deployment binding.");
  }
  return Object.freeze({
    root,
    environment: rendered.environment,
    runtimeConfig,
    stage: rendered.environment.NODE_SHORTENER_DEPLOYMENT_STAGE,
    targetId: rendered.environment.NODE_SHORTENER_DEPLOYMENT_TARGET_ID,
    canonicalHosts: Object.freeze(runtimeConfig.registry.all().map((domain) => domain.canonicalHost).sort()),
    runtimeConfigurationSha256,
    pm2DeploymentConfigurationSha256: runtimePm2Sha256,
    manifest,
    manifestBytes,
    artifactManifestSha256: sha256(manifestBytes),
  });
}

export async function createProductionActivation(plan, options) {
  const lifetimeHours = requiredLifetimeHours(plan.stage, options.lifetimeHours);
  const issuedAtDate = options.clock();
  if (!(issuedAtDate instanceof Date) || !Number.isFinite(issuedAtDate.getTime())) {
    throw new Error("The system UTC clock is invalid.");
  }
  const issuedAt = issuedAtDate.toISOString();
  const readinessPath = resolve(plan.root, "config/production-readiness.json");
  const before = await readBoundedJson(readinessPath, "production-readiness document");
  assertNoTemplatePlaceholder(before.value, "The production-readiness document");
  validateExactReadinessBinding(before.value, plan);
  await assertPrivateReadinessEvidence(plan.root, before.value);

  const readinessResult = await options.verifyProductionReadiness({
    projectRoot: plan.root,
    documentPath: readinessPath,
    requestedStage: plan.stage,
    now: issuedAtDate,
  });
  if (readinessResult.blockers.length > 0) {
    throw new Error(
      `Readiness is not green for this exact ${plan.stage} target (${readinessResult.blockers.length} blocker(s)).`,
    );
  }
  const after = await readBoundedJson(readinessPath, "production-readiness document");
  if (sha256(before.bytes) !== sha256(after.bytes)) {
    throw new Error("The production-readiness document changed during activation generation.");
  }
  validateExactReadinessBinding(after.value, plan);
  await assertPrivateReadinessEvidence(plan.root, after.value);

  const stamp = issuedAt.replace(/[-:.TZ]/g, "");
  const manifestName = `artifact-manifest.${plan.stage}.${stamp}.${plan.artifactManifestSha256.slice(0, 12)}.json`;
  const manifestPath = `private/activation/${manifestName}`;
  const readinessDocumentSha256 = sha256(after.bytes);
  const readinessName = `readiness.${plan.stage}.${stamp}.${readinessDocumentSha256.slice(0, 12)}.json`;
  const readinessPrivatePath = `private/activation/${readinessName}`;
  const expiresAt = new Date(issuedAtDate.getTime() + lifetimeHours * 60 * 60 * 1_000).toISOString();
  const activation = Object.freeze({
    schemaVersion: 1,
    kind: "nodejs-shortener-production-activation",
    stage: plan.stage,
    targetId: plan.targetId,
    issuedAt,
    expiresAt,
    canonicalHosts: plan.canonicalHosts,
    runtimeConfigurationSha256: plan.runtimeConfigurationSha256,
    pm2DeploymentConfigurationSha256: plan.pm2DeploymentConfigurationSha256,
    readinessDocument: Object.freeze({ path: readinessPrivatePath, sha256: readinessDocumentSha256 }),
    artifactManifest: Object.freeze({ path: manifestPath, sha256: plan.artifactManifestSha256 }),
  });
  const activationBytes = canonicalJson(activation);
  const activationSha256 = sha256(activationBytes);
  const activationName = `activation.${plan.stage}.${stamp}.${activationSha256.slice(0, 12)}.json`;
  const activationPath = `private/activation/${activationName}`;

  const activationDirectory = await prepareActivationDirectory(plan.root);
  const manifestFinal = resolve(activationDirectory, manifestName);
  const readinessFinal = resolve(activationDirectory, readinessName);
  await publishOwnerOnlyAtomic(readinessFinal, after.bytes);
  let manifestPublished = false;
  let activationPublished = false;
  try {
    await publishOwnerOnlyAtomic(manifestFinal, plan.manifestBytes);
    manifestPublished = true;
    const activationFinal = resolve(activationDirectory, activationName);
    const validationTemporary = resolve(activationDirectory, `.validation.${randomUUID()}.json`);
    await writeOwnerOnlyTemporary(validationTemporary, activationBytes);
    try {
      options.assertProductionStartupAllowed(plan.runtimeConfig, {
        environment: {
          ...plan.environment,
          NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE: relative(plan.root, validationTemporary).replaceAll("\\", "/"),
          NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256: activationSha256,
        },
        now: issuedAtDate,
        projectRoot: plan.root,
      });
      await link(validationTemporary, activationFinal);
      await assertPublishedOwnerOnly(activationFinal);
      activationPublished = true;
    } finally {
      await unlink(validationTemporary).catch(() => undefined);
    }
  } finally {
    if (!activationPublished) {
      if (manifestPublished) await unlink(manifestFinal).catch(() => undefined);
      await unlink(readinessFinal).catch(() => undefined);
    }
  }

  return Object.freeze({
    activationPath,
    activationSha256,
    artifactManifestPath: manifestPath,
    artifactManifestSha256: plan.artifactManifestSha256,
    runtimeConfigurationSha256: plan.runtimeConfigurationSha256,
    pm2DeploymentConfigurationSha256: plan.pm2DeploymentConfigurationSha256,
    readinessDocumentPath: readinessPrivatePath,
    readinessDocumentSha256,
    issuedAt,
    expiresAt,
  });
}

function validateGenerationEnvironment(environment) {
  if (environment.NODE_ENV !== "production" || environment.HOST !== "127.0.0.1") {
    throw new Error("Activation generation requires NODE_ENV=production and HOST=127.0.0.1.");
  }
  if (environment.NODE_SHORTENER_DEPLOYMENT_STAGE !== "pilot"
    && environment.NODE_SHORTENER_DEPLOYMENT_STAGE !== "release") {
    throw new Error("NODE_SHORTENER_DEPLOYMENT_STAGE must be pilot or release.");
  }
  const target = environment.NODE_SHORTENER_DEPLOYMENT_TARGET_ID;
  if (!exactTargetPattern.test(target ?? "") || !/[0-9]/.test(target)
    || /(?:^|[._:/-])(?:all|any|default|global|localhost|pending|tbd|unknown|unset|wildcard)(?:$|[._:/-])/i.test(target)) {
    throw new Error("NODE_SHORTENER_DEPLOYMENT_TARGET_ID must identify one exact deployment.");
  }
  validatePm2DeploymentEnvironment(environment);
}

function validateExactReadinessBinding(document, plan) {
  if (document === null || typeof document !== "object" || Array.isArray(document)
    || document.schemaVersion !== 2 || document.project !== "nodejs-shortener"
    || document.deployments === null || typeof document.deployments !== "object"
    || Array.isArray(document.deployments)) {
    throw new Error("The production-readiness document has an invalid identity or deployment binding.");
  }
  const binding = document.deployments[plan.stage];
  if (binding === null || typeof binding !== "object" || Array.isArray(binding)
    || binding.targetId !== plan.targetId
    || binding.artifactSha256 !== plan.artifactManifestSha256
    || binding.configurationSha256 !== plan.runtimeConfigurationSha256) {
    throw new Error("The readiness deployment is not bound to this exact target, artifact and runtime configuration.");
  }
  if (plan.stage === "release" && document.deployments.pilot !== null
    && document.deployments.pilot?.artifactSha256 !== plan.artifactManifestSha256) {
    throw new Error("The release readiness document is not bound to the same pilot artifact.");
  }
}

async function assertPrivateReadinessEvidence(root, document) {
  await assertReadinessIgnore(root);
  const readinessRoot = resolve(root, "evidence/readiness");
  if (!Array.isArray(document.gates)) throw new Error("The readiness gate list is invalid.");
  for (const gate of document.gates) {
    if (!Array.isArray(gate?.evidence)) throw new Error("A readiness gate has invalid evidence references.");
    for (const reference of gate.evidence) {
      const path = reference?.path;
      if (typeof path !== "string" || !/^evidence\/readiness\/[A-Za-z0-9._/-]+\.json$/.test(path)
        || path.includes("//") || path.split("/").some((part) => part === "." || part === "..")) {
        throw new Error("Readiness evidence must remain under the private ignored evidence/readiness directory.");
      }
      const candidate = resolve(root, ...path.split("/"));
      assertStrictChild(readinessRoot, candidate, "readiness evidence");
      const receipt = await readBoundedJson(candidate, "readiness evidence receipt");
      if (sha256(receipt.bytes) !== reference.sha256) {
        throw new Error("A readiness evidence receipt digest does not match its reference.");
      }
      if (containsPlaceholder(receipt.value)) {
        throw new Error("A readiness evidence receipt contains an unresolved template placeholder.");
      }
      for (const check of receipt.value?.checks ?? []) {
        if (typeof check?.observed !== "string"
          || secretObservationPatterns.some((pattern) => pattern.test(check.observed))) {
          throw new Error("A readiness evidence observation is invalid or appears to contain secret material.");
        }
      }
    }
  }
  const gitMarker = resolve(root, ".git");
  try {
    await lstat(gitMarker);
    const tracked = spawnSync("git", ["-C", root, "ls-files", "--", "evidence/readiness"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (tracked.status !== 0 || String(tracked.stdout).trim().length > 0) {
      throw new Error("Readiness evidence is tracked by Git or its tracking state cannot be proven safe.");
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function assertReadinessIgnore(root) {
  const source = await readFile(resolve(root, ".gitignore"), "utf8");
  const lines = source.split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes("/evidence/readiness/")) {
    throw new Error(".gitignore must contain the exact /evidence/readiness/ private-evidence rule.");
  }
}

async function readBoundedJson(path, context) {
  const bytes = await readFile(path);
  if (bytes.byteLength > 1_048_576) throw new Error(`${context} exceeds the 1 MiB limit.`);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`${context} is not valid JSON.`);
  }
}

function requiredLifetimeHours(stage, value) {
  const fallback = stage === "pilot" ? 168 : 720;
  const selected = value ?? fallback;
  const maximum = stage === "pilot" ? 720 : 9_600;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new Error(`Activation lifetime must be a whole number from 1 to ${maximum} hours for ${stage}.`);
  }
  return selected;
}

async function prepareActivationDirectory(root) {
  const privateDirectory = resolve(root, "private");
  const activationDirectory = resolve(privateDirectory, "activation");
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("The release root must be a real non-symlink directory.");
  }
  await ensureRealDirectory(privateDirectory, 0o700, "private directory");
  await ensureRealDirectory(activationDirectory, 0o700, "activation directory");
  if (process.platform !== "win32") await chmod(activationDirectory, 0o700);
  assertStrictChild(await realpath(root), await realpath(activationDirectory), "activation directory");
  return activationDirectory;
}

async function ensureRealDirectory(path, mode, context) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`The ${context} must be a real directory.`);
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    try {
      await mkdir(path, { recursive: false, mode });
    } catch (createError) {
      if (!(createError && typeof createError === "object" && "code" in createError
        && createError.code === "EEXIST")) throw createError;
    }
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`The ${context} must be a real directory.`);
    }
  }
}

async function publishOwnerOnlyAtomic(finalPath, bytes) {
  const temporary = resolve(dirname(finalPath), `.publish.${randomUUID()}.json`);
  await writeOwnerOnlyTemporary(temporary, bytes);
  try {
    await link(temporary, finalPath);
    await assertPublishedOwnerOnly(finalPath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function writeOwnerOnlyTemporary(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function assertPublishedOwnerOnly(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Published activation material is not regular.");
  if (process.platform !== "win32" && typeof process.getuid === "function") {
    if (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0) {
      throw new Error("Published activation material is not owner-only.");
    }
  }
}

function isSafeArtifactPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 500
    && !path.includes("\\") && !path.includes("//") && !isAbsolute(path)
    && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}

function assertStrictChild(parent, candidate, context) {
  const child = relative(resolve(parent), resolve(candidate));
  if (child.length === 0 || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`${context} escapes its allowed directory.`);
  }
}

function canonicalJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(arguments_) {
  const result = {
    projectRoot: resolve(fileURLToPath(new URL("..", import.meta.url))),
    environmentFile: "",
    mode: "plan",
    lifetimeHours: undefined,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index] ?? "";
    if (argument === "--activate") {
      result.mode = "activate";
      continue;
    }
    if (argument === "--plan") {
      result.mode = "plan";
      continue;
    }
    const [name, inline] = argument.split("=", 2);
    const value = inline ?? arguments_[index + 1];
    if (!["--env-file", "--lifetime-hours"].includes(name)
      || value === undefined || value.length === 0) {
      throw new Error("Usage: generate-production-activation.mjs --env-file=<absolute> [--plan|--activate] [--lifetime-hours=N]");
    }
    if (inline === undefined) index += 1;
    if (name === "--env-file") {
      if (!isAbsolute(value)) throw new Error("--env-file must use an absolute path.");
      result.environmentFile = resolve(value);
    }
    if (name === "--lifetime-hours") {
      if (!/^[1-9][0-9]*$/.test(value)) throw new Error("--lifetime-hours must be a positive whole number.");
      result.lifetimeHours = Number(value);
    }
  }
  if (result.environmentFile.length === 0) throw new Error("--env-file is required.");
  if (result.mode === "plan" && result.lifetimeHours !== undefined) {
    throw new Error("--lifetime-hours applies only with --activate.");
  }
  return result;
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    const arguments_ = parseArguments(process.argv.slice(2));
    const [{ loadRuntimeConfig }, startup] = await Promise.all([
      import(new URL("../dist/config/runtime.js", import.meta.url)),
      import(new URL("../dist/config/production-startup.js", import.meta.url)),
    ]);
    const plan = await buildProductionActivationPlan({
      projectRoot: arguments_.projectRoot,
      environmentFile: arguments_.environmentFile,
      loadRuntimeConfig,
      productionArtifactManifestPaths: startup.productionArtifactManifestPaths,
      productionRuntimeConfigurationSha256: startup.productionRuntimeConfigurationSha256,
      productionPm2DeploymentConfigurationSha256: startup.productionPm2DeploymentConfigurationSha256,
    });
    if (arguments_.mode === "plan") {
      process.stdout.write(
        "Activation plan only; no files written.\n"
        + `artifact-manifest-sha256=${plan.artifactManifestSha256}\n`
        + `runtime-configuration-sha256=${plan.runtimeConfigurationSha256}\n`
        + `pm2-deployment-configuration-sha256=${plan.pm2DeploymentConfigurationSha256}\n`,
      );
    } else {
      const result = await createProductionActivation(plan, {
        lifetimeHours: arguments_.lifetimeHours,
        clock: () => new Date(),
        verifyProductionReadiness,
        assertProductionStartupAllowed: startup.assertProductionStartupAllowed,
      });
      process.stdout.write(
        "Production activation created without overwrite.\n"
        + `artifact-manifest-path=${result.artifactManifestPath}\n`
        + `artifact-manifest-sha256=${result.artifactManifestSha256}\n`
        + `activation-path=${result.activationPath}\n`
        + `activation-sha256=${result.activationSha256}\n`
        + `runtime-configuration-sha256=${result.runtimeConfigurationSha256}\n`
        + `pm2-deployment-configuration-sha256=${result.pm2DeploymentConfigurationSha256}\n`
        + `readiness-document-sha256=${result.readinessDocumentSha256}\n`
        + `readiness-document-path=${result.readinessDocumentPath}\n`
        + `issued-at=${result.issuedAt}\nexpires-at=${result.expiresAt}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(`Production activation BLOCKED: ${safeError(error)}\n`);
    process.exitCode = 1;
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : "unknown activation failure";
  return message.replace(/(?:redis|rediss|mysql):\/\/[^\s/:@]+:[^\s/@]+@/gi, "[redacted-uri]")
    .replace(/[\r\n]+/g, " ").slice(0, 1_000);
}
