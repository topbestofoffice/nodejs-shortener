import type { DomainRegistry } from "../../config/domain-registry.js";
import type { RedirectDecision, RedirectDecisionEngine, RedirectDecisionInput } from "./classification.js";
import { isGenericBot } from "./classification.js";
import {
  DIVERSION_DECISION_COOKIE_NAME,
  type CurrentDecisionCore,
  type CurrentDecisionResult,
  type DecisionCookieIntent,
} from "./current-decision.js";

export interface CurrentRedirectDecision extends RedirectDecision {
  readonly decisionCookie: DecisionCookieIntent | null;
  /** Safe structured detail for private diagnostics; it contains no raw IP or cookie. */
  readonly observed: Omit<CurrentDecisionResult, "target" | "decisionCookie">;
}

/**
 * HTTP-neutral adapter from the exact-current decision core to RedirectService.
 * Set-Cookie transport remains the route layer's responsibility.
 */
export class CurrentRedirectDecisionEngine implements RedirectDecisionEngine {
  public constructor(
    private readonly core: CurrentDecisionCore,
    private readonly registry: DomainRegistry,
  ) {}

  public async decide(input: RedirectDecisionInput): Promise<CurrentRedirectDecision> {
    const domain = this.registry.byId(input.link.domainId);
    if (domain === undefined || domain.canonicalHost !== input.link.domainHostname) {
      throw new Error("Current redirect decision received an unknown or mismatched domain.");
    }

    const result = await this.core.decide({
      domainId: input.link.domainId,
      domainBaseUrl: domain.publicBaseUrl,
      authorDestination: input.link.destination,
      authorRole: input.link.authorRole,
      diversionCampaign: input.link.diversionCampaign,
      clientIp: input.ip,
      trustedCountry: input.country ?? null,
      method: input.method,
      userAgent: input.userAgent,
      isCrawler: isGenericBot(input.userAgent),
      fbclid: input.query.fbclid,
      referer: input.headers.referer,
      decisionCookieValue: readCookie(input.headers.cookie, DIVERSION_DECISION_COOKIE_NAME),
    });

    const observed = observedDecision(result);
    return {
      target: result.target,
      diverted: result.diverted,
      filterReason: result.filterReason,
      reportCountry: result.reportCountry ?? null,
      country: result.country,
      dynamicDiversionEnabled: result.dynamicDiversionEnabled,
      block: result.block,
      decisionCookie: result.decisionCookie,
      observed,
    };
  }
}

function observedDecision(result: CurrentDecisionResult): Omit<CurrentDecisionResult, "target" | "decisionCookie"> {
  const copy: Record<string, unknown> = { ...result };
  delete copy.target;
  delete copy.decisionCookie;
  return copy as unknown as Omit<CurrentDecisionResult, "target" | "decisionCookie">;
}

/** Return one unambiguous named cookie; duplicate or malformed state is ignored. */
export function readCookie(rawCookie: string | undefined, name: string): string | undefined {
  if (rawCookie === undefined || rawCookie.length === 0 || rawCookie.length > 8_192
    || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(name)) {
    return undefined;
  }
  let value: string | undefined;
  for (const segment of rawCookie.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    const candidateName = segment.slice(0, separator).trim();
    if (candidateName !== name) continue;
    const candidateValue = segment.slice(separator + 1).trim();
    if (value !== undefined || candidateValue.length === 0 || candidateValue.length > 256
      || candidateValue.includes(",") || containsControlCharacter(candidateValue)) {
      return undefined;
    }
    value = candidateValue;
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
