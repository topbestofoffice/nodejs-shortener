import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

export interface RuntimeReadinessProbe {
  check(): Promise<boolean>;
  close(): Promise<void>;
}

export interface RuntimeDependencyChecks {
  readonly database: () => Promise<boolean>;
  readonly redis: () => Promise<boolean>;
  readonly directories: () => Promise<boolean>;
  readonly imageWorker: () => Promise<boolean>;
}

export interface RuntimeReadinessOptions {
  readonly timeoutMs?: number;
  readonly cacheTtlMs?: number;
  readonly now?: () => number;
}

interface ActiveProbe {
  readonly raw: Promise<boolean>;
  readonly bounded: Promise<boolean>;
}

/**
 * One bounded dependency probe per web process. Concurrent callers share the
 * same bounded result, and a timed-out raw operation remains single-flight
 * until it actually settles. That prevents health polling from stacking work
 * in the MariaDB pool or Redis client after an upstream stall.
 */
export class CachedRuntimeReadinessProbe implements RuntimeReadinessProbe {
  readonly #checks: RuntimeDependencyChecks;
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  #active: ActiveProbe | null = null;
  #cached: { readonly ready: boolean; readonly expiresAt: number } | null = null;
  #closed = false;

  public constructor(checks: RuntimeDependencyChecks, options: RuntimeReadinessOptions = {}) {
    this.#checks = checks;
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? 1_500, "Readiness timeout");
    this.#cacheTtlMs = positiveInteger(options.cacheTtlMs ?? 1_000, "Readiness cache TTL");
    this.#now = options.now ?? Date.now;
  }

  public check(): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false);

    const now = this.#now();
    if (this.#cached !== null && now < this.#cached.expiresAt) {
      return Promise.resolve(this.#cached.ready);
    }
    if (this.#active !== null) {
      return this.#active.bounded;
    }

    const raw = this.#runChecks();
    const bounded = boundedBoolean(raw, this.#timeoutMs);
    const active = { raw, bounded };
    this.#active = active;

    void bounded.then((ready) => {
      if (!this.#closed) {
        this.#cached = { ready, expiresAt: this.#now() + this.#cacheTtlMs };
      }
    });
    void raw.then(
      () => {
        if (this.#active === active) this.#active = null;
      },
      () => {
        if (this.#active === active) this.#active = null;
      },
    );
    return bounded;
  }

  public async close(): Promise<void> {
    this.#closed = true;
    this.#cached = null;
    if (this.#active !== null) {
      await this.#active.bounded;
    }
  }

  async #runChecks(): Promise<boolean> {
    const results = await Promise.allSettled([
      this.#checks.database(),
      this.#checks.redis(),
      this.#checks.directories(),
      this.#checks.imageWorker(),
    ]);
    return results.every((result) => result.status === "fulfilled" && result.value === true);
  }
}

export function createDeterministicReadinessProbe(ready: boolean): RuntimeReadinessProbe {
  let closed = false;
  return {
    check: () => Promise.resolve(!closed && ready),
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
}

export async function waitForInitialRuntimeReadiness(
  probe: RuntimeReadinessProbe,
  options: {
    readonly timeoutMs?: number;
    readonly retryMs?: number;
    readonly now?: () => number;
    readonly delay?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<void> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? 12_000, "Initial readiness timeout");
  const retryMs = positiveInteger(options.retryMs ?? 500, "Initial readiness retry");
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((milliseconds) => new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  }));
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (await probe.check().catch(() => false)) return;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await delay(Math.min(retryMs, remaining));
  }
  throw new Error("Runtime dependencies are not ready; refusing to open the web listener.");
}

export async function requiredDirectoriesReady(paths: readonly string[]): Promise<boolean> {
  if (paths.length === 0) return false;
  const mode = constants.R_OK | constants.W_OK | constants.X_OK;
  const results = await Promise.allSettled(paths.map(async (path) => {
    const details = await stat(path);
    if (!details.isDirectory()) return false;
    await access(path, mode);
    return true;
  }));
  return results.every((result) => result.status === "fulfilled" && result.value === true);
}

function boundedBoolean(operation: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    operation.then(
      (value) => finish(value === true),
      () => finish(false),
    );
  });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}
