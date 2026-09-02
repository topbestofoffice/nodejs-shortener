import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApplication } from "../src/app.js";
import { AuthService } from "../src/modules/auth/service.js";
import { createPhpCompatiblePasswordHash } from "../src/modules/auth/passwords.js";
import { adminAssetVersion } from "../src/modules/admin/view.js";
import {
  dashboardCommunityStatsCacheKey,
  dashboardOwnStatsCacheKey,
} from "../src/modules/dashboard/history-service.js";
import { InMemoryApplicationStore, InMemorySessionStore } from "../src/testing/in-memory-store.js";
import { baseLink, domainPolicies, testConfig } from "./fixtures.js";

const now = new Date("2026-09-01T12:00:00.000Z");
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("Admin core HTTP parity", () => {
  it("is dashboard/admin-only, exposes all configured domains and does not read reporting eagerly", async () => {
    const fixture = await createFixture();
    const reportRead = vi.spyOn(fixture.store, "loadReportActivation");
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    const publicResponse = await app.inject({
      method: "GET",
      url: "/admin.php",
      headers: { host: "url6x.local" },
    });
    expect(publicResponse.statusCode).toBe(401);

    const ordinary = await authenticated(app, "author");
    const ordinaryResponse = await app.inject({
      method: "GET",
      url: "/admin.php",
      headers: { host: "url6x.local", cookie: ordinary.cookie },
    });
    expect(ordinaryResponse.statusCode).toBe(403);

    const admin = await authenticated(app, "owner");
    const response = await app.inject({
      method: "GET",
      url: "/admin.php?domain_id=3",
      headers: { host: "url6x.local", cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body).toContain(`src="/assets/admin.js?v=${adminAssetVersion}"`);
    expect(response.body).toContain(`href="/assets/admin.css?v=${adminAssetVersion}"`);
    expect(response.body).toContain('value="1">URL6X — url6x.local</option>');
    expect(response.body).toContain('value="2">VIDX1X — vidx1x.local</option>');
    expect(response.body).toContain('value="3" selected>Plays9X — plays9x.local</option>');
    expect(response.body).toContain('name="action" value="save_settings"');
    expect(response.body).toContain('name="action" value="save_geo"');
    expect(response.body).toContain('name="action" value="reset_sessions"');
    expect(response.body).toContain('name="action" value="load_diversion_history"');
    expect(response.body).toContain("No report loaded. Choose a period above to read it.");
    expect(reportRead).not.toHaveBeenCalled();

    const redirectHost = await app.inject({
      method: "GET",
      url: "/admin.php",
      headers: { host: "vidx1x.local", cookie: admin.cookie },
    });
    expect(redirectHost.statusCode).toBe(404);
  });

  it("shows an Admin link only for exact role=admin", async () => {
    const fixture = await createFixture();
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const ordinary = await authenticated(app, "author");
    const ordinaryDashboard = await app.inject({
      method: "GET",
      url: "/index.php",
      headers: { host: "url6x.local", cookie: ordinary.cookie },
    });
    expect(ordinaryDashboard.body).not.toContain('href="/admin.php"');

    const admin = await authenticated(app, "owner");
    const adminDashboard = await app.inject({
      method: "GET",
      url: "/index.php",
      headers: { host: "url6x.local", cookie: admin.cookie },
    });
    expect(adminDashboard.statusCode).toBe(200);
    expect(adminDashboard.body).toContain('<a class="button quiet" href="/admin.php">Admin panel</a>');
  });

  it("validates domain and CSRF before saving skim settings, then uses 303 PRG", async () => {
    const fixture = await createFixture();
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const admin = await authenticated(app, "owner");

    const invalidCsrf = await postAdmin(app, admin.cookie, {
      csrf: "0".repeat(64),
      action: "save_settings",
      domain_id: "2",
      skim_enabled: "1",
      skim_destination_url: "https://landing.example/path",
      skim_default_percent: "30",
    });
    expect(invalidCsrf.statusCode).toBe(403);

    const wrongDomain = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf,
      action: "save_settings",
      domain_id: "999",
      skim_enabled: "1",
      skim_destination_url: "https://landing.example/path",
      skim_default_percent: "30",
    });
    expect(wrongDomain.statusCode).toBe(400);

    const cacheKeys = [
      "skim_enabled",
      "skim_destination_url",
      "skim_default_percent",
    ].map((key) => `${testConfig.appNamespace}:domain:2:set:${key}`);
    for (const key of cacheKeys) await fixture.store.set(key, "stale", 60);
    const saved = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf,
      action: "save_settings",
      domain_id: "2",
      skim_enabled: "1",
      skim_destination_url: "https://landing.example/path",
      skim_default_percent: "30",
    });
    expect(saved.statusCode, saved.body).toBe(303);
    expect(saved.headers.location).toBe("/admin.php?domain_id=2&notice=settings_saved");
    await expect(fixture.store.loadDomainState(2)).resolves.toMatchObject({
      skim: { enabled: true, destinationUrl: "https://landing.example/path", defaultPercent: 30 },
    });
    for (const key of cacheKeys) await expect(fixture.store.get(key)).resolves.toBeNull();
  });

  it("reconstructs and commits country rules with Quality Control as one candidate", async () => {
    const fixture = await createFixture();
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const admin = await authenticated(app, "owner");

    const malformed = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf,
      action: "save_geo",
      domain_id: "2",
      quality_mode: "selected",
      geo_rows_complete: "1",
      "geo_rows[1][country]": "IN",
      "geo_rows[1][percent]": "20",
    });
    expect(malformed.statusCode).toBe(422);

    await fixture.store.set(`${testConfig.appNamespace}:domain:2:georules`, "stale", 60);
    const saved = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf,
      action: "save_geo",
      domain_id: "2",
      quality_mode: "selected",
      geo_rows_complete: "1",
      "geo_rows[0][country]": "in",
      "geo_rows[0][percent]": "25",
      "geo_rows[0][quality]": "1",
      "geo_rows[1][country]": "US",
      "geo_rows[1][percent]": "10",
    });
    expect(saved.statusCode, saved.body).toBe(303);
    await expect(fixture.store.loadDomainState(2)).resolves.toMatchObject({
      geoRules: [
        { countryCode: "IN", percent: 25 },
        { countryCode: "US", percent: 10 },
      ],
      qualityPolicy: { active: true, scope: "selected", countries: ["IN"] },
    });
    await expect(fixture.store.get(`${testConfig.appNamespace}:domain:2:georules`)).resolves.toBeNull();
  });

  it("adds only standard users with the existing password rule and toggles registration", async () => {
    const fixture = await createFixture();
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const admin = await authenticated(app, "owner");

    const shortPassword = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf,
      action: "add_user",
      domain_id: "2",
      new_username: "new-user",
      new_password: "short",
      new_password2: "short",
    });
    expect(shortPassword.statusCode).toBe(422);

    const added = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf,
      action: "add_user",
      domain_id: "2",
      new_username: "new-user",
      new_password: "long-password",
      new_password2: "long-password",
      role: "admin",
    });
    expect(added.statusCode).toBe(303);
    await expect(fixture.store.findUserByUsername("new-user")).resolves.toMatchObject({ role: "user" });

    await fixture.store.set(`${testConfig.appNamespace}:set:registration_enabled`, "v0", 60);
    const enabled = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf,
      action: "save_registration",
      domain_id: "2",
      registration_enabled: "1",
    });
    expect(enabled.statusCode).toBe(303);
    expect(fixture.store.registrationEnabled).toBe(true);
    await expect(fixture.store.get(`${testConfig.appNamespace}:set:registration_enabled`)).resolves.toBeNull();
  });

  it("deletes a locked regular user only without uploads and invalidates link, OG and dashboard caches", async () => {
    const fixture = await createFixture();
    fixture.store.seedLink({ ...baseLink, userId: 20, code: "Delete20" });
    const linkKey = `${testConfig.appNamespace}:domain:2:link:Delete20`;
    const ogKey = `${testConfig.appNamespace}:domain:2:og:Delete20`;
    const ownKey = dashboardOwnStatsCacheKey(testConfig.appNamespace, 20);
    const communityKey = dashboardCommunityStatsCacheKey(testConfig.appNamespace);
    for (const key of [linkKey, ogKey, ownKey, communityKey]) await fixture.store.set(key, "stale", 60);
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const admin = await authenticated(app, "owner");

    const protectedAdmin = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf, action: "delete_user", domain_id: "2", user_id: "1",
    });
    expect(protectedAdmin.statusCode).toBe(422);

    const deleted = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf, action: "delete_user", domain_id: "2", user_id: "20",
    });
    expect(deleted.statusCode).toBe(303);
    await expect(fixture.store.findUserById(20)).resolves.toBeNull();
    for (const key of [linkKey, ogKey, ownKey, communityKey]) {
      await expect(fixture.store.get(key)).resolves.toBeNull();
    }

    await fixture.store.registerReady({
      path: "uploads/1111111111111111.jpg",
      userId: 30,
      sessionScopeHash: "a".repeat(64),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 86_400_000),
    });
    const blocked = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf, action: "delete_user", domain_id: "2", user_id: "30",
    });
    expect(blocked.statusCode).toBe(409);
    await expect(fixture.store.findUserById(30)).resolves.not.toBeNull();
  });

  it("validates compact report range and domain, then loads truthful incomplete values through GET", async () => {
    const fixture = await createFixture();
    const activationRead = vi.spyOn(fixture.store, "loadReportActivation");
    const outcomeRead = vi.spyOn(fixture.store, "loadCountryOutcomeAggregates");
    app = await buildApplication({
      config: testConfig,
      stores: fixture.store,
      authService: fixture.auth,
      clock: { now: () => new Date(now) },
    });
    const admin = await authenticated(app, "owner");

    const missingRange = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf, action: "load_diversion_history", domain_id: "2",
    });
    expect(missingRange.statusCode).toBe(422);

    const invalidRange = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf, action: "load_diversion_history", domain_id: "2", history_range: "today",
    });
    expect(invalidRange.statusCode).toBe(422);

    const invalidDomain = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf, action: "load_diversion_history", domain_id: "999", history_range: "6h",
    });
    expect(invalidDomain.statusCode).toBe(400);

    const response = await postAdmin(app, admin.cookie, {
      csrf: admin.csrf, action: "load_diversion_history", domain_id: "2", history_range: "6h",
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/admin.php?domain_id=2&history_range=6h");
    const reportLocation = response.headers.location;
    if (reportLocation === undefined) throw new Error("Admin report redirect is missing.");
    expect(activationRead).not.toHaveBeenCalled();

    const report = await app.inject({
      method: "GET",
      url: reportLocation,
      headers: { host: "url6x.local", cookie: admin.cookie },
    });
    expect(report.statusCode, report.body).toBe(200);
    expect(report.body).toContain("Last 6 completed hours");
    expect(report.body).toContain('<span>Delivered</span><strong>N/A</strong>');
    expect(report.body).toContain('<span>Diverted</span><strong>Collecting</strong>');
    expect(report.body).toContain("No missing metric is shown as zero.");
    expect(report.body).toContain('name="history_range" value="6h" aria-pressed="true"');
    expect(activationRead).toHaveBeenCalledOnce();
    expect(outcomeRead).toHaveBeenCalledOnce();

    const malformedGet = await app.inject({
      method: "GET",
      url: "/admin.php?domain_id=2&history_range=6H",
      headers: { host: "url6x.local", cookie: admin.cookie },
    });
    expect(malformedGet.statusCode).toBe(400);
    expect(activationRead).toHaveBeenCalledOnce();
  });
});

async function createFixture(): Promise<{
  readonly store: InMemoryApplicationStore;
  readonly auth: AuthService;
}> {
  const store = new InMemoryApplicationStore(domainPolicies);
  store.seedUser({
    id: 1,
    username: "owner",
    passwordHash: await createPhpCompatiblePasswordHash("secret-password"),
    role: "admin",
    defaultDomainId: 2,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  store.seedUser({
    id: 10,
    username: "author",
    passwordHash: await createPhpCompatiblePasswordHash("secret-password"),
    role: "user",
    defaultDomainId: 2,
    createdAt: new Date("2026-01-02T00:00:00.000Z"),
  });
  for (const [id, username] of [[20, "delete-me"], [30, "has-upload"]] as const) {
    store.seedUser({
      id,
      username,
      passwordHash: await createPhpCompatiblePasswordHash("secret-password"),
      role: "user",
      defaultDomainId: 2,
      createdAt: new Date("2026-01-03T00:00:00.000Z"),
    });
  }
  return {
    store,
    auth: new AuthService({
      authStore: store,
      sessions: new InMemorySessionStore(),
      clock: { now: () => new Date(now) },
      ipHashSecret: testConfig.ipHashSecret,
    }),
  };
}

async function authenticated(
  target: FastifyInstance,
  username: string,
): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const preAuth = await target.inject({
    method: "GET", url: "/auth/csrf", headers: { host: "url6x.local" },
  });
  const preCookie = preAuth.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const login = await target.inject({
    method: "POST",
    url: "/auth/login",
    headers: {
      host: "url6x.local",
      cookie: preCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({
      username,
      password: "secret-password",
      csrf: preAuth.json<{ csrf: string }>().csrf,
    }).toString(),
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  const session = await target.inject({
    method: "GET", url: "/auth/session", headers: { host: "url6x.local", cookie },
  });
  return { cookie, csrf: session.json<{ csrf: string }>().csrf };
}

async function postAdmin(
  target: FastifyInstance,
  cookie: string,
  fields: Readonly<Record<string, string>>,
) {
  return target.inject({
    method: "POST",
    url: "/admin.php",
    headers: {
      host: "url6x.local",
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams(fields).toString(),
  });
}
