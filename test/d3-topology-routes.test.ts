import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../src/app.js";
import { DomainRegistry } from "../src/config/domain-registry.js";
import type { LinkRecord } from "../src/core/types.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { baseLink, domainPolicies, testConfig } from "./fixtures.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("D3 domain topology", () => {
  it.each(["config/domains.local.json", "config/domains.local.example.json"])(
    "enables compact no-image previews only for D2 in %s",
    async (path) => {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      const registry = new DomainRegistry(raw);

      expect(registry.all().map((domain) => ({
        id: domain.id,
        compactNoImagePreview: domain.compactNoImagePreview,
      }))).toEqual([
        { id: 1, compactNoImagePreview: false },
        { id: 2, compactNoImagePreview: true },
        { id: 3, compactNoImagePreview: false },
      ]);
    },
  );

  it("keeps D1 paused, D2 as the first fallback, and D2 plus D3 selectable", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);

    expect(testConfig.registry.all().map((domain) => ({
      id: domain.id,
      key: domain.key,
      surface: domain.surface,
      active: domain.active,
      allowCreate: domain.allowCreate,
      creationFallback: domain.creationFallback,
      acceptUnprovenDeliveredClaim: domain.acceptUnprovenDeliveredClaim,
    }))).toEqual([
      { id: 1, key: "url6x", surface: "dashboard", active: true, allowCreate: false, creationFallback: false, acceptUnprovenDeliveredClaim: false },
      { id: 2, key: "vidx1x", surface: "redirect", active: true, allowCreate: true, creationFallback: true, acceptUnprovenDeliveredClaim: false },
      { id: 3, key: "plays9x", surface: "redirect", active: true, allowCreate: true, creationFallback: false, acceptUnprovenDeliveredClaim: true },
    ]);
    const selectable = await store.listSelectableDomains();
    expect(selectable.map((domain) => domain.id)).toEqual([2, 3]);
    expect(selectable[0]?.id).toBe(2);
  });

  it("accepts only the Plays9X apex and does not invent a www alias", () => {
    expect(testConfig.registry.resolve("plays9x.local")).toMatchObject({
      isCanonical: true,
      definition: {
        id: 3,
        key: "plays9x",
        canonicalHost: "plays9x.local",
        aliases: [],
        imageBaseUrl: "https://plays9x.local",
        emitLocalImageAlt: true,
        compactNoImagePreview: false,
      },
    });
    expect(() => testConfig.registry.resolve("www.plays9x.local")).toThrow("Misdirected request");
  });

  it("leaves the generic single-domain configuration valid and singular", async () => {
    const raw = JSON.parse(await readFile("config/domains.single.example.json", "utf8")) as unknown;
    const registry = new DomainRegistry(raw);

    expect(registry.all()).toHaveLength(1);
    expect(registry.all()[0]).toMatchObject({
      key: "shortener",
      surface: "dashboard",
      active: true,
      allowCreate: true,
      creationFallback: false,
      acceptUnprovenDeliveredClaim: false,
    });
  });
});

describe("D3 redirect-only routes", () => {
  it.each(["/", "/?cache_bust=1", "/index.php", "/index.php?cache_bust=1"])(
    "returns an empty, no-store and non-indexable 404 for %s",
    async (url) => {
      const store = new InMemoryApplicationStore(domainPolicies);
      app = await buildApplication({ config: testConfig, stores: store });

      const response = await app.inject({ method: "GET", url, headers: { host: "plays9x.local" } });

      expect(response.statusCode).toBe(404);
      expect(response.body).toBe("");
      expect(response.headers["cache-control"]).toContain("no-store");
      expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
      expect(store.lookupCount).toBe(0);
    },
  );

  it("does not apply the blank redirect surface response to the dashboard Host", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({ method: "GET", url: "/", headers: { host: "url6x.local" } });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toBe("");
    expect(response.headers["x-robots-tag"]).toBeUndefined();
  });

  it("serves only the matching D3 short code and keeps D2 isolated", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const d3Link: LinkRecord = {
      ...baseLink,
      id: "9007199254740994",
      domainId: 3,
      domainHostname: "plays9x.local",
      domainLabel: "Plays9X",
      diversionCampaign: "plays9x",
      destination: "https://plays-destination.example/article",
    };
    store.seedLink(baseLink);
    store.seedLink(d3Link);
    app = await buildApplication({ config: testConfig, stores: store });

    const d2 = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });
    const d3 = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("plays9x.local"),
    });
    const www = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("www.plays9x.local"),
    });

    expect(d2.statusCode).toBe(301);
    expect(d2.headers.location).toBe(baseLink.destination);
    expect(d3.statusCode).toBe(301);
    expect(d3.headers.location).toBe(d3Link.destination);
    expect(www.statusCode).toBe(421);
    expect(www.headers.location).toBeUndefined();
  });

  it.each(["/admin.php", "/api.php", "/stats.php", "/nested/path", "/Unknown9"])(
    "keeps the redirect-only surface hidden at %s",
    async (url) => {
      const store = new InMemoryApplicationStore(domainPolicies);
      app = await buildApplication({ config: testConfig, stores: store });

      const response = await app.inject({ method: "GET", url, headers: browserHeaders("plays9x.local") });

      expect(response.statusCode).toBe(404);
      expect(response.headers.location).toBeUndefined();
    },
  );
});

function browserHeaders(host: string): Record<string, string> {
  return {
    host,
    "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36",
  };
}
