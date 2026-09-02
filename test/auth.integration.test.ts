import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../src/app.js";
import { AuthService } from "../src/modules/auth/service.js";
import { createPhpCompatiblePasswordHash, verifyPhpPassword } from "../src/modules/auth/passwords.js";
import { InMemoryApplicationStore, InMemorySessionStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("authentication", () => {
  it("creates a PHP-compatible bcrypt hash", async () => {
    const hash = await createPhpCompatiblePasswordHash("correct horse battery staple");
    expect(hash.startsWith("$2y$")).toBe(true);
    await expect(verifyPhpPassword("correct horse battery staple", hash)).resolves.toBe(true);
  });

  it("rejects login before credential or throttle work when pre-auth CSRF is missing", async () => {
    const { store, service } = await authFixture();
    app = await buildApplication({ config: testConfig, stores: store, authService: service });
    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { host: "url6x.local", "content-type": "application/x-www-form-urlencoded" },
      payload: "username=author&password=wrong",
    });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe("Your session expired — please try again.\n");
    const expectedIpHash = createHash("sha256").update(`127.0.0.1|${testConfig.ipHashSecret}`).digest("hex");
    expect(await store.authFailureCount(expectedIpHash, "login_fail", new Date(0))).toBe(0);
  });

  it("logs in, shares the server-side session, and returns CSRF", async () => {
    const { store, service } = await authFixture();
    app = await buildApplication({ config: testConfig, stores: store, authService: service });
    const preAuth = await preAuthCsrf(app);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { host: "url6x.local", "content-type": "application/x-www-form-urlencoded", cookie: preAuth.cookie },
      payload: `username=author&password=secret-password&csrf=${preAuth.csrf}`,
    });
    const cookies = login.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    const session = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: { host: "url6x.local", cookie: cookies },
    });

    expect(login.statusCode).toBe(200);
    expect(login.cookies.some((item) => item.name === "fs_remember")).toBe(true);
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ ok: true, user: { username: "author" } });
    expect(session.json<{ csrf: string }>().csrf).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records only failed login attempts and uses a generic error", async () => {
    const { store, service } = await authFixture();
    app = await buildApplication({ config: testConfig, stores: store, authService: service });
    const preAuth = await preAuthCsrf(app);

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { host: "url6x.local", "content-type": "application/x-www-form-urlencoded", cookie: preAuth.cookie },
      payload: `username=author&password=wrong&csrf=${preAuth.csrf}`,
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe("Invalid username or password.\n");
    const expectedIpHash = createHash("sha256").update(`127.0.0.1|${testConfig.ipHashSecret}`).digest("hex");
    expect(await store.authFailureCount(expectedIpHash, "login_fail", new Date(0))).toBe(1);
  });

  it("keeps the redirect-only host away from auth", async () => {
    const { store, service } = await authFixture();
    app = await buildApplication({ config: testConfig, stores: store, authService: service });

    const response = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { host: "vidx1x.local", "content-type": "application/x-www-form-urlencoded" },
      payload: "username=author&password=secret-password",
    });

    expect(response.statusCode).toBe(404);
  });
});

async function authFixture(): Promise<{ store: InMemoryApplicationStore; service: AuthService }> {
  const store = new InMemoryApplicationStore(domainPolicies);
  store.seedUser({
    id: 10,
    username: "author",
    passwordHash: await createPhpCompatiblePasswordHash("secret-password"),
    role: "user",
    defaultDomainId: 2,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  const service = new AuthService({
    authStore: store,
    sessions: new InMemorySessionStore(),
    clock: { now: () => new Date("2026-08-23T12:00:00Z") },
    ipHashSecret: testConfig.ipHashSecret,
  });
  return { store, service };
}

async function preAuthCsrf(target: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
  const response = await target.inject({ method: "GET", url: "/auth/csrf", headers: { host: "url6x.local" } });
  expect(response.statusCode).toBe(200);
  return {
    cookie: response.cookies.map((item) => `${item.name}=${item.value}`).join("; "),
    csrf: response.json<{ csrf: string }>().csrf,
  };
}
