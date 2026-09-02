import { mkdir } from "node:fs/promises";
import fastifyStatic from "@fastify/static";
import { buildApplication } from "./app.js";
import { loadEnvironmentFile } from "./config/load-env.js";
import { loadRuntimeConfig } from "./config/runtime.js";
import { assertProductionStartupAllowed } from "./config/production-startup.js";
import { createRuntimeResources } from "./infrastructure/runtime-resources.js";
import { waitForInitialRuntimeReadiness } from "./infrastructure/runtime-readiness.js";
import {
  RecoveryDrainer,
  isRecoveryDrainerOwner,
  recoverBeforeListen,
} from "./infrastructure/startup-recovery.js";
import { SharpMetadataReader } from "./infrastructure/sharp-metadata-reader.js";
import { AuthService } from "./modules/auth/service.js";
import { LinkService } from "./modules/links/service.js";
import { ImageUploadService } from "./modules/uploads/service.js";
import { systemClock } from "./ports.js";

loadEnvironmentFile();
const config = await loadRuntimeConfig();
assertProductionStartupAllowed(config);
const resources = await createRuntimeResources(config);
let shuttingDown = false;
let resourcesClosePromise: Promise<void> | null = null;
const closeResources = (): Promise<void> => {
  resourcesClosePromise ??= resources.close();
  return resourcesClosePromise;
};

try {
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
    ledgerDomainId: config.registry.all().find((domain) => domain.surface === "dashboard")?.id ?? 1,
    jobLeaseMs: Math.max(config.image.jobTimeoutMs * 3, 30_000),
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
    readiness: resources.readiness,
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

  const recoveryBatchSize = 1;
  const recoveryDrainer = new RecoveryDrainer({
    owner: isRecoveryDrainerOwner(process.env.NODE_APP_INSTANCE),
    batchSize: recoveryBatchSize,
    drainBatch: () => imageUploadService.reconcileOnStartup(recoveryBatchSize, 1),
    onResult: (result) => {
      if (result.inspected > 0) app.log.info(result, "image recovery batch completed");
    },
    onError: (error) => {
      app.log.error({ err: error }, "image recovery batch failed; bounded retry scheduled");
    },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  const recoveryProbe = await recoverBeforeListen(
    () => imageUploadService.probeRecoveryBacklog(1),
    async () => {
      // Apache has no application-readiness gate. Do not open the loopback
      // listener, or tell PM2 we are ready, until the exact dependency probe
      // (including the image-worker heartbeat) succeeds once.
      await waitForInitialRuntimeReadiness(resources.readiness);
      return app.listen({ host: config.host, port: config.port });
    },
    { timeoutMs: config.operations.imageRecoveryPreflightTimeoutMs },
  );
  if (!shuttingDown) {
    // Start the singleton loop before signalling PM2 readiness. The first pass
    // is asynchronous and cannot hold the listener behind the image worker.
    recoveryDrainer.start();
    if (recoveryProbe.dueJobsObserved > 0) {
      app.log.info(recoveryProbe, "due image recovery work observed; background drain started");
    }
    process.send?.("ready");
  }

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, "graceful shutdown started");
    try {
      // Stop accepting requests and stop the recovery loop in parallel. Each
      // may already be waiting on one two-window BullMQ execution; serial waits
      // would double the PM2 kill-time requirement.
      const settling = await Promise.allSettled([app.close(), recoveryDrainer.stop()]);
      const failures = settling.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      const resourceClose = await Promise.allSettled([closeResources()]);
      failures.push(...resourceClose.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      ));
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((failure): unknown => failure.reason),
          "Web shutdown did not settle cleanly.",
        );
      }
      process.exitCode = 0;
    } catch (error) {
      app.log.error({ err: error }, "graceful shutdown failed");
      process.exitCode = 1;
    }
  }
} catch (error) {
  await closeResources();
  throw error;
}
