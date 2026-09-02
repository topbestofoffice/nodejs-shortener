import { describe, expect, it, vi } from "vitest";
import {
  RecoveryDrainer,
  isRecoveryDrainerOwner,
  recoverBeforeListen,
  recoveryPreflightTimeoutFromEnvironment,
} from "../src/infrastructure/startup-recovery.js";

describe("image-job startup ordering", () => {
  it("does not bind the HTTP socket until reconciliation completes", async () => {
    const gate = deferred<{ inspected: number }>();
    const order: string[] = [];
    const reconcile = vi.fn(async () => {
      order.push("reconcile");
      return gate.promise;
    });
    const listen = vi.fn(async () => {
      order.push("listen");
    });

    const startup = recoverBeforeListen(reconcile, listen);
    await Promise.resolve();
    expect(reconcile).toHaveBeenCalledOnce();
    expect(listen).not.toHaveBeenCalled();

    gate.resolve({ inspected: 3 });
    await expect(startup).resolves.toEqual({ inspected: 3 });
    expect(order).toEqual(["reconcile", "listen"]);
  });

  it("leaves the HTTP socket unbound when reconciliation fails", async () => {
    const failure = new Error("ledger recovery failed");
    const listen = vi.fn(async () => undefined);

    await expect(recoverBeforeListen(async () => Promise.reject(failure), listen)).rejects.toBe(failure);
    expect(listen).not.toHaveBeenCalled();
  });

  it("keeps the socket unbound when the read-only preflight exceeds its hard deadline", async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<{ dueJobsObserved: number }>();
      const listen = vi.fn(async () => undefined);
      const startup = recoverBeforeListen(() => gate.promise, listen, { timeoutMs: 1_000 });
      const rejection = expect(startup).rejects.toThrow("Image recovery preflight exceeded 1000ms");

      await vi.advanceTimersByTimeAsync(1_000);

      await rejection;
      expect(listen).not.toHaveBeenCalled();
      gate.resolve({ dueJobsObserved: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes the exact preflight bound consumed by the server and PM2", () => {
    expect(recoveryPreflightTimeoutFromEnvironment({})).toBe(5_000);
    expect(recoveryPreflightTimeoutFromEnvironment({ IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS: "1000" })).toBe(1_000);
    expect(recoveryPreflightTimeoutFromEnvironment({ IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS: "30000" })).toBe(30_000);
    expect(recoveryPreflightTimeoutFromEnvironment({ IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS: "999" })).toBe(5_000);
    expect(recoveryPreflightTimeoutFromEnvironment({ IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS: "30001" })).toBe(5_000);
    expect(recoveryPreflightTimeoutFromEnvironment({ IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS: "invalid" })).toBe(5_000);
  });
});

describe("bounded post-listen image recovery", () => {
  it("drains a backlog larger than the old 100-row startup cap without delaying readiness", async () => {
    vi.useFakeTimers();
    try {
      let remaining = 137;
      const preflight = vi.fn(async () => ({ dueJobsObserved: 1 }));
      const listen = vi.fn(async () => undefined);
      const drainBatch = vi.fn(async () => {
        if (remaining === 0) return { inspected: 0, recovered: 0, manualReview: 0 };
        remaining -= 1;
        return { inspected: 1, recovered: 1, manualReview: 0 };
      });
      const drainer = new RecoveryDrainer({
        owner: true,
        batchSize: 1,
        drainBatch,
        continuationDelayMs: 1,
        idleDelayMs: 1_000,
        errorDelayMs: 1_000,
      });

      await expect(recoverBeforeListen(preflight, listen, { timeoutMs: 1_000 }))
        .resolves.toEqual({ dueJobsObserved: 1 });
      drainer.start();

      // This is the same ordering used by server.ts before process.send("ready").
      expect(drainer.isRunning).toBe(true);
      expect(listen).toHaveBeenCalledOnce();
      expect(remaining).toBe(136);
      for (let index = 0; index < 137 && remaining > 0; index += 1) {
        await vi.advanceTimersByTimeAsync(1);
      }

      expect(remaining).toBe(0);
      expect(drainBatch).toHaveBeenCalledTimes(137);
      expect(preflight).toHaveBeenCalledOnce();
      expect(listen).toHaveBeenCalledOnce();
      await drainer.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("assigns ongoing recovery only to PM2 instance zero", async () => {
    expect(isRecoveryDrainerOwner(undefined)).toBe(true);
    expect(isRecoveryDrainerOwner("0")).toBe(true);
    expect(isRecoveryDrainerOwner("1")).toBe(false);
    expect(isRecoveryDrainerOwner("3")).toBe(false);
    expect(() => isRecoveryDrainerOwner("worker-a")).toThrow("NODE_APP_INSTANCE");

    const ownerDrain = vi.fn(async () => ({ inspected: 0, recovered: 0, manualReview: 0 }));
    const followerDrain = vi.fn(async () => ({ inspected: 0, recovered: 0, manualReview: 0 }));
    const owner = new RecoveryDrainer({ owner: true, batchSize: 1, drainBatch: ownerDrain });
    const follower = new RecoveryDrainer({ owner: false, batchSize: 1, drainBatch: followerDrain });
    owner.start();
    follower.start();
    await Promise.resolve();

    expect(owner.isRunning).toBe(true);
    expect(follower.isRunning).toBe(false);
    expect(ownerDrain).toHaveBeenCalledOnce();
    expect(followerDrain).not.toHaveBeenCalled();
    await Promise.all([owner.stop(), follower.stop()]);
  });

  it("awaits an active batch on shutdown and never schedules another pass", async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<{ inspected: number; recovered: number; manualReview: number }>();
      const drainBatch = vi.fn(() => gate.promise);
      const drainer = new RecoveryDrainer({
        owner: true,
        batchSize: 1,
        drainBatch,
        continuationDelayMs: 1,
        idleDelayMs: 1,
        errorDelayMs: 1,
      });
      drainer.start();
      expect(drainBatch).toHaveBeenCalledOnce();

      let stopped = false;
      const stopping = drainer.stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);

      gate.resolve({ inspected: 1, recovered: 1, manualReview: 0 });
      await stopping;
      await vi.advanceTimersByTimeAsync(10);
      expect(stopped).toBe(true);
      expect(drainer.isRunning).toBe(false);
      expect(drainBatch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains a failed pass and retries without an unhandled rejection", async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const drainBatch = vi.fn()
        .mockRejectedValueOnce(new Error("temporary ledger outage"))
        .mockResolvedValue({ inspected: 0, recovered: 0, manualReview: 0 });
      const drainer = new RecoveryDrainer({
        owner: true,
        batchSize: 1,
        drainBatch,
        errorDelayMs: 1,
        idleDelayMs: 10_000,
        onError: (error) => {
          errors.push(error);
          throw new Error("logger unavailable");
        },
      });
      drainer.start();
      await vi.advanceTimersByTimeAsync(1);

      expect(drainBatch).toHaveBeenCalledTimes(2);
      expect(errors).toHaveLength(1);
      await drainer.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error("Deferred promise is not initialized.");
      resolvePromise(value);
    },
  };
}
