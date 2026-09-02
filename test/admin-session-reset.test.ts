import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApplication } from "../src/app.js";
import type { SessionData, UserRecord } from "../src/core/types.js";
import { AuthService } from "../src/modules/auth/service.js";
import { createPhpCompatiblePasswordHash } from "../src/modules/auth/passwords.js";
import type { SessionStore } from "../src/ports.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

const now = new Date("2026-09-01T12:00:00.000Z");
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("Admin global session reset", () => {
  it("atomically revokes every old browser while issuing fresh Admin credentials", async () => {
    const fixture = await createFixture();
    app = await buildApplication({
      config: testConfig,
      stores: fixture.store,
      authService: fixture.auth,
    });
    const owner = await login(app, "owner");
    const author = await login(app, "author");

    const reset = await postReset(app, owner.cookie, owner.csrf);

    expect(reset.statusCode, reset.body).toBe(303);
    expect(reset.headers.location).toBe("/admin.php?domain_id=2&notice=sessions_reset");
    expect(fixture.store.authEpoch).toBe(1);
    const refreshedCookie = reset.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    expect(refreshedCookie).toContain("node_shortener_session=");
    expect(refreshedCookie).toContain("fs_remember=");

    for (const staleCookie of [owner.cookie, author.cookie]) {
      const stale = await app.inject({
        method: "GET",
        url: "/auth/session",
        headers: { host: "url6x.local", cookie: staleCookie },
      });
      expect(stale.statusCode).toBe(401);
    }
    const current = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { host: "url6x.local", cookie: refreshedCookie },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ ok: true, user: { username: "owner", role: "admin" } });
  });

  it("clears both cookies and reports the committed reset when Redis refresh fails", async () => {
    const fixture = await createFixture();
    app = await buildApplication({
      config: testConfig,
      stores: fixture.store,
      authService: fixture.auth,
    });
    const owner = await login(app, "owner");
    fixture.sessions.failNextSet = true;

    const reset = await postReset(app, owner.cookie, owner.csrf);

    expect(reset.statusCode).toBe(503);
    expect(reset.body).toBe(
      "Global session reset completed, but this browser could not be refreshed. Sign in again; do not repeat the reset.\n",
    );
    expect(clearedCookieNames(reset.headers["set-cookie"])).toEqual([
      "fs_remember",
      "node_shortener_session",
    ]);
    expect(fixture.store.authEpoch).toBe(1);
    const stale = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { host: "url6x.local", cookie: owner.cookie },
    });
    expect(stale.statusCode).toBe(401);

    // Password login is the recovery path. The reset action is never retried.
    const recovered = await login(app, "owner");
    expect(recovered.cookie).toContain("node_shortener_session=");
  });

  it("clears credentials and never retries when the database reset outcome is unknown", async () => {
    const fixture = await createFixture();
    app = await buildApplication({
      config: testConfig,
      stores: fixture.store,
      authService: fixture.auth,
    });
    const owner = await login(app, "owner");
    const resetMutation = vi.spyOn(fixture.store, "resetAllAuthCredentials")
      .mockRejectedValueOnce(new Error("commit acknowledgement lost"));

    const reset = await postReset(app, owner.cookie, owner.csrf);

    expect(reset.statusCode).toBe(503);
    expect(reset.body).toBe(
      "Global session reset could not be confirmed. For safety, sign in again and check before retrying.\n",
    );
    expect(clearedCookieNames(reset.headers["set-cookie"])).toEqual([
      "fs_remember",
      "node_shortener_session",
    ]);
    expect(resetMutation).toHaveBeenCalledOnce();
  });

  it("never lets a remember restore racing the reset remain valid afterwards", async () => {
    const fixture = await createFixture();
    const owner = await fixture.auth.login("owner", "secret-password", "127.0.0.1");
    const author = await fixture.auth.login("author", "secret-password", "127.0.0.1");
    expect(author.rememberCookie).not.toBeNull();

    const [possiblyRestored, reset] = await Promise.all([
      fixture.auth.restoreRemember(author.rememberCookie ?? ""),
      fixture.auth.resetAllSessions(owner.session, owner.user),
    ]);

    if (possiblyRestored !== null) {
      await expect(fixture.auth.getSession(possiblyRestored.session.id)).resolves.toBeNull();
    }
    await expect(fixture.auth.getSession(reset.session.id)).resolves.toMatchObject({
      user: { username: "owner", role: "admin" },
      session: { authEpoch: 1 },
    });
  });
});

async function createFixture(): Promise<{
  readonly store: InMemoryApplicationStore;
  readonly sessions: ToggleSessionStore;
  readonly auth: AuthService;
}> {
  const store = new InMemoryApplicationStore(domainPolicies);
  const passwordHash = await createPhpCompatiblePasswordHash("secret-password");
  for (const user of [
    userRecord(1, "owner", "admin", passwordHash),
    userRecord(10, "author", "user", passwordHash),
  ]) {
    store.seedUser(user);
  }
  const sessions = new ToggleSessionStore();
  return {
    store,
    sessions,
    auth: new AuthService({
      authStore: store,
      sessions,
      clock: { now: () => new Date(now) },
      ipHashSecret: testConfig.ipHashSecret,
    }),
  };
}

function userRecord(
  id: number,
  username: string,
  role: "admin" | "user",
  passwordHash: string,
): UserRecord {
  return {
    id,
    username,
    passwordHash,
    role,
    defaultDomainId: 2,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

async function login(
  target: FastifyInstance,
  username: string,
): Promise<{ readonly cookie: string; readonly csrf: string }> {
  const preAuth = await target.inject({
    method: "GET",
    url: "/auth/csrf",
    headers: { host: "url6x.local" },
  });
  const preCookie = preAuth.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  const response = await target.inject({
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
  expect(response.statusCode, response.body).toBe(200);
  return {
    cookie: response.cookies.map((item) => `${item.name}=${item.value}`).join("; "),
    csrf: response.json<{ csrf: string }>().csrf,
  };
}

async function postReset(target: FastifyInstance, cookie: string, csrf: string) {
  return target.inject({
    method: "POST",
    url: "/admin.php",
    headers: {
      host: "url6x.local",
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({
      csrf,
      action: "reset_sessions",
      domain_id: "2",
    }).toString(),
  });
}

function clearedCookieNames(header: string | string[] | undefined): string[] {
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return values
    .filter((value) => value.includes("Expires=Thu, 01 Jan 1970"))
    .map((value) => value.split("=", 1)[0] ?? "")
    .sort();
}

class ToggleSessionStore implements SessionStore {
  public failNextSet = false;
  readonly #sessions = new Map<string, SessionData>();

  public async get(sessionId: string): Promise<SessionData | null> {
    return structuredClone(this.#sessions.get(sessionId) ?? null);
  }

  public async set(session: SessionData, _ttlSeconds: number): Promise<void> {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("Redis session write unavailable");
    }
    this.#sessions.set(session.id, structuredClone(session));
  }

  public async delete(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
  }
}
