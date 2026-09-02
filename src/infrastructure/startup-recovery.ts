export const DEFAULT_RECOVERY_PREFLIGHT_TIMEOUT_MS = 5_000;
export const MIN_RECOVERY_PREFLIGHT_TIMEOUT_MS = 1_000;
export const MAX_RECOVERY_PREFLIGHT_TIMEOUT_MS = 30_000;

export interface RecoveryPreflightOptions {
  /**
   * The preflight must be read-only. A timed-out promise cannot be cancelled,
   * so allowing it to mutate the ledger could race the post-listen drainer.
   */
  readonly timeoutMs?: number;
}

export async function recoverBeforeListen<T>(
  preflight: () => Promise<T>,
  listen: () => Promise<unknown>,
  options: RecoveryPreflightOptions = {},
): Promise<T> {
  const result = options.timeoutMs === undefined
    ? await preflight()
    : await withRecoveryPreflightDeadline(preflight(), options.timeoutMs);
  await listen();
  return result;
}

export function recoveryPreflightTimeoutFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const value = Number(environment.IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS);
  return Number.isSafeInteger(value)
    && value >= MIN_RECOVERY_PREFLIGHT_TIMEOUT_MS
    && value <= MAX_RECOVERY_PREFLIGHT_TIMEOUT_MS
    ? value
    : DEFAULT_RECOVERY_PREFLIGHT_TIMEOUT_MS;
}

export function isRecoveryDrainerOwner(instance: string | undefined): boolean {
  if (instance === undefined || instance === "") return true;
  if (!/^(?:0|[1-9][0-9]*)$/.test(instance)) {
    throw new Error("NODE_APP_INSTANCE must be a non-negative integer when supplied.");
  }
  return instance === "0";
}

export interface RecoveryBatchResult {
  readonly inspected: number;
  readonly recovered: number;
  readonly manualReview: number;
}

export interface RecoveryDrainerOptions {
  readonly owner: boolean;
  readonly batchSize: number;
  readonly drainBatch: () => Promise<RecoveryBatchResult>;
  readonly idleDelayMs?: number;
  readonly continuationDelayMs?: number;
  readonly errorDelayMs?: number;
  readonly onResult?: (result: RecoveryBatchResult) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Runs one recovery batch at a time in exactly one web process. The durable
 * ledger's version/lease compare-and-swap remains the correctness boundary;
 * singleton ownership only avoids needless duplicate scanning.
 */
export class RecoveryDrainer {
  readonly #owner: boolean;
  readonly #batchSize: number;
  readonly #drainBatch: () => Promise<RecoveryBatchResult>;
  readonly #idleDelayMs: number;
  readonly #continuationDelayMs: number;
  readonly #errorDelayMs: number;
  readonly #onResult: ((result: RecoveryBatchResult) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  #started = false;
  #stopping = false;
  #timer: NodeJS.Timeout | null = null;
  #activePass: Promise<void> | null = null;

  public constructor(options: RecoveryDrainerOptions) {
    if (!Number.isSafeInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 100) {
      throw new RangeError("Recovery drainer batch size must be between 1 and 100.");
    }
    this.#owner = options.owner;
    this.#batchSize = options.batchSize;
    this.#drainBatch = options.drainBatch;
    this.#idleDelayMs = boundedDelay(options.idleDelayMs ?? 5_000, "idle");
    this.#continuationDelayMs = boundedDelay(options.continuationDelayMs ?? 25, "continuation");
    this.#errorDelayMs = boundedDelay(options.errorDelayMs ?? 5_000, "error");
    this.#onResult = options.onResult;
    this.#onError = options.onError;
  }

  public get isOwner(): boolean {
    return this.#owner;
  }

  public get isRunning(): boolean {
    return this.#started && !this.#stopping && this.#owner;
  }

  public start(): void {
    if (this.#started) return;
    this.#started = true;
    if (!this.#owner) return;
    this.#beginPass();
  }

  public async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    await this.#activePass;
  }

  #beginPass(): void {
    if (this.#stopping || this.#activePass !== null) return;
    const pass = this.#runPass();
    this.#activePass = pass;
    void pass.then(() => {
      if (this.#activePass === pass) this.#activePass = null;
    });
  }

  async #runPass(): Promise<void> {
    let nextDelay = this.#idleDelayMs;
    try {
      const result = await this.#drainBatch();
      callSafely(this.#onResult, result);
      // A full productive batch proves more due rows may remain. Empty, stale
      // or waiting batches back off so an unexpected row cannot cause a spin.
      if (result.inspected >= this.#batchSize
        && (result.recovered > 0 || result.manualReview > 0)) {
        nextDelay = this.#continuationDelayMs;
      }
    } catch (error) {
      callSafely(this.#onError, error);
      nextDelay = this.#errorDelayMs;
    }
    this.#schedule(nextDelay);
  }

  #schedule(delayMs: number): void {
    if (this.#stopping) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#beginPass();
    }, delayMs);
    this.#timer.unref();
  }
}

async function withRecoveryPreflightDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs)
    || timeoutMs < MIN_RECOVERY_PREFLIGHT_TIMEOUT_MS
    || timeoutMs > MAX_RECOVERY_PREFLIGHT_TIMEOUT_MS) {
    throw new RangeError("Recovery preflight timeout is outside the supported bound.");
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Image recovery preflight exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Image recovery preflight failed.", { cause: error }));
      },
    );
  });
}

function boundedDelay(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 3_600_000) {
    throw new RangeError(`Recovery drainer ${label} delay is invalid.`);
  }
  return value;
}

function callSafely<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    // Logging/metrics hooks must never terminate the durable recovery loop.
  }
}
