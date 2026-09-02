import { createHash } from "node:crypto";
import { z } from "zod";
import type { DomainContext, LinkRecord } from "../../core/types.js";
import { normalizeHttpDestination } from "../../core/http-destination.js";
import type { ApplicationStores, ClaimResult, Clock } from "../../ports.js";
import { isGenericBot, isPreviewCrawler, type RedirectDecisionEngine } from "./classification.js";
import { renderOpenGraphPreview, type ImageMetadataReader } from "./preview.js";
import type { DecisionCookieIntent } from "./current-decision.js";

const cachedLinkSchema = z.object({
  id: z.string().regex(/^[1-9][0-9]*$/),
  domainId: z.number().int().positive(),
  code: z.string(),
  userId: z.number().int().positive(),
  destination: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  image: z.string().nullable(),
  compactActivityTracked: z.boolean(),
  authorRole: z.string(),
  domainHostname: z.string(),
  domainLabel: z.string(),
  diversionCampaign: z.string(),
  createdAt: z.coerce.date(),
});

export type RedirectResult =
  | { readonly kind: "not_found" }
  | { readonly kind: "preview"; readonly html: string }
  | {
      readonly kind: "redirect";
      readonly location: string;
      readonly statusCode: 301 | 302;
      readonly decisionCookie: DecisionCookieIntent | null;
    }
  | { readonly kind: "blocked"; readonly reason: "aws_dc" | "fbclid_replay" };

export interface RedirectRequestInput {
  readonly context: DomainContext;
  readonly code: string;
  readonly ip: string;
  readonly country?: string | null;
  readonly method: string;
  readonly userAgent: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface RedirectServiceOptions {
  readonly appNamespace: string;
  readonly ipHashSecret: string;
  readonly stores: ApplicationStores;
  readonly clock: Clock;
  readonly decisions: RedirectDecisionEngine;
  readonly metadataReader: ImageMetadataReader;
}

export class RedirectService {
  public constructor(private readonly options: RedirectServiceOptions) {}

  public async handle(input: RedirectRequestInput): Promise<RedirectResult> {
    if (!/^[A-Za-z0-9]{1,32}$/.test(input.code)) {
      return { kind: "not_found" };
    }

    const link = await this.#getLink(input.context, input.code);
    if (link === null) {
      return { kind: "not_found" };
    }

    if (isPreviewCrawler(input.userAgent)) {
      const ogKey = this.#key(`domain:${link.domainId}:og:${link.code}`);
      const cached = await this.#safeCacheGet(ogKey);
      if (cached !== null) {
        return { kind: "preview", html: cached };
      }
      const html = await renderOpenGraphPreview(link, input.context.definition, this.options.metadataReader);
      await this.#bestEffort(() => this.options.stores.cache.set(ogKey, html, 60));
      return { kind: "preview", html };
    }

    if (isGenericBot(input.userAgent)) {
      return { kind: "redirect", location: link.destination, statusCode: 301, decisionCookie: null };
    }

    let decision;
    try {
      decision = await this.options.decisions.decide({
        link,
        ip: input.ip,
        ...(input.country === undefined ? {} : { country: input.country }),
        method: input.method,
        userAgent: input.userAgent,
        query: input.query,
        headers: input.headers,
      });
    } catch {
      decision = {
        target: link.destination,
        diverted: false,
        filterReason: null,
        reportCountry: null,
        country: null,
        dynamicDiversionEnabled: false,
        block: null,
      } as const;
    }

    const ipHash = createHash("sha256").update(`${input.ip}|${this.options.ipHashSecret}`).digest("hex");
    const claimKey = this.#key(`click-dedup:v1:d${link.domainId}:l${link.id}:h${ipHash}`);
    let claim: ClaimResult;
    try {
      claim = await this.options.stores.claims.claim(claimKey, 15);
    } catch {
      claim = "unavailable";
    }
    if (claim !== "duplicate") {
      const outcome = decision.filterReason === "meta"
        ? "filtered_meta"
        : decision.filterReason === "aws_dc" || decision.filterReason === "fbclid_replay"
          ? "filtered_bot"
          : decision.filterReason !== null
            ? "filtered_other"
            : decision.diverted
              ? "diverted"
              : "delivered";
      const accountingCountry = decision.reportCountry;
      const trustedReportCountry = decision.reportCountry;
      const occurredAt = this.options.clock.now();
      let accountingSucceeded = false;
      try {
        await this.options.stores.accounting.record({
          linkId: link.id,
          domainId: link.domainId,
          outcome,
          country: accountingCountry,
          occurredAt,
          trackRecentActivity: link.compactActivityTracked === true
            || (link.image?.startsWith("uploads/") ?? false),
        });
        accountingSucceeded = true;
      } catch {
        // Accounting remains fail-open for the redirect, but an enabled
        // Delivered observer must latch the missing business outcome.
      }

      const observer = this.options.stores.deliveredCountryObserver;
      let observerEnabled = false;
      if (outcome === "delivered" && observer !== undefined) {
        try {
          observerEnabled = observer.isEnabled(link.domainId);
        } catch {
          await this.#markDeliveredGap(link.domainId, occurredAt, "config");
        }
      }
      if (outcome === "delivered" && observerEnabled && observer !== undefined) {
        if (!accountingSucceeded) {
          await this.#markDeliveredGap(link.domainId, occurredAt, "accounting");
        } else if (claim === "winner"
          || (input.context.definition.acceptUnprovenDeliveredClaim && claim === "unavailable")) {
          try {
            await observer.observe({
              domainId: link.domainId,
              country: trustedReportCountry,
              occurredAt,
            });
          } catch {
            await this.#markDeliveredGap(link.domainId, occurredAt, "observer");
          }
        } else {
          // Domains that do not accept unproved fail-open claims retain the
          // true-only collector rule. Token-owned lost replies are winners;
          // an unproved claim latches the generation instead of entering it.
          await this.#markDeliveredGap(link.domainId, occurredAt, "claim");
        }
      }
    }

    if (decision.block !== null) {
      return { kind: "blocked", reason: decision.block };
    }
    const statusCode = !decision.dynamicDiversionEnabled || link.authorRole === "admin" ? 301 : 302;
    return {
      kind: "redirect",
      location: decision.target,
      statusCode,
      decisionCookie: decision.decisionCookie ?? null,
    };
  }

  async #getLink(context: DomainContext, code: string): Promise<LinkRecord | null> {
    const cacheKey = this.#key(`domain:${context.definition.id}:link:${code}`);
    const cached = await this.#safeCacheGet(cacheKey);
    if (cached !== null) {
      try {
        const parsed = cachedLinkSchema.safeParse(normalizeCachedLink(JSON.parse(cached) as unknown));
        const destination = parsed.success ? normalizeHttpDestination(parsed.data.destination) : null;
        if (parsed.success && destination !== null
           && parsed.data.domainId === context.definition.id
           && parsed.data.domainHostname === context.definition.canonicalHost) {
          return destination === parsed.data.destination ? parsed.data : { ...parsed.data, destination };
        }
      } catch {
        // Corrupt cache state is a miss; MariaDB remains authoritative.
      }
      await this.#bestEffort(() => this.options.stores.cache.delete(cacheKey));
    }

    const link = await this.options.stores.links.findLink(
      context.definition.id,
      code,
      context.definition.canonicalHost,
      context.definition.surface,
    );
    if (link !== null) {
      const destination = normalizeHttpDestination(link.destination);
      if (destination !== null) {
        const safeLink = destination === link.destination ? link : { ...link, destination };
        await this.#bestEffort(() => this.options.stores.cache.set(cacheKey, JSON.stringify(phpCompatibleCacheRow(safeLink)), 60));
        return safeLink;
      }
    }
    return null;
  }

  #key(suffix: string): string {
    return `${this.options.appNamespace}:${suffix}`;
  }

  async #bestEffort(operation: () => Promise<void>): Promise<void> {
    try {
      await operation();
    } catch {
      // Cache and accounting failures never block a valid redirect.
    }
  }

  async #markDeliveredGap(
    domainId: number,
    occurredAt: Date,
    reason: "claim" | "accounting" | "observer" | "config",
  ): Promise<void> {
    const observer = this.options.stores.deliveredCountryObserver;
    if (observer === undefined) {
      return;
    }
    try {
      await observer.markGap({ domainId, occurredAt, reason });
    } catch {
      // The observer is auxiliary and must never suppress a valid redirect.
    }
  }

  async #safeCacheGet(key: string): Promise<string | null> {
    try {
      return await this.options.stores.cache.get(key);
    } catch {
      return null;
    }
  }
}

function normalizeCachedLink(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const row = value as Record<string, unknown>;
  return {
    id: scalarString(row.id),
    domainId: row.domainId ?? row.domain_id,
    code: row.code,
    userId: row.userId ?? row.user_id,
    destination: row.destination,
    title: row.title ?? null,
    description: row.description ?? null,
    image: row.image ?? null,
    compactActivityTracked: booleanFlag(row.compactActivityTracked ?? row.compact_activity_tracked),
    authorRole: row.authorRole ?? row.author_role ?? "user",
    domainHostname: row.domainHostname ?? row.domain_hostname,
    domainLabel: row.domainLabel ?? row.domain_label,
    diversionCampaign: row.diversionCampaign ?? row.diversion_campaign,
    createdAt: row.createdAt ?? row.created_at ?? "1970-01-01T00:00:00.000Z",
  };
}

function scalarString(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : "";
}

function booleanFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

function phpCompatibleCacheRow(link: LinkRecord): Record<string, unknown> {
  return {
    id: link.id,
    domain_id: link.domainId,
    code: link.code,
    user_id: link.userId,
    destination: link.destination,
    title: link.title,
    description: link.description,
    image: link.image,
    compact_activity_tracked: link.compactActivityTracked === true ? 1 : 0,
    author_role: link.authorRole,
    domain_hostname: link.domainHostname,
    domain_label: link.domainLabel,
    diversion_campaign: link.diversionCampaign,
    created_at: link.createdAt.toISOString(),
  };
}
