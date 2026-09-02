import { performance } from "node:perf_hooks";
import { withDeadline } from "./bullmq-executor.js";

const compareDeleteScript =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const acquireRefreshScript = `local current = redis.call('GET', KEYS[1])
if not current then
  local acquired = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
  if acquired then return 1 else return 0 end
end
if current == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0`;

export interface WorkerHeartbeatRedisClient {
  eval(script: string, keyCount: number, key: string, token: string, ttlMs?: number): Promise<unknown>;
}

export interface ImageWorkerHeartbeatOptions {
  readonly client: WorkerHeartbeatRedisClient;
  readonly key: string;
  readonly token: string;
  readonly ttlMs?: number;
  readonly intervalMs?: number;
  readonly commandTimeoutMs?: number;
  readonly nowMs?: () => number;
  readonly onFirstPublished: () => void;
  readonly onError: (error: unknown) => void;
  readonly onLeaseLost?: (error: unknown) => void;
}

export interface PausedImageQueueConsumer {
  waitUntilReady(): Promise<unknown>;
  run(): Promise<void>;
}

export interface ImageWorkerSingletonLease {
  acquire(): Promise<void>;
  start(): void;
}

/** Start a paused queue consumer only after its distributed singleton lease is
 * owned. A lease conflict rejects without calling run() or announcing ready. */
export async function startLeasedImageConsumer(options: {
  readonly consumer: PausedImageQueueConsumer;
  readonly lease: ImageWorkerSingletonLease;
  readonly onReady: () => void;
  readonly onRunError: (error: unknown) => void;
}): Promise<void> {
  await options.consumer.waitUntilReady();
  await options.lease.acquire();
  options.lease.start();
  void options.consumer.run().catch(options.onRunError);
  options.onReady();
}

/** One process-owned expiring liveness key. Stop waits for an in-flight refresh
 * before compare-and-delete, so a late command cannot recreate a stopped key. */
export class ImageWorkerHeartbeat {
  readonly #ttlMs: number;
  readonly #intervalMs: number;
  readonly #commandTimeoutMs: number;
  #timer: NodeJS.Timeout | null = null;
  #active: Promise<void> | null = null;
  #readySent = false;
  #stopped = false;
  #lastSuccessfulPublishAtMs: number | null = null;
  #leaseLossSignalled = false;
  readonly #nowMs: () => number;

  public constructor(private readonly options: ImageWorkerHeartbeatOptions) {
    this.#ttlMs = bounded(options.ttlMs ?? 15_000, 1_000, 60_000, "heartbeat TTL");
    this.#intervalMs = bounded(options.intervalMs ?? 5_000, 250, this.#ttlMs - 1, "heartbeat interval");
    this.#commandTimeoutMs = bounded(
      options.commandTimeoutMs ?? 1_000,
      50,
      this.#intervalMs,
      "heartbeat command timeout",
    );
    this.#nowMs = options.nowMs ?? (() => performance.now());
    if (!/^[0-9a-f]{64}:[0-9]+:[0-9a-f-]{36}$/.test(options.token) || options.key.length < 1) {
      throw new Error("Image worker heartbeat identity is invalid.");
    }
  }

  public start(): void {
    if (this.#timer !== null || this.#stopped) return;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
    this.#timer.unref();
  }

  /** Acquire the singleton lease before the queue consumer is allowed to run.
   * Unlike the periodic refresh path, an initial conflict is returned to the
   * caller so process startup can fail closed without consuming a job. */
  public async acquire(): Promise<void> {
    if (this.#stopped) {
      throw new Error("Image worker heartbeat is stopped.");
    }
    if (this.#readySent) return;
    if (this.#active !== null) {
      await this.#active;
      if (this.#readySent) return;
    }
    const operation = this.#publish();
    this.#active = operation;
    try {
      await operation;
    } finally {
      if (this.#active === operation) this.#active = null;
    }
  }

  public async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    await this.#active?.catch(() => undefined);
    await withDeadline(this.options.client.eval(
      compareDeleteScript,
      1,
      this.options.key,
      this.options.token,
    ), this.#commandTimeoutMs).catch(() => undefined);
  }

  #tick(): void {
    if (this.#stopped || this.#leaseLossSignalled || this.#active !== null) return;
    const operation = this.#publish();
    this.#active = operation;
    void operation.catch(() => undefined).finally(() => {
      if (this.#active === operation) this.#active = null;
    });
  }

  async #publish(): Promise<void> {
    try {
      const acquired = await withDeadline(
        this.options.client.eval(
          acquireRefreshScript,
          1,
          this.options.key,
          this.options.token,
          this.#ttlMs,
        ),
        this.#commandTimeoutMs,
      );
      if (Number(acquired) !== 1) {
        throw new ImageWorkerLeaseConflictError();
      }
      this.#lastSuccessfulPublishAtMs = this.#nowMs();
      if (!this.#readySent && !this.#stopped) {
        this.#readySent = true;
        this.options.onFirstPublished();
      }
    } catch (error) {
      if (!this.#stopped) {
        if (!this.#readySent) {
          this.options.onError(error);
        } else if (error instanceof ImageWorkerLeaseConflictError || this.#refreshWindowExhausted()) {
          this.#signalLeaseLost(error);
        } else {
          this.options.onError(error);
        }
      }
      throw error;
    }
  }

  #refreshWindowExhausted(): boolean {
    if (this.#lastSuccessfulPublishAtMs === null) return true;
    const nextDecisionAt = this.#nowMs() + this.#intervalMs + this.#commandTimeoutMs;
    return nextDecisionAt >= this.#lastSuccessfulPublishAtMs + this.#ttlMs;
  }

  #signalLeaseLost(error: unknown): void {
    if (this.#leaseLossSignalled) return;
    this.#leaseLossSignalled = true;
    this.options.onLeaseLost?.(error);
  }
}

class ImageWorkerLeaseConflictError extends Error {
  public constructor() {
    super("Another image worker owns the singleton lease.");
    this.name = "ImageWorkerLeaseConflictError";
  }
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`Image worker ${label} is outside the bounded range.`);
  }
  return value;
}
