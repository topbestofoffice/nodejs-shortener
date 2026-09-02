import { isAbsolute, relative, resolve } from "node:path";
import { Queue, QueueEvents, type Job } from "bullmq";
import { Redis } from "ioredis";
import { z } from "zod";
import { AppError } from "../../core/errors.js";
import {
  type ImageExecutionRequest,
  type ImageExecutionResult,
  type ImageExecutor,
} from "./image-executor.js";

export const imageQueueName = "image-normalization";
export const imageJobName = "normalize-v1";

const reserveAdmissionScript = `local admissionKey = KEYS[1]
local jobKeyPrefix = ARGV[1]
local jobId = ARGV[2]
local cap = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local grace = tonumber(ARGV[5])
local entries = redis.call('ZRANGE', admissionKey, 0, -1, 'WITHSCORES')
for i = 1, #entries, 2 do
  local existingId = entries[i]
  local reservedAt = tonumber(entries[i + 1]) or 0
  if reservedAt <= now - grace and redis.call('EXISTS', jobKeyPrefix .. existingId) == 0 then
    redis.call('ZREM', admissionKey, existingId)
  end
end
if redis.call('ZCARD', admissionKey) >= cap then return 0 end
return redis.call('ZADD', admissionKey, 'NX', now, jobId)`;

const resultSchema = z.object({
  width: z.literal(1200),
  height: z.literal(630),
  format: z.literal("jpeg"),
  sourceWidth: z.number().int().positive(),
  sourceHeight: z.number().int().positive(),
});

export interface BullMqImageExecutorOptions {
  readonly redisUrl: string;
  readonly prefix: string;
  readonly timeoutMs: number;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
  readonly submissionTimeoutMs?: number;
  readonly maxQueuedJobs?: number;
  readonly privateTempDir: string;
  readonly publicUploadDir: string;
  /** Exact production activation digest shared by the matching web and worker release. */
  readonly workerHeartbeatIdentity: string;
}

export interface QueuedImageExecutionRequest {
  readonly jobId: string;
  readonly attempt: number;
  readonly inputKey: string;
  readonly outputTempKey: string;
  readonly finalKey: string;
  readonly maxPixels: number;
  readonly deferPublication: true;
}

export class BullMqImageExecutor implements ImageExecutor {
  readonly #queueConnection: Redis;
  readonly #eventsConnection: Redis;
  readonly #queue: Queue<QueuedImageExecutionRequest, ImageExecutionResult, typeof imageJobName>;
  readonly #events: QueueEvents<ImageExecutionResult>;
  readonly #timeoutMs: number;
  readonly #submissionTimeoutMs: number;
  readonly #admissionKey: string;
  readonly #workerHeartbeatKey: string;
  readonly #workerHeartbeatIdentity: string;
  readonly #jobKeyPrefix: string;
  readonly #reservationGraceMs: number;
  readonly #maxQueuedJobs: number;
  readonly #privateTempDir: string;
  readonly #publicUploadDir: string;

  public constructor(options: BullMqImageExecutorOptions) {
    const connectTimeoutMs = options.connectTimeoutMs ?? 500;
    const commandTimeoutMs = options.commandTimeoutMs ?? 200;
    const queueRedisOptions = {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: connectTimeoutMs,
      commandTimeout: commandTimeoutMs,
    } as const;
    const eventsRedisOptions = {
      enableOfflineQueue: false,
      // QueueEvents uses a blocking XREAD connection. BullMQ requires this
      // connection to retry indefinitely, so request-level deadlines below are
      // the protection for the web path.
      maxRetriesPerRequest: null,
      connectTimeout: connectTimeoutMs,
    } as const;
    this.#queueConnection = new Redis(options.redisUrl, queueRedisOptions);
    this.#eventsConnection = new Redis(options.redisUrl, eventsRedisOptions);
    this.#queue = new Queue(imageQueueName, {
      connection: this.#queueConnection,
      prefix: options.prefix,
      skipWaitingForReady: true,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 1_000 },
      },
    });
    this.#events = new QueueEvents(imageQueueName, {
      connection: this.#eventsConnection,
      prefix: options.prefix,
    });
    this.#queueConnection.on("error", () => undefined);
    this.#eventsConnection.on("error", () => undefined);
    this.#events.on("error", () => undefined);
    this.#timeoutMs = options.timeoutMs;
    this.#submissionTimeoutMs = options.submissionTimeoutMs
      ?? Math.min(options.timeoutMs, Math.max(1_000, connectTimeoutMs + commandTimeoutMs * 2));
    this.#admissionKey = imageAdmissionKey(options.prefix);
    this.#workerHeartbeatKey = imageWorkerHeartbeatKey(options.prefix);
    this.#workerHeartbeatIdentity = requiredDeploymentIdentity(options.workerHeartbeatIdentity);
    this.#jobKeyPrefix = this.#queue.toKey("");
    this.#reservationGraceMs = Math.max(30_000, this.#submissionTimeoutMs * 2);
    this.#maxQueuedJobs = options.maxQueuedJobs ?? 20;
    this.#privateTempDir = resolve(options.privateTempDir);
    this.#publicUploadDir = resolve(options.publicUploadDir);
  }

  public async execute(request: ImageExecutionRequest): Promise<ImageExecutionResult> {
    if (!/^[0-9a-f]{32}$/.test(request.jobId)) {
      throw new AppError("Image processor received an invalid job.", 500, "IMAGE_JOB_INVALID", false);
    }
    if (!request.deferPublication) {
      throw new AppError("Durable image jobs must defer publication.", 500, "IMAGE_JOB_PUBLICATION_UNSAFE", false);
    }
    const jobId = request.jobId;
    const queueRequest = buildQueuedImageExecutionRequest(
      request,
      this.#privateTempDir,
      this.#publicUploadDir,
    );
    let job: Job<QueuedImageExecutionRequest, ImageExecutionResult, typeof imageJobName> | null = null;
    try {
      await withDeadline(this.#events.waitUntilReady(), this.#submissionTimeoutMs);
      const existing = await withDeadline(this.#queue.getJob(jobId), this.#submissionTimeoutMs);
      if (existing !== undefined) {
        assertSameQueueIdentity(existing.data, queueRequest);
        const state = await withDeadline(existing.getState(), this.#submissionTimeoutMs);
        const replay = decideBullMqJobReplay(existing.data.attempt, request.attempt, state);
        if (replay === "reuse") {
          job = existing;
        } else if (replay === "replace") {
          await withDeadline(existing.remove(), this.#submissionTimeoutMs);
          await this.#releaseAdmission(jobId);
        } else {
          throw new AppError(
            "A newer image attempt already owns this queue identity.",
            503,
            "IMAGE_JOB_GENERATION_CONFLICT",
            false,
          );
        }
      }
      if (job === null) {
        const admitted = await withDeadline(
          this.#queueConnection.eval(
            reserveAdmissionScript,
            1,
            this.#admissionKey,
            this.#jobKeyPrefix,
            jobId,
            this.#maxQueuedJobs,
            Date.now(),
            this.#reservationGraceMs,
          ),
          this.#submissionTimeoutMs,
        );
        if (Number(admitted) !== 1) {
          throw new AppError("Image processor is temporarily busy. Try again.", 429, "IMAGE_QUEUE_FULL");
        }
        job = await withDeadline(this.#queue.add(imageJobName, queueRequest, {
          jobId,
        }), this.#submissionTimeoutMs);
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("Image processor is temporarily unavailable. Try again.", 503, "IMAGE_QUEUE_UNAVAILABLE", false);
    }
    try {
      const result = await job.waitUntilFinished(this.#events, this.#timeoutMs);
      const parsed = resultSchema.parse(result);
      await this.#releaseAdmission(jobId);
      return parsed;
    } catch (error) {
      if (isBullMqTimeout(error)) {
        const state = await withDeadline(job.getState(), this.#submissionTimeoutMs)
          .catch(() => "unknown" as const);
        if (state === "waiting" || state === "delayed" || state === "prioritized") {
          try {
            await withDeadline(job.remove(), this.#submissionTimeoutMs);
            await this.#releaseAdmission(jobId);
            throw new AppError("Image processing timed out. Retry the upload.", 503, "IMAGE_JOB_TIMEOUT", false);
          } catch (removeError) {
            if (removeError instanceof AppError) {
              throw removeError;
            }
          }
        }
        // Give an active Sharp operation one additional bounded window. If it is
        // still stuck, return a retryable error and retain a compensation waiter
        // that removes any late public output from this still-running web process.
        try {
          const result = resultSchema.parse(await job.waitUntilFinished(this.#events, this.#timeoutMs));
          await this.#releaseAdmission(jobId);
          return result;
        } catch (secondError) {
          if (!isBullMqTimeout(secondError)) {
            await this.#releaseIfTerminal(job, jobId);
            throw secondError;
          }
          // The worker publishes only a private output. Leave any late result
          // for ledger reconciliation; deleting it here races a fresh lease.
          throw new AppError("Image processing timed out. Retry the upload.", 503, "IMAGE_JOB_TIMEOUT", false);
        }
      }
      await this.#releaseIfTerminal(job, jobId);
      throw error;
    }
  }

  public async close(): Promise<void> {
    await Promise.allSettled([this.#queue.close(), this.#events.close()]);
    this.#queueConnection.disconnect(false);
    this.#eventsConnection.disconnect(false);
  }

  public async hasRegisteredWorker(): Promise<boolean> {
    const heartbeat = await withDeadline(
      this.#queueConnection.get(this.#workerHeartbeatKey),
      this.#submissionTimeoutMs,
    );
    return imageWorkerHeartbeatObserved(heartbeat, this.#workerHeartbeatIdentity);
  }

  async #releaseAdmission(jobId: string): Promise<void> {
    await withDeadline(this.#queueConnection.zrem(this.#admissionKey, jobId), this.#submissionTimeoutMs)
      .catch(() => undefined);
  }

  async #releaseIfTerminal(
    job: Job<QueuedImageExecutionRequest, ImageExecutionResult, typeof imageJobName>,
    jobId: string,
  ): Promise<void> {
    const state = await withDeadline(job.getState(), this.#submissionTimeoutMs)
      .catch(() => "unknown" as const);
    if (state === "completed" || state === "failed") {
      await this.#releaseAdmission(jobId);
    }
  }
}

export function imageWorkerHeartbeatObserved(
  heartbeat: string | null,
  deploymentIdentity: string,
): boolean {
  const identity = requiredDeploymentIdentity(deploymentIdentity);
  return heartbeat !== null
    && heartbeat.startsWith(`${identity}:`)
    && /^[0-9a-f]{64}:[0-9]+:[0-9a-f-]{36}$/.test(heartbeat);
}

function isBullMqTimeout(error: unknown): boolean {
  return error instanceof Error && /timed out/i.test(error.message);
}

export async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("Deadline must be a positive safe integer.");
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Operation timed out.")), timeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Operation failed."));
      },
    );
  });
}

export function imageAdmissionKey(prefix: string): string {
  return `${prefix}:${imageQueueName}:admission:v1`;
}

export function imageWorkerHeartbeatKey(prefix: string): string {
  return `${prefix}:${imageQueueName}:worker-singleton:v2`;
}

function requiredDeploymentIdentity(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("Image worker heartbeat deployment identity is invalid.");
  }
  return value;
}

export type BullMqJobReplayDecision = "reuse" | "replace" | "reject";

export function decideBullMqJobReplay(
  storedAttempt: number,
  requestedAttempt: number,
  state: string,
): BullMqJobReplayDecision {
  if (!Number.isInteger(storedAttempt) || storedAttempt < 1 || storedAttempt > 20
    || !Number.isInteger(requestedAttempt) || requestedAttempt < 1 || requestedAttempt > 20) {
    return "reject";
  }
  if (storedAttempt > requestedAttempt) return "reject";
  if (storedAttempt === requestedAttempt) return "reuse";
  if (state === "active" || state === "waiting-children") {
    // The exact older request is still executing. Waiting for its deterministic
    // private output is safer than starting a second writer for the same key.
    return "reuse";
  }
  if (state === "completed" || state === "failed" || state === "waiting"
    || state === "delayed" || state === "prioritized") {
    return "replace";
  }
  return "reject";
}

export function buildQueuedImageExecutionRequest(
  request: ImageExecutionRequest,
  privateTempDir: string,
  publicUploadDir: string,
): QueuedImageExecutionRequest {
  if (!/^[0-9a-f]{32}$/.test(request.jobId)) {
    throw new AppError("Image processor received an invalid job.", 500, "IMAGE_JOB_INVALID", false);
  }
  if (!request.deferPublication) {
    throw new AppError("Durable image jobs must defer publication.", 500, "IMAGE_JOB_PUBLICATION_UNSAFE", false);
  }
  if (!Number.isInteger(request.attempt) || request.attempt < 1 || request.attempt > 20) {
    throw new AppError("Image processor received an invalid attempt.", 500, "IMAGE_JOB_INVALID", false);
  }
  return {
    jobId: request.jobId,
    attempt: request.attempt,
    inputKey: relativeKey(resolve(privateTempDir), request.inputPath, "input"),
    outputTempKey: relativeKey(resolve(privateTempDir), request.outputTempPath, "temporary output"),
    finalKey: relativeKey(resolve(publicUploadDir), request.finalPath, "final output"),
    maxPixels: request.maxPixels,
    deferPublication: true,
  };
}

function assertSameQueueIdentity(
  stored: QueuedImageExecutionRequest,
  requested: QueuedImageExecutionRequest,
): void {
  if (stored.jobId !== requested.jobId
    || stored.inputKey !== requested.inputKey
    || stored.outputTempKey !== requested.outputTempKey
    || stored.finalKey !== requested.finalKey
    || stored.maxPixels !== requested.maxPixels
    || stored.deferPublication !== true) {
    throw new AppError("Image queue identity conflicts with its ledger row.", 500, "IMAGE_JOB_ID_CONFLICT", false);
  }
}

function relativeKey(root: string, candidate: string, label: string): string {
  const value = relative(root, resolve(candidate));
  if (value.length === 0 || value.startsWith("..") || isAbsolute(value) || value.includes("\\")) {
    throw new AppError(`Image ${label} path is outside its configured directory.`, 500, "IMAGE_PATH_INVALID", false);
  }
  return value.replaceAll("\\", "/");
}
