const countryCodes = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" "),
);

const metaInstagramPattern = /(?:^|[; (])Instagram(?:[/ ]|$)/i;
const metaMessengerPattern = /(?:^|[; (])(?:MESSENGER|Orca)(?:[/; )-]|$)/i;
const androidWebViewPattern = /(?:^|[; (])wv(?:[; )]|$)/i;

export type CountryQualityScope = "selected" | "all";

export interface CountryQualityPolicy {
  readonly active: boolean;
  readonly scope: CountryQualityScope;
  readonly countries: readonly string[];
}

export const DEFAULT_COUNTRY_QUALITY_POLICY: CountryQualityPolicy = {
  active: false,
  scope: "selected",
  countries: [],
};

export type EnforcedDiversionFilter = "meta" | "aws_dc" | "fbclid_replay";

export type DiversionVetoReason =
  | "admin_author"
  | "diversion_disabled"
  | "zero_percent"
  | "facebook_evidence_missing"
  | "invalid_diversion_destination"
  | "low_yield_browser"
  | "filter_meta"
  | "filter_aws_dc"
  | "filter_fbclid_replay"
  | "country_quality";

export interface DiversionPolicyInput {
  readonly authorIsAdmin: boolean;
  readonly diversionEnabled: boolean;
  readonly debugEnabled: boolean;
  readonly diversionDestinationValid: boolean;
  readonly requestMethod: string;
  readonly userAgent: string;
  readonly fbclid: string | undefined;
  readonly referer: string | undefined;
  readonly country: string | null;
  readonly defaultCountryPercent: number;
  readonly explicitCountryPercentages: Readonly<Record<string, number>>;
  readonly countryQualityControlActive: boolean;
  readonly countryQualityPolicy: CountryQualityPolicy;
  readonly lowYieldBrowserVetoActive: boolean;
  readonly enforcedFilter: EnforcedDiversionFilter | null;
  readonly decisionCookieActive: boolean;
  readonly hasValidDecisionCookie: boolean;
}

export interface DiversionPreRollDecision {
  readonly country: string | null;
  readonly percent: number;
  readonly hasExplicitCountryPercent: boolean;
  readonly facebookEvidence: boolean;
  readonly lowYieldBrowser: boolean;
  readonly qualityCountryEnabled: boolean;
  readonly qualityChromeVeto: boolean;
  readonly diversionEligible: boolean;
  readonly vetoReason: DiversionVetoReason | null;
  readonly cookieEligible: boolean;
  readonly repeatBrowser: boolean;
  readonly shouldIssueDecisionCookie: boolean;
  readonly shouldRoll: boolean;
}

export interface DiversionDecision extends DiversionPreRollDecision {
  readonly percentageRoll: number | null;
  readonly wouldDivert: boolean | null;
  readonly selectedForDiversion: boolean;
}

export interface CountryPercentage {
  readonly country: string | null;
  readonly percent: number;
  readonly explicit: boolean;
}

/** Missing, malformed, oversized, duplicate, or unknown-country state defaults Off. */
export function decodeCountryQualityPolicy(stored: unknown): CountryQualityPolicy {
  let value = stored;
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 4096) {
      return DEFAULT_COUNTRY_QUALITY_POLICY;
    }
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return DEFAULT_COUNTRY_QUALITY_POLICY;
    }
  }

  if (!isRecord(value)
    || typeof value.active !== "boolean"
    || (value.scope !== "selected" && value.scope !== "all")
    || !Array.isArray(value.countries)
    || value.countries.length > 250) {
    return DEFAULT_COUNTRY_QUALITY_POLICY;
  }

  const seen = new Set<string>();
  for (const country of value.countries) {
    if (typeof country !== "string") {
      return DEFAULT_COUNTRY_QUALITY_POLICY;
    }
    const code = normalizeCountryCode(country);
    if (code === null || seen.has(code)) {
      return DEFAULT_COUNTRY_QUALITY_POLICY;
    }
    seen.add(code);
  }

  return {
    active: value.active,
    scope: value.scope,
    countries: [...seen].sort(),
  };
}

export function isExplicitMetaAppUserAgent(userAgent: string): boolean {
  const normalized = userAgent.toLowerCase();
  return normalized.includes("fban/")
    || normalized.includes("fbav/")
    || normalized.includes("fb_iab")
    || normalized.includes("fb4a")
    || metaInstagramPattern.test(userAgent)
    || metaMessengerPattern.test(userAgent);
}

/** True only for ordinary Android Chrome-shaped traffic covered by Quality Control. */
export function isAndroidChromeQualityCandidate(userAgent: string): boolean {
  const normalized = userAgent.toLowerCase();
  return normalized.includes("android")
    && normalized.includes("chrome/")
    && !isExplicitMetaAppUserAgent(userAgent)
    && !androidWebViewPattern.test(userAgent)
    && !normalized.includes("version/4.0")
    && !normalized.includes("samsungbrowser/")
    && !normalized.includes("opr/")
    && !normalized.includes("opera")
    && !normalized.includes("edga/")
    && !normalized.includes("edg/")
    && !normalized.includes("gsa/");
}

/** Samsung and named Opera cohorts stay on the author destination; they are not bots. */
export function isLowYieldBrowserUserAgent(userAgent: string): boolean {
  const normalized = userAgent.toLowerCase();
  return normalized.includes("samsungbrowser/")
    || normalized.includes("opr/")
    || normalized.includes("opera mini/")
    || normalized.includes("opera mobi/")
    || normalized.includes("opera/");
}

/** Heuristic click evidence only; this is not cryptographic Facebook identity proof. */
export function hasFacebookClickEvidence(fbclid: string | undefined, referer: string | undefined): boolean {
  if (fbclid !== undefined && fbclid !== "") {
    return true;
  }
  const candidate = referer?.trim() ?? "";
  if (candidate === "") {
    return false;
  }
  try {
    const hostname = new URL(candidate).hostname.toLowerCase();
    return hostname === "facebook.com"
      || hostname.endsWith(".facebook.com")
      || hostname === "instagram.com"
      || hostname.endsWith(".instagram.com");
  } catch {
    return false;
  }
}

/** Resolve an explicit country row first, otherwise the per-domain default. */
export function resolveCountryPercentage(
  country: string | null,
  explicitCountryPercentages: Readonly<Record<string, number>>,
  defaultCountryPercent: number,
): CountryPercentage {
  const code = normalizeCountryCode(country);
  if (code !== null && hasOwn(explicitCountryPercentages, code)) {
    return {
      country: code,
      percent: normalizePercent(explicitCountryPercentages[code]),
      explicit: true,
    };
  }
  return {
    country: code,
    percent: normalizePercent(defaultCountryPercent),
    explicit: false,
  };
}

/** Quality Control applies only to a known country with an explicit positive row. */
export function isCountryQualityEnabled(
  policy: CountryQualityPolicy,
  percentage: CountryPercentage,
): boolean {
  if (!policy.active
    || percentage.country === null
    || percentage.percent <= 0
    || !percentage.explicit) {
    return false;
  }
  return policy.scope === "all" || policy.countries.includes(percentage.country);
}

/** Evaluate all current diversion preconditions without generating randomness or mutating cookies. */
export function evaluateDiversionPreconditions(input: DiversionPolicyInput): DiversionPreRollDecision {
  const percentage = resolveCountryPercentage(
    input.country,
    input.explicitCountryPercentages,
    input.defaultCountryPercent,
  );
  const facebookEvidence = hasFacebookClickEvidence(input.fbclid, input.referer);
  const lowYieldBrowser = input.lowYieldBrowserVetoActive
    && isLowYieldBrowserUserAgent(input.userAgent);
  const qualityCountryEnabled = input.countryQualityControlActive
    && isCountryQualityEnabled(input.countryQualityPolicy, percentage);
  const qualityChromeVeto = qualityCountryEnabled
    && isAndroidChromeQualityCandidate(input.userAgent);
  const diversionEligible = !input.authorIsAdmin
    && input.diversionEnabled
    && percentage.percent > 0
    && facebookEvidence
    && input.diversionDestinationValid
    && !lowYieldBrowser
    && input.enforcedFilter === null
    && !qualityChromeVeto;
  const cookieEligible = diversionEligible && input.requestMethod.toUpperCase() === "GET";
  const repeatBrowser = cookieEligible
    && input.decisionCookieActive
    && input.hasValidDecisionCookie;
  const shouldEvaluate = !input.authorIsAdmin && (input.diversionEnabled || input.debugEnabled);

  return {
    country: percentage.country,
    percent: percentage.percent,
    hasExplicitCountryPercent: percentage.explicit,
    facebookEvidence,
    lowYieldBrowser,
    qualityCountryEnabled,
    qualityChromeVeto,
    diversionEligible,
    vetoReason: diversionVetoReason(input, percentage.percent, facebookEvidence, lowYieldBrowser, qualityChromeVeto),
    cookieEligible,
    repeatBrowser,
    shouldIssueDecisionCookie: cookieEligible && input.decisionCookieActive && !repeatBrowser,
    shouldRoll: shouldEvaluate && (input.debugEnabled || (diversionEligible && !repeatBrowser)),
  };
}

/** Apply PHP-compatible inclusive 1..100 percentage semantics to a pre-roll decision. */
export function applyDiversionPercentageRoll(
  decision: DiversionPreRollDecision,
  percentageRoll: number | null,
): DiversionDecision {
  if (!decision.shouldRoll) {
    return {
      ...decision,
      percentageRoll: null,
      wouldDivert: null,
      selectedForDiversion: false,
    };
  }
  if (!Number.isInteger(percentageRoll) || percentageRoll === null || percentageRoll < 1 || percentageRoll > 100) {
    throw new RangeError("percentageRoll must be an integer from 1 through 100 when shouldRoll is true");
  }
  const wouldDivert = decision.percent > 0 && percentageRoll <= decision.percent;
  return {
    ...decision,
    percentageRoll,
    wouldDivert,
    selectedForDiversion: decision.diversionEligible && !decision.repeatBrowser && wouldDivert,
  };
}

function diversionVetoReason(
  input: DiversionPolicyInput,
  percent: number,
  facebookEvidence: boolean,
  lowYieldBrowser: boolean,
  qualityChromeVeto: boolean,
): DiversionVetoReason | null {
  if (input.authorIsAdmin) return "admin_author";
  if (!input.diversionEnabled) return "diversion_disabled";
  if (percent <= 0) return "zero_percent";
  if (!facebookEvidence) return "facebook_evidence_missing";
  if (!input.diversionDestinationValid) return "invalid_diversion_destination";
  if (lowYieldBrowser) return "low_yield_browser";
  if (input.enforcedFilter !== null) return `filter_${input.enforcedFilter}`;
  if (qualityChromeVeto) return "country_quality";
  return null;
}

function normalizeCountryCode(country: string | null): string | null {
  if (country === null) {
    return null;
  }
  const code = country.trim().toUpperCase();
  return countryCodes.has(code) ? code : null;
}

function normalizePercent(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.trunc(value)));
}

function hasOwn(record: Readonly<Record<string, number>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
