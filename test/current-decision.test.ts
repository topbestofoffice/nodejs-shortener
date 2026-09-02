import { describe, expect, it } from "vitest";
import {
  CurrentDecisionCore,
  buildDiversionUrlWithAttribution,
  createDiversionDecisionCookie,
  diversionAttributionValue,
  isDiversionDecisionCookieValid,
  type CurrentBaseSettings,
  type CurrentDecisionConfig,
  type CurrentDecisionInput,
  type CurrentDecisionProvider,
  type CurrentDiversionContext,
  type DatacenterClassificationInput,
  type DiversionContextInput,
  type ReplayDetection,
  type ReplayDetectionInput,
} from "../src/modules/redirect/current-decision.js";

const now = new Date("2026-08-23T12:00:00.000Z");
const nowSeconds = Math.floor(now.getTime() / 1000);
const cookieSecret = "test-cookie-secret";
const androidChrome = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";

describe("signed diversion decision cookie", () => {
  it("matches a PHP hash_hmac golden vector using the migration IP-hash salt", () => {
    const cookie = createDiversionDecisionCookie({
      domainBaseUrl: "https://vidx1x.example",
      secret: "migration-ip-hash-salt",
      nowSeconds: 1_787_486_400,
    });

    expect(cookie.value).toBe(
      "1787490000.3042113c26299057ea6b12b3ff32678ff9807c7cc3aa070c78b3693a3c8b1019",
    );
  });

  it("creates the exact host-only one-hour cookie intent and validates it", () => {
    const cookie = createDiversionDecisionCookie({
      domainBaseUrl: "https://vidx1x.com",
      secret: cookieSecret,
      nowSeconds,
    });

    expect(cookie).toMatchObject({
      name: "__Host-diversion_seen",
      expires: new Date((nowSeconds + 3600) * 1000),
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
    expect(isDiversionDecisionCookieValid({
      value: cookie.value,
      domainBaseUrl: "https://vidx1x.com",
      secret: cookieSecret,
      nowSeconds,
    })).toBe(true);
  });

  it("rejects cross-domain, expired, too-far-future, uppercase, and tampered cookies", () => {
    const cookie = createDiversionDecisionCookie({
      domainBaseUrl: "https://vidx1x.com",
      secret: cookieSecret,
      nowSeconds,
    });
    const common = { secret: cookieSecret, nowSeconds };

    expect(isDiversionDecisionCookieValid({
      ...common,
      value: cookie.value,
      domainBaseUrl: "https://url6x.com",
    })).toBe(false);
    expect(isDiversionDecisionCookieValid({
      ...common,
      value: cookie.value,
      domainBaseUrl: "https://vidx1x.com",
      nowSeconds: nowSeconds + 3600,
    })).toBe(false);
    expect(isDiversionDecisionCookieValid({
      ...common,
      value: createDiversionDecisionCookie({
        domainBaseUrl: "https://vidx1x.com",
        secret: cookieSecret,
        nowSeconds: nowSeconds + 61,
      }).value,
      domainBaseUrl: "https://vidx1x.com",
    })).toBe(false);
    expect(isDiversionDecisionCookieValid({
      ...common,
      value: cookie.value.toUpperCase(),
      domainBaseUrl: "https://vidx1x.com",
    })).toBe(false);
    expect(isDiversionDecisionCookieValid({
      ...common,
      value: `${cookie.value.slice(0, -1)}0`,
      domainBaseUrl: "https://vidx1x.com",
    })).toBe(false);
  });
});

describe("diversion attribution", () => {
  it("carries one bounded source and medium, lowercases them, and appends the campaign", () => {
    expect(buildDiversionUrlWithAttribution(
      "https://skim.example/landing?existing=1",
      "https://author.example/watch?utm_source=FaceBook&utm_medium=Paid_Social",
      "vidx1x",
    )).toBe("https://skim.example/landing?existing=1&utm_source=facebook&utm_medium=paid_social&utm_campaign=vidx1x");
  });

  it("uses div2 for both values when either value is missing, duplicated, or unsafe", () => {
    expect(buildDiversionUrlWithAttribution(
      "https://skim.example/landing",
      "https://author.example/?utm_source=facebook&utm_source=other&utm_medium=social",
      "vidx1x",
    )).toBe("https://skim.example/landing?utm_source=div2&utm_medium=div2&utm_campaign=vidx1x");
    expect(buildDiversionUrlWithAttribution(
      "https://skim.example/landing",
      "https://author.example/?utm_source=facebook1234567&utm_medium=social",
      "vidx1x",
    )).toBe("https://skim.example/landing?utm_source=div2&utm_medium=div2&utm_campaign=vidx1x");
  });

  it("decodes PHP-style names/values and leaves a fragment-bearing skim URL unchanged", () => {
    expect(buildDiversionUrlWithAttribution(
      "https://skim.example/landing",
      "https://author.example/?utm%5Fsource=Face%2EBook&utm_medium=paid-social",
      "vidx1x",
    )).toContain("utm_source=face.book&utm_medium=paid-social");
    expect(buildDiversionUrlWithAttribution(
      "https://skim.example/landing#section",
      "https://author.example/?utm_source=facebook&utm_medium=social",
      "vidx1x",
    )).toBe("https://skim.example/landing#section");
  });

  it("rejects an invalid campaign and the current unsafe attribution shapes", () => {
    expect(() => buildDiversionUrlWithAttribution(
      "https://skim.example/landing",
      "https://author.example/",
      "VIDX1X",
    )).toThrow("Domain campaign is invalid");
    expect(diversionAttributionValue("0123456789abcdef01234567")).toBeNull();
    expect(diversionAttributionValue("campaign1234567")).toBeNull();
    expect(diversionAttributionValue("campaign123456789012")).toBeNull();
  });
});

describe("current redirect decision core", () => {
  it("runs base, Meta, datacenter, replay, then geo context and returns an attributed diversion", async () => {
    const provider = new StubProvider();
    const harness = createCore(provider, 25);

    const result = await harness.core.decide(request());

    expect(provider.calls).toEqual(["base", "meta", "aws_dc", "fbclid_replay", "context"]);
    expect(result).toMatchObject({
      target: "https://skim.example/landing?utm_source=facebook&utm_medium=social&utm_campaign=vidx1x",
      diverted: true,
      filterReason: null,
      block: null,
      country: "BR",
      countryResolved: true,
      percent: 50,
      percentageRoll: 25,
      wouldDivert: true,
      diversionEligible: true,
      repeatBrowser: false,
      dynamicDiversionEnabled: true,
      redirectStatus: 302,
      failAuthorStage: null,
    });
    expect(result.decisionCookie?.name).toBe("__Host-diversion_seen");
    expect(harness.rollCalls()).toBe(1);
  });

  it("issues the first eligible GET cookie even when the percentage roll stays with the author", async () => {
    const provider = new StubProvider();
    const harness = createCore(provider, 75);

    const result = await harness.core.decide(request());

    expect(result).toMatchObject({
      target: "https://author.example/watch?utm_source=facebook&utm_medium=social",
      diverted: false,
      percentageRoll: 75,
      wouldDivert: false,
    });
    expect(result.decisionCookie).not.toBeNull();
  });

  it("suppresses a same-domain repeat GET without a roll or a replacement cookie", async () => {
    const provider = new StubProvider();
    const existing = createDiversionDecisionCookie({
      domainBaseUrl: "https://vidx1x.com",
      secret: cookieSecret,
      nowSeconds,
    });
    const harness = createCore(provider, 1);

    const result = await harness.core.decide(request({ decisionCookieValue: existing.value }));

    expect(result).toMatchObject({
      diverted: false,
      repeatBrowser: true,
      percentageRoll: null,
      wouldDivert: null,
      decisionCookie: null,
    });
    expect(harness.rollCalls()).toBe(0);
  });

  it("still performs a debug observation roll for a repeat GET without diverting or replacing its cookie", async () => {
    const provider = new StubProvider();
    provider.base = { skimEnabled: true, debugEnabled: true };
    const existing = createDiversionDecisionCookie({
      domainBaseUrl: "https://vidx1x.com",
      secret: cookieSecret,
      nowSeconds,
    });
    const harness = createCore(provider, 1);

    const result = await harness.core.decide(request({ decisionCookieValue: existing.value }));

    expect(result).toMatchObject({
      diverted: false,
      repeatBrowser: true,
      percentageRoll: 1,
      wouldDivert: true,
      decisionCookie: null,
    });
    expect(harness.rollCalls()).toBe(1);
  });

  it("treats a different-domain cookie as invalid and replaces it after rolling", async () => {
    const provider = new StubProvider();
    const otherDomain = createDiversionDecisionCookie({
      domainBaseUrl: "https://url6x.com",
      secret: cookieSecret,
      nowSeconds,
    });
    const harness = createCore(provider, 25);

    const result = await harness.core.decide(request({ decisionCookieValue: otherDomain.value }));

    expect(result.repeatBrowser).toBe(false);
    expect(result.diverted).toBe(true);
    expect(result.decisionCookie).not.toBeNull();
    expect(harness.rollCalls()).toBe(1);
  });

  it("ignores the cookie for non-GET traffic, rolls, and does not issue a cookie", async () => {
    const provider = new StubProvider();
    const existing = createDiversionDecisionCookie({
      domainBaseUrl: "https://vidx1x.com",
      secret: cookieSecret,
      nowSeconds,
    });
    const harness = createCore(provider, 25);

    const result = await harness.core.decide(request({
      method: "POST",
      decisionCookieValue: existing.value,
    }));

    expect(result).toMatchObject({
      diverted: true,
      repeatBrowser: false,
      decisionCookie: null,
    });
    expect(harness.rollCalls()).toBe(1);
  });

  it("classifies Meta first, calls datacenter with that evidence, skips replay, and enforces Meta", async () => {
    const provider = new StubProvider();
    provider.meta = true;
    const harness = createCore(provider, 1);

    const result = await harness.core.decide(request());

    expect(provider.calls).toEqual(["base", "meta", "aws_dc", "context"]);
    expect(provider.lastDatacenterInput?.metaNetwork).toBe(true);
    expect(result).toMatchObject({
      observedFilterReason: "meta",
      filterReason: "meta",
      shadowReason: null,
      block: null,
      diverted: false,
    });
  });

  it("skips replay for a datacenter match and maps its enforced hard block", async () => {
    const provider = new StubProvider();
    provider.datacenter = true;
    const result = await createCore(provider, 1).core.decide(request());

    expect(provider.calls).toEqual(["base", "meta", "aws_dc", "context"]);
    expect(result).toMatchObject({
      observedFilterReason: "aws_dc",
      filterReason: "aws_dc",
      block: "aws_dc",
      diverted: false,
    });
  });

  it("soft-filters replay at 30/10 and blocks only the stricter 50/50 tier", async () => {
    const softProvider = new StubProvider();
    softProvider.replay = { detected: true, total: 49, token: 49 };
    const soft = await createCore(softProvider, 1).core.decide(request());
    expect(soft).toMatchObject({ filterReason: "fbclid_replay", block: null, diverted: false });

    const hardProvider = new StubProvider();
    hardProvider.replay = { detected: true, total: 50, token: 50 };
    const hard = await createCore(hardProvider, 1).core.decide(request());
    expect(hard).toMatchObject({ filterReason: "fbclid_replay", block: "fbclid_replay", diverted: false });
  });

  it("preserves observed shadow ordering when enforcement is disabled", async () => {
    const provider = new StubProvider();
    provider.meta = true;
    const result = await createCore(provider, 1, { metaEnforce: false }).core.decide(request());

    expect(result).toMatchObject({
      observedFilterReason: "meta",
      filterReason: null,
      shadowReason: "meta",
      block: null,
      diverted: true,
    });
  });

  it("keeps admin links on a direct 301 and skips all geo, roll, and cookie work", async () => {
    const provider = new StubProvider();
    const harness = createCore(provider, 1);

    const result = await harness.core.decide(request({ authorRole: "admin" }));

    expect(provider.calls).toEqual(["base", "meta", "aws_dc", "fbclid_replay"]);
    expect(result).toMatchObject({
      diverted: false,
      country: null,
      countryResolved: false,
      percent: null,
      dynamicDiversionEnabled: true,
      redirectStatus: 301,
      decisionCookie: null,
    });
    expect(harness.rollCalls()).toBe(0);
  });

  it("preserves a trusted header country for filtered accounting without geo lookup", async () => {
    const provider = new StubProvider();
    provider.base = { skimEnabled: false, debugEnabled: false };
    provider.meta = true;

    const result = await createCore(provider, 1).core.decide(request({ trustedCountry: "IN" }));

    expect(provider.calls).toEqual(["base", "meta", "aws_dc"]);
    expect(result).toMatchObject({
      filterReason: "meta",
      country: "IN",
      countryResolved: true,
      diverted: false,
    });
  });

  it("skips geo and roll work when both skim and debug are Off", async () => {
    const provider = new StubProvider();
    provider.base = { skimEnabled: false, debugEnabled: false };
    const harness = createCore(provider, 1);

    const result = await harness.core.decide(request());

    expect(provider.calls).toEqual(["base", "meta", "aws_dc", "fbclid_replay"]);
    expect(result).toMatchObject({
      diverted: false,
      countryResolved: false,
      percent: null,
      dynamicDiversionEnabled: false,
      redirectStatus: 301,
      failAuthorStage: null,
    });
    expect(harness.rollCalls()).toBe(0);
  });

  it("loads geo and rolls for debug observation while diversion remains Off", async () => {
    const provider = new StubProvider();
    provider.base = { skimEnabled: false, debugEnabled: true };
    const harness = createCore(provider, 25);

    const result = await harness.core.decide(request());

    expect(provider.calls).toEqual(["base", "meta", "aws_dc", "fbclid_replay", "context"]);
    expect(result).toMatchObject({
      diverted: false,
      country: "BR",
      countryResolved: true,
      percent: 50,
      percentageRoll: 25,
      wouldDivert: true,
      dynamicDiversionEnabled: false,
      redirectStatus: 301,
      decisionCookie: null,
    });
    expect(harness.rollCalls()).toBe(1);
  });

  it("keeps Quality-Control and low-yield vetoes as normal unfiltered author delivery", async () => {
    const qualityProvider = new StubProvider();
    qualityProvider.context = {
      ...qualityProvider.context,
      explicitCountryPercentages: { BR: 50 },
      countryQualityPolicy: { active: true, scope: "selected", countries: ["BR"] },
    };
    const qualityHarness = createCore(qualityProvider, 1);
    const quality = await qualityHarness.core.decide(request());
    expect(quality).toMatchObject({
      diverted: false,
      filterReason: null,
      qualityChromeVeto: true,
      lowYieldBrowser: false,
      decisionCookie: null,
    });
    expect(qualityHarness.rollCalls()).toBe(0);

    const lowYieldProvider = new StubProvider();
    const lowYieldHarness = createCore(lowYieldProvider, 1);
    const lowYield = await lowYieldHarness.core.decide(request({
      userAgent: `${androidChrome} SamsungBrowser/25.0`,
    }));
    expect(lowYield).toMatchObject({
      diverted: false,
      filterReason: null,
      qualityChromeVeto: false,
      lowYieldBrowser: true,
      decisionCookie: null,
    });
    expect(lowYieldHarness.rollCalls()).toBe(0);
  });

  it("fails classification providers open in order and continues normal diversion", async () => {
    const provider = new StubProvider();
    provider.failures = new Set(["meta", "aws_dc", "fbclid_replay"]);
    const result = await createCore(provider, 1).core.decide(request());

    expect(provider.calls).toEqual(["base", "meta", "aws_dc", "fbclid_replay", "context"]);
    expect(result).toMatchObject({
      classificationFailures: ["meta", "aws_dc", "fbclid_replay"],
      filterReason: null,
      block: null,
      diverted: true,
      failAuthorStage: null,
    });
  });

  it("fails base settings to a direct author redirect but still runs classifiers", async () => {
    const provider = new StubProvider();
    provider.failures.add("base");
    const harness = createCore(provider, 1);
    const result = await harness.core.decide(request());

    expect(provider.calls).toEqual(["base", "meta", "aws_dc", "fbclid_replay"]);
    expect(result).toMatchObject({
      target: "https://author.example/watch?utm_source=facebook&utm_medium=social",
      diverted: false,
      skimEnabled: false,
      redirectStatus: 301,
      failAuthorStage: "base_settings",
    });
    expect(harness.rollCalls()).toBe(0);
  });

  it("fails geo/context work to the author while retaining dynamic 302 and filter results", async () => {
    const provider = new StubProvider();
    provider.failures.add("context");
    provider.replay = { detected: true, total: 30, token: 10 };
    const result = await createCore(provider, 1).core.decide(request());

    expect(result).toMatchObject({
      target: "https://author.example/watch?utm_source=facebook&utm_medium=social",
      diverted: false,
      filterReason: "fbclid_replay",
      dynamicDiversionEnabled: true,
      redirectStatus: 302,
      countryResolved: false,
      failAuthorStage: "diversion_context",
    });
  });

  it("fails an invalid or throwing percentage roll to the author before cookie issuance", async () => {
    const provider = new StubProvider();
    const invalid = await createCore(provider, 0).core.decide(request());
    expect(invalid).toMatchObject({ diverted: false, decisionCookie: null, failAuthorStage: "percentage_roll" });

    const throwing = new CurrentDecisionCore({
      provider: new StubProvider(),
      clock: { now: () => now },
      roll: () => { throw new Error("rng unavailable"); },
      cookieSecret,
    });
    expect(await throwing.decide(request())).toMatchObject({
      diverted: false,
      decisionCookie: null,
      failAuthorStage: "percentage_roll",
    });
  });

  it("keeps the already-issued cookie intent when winning attribution has an invalid campaign", async () => {
    const provider = new StubProvider();
    const result = await createCore(provider, 1).core.decide(request({ diversionCampaign: "VIDX1X" }));

    expect(result).toMatchObject({
      target: "https://author.example/watch?utm_source=facebook&utm_medium=social",
      diverted: false,
      wouldDivert: true,
      failAuthorStage: "attribution",
    });
    expect(result.decisionCookie).not.toBeNull();
  });

  it("does not roll or issue a cookie for an invalid skim destination", async () => {
    const provider = new StubProvider();
    provider.context = { ...provider.context, skimDestinationUrl: "javascript:alert(1)" };
    const harness = createCore(provider, 1);
    const result = await harness.core.decide(request());

    expect(result).toMatchObject({
      diverted: false,
      diversionEligible: false,
      decisionCookie: null,
      failAuthorStage: null,
    });
    expect(harness.rollCalls()).toBe(0);
  });
});

class StubProvider implements CurrentDecisionProvider {
  public readonly calls: string[] = [];
  public failures = new Set<string>();
  public base: CurrentBaseSettings = { skimEnabled: true, debugEnabled: false };
  public context: CurrentDiversionContext = {
    skimDestinationUrl: "https://skim.example/landing",
    country: "BR",
    defaultCountryPercent: 50,
    explicitCountryPercentages: {},
    countryQualityPolicy: { active: false, scope: "selected", countries: [] },
  };
  public meta = false;
  public datacenter = false;
  public replay: ReplayDetection = { detected: false, total: 1, token: 1 };
  public lastDatacenterInput: DatacenterClassificationInput | undefined;

  public async getBaseSettings(_domainId: number): Promise<CurrentBaseSettings> {
    this.calls.push("base");
    this.throwIf("base");
    return this.base;
  }

  public async isMetaNetwork(_clientIp: string): Promise<boolean> {
    this.calls.push("meta");
    this.throwIf("meta");
    return this.meta;
  }

  public async isDatacenterBot(input: DatacenterClassificationInput): Promise<boolean> {
    this.calls.push("aws_dc");
    this.lastDatacenterInput = input;
    this.throwIf("aws_dc");
    return input.metaNetwork || input.isCrawler ? false : this.datacenter;
  }

  public async detectReplay(_input: ReplayDetectionInput): Promise<ReplayDetection> {
    this.calls.push("fbclid_replay");
    this.throwIf("fbclid_replay");
    return this.replay;
  }

  public async getDiversionContext(_input: DiversionContextInput): Promise<CurrentDiversionContext> {
    this.calls.push("context");
    this.throwIf("context");
    return this.context;
  }

  private throwIf(stage: string): void {
    if (this.failures.has(stage)) {
      throw new Error(`${stage} unavailable`);
    }
  }
}

function createCore(
  provider: CurrentDecisionProvider,
  rollValue: number,
  config: Partial<CurrentDecisionConfig> = {},
): { readonly core: CurrentDecisionCore; readonly rollCalls: () => number } {
  let calls = 0;
  return {
    core: new CurrentDecisionCore({
      provider,
      clock: { now: () => now },
      roll: () => {
        calls += 1;
        return rollValue;
      },
      cookieSecret,
      config,
    }),
    rollCalls: () => calls,
  };
}

function request(override: Partial<CurrentDecisionInput> = {}): CurrentDecisionInput {
  return {
    domainId: 2,
    domainBaseUrl: "https://vidx1x.com",
    authorDestination: "https://author.example/watch?utm_source=facebook&utm_medium=social",
    authorRole: "user",
    diversionCampaign: "vidx1x",
    clientIp: "203.0.113.10",
    method: "GET",
    userAgent: androidChrome,
    isCrawler: false,
    fbclid: "campaign-token",
    referer: undefined,
    decisionCookieValue: undefined,
    ...override,
  };
}
