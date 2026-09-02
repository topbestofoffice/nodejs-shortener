import { describe, expect, it, vi } from "vitest";
import { buildApplication } from "../src/app.js";
import { DomainRegistry } from "../src/config/domain-registry.js";
import type { LinkRecord } from "../src/core/types.js";
import type {
  CurrentDecisionCore,
  CurrentDecisionInput,
  CurrentDecisionResult,
} from "../src/modules/redirect/current-decision.js";
import { CurrentRedirectDecisionEngine, readCookie } from "../src/modules/redirect/current-engine.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { baseLink, domainPolicies, testConfig } from "./fixtures.js";

const registry = new DomainRegistry([{
  id: 2,
  key: "vidx1x",
  canonicalHost: "vidx1x.local",
  aliases: [],
  label: "VIDX1X",
  surface: "redirect",
  active: true,
  allowCreate: true,
  publicBaseUrl: "https://vidx1x.local",
  imageBaseUrl: "https://vidx1x.local",
}]);

const link: LinkRecord = {
  id: "9007199254740993",
  domainId: 2,
  code: "Ab12Cd3",
  userId: 42,
  destination: "https://author.example/article?utm_source=fb&utm_medium=social",
  title: null,
  description: null,
  image: null,
  authorRole: "user",
  domainHostname: "vidx1x.local",
  domainLabel: "VIDX1X",
  diversionCampaign: "vidx1x",
  createdAt: new Date("2026-08-23T00:00:00.000Z"),
};

describe("CurrentRedirectDecisionEngine", () => {
  it("adapts request evidence and carries the cookie intent without leaking raw identity into observations", async () => {
    const result = currentResult();
    const decide = vi.fn(async (_input: CurrentDecisionInput) => result);
    const engine = new CurrentRedirectDecisionEngine({ decide } as unknown as CurrentDecisionCore, registry);

    const adapted = await engine.decide({
      link,
      ip: "198.51.100.20",
      method: "GET",
      userAgent: "Mozilla/5.0 Chrome/140.0.0.0",
      query: { fbclid: "synthetic-click-token" },
      headers: {
        referer: "https://facebook.com/story",
        cookie: "other=one; __Host-diversion_seen=1787489000.abc123",
      },
    });

    expect(decide).toHaveBeenCalledWith({
      domainId: 2,
      domainBaseUrl: "https://vidx1x.local",
      authorDestination: link.destination,
      authorRole: "user",
      diversionCampaign: "vidx1x",
      clientIp: "198.51.100.20",
      trustedCountry: null,
      method: "GET",
      userAgent: "Mozilla/5.0 Chrome/140.0.0.0",
      isCrawler: false,
      fbclid: "synthetic-click-token",
      referer: "https://facebook.com/story",
      decisionCookieValue: "1787489000.abc123",
    });
    expect(adapted).toMatchObject({
      target: result.target,
      diverted: true,
      filterReason: null,
      country: "IN",
      dynamicDiversionEnabled: true,
      block: null,
      decisionCookie: result.decisionCookie,
      observed: { redirectStatus: 302, country: "IN" },
    });
    expect(adapted.observed).not.toHaveProperty("target");
    expect(adapted.observed).not.toHaveProperty("decisionCookie");
    expect(JSON.stringify(adapted.observed)).not.toContain("198.51.100.20");
    expect(JSON.stringify(adapted.observed)).not.toContain("abc123");
  });

  it("marks generic agents as crawlers for the core and rejects a mismatched domain identity", async () => {
    const decide = vi.fn(async (_input: CurrentDecisionInput) => currentResult());
    const engine = new CurrentRedirectDecisionEngine({ decide } as unknown as CurrentDecisionCore, registry);
    await engine.decide({ link, ip: "198.51.100.1", method: "GET", userAgent: "curl/8.0", query: {}, headers: {} });
    expect(decide.mock.calls[0]?.[0]).toMatchObject({ isCrawler: true });

    await expect(engine.decide({
      link: { ...link, domainHostname: "wrong.local" },
      ip: "198.51.100.1",
      method: "GET",
      userAgent: "Mozilla/5.0",
      query: {},
      headers: {},
    })).rejects.toThrow("unknown or mismatched domain");
  });

  it("carries a signed decision cookie through HTTP without changing the selected redirect", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    const cookie = currentResult().decisionCookie;
    const app = await buildApplication({
      config: testConfig,
      stores: store,
      decisions: {
        decide: async () => ({
          target: "https://selected.example/path",
          diverted: true,
          filterReason: null,
          reportCountry: null,
          country: "IN",
          dynamicDiversionEnabled: true,
          block: null,
          decisionCookie: cookie,
        }),
      },
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/${baseLink.code}`,
        headers: { host: "vidx1x.local", "user-agent": "Mozilla/5.0 Chrome/140.0.0.0" },
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe("https://selected.example/path");
      expect(response.headers["set-cookie"]).toBe(
        `${cookie?.name}=${cookie?.value}; Expires=${cookie?.expires.toUTCString()}; Path=/; Secure; HttpOnly; SameSite=Lax`,
      );
    } finally {
      await app.close();
    }
  });
});

describe("readCookie", () => {
  it.each([
    ["a=1; wanted=value; c=3", "wanted", "value"],
    ["wanted=one; wanted=two", "wanted", undefined],
    ["wanted=", "wanted", undefined],
    ["wanted=a,b", "wanted", undefined],
    ["wanted=ok\u0001bad", "wanted", undefined],
    ["x".repeat(8_193), "wanted", undefined],
    ["wanted=value", "bad name", undefined],
  ])("parses one bounded, unambiguous cookie", (raw, name, expected) => {
    expect(readCookie(raw, name)).toBe(expected);
  });
});

function currentResult(): CurrentDecisionResult {
  return {
    target: "https://skim.example/path?utm_source=fb&utm_medium=social&utm_campaign=vidx1x",
    diverted: true,
    skimEnabled: true,
    debugEnabled: false,
    dynamicDiversionEnabled: true,
    redirectStatus: 302,
    observedFilterReason: null,
    filterReason: null,
    shadowReason: null,
    block: null,
    classificationFailures: [],
    country: "IN",
    countryResolved: true,
    percent: 50,
    percentageRoll: 1,
    wouldDivert: true,
    diversionEligible: true,
    repeatBrowser: false,
    facebookEvidence: true,
    lowYieldBrowser: false,
    qualityChromeVeto: false,
    decisionCookie: {
      name: "__Host-diversion_seen",
      value: `${1_787_489_000}.${"a".repeat(64)}`,
      expires: new Date("2026-08-23T13:00:00.000Z"),
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    },
    failAuthorStage: null,
  };
}
