import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ImageWorkerHeartbeat,
  startLeasedImageConsumer,
  type WorkerHeartbeatRedisClient,
} from "../src/modules/uploads/worker-heartbeat.js";
import { crashStopImageWorkerAfterLeaseLoss } from "../src/workers/lease-loss.js";

afterEach(() => vi.useRealTimers());

describe("image worker heartbeat lifecycle", () => {
  const deployment = "a".repeat(64);
  const token = `${deployment}:123:1f4ed7e5-9854-4fae-abd8-217909229af1`;

  it("publishes a 15-second TTL, refreshes every five seconds and signals ready only after success", async () => {
    vi.useFakeTimers();
    const client = new FakeHeartbeatRedis();
    const ready = vi.fn();
    const heartbeat = new ImageWorkerHeartbeat({
      client,
      key: "pilot:image:heartbeat",
      token,
      onFirstPublished: ready,
      onError: vi.fn(),
    });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.sets).toEqual([{ ttl: 15_000, value: token }]);
    expect(ready).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(client.sets).toHaveLength(2);
    expect(ready).toHaveBeenCalledOnce();
    await heartbeat.stop();
  });

  it("does not signal PM2 ready on a failed publish and recovers on the next refresh", async () => {
    vi.useFakeTimers();
    const client = new FakeHeartbeatRedis();
    client.failNext = true;
    const ready = vi.fn();
    const error = vi.fn();
    const heartbeat = new ImageWorkerHeartbeat({
      client,
      key: "pilot:image:heartbeat",
      token,
      onFirstPublished: ready,
      onError: error,
    });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ready).toHaveBeenCalledOnce();
    await heartbeat.stop();
  });

  it("cannot delete a replacement worker's heartbeat during old-worker shutdown", async () => {
    const client = new FakeHeartbeatRedis();
    const old = new ImageWorkerHeartbeat({
      client,
      key: "pilot:image:heartbeat",
      token,
      onFirstPublished: vi.fn(),
      onError: vi.fn(),
    });
    old.start();
    await Promise.resolve();
    client.current = `${deployment}:456:eb6403f8-2340-47c0-bb4a-7d9ab7bf50f8`;

    await old.stop();

    expect(client.current).toBe(`${deployment}:456:eb6403f8-2340-47c0-bb4a-7d9ab7bf50f8`);
  });

  it("never lets a second worker overwrite the distributed singleton lease", async () => {
    vi.useFakeTimers();
    const client = new FakeHeartbeatRedis();
    const firstReady = vi.fn();
    const secondReady = vi.fn();
    const secondError = vi.fn();
    const first = new ImageWorkerHeartbeat({
      client,
      key: "pilot:image:heartbeat",
      token,
      onFirstPublished: firstReady,
      onError: vi.fn(),
    });
    const second = new ImageWorkerHeartbeat({
      client,
      key: "pilot:image:heartbeat",
      token: `${deployment}:456:eb6403f8-2340-47c0-bb4a-7d9ab7bf50f8`,
      onFirstPublished: secondReady,
      onError: secondError,
    });

    first.start();
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(firstReady).toHaveBeenCalledOnce();
    expect(secondReady).not.toHaveBeenCalled();
    expect(secondError).toHaveBeenCalledOnce();
    expect(client.current).toBe(token);

    await first.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(secondReady).toHaveBeenCalledOnce();
    await second.stop();
  });

  it("declares lease loss after a ready worker can no longer refresh its token", async () => {
    vi.useFakeTimers();
    const client = new FakeHeartbeatRedis();
    const lost = vi.fn();
    const exitNow = vi.fn();
    const heartbeat = new ImageWorkerHeartbeat({
      client,
      key: "pilot:image:heartbeat",
      token,
      onFirstPublished: vi.fn(),
      onError: vi.fn(),
      onLeaseLost: (error) => {
        lost(error);
        crashStopImageWorkerAfterLeaseLoss(error, { writeError: vi.fn(), exitNow });
      },
    });
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);
    client.current = `${deployment}:456:eb6403f8-2340-47c0-bb4a-7d9ab7bf50f8`;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lost).toHaveBeenCalledOnce();
    expect(exitNow).toHaveBeenCalledOnce();
    expect(exitNow).toHaveBeenCalledWith(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(exitNow).toHaveBeenCalledOnce();
    await heartbeat.stop();
  });

  it("tolerates one ambiguous post-ready Redis failure but exits before the lease safety window closes", async () => {
    vi.useFakeTimers();
    const client = new FakeHeartbeatRedis();
    const lost = vi.fn();
    const error = vi.fn();
    let nowMs = 0;
    const heartbeat = new ImageWorkerHeartbeat({
      client,
      key: "pilot:image:heartbeat",
      token,
      nowMs: () => nowMs,
      onFirstPublished: vi.fn(),
      onError: error,
      onLeaseLost: lost,
    });
    await heartbeat.acquire();
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);

    client.failNext = true;
    nowMs = 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(error).toHaveBeenCalledOnce();
    expect(lost).not.toHaveBeenCalled();

    client.failNext = true;
    nowMs = 10_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lost).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(lost).toHaveBeenCalledOnce();
    await heartbeat.stop();
  });

  it("never starts a BullMQ consumer that loses the initial singleton lease", async () => {
    const run = vi.fn(async () => undefined);
    const start = vi.fn();
    const ready = vi.fn();
    const leaseError = new Error("Another image worker owns the singleton lease.");

    await expect(startLeasedImageConsumer({
      consumer: {
        waitUntilReady: vi.fn(async () => undefined),
        run,
      },
      lease: {
        acquire: vi.fn(async () => { throw leaseError; }),
        start,
      },
      onReady: ready,
      onRunError: vi.fn(),
    })).rejects.toBe(leaseError);

    expect(run).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it("starts a leased consumer once and reports an asynchronous run-loop failure", async () => {
    const runError = new Error("consumer stopped");
    const onRunError = vi.fn();
    const events: string[] = [];

    await startLeasedImageConsumer({
      consumer: {
        waitUntilReady: vi.fn(async () => { events.push("connected"); }),
        run: vi.fn(async () => { throw runError; }),
      },
      lease: {
        acquire: vi.fn(async () => { events.push("acquired"); }),
        start: vi.fn(() => { events.push("refreshing"); }),
      },
      onReady: vi.fn(() => { events.push("ready"); }),
      onRunError,
    });
    await Promise.resolve();

    expect(events).toEqual(["connected", "acquired", "refreshing", "ready"]);
    expect(onRunError).toHaveBeenCalledWith(runError);
  });

  it("validates heartbeat identity and every configured timing bound", () => {
    const create = (overrides: Partial<ConstructorParameters<typeof ImageWorkerHeartbeat>[0]> = {}) =>
      new ImageWorkerHeartbeat({
        client: new FakeHeartbeatRedis(),
        key: "pilot:image:heartbeat",
        token,
        onFirstPublished: vi.fn(),
        onError: vi.fn(),
        ...overrides,
      });

    expect(() => create({ token: "invalid" })).toThrow("identity is invalid");
    expect(() => create({ key: "" })).toThrow("identity is invalid");
    for (const ttlMs of [999, 60_001, 1_000.5]) {
      expect(() => create({ ttlMs })).toThrow("TTL is outside");
    }
    expect(() => create({ ttlMs: 1_000, intervalMs: 1_000 })).toThrow("interval is outside");
    expect(() => create({ intervalMs: 249 })).toThrow("interval is outside");
    expect(() => create({ intervalMs: 500, commandTimeoutMs: 49 })).toThrow("command timeout is outside");
    expect(() => create({ intervalMs: 500, commandTimeoutMs: 501 })).toThrow("command timeout is outside");
  });

  it("makes acquire/start/stop idempotent and refuses reacquisition after stop", async () => {
    vi.useFakeTimers();
    const client = new FakeHeartbeatRedis();
    const ready = vi.fn();
    const heartbeat = new ImageWorkerHeartbeat({
      client,
      key: "pilot:image:heartbeat",
      token,
      onFirstPublished: ready,
      onError: vi.fn(),
    });

    await heartbeat.acquire();
    await heartbeat.acquire();
    heartbeat.start();
    heartbeat.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toHaveBeenCalledOnce();
    await heartbeat.stop();
    await heartbeat.stop();
    heartbeat.start();
    await expect(heartbeat.acquire()).rejects.toThrow("heartbeat is stopped");
  });

  it("coalesces concurrent acquire calls behind one in-flight lease operation", async () => {
    const pending = new DeferredHeartbeatRedis();
    const ready = vi.fn();
    const heartbeat = new ImageWorkerHeartbeat({
      client: pending,
      key: "pilot:image:heartbeat",
      token,
      onFirstPublished: ready,
      onError: vi.fn(),
    });

    const first = heartbeat.acquire();
    const second = heartbeat.acquire();
    expect(pending.calls).toBe(1);
    pending.resolve(1);
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(ready).toHaveBeenCalledOnce();
    await heartbeat.stop();
  });
});

class FakeHeartbeatRedis implements WorkerHeartbeatRedisClient {
  public readonly sets: Array<{ readonly ttl: number; readonly value: string }> = [];
  public current: string | null = null;
  public failNext = false;

  public async eval(script: string, _count: number, _key: string, token: string, ttl?: number): Promise<unknown> {
    if (script.includes("PEXPIRE")) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error("temporary Redis error");
      }
      if (this.current !== null && this.current !== token) return 0;
      this.current = token;
      this.sets.push({ ttl: ttl ?? 0, value: token });
      return 1;
    }
    if (this.current === token) {
      this.current = null;
      return 1;
    }
    return 0;
  }
}

class DeferredHeartbeatRedis implements WorkerHeartbeatRedisClient {
  public calls = 0;
  readonly #pending: Array<(value: unknown) => void> = [];

  public async eval(script: string): Promise<unknown> {
    if (!script.includes("PEXPIRE")) return 1;
    this.calls += 1;
    return new Promise((resolve) => this.#pending.push(resolve));
  }

  public resolve(value: unknown): void {
    this.#pending.shift()?.(value);
  }
}
