import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import sharp from "sharp";
import { z } from "zod";
import { loadEnvironmentFile } from "../config/load-env.js";
import { assertProductionStartupAllowed } from "../config/production-startup.js";
import { loadRuntimeConfig } from "../config/runtime.js";
import {
  imageAdmissionKey,
  imageJobName,
  imageQueueName,
  imageWorkerHeartbeatKey,
  withDeadline,
  type QueuedImageExecutionRequest,
} from "../modules/uploads/bullmq-executor.js";
import {
  processImage,
  type ImageExecutionRequest,
  type ImageExecutionResult,
} from "../modules/uploads/image-executor.js";
import {
  ImageWorkerHeartbeat,
  startLeasedImageConsumer,
} from "../modules/uploads/worker-heartbeat.js";
import { crashStopImageWorkerAfterLeaseLoss } from "./lease-loss.js";

const requestSchema = z.object({
  jobId: z.string().regex(/^[0-9a-f]{32}$/),
  attempt: z.number().int().positive().max(20),
  inputKey: z.string().min(1),
  outputTempKey: z.string().min(1),
  finalKey: z.string().min(1),
  maxPixels: z.number().int().positive(),
  deferPublication: z.literal(true),
});

loadEnvironmentFile();
const config = await loadRuntimeConfig();
assertProductionStartupAllowed(config);
if (config.image.executor !== "bullmq") {
  throw new Error("The image worker requires IMAGE_EXECUTOR=bullmq.");
}

sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 50 });

const connection = new Redis(config.redis.url, {
  maxRetriesPerRequest: null,
  connectTimeout: config.redis.connectTimeoutMs,
});
const admissionConnection = new Redis(config.redis.url, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: config.redis.connectTimeoutMs,
  commandTimeout: config.redis.commandTimeoutMs,
});
admissionConnection.on("error", () => undefined);
const admissionKey = imageAdmissionKey(`${config.redis.keyPrefix}:bull`);
const heartbeatKey = imageWorkerHeartbeatKey(`${config.redis.keyPrefix}:bull`);
const heartbeatToken = `${requiredWorkerHeartbeatIdentity()}:${process.pid}:${randomUUID()}`;
const heartbeat = new ImageWorkerHeartbeat({
  client: {
    eval: (script, keyCount, key, token, ttlMs) => ttlMs === undefined
      ? admissionConnection.eval(script, keyCount, key, token)
      : admissionConnection.eval(script, keyCount, key, token, ttlMs),
  },
  key: heartbeatKey,
  token: heartbeatToken,
  onFirstPublished: () => undefined,
  onError: (error) => {
    process.stderr.write(`image worker heartbeat error: ${safeError(error)}\n`);
  },
  onLeaseLost: (error) => {
    crashStopImageWorkerAfterLeaseLoss(error);
  },
});
const worker = new Worker<QueuedImageExecutionRequest, ImageExecutionResult, typeof imageJobName>(
  imageQueueName,
  async (job: Job<QueuedImageExecutionRequest, ImageExecutionResult, typeof imageJobName>) => {
    try {
      if (job.name !== imageJobName) {
        throw new Error("Unsupported image job.");
      }
      const request = requestSchema.parse(job.data);
      if (request.jobId !== job.id) {
        throw new Error("Image queue identity does not match its ledger job.");
      }
      const inputPath = resolveKey(config.image.privateTempDir, request.inputKey, "input");
      const outputTempPath = resolveKey(config.image.privateTempDir, request.outputTempKey, "temporary output");
      const finalPath = resolveKey(config.image.publicUploadDir, request.finalKey, "final output");
      if (request.maxPixels !== config.image.maxImagePixels) {
        throw new Error("Image pixel limit does not match worker configuration.");
      }
      const executionRequest: ImageExecutionRequest = {
        jobId: request.jobId,
        attempt: request.attempt,
        inputPath,
        outputTempPath,
        finalPath,
        maxPixels: request.maxPixels,
        deferPublication: true,
      };
      return await processImage(executionRequest);
    } finally {
      if (job.id !== undefined) {
        await withDeadline(admissionConnection.zrem(admissionKey, job.id), 1_000)
          .catch(() => undefined);
      }
    }
  },
  {
    connection,
    prefix: `${config.redis.keyPrefix}:bull`,
    autorun: false,
    concurrency: 1,
    maxStalledCount: 1,
    lockDuration: Math.max(config.image.jobTimeoutMs, 30_000),
  },
);

worker.on("error", (error) => {
  process.stderr.write(`image worker error: ${safeError(error)}\n`);
});
worker.on("failed", (job, error) => {
  process.stderr.write(`image job ${job?.id ?? "unknown"} failed: ${safeError(error)}\n`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal, 0);
  });
}

void startWorker().catch((error: unknown) => {
  process.stderr.write(`image worker startup failed: ${safeError(error)}\n`);
  void shutdown("startup failure", 1);
});

async function startWorker(): Promise<void> {
  // Connecting a paused BullMQ worker is safe; it cannot reserve a job until
  // run() is called. The distributed singleton lease is acquired before that
  // point so an old release or duplicate PM2 process fails closed.
  await startLeasedImageConsumer({
    consumer: worker,
    lease: heartbeat,
    onReady: () => {
      process.stdout.write("image worker ready\n");
      process.send?.("ready");
    },
    onRunError: (error: unknown) => {
      process.stderr.write(`image worker run loop failed: ${safeError(error)}\n`);
      void shutdown("worker run-loop failure", 1);
    },
  });
}

let shuttingDown = false;
async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`image worker stopping after ${signal}\n`);
  await worker.close();
  await heartbeat.stop();
  connection.disconnect(false);
  admissionConnection.disconnect(false);
  process.exitCode = exitCode;
}

function resolveKey(root: string, key: string, label: string): string {
  if (key.includes("\\") || key.startsWith("/") || key.split("/").some((part) => part === ".." || part === ".")) {
    throw new Error(`Image ${label} key is invalid.`);
  }
  const candidate = resolve(root, key);
  const relativePath = relative(resolve(root), candidate);
  if (relativePath.length === 0 || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Image ${label} path is outside its configured directory.`);
  }
  return candidate;
}

function requiredWorkerHeartbeatIdentity(): string {
  const value = process.env.NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Image worker heartbeat requires the exact production activation digest.");
  }
  return value;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/[\r\n]+/g, " ").slice(0, 500) : "unknown error";
}
