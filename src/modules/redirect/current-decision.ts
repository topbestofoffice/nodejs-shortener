import { createHmac, timingSafeEqual } from "node:crypto";
import {
  applyDiversionPercentageRoll,
  decodeCountryQualityPolicy,
  evaluateDiversionPreconditions,
  isLowYieldBrowserUserAgent,
  type DiversionPreRollDecision,
  type EnforcedDiversionFilter,
} from "./policy.js";

export const DIVERSION_DECISION_COOKIE_NAME = "__Host-diversion_seen";

export interface CurrentDecisionConfig {
  readonly metaEnforce: boolean;
  readonly datacenterActive: boolean;
  readonly datacenterEnforce: boolean;
  readonly datacenterBlock: boolean;
  readonly replayActive: boolean;
  readonly replayEnforce: boolean;
  readonly replayBlock: boolean;
  readonly replayWindowSeconds: number;
  readonly replayMinimumTotal: number;
  readonly replayMinimumToken: number;
  readonly replayBlockMinimumTotal: number;
  readonly replayBlockMinimumToken: number;
  readonly replayTokenFieldCap: number;
  readonly decisionCookieActive: boolean;
  readonly decisionCookieTtlSeconds: number;
  readonly decisionCookieFutureSkewSeconds: number;
  readonly lowYieldBrowserVetoActive: boolean;
  readonly countryQualityControlActive: boolean;
}

export const CURRENT_DECISION_CONFIG: CurrentDecisionConfig = {
  metaEnforce: true,
  datacenterActive: true,
  datacenterEnforce: true,
  datacenterBlock: true,
  replayActive: true,
  replayEnforce: true,
  replayBlock: true,
  replayWindowSeconds: 7200,
  replayMinimumTotal: 30,
  replayMinimumToken: 10,
  replayBlockMinimumTotal: 50,
  replayBlockMinimumToken: 50,
  replayTokenFieldCap: 8,
  decisionCookieActive: true,
  decisionCookieTtlSeconds: 3600,
  decisionCookieFutureSkewSeconds: 60,
  lowYieldBrowserVetoActive: true,
  countryQualityControlActive: true,
};

export interface CurrentBaseSettings {
  readonly skimEnabled: boolean;
  readonly debugEnabled: boolean;
}

export interface CurrentDiversionContext {
  readonly skimDestinationUrl: string;
  readonly country: string | null;
  readonly defaultCountryPercent: number;
  readonly explicitCountryPercentages: Readonly<Record<string, number>>;
  readonly countryQualityPolicy: unknown;
}

export interface DatacenterClassificationInput {
  readonly clientIp: string;
  readonly isCrawler: boolean;
  readonly metaNetwork: boolean;
}

export interface ReplayDetectionInput {
  readonly token: string;
  readonly clientIp: string;
  readonly domainId: number;
  readonly windowSeconds: number;
  readonly minimumTotal: number;
  readonly minimumToken: number;
  readonly tokenFieldCap: number;
}

export interface ReplayDetection {
  readonly detected: boolean;
  readonly total: number;
  readonly token: number;
}

export interface DiversionContextInput {
  readonly domainId: number;
  readonly clientIp: string;
  /** Country accepted only by the verified request-identity boundary, when available. */
  readonly trustedCountry?: string | null;
}

export interface CurrentDecisionProvider {
  getBaseSettings(domainId: number): Promise<CurrentBaseSettings>;
  isMetaNetwork(clientIp: string): Promise<boolean>;
  isDatacenterBot(input: DatacenterClassificationInput): Promise<boolean>;
  detectReplay(input: ReplayDetectionInput): Promise<ReplayDetection>;
  getDiversionContext(input: DiversionContextInput): Promise<CurrentDiversionContext>;
}

export interface DecisionClock {
  now(): Date;
}

export interface CurrentDecisionInput {
  readonly domainId: number;
  readonly domainBaseUrl: string;
  readonly authorDestination: string;
  readonly authorRole: string;
  readonly diversionCampaign: string;
  readonly clientIp: string;
  readonly trustedCountry?: string | null;
  readonly method: string;
  readonly userAgent: string;
  readonly isCrawler: boolean;
  readonly fbclid: string | undefined;
  readonly referer: string | undefined;
  readonly decisionCookieValue: string | undefined;
}

export type CurrentFilterReason = EnforcedDiversionFilter;
export type CurrentBlockReason = "aws_dc" | "fbclid_replay";
export type ClassificationFailure = "meta" | "aws_dc" | "fbclid_replay";
export type FailAuthorStage =
  | "base_settings"
  | "diversion_context"
  | "cookie"
  | "percentage_roll"
  | "attribution";

export interface DecisionCookieIntent {
  readonly name: typeof DIVERSION_DECISION_COOKIE_NAME;
  readonly value: string;
  readonly expires: Date;
  readonly path: "/";
  readonly secure: true;
  readonly httpOnly: true;
  readonly sameSite: "Lax";
}

export interface CurrentDecisionResult {
  readonly target: string;
  readonly diverted: boolean;
  readonly skimEnabled: boolean;
  readonly debugEnabled: boolean;
  readonly dynamicDiversionEnabled: boolean;
  readonly redirectStatus: 301 | 302;
  readonly observedFilterReason: CurrentFilterReason | null;
  readonly filterReason: CurrentFilterReason | null;
  readonly shadowReason: CurrentFilterReason | null;
  readonly block: CurrentBlockReason | null;
  readonly classificationFailures: readonly ClassificationFailure[];
  /** Trusted request-header country only. Never populated from routing fallback GeoIP. */
  readonly reportCountry?: string | null;
  readonly country: string | null;
  readonly countryResolved: boolean;
  readonly percent: number | null;
  readonly percentageRoll: number | null;
  readonly wouldDivert: boolean | null;
  readonly diversionEligible: boolean;
  readonly repeatBrowser: boolean;
  readonly facebookEvidence: boolean | null;
  readonly lowYieldBrowser: boolean;
  readonly qualityChromeVeto: boolean;
  readonly decisionCookie: DecisionCookieIntent | null;
  readonly failAuthorStage: FailAuthorStage | null;
}

export interface CurrentDecisionCoreOptions {
  readonly provider: CurrentDecisionProvider;
  readonly clock: DecisionClock;
  readonly roll: () => number;
  readonly cookieSecret: string;
  readonly config?: Partial<CurrentDecisionConfig>;
}

interface ClassificationResult {
  readonly observedFilterReason: CurrentFilterReason | null;
  readonly filterReason: CurrentFilterReason | null;
  readonly shadowReason: CurrentFilterReason | null;
  readonly block: CurrentBlockReason | null;
  readonly failures: readonly ClassificationFailure[];
}

interface PartialDecisionState {
  readonly base: CurrentBaseSettings;
  readonly classification: ClassificationResult;
  readonly reportCountry: string | null;
  readonly country: string | null;
  readonly countryResolved: boolean;
  readonly preRoll: DiversionPreRollDecision | null;
  readonly percentageRoll: number | null;
  readonly wouldDivert: boolean | null;
  readonly decisionCookie: DecisionCookieIntent | null;
  readonly failAuthorStage: FailAuthorStage | null;
}

export class CurrentDecisionCore {
  readonly #provider: CurrentDecisionProvider;
  readonly #clock: DecisionClock;
  readonly #roll: () => number;
  readonly #cookieSecret: string;
  readonly #config: CurrentDecisionConfig;

  public constructor(options: CurrentDecisionCoreOptions) {
    this.#provider = options.provider;
    this.#clock = options.clock;
    this.#roll = options.roll;
    this.#cookieSecret = options.cookieSecret;
    this.#config = { ...CURRENT_DECISION_CONFIG, ...options.config };
  }

  public async decide(input: CurrentDecisionInput): Promise<CurrentDecisionResult> {
    let base: CurrentBaseSettings;
    let baseFailure: FailAuthorStage | null = null;
    try {
      base = await this.#provider.getBaseSettings(input.domainId);
    } catch {
      base = { skimEnabled: false, debugEnabled: false };
      baseFailure = "base_settings";
    }

    const classification = await this.#classify(input);
    const authorIsAdmin = input.authorRole === "admin";
    const reportCountry = input.trustedCountry ?? null;
    const initial: PartialDecisionState = {
      base,
      classification,
      // The current PHP accounting-only path preserves a trusted country
      // header for filtered requests even when skim/debug is disabled or the
      // author is exempt. This does not trigger a geo-cache or external lookup.
      reportCountry,
      country: reportCountry,
      countryResolved: reportCountry !== null,
      preRoll: null,
      percentageRoll: null,
      wouldDivert: null,
      decisionCookie: null,
      failAuthorStage: baseFailure,
    };

    if (authorIsAdmin || (!base.skimEnabled && !base.debugEnabled)) {
      return this.#authorResult(input, initial);
    }

    let context: CurrentDiversionContext;
    try {
      context = await this.#provider.getDiversionContext({
        domainId: input.domainId,
        clientIp: input.clientIp,
        ...(input.trustedCountry === undefined ? {} : { trustedCountry: input.trustedCountry }),
      });
    } catch {
      return this.#authorResult(input, {
        ...initial,
        failAuthorStage: "diversion_context",
      });
    }

    const decisionInput = {
      authorIsAdmin,
      diversionEnabled: base.skimEnabled,
      debugEnabled: base.debugEnabled,
      diversionDestinationValid: isValidHttpUrl(context.skimDestinationUrl),
      requestMethod: input.method,
      userAgent: input.userAgent,
      fbclid: input.fbclid,
      referer: input.referer,
      country: context.country,
      defaultCountryPercent: context.defaultCountryPercent,
      explicitCountryPercentages: context.explicitCountryPercentages,
      countryQualityControlActive: this.#config.countryQualityControlActive,
      countryQualityPolicy: decodeCountryQualityPolicy(context.countryQualityPolicy),
      lowYieldBrowserVetoActive: this.#config.lowYieldBrowserVetoActive,
      enforcedFilter: classification.filterReason,
      decisionCookieActive: this.#config.decisionCookieActive,
      hasValidDecisionCookie: false,
    } as const;

    let preRoll = evaluateDiversionPreconditions(decisionInput);
    if (preRoll.cookieEligible && this.#config.decisionCookieActive) {
      try {
        const validCookie = isDiversionDecisionCookieValid({
          value: input.decisionCookieValue,
          domainBaseUrl: input.domainBaseUrl,
          secret: this.#cookieSecret,
          nowSeconds: epochSeconds(this.#clock.now()),
          ttlSeconds: this.#config.decisionCookieTtlSeconds,
          futureSkewSeconds: this.#config.decisionCookieFutureSkewSeconds,
        });
        if (validCookie) {
          preRoll = evaluateDiversionPreconditions({
            ...decisionInput,
            hasValidDecisionCookie: true,
          });
        }
      } catch {
        return this.#authorResult(input, {
          ...initial,
          country: context.country,
          countryResolved: true,
          preRoll,
          failAuthorStage: "cookie",
        });
      }
    }

    let rolled;
    try {
      rolled = applyDiversionPercentageRoll(preRoll, preRoll.shouldRoll ? this.#roll() : null);
    } catch {
      return this.#authorResult(input, {
        ...initial,
        country: context.country,
        countryResolved: true,
        preRoll,
        failAuthorStage: "percentage_roll",
      });
    }

    let decisionCookie: DecisionCookieIntent | null = null;
    if (preRoll.shouldIssueDecisionCookie) {
      try {
        decisionCookie = createDiversionDecisionCookie({
          domainBaseUrl: input.domainBaseUrl,
          secret: this.#cookieSecret,
          nowSeconds: epochSeconds(this.#clock.now()),
          ttlSeconds: this.#config.decisionCookieTtlSeconds,
        });
      } catch {
        return this.#authorResult(input, {
          ...initial,
          country: context.country,
          countryResolved: true,
          preRoll,
          percentageRoll: rolled.percentageRoll,
          wouldDivert: rolled.wouldDivert,
          failAuthorStage: "cookie",
        });
      }
    }

    const completed: PartialDecisionState = {
      ...initial,
      country: context.country,
      countryResolved: true,
      preRoll,
      percentageRoll: rolled.percentageRoll,
      wouldDivert: rolled.wouldDivert,
      decisionCookie,
      failAuthorStage: null,
    };
    if (!rolled.selectedForDiversion) {
      return this.#authorResult(input, completed);
    }

    try {
      const target = buildDiversionUrlWithAttribution(
        context.skimDestinationUrl,
        input.authorDestination,
        input.diversionCampaign,
      );
      return this.#result(input, completed, target, true);
    } catch {
      return this.#authorResult(input, {
        ...completed,
        failAuthorStage: "attribution",
      });
    }
  }

  async #classify(input: CurrentDecisionInput): Promise<ClassificationResult> {
    const failures: ClassificationFailure[] = [];
    const metaNetwork = await failOpen(
      () => this.#provider.isMetaNetwork(input.clientIp),
      () => failures.push("meta"),
    );
    const datacenter = this.#config.datacenterActive
      ? await failOpen(
        () => this.#provider.isDatacenterBot({
          clientIp: input.clientIp,
          isCrawler: input.isCrawler,
          metaNetwork,
        }),
        () => failures.push("aws_dc"),
      )
      : false;

    let replay: ReplayDetection = { detected: false, total: 0, token: 0 };
    if (this.#config.replayActive && !metaNetwork && !datacenter) {
      replay = await failOpenReplay(
        () => this.#provider.detectReplay({
          token: input.fbclid?.trim() ?? "",
          clientIp: input.clientIp,
          domainId: input.domainId,
          windowSeconds: this.#config.replayWindowSeconds,
          minimumTotal: this.#config.replayMinimumTotal,
          minimumToken: this.#config.replayMinimumToken,
          tokenFieldCap: this.#config.replayTokenFieldCap,
        }),
        () => failures.push("fbclid_replay"),
      );
    }

    const observedFilterReason: CurrentFilterReason | null = metaNetwork
      ? "meta"
      : datacenter
        ? "aws_dc"
        : replay.detected
          ? "fbclid_replay"
          : null;
    const filterReason: CurrentFilterReason | null = metaNetwork && this.#config.metaEnforce
      ? "meta"
      : datacenter && this.#config.datacenterEnforce
        ? "aws_dc"
        : replay.detected && this.#config.replayEnforce
          ? "fbclid_replay"
          : null;
    const replayHardBlock = replay.detected
      && this.#config.replayEnforce
      && this.#config.replayBlock
      && replay.total >= this.#config.replayBlockMinimumTotal
      && replay.token >= this.#config.replayBlockMinimumToken;
    const block: CurrentBlockReason | null = replayHardBlock
      ? "fbclid_replay"
      : datacenter && this.#config.datacenterEnforce && this.#config.datacenterBlock
        ? "aws_dc"
        : null;

    return {
      observedFilterReason,
      filterReason,
      shadowReason: filterReason === null ? observedFilterReason : null,
      block,
      failures,
    };
  }

  #authorResult(input: CurrentDecisionInput, state: PartialDecisionState): CurrentDecisionResult {
    return this.#result(input, state, input.authorDestination, false);
  }

  #result(
    input: CurrentDecisionInput,
    state: PartialDecisionState,
    target: string,
    diverted: boolean,
  ): CurrentDecisionResult {
    const authorIsAdmin = input.authorRole === "admin";
    return {
      target,
      diverted,
      skimEnabled: state.base.skimEnabled,
      debugEnabled: state.base.debugEnabled,
      dynamicDiversionEnabled: state.base.skimEnabled,
      redirectStatus: !state.base.skimEnabled || authorIsAdmin ? 301 : 302,
      observedFilterReason: state.classification.observedFilterReason,
      filterReason: state.classification.filterReason,
      shadowReason: state.classification.shadowReason,
      block: state.classification.block,
      classificationFailures: state.classification.failures,
      reportCountry: state.reportCountry,
      country: state.country,
      countryResolved: state.countryResolved,
      percent: state.preRoll?.percent ?? null,
      percentageRoll: state.percentageRoll,
      wouldDivert: state.wouldDivert,
      diversionEligible: state.preRoll?.diversionEligible ?? false,
      repeatBrowser: state.preRoll?.repeatBrowser ?? false,
      facebookEvidence: state.preRoll?.facebookEvidence ?? null,
      lowYieldBrowser: state.preRoll?.lowYieldBrowser
        ?? (this.#config.lowYieldBrowserVetoActive && isLowYieldBrowserUserAgent(input.userAgent)),
      qualityChromeVeto: state.preRoll?.qualityChromeVeto ?? false,
      decisionCookie: state.decisionCookie,
      failAuthorStage: state.failAuthorStage,
    };
  }
}

export interface CookieValidationInput {
  readonly value: string | undefined;
  readonly domainBaseUrl: string;
  readonly secret: string;
  readonly nowSeconds: number;
  readonly ttlSeconds?: number;
  readonly futureSkewSeconds?: number;
}

export function isDiversionDecisionCookieValid(input: CookieValidationInput): boolean {
  const value = input.value;
  if (value === undefined || value.length > 80) {
    return false;
  }
  const match = /^([1-9][0-9]{9})\.([a-f0-9]{64})$/.exec(value);
  if (match === null) {
    return false;
  }
  const suppliedSignature = match[2];
  if (suppliedSignature === undefined) {
    return false;
  }
  const expiresAt = Number(match[1]);
  const ttlSeconds = input.ttlSeconds ?? CURRENT_DECISION_CONFIG.decisionCookieTtlSeconds;
  const futureSkewSeconds = input.futureSkewSeconds
    ?? CURRENT_DECISION_CONFIG.decisionCookieFutureSkewSeconds;
  if (!Number.isSafeInteger(input.nowSeconds)
    || !Number.isSafeInteger(ttlSeconds)
    || !Number.isSafeInteger(futureSkewSeconds)
    || ttlSeconds < 1
    || futureSkewSeconds < 0
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= input.nowSeconds
    || expiresAt > input.nowSeconds + ttlSeconds + futureSkewSeconds) {
    return false;
  }
  const expected = decisionCookieSignature(input.domainBaseUrl, expiresAt, input.secret);
  return timingSafeEqual(Buffer.from(expected, "ascii"), Buffer.from(suppliedSignature, "ascii"));
}

export interface CookieCreationInput {
  readonly domainBaseUrl: string;
  readonly secret: string;
  readonly nowSeconds: number;
  readonly ttlSeconds?: number;
}

export function createDiversionDecisionCookie(input: CookieCreationInput): DecisionCookieIntent {
  const ttlSeconds = input.ttlSeconds ?? CURRENT_DECISION_CONFIG.decisionCookieTtlSeconds;
  const expiresAt = input.nowSeconds + ttlSeconds;
  if (!Number.isSafeInteger(input.nowSeconds)
    || !Number.isSafeInteger(ttlSeconds)
    || input.nowSeconds < 0
    || ttlSeconds < 1) {
    throw new RangeError("Cookie time and TTL must be positive safe integers");
  }
  return {
    name: DIVERSION_DECISION_COOKIE_NAME,
    value: `${expiresAt}.${decisionCookieSignature(input.domainBaseUrl, expiresAt, input.secret)}`,
    expires: new Date(expiresAt * 1000),
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  };
}

export function diversionAttributionValue(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const digitCount = normalized.match(/[0-9]/g)?.length ?? 0;
  if (normalized === ""
    || Buffer.byteLength(normalized, "utf8") > 32
    || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(normalized)
    || !/[a-z]/.test(normalized)
    || digitCount >= 7
    || /^[0-9a-f]{24,32}$/.test(normalized)
    || (Buffer.byteLength(normalized, "utf8") >= 20
      && !/[._-]/.test(normalized)
      && /[0-9]/.test(normalized))) {
    return null;
  }
  return normalized;
}

export function buildDiversionUrlWithAttribution(
  skimUrl: string,
  authorDestination: string,
  campaign: string,
): string {
  const normalizedCampaign = campaign.trim();
  if (!/^[a-z0-9_-]{1,32}$/.test(normalizedCampaign)) {
    throw new Error("Domain campaign is invalid");
  }
  if (skimUrl.includes("#")) {
    return skimUrl;
  }

  const sourceValues: string[] = [];
  const mediumValues: string[] = [];
  const rawQuery = rawUrlQuery(authorDestination);
  if (rawQuery !== "" && Buffer.byteLength(rawQuery, "utf8") <= 2048) {
    for (const part of rawQuery.split("&")) {
      const separator = part.indexOf("=");
      const rawName = separator === -1 ? part : part.slice(0, separator);
      const rawValue = separator === -1 ? "" : part.slice(separator + 1);
      const name = phpUrlDecode(rawName);
      if (name === "utm_source") {
        sourceValues.push(phpUrlDecode(rawValue));
      } else if (name === "utm_medium") {
        mediumValues.push(phpUrlDecode(rawValue));
      }
    }
  }

  let source = sourceValues.length === 1 ? diversionAttributionValue(sourceValues[0] ?? "") : null;
  let medium = mediumValues.length === 1 ? diversionAttributionValue(mediumValues[0] ?? "") : null;
  if (source === null || medium === null) {
    source = "div2";
    medium = "div2";
  }
  const query = `utm_source=${encodeURIComponent(source)}`
    + `&utm_medium=${encodeURIComponent(medium)}`
    + `&utm_campaign=${encodeURIComponent(normalizedCampaign)}`;
  return `${skimUrl}${skimUrl.includes("?") ? "&" : "?"}${query}`;
}

function decisionCookieSignature(domainBaseUrl: string, expiresAt: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`diversion-seen-v1|${domainBaseUrl}|${expiresAt}`)
    .digest("hex");
}

function rawUrlQuery(value: string): string {
  try {
    const url = new URL(value);
    return url.search.startsWith("?") ? url.search.slice(1) : "";
  } catch {
    return "";
  }
}

function phpUrlDecode(value: string): string {
  return value
    .replace(/\+/g, " ")
    .replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function epochSeconds(value: Date): number {
  const seconds = Math.floor(value.getTime() / 1000);
  if (!Number.isSafeInteger(seconds)) {
    throw new RangeError("Clock returned an invalid date");
  }
  return seconds;
}

async function failOpen(operation: () => Promise<boolean>, onFailure: () => void): Promise<boolean> {
  try {
    return await operation();
  } catch {
    onFailure();
    return false;
  }
}

async function failOpenReplay(
  operation: () => Promise<ReplayDetection>,
  onFailure: () => void,
): Promise<ReplayDetection> {
  try {
    const result = await operation();
    return {
      detected: result.detected,
      total: nonNegativeInteger(result.total),
      token: nonNegativeInteger(result.token),
    };
  } catch {
    onFailure();
    return { detected: false, total: 0, token: 0 };
  }
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}
