import type { FilterReason, LinkRecord } from "../../core/types.js";
import type { DecisionCookieIntent } from "./current-decision.js";

const previewCrawlerPattern = /facebookexternalhit|facebot|meta-externalagent|meta-externalfetcher|meta-externalads|twitterbot|whatsapp|linkedinbot|slackbot|telegrambot|discordbot|pinterest|redditbot|skypeuripreview|embedly|vkshare|tumblr|flipboard/i;
const genericBotPattern = /googlebot|bingbot|applebot|meta-externalagent|meta-externalfetcher|headlesschrome|phantomjs|puppeteer|playwright|python-requests|python-urllib|libwww-perl|curl\/|wget\/|go-http-client|java\/|okhttp|axios|node-fetch|httpclient|scrapy|httpie|dataprovider|monitoring|uptime|bot\b|crawler|spider/i;

export function isPreviewCrawler(userAgent: string): boolean {
  return userAgent.trim().length > 0 && previewCrawlerPattern.test(userAgent);
}

export function isGenericBot(userAgent: string): boolean {
  return userAgent.trim().length === 0 || isPreviewCrawler(userAgent) || genericBotPattern.test(userAgent);
}

export interface RedirectDecisionInput {
  readonly link: LinkRecord;
  readonly ip: string;
  readonly country?: string | null;
  readonly method: string;
  readonly userAgent: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface RedirectDecision {
  readonly target: string;
  readonly diverted: boolean;
  readonly filterReason: FilterReason | null;
  /** Trusted-header-only country for reporting; routing may use a fallback country. */
  readonly reportCountry: string | null;
  readonly country: string | null;
  readonly dynamicDiversionEnabled: boolean;
  readonly block: "aws_dc" | "fbclid_replay" | null;
  readonly decisionCookie?: DecisionCookieIntent | null;
}

export interface RedirectDecisionEngine {
  decide(input: RedirectDecisionInput): Promise<RedirectDecision>;
}

export class PassThroughDecisionEngine implements RedirectDecisionEngine {
  public async decide(input: RedirectDecisionInput): Promise<RedirectDecision> {
    return {
      target: input.link.destination,
      diverted: false,
      filterReason: null,
      reportCountry: null,
      country: null,
      dynamicDiversionEnabled: false,
      block: null,
    };
  }
}
