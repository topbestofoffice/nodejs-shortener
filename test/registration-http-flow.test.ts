import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApplication } from "../src/app.js";
import type { SessionData } from "../src/core/types.js";
import { verifyPhpPassword } from "../src/modules/auth/passwords.js";
import { AuthService } from "../src/modules/auth/service.js";
import type { SessionStore } from "../src/ports.js";
import { InMemoryApplicationStore, InMemorySessionStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

const now = new Date("2026-08-23T12:00:00.000Z");
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("public registration HTTP parity", () => {
  it("requires dashboard pre-auth CSRF before enablement or attempt bookkeeping", async () => {
    const fixture = createFixture();
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    const missingCsrf = await register(app, { username: "new-user" });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.body).toBe("Your session expired — please try again.\n");

    const ipHash = hashedLoopbackIp();
    expect(await fixture.store.authFailureCount(ipHash, "register", new Date(0))).toBe(0);

    const preAuth = await issuePreAuth(app);
    const closed = await register(app, { username: "new-user", ...preAuth });
    expect(closed.statusCode).toBe(403);
    expect(closed.body).toBe("Sign-up is currently closed.\n");
    expect(await fixture.store.authFailureCount(ipHash, "register", new Date(0))).toBe(0);
  });

  it("creates a case-preserving user, forces role=user, and establishes auth cookies", async () => {
    const fixture = createFixture({ enabled: true });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const preAuth = await issuePreAuth(app);

    const response = await register(app, {
      username: "  New.User  ",
      password: "correct-password",
      password2: "correct-password",
      role: "admin",
      ...preAuth,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "authenticated",
      login_required: false,
      user: { username: "New.User", role: "user" },
    });
    expect(response.body).not.toContain("passwordHash");
    expect(response.cookies.some((cookie) => cookie.name === "node_shortener_session")).toBe(true);
    expect(response.cookies.some((cookie) => cookie.name === "fs_remember")).toBe(true);

    const created = await fixture.store.findUserByUsername("New.User");
    expect(created).toMatchObject({ username: "New.User", role: "user", defaultDomainId: null });
    await expect(verifyPhpPassword("correct-password", created?.passwordHash ?? "")).resolves.toBe(true);
    expect(await fixture.store.findUserByUsername("new.user")).toBeNull();

    const cookies = response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const session = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { host: "url6x.local", cookie: cookies },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ ok: true, user: { username: "New.User", role: "user" } });

    expect(await fixture.store.authFailureCount(hashedLoopbackIp(), "register", new Date(0))).toBe(1);
    expect(await fixture.store.authFailureCount("127.0.0.1", "register", new Date(0))).toBe(0);
  });

  it("records each genuine attempt before validation and blocks only attempt six", async () => {
    const fixture = createFixture({ enabled: true });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const preAuth = await issuePreAuth(app);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await register(app, { username: "x", ...preAuth });
      expect(response.statusCode, `attempt ${attempt}`).toBe(422);
      expect(response.body).toContain("Username must be 3–64 characters");
    }
    const blocked = await register(app, { username: "valid-user", ...preAuth });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toBe("Too many sign-up attempts. Please try again later.\n");
    expect(await fixture.store.authFailureCount(hashedLoopbackIp(), "register", new Date(0))).toBe(5);
  });

  it("keeps throttle reads and writes fail-open", async () => {
    const fixture = createFixture({ enabled: true });
    fixture.store.failAuthFailureCount = true;
    fixture.store.failRecordAuthFailure = true;
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const preAuth = await issuePreAuth(app);

    const response = await register(app, { username: "fail-open-user", ...preAuth });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: "authenticated", user: { username: "fail-open-user" } });
  });

  it("keeps usernames case-sensitive and lets the UNIQUE backstop reject the exact duplicate", async () => {
    const fixture = createFixture({ enabled: true });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    const first = await register(app, { username: "CaseUser", ...await issuePreAuth(app) });
    const second = await register(app, { username: "caseuser", ...await issuePreAuth(app) });
    const duplicate = await register(app, { username: "CaseUser", ...await issuePreAuth(app) });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toBe("That username is taken — please choose another.\n");
    expect(await fixture.store.findUserByUsername("CaseUser")).not.toBeNull();
    expect(await fixture.store.findUserByUsername("caseuser")).not.toBeNull();
  });

  it("reports account_created/login_required when session persistence fails after INSERT", async () => {
    const fixture = createFixture({ enabled: true, sessions: new FailingSessionStore() });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });
    const preAuth = await issuePreAuth(app);

    const response = await register(app, { username: "committed-user", ...preAuth });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      ok: true,
      status: "account_created",
      login_required: true,
      user: { id: 1, username: "committed-user", role: "user" },
    });
    expect(await fixture.store.findUserByUsername("committed-user")).not.toBeNull();
    expect(response.cookies.some((cookie) =>
      (cookie.name === "node_shortener_session" || cookie.name === "fs_remember")
      && cookie.value.length > 0)).toBe(false);
    expect(response.body).not.toContain("try again");
  });

  it("hides registration storage errors and fails closed when the enable switch is unreadable", async () => {
    const insertFailure = createFixture({ enabled: true });
    insertFailure.store.failCreateUser = true;
    app = await buildApplication({ config: testConfig, stores: insertFailure.store, authService: insertFailure.auth });
    const failedInsert = await register(app, { username: "storage-user", ...await issuePreAuth(app) });
    expect(failedInsert.statusCode).toBe(503);
    expect(failedInsert.body).toBe("Could not create your account. Please try again.\n");
    expect(failedInsert.body).not.toContain("Injected");
    await app.close();

    const settingFailure = createFixture({ enabled: true });
    settingFailure.store.failRegistrationSetting = true;
    app = await buildApplication({ config: testConfig, stores: settingFailure.store, authService: settingFailure.auth });
    const failedSetting = await register(app, { username: "setting-user", ...await issuePreAuth(app) });
    expect(failedSetting.statusCode).toBe(503);
    expect(failedSetting.body).toBe("Sign-up is temporarily unavailable. Please try again later.\n");
    expect(failedSetting.body).not.toContain("Injected");
    expect(await settingFailure.store.authFailureCount(hashedLoopbackIp(), "register", new Date(0))).toBe(0);
  });

  it.each(["vidx1x.local", "plays9x.local"])("keeps redirect-only host %s away from registration", async (host) => {
    const fixture = createFixture({ enabled: true });
    app = await buildApplication({ config: testConfig, stores: fixture.store, authService: fixture.auth });

    const response = await register(app, { host, username: "hidden-user" });

    expect(response.statusCode).toBe(404);
    expect(await fixture.store.findUserByUsername("hidden-user")).toBeNull();
  });
});

function createFixture(options: {
  readonly enabled?: boolean;
  readonly sessions?: SessionStore;
} = {}): { store: InMemoryApplicationStore; auth: AuthService } {
  const store = new InMemoryApplicationStore(domainPolicies);
  store.registrationEnabled = options.enabled ?? false;
  return {
    store,
    auth: new AuthService({
      authStore: store,
      sessions: options.sessions ?? new InMemorySessionStore(),
      clock: { now: () => new Date(now) },
      ipHashSecret: testConfig.ipHashSecret,
      sessionTtlSeconds: 3_600,
    }),
  };
}

async function issuePreAuth(target: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const response = await target.inject({
    method: "GET",
    url: "/auth/csrf",
    headers: { host: "url6x.local" },
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    csrf: response.json<{ csrf: string }>().csrf,
  };
}

async function register(target: FastifyInstance, options: {
  readonly host?: string;
  readonly cookie?: string;
  readonly csrf?: string;
  readonly username?: string;
  readonly password?: string;
  readonly password2?: string;
  readonly role?: string;
}) {
  const form = new URLSearchParams();
  if (options.csrf !== undefined) form.set("csrf", options.csrf);
  if (options.username !== undefined) form.set("username", options.username);
  form.set("password", options.password ?? "password");
  form.set("password2", options.password2 ?? options.password ?? "password");
  if (options.role !== undefined) form.set("role", options.role);
  return target.inject({
    method: "POST",
    url: "/auth/register",
    headers: {
      host: options.host ?? "url6x.local",
      "content-type": "application/x-www-form-urlencoded",
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    payload: form.toString(),
  });
}

function hashedLoopbackIp(): string {
  return createHash("sha256")
    .update(`127.0.0.1|${testConfig.ipHashSecret}`)
    .digest("hex");
}

class FailingSessionStore implements SessionStore {
  public async get(_sessionId: string): Promise<SessionData | null> {
    return null;
  }

  public async set(_session: SessionData, _ttlSeconds: number): Promise<void> {
    throw new Error("Injected session persistence failure");
  }

  public async delete(_sessionId: string): Promise<void> {
    // Nothing was stored.
  }
}
