import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../src/app.js";
import { noImageMetadataReader, renderOpenGraphPreview } from "../src/modules/redirect/preview.js";
import { canonicalAliasTarget } from "../src/security/request-trust.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { baseLink, domainPolicies, testConfig } from "./fixtures.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("redirect HTTP contract", () => {
  it("rejects an unknown host before any store lookup", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({ method: "GET", url: `/${baseLink.code}`, headers: { host: "wrong.local" } });

    expect(response.statusCode).toBe(421);
    expect(store.lookupCount).toBe(0);
  });

  it("isolates identical codes by host/domain", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    store.seedLink({ ...baseLink, id: "2", domainId: 1, domainHostname: "url6x.local", destination: "https://other.example" });
    app = await buildApplication({ config: testConfig, stores: store });

    const vidx = await app.inject({ method: "GET", url: `/${baseLink.code}`, headers: browserHeaders("vidx1x.local") });
    const url6x = await app.inject({ method: "GET", url: `/${baseLink.code}`, headers: browserHeaders("url6x.local") });

    expect(vidx.headers.location).toBe(baseLink.destination);
    expect(url6x.headers.location).toBe("https://other.example");
  });

  it("renders stored Open Graph metadata to preview crawlers without counting", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: { host: "vidx1x.local", "user-agent": "facebookexternalhit/1.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('property="og:title" content="Stored title"');
    expect(response.body).toContain('property="og:url" content="https://vidx1x.local/Ab12Cd3"');
    expect(store.accountingEvents).toHaveLength(0);
  });

  it("never emits or redirects to an unsafe legacy destination", async () => {
    const unsafe = { ...baseLink, destination: "javascript:alert(document.domain)" };
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(unsafe);
    app = await buildApplication({ config: testConfig, stores: store });

    for (const userAgent of ["facebookexternalhit/1.1", browserHeaders("vidx1x.local")["user-agent"]!]) {
      const response = await app.inject({
        method: "GET",
        url: `/${unsafe.code}`,
        headers: { host: "vidx1x.local", "user-agent": userAgent },
      });
      expect(response.statusCode).toBe(404);
      expect(response.headers.location).toBeUndefined();
      expect(response.body).not.toContain("javascript:");
    }

    const domain = testConfig.registry.byId(2);
    if (domain === undefined) throw new Error("D2 fixture is missing");
    const preview = await renderOpenGraphPreview(unsafe, domain, noImageMetadataReader);
    expect(preview).toContain("Destination unavailable.");
    expect(preview).not.toContain("<script>");
    expect(preview).not.toContain('href="javascript:');
  });

  it.each([
    ["credentials", "https://user@example.com/private"],
    ["ASCII control", "https://destination.example/path\r\nignored"],
    ["over 4096 bytes", `https://destination.example/${"a".repeat(4_070)}`],
  ])("does not cache or emit an unsafe legacy %s destination", async (_label, destination) => {
    const unsafe = { ...baseLink, destination };
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(unsafe);
    const key = `test-shortener:domain:2:link:${baseLink.code}`;
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${unsafe.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers.location).toBeUndefined();
    expect(await store.get(key)).toBeNull();
  });

  it.each([
    ["leading whitespace", " https://Destination.Example/%2fPath?Q=%2f", "https://Destination.Example/%2fPath?Q=%2f"],
    ["trailing whitespace", "https://Destination.Example/%2fPath?Q=%2f ", "https://Destination.Example/%2fPath?Q=%2f"],
  ])("trims a safe legacy %s destination without rewriting its URL spelling", async (_label, destination, expected) => {
    const legacy = { ...baseLink, destination };
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(legacy);
    const key = `test-shortener:domain:2:link:${baseLink.code}`;
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${legacy.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(expected);
    expect(await store.get(key)).toContain(expected);
    expect(await store.get(key)).not.toContain(`"destination":" ${expected}`);
  });

  it("rejects a poisoned cache destination and repairs it from the safe MariaDB row", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    const key = `test-shortener:domain:2:link:${baseLink.code}`;
    await store.set(key, JSON.stringify({
      id: baseLink.id,
      domain_id: baseLink.domainId,
      code: baseLink.code,
      user_id: baseLink.userId,
      destination: "javascript:alert(1)",
      title: baseLink.title,
      description: baseLink.description,
      image: baseLink.image,
      compact_activity_tracked: 0,
      author_role: baseLink.authorRole,
      domain_hostname: baseLink.domainHostname,
      domain_label: baseLink.domainLabel,
      diversion_campaign: baseLink.diversionCampaign,
      created_at: baseLink.createdAt.toISOString(),
    }), 60);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(baseLink.destination);
    expect(await store.get(key)).toContain(baseLink.destination);
    expect(await store.get(key)).not.toContain("javascript:");
  });

  it.each([
    { domainId: 1, host: "url6x.local", label: "URL6X", card: "summary_large_image", omitEmpty: false },
    { domainId: 2, host: "vidx1x.local", label: "VIDX1X", card: "summary", omitEmpty: true },
    { domainId: 3, host: "plays9x.local", label: "Plays9X", card: "summary_large_image", omitEmpty: false },
  ])("applies the configured no-image preview behavior on $host", async ({
    domainId,
    host,
    label,
    card,
    omitEmpty,
  }) => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink({
      ...baseLink,
      id: String(domainId),
      domainId,
      domainHostname: host,
      domainLabel: label,
      image: null,
      description: "   ",
    });
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: { host, "user-agent": "facebookexternalhit/1.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(`<meta name="twitter:card" content="${card}">`);
    expect(response.body.includes('property="og:description"')).toBe(!omitEmpty);
  });

  it("keeps a nonempty description on a no-image compact card", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink({ ...baseLink, image: null, description: "Useful preview context" });
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: { host: "vidx1x.local", "user-agent": "facebookexternalhit/1.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('property="og:description" content="Useful preview context"');
    expect(response.body).toContain('<meta name="twitter:card" content="summary">');
  });

  it.each([
    { domainId: 1, host: "url6x.local", label: "URL6X", emitAlt: true },
    { domainId: 2, host: "vidx1x.local", label: "VIDX1X", emitAlt: false },
    { domainId: 3, host: "plays9x.local", label: "Plays9X", emitAlt: true },
  ])("uses large-card metadata for a managed image on $host", async ({ domainId, host, label, emitAlt }) => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink({
      ...baseLink,
      id: String(domainId),
      domainId,
      domainHostname: host,
      domainLabel: label,
      title: `${label} accessible preview`,
    });
    app = await buildApplication({
      config: testConfig,
      stores: store,
      metadataReader: {
        read: async () => ({ width: 1200, height: 630, mime: "image/jpeg" }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: { host, "user-agent": "facebookexternalhit/1.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(response.body.includes('property="og:image:alt"')).toBe(emitAlt);
    expect(response.body).toContain('property="og:image:width" content="1200"');
    expect(response.body).toContain('property="og:image:height" content="630"');
    expect(response.body).toContain('property="og:image:type" content="image/jpeg"');
  });

  it("does not count generic bots", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: { host: "vidx1x.local", "user-agent": "curl/8.0" },
    });

    expect(response.statusCode).toBe(301);
    expect(store.accountingEvents).toHaveLength(0);
  });

  it("counts a human once per 15-second claim and preserves BIGINT as a string", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    app = await buildApplication({ config: testConfig, stores: store });

    const first = await app.inject({ method: "GET", url: `/${baseLink.code}`, headers: browserHeaders("vidx1x.local") });
    const duplicate = await app.inject({ method: "GET", url: `/${baseLink.code}`, headers: browserHeaders("vidx1x.local") });

    expect(first.statusCode).toBe(301);
    expect(duplicate.statusCode).toBe(301);
    expect(store.accountingEvents).toHaveLength(1);
    expect(store.accountingEvents[0]?.linkId).toBe("9007199254740993");
    expect(store.accountingEvents[0]?.trackRecentActivity).toBe(true);
  });

  it("still redirects when accounting fails", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    store.failAccounting = true;
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({ method: "GET", url: `/${baseLink.code}`, headers: browserHeaders("vidx1x.local") });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(baseLink.destination);
  });

  it("keeps the PHP uploads/ recent-activity fallback case-sensitive", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const link = { ...baseLink, image: "Uploads/legacy-name.jpg" };
    store.seedLink(link);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${link.code}`,
      headers: browserHeaders(link.domainHostname),
    });

    expect(response.statusCode).toBe(301);
    expect(store.accountingEvents[0]?.trackRecentActivity).toBe(false);
    expect(store.recentActivityEpochsForTest(link.domainId, link.code)).toBeNull();
  });

  it("treats malformed cached link JSON as a miss and repairs from the store", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    await store.set(`test-shortener:domain:2:link:${baseLink.code}`, "{broken-json", 60);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(baseLink.destination);
    expect(store.lookupCount).toBe(1);
  });

  it("reads the current PHP snake_case Redis link payload without a database lookup", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    await store.set(`test-shortener:domain:2:link:${baseLink.code}`, JSON.stringify({
      id: baseLink.id,
      domain_id: baseLink.domainId,
      code: baseLink.code,
      user_id: baseLink.userId,
      destination: baseLink.destination,
      title: baseLink.title,
      description: baseLink.description,
      image: null,
      compact_activity_tracked: 1,
      author_role: baseLink.authorRole,
      domain_hostname: baseLink.domainHostname,
      domain_label: baseLink.domainLabel,
      diversion_campaign: baseLink.diversionCampaign,
    }), 60);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(baseLink.destination);
    expect(store.lookupCount).toBe(0);
    expect(store.accountingEvents[0]?.trackRecentActivity).toBe(true);
  });

  it("canonicalizes an alias without doing a link lookup", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({ method: "GET", url: `/${baseLink.code}?x=1`, headers: browserHeaders("www.vidx1x.local") });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(`https://vidx1x.local/${baseLink.code}?x=1`);
    expect(store.lookupCount).toBe(0);
  });

  it("never treats a scheme-relative alias target as an external redirect", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: "//attacker.example/path?x=1",
      headers: browserHeaders("www.vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe("https://vidx1x.local/attacker.example/path?x=1");
    expect(store.lookupCount).toBe(0);
  });

  it.each([
    "/\\\\attacker.example/path",
    "/\\/attacker.example/path",
    "/%5c%5cattacker.example/path",
    "/%5C/attacker.example/path",
  ])("does not let ambiguous alias target %s leave the canonical origin", async (url) => {
    const store = new InMemoryApplicationStore(domainPolicies);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url,
      headers: browserHeaders("www.vidx1x.local"),
    });

    expect([301, 400]).toContain(response.statusCode);
    if (response.headers.location !== undefined) {
      expect(new URL(response.headers.location).origin).toBe("https://vidx1x.local");
    }
    expect(store.lookupCount).toBe(0);
  });

  it.each([
    "/\\\\attacker.example/path",
    "/\\/attacker.example/path",
    "/%5c%5cattacker.example/path",
    "/%5C/attacker.example/path",
  ])("rejects an unnormalized ambiguous target %s", (url) => {
    expect(() => canonicalAliasTarget(url, "https://vidx1x.local"))
      .toThrowError(expect.objectContaining({ statusCode: 400, code: "INVALID_REQUEST_TARGET" }));
  });

  it("keeps encoded leading slashes under the canonical origin", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    app = await buildApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: "/%2f%2fattacker.example/path?x=1",
      headers: browserHeaders("www.vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    const location = response.headers.location ?? "";
    expect(new URL(location).origin).toBe("https://vidx1x.local");
    expect(location).toBe("https://vidx1x.local/%2f%2fattacker.example/path?x=1");
    expect(store.lookupCount).toBe(0);
  });
});

function browserHeaders(host: string): Record<string, string> {
  return {
    host,
    "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36",
  };
}
