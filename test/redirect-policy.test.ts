import { describe, expect, it } from "vitest";
import {
  DEFAULT_COUNTRY_QUALITY_POLICY,
  applyDiversionPercentageRoll,
  decodeCountryQualityPolicy,
  evaluateDiversionPreconditions,
  hasFacebookClickEvidence,
  isAndroidChromeQualityCandidate,
  isCountryQualityEnabled,
  isExplicitMetaAppUserAgent,
  isLowYieldBrowserUserAgent,
  resolveCountryPercentage,
  type CountryQualityPolicy,
  type DiversionPolicyInput,
} from "../src/modules/redirect/policy.js";

const androidChrome = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36";

const activeBrazilPolicy: CountryQualityPolicy = {
  active: true,
  scope: "selected",
  countries: ["BR"],
};

describe("country Quality Control policy", () => {
  it("strictly decodes, normalizes, and sorts the server-owned policy", () => {
    expect(decodeCountryQualityPolicy('{"active":true,"scope":"selected","countries":[" ph ","BR","XK"]}')).toEqual({
      active: true,
      scope: "selected",
      countries: ["BR", "PH", "XK"],
    });
  });

  it.each([
    undefined,
    "not-json",
    { active: "true", scope: "selected", countries: ["BR"] },
    { active: true, scope: "other", countries: ["BR"] },
    { active: true, scope: "selected", countries: ["BR", "br"] },
    { active: true, scope: "selected", countries: ["ZZ"] },
  ])("defaults malformed or unknown policy Off", (stored) => {
    expect(decodeCountryQualityPolicy(stored)).toEqual(DEFAULT_COUNTRY_QUALITY_POLICY);
  });

  it("uses an explicit country percentage before the default and clamps it", () => {
    expect(resolveCountryPercentage("br", { BR: 120 }, 40)).toEqual({ country: "BR", percent: 100, explicit: true });
    expect(resolveCountryPercentage("PH", { BR: 70 }, 40)).toEqual({ country: "PH", percent: 40, explicit: false });
  });

  it("enables selected or all scope only for an explicit positive country row", () => {
    const brazil = resolveCountryPercentage("BR", { BR: 70 }, 40);
    const defaultOnly = resolveCountryPercentage("PH", { BR: 70 }, 40);
    const explicitZero = resolveCountryPercentage("BR", { BR: 0 }, 40);

    expect(isCountryQualityEnabled(activeBrazilPolicy, brazil)).toBe(true);
    expect(isCountryQualityEnabled({ active: true, scope: "all", countries: [] }, brazil)).toBe(true);
    expect(isCountryQualityEnabled({ active: true, scope: "all", countries: [] }, defaultOnly)).toBe(false);
    expect(isCountryQualityEnabled(activeBrazilPolicy, explicitZero)).toBe(false);
    expect(isCountryQualityEnabled(DEFAULT_COUNTRY_QUALITY_POLICY, brazil)).toBe(false);
  });
});

describe("browser cohorts", () => {
  it.each([
    "Mozilla/5.0 [FBAN/FB4A;FBAV/400.0]",
    "Mozilla/5.0 FB_IAB/FB4A",
    "Mozilla/5.0 FB4A",
    "Mozilla/5.0 (Linux; Android) Instagram 300.0",
    "Mozilla/5.0 (Linux; Android) MESSENGER/450.0",
    "Mozilla/5.0 (Linux; Android) Orca-Android",
  ])("recognizes explicit Meta app marker in %s", (userAgent) => {
    expect(isExplicitMetaAppUserAgent(userAgent)).toBe(true);
  });

  it("accepts ordinary Android Chrome for Quality Control", () => {
    expect(isAndroidChromeQualityCandidate(androidChrome)).toBe(true);
  });

  it.each([
    `${androidChrome} [FBAN/FB4A;FBAV/400.0]`,
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/X; wv) Version/4.0 Chrome/124.0 Mobile Safari/537.36",
    `${androidChrome} Version/4.0`,
    `${androidChrome} SamsungBrowser/25.0`,
    `${androidChrome} OPR/80.0`,
    `${androidChrome} Opera Mini/80.0`,
    `${androidChrome} EdgA/124.0`,
    `${androidChrome} Edg/124.0`,
    `${androidChrome} GSA/15.0`,
    "Mozilla/5.0 (iPhone) Chrome/124.0 Mobile",
    "Mozilla/5.0 (Linux; Android 14) Safari/537.36",
  ])("excludes named apps, WebView, or non-Android-Chrome UA from Quality Control: %s", (userAgent) => {
    expect(isAndroidChromeQualityCandidate(userAgent)).toBe(false);
  });

  it.each([
    `${androidChrome} SamsungBrowser/25.0`,
    `${androidChrome} OPR/80.0`,
    `${androidChrome} Opera Mini/80.0`,
    `${androidChrome} Opera Mobi/80.0`,
    `${androidChrome} Opera/80.0`,
  ])("vetoes named low-yield cohort without classifying it as a bot: %s", (userAgent) => {
    expect(isLowYieldBrowserUserAgent(userAgent)).toBe(true);
  });

  it("does not broaden the low-yield veto to Edge or GSA", () => {
    expect(isLowYieldBrowserUserAgent(`${androidChrome} EdgA/124.0`)).toBe(false);
    expect(isLowYieldBrowserUserAgent(`${androidChrome} GSA/15.0`)).toBe(false);
  });
});

describe("Facebook click evidence", () => {
  it("accepts any non-empty fbclid, including when Referer is absent", () => {
    expect(hasFacebookClickEvidence("campaign-token", undefined)).toBe(true);
    expect(hasFacebookClickEvidence(" ", undefined)).toBe(true);
  });

  it.each([
    "https://facebook.com/post/1",
    "https://m.facebook.com/post/1",
    "https://instagram.com/reel/1",
    "https://l.instagram.com/redirect",
  ])("accepts an exact or subdomain Facebook/Instagram Referer host: %s", (referer) => {
    expect(hasFacebookClickEvidence(undefined, referer)).toBe(true);
  });

  it.each([
    "",
    "not a url",
    "https://evilfacebook.com/post/1",
    "https://facebook.com.evil.example/post/1",
    "https://facebook.com@evil.example/post/1",
  ])("rejects absent, malformed, or suffix-confusion Referer evidence: %s", (referer) => {
    expect(hasFacebookClickEvidence(undefined, referer)).toBe(false);
  });
});

describe("diversion decision", () => {
  it("makes a first eligible GET cookie-eligible and applies the inclusive percentage roll", () => {
    const preRoll = evaluateDiversionPreconditions(input());

    expect(preRoll).toMatchObject({
      percent: 50,
      diversionEligible: true,
      cookieEligible: true,
      repeatBrowser: false,
      shouldIssueDecisionCookie: true,
      shouldRoll: true,
      vetoReason: null,
    });
    expect(applyDiversionPercentageRoll(preRoll, 50)).toMatchObject({
      percentageRoll: 50,
      wouldDivert: true,
      selectedForDiversion: true,
    });
    expect(applyDiversionPercentageRoll(preRoll, 51)).toMatchObject({
      wouldDivert: false,
      selectedForDiversion: false,
    });
  });

  it("suppresses a valid repeat-cookie GET without rolling or issuing another cookie", () => {
    const preRoll = evaluateDiversionPreconditions(input({ hasValidDecisionCookie: true }));

    expect(preRoll).toMatchObject({
      diversionEligible: true,
      cookieEligible: true,
      repeatBrowser: true,
      shouldIssueDecisionCookie: false,
      shouldRoll: false,
    });
    expect(applyDiversionPercentageRoll(preRoll, 1)).toMatchObject({
      percentageRoll: null,
      wouldDivert: null,
      selectedForDiversion: false,
    });
  });

  it("can roll a non-GET eligible request but never reads or issues the browser cookie", () => {
    const preRoll = evaluateDiversionPreconditions(input({
      requestMethod: "POST",
      hasValidDecisionCookie: true,
    }));

    expect(preRoll).toMatchObject({
      diversionEligible: true,
      cookieEligible: false,
      repeatBrowser: false,
      shouldIssueDecisionCookie: false,
      shouldRoll: true,
    });
    expect(applyDiversionPercentageRoll(preRoll, 1).selectedForDiversion).toBe(true);
  });

  it("vetoes selected-country ordinary Android Chrome but not excluded Meta, Edge, or GSA UAs", () => {
    const quality = {
      countryQualityPolicy: activeBrazilPolicy,
      explicitCountryPercentages: { BR: 50 },
    } satisfies Partial<DiversionPolicyInput>;

    expect(evaluateDiversionPreconditions(input(quality))).toMatchObject({
      qualityCountryEnabled: true,
      qualityChromeVeto: true,
      diversionEligible: false,
      vetoReason: "country_quality",
    });
    for (const userAgent of [
      `${androidChrome} [FBAN/FB4A;FBAV/400.0]`,
      `${androidChrome} EdgA/124.0`,
      `${androidChrome} GSA/15.0`,
    ]) {
      expect(evaluateDiversionPreconditions(input({ ...quality, userAgent }))).toMatchObject({
        qualityCountryEnabled: true,
        qualityChromeVeto: false,
        diversionEligible: true,
      });
    }
  });

  it("does not apply all-country Quality Control to a default-only country percentage", () => {
    expect(evaluateDiversionPreconditions(input({
      country: "PH",
      explicitCountryPercentages: { BR: 50 },
      countryQualityPolicy: { active: true, scope: "all", countries: [] },
    }))).toMatchObject({
      percent: 50,
      hasExplicitCountryPercent: false,
      qualityCountryEnabled: false,
      qualityChromeVeto: false,
      diversionEligible: true,
    });
  });

  it("applies the low-yield veto before Quality Control", () => {
    expect(evaluateDiversionPreconditions(input({
      userAgent: `${androidChrome} SamsungBrowser/25.0`,
      countryQualityPolicy: activeBrazilPolicy,
      explicitCountryPercentages: { BR: 50 },
    }))).toMatchObject({
      lowYieldBrowser: true,
      qualityChromeVeto: false,
      diversionEligible: false,
      vetoReason: "low_yield_browser",
    });
  });

  it.each([
    [{ authorIsAdmin: true }, "admin_author"],
    [{ diversionEnabled: false }, "diversion_disabled"],
    [{ defaultCountryPercent: 0 }, "zero_percent"],
    [{ fbclid: undefined, referer: undefined }, "facebook_evidence_missing"],
    [{ diversionDestinationValid: false }, "invalid_diversion_destination"],
    [{ enforcedFilter: "meta" }, "filter_meta"],
    [{ enforcedFilter: "aws_dc" }, "filter_aws_dc"],
    [{ enforcedFilter: "fbclid_replay" }, "filter_fbclid_replay"],
  ] satisfies readonly (readonly [Partial<DiversionPolicyInput>, string])[])(
    "fails the required precondition with reason %s",
    (override, reason) => {
      expect(evaluateDiversionPreconditions(input(override))).toMatchObject({
        diversionEligible: false,
        vetoReason: reason,
      });
    },
  );

  it("preserves debug-only rolling without selecting an ineligible diversion", () => {
    const preRoll = evaluateDiversionPreconditions(input({
      diversionEnabled: false,
      debugEnabled: true,
    }));

    expect(preRoll).toMatchObject({ diversionEligible: false, shouldRoll: true });
    expect(applyDiversionPercentageRoll(preRoll, 1)).toMatchObject({
      wouldDivert: true,
      selectedForDiversion: false,
    });
  });

  it("rejects an invalid roll only when a roll is required", () => {
    expect(() => applyDiversionPercentageRoll(evaluateDiversionPreconditions(input()), 0)).toThrow(RangeError);
    expect(() => applyDiversionPercentageRoll(
      evaluateDiversionPreconditions(input({ hasValidDecisionCookie: true })),
      0,
    )).not.toThrow();
  });
});

function input(override: Partial<DiversionPolicyInput> = {}): DiversionPolicyInput {
  return {
    authorIsAdmin: false,
    diversionEnabled: true,
    debugEnabled: false,
    diversionDestinationValid: true,
    requestMethod: "GET",
    userAgent: androidChrome,
    fbclid: "campaign-token",
    referer: undefined,
    country: "BR",
    defaultCountryPercent: 50,
    explicitCountryPercentages: {},
    countryQualityControlActive: true,
    countryQualityPolicy: DEFAULT_COUNTRY_QUALITY_POLICY,
    lowYieldBrowserVetoActive: true,
    enforcedFilter: null,
    decisionCookieActive: true,
    hasValidDecisionCookie: false,
    ...override,
  };
}
