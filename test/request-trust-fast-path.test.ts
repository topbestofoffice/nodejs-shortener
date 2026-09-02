import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { DomainStore } from "../src/ports.js";
import { requestTrustHook, preDomainPathDecision } from "../src/security/request-trust.js";
import { domainPolicies, testConfig } from "./fixtures.js";

describe("request trust pre-domain path gate", () => {
  it("keeps strict public files and liveness DB-free but validates real application routes", async () => {
    let reads = 0;
    const domains: DomainStore = {
      getDomain: async (id) => {
        reads += 1;
        return domainPolicies.find((domain) => domain.id === id) ?? null;
      },
      listManageableDomains: async () => [],
      listSelectableDomains: async () => [],
    };
    const app = Fastify({ logger: false });
    app.decorateRequest("domainContext");
    app.decorateRequest("domainPolicy");
    app.addHook("onRequest", requestTrustHook(testConfig, domains));
    app.get("/health/live", async () => ({ ok: true }));
    app.get("/health/ready", async () => ({ ok: true }));
    app.get("/assets/dashboard-shell.js", async () => "asset");
    app.get("/AbC123", async () => "code");

    const live = await app.inject({ method: "GET", url: "/health/live", headers: { host: "url6x.local" } });
    const ready = await app.inject({ method: "GET", url: "/health/ready", headers: { host: "url6x.local" } });
    const asset = await app.inject({ method: "GET", url: "/assets/dashboard-shell.js", headers: { host: "url6x.local" } });
    const probe = await app.inject({ method: "GET", url: "/.git/config", headers: { host: "url6x.local" } });
    expect([live.statusCode, ready.statusCode, asset.statusCode, probe.statusCode]).toEqual([200, 200, 200, 404]);
    expect(reads).toBe(0);

    const code = await app.inject({ method: "GET", url: "/AbC123", headers: { host: "vidx1x.local" } });
    expect(code.statusCode).toBe(200);
    expect(reads).toBe(1);
    await app.close();
  });

  it("does not treat traversal, encoded, non-GET or disabled diagnostics paths as public files", () => {
    expect(preDomainPathDecision("dashboard", "GET", "/assets/../auth/login", false)).toBe("reject");
    expect(preDomainPathDecision("dashboard", "GET", "/assets/%2e%2e/auth/login", false)).toBe("reject");
    expect(preDomainPathDecision("dashboard", "POST", "/assets/dashboard-shell.js", false)).toBe("reject");
    expect(preDomainPathDecision("dashboard", "GET", "/__pilot/headers", false)).toBe("reject");
    expect(preDomainPathDecision("dashboard", "GET", "/__pilot/headers", true)).toBe("dynamic");
    expect(preDomainPathDecision("redirect", "GET", "/health/live", true)).toBe("reject");
    expect(preDomainPathDecision("redirect", "GET", "/health/ready", true)).toBe("reject");
    expect(preDomainPathDecision("redirect", "GET", "/__pilot/headers", true)).toBe("reject");
  });
});
