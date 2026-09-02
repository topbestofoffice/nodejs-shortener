import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../src/app.js";
import { DomainRegistry } from "../src/config/domain-registry.js";
import { AuthService } from "../src/modules/auth/service.js";
import { createPhpCompatiblePasswordHash } from "../src/modules/auth/passwords.js";
import { dashboardAssetVersion } from "../src/modules/dashboard/shell-view.js";
import { InMemoryApplicationStore, InMemorySessionStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("dashboard shell HTTP contract", () => {
  it.each(["/", "/index.php"])("serves the value-free public/login shell at %s", async (url) => {
    const fixture = await createFixture();
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    const response = await app.inject({ method: "GET", url, headers: { host: "url6x.local" } });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["permissions-policy"]).toContain("camera=()");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.body).toContain('id="loginForm"');
    expect(response.body).toContain('action="/auth/login"');
    expect(response.body).toContain(`href="/assets/dashboard-shell.css?v=${dashboardAssetVersion}"`);
    expect(response.body).toContain(`src="/assets/dashboard-shell.js?v=${dashboardAssetVersion}"`);
    expect(response.body).not.toMatch(/19K\+|2\.0M\+|281\.7K|26 Aug 2026/);
    expect(response.body).not.toContain("Traffic Shield");
    expect(response.body).not.toContain("Admin panel");
  });

  it("renders public registration only while the backend setting is enabled", async () => {
    const fixture = await createFixture({ registrationEnabled: true });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    const response = await app.inject({ method: "GET", url: "/", headers: { host: "url6x.local" } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('id="registerAuthTab"');
    expect(response.body).toContain('id="registrationForm"');
    expect(response.body).toContain('action="/auth/register"');
    expect(response.body).toContain('name="username"');
    expect(response.body).toContain('pattern="[A-Za-z0-9_.\\-]{3,64}"');
    expect(response.body).toContain('name="password"');
    expect(response.body).toContain('name="password2"');
    expect(response.body).toContain("8–72 UTF-8 bytes");
    expect(response.body).toContain("Create a standard user account");
    expect(response.body).not.toContain('name="role"');
    expect(response.body).not.toMatch(/create (?:an )?admin|administrator account/i);
  });

  it("omits the registration form when sign-up is disabled", async () => {
    const fixture = await createFixture({ registrationEnabled: false });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    const response = await app.inject({ method: "GET", url: "/index.php", headers: { host: "url6x.local" } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Sign-up is currently closed. Existing users can still sign in.");
    expect(response.body).not.toContain('id="registerAuthTab"');
    expect(response.body).not.toContain('id="registrationForm"');
    expect(response.body).not.toContain('action="/auth/register"');
  });

  it("fails the registration surface closed when its setting cannot be read", async () => {
    const fixture = await createFixture({ registrationEnabled: true, failRegistrationSetting: true });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    const response = await app.inject({ method: "GET", url: "/", headers: { host: "url6x.local" } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Sign-up status is temporarily unavailable. Existing users can still sign in.");
    expect(response.body).not.toContain('id="registerAuthTab"');
    expect(response.body).not.toContain('id="registrationForm"');
    expect(response.body).not.toContain('action="/auth/register"');
  });

  it("keeps redirect-only roots empty and hidden even when the shell is registered", async () => {
    const fixture = await createFixture({ registrationEnabled: true });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    for (const host of ["vidx1x.local", "plays9x.local"]) {
      for (const url of ["/", "/index.php"]) {
        const response = await app.inject({ method: "GET", url, headers: { host } });
        expect(response.statusCode, `${host}${url}`).toBe(404);
        expect(response.body, `${host}${url}`).toBe("");
        expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
      }
    }
  });

  it("renders the authenticated D2/D3 creator with the account default and no fake surfaces", async () => {
    const fixture = await createFixture({ defaultDomainId: 3 });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const cookies = await login(app);

    const response = await app.inject({
      method: "GET",
      url: "/index.php",
      headers: { host: "url6x.local", cookie: cookies },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("data-dashboard-shell");
    expect(response.body).toContain('data-preference-scope="account"');
    expect(response.body).toContain('data-max-bulk-links="100"');
    expect(response.body).toContain('data-max-bulk-images="100"');
    expect(response.body).toContain('id="singleLinkForm"');
    expect(response.body).toContain('id="bulkLinkForm"');
    expect(response.body).toContain('id="singleDomain"');
    expect(response.body).toContain('id="bulkDomain"');
    expect(response.body).toContain('data-set-default-domain');
    expect(response.body).toContain('data-domain-target="singleDomain"');
    expect(response.body).toContain('id="keepForNext"');
    expect(response.body).toContain("Keep title, description and image(s) for the next creation");
    expect(response.body).toContain('value="2">VIDX1X — vidx1x.local</option>');
    expect(response.body).toContain('value="3" selected>Plays9X — plays9x.local</option>');
    expect(response.body).not.toContain('option value="1"');
    expect(response.body).toContain('id="history-title">All short links');
    expect(response.body).toContain('id="historyQuery"');
    expect(response.body).toContain("Showing current database history for your account");
    expect(response.body).toContain('id="shieldBell"');
    expect(response.body).toContain('id="shieldPanel"');
    expect(response.body).toContain('data-shield-date="');
    expect(response.body).toContain("Traffic Protection");
    expect(response.body).not.toContain("Admin panel");
  });

  it("renders the exact configured bulk limits into the authenticated client contract", async () => {
    const fixture = await createFixture();
    app = await buildApplication({
      config: {
        ...testConfig,
        links: { ...testConfig.links, maxBulkLinks: 17, maxBulkImages: 19 },
      },
      stores: fixture.store,
      authService: fixture.auth,
    });
    const cookies = await login(app);

    const response = await app.inject({
      method: "GET",
      url: "/index.php",
      headers: { host: "url6x.local", cookie: cookies },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-max-bulk-links="17"');
    expect(response.body).toContain('data-max-bulk-images="19"');
    expect(response.body).toContain("Destination URLs <span>— up to 17, one per line</span>");
    expect(response.body).toContain("Add images <span>— up to 19, uploaded one at a time</span>");
  });

  it("escapes account-controlled text in the authenticated document", async () => {
    const fixture = await createFixture({ username: "author<script>" });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const cookies = await login(app, "author<script>");

    const response = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "url6x.local", cookie: cookies },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("author&lt;script&gt;");
    expect(response.body).not.toContain("author<script>");
  });

  it("allows and renders only explicitly configured privacy-bounded dashboard analytics", async () => {
    const fixture = await createFixture();
    app = await buildApplication({
      config: {
        ...testConfig,
        analytics: { enabled: true, measurementId: "G-ABC123", siteKey: "shortener_pilot" },
      },
      stores: fixture.store,
      authService: fixture.auth,
    });
    const publicResponse = await app.inject({ method: "GET", url: "/", headers: { host: "url6x.local" } });
    expect(publicResponse.headers["content-security-policy"]).not.toContain("googletagmanager.com");
    const cookies = await login(app);

    const response = await app.inject({
      method: "GET",
      url: "/index.php",
      headers: { host: "url6x.local", cookie: cookies },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-analytics-enabled="1"');
    expect(response.body).toContain('data-analytics-id="G-ABC123"');
    expect(response.body).toContain('data-analytics-site-key="shortener_pilot"');
    expect(response.headers["content-security-policy"]).toContain("script-src 'self' https://www.googletagmanager.com");
    expect(response.headers["content-security-policy"]).toContain("connect-src 'self' https://www.google-analytics.com");
  });

  it("serves scoped assets with explicit development and production cache policies", async () => {
    const fixture = await createFixture();
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    const css = await app.inject({ method: "GET", url: `/assets/dashboard-shell.css?v=${dashboardAssetVersion}`, headers: { host: "url6x.local" } });
    const js = await app.inject({ method: "GET", url: `/assets/dashboard-shell.js?v=${dashboardAssetVersion}`, headers: { host: "url6x.local" } });
    const redirectAsset = await app.inject({ method: "GET", url: "/assets/dashboard-shell.css", headers: { host: "plays9x.local" } });

    expect(css.statusCode).toBe(200);
    expect(css.headers["cache-control"]).toBe("no-store, max-age=0");
    expect(css.headers.etag).toBeDefined();
    expect(css.headers["x-content-type-options"]).toBe("nosniff");
    expect(js.statusCode).toBe(200);
    expect(js.body).toContain('return failed === 0 ? "success" : "partial"');
    expect(js.body).toContain('"Source: "');
    expect(js.body).toContain('"Medium: "');
    expect(js.body).toContain('data.failure_code === "image_processor_busy"');
    expect(js.body).toContain('fetch("/auth/csrf"');
    expect(js.body).toContain('fetch("/auth/register"');
    expect(js.body).toContain("do not create the account again");
    expect(js.body).toContain('body.append("action", "shield_stats")');
    expect(js.body).toContain("formatShieldCounter");
    expect(js.body).not.toContain('body.set("role"');
    expect(redirectAsset.statusCode).toBe(404);
    await app.close();

    const productionConfig = { ...testConfig, environment: "production" as const };
    app = await buildApplication({ config: productionConfig, stores: fixture.store, authService: fixture.auth });
    const productionAsset = await app.inject({
      method: "GET",
      url: `/assets/dashboard-shell.css?v=${dashboardAssetVersion}`,
      headers: { host: "url6x.local" },
    });
    expect(productionAsset.statusCode).toBe(200);
    expect(productionAsset.headers["cache-control"]).toBe("public, max-age=300, must-revalidate");
  });

  it("serves dashboard assets without restoring an authenticated session", async () => {
    const fixture = await createFixture();
    const getSession = vi.spyOn(fixture.auth, "getSession").mockRejectedValue(new Error("must not run"));
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const signed = fixture.auth.signSessionId("asset-session", testConfig.cookieSigningSecret);

    const response = await app.inject({
      method: "GET",
      url: `/assets/dashboard-shell.js?v=${dashboardAssetVersion}`,
      headers: { host: "url6x.local", cookie: `node_shortener_session=${signed}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("javascript");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("does not add another dashboard document route", async () => {
    const fixture = await createFixture();
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    const response = await app.inject({ method: "GET", url: "/dashboard.html", headers: { host: "url6x.local" } });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("data-dashboard-shell");
    expect(response.body).not.toContain('id="loginForm"');
  });

  it("keeps the same shell functional for a single creatable dashboard domain", async () => {
    const registry = new DomainRegistry([{
      id: 1,
      key: "shortener",
      canonicalHost: "short.example.com",
      aliases: ["www.short.example.com"],
      label: "Shortener",
      surface: "dashboard",
      active: true,
      allowCreate: true,
      publicBaseUrl: "https://short.example.com",
      imageBaseUrl: "https://short.example.com",
      emitLocalImageAlt: false,
    }]);
    const store = new InMemoryApplicationStore([{
      id: 1,
      domainKey: "shortener",
      hostname: "short.example.com",
      label: "Shortener",
      surface: "dashboard",
      active: true,
      allowCreate: true,
      diversionCampaign: "shortener",
      reportTimezone: "UTC",
    }]);
    store.seedUser({
      id: 10,
      username: "author",
      passwordHash: await createPhpCompatiblePasswordHash("secret-password"),
      role: "user",
      defaultDomainId: 1,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const auth = new AuthService({
      authStore: store,
      sessions: new InMemorySessionStore(),
      clock: { now: () => new Date("2026-09-01T12:00:00Z") },
      ipHashSecret: testConfig.ipHashSecret,
    });
    app = await buildApplication({ config: { ...testConfig, registry }, stores: store, authService: auth });
    const cookies = await login(app, "author", "short.example.com");

    const response = await app.inject({ method: "GET", url: "/", headers: { host: "short.example.com", cookie: cookies } });

    expect(response.statusCode).toBe(200);
    expect(response.body.match(/value="1" selected>Shortener — short\.example\.com<\/option>/g)).toHaveLength(2);
    expect(response.body).toContain('class="domain-chevron"');
  });

  it("selects the configured creation fallback even when it is second and has an arbitrary id", async () => {
    const definitions = [{
      id: 91,
      key: "control",
      canonicalHost: "manage.example.com",
      aliases: [],
      label: "Control",
      surface: "dashboard" as const,
      active: true,
      allowCreate: true,
      publicBaseUrl: "https://manage.example.com",
      imageBaseUrl: "https://manage.example.com",
    }, {
      id: 73,
      key: "fallback",
      canonicalHost: "go.example.com",
      aliases: [],
      label: "Fallback",
      surface: "redirect" as const,
      active: true,
      allowCreate: true,
      creationFallback: true,
      publicBaseUrl: "https://go.example.com",
      imageBaseUrl: "https://go.example.com",
    }];
    const registry = new DomainRegistry(definitions);
    const store = new InMemoryApplicationStore(definitions.map((definition) => ({
      id: definition.id,
      domainKey: definition.key,
      hostname: definition.canonicalHost,
      label: definition.label,
      surface: definition.surface,
      active: definition.active,
      allowCreate: definition.allowCreate,
      diversionCampaign: definition.key,
      reportTimezone: "UTC" as const,
    })));
    store.seedUser({
      id: 10,
      username: "author",
      passwordHash: await createPhpCompatiblePasswordHash("secret-password"),
      role: "user",
      defaultDomainId: 404,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const auth = new AuthService({
      authStore: store,
      sessions: new InMemorySessionStore(),
      clock: { now: () => new Date("2026-09-01T12:00:00Z") },
      ipHashSecret: testConfig.ipHashSecret,
    });
    app = await buildApplication({ config: { ...testConfig, registry }, stores: store, authService: auth });
    const cookies = await login(app, "author", "manage.example.com");

    const response = await app.inject({
      method: "GET",
      url: "/index.php",
      headers: { host: "manage.example.com", cookie: cookies },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data-default-domain-id="73"');
    expect(response.body.match(/value="73" selected>Fallback — go\.example\.com/g)).toHaveLength(2);
    expect(response.body).not.toContain('value="91" selected>Control');
  });
});

async function createFixture(overrides: {
  readonly username?: string;
  readonly defaultDomainId?: number;
  readonly registrationEnabled?: boolean;
  readonly failRegistrationSetting?: boolean;
} = {}): Promise<{
  readonly store: InMemoryApplicationStore;
  readonly auth: AuthService;
}> {
  const store = new InMemoryApplicationStore(domainPolicies);
  store.registrationEnabled = overrides.registrationEnabled ?? false;
  store.failRegistrationSetting = overrides.failRegistrationSetting ?? false;
  store.seedUser({
    id: 10,
    username: overrides.username ?? "author",
    passwordHash: await createPhpCompatiblePasswordHash("secret-password"),
    role: "user",
    defaultDomainId: overrides.defaultDomainId ?? 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  return {
    store,
    auth: new AuthService({
      authStore: store,
      sessions: new InMemorySessionStore(),
      clock: { now: () => new Date("2026-09-01T12:00:00Z") },
      ipHashSecret: testConfig.ipHashSecret,
    }),
  };
}

async function login(target: FastifyInstance, username = "author", host = "url6x.local"): Promise<string> {
  const preAuth = await target.inject({ method: "GET", url: "/auth/csrf", headers: { host } });
  expect(preAuth.statusCode).toBe(200);
  const preAuthCookies = preAuth.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const csrf = preAuth.json<{ csrf: string }>().csrf;
  const body = new URLSearchParams({ username, password: "secret-password", csrf });
  const response = await target.inject({
    method: "POST",
    url: "/auth/login",
    headers: {
      host,
      cookie: preAuthCookies,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: body.toString(),
  });
  expect(response.statusCode).toBe(200);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}
