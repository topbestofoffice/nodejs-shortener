import { mkdir } from "node:fs/promises";
import fastifyStatic from "@fastify/static";
import { buildApplication } from "../dist/app.js";
import { loadEnvironmentFile } from "../dist/config/load-env.js";
import { loadRuntimeConfig } from "../dist/config/runtime.js";
import { createRuntimeResources } from "../dist/infrastructure/runtime-resources.js";
import { SharpMetadataReader } from "../dist/infrastructure/sharp-metadata-reader.js";
import { AuthService } from "../dist/modules/auth/service.js";
import { LinkService } from "../dist/modules/links/service.js";
import { ImageUploadService } from "../dist/modules/uploads/service.js";
import { systemClock } from "../dist/ports.js";

loadEnvironmentFile();
const config = await loadRuntimeConfig();
if (config.environment !== "development" || config.storageDriver !== "memory") {
  throw new Error("The browser fixture is restricted to development in-memory mode.");
}
const resources = await createRuntimeResources(config);
if (!("registrationEnabled" in resources.stores)) {
  await resources.close();
  throw new Error("The browser fixture requires the in-memory application store.");
}
resources.stores.registrationEnabled = true;

const authService = new AuthService({
  authStore: resources.stores.auth,
  sessions: resources.sessions,
  clock: systemClock,
  ipHashSecret: config.ipHashSecret,
  sessionTtlSeconds: config.sessionTtlSeconds,
});
const imageUploadService = new ImageUploadService({
  uploads: resources.stores.uploads,
  imageJobs: resources.imageJobs,
  executor: resources.imageExecutor,
  clock: systemClock,
  privateTempDir: config.image.privateTempDir,
  publicUploadDir: config.image.publicUploadDir,
  maxUploadBytes: config.image.maxUploadBytes,
  maxImagePixels: config.image.maxImagePixels,
  readyPerSession: config.image.readyPerSession,
  readyTotal: config.image.readyTotal,
  ownershipTtlSeconds: config.image.ownershipTtlSeconds,
  maxOwnedPaths: config.links.maxBulkImages,
  ownedImageHosts: config.registry.all().flatMap((domain) => [domain.canonicalHost, ...domain.aliases]),
});
const linkService = new LinkService({
  appNamespace: config.appNamespace,
  registry: config.registry,
  stores: resources.stores,
  clock: systemClock,
  codeLength: config.links.codeLength,
  imageOwnershipTtlSeconds: config.image.ownershipTtlSeconds,
});
const app = await buildApplication({
  config,
  stores: resources.stores,
  authService,
  imageUploadService,
  linkService,
  metadataReader: new SharpMetadataReader(config.image.publicUploadDir, config.image.maxImagePixels),
  decisions: resources.decisions,
  logger: { level: config.logLevel },
});

if (config.image.serveStaticUploads) {
  await mkdir(config.image.publicUploadDir, { recursive: true });
  await app.register(fastifyStatic, {
    root: config.image.publicUploadDir,
    prefix: "/uploads/",
    decorateReply: false,
    cacheControl: false,
  });
}

let closing = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => { void close(signal); });
}
await app.listen({ host: config.host, port: config.port });
process.send?.("ready");

async function close(signal) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "browser fixture shutdown started");
  try {
    await app.close();
    await resources.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error({ err: error }, "browser fixture shutdown failed");
    process.exitCode = 1;
  }
}
