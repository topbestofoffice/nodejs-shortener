import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApplication } from "../src/app.js";
import { configuredDomainsReady } from "../src/infrastructure/runtime-resources.js";
import {
  CachedRuntimeReadinessProbe,
  waitForInitialRuntimeReadiness,
  requiredDirectoriesReady,
  type RuntimeDependencyChecks,
  type RuntimeReadinessProbe,
} from "../src/infrastructure/runtime-readiness.js";
import {
  imageWorkerHeartbeatKey,
  imageWorkerHeartbeatObserved,
} from "../src/modules/uploads/bullmq-executor.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

const openApplications: FastifyInstance[] = [];
const temporaryPaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(openApplications.splice(0).map(async (app) => app.close()));
  await Promise.all(temporaryPaths.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("cached runtime readiness", () => {
  it("waits boundedly for dependencies and refuses listener admission after the deadline", async () => {
    let now = 0;
    let attempts = 0;
    const eventuallyReady = readinessProbe(async () => ++attempts >= 3);
    await expect(waitForInitialRuntimeReadiness(eventuallyReady, {
      timeoutMs: 1_000,
      retryMs: 100,
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds; },
    })).resolves.toBeUndefined();
    expect(attempts).toBe(3);

    now = 0;
    await expect(waitForInitialRuntimeReadiness(readinessProbe(async () => false), {
      timeoutMs: 300,
      retryMs: 100,
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds; },
    }))
      .rejects.toThrow(/refusing to open the web listener/);
    now = 0;
    await expect(waitForInitialRuntimeReadiness(readinessProbe(async () => { throw new Error("secret"); }), {
      timeoutMs: 100,
      retryMs: 100,
      now: () => now,
      delay: async (milliseconds) => { now += milliseconds; },
    }))
      .rejects.toThrow(/refusing to open the web listener/);
  });

  it("single-flights concurrent checks and briefly caches the bounded result", async () => {
    let now = 1_000;
    let releaseDatabase: ((ready: boolean) => void) | undefined;
    const database = vi.fn(() => new Promise<boolean>((resolve) => {
      releaseDatabase = resolve;
    }));
    const checks = successfulChecks({ database });
    const probe = new CachedRuntimeReadinessProbe(checks, {
      timeoutMs: 1_000,
      cacheTtlMs: 100,
      now: () => now,
    });

    const first = probe.check();
    const concurrent = probe.check();
    expect(concurrent).toBe(first);
    expect(database).toHaveBeenCalledTimes(1);
    expect(checks.redis).toHaveBeenCalledTimes(1);
    releaseDatabase?.(true);
    await expect(Promise.all([first, concurrent])).resolves.toEqual([true, true]);

    now += 99;
    await expect(probe.check()).resolves.toBe(true);
    expect(database).toHaveBeenCalledTimes(1);

    now += 2;
    const refreshed = probe.check();
    expect(database).toHaveBeenCalledTimes(2);
    releaseDatabase?.(true);
    await expect(refreshed).resolves.toBe(true);
    await probe.close();
    await expect(probe.check()).resolves.toBe(false);
  });

  it("returns within its deadline and does not stack a second raw probe behind a hung dependency", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const database = vi.fn(() => new Promise<boolean>(() => undefined));
    const probe = new CachedRuntimeReadinessProbe(successfulChecks({ database }), {
      timeoutMs: 50,
      cacheTtlMs: 10,
      now: () => now,
    });

    const pending = probe.check();
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe(false);

    now += 11;
    await expect(probe.check()).resolves.toBe(false);
    expect(database).toHaveBeenCalledTimes(1);
    await probe.close();
  });

  it("fails closed when any required dependency rejects or returns false", async () => {
    const rejected = new CachedRuntimeReadinessProbe(successfulChecks({
      redis: vi.fn(async () => { throw new Error("redis://secret@example.invalid"); }),
    }));
    const missingWorker = new CachedRuntimeReadinessProbe(successfulChecks({
      imageWorker: vi.fn(async () => false),
    }));

    await expect(rejected.check()).resolves.toBe(false);
    await expect(missingWorker.check()).resolves.toBe(false);
    await Promise.all([rejected.close(), missingWorker.close()]);
  });
});

describe("readiness dependency contracts", () => {
  it("requires readable writable directories, not a file or missing path", async () => {
    const root = await mkdtemp(join(tmpdir(), "node-shortener-ready-"));
    temporaryPaths.push(root);
    const first = join(root, "private");
    const second = join(root, "public");
    const file = join(root, "not-a-directory");
    await Promise.all([mkdir(first), mkdir(second), writeFile(file, "x")]);

    await expect(requiredDirectoriesReady([first, second])).resolves.toBe(true);
    await expect(requiredDirectoriesReady([first, file])).resolves.toBe(false);
    await expect(requiredDirectoriesReady([first, join(root, "missing")])).resolves.toBe(false);
    await expect(requiredDirectoriesReady([])).resolves.toBe(false);
  });

  it("requires the exact configured domain set to match the authoritative MariaDB view", async () => {
    await expect(configuredDomainsReady({
      listManageableDomains: async () => domainPolicies,
    }, testConfig)).resolves.toBe(true);
    await expect(configuredDomainsReady({
      listManageableDomains: async () => domainPolicies.slice(0, 2),
    }, testConfig)).resolves.toBe(false);
    await expect(configuredDomainsReady({
      listManageableDomains: async () => domainPolicies.map((domain) => domain.id === 2
        ? { ...domain, allowCreate: false }
        : domain),
    }, testConfig)).resolves.toBe(false);
    for (const drift of [
      { domainKey: "wrong-key" },
      { diversionCampaign: "wrong-campaign" },
      { reportTimezone: "Asia/Kolkata" as const },
    ]) {
      await expect(configuredDomainsReady({
        listManageableDomains: async () => domainPolicies.map((domain) => domain.id === 2
          ? { ...domain, ...drift }
          : domain),
      }, testConfig)).resolves.toBe(false);
    }
    await expect(configuredDomainsReady({
      listManageableDomains: async () => [
        ...domainPolicies,
        { ...domainPolicies[0]!, id: 99, hostname: "unexpected.local" },
      ],
    }, testConfig)).resolves.toBe(false);
    await expect(configuredDomainsReady({
      listManageableDomains: async () => domainPolicies.map((domain) => domain.id === 2
        ? { ...domain, active: false }
        : domain),
    }, testConfig)).resolves.toBe(false);
  });

  it("accepts only a live worker heartbeat token", () => {
    const identity = "a".repeat(64);
    expect(imageWorkerHeartbeatObserved(
      `${identity}:123:1f4ed7e5-9854-4fae-abd8-217909229af1`, identity,
    )).toBe(true);
    expect(imageWorkerHeartbeatObserved("GCP does not support client list", identity)).toBe(false);
    expect(imageWorkerHeartbeatObserved(`${"b".repeat(64)}:123:1f4ed7e5-9854-4fae-abd8-217909229af1`, identity))
      .toBe(false);
    expect(imageWorkerHeartbeatObserved(null, identity)).toBe(false);
  });

  it("binds worker readiness to one exact production activation", () => {
    const key = imageWorkerHeartbeatKey("pilot:bull");
    expect(key).toContain("worker-singleton:v2");
    expect(() => imageWorkerHeartbeatObserved(null, "not-a-digest"))
      .toThrow("deployment identity is invalid");
  });
});

describe("readiness HTTP boundary", () => {
  it("keeps liveness process-only and serves readiness only on the dashboard host", async () => {
    const check = vi.fn(async () => true);
    const domains = new InMemoryApplicationStore(domainPolicies);
    const domainRead = vi.spyOn(domains, "getDomain");
    const app = await trackedApplication({
      stores: domains,
      readiness: readinessProbe(check),
    });

    const live = await app.inject({ method: "GET", url: "/health/live", headers: { host: "url6x.local" } });
    const ready = await app.inject({ method: "GET", url: "/health/ready", headers: { host: "url6x.local" } });
    const redirectReady = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { host: "vidx1x.local" },
    });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ ok: true });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ ok: true, domain_id: 1 });
    expect(ready.headers["cache-control"]).toBe("no-store, private, max-age=0");
    expect(redirectReady.statusCode).toBe(404);
    expect(check).toHaveBeenCalledTimes(1);
    expect(domainRead).not.toHaveBeenCalled();
  });

  it("maps a dependency error to a generic no-store 503 without exposing secrets", async () => {
    const secret = "mysql://user:password@private-db.example";
    const app = await trackedApplication({
      readiness: readinessProbe(async () => { throw new Error(secret); }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { host: "url6x.local" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("Temporarily unavailable.\n");
    expect(response.body).not.toContain(secret);
    expect(response.headers["cache-control"]).toBe("no-store, private, max-age=0");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
  });

  it("fails closed when mysql mode is assembled without its runtime readiness probe", async () => {
    const app = await trackedApplication({
      config: { ...testConfig, storageDriver: "mysql" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/health/ready",
      headers: { host: "url6x.local" },
    });
    expect(response.statusCode).toBe(503);
  });
});

function successfulChecks(
  overrides: Partial<RuntimeDependencyChecks> = {},
): RuntimeDependencyChecks & Record<keyof RuntimeDependencyChecks, ReturnType<typeof vi.fn>> {
  return {
    database: vi.fn(async () => true),
    redis: vi.fn(async () => true),
    directories: vi.fn(async () => true),
    imageWorker: vi.fn(async () => true),
    ...overrides,
  } as RuntimeDependencyChecks & Record<keyof RuntimeDependencyChecks, ReturnType<typeof vi.fn>>;
}

function readinessProbe(check: () => Promise<boolean>): RuntimeReadinessProbe {
  return { check, close: () => Promise.resolve() };
}

async function trackedApplication(
  options: Partial<Parameters<typeof buildApplication>[0]> = {},
): Promise<FastifyInstance> {
  const app = await buildApplication({
    config: testConfig,
    stores: new InMemoryApplicationStore(domainPolicies),
    ...options,
  });
  openApplications.push(app);
  return app;
}
