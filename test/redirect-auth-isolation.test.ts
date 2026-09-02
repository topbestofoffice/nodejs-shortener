import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../src/app.js";
import type { SessionData } from "../src/core/types.js";
import { AuthService } from "../src/modules/auth/service.js";
import type { SessionStore } from "../src/ports.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { baseLink, domainPolicies, testConfig } from "./fixtures.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("redirect isolation from session infrastructure", () => {
  it("keeps a valid short-link redirect working when Redis sessions are unavailable", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    const authService = new AuthService({
      authStore: store,
      sessions: new UnavailableSessionStore(),
      clock: { now: () => new Date("2026-08-23T12:00:00Z") },
      ipHashSecret: testConfig.ipHashSecret,
    });
    app = await buildApplication({ config: testConfig, stores: store, authService });
    const unavailableSessionCookie = authService.signSessionId("a".repeat(64), testConfig.cookieSigningSecret);

    const redirect = await app.inject({
      method: "GET",
      url: `/${baseLink.code}`,
      headers: {
        host: "vidx1x.local",
        cookie: `node_shortener_session=${unavailableSessionCookie}`,
        "user-agent": "Mozilla/5.0 Chrome/124.0",
      },
    });
    const dashboardSession = await app.inject({
      method: "GET",
      url: "/auth/session",
      headers: {
        host: "url6x.local",
        cookie: `node_shortener_session=${unavailableSessionCookie}`,
      },
    });

    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location).toBe(baseLink.destination);
    expect(dashboardSession.statusCode).toBe(503);
  });
});

class UnavailableSessionStore implements SessionStore {
  public async get(_sessionId: string): Promise<SessionData | null> {
    throw new Error("Redis unavailable");
  }

  public async set(_session: SessionData, _ttlSeconds: number): Promise<void> {
    throw new Error("Redis unavailable");
  }

  public async delete(_sessionId: string): Promise<void> {
    throw new Error("Redis unavailable");
  }
}
