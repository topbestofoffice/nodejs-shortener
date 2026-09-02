import { createHash } from "node:crypto";
import { hash as hashArgon2 } from "@node-rs/argon2";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApplication } from "../src/app.js";
import { AppError } from "../src/core/errors.js";
import type { RememberTokenRecord, SessionData, UserRecord } from "../src/core/types.js";
import { assertCsrf } from "../src/modules/auth/http.js";
import {
  createPhpCompatiblePasswordHash,
  invalidLoginPasswordHash,
  verifyPhpPassword,
} from "../src/modules/auth/passwords.js";
import { AuthService } from "../src/modules/auth/service.js";
import type { AuthStore, SessionStore } from "../src/ports.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

const now = new Date("2026-08-23T12:00:00.000Z");
const validSelector = "a".repeat(24);
const validValidator = "b".repeat(64);
let phpPasswordHash = "";
let app: FastifyInstance | undefined;

beforeAll(async () => {
  phpPasswordHash = await createPhpCompatiblePasswordHash("secret-password");
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("AuthService failure-safe session and remember-token behavior", () => {
  it("runs the same password-verifier boundary for an unknown username", async () => {
    const observed: Array<{ readonly password: string; readonly hash: string }> = [];
    const fixture = createServiceFixture({
      seedUser: false,
      verifyPassword: async (password, hash) => {
        observed.push({ password, hash });
        return false;
      },
    });

    await expect(fixture.service.login("missing-user", "candidate", "203.0.113.10"))
      .rejects.toMatchObject({ statusCode: 401, code: "INVALID_LOGIN" });
    expect(observed).toEqual([{ password: "candidate", hash: invalidLoginPasswordHash }]);
  });

  it("throttles an IP after twenty recent failures without checking credentials again", async () => {
    const fixture = createServiceFixture();
    const ip = "203.0.113.10";
    const ipHash = sha256(`${ip}|${testConfig.ipHashSecret}`);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await fixture.auth.recordAuthFailure(ipHash, "login_fail", new Date(now.getTime() - attempt * 1_000));
    }

    await expect(fixture.service.login("author", "secret-password", ip)).rejects.toMatchObject({
      statusCode: 429,
      code: "LOGIN_THROTTLED",
    });
    expect(fixture.sessions.setCalls).toHaveLength(0);
    expect(fixture.auth.createdSelectors).toHaveLength(0);
  });

  it("keeps PHP's fail-open throttle bookkeeping contract", async () => {
    const lookupFailure = createServiceFixture();
    lookupFailure.auth.failFailureCount = new Error("throttle read unavailable");
    await expect(lookupFailure.service.login("author", "secret-password", "203.0.113.10"))
      .resolves.toMatchObject({ user: { username: "author" } });

    const writeFailure = createServiceFixture();
    writeFailure.auth.failRecordFailure = new Error("throttle write unavailable");
    await expect(writeFailure.service.login("author", "wrong", "203.0.113.10"))
      .rejects.toMatchObject({ statusCode: 401, code: "INVALID_LOGIN" });
  });

  it("keeps the password-authenticated session when remember-token creation fails", async () => {
    const fixture = createServiceFixture();
    fixture.auth.failCreateRemember = new Error("remember storage unavailable");

    const authenticated = await fixture.service.login("  author  ", "secret-password", "203.0.113.10");

    expect(authenticated.user.username).toBe("author");
    expect(authenticated.session.rememberSelector).toBeNull();
    expect(authenticated.rememberCookie).toBeNull();
    expect(fixture.sessions.setCalls).toHaveLength(1);
    expect(fixture.sessions.has(authenticated.session.id)).toBe(true);
  });

  it("removes a just-created remember token if the session update cannot persist its selector", async () => {
    const fixture = createServiceFixture();
    fixture.sessions.failOnSetCall = 2;

    const authenticated = await fixture.service.login("author", "secret-password", "203.0.113.10");
    const createdSelector = fixture.auth.createdSelectors[0];

    expect(createdSelector).toMatch(/^[a-f0-9]{24}$/);
    expect(fixture.auth.deletedSelectors).toEqual([createdSelector]);
    expect(fixture.auth.rememberToken(createdSelector ?? "")).toBeNull();
    expect(authenticated.session.rememberSelector).toBeNull();
    expect(authenticated.rememberCookie).toBeNull();
    expect(fixture.sessions.has(authenticated.session.id)).toBe(true);
  });

  it("fails closed before creating a session when atomic remember rotation is unavailable", async () => {
    const fixture = createServiceFixture();
    fixture.auth.seedRemember({
      id: "remember-1",
      userId: 10,
      selector: validSelector,
      validatorHash: sha256(validValidator),
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    fixture.auth.failRotateRemember = new Error("rotation unavailable");

    await expect(fixture.service.restoreRemember(`${validSelector}:${validValidator}`))
      .rejects.toThrow("rotation unavailable");

    expect(fixture.sessions.setCalls).toHaveLength(0);
    expect(fixture.auth.rememberToken(validSelector)?.validatorHash).toBe(sha256(validValidator));
  });

  it("rotates a valid remember token and rejects the superseded validator", async () => {
    const fixture = createServiceFixture();
    fixture.auth.seedRemember({
      id: "remember-1",
      userId: 10,
      selector: validSelector,
      validatorHash: sha256(validValidator),
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const restored = await fixture.service.restoreRemember(`${validSelector}:${validValidator}`);

    expect(restored?.rememberCookie).toMatch(new RegExp(`^${validSelector}:[a-f0-9]{64}$`));
    expect(fixture.auth.rememberToken(validSelector)?.validatorHash).not.toBe(sha256(validValidator));

    await expect(fixture.service.restoreRemember(`${validSelector}:${validValidator}`)).resolves.toBeNull();
    expect(fixture.auth.deletedSelectors).toContain(validSelector);
  });

  it("rejects malformed, expired, mismatched, and orphaned remember cookies with bounded cleanup", async () => {
    const malformed = createServiceFixture();
    await expect(malformed.service.restoreRemember("not-a-valid-cookie")).resolves.toBeNull();
    expect(malformed.auth.rememberLookups).toBe(0);
    expect(malformed.auth.deletedSelectors).toEqual([]);

    const expired = createServiceFixture();
    expired.auth.seedRemember({
      id: "expired",
      userId: 10,
      selector: validSelector,
      validatorHash: sha256(validValidator),
      expiresAt: new Date("2026-08-23T11:59:59.000Z"),
    });
    await expect(expired.service.restoreRemember(`${validSelector}:${validValidator}`)).resolves.toBeNull();
    expect(expired.auth.deletedSelectors).toEqual([validSelector]);

    const mismatch = createServiceFixture();
    mismatch.auth.seedRemember({
      id: "mismatch",
      userId: 10,
      selector: validSelector,
      validatorHash: sha256(validValidator),
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    mismatch.auth.failDeleteRemember = new Error("cleanup unavailable");
    await expect(mismatch.service.restoreRemember(`${validSelector}:${"c".repeat(64)}`)).resolves.toBeNull();
    expect(mismatch.auth.deletedSelectors).toEqual([validSelector]);

    const orphaned = createServiceFixture({ seedUser: false });
    orphaned.auth.seedRemember({
      id: "orphaned",
      userId: 999,
      selector: validSelector,
      validatorHash: sha256(validValidator),
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    await expect(orphaned.service.restoreRemember(`${validSelector}:${validValidator}`)).resolves.toBeNull();
    expect(orphaned.auth.deletedSelectors).toEqual([validSelector]);
  });

  it("rejects expired, auth-epoch-stale, and user-orphaned sessions", async () => {
    const expired = createServiceFixture();
    const expiredSession = makeSession({ expiresAt: "2026-08-23T12:00:00.000Z" });
    expired.sessions.seed(expiredSession);
    await expect(expired.service.getSession(expiredSession.id)).resolves.toBeNull();

    const stale = createServiceFixture();
    stale.auth.authEpoch = 2;
    const staleSession = makeSession({ authEpoch: 1 });
    stale.sessions.seed(staleSession);
    await expect(stale.service.getSession(staleSession.id)).resolves.toBeNull();
    expect(stale.sessions.deletedIds).toEqual([staleSession.id]);

    const orphaned = createServiceFixture({ seedUser: false });
    const orphanedSession = makeSession();
    orphaned.sessions.seed(orphanedSession);
    await expect(orphaned.service.getSession(orphanedSession.id)).resolves.toBeNull();
    expect(orphaned.sessions.deletedIds).toEqual([orphanedSession.id]);
  });

  it("revokes the session even when remember-token deletion fails, then reports the incomplete logout", async () => {
    const fixture = createServiceFixture();
    const session = makeSession({ rememberSelector: validSelector });
    fixture.sessions.seed(session);
    fixture.auth.seedRemember({
      id: "remember-logout",
      userId: session.userId,
      selector: validSelector,
      validatorHash: sha256(validValidator),
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    fixture.auth.failDeleteRemember = new Error("cleanup unavailable");

    await expect(fixture.service.logout(session)).rejects.toMatchObject({
      statusCode: 503,
      code: "LOGOUT_REVOCATION_INCOMPLETE",
    });

    expect(fixture.sessions.has(session.id)).toBe(false);
    expect(fixture.auth.deletedSelectors).toEqual([validSelector]);
    expect(fixture.auth.rememberToken(validSelector)).not.toBeNull();
  });

  it("revokes the remember token even when session deletion fails, then reports the incomplete logout", async () => {
    const fixture = createServiceFixture();
    const session = makeSession({ rememberSelector: validSelector });
    fixture.sessions.seed(session);
    fixture.auth.seedRemember({
      id: "remember-logout",
      userId: session.userId,
      selector: validSelector,
      validatorHash: sha256(validValidator),
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    fixture.sessions.failDelete = new Error("session store unavailable");

    await expect(fixture.service.logout(session)).rejects.toMatchObject({
      statusCode: 503,
      code: "LOGOUT_REVOCATION_INCOMPLETE",
    });

    expect(fixture.sessions.deletedIds).toEqual([session.id]);
    expect(fixture.sessions.has(session.id)).toBe(true);
    expect(fixture.auth.deletedSelectors).toEqual([validSelector]);
    expect(fixture.auth.rememberToken(validSelector)).toBeNull();
  });
});

describe("auth HTTP cookie and CSRF boundaries", () => {
  it("keeps the session cookie browser-scoped while remember remains persistent", async () => {
    const fixture = createServiceFixture();
    app = await buildApplication({
      config: testConfig,
      stores: new InMemoryApplicationStore(domainPolicies),
      authService: fixture.service,
    });

    const login = await loginThroughHttp(app);
    const session = login.cookies.find((item) => item.name === "node_shortener_session");
    const remember = login.cookies.find((item) => item.name === "fs_remember");

    expect(session).toBeDefined();
    expect(session?.maxAge).toBeUndefined();
    expect(session?.expires).toBeUndefined();
    expect(remember?.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it("restores a session from a valid remember cookie and returns rotated auth cookies", async () => {
    const fixture = createServiceFixture();
    app = await buildApplication({
      config: testConfig,
      stores: new InMemoryApplicationStore(domainPolicies),
      authService: fixture.service,
    });
    const login = await loginThroughHttp(app);
    const originalRemember = login.cookies.find((item) => item.name === "fs_remember");
    expect(originalRemember).toBeDefined();

    const restored = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: {
        host: "url6x.local",
        cookie: `fs_remember=${originalRemember?.value ?? ""}`,
      },
    });
    const rotatedRemember = restored.cookies.find((item) => item.name === "fs_remember");

    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ ok: true, user: { username: "author" } });
    expect(restored.cookies.some((item) => item.name === "node_shortener_session")).toBe(true);
    expect(rotatedRemember?.value).toMatch(/^[a-f0-9]{24}:[a-f0-9]{64}$/);
    expect(rotatedRemember?.value).not.toBe(originalRemember?.value);
  });

  it("treats tampered session and malformed remember cookies as unauthenticated and clears both", async () => {
    const fixture = createServiceFixture();
    app = await buildApplication({
      config: testConfig,
      stores: new InMemoryApplicationStore(domainPolicies),
      authService: fixture.service,
    });

    const response = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: {
        host: "url6x.local",
        cookie: "node_shortener_session=tampered; fs_remember=malformed",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(clearedCookieNames(response.headers["set-cookie"])).toEqual([
      "fs_remember",
      "node_shortener_session",
    ]);
    expect(fixture.auth.rememberLookups).toBe(0);
  });

  it("rejects missing and mismatched form CSRF values, then accepts the exact token once", async () => {
    const fixture = createServiceFixture();
    app = await buildApplication({
      config: testConfig,
      stores: new InMemoryApplicationStore(domainPolicies),
      authService: fixture.service,
    });
    const login = await loginThroughHttp(app);
    const csrf = login.json<{ csrf: string }>().csrf;
    const cookies = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");

    const missing = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { host: "url6x.local", cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: "",
    });
    const mismatched = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { host: "url6x.local", cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: `csrf=${"f".repeat(64)}`,
    });
    const accepted = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { host: "url6x.local", cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: `csrf=${csrf}`,
    });

    expect(missing.statusCode).toBe(403);
    expect(mismatched.statusCode).toBe(403);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ ok: true });
    expect(clearedCookieNames(accepted.headers["set-cookie"])).toEqual([
      "fs_remember",
      "node_shortener_session",
    ]);
  });

  it("clears browser cookies even if server-side session deletion fails during logout", async () => {
    const fixture = createServiceFixture();
    app = await buildApplication({
      config: testConfig,
      stores: new InMemoryApplicationStore(domainPolicies),
      authService: fixture.service,
    });
    const login = await loginThroughHttp(app);
    const csrf = login.json<{ csrf: string }>().csrf;
    const cookies = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    fixture.sessions.failDelete = new Error("session store unavailable");

    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { host: "url6x.local", cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: `csrf=${csrf}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe("Server-side sign-out cleanup is temporarily incomplete.\n");
    expect(clearedCookieNames(response.headers["set-cookie"])).toEqual([
      "fs_remember",
      "node_shortener_session",
    ]);
    expect(fixture.auth.deletedSelectors).toHaveLength(1);
  });

  it("clears browser cookies if remember-token deletion fails after session revocation", async () => {
    const fixture = createServiceFixture();
    app = await buildApplication({
      config: testConfig,
      stores: new InMemoryApplicationStore(domainPolicies),
      authService: fixture.service,
    });
    const login = await loginThroughHttp(app);
    const csrf = login.json<{ csrf: string }>().csrf;
    const cookies = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const sessionCookie = login.cookies.find((item) => item.name === "node_shortener_session");
    const sessionId = fixture.service.verifySignedSessionId(
      sessionCookie?.value ?? "",
      testConfig.cookieSigningSecret,
    );
    fixture.auth.failDeleteRemember = new Error("remember store unavailable");

    const response = await app.inject({
      method: "POST",
      url: "/auth/logout",
      headers: { host: "url6x.local", cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      payload: `csrf=${csrf}`,
    });

    expect(response.statusCode).toBe(503);
    expect(clearedCookieNames(response.headers["set-cookie"])).toEqual([
      "fs_remember",
      "node_shortener_session",
    ]);
    expect(sessionId).not.toBeNull();
    expect(fixture.sessions.has(sessionId ?? "")).toBe(false);
    expect(fixture.auth.deletedSelectors).toHaveLength(1);
  });

  it("validates signed session IDs and CSRF tokens without accepting altered values", () => {
    const fixture = createServiceFixture();
    const session = makeSession();
    const signed = fixture.service.signSessionId(session.id, testConfig.cookieSigningSecret);

    expect(fixture.service.verifySignedSessionId(signed, testConfig.cookieSigningSecret)).toBe(session.id);
    expect(fixture.service.verifySignedSessionId(`${signed.slice(0, -1)}0`, testConfig.cookieSigningSecret)).toBeNull();
    expect(fixture.service.verifySignedSessionId("invalid", testConfig.cookieSigningSecret)).toBeNull();
    expect(() => assertCsrf(session, session.csrfToken)).not.toThrow();
    expectCsrfError(session, undefined);
    expectCsrfError(session, "A".repeat(64));
    expectCsrfError(session, "f".repeat(64));
  });
});

describe("PHP password hash compatibility", () => {
  it("verifies Argon2 and PHP bcrypt variants while rejecting bad passwords and malformed hashes", async () => {
    const password = "correct horse battery staple";
    const bcrypt2b = await bcrypt.hash(password, 4);
    const bcrypt2a = `$2a$${bcrypt2b.slice(4)}`;
    const bcrypt2y = `$2y$${bcrypt2b.slice(4)}`;
    const argon2 = await hashArgon2(password);

    await expect(verifyPhpPassword(password, bcrypt2a)).resolves.toBe(true);
    await expect(verifyPhpPassword(password, bcrypt2b)).resolves.toBe(true);
    await expect(verifyPhpPassword(password, bcrypt2y)).resolves.toBe(true);
    await expect(verifyPhpPassword(password, argon2)).resolves.toBe(true);
    await expect(verifyPhpPassword("wrong", argon2)).resolves.toBe(false);
    await expect(verifyPhpPassword(password, "$argon2id$malformed")).resolves.toBe(false);
    await expect(verifyPhpPassword(password, "$2y$malformed")).resolves.toBe(false);
    await expect(verifyPhpPassword(password, "$scrypt$unsupported")).resolves.toBe(false);
  });
});

function createServiceFixture(options: {
  readonly seedUser?: boolean;
  readonly verifyPassword?: (password: string, hash: string) => Promise<boolean>;
} = {}): {
  readonly auth: TrackingAuthStore;
  readonly sessions: TrackingSessionStore;
  readonly service: AuthService;
} {
  const auth = new TrackingAuthStore();
  if (options.seedUser !== false) {
    auth.seedUser({
      id: 10,
      username: "author",
      passwordHash: phpPasswordHash,
      role: "user",
      defaultDomainId: 2,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  }
  const sessions = new TrackingSessionStore();
  return {
    auth,
    sessions,
    service: new AuthService({
      authStore: auth,
      sessions,
      clock: { now: () => new Date(now) },
      ipHashSecret: testConfig.ipHashSecret,
      sessionTtlSeconds: 3_600,
      ...(options.verifyPassword === undefined ? {} : { verifyPassword: options.verifyPassword }),
    }),
  };
}

async function loginThroughHttp(instance: FastifyInstance) {
  const csrfResponse = await instance.inject({
    method: "GET",
    url: "/auth/csrf",
    headers: { host: "url6x.local" },
  });
  const preAuthCookie = csrfResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  const csrf = csrfResponse.json<{ csrf: string }>().csrf;
  const response = await instance.inject({
    method: "POST",
    url: "/auth/login",
    headers: {
      host: "url6x.local",
      "content-type": "application/x-www-form-urlencoded",
      cookie: preAuthCookie,
    },
    payload: `username=author&password=secret-password&csrf=${csrf}`,
  });
  expect(response.statusCode).toBe(200);
  return response;
}

function makeSession(overrides: Partial<SessionData> = {}): SessionData {
  return {
    id: "d".repeat(64),
    userId: 10,
    csrfToken: "e".repeat(64),
    uploadScope: "f".repeat(64),
    authEpoch: 0,
    createdAt: "2026-08-23T11:00:00.000Z",
    expiresAt: "2026-08-23T13:00:00.000Z",
    rememberSelector: null,
    ...overrides,
  };
}

function expectCsrfError(session: SessionData, supplied: unknown): void {
  try {
    assertCsrf(session, supplied);
    throw new Error("Expected assertCsrf to reject the supplied value.");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 403, code: "INVALID_CSRF" });
  }
}

function clearedCookieNames(header: string | string[] | undefined): string[] {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return values
    .filter((value) => value.includes("Expires=Thu, 01 Jan 1970"))
    .map((value) => value.split("=", 1)[0] ?? "")
    .sort();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class TrackingSessionStore implements SessionStore {
  public readonly setCalls: SessionData[] = [];
  public readonly deletedIds: string[] = [];
  public failOnSetCall: number | null = null;
  public failDelete: Error | null = null;
  readonly #sessions = new Map<string, SessionData>();

  public seed(session: SessionData): void {
    this.#sessions.set(session.id, structuredClone(session));
  }

  public has(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  public async get(sessionId: string): Promise<SessionData | null> {
    return structuredClone(this.#sessions.get(sessionId) ?? null);
  }

  public async set(session: SessionData, _ttlSeconds: number): Promise<void> {
    this.setCalls.push(structuredClone(session));
    if (this.failOnSetCall === this.setCalls.length) {
      throw new Error("session write unavailable");
    }
    this.#sessions.set(session.id, structuredClone(session));
  }

  public async delete(sessionId: string): Promise<void> {
    this.deletedIds.push(sessionId);
    if (this.failDelete !== null) {
      throw this.failDelete;
    }
    this.#sessions.delete(sessionId);
  }
}

class TrackingAuthStore implements AuthStore {
  public readonly createdSelectors: string[] = [];
  public readonly deletedSelectors: string[] = [];
  public rememberLookups = 0;
  public authEpoch = 0;
  public failCreateRemember: Error | null = null;
  public failRotateRemember: Error | null = null;
  public failDeleteRemember: Error | null = null;
  public failFailureCount: Error | null = null;
  public failRecordFailure: Error | null = null;
  readonly #usersById = new Map<number, UserRecord>();
  readonly #usersByName = new Map<string, UserRecord>();
  readonly #remember = new Map<string, RememberTokenRecord>();
  readonly #failures: Array<{ readonly ipHash: string; readonly action: string; readonly at: Date }> = [];

  public seedUser(user: UserRecord): void {
    this.#usersById.set(user.id, structuredClone(user));
    this.#usersByName.set(user.username, structuredClone(user));
  }

  public seedRemember(token: RememberTokenRecord): void {
    this.#remember.set(token.selector, structuredClone(token));
  }

  public rememberToken(selector: string): RememberTokenRecord | null {
    return structuredClone(this.#remember.get(selector) ?? null);
  }

  public async findUserByUsername(username: string): Promise<UserRecord | null> {
    return structuredClone(this.#usersByName.get(username) ?? null);
  }

  public async findUserById(userId: number): Promise<UserRecord | null> {
    return structuredClone(this.#usersById.get(userId) ?? null);
  }

  public async authFailureCount(ipHash: string, action: string, since: Date): Promise<number> {
    if (this.failFailureCount !== null) throw this.failFailureCount;
    return this.#failures.filter((row) => row.ipHash === ipHash && row.action === action && row.at >= since).length;
  }

  public async recordAuthFailure(ipHash: string, action: string, at: Date): Promise<void> {
    if (this.failRecordFailure !== null) throw this.failRecordFailure;
    this.#failures.push({ ipHash, action, at });
  }

  public async getAuthEpoch(): Promise<number> {
    return this.authEpoch;
  }

  public async createRememberToken(input: {
    userId: number;
    selector: string;
    validatorHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<{ readonly authEpoch: number }> {
    if (this.failCreateRemember !== null) {
      throw this.failCreateRemember;
    }
    this.createdSelectors.push(input.selector);
    this.#remember.set(input.selector, {
      id: String(this.#remember.size + 1),
      userId: input.userId,
      selector: input.selector,
      validatorHash: input.validatorHash,
      expiresAt: new Date(input.expiresAt),
    });
    return { authEpoch: this.authEpoch };
  }

  public async findRememberToken(selector: string): Promise<RememberTokenRecord | null> {
    this.rememberLookups += 1;
    return this.rememberToken(selector);
  }

  public async rotateRememberToken(id: string, validatorHash: string, expiresAt: Date): Promise<void> {
    if (this.failRotateRemember !== null) {
      throw this.failRotateRemember;
    }
    for (const [selector, token] of this.#remember) {
      if (token.id === id) {
        this.#remember.set(selector, { ...token, validatorHash, expiresAt: new Date(expiresAt) });
        return;
      }
    }
    throw new Error("Remember token not found.");
  }

  public async restoreRememberToken(input: {
    readonly selector: string;
    readonly validatorHash: string;
    readonly rotatedValidatorHash: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }): Promise<
    | {
        readonly status: "rotated";
        readonly userId: number;
        readonly selector: string;
        readonly authEpoch: number;
      }
    | { readonly status: "invalid" }
  > {
    this.rememberLookups += 1;
    const token = this.#remember.get(input.selector);
    if (token === undefined) return { status: "invalid" };
    if (token.validatorHash !== input.validatorHash || token.expiresAt <= input.now) {
      this.deletedSelectors.push(input.selector);
      if (this.failDeleteRemember === null) this.#remember.delete(input.selector);
      return { status: "invalid" };
    }
    if (this.failRotateRemember !== null) throw this.failRotateRemember;
    this.#remember.set(input.selector, {
      ...token,
      validatorHash: input.rotatedValidatorHash,
      expiresAt: new Date(input.expiresAt),
    });
    return {
      status: "rotated",
      userId: token.userId,
      selector: token.selector,
      authEpoch: this.authEpoch,
    };
  }

  public async resetAllAuthCredentials(input: {
    readonly adminUserId: number;
    readonly selector: string;
    readonly validatorHash: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }): Promise<{ readonly authEpoch: number }> {
    this.authEpoch += 1;
    this.#remember.clear();
    this.#remember.set(input.selector, {
      id: "reset-1",
      userId: input.adminUserId,
      selector: input.selector,
      validatorHash: input.validatorHash,
      expiresAt: new Date(input.expiresAt),
    });
    return { authEpoch: this.authEpoch };
  }

  public async deleteRememberToken(selector: string): Promise<void> {
    this.deletedSelectors.push(selector);
    if (this.failDeleteRemember !== null) {
      throw this.failDeleteRemember;
    }
    this.#remember.delete(selector);
  }

  public async setDefaultDomain(userId: number, domainId: number): Promise<void> {
    const user = this.#usersById.get(userId);
    if (user === undefined) {
      throw new Error("User not found.");
    }
    const updated = { ...user, defaultDomainId: domainId };
    this.#usersById.set(userId, updated);
    this.#usersByName.set(updated.username, updated);
  }
}
