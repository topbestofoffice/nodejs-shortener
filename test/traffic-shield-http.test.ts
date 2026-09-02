import multipartPlugin from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { DomainContext, DomainPolicy, LinkRecord, SessionData, UserRecord } from "../src/core/types.js";
import { registerLinkApiRoutes } from "../src/modules/links/http.js";
import type { LinkService } from "../src/modules/links/service.js";
import { trafficShieldSlotForDate } from "../src/modules/dashboard/shield-service.js";
import type { ImageUploadService } from "../src/modules/uploads/service.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

const csrf = "b".repeat(64);
const reportNow = new Date("2026-09-01T12:00:00.000Z");
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("Traffic Shield HTTP contract", () => {
  it("keeps the report inside the existing POST-only /api.php dispatcher", async () => {
    const fixture = await buildFixture();
    app = fixture.app;
    fixture.setAuth(authenticated(42));

    const response = await app.inject({ method: "GET", url: "/api.php", headers: { host: "url6x.local" } });

    expect(response.statusCode).toBe(405);
    expect(response.json()).toEqual({ ok: false, error: "POST required" });
  });

  it("requires dashboard authentication and the exact session CSRF", async () => {
    const fixture = await buildFixture();
    app = fixture.app;
    fixture.setAuth(null);
    const unauthenticated = await shieldRequest(app, "url6x.local", csrf);
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json()).toEqual({ ok: false, error: "Not authenticated" });

    fixture.setAuth(authenticated(42));
    const rejected = await shieldRequest(app, "url6x.local", "invalid");
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toEqual({ ok: false, error: "Invalid CSRF token" });
  });

  it("combines all current owner links across domains without leaking another owner or internal dimensions", async () => {
    const fixture = await buildFixture();
    app = fixture.app;
    seedShieldLinks(fixture.store);
    fixture.store.trafficShieldActivationStartedAtUtc = "2026-08-25 18:30:00";
    fixture.setAuth(authenticated(42));

    const response = await shieldRequest(app, "url6x.local", csrf);

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store, private, max-age=0");
    const payload = response.json<{ days: Array<Record<string, unknown>> } & Record<string, unknown>>();
    expect(payload).toMatchObject({
      ok: true,
      total: "9007199254741000",
      history_total: "9007199254741000",
      history_state: "exact",
    });
    expect(payload.days[0]).toMatchObject({ iso: "2026-09-01", count: "9007199254740993", state: "exact_so_far" });
    expect(payload.days[1]).toMatchObject({ iso: "2026-08-31", count: "7", state: "exact" });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/filtered_meta|filtered_bot|filtered_other|country|domain_id/i);
    expect(serialized).not.toContain("999");
  });

  it("returns an honest 503 on aggregate/settings failure without a false numeric zero", async () => {
    const fixture = await buildFixture();
    app = fixture.app;
    fixture.setAuth(authenticated(42));
    fixture.store.failTrafficShieldRead = true;

    const response = await shieldRequest(app, "url6x.local", csrf);

    expect(response.statusCode).toBe(503);
    expect(response.headers["cache-control"]).toBe("no-store, private, max-age=0");
    expect(response.json()).toEqual({ ok: false, error: "Protection report unavailable right now." });
    expect(response.body).not.toMatch(/"(?:total|history_total|count)"\s*:\s*0/);
  });

  it("keeps the same POST action hidden on redirect-only hosts", async () => {
    const fixture = await buildFixture();
    app = fixture.app;
    fixture.setAuth(authenticated(42));

    const response = await shieldRequest(app, "vidx1x.local", csrf);

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("history_total");
  });
});

async function buildFixture(): Promise<{
  readonly app: FastifyInstance;
  readonly store: InMemoryApplicationStore;
  readonly setAuth: (value: { session: SessionData; user: UserRecord } | null) => void;
}> {
  const instance = Fastify({ logger: false });
  await instance.register(multipartPlugin);
  const store = new InMemoryApplicationStore(domainPolicies);
  let auth: { session: SessionData; user: UserRecord } | null = authenticated(42);
  instance.decorateRequest("auth");
  instance.decorateRequest("domainContext");
  instance.decorateRequest("domainPolicy");
  instance.addHook("onRequest", async (request) => {
    const definition = testConfig.registry.resolve(String(request.headers.host ?? "")).definition;
    const policy = domainPolicies.find((entry) => entry.id === definition.id);
    if (policy === undefined) throw new Error("Missing domain fixture.");
    request.domainContext = { definition, requestHost: definition.canonicalHost, isCanonical: true } satisfies DomainContext;
    request.domainPolicy = policy satisfies DomainPolicy;
    request.auth = auth;
  });
  registerLinkApiRoutes(instance, {
    links: {} as LinkService,
    images: {} as ImageUploadService,
    stores: store,
    registry: testConfig.registry,
    browserScopedDefaultUsers: [],
    clock: { now: () => new Date(reportNow) },
  });
  return { app: instance, store, setAuth: (value) => { auth = value; } };
}

function seedShieldLinks(store: InMemoryApplicationStore): void {
  store.seedLink(link("1", 2, 42, "OwnerD2"), {
    filteredMetaClicks: 9_007_199_254_740_993n,
    filteredHistory: ring({ "2026-09-01": 9_007_199_254_740_993n }),
  });
  store.seedLink(link("2", 3, 42, "OwnerD3"), {
    filteredBotClicks: 7n,
    filteredHistory: ring({ "2026-08-31": 7n }),
  });
  store.seedLink(link("3", 2, 43, "OtherD2"), {
    filteredOtherClicks: 999n,
    filteredHistory: ring({ "2026-09-01": 999n }),
  });
}

function ring(values: Readonly<Record<string, bigint>>): Array<{ date: string | null; count: bigint }> {
  const cells = Array.from({ length: 7 }, () => ({ date: null as string | null, count: 0n }));
  for (const [date, count] of Object.entries(values)) {
    cells[trafficShieldSlotForDate(date)] = { date, count };
  }
  return cells;
}

function link(id: string, domainId: number, userId: number, code: string): LinkRecord {
  const definition = testConfig.registry.byId(domainId);
  if (definition === undefined) throw new Error("Missing link domain fixture.");
  return {
    id,
    domainId,
    code,
    userId,
    destination: `https://destination.example/${id}`,
    title: null,
    description: null,
    image: null,
    authorRole: "user",
    domainHostname: definition.canonicalHost,
    domainLabel: definition.label,
    diversionCampaign: definition.key,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  };
}

function authenticated(userId: number): { session: SessionData; user: UserRecord } {
  return {
    session: {
      id: `session-${userId}`,
      userId,
      csrfToken: csrf,
      uploadScope: "shield-http",
      authEpoch: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-09-02T00:00:00.000Z",
      rememberSelector: null,
    },
    user: {
      id: userId,
      username: `user-${userId}`,
      passwordHash: "unused",
      role: "user",
      defaultDomainId: 2,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  };
}

async function shieldRequest(target: FastifyInstance, host: string, suppliedCsrf: string) {
  const boundary = "----node-shortener-shield-boundary";
  const payload = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="action"\r\n\r\nshield_stats\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${suppliedCsrf}\r\n`,
    `--${boundary}--\r\n`,
  ].join(""), "utf8");
  return target.inject({
    method: "POST",
    url: "/api.php",
    headers: { host, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}
