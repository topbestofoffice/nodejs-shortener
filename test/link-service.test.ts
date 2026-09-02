import { describe, expect, it } from "vitest";
import { LinkService } from "../src/modules/links/service.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

const fixedClock = { now: () => new Date("2026-08-23T12:00:00.000Z") };

describe("LinkService", () => {
  it("rejects creation on active but creation-paused URL6X", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const service = new LinkService({
      appNamespace: testConfig.appNamespace,
      registry: testConfig.registry,
      stores: store,
      clock: fixedClock,
      codeGenerator: () => "Paused1",
    });

    await expect(service.create({ domainId: 1, userId: 9, destination: "https://example.com" }))
      .rejects.toMatchObject({ code: "DOMAIN_NOT_CREATABLE" });
  });

  it("creates a VIDX1X link and retains domain identity", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const service = new LinkService({
      appNamespace: testConfig.appNamespace,
      registry: testConfig.registry,
      stores: store,
      clock: fixedClock,
      codeGenerator: () => "Create1",
    });

    const link = await service.create({ domainId: 2, userId: 9, destination: "https://example.com/a" });

    expect(link).toMatchObject({ domainId: 2, code: "Create1", userId: 9 });
    expect(service.shortUrl(link)).toBe("https://vidx1x.local/Create1");
  });

  it("retries only duplicate-code failures", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    let calls = 0;
    const service = new LinkService({
      appNamespace: testConfig.appNamespace,
      registry: testConfig.registry,
      stores: store,
      clock: fixedClock,
      codeGenerator: () => (++calls === 1 ? "Clash11" : "Unique1"),
    });
    await service.create({ domainId: 2, userId: 7, destination: "https://first.example", image: null });
    calls = 0;

    const link = await service.create({ domainId: 2, userId: 8, destination: "https://second.example" });

    expect(link.code).toBe("Unique1");
    expect(calls).toBe(2);
  });

  it("enforces owner-scoped deletion", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const service = new LinkService({
      appNamespace: testConfig.appNamespace,
      registry: testConfig.registry,
      stores: store,
      clock: fixedClock,
      codeGenerator: () => "Owned11",
    });
    await service.create({ domainId: 2, userId: 8, destination: "https://example.com" });

    await expect(service.deleteOwned(2, "Owned11", 99)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.deleteOwned(2, "Owned11", 8)).resolves.toBeUndefined();
  });

  it("does not report a committed delete as failed when cache invalidation is unavailable", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const service = new LinkService({
      appNamespace: testConfig.appNamespace,
      registry: testConfig.registry,
      stores: {
        domains: store,
        links: store,
        accounting: store,
        claims: store,
        auth: store,
        uploads: store,
        cache: {
          get: (key) => store.get(key),
          set: (key, value, ttl) => store.set(key, value, ttl),
          delete: async () => { throw new Error("Redis unavailable"); },
        },
      },
      clock: fixedClock,
      codeGenerator: () => "Delete1",
    });
    await service.create({ domainId: 2, userId: 8, destination: "https://example.com" });

    await expect(service.deleteOwned(2, "Delete1", 8)).resolves.toBeUndefined();
    await expect(service.deleteOwned(2, "Delete1", 8)).rejects.toMatchObject({ statusCode: 404 });
  });

  it.each([
    ["no trailing slash", "  https://Example.COM  ", "https://Example.COM"],
    ["explicit trailing slash", "https://Example.COM/", "https://Example.COM/"],
    [
      "percent escapes, URL case, and query spelling",
      "HTTPS://EXAMPLE.COM/%2fPath?Q=%2f&Mixed=VaLue",
      "HTTPS://EXAMPLE.COM/%2fPath?Q=%2f&Mixed=VaLue",
    ],
  ])("preserves the trimmed PHP destination spelling for %s", async (_label, destination, expected) => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const service = new LinkService({
      appNamespace: testConfig.appNamespace,
      registry: testConfig.registry,
      stores: store,
      clock: fixedClock,
      codeGenerator: () => "Exact11",
    });

    await expect(service.create({ domainId: 2, userId: 8, destination }))
      .resolves.toMatchObject({ destination: expected });
  });

  it.each([
    "javascript:alert(1)",
    "https://user@example.com",
    "https://user:pass@example.com",
    "https://example.com/path\tsegment",
    "\nhttps://example.com/path",
    `https://example.com/${"a".repeat(4_077)}`,
    "not a url",
  ])("rejects unsafe destination %s", async (destination) => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const service = new LinkService({
      appNamespace: testConfig.appNamespace,
      registry: testConfig.registry,
      stores: store,
      clock: fixedClock,
      codeGenerator: () => "Safe111",
    });

    await expect(service.create({ domainId: 2, userId: 8, destination })).rejects.toMatchObject({ code: "INVALID_DESTINATION" });
  });
});
