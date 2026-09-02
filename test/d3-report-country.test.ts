import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../src/app.js";
import type { LinkRecord } from "../src/core/types.js";
import {
  CurrentDecisionCore,
  type CurrentDecisionInput,
  type CurrentDecisionProvider,
} from "../src/modules/redirect/current-decision.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { baseLink, domainPolicies, testConfig } from "./fixtures.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("D3 reporting country isolation", () => {
  it("keeps fallback routing country separate from trusted-header reporting country", async () => {
    const core = new CurrentDecisionCore({
      provider: new FallbackCountryProvider(),
      clock: { now: () => new Date("2026-09-01T00:00:00.000Z") },
      roll: () => 1,
      cookieSecret: "d3-cookie-test-secret-with-at-least-32-chars",
    });

    const noTrustedHeader = await core.decide(decisionInput());
    expect(noTrustedHeader).toMatchObject({ country: "US", reportCountry: null });

    const trustedHeader = await core.decide(decisionInput({ trustedCountry: "IN" }));
    expect(trustedHeader).toMatchObject({ country: "US", reportCountry: "IN" });
  });

  it("records only reportCountry even when routing used a fallback country", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const d3Link: LinkRecord = {
      ...baseLink,
      id: "9007199254740994",
      domainId: 3,
      domainHostname: "plays9x.local",
      domainLabel: "Plays9X",
      diversionCampaign: "plays9x",
    };
    store.seedLink(d3Link);
    app = await buildApplication({
      config: testConfig,
      stores: store,
      decisions: {
        decide: async () => ({
          target: d3Link.destination,
          diverted: false,
          filterReason: null,
          country: "US",
          reportCountry: null,
          dynamicDiversionEnabled: false,
          block: null,
        }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: `/${d3Link.code}`,
      headers: {
        host: "plays9x.local",
        "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/124.0 Mobile Safari/537.36",
      },
    });

    expect(response.statusCode).toBe(301);
    expect(store.accountingEvents).toHaveLength(1);
    expect(store.accountingEvents[0]?.country).toBeNull();
  });
});

class FallbackCountryProvider implements CurrentDecisionProvider {
  public async getBaseSettings() {
    return { skimEnabled: true, debugEnabled: false };
  }

  public async isMetaNetwork() {
    return false;
  }

  public async isDatacenterBot() {
    return false;
  }

  public async detectReplay() {
    return { detected: false, total: 1, token: 1 };
  }

  public async getDiversionContext() {
    return {
      skimDestinationUrl: "https://skim.example/landing",
      country: "US",
      defaultCountryPercent: 100,
      explicitCountryPercentages: {},
      countryQualityPolicy: null,
    };
  }
}

function decisionInput(overrides: Partial<CurrentDecisionInput> = {}): CurrentDecisionInput {
  return {
    domainId: 3,
    domainBaseUrl: "https://plays9x.local",
    authorDestination: "https://author.example/article",
    authorRole: "user",
    diversionCampaign: "plays9x",
    clientIp: "198.51.100.20",
    method: "GET",
    userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/124.0 Mobile Safari/537.36",
    isCrawler: false,
    fbclid: "campaign-token",
    referer: "https://facebook.example/story",
    decisionCookieValue: undefined,
    ...overrides,
  };
}
