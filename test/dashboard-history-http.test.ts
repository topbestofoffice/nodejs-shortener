import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../src/app.js";
import { AuthService } from "../src/modules/auth/service.js";
import { createPhpCompatiblePasswordHash } from "../src/modules/auth/passwords.js";
import { InMemoryApplicationStore, InMemorySessionStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

let app: FastifyInstance | undefined;
const fixedClock = { now: () => new Date("2026-09-01T12:00:00Z") };

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("persisted dashboard history HTTP contract", () => {
  it("shows only the signed-in owner's persisted links, current stats and literal search results", async () => {
    const store = await fixtureStore();
    store.seedLink(link(41, 10, "OwnCode", "Needle_% report"), {
      countedClicks: 12_345n,
      todayClicks: 11n,
      todayClickDate: "2026-09-01",
    });
    store.seedLink(link(42, 11, "OtherCode", "Needle_% private"), { countedClicks: 99_999n });
    const auth = authService(store);
    app = await buildApplication({ config: testConfig, stores: store, authService: auth, clock: fixedClock });
    const cookie = await login(app);

    const response = await app.inject({
      method: "GET",
      url: "/index.php?q=Needle_%25&per=20&page=99",
      headers: { host: "url6x.local", cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Needle_% report");
    expect(response.body).not.toContain("Needle_% private");
    expect(response.body).toContain('aria-label="12,345 counted clicks"');
    expect(response.body).toContain("1 result for");
    expect(response.body).toContain('value="Needle_%"');
    expect(response.body).toContain("Your links</span><strong>1</strong>");
    expect(response.body).toContain("Your counted clicks</span><strong>12,345</strong>");
    expect(response.body).toContain("11 today");
  });

  it("clamps pagination from current link truth and orders newest IDs first", async () => {
    const store = await fixtureStore();
    for (let id = 1; id <= 25; id += 1) {
      store.seedLink(link(id, 10, `Code${String(id).padStart(3, "0")}`, `Title ${id}`));
    }
    app = await buildApplication({ config: testConfig, stores: store, authService: authService(store), clock: fixedClock });
    const cookie = await login(app);

    const response = await app.inject({
      method: "GET",
      url: "/index.php?per=20&page=99",
      headers: { host: "url6x.local", cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Page 2 of 2 · 25 links");
    expect(response.body).toContain("Title 5");
    expect(response.body).toContain("Title 1");
    expect(response.body).not.toContain("Title 25");
    expect(response.body.indexOf("Title 5")).toBeLessThan(response.body.indexOf("Title 1"));
  });

  it("ignores a stale account default for the shared browser-scoped author", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedUser({
      id: 8,
      username: "hdvideos",
      passwordHash: await createPhpCompatiblePasswordHash("secret-password"),
      role: "user",
      defaultDomainId: 3,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    app = await buildApplication({ config: testConfig, stores: store, authService: authService(store), clock: fixedClock });
    const cookie = await login(app, "hdvideos");

    const response = await app.inject({
      method: "GET",
      url: "/index.php",
      headers: { host: "url6x.local", cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-preference-scope="browser"');
    expect(response.body).toContain('data-default-domain-id="2"');
    expect(response.body.match(/value="2" selected>VIDX1X/g)).toHaveLength(2);
    expect(response.body).not.toContain('value="3" selected>Plays9X');
  });

  it("returns the history page when a legacy row uses a domain absent from the Node registry", async () => {
    const store = await fixtureStore();
    store.seedLink(link(51, 10, "Good510", "Configured row"));
    store.seedLink({
      ...link(52, 10, "Old520", "Retired-domain row"),
      domainId: 999,
      domainHostname: "retired.example",
      domainLabel: "Retired",
    });
    app = await buildApplication({ config: testConfig, stores: store, authService: authService(store), clock: fixedClock });
    const cookie = await login(app);

    const response = await app.inject({
      method: "GET",
      url: "/index.php",
      headers: { host: "url6x.local", cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Configured row");
    expect(response.body).toContain("Retired-domain row");
    expect(response.body).toContain("Unavailable domain · Old520");
    expect(response.body).not.toContain("https://retired.example/Old520");
  });
});

async function fixtureStore(): Promise<InMemoryApplicationStore> {
  const store = new InMemoryApplicationStore(domainPolicies);
  for (const [id, username, role] of [[10, "author", "user"], [11, "other", "user"], [12, "owner", "admin"]] as const) {
    store.seedUser({
      id,
      username,
      passwordHash: await createPhpCompatiblePasswordHash("secret-password"),
      role,
      defaultDomainId: 2,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
  }
  return store;
}

function authService(store: InMemoryApplicationStore): AuthService {
  return new AuthService({
    authStore: store,
    sessions: new InMemorySessionStore(),
    clock: fixedClock,
    ipHashSecret: testConfig.ipHashSecret,
  });
}

function link(id: number, userId: number, code: string, title: string) {
  return {
    id: String(id),
    domainId: 2,
    code,
    userId,
    destination: `https://destination.example/${id}`,
    title,
    description: null,
    image: null,
    authorRole: "user",
    domainHostname: "vidx1x.local",
    domainLabel: "VIDX1X",
    diversionCampaign: "vidx1x",
    createdAt: new Date(`2026-08-${String(Math.min(id, 28)).padStart(2, "0")}T00:00:00Z`),
  } as const;
}

async function login(target: FastifyInstance, username = "author"): Promise<string> {
  const preAuth = await target.inject({ method: "GET", url: "/auth/csrf", headers: { host: "url6x.local" } });
  const preAuthCookies = preAuth.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const csrf = preAuth.json<{ csrf: string }>().csrf;
  const response = await target.inject({
    method: "POST",
    url: "/auth/login",
    headers: {
      host: "url6x.local",
      cookie: preAuthCookies,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({ username, password: "secret-password", csrf }).toString(),
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
