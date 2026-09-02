import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnvironmentFile } from "../src/config/load-env.js";
import type { RuntimeConfig } from "../src/config/runtime.js";
import type { SessionData } from "../src/core/types.js";
import {
  configuredDomainPoliciesReady,
  createRuntimeResources,
} from "../src/infrastructure/runtime-resources.js";
import { RedisSessionStore } from "../src/infrastructure/redis-session-store.js";
import { RedisCacheClaimStore } from "../src/infrastructure/redis-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.NODE_SHORTENER_COVERAGE_ENV;
  await Promise.all(temporaryDirectories.splice(0).map(
    async (path) => rm(path, { recursive: true, force: true }),
  ));
});

describe("runtime resource composition", () => {
  it("assembles and closes the complete in-memory runtime with deterministic readiness", async () => {
    const fixture = await runtimeFixture({
      developmentSeed: { username: "coverage-admin", password: "coverage-password" },
    });

    const resources = await createRuntimeResources(fixture.config);

    await expect(resources.readiness.check()).resolves.toBe(true);
    await expect(resources.stores.auth.findUserByUsername("coverage-admin")).resolves.toMatchObject({
      id: 1,
      username: "coverage-admin",
      role: "admin",
      defaultDomainId: 2,
    });
    await expect(resources.sessions.get("missing-session")).resolves.toBeNull();
    await expect(resources.close()).resolves.toBeUndefined();
  });

  it("does not invent a seed user and rejects current-engine assembly without MariaDB and Redis", async () => {
    const unseeded = await runtimeFixture();
    const resources = await createRuntimeResources(unseeded.config);
    await expect(resources.stores.auth.findUserByUsername("coverage-admin")).resolves.toBeNull();
    await resources.close();

    const incompatible = await runtimeFixture({ redirectEngine: "current" });
    await expect(createRuntimeResources(incompatible.config)).rejects.toThrow(
      "requires MariaDB and Redis resources",
    );
  });

  it("rejects duplicate identities and every material configured-domain drift", () => {
    expect(configuredDomainPoliciesReady(domainPolicies, testConfig)).toBe(true);
    expect(configuredDomainPoliciesReady([
      domainPolicies[0]!,
      { ...domainPolicies[1]!, id: domainPolicies[0]!.id },
      domainPolicies[2]!,
    ], testConfig)).toBe(false);

    for (const drift of [
      { hostname: "wrong.local" },
      { label: "Wrong label" },
      { surface: "dashboard" as const },
    ]) {
      expect(configuredDomainPoliciesReady(domainPolicies.map((domain) => domain.id === 2
        ? { ...domain, ...drift }
        : domain), testConfig)).toBe(false);
    }
  });
});

describe("private environment loading", () => {
  it("ignores a missing private env, loads an existing file and preserves shell authority", async () => {
    const root = await temporaryRoot("node-shortener-env-");
    await expect(Promise.resolve(loadEnvironmentFile(join(root, "missing.env")))).resolves.toBeUndefined();

    const envFile = join(root, "private.env");
    await writeFile(envFile, "NODE_SHORTENER_COVERAGE_ENV=from-file\n", { mode: 0o600 });
    loadEnvironmentFile(envFile);
    expect(process.env.NODE_SHORTENER_COVERAGE_ENV).toBe("from-file");

    process.env.NODE_SHORTENER_COVERAGE_ENV = "from-shell";
    loadEnvironmentFile(envFile);
    expect(process.env.NODE_SHORTENER_COVERAGE_ENV).toBe("from-shell");
  });

  it("does not hide a non-missing-file load failure", async () => {
    const root = await temporaryRoot("node-shortener-env-error-");
    const directory = join(root, "not-an-env-file");
    await mkdir(directory);
    expect(() => loadEnvironmentFile(directory)).toThrow();
  });
});

describe("Redis session and cache adapter contracts", () => {
  it("connects a waiting client and round-trips the exact session representation", async () => {
    const redis = new FakeRedis();
    const store = new RedisSessionStore(redis as unknown as Redis, "pilot");
    const session = validSession();

    await store.set(session, 90);
    expect(redis.connect).toHaveBeenCalledOnce();
    expect(redis.set).toHaveBeenCalledWith(
      `pilot:session:${session.id}`,
      JSON.stringify(session),
      "EX",
      90,
    );

    redis.status = "ready";
    redis.get.mockResolvedValueOnce(JSON.stringify(session));
    await expect(store.get(session.id)).resolves.toEqual(session);
    await store.delete(session.id);
    expect(redis.del).toHaveBeenCalledWith(`pilot:session:${session.id}`);
    expect(redis.connect).toHaveBeenCalledOnce();
  });

  it("fails closed for missing, malformed and schema-invalid sessions", async () => {
    const redis = new FakeRedis();
    redis.status = "ready";
    const store = new RedisSessionStore(redis as unknown as Redis, "pilot");
    redis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("{not-json")
      .mockResolvedValueOnce(JSON.stringify({ ...validSession(), csrfToken: "invalid" }));

    await expect(store.get("missing")).resolves.toBeNull();
    await expect(store.get("malformed")).resolves.toBeNull();
    await expect(store.get("invalid")).resolves.toBeNull();
    expect(redis.connect).not.toHaveBeenCalled();
  });

  it("covers cache connect, empty-delete, mutation, claim and close behavior without a live Redis", async () => {
    const client = new FakeRedis();
    const store = Object.create(RedisCacheClaimStore.prototype) as RedisCacheClaimStore;
    Object.defineProperty(store, "client", { value: client, configurable: true });

    client.get.mockResolvedValueOnce("cached");
    await expect(store.get("key")).resolves.toBe("cached");
    await store.set("key", "value", 30);
    await store.delete();
    expect(client.del).not.toHaveBeenCalled();
    await store.delete("a", "b");
    expect(client.del).toHaveBeenCalledWith("a", "b");

    client.set.mockResolvedValueOnce("OK");
    await expect(store.claim("claim", 15)).resolves.toBe("winner");
    await store.close();
    expect(client.disconnect).toHaveBeenCalledWith(false);

    client.status = "end";
    client.disconnect.mockClear();
    await store.close();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it("returns unavailable when cache connection fails before a claim", async () => {
    const client = new FakeRedis();
    client.connect.mockRejectedValueOnce(new Error("Redis unavailable"));
    const store = Object.create(RedisCacheClaimStore.prototype) as RedisCacheClaimStore;
    Object.defineProperty(store, "client", { value: client, configurable: true });

    await expect(store.claim("claim", 15)).resolves.toBe("unavailable");
  });
});

async function runtimeFixture(overrides: Partial<RuntimeConfig> = {}): Promise<{ config: RuntimeConfig }> {
  const root = await temporaryRoot("node-shortener-runtime-resources-");
  return {
    config: {
      ...testConfig,
      ...overrides,
      image: {
        ...testConfig.image,
        privateTempDir: join(root, "private", "tmp"),
        publicUploadDir: join(root, "public", "uploads"),
        ...(overrides.image ?? {}),
      },
    },
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function validSession(): SessionData {
  return {
    id: "a".repeat(64),
    userId: 7,
    csrfToken: "b".repeat(64),
    uploadScope: "c".repeat(64),
    authEpoch: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-09-02T00:00:00.000Z",
    rememberSelector: null,
  };
}

class FakeRedis {
  public status = "wait";
  public readonly connect = vi.fn(async () => { this.status = "ready"; });
  public readonly get = vi.fn<(...args: readonly unknown[]) => Promise<string | null>>(async () => null);
  public readonly set = vi.fn<(...args: readonly unknown[]) => Promise<unknown>>(async () => "OK");
  public readonly del = vi.fn<(...args: readonly unknown[]) => Promise<number>>(async () => 1);
  public readonly disconnect = vi.fn();
}
