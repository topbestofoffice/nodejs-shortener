import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApplication } from "../src/app.js";
import { DomainRegistry, normalizeRequestHost } from "../src/config/domain-registry.js";
import type { RuntimeConfig } from "../src/config/runtime.js";
import type { DomainDefinition } from "../src/core/types.js";
import type { AuthService } from "../src/modules/auth/service.js";
import type { LinkService } from "../src/modules/links/service.js";
import type { RedirectDecision, RedirectDecisionEngine } from "../src/modules/redirect/classification.js";
import type { ImageUploadService } from "../src/modules/uploads/service.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { baseLink, domainPolicies, testConfig } from "./fixtures.js";

const openApplications: FastifyInstance[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(openApplications.splice(0).map(async (app) => app.close()));
});

describe("request trust failure boundaries", () => {
  it("authenticates the private proxy before revealing whether a Host is configured", async () => {
    const token = "synthetic-private-origin-token";
    const config: RuntimeConfig = {
      ...testConfig,
      originAuth: {
        enabled: true,
        header: "x-shortener-origin-auth",
        expectedSha256: sha256(token),
      },
    };
    const store = new InMemoryApplicationStore(domainPolicies);
    const app = await trackedApplication({ config, stores: store });

    const configured = await app.inject({ method: "GET", url: "/", headers: { host: "url6x.local" } });
    const unknown = await app.inject({ method: "GET", url: "/", headers: { host: "unknown.local" } });
    expect(configured.statusCode).toBe(403);
    expect(unknown.statusCode).toBe(403);
    expect(configured.body).toBe(unknown.body);

    const authenticatedUnknown = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "unknown.local", "x-shortener-origin-auth": token },
    });
    expect(authenticatedUnknown.statusCode).toBe(421);
    expect(store.lookupCount).toBe(0);
  });

  it("rejects a statically inactive host before an alias redirect or database lookup", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const getDomain = vi.spyOn(store, "getDomain");
    const config = withRegistry([domainDefinition({
      active: false,
      aliases: ["www.vidx1x.local"],
    })]);
    const app = await trackedApplication({ config, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("www.vidx1x.local"),
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("Temporarily unavailable.\n");
    expect(response.headers.location).toBeUndefined();
    expect(getDomain).not.toHaveBeenCalled();
  });

  it("maps a missing or inactive authoritative domain row to temporary unavailability", async () => {
    for (const policy of [null, { ...domainPolicies[0]!, active: false }]) {
      const store = new InMemoryApplicationStore(domainPolicies);
      vi.spyOn(store, "getDomain").mockResolvedValue(policy);
      const app = await trackedApplication({ config: testConfig, stores: store });

      const response = await app.inject({
        method: "GET",
        url: "/login",
        headers: { host: "url6x.local" },
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers["cache-control"]).toBe("no-store, private, max-age=0");
    }
  });

  it("fails closed with 503 when the authoritative domain store is unavailable", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    vi.spyOn(store, "getDomain").mockRejectedValue(new Error("database credentials must not leak"));
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: "/login",
      headers: { host: "url6x.local" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("Temporarily unavailable.\n");
    expect(response.body).not.toContain("credentials");
  });

  it("rejects static/database policy drift instead of routing under the wrong rules", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    vi.spyOn(store, "getDomain").mockResolvedValue({
      ...domainPolicies[0]!,
      allowCreate: true,
    });
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: "/login",
      headers: { host: "url6x.local" },
    });

    expect(response.statusCode).toBe(421);
    expect(response.body).toBe("Misdirected request.\n");
  });

  it.each([
    { id: 99 },
    { domainKey: "wrong-key" },
    { label: "Wrong label" },
    { diversionCampaign: "wrong-campaign" },
    { reportTimezone: "Asia/Kolkata" as const },
  ])("rejects complete configured-domain identity drift: $drift", async (drift) => {
    const store = new InMemoryApplicationStore(domainPolicies);
    vi.spyOn(store, "getDomain").mockResolvedValue({ ...domainPolicies[0]!, ...drift });
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: "/login",
      headers: { host: "url6x.local" },
    });

    expect(response.statusCode).toBe(421);
  });

  it("authenticates the proxy origin before serving liveness or canonicalizing aliases", async () => {
    const token = "pilot-origin-token";
    const store = new InMemoryApplicationStore(domainPolicies);
    const getDomain = vi.spyOn(store, "getDomain").mockRejectedValue(new Error("must not be queried by liveness"));
    const config: RuntimeConfig = {
      ...testConfig,
      originAuth: {
        enabled: true,
        header: "x-origin-auth-test",
        expectedSha256: sha256(token),
      },
    };
    const app = await trackedApplication({ config, stores: store });

    const missing = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "url6x.local" },
    });
    const wrong = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "url6x.local", "x-origin-auth-test": "wrong" },
    });
    const oversized = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "url6x.local", "x-origin-auth-test": "x".repeat(257) },
    });
    const live = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "url6x.local", "x-origin-auth-test": token },
    });
    const unauthenticatedAlias = await app.inject({
      method: "GET",
      url: "/safe?x=1",
      headers: { host: "www.url6x.local" },
    });
    const authenticatedAlias = await app.inject({
      method: "GET",
      url: "/safe?x=1",
      headers: { host: "www.url6x.local", "x-origin-auth-test": token },
    });

    expect([missing.statusCode, wrong.statusCode, oversized.statusCode]).toEqual([403, 403, 403]);
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ ok: true });
    expect(unauthenticatedAlias.statusCode).toBe(403);
    expect(unauthenticatedAlias.headers.location).toBeUndefined();
    expect(authenticatedAlias.statusCode).toBe(301);
    expect(authenticatedAlias.headers.location).toBe("https://url6x.local/safe?x=1");
    expect(getDomain).not.toHaveBeenCalled();
  });

  it("hides health and pilot diagnostics on redirect-only hosts without a domain-store read", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const getDomain = vi.spyOn(store, "getDomain");
    const config: RuntimeConfig = {
      ...testConfig,
      pilotDiagnostics: { enabled: true, expectedTokenSha256: sha256("pilot-token") },
    };
    const app = await trackedApplication({ config, stores: store });

    for (const url of ["/health/live", "/health/ready", "/__pilot/headers"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { host: "vidx1x.local", "x-pilot-diagnostic-token": "pilot-token" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).toBe("Not found.\n");
    }
    expect(getDomain).not.toHaveBeenCalled();
  });
});

describe("redirect route branches", () => {
  it("returns an empty HEAD preview with anti-cache headers and no accounting", async () => {
    const store = seededStore();
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "HEAD",
      url: `/${baseLink.code}`,
      headers: { host: "vidx1x.local", "user-agent": "facebookexternalhit/1.1" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("");
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate, max-age=0");
    expect(store.accountingEvents).toHaveLength(0);
  });

  it("returns an empty, non-indexable HEAD response for a blocked request", async () => {
    const store = seededStore();
    const decide = vi.fn<RedirectDecisionEngine["decide"]>(async () => ({
      target: baseLink.destination,
      diverted: false,
      filterReason: "fbclid_replay",
      reportCountry: null,
      country: "US",
      dynamicDiversionEnabled: true,
      block: "fbclid_replay",
    }));
    const app = await trackedApplication({
      config: testConfig,
      stores: store,
      decisions: { decide },
    });

    const response = await app.inject({
      method: "HEAD",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe("");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ method: "HEAD" }));
    expect(store.accountingEvents[0]?.outcome).toBe("filtered_bot");
  });

  it("returns the fixed HEAD 404 without querying storage for an invalid code", async () => {
    const store = seededStore();
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "HEAD",
      url: "/bad-code",
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("This short link does not exist.");
    expect(response.body).not.toContain(baseLink.destination);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(store.lookupCount).toBe(0);
  });

  it.each([
    ["aws_dc", "Access from this hosting, VPN, or proxy network is not allowed."],
    ["fbclid_replay", "Access denied."],
  ] as const)("uses the safe %s block response", async (reason, expectedMessage) => {
    const store = seededStore();
    const app = await trackedApplication({
      config: testConfig,
      stores: store,
      decisions: decisionEngine({ block: reason, filterReason: reason }),
    });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain(expectedMessage);
    expect(response.headers.location).toBeUndefined();
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
  });

  it("fails open to the stored destination when the decision provider throws", async () => {
    const store = seededStore();
    const decisions: RedirectDecisionEngine = {
      decide: async () => {
        throw new Error("classification provider unavailable");
      },
    };
    const app = await trackedApplication({ config: testConfig, stores: store, decisions });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(baseLink.destination);
    expect(store.accountingEvents[0]?.outcome).toBe("delivered");
  });

  it("uses 302 for dynamic user diversion but keeps an admin redirect permanent", async () => {
    const store = seededStore();
    store.seedLink({ ...baseLink, id: "9007199254740994", code: "Admin12", authorRole: "admin" });
    const decisions = decisionEngine({
      target: "https://campaign.example/landing",
      diverted: true,
      dynamicDiversionEnabled: true,
    });
    const app = await trackedApplication({ config: testConfig, stores: store, decisions });

    const user = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });
    const admin = await app.inject({
      method: "GET",
      url: "/Admin12",
      headers: { ...browserHeaders("vidx1x.local"), "x-forwarded-for": "192.0.2.20" },
      remoteAddress: "192.0.2.20",
    });

    expect(user.statusCode).toBe(302);
    expect(admin.statusCode).toBe(301);
    expect(user.headers.location).toBe("https://campaign.example/landing");
    expect(admin.headers.location).toBe("https://campaign.example/landing");
    expect(store.accountingEvents.map((event) => event.outcome)).toEqual(["diverted", "diverted"]);
  });
});

describe("redirect cache and generic error handling", () => {
  it("falls back to MariaDB when cache reads fail and still redirects when cache repair fails", async () => {
    const store = seededStore();
    vi.spyOn(store, "get").mockRejectedValueOnce(new Error("Redis read unavailable"));
    vi.spyOn(store, "set").mockRejectedValueOnce(new Error("Redis write unavailable"));
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(baseLink.destination);
    expect(store.lookupCount).toBe(1);
  });

  it("never trusts a well-formed cached link belonging to a different host", async () => {
    const store = seededStore();
    await store.set(cacheKey(), JSON.stringify({
      id: baseLink.id,
      domain_id: baseLink.domainId,
      code: baseLink.code,
      user_id: baseLink.userId,
      destination: "https://attacker.example/cache-poison",
      title: baseLink.title,
      description: baseLink.description,
      image: baseLink.image,
      author_role: baseLink.authorRole,
      domain_hostname: "attacker.example",
      domain_label: baseLink.domainLabel,
      diversion_campaign: baseLink.diversionCampaign,
      created_at: baseLink.createdAt.toISOString(),
    }), 60);
    vi.spyOn(store, "delete").mockRejectedValueOnce(new Error("Redis delete unavailable"));
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(baseLink.destination);
    expect(response.headers.location).not.toContain("attacker.example");
    expect(store.lookupCount).toBe(1);
  });

  it("treats syntactically valid but schema-malformed cache data as a miss", async () => {
    const store = seededStore();
    await store.set(cacheKey(), JSON.stringify({
      id: [baseLink.id],
      domain_id: String(baseLink.domainId),
      code: baseLink.code,
      destination: "https://attacker.example/cache-poison",
    }), 60);
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    expect(response.headers.location).toBe(baseLink.destination);
    expect(store.lookupCount).toBe(1);
  });

  it("renders a crawler preview despite cache read and write failures", async () => {
    const store = seededStore();
    vi.spyOn(store, "get").mockRejectedValueOnce(new Error("Redis read unavailable"));
    vi.spyOn(store, "set").mockRejectedValue(new Error("Redis write unavailable"));
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: { host: "vidx1x.local", "user-agent": "Twitterbot/1.0" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(baseLink.destination);
    expect(store.accountingEvents).toHaveLength(0);
  });

  it("continues accounting when the duplicate-claim store throws", async () => {
    const store = seededStore();
    vi.spyOn(store, "claim").mockRejectedValueOnce(new Error("claim unavailable"));
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(301);
    expect(store.accountingEvents).toHaveLength(1);
  });

  it("returns a generic 500 without leaking an unexpected storage error", async () => {
    const store = seededStore();
    vi.spyOn(store, "findLink").mockRejectedValueOnce(new Error("secret database endpoint"));
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: browserHeaders("vidx1x.local"),
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).toBe("Unexpected error.\n");
    expect(response.body).not.toContain("database endpoint");
  });

  it("uses the explicit plain-text not-found handler outside the short-code route", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const app = await trackedApplication({ config: testConfig, stores: store });

    const response = await app.inject({
      method: "GET",
      url: "/nested/path",
      headers: { host: "vidx1x.local" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("Not found.\n");
    expect(response.headers["content-type"]).toContain("text/plain");
  });
});

describe("application dependency wiring guards", () => {
  const fakeAuthService = {} as unknown as AuthService;
  const fakeImageService = {} as unknown as ImageUploadService;
  const fakeLinkService = {} as unknown as LinkService;

  it("refuses image routes without authentication", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);

    await expect(buildApplication({
      config: testConfig,
      stores: store,
      imageUploadService: fakeImageService,
    })).rejects.toThrow("Image upload routes require authentication.");
  });

  it("refuses link routes when both required services are missing", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);

    await expect(buildApplication({
      config: testConfig,
      stores: store,
      linkService: fakeLinkService,
    })).rejects.toThrow("Link API routes require authentication and image services.");
  });

  it("refuses link routes when authentication exists but image handling is absent", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);

    await expect(buildApplication({
      config: testConfig,
      stores: store,
      authService: fakeAuthService,
      linkService: fakeLinkService,
    })).rejects.toThrow("Link API routes require authentication and image services.");
  });
});

describe("domain registry security branches", () => {
  it("normalizes safe IDNs and rejects delimiter-based Host confusion", () => {
    expect(normalizeRequestHost("BÜCHER.example.:443")).toBe("xn--bcher-kva.example");
    for (const host of [
      "go.example,attacker.example",
      "go.example@attacker.example",
      "go.example\\attacker.example",
      "go.example\r\nX-Injected: yes",
      "go.example:0",
    ]) {
      expect(normalizeRequestHost(host)).toBeNull();
    }
  });

  it("rejects duplicate identities and alias collisions", () => {
    expect(() => new DomainRegistry([
      domainDefinition({ id: 1, canonicalHost: "one.example", publicBaseUrl: "https://one.example" }),
      domainDefinition({ id: 1, canonicalHost: "two.example", publicBaseUrl: "https://two.example" }),
    ])).toThrow("Duplicate domain id: 1");

    expect(() => new DomainRegistry([
      domainDefinition({ id: 1, canonicalHost: "one.example", publicBaseUrl: "https://one.example", aliases: ["shared.example"] }),
      domainDefinition({ id: 2, canonicalHost: "two.example", publicBaseUrl: "https://two.example", aliases: ["shared.example"] }),
    ])).toThrow("Duplicate host route: shared.example");
  });

  it.each([
    ["credentials", { publicBaseUrl: "https://user:pass@vidx1x.local" }],
    ["public path", { publicBaseUrl: "https://vidx1x.local/base" }],
    ["wrong public host", { publicBaseUrl: "https://other.local" }],
    ["non-HTTP image scheme", { imageBaseUrl: "ftp://images.example" }],
    ["image query", { imageBaseUrl: "https://images.example/?version=1" }],
  ] as const)("rejects unsafe domain URL configuration: %s", (_label, override) => {
    expect(() => new DomainRegistry([domainDefinition(override)])).toThrow();
  });

  it("allows a separate HTTPS image host while keeping the public Host exact", () => {
    const registry = new DomainRegistry([domainDefinition({ imageBaseUrl: "https://images.example" })]);

    expect(registry.byId(2)?.imageBaseUrl).toBe("https://images.example");
    expect(registry.resolve("VIDX1X.LOCAL:443").definition.id).toBe(2);
    expect(Object.isFrozen(registry.all())).toBe(true);
  });
});

function seededStore(): InMemoryApplicationStore {
  const store = new InMemoryApplicationStore(domainPolicies);
  store.seedLink(baseLink);
  return store;
}

async function trackedApplication(
  options: Parameters<typeof buildApplication>[0],
): Promise<FastifyInstance> {
  const app = await buildApplication(options);
  openApplications.push(app);
  return app;
}

function browserHeaders(host: string): Record<string, string> {
  return {
    host,
    "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36",
  };
}

function decisionEngine(overrides: Partial<RedirectDecision>): RedirectDecisionEngine {
  return {
    decide: async (input) => ({
      target: input.link.destination,
      diverted: false,
      filterReason: null,
      reportCountry: null,
      country: null,
      dynamicDiversionEnabled: false,
      block: null,
      ...overrides,
    }),
  };
}

function cacheKey(): string {
  return `test-shortener:domain:${baseLink.domainId}:link:${baseLink.code}`;
}

function withRegistry(definitions: readonly DomainDefinition[]): RuntimeConfig {
  return {
    ...testConfig,
    registry: new DomainRegistry(definitions),
  };
}

function domainDefinition(overrides: Partial<DomainDefinition> = {}): DomainDefinition {
  return {
    id: 2,
    key: "vidx1x",
    diversionCampaign: "vidx1x",
    reportTimezone: "UTC",
    canonicalHost: "vidx1x.local",
    aliases: ["www.vidx1x.local"],
    label: "VIDX1X",
    surface: "redirect",
    active: true,
    allowCreate: true,
    publicBaseUrl: "https://vidx1x.local",
    imageBaseUrl: "https://vidx1x.local",
    emitLocalImageAlt: false,
    compactNoImagePreview: false,
    creationFallback: false,
    acceptUnprovenDeliveredClaim: false,
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
