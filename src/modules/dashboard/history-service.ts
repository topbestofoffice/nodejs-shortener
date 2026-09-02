import type { LinkRecord } from "../../core/types.js";
import type { CacheStore, Clock } from "../../ports.js";
import {
  parseDashboardHistoryRequest,
  resolveDashboardPagination,
  type DashboardPagination,
} from "./history-policy.js";
import type { TrafficShieldStore } from "./shield-service.js";

const statsCacheSchema = 1;
const statsCacheSeconds = 60;
const unsignedCounterMax = 18_446_744_073_709_551_615n;

export interface DashboardOwnStats {
  readonly totalLinks: bigint;
  readonly totalClicks: bigint;
  readonly clicksToday: bigint;
}

export interface DashboardCommunityStats {
  readonly totalClicks: bigint;
  readonly clicksToday: bigint;
}

export interface DashboardHistoryLink {
  readonly link: LinkRecord;
  readonly countedClicks: bigint;
  readonly divertedClicks: bigint;
  readonly filteredMetaClicks: bigint;
  readonly filteredBotClicks: bigint;
  readonly filteredOtherClicks: bigint;
  readonly todayClicks: bigint;
  readonly todayClickDate: string | null;
  readonly lastActivityAt: Date | null;
}

export interface DashboardHistoryStore extends TrafficShieldStore {
  loadDashboardOwnStats(userId: number, businessDate: string): Promise<DashboardOwnStats>;
  loadDashboardCommunityStats(businessDate: string): Promise<DashboardCommunityStats>;
  countDashboardLinks(userId: number, literalQuery: string): Promise<number>;
  listDashboardLinks(input: {
    readonly userId: number;
    readonly literalQuery: string;
    readonly limit: number;
    readonly offset: number;
  }): Promise<readonly DashboardHistoryLink[]>;
}

export interface DashboardSnapshot {
  readonly stats: DashboardOwnStats;
  /** Optional display metric: storage/cache errors must not break the dashboard. */
  readonly community: DashboardCommunityStats | null;
  readonly pagination: DashboardPagination;
  readonly links: readonly DashboardHistoryLink[];
}

export interface DashboardHistoryServiceOptions {
  readonly store: DashboardHistoryStore;
  readonly cache: CacheStore;
  readonly clock: Clock;
  readonly keyPrefix: string;
}

export class DashboardHistoryService {
  readonly #keyPrefix: string;

  public constructor(private readonly options: DashboardHistoryServiceOptions) {
    this.#keyPrefix = options.keyPrefix.replace(/:+$/, "");
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(this.#keyPrefix)) {
      throw new Error("Dashboard history requires an explicit cache-key prefix.");
    }
  }

  public async load(userId: number, rawQuery: unknown): Promise<DashboardSnapshot> {
    if (!Number.isSafeInteger(userId) || userId < 1) {
      throw new RangeError("Dashboard user ID is invalid.");
    }
    const request = parseDashboardHistoryRequest(rawQuery);
    const businessDate = indiaBusinessDate(this.options.clock.now());
    const statsPromise = this.#loadOwnStats(userId, businessDate);
    const communityPromise = this.#loadCommunityStats(businessDate);
    const matchCount = await this.options.store.countDashboardLinks(userId, request.query);
    const pagination = resolveDashboardPagination(request, matchCount);
    const linksPromise = this.options.store.listDashboardLinks({
      userId,
      literalQuery: request.query,
      limit: pagination.perPage,
      offset: pagination.offset,
    });
    const [stats, community, links] = await Promise.all([statsPromise, communityPromise, linksPromise]);

    return { stats, community, pagination, links };
  }

  /** Best-effort invalidation after a committed create/delete. */
  public async invalidateUserStats(userId: number): Promise<void> {
    try {
      await this.options.cache.delete(dashboardOwnStatsCacheKey(this.#keyPrefix, userId));
    } catch {
      // The cache is an optimization. Current DB truth remains authoritative.
    }
  }

  async #loadOwnStats(userId: number, businessDate: string): Promise<DashboardOwnStats> {
    const key = dashboardOwnStatsCacheKey(this.#keyPrefix, userId);
    const cached = await this.#readCache(key, businessDate, parseOwnStatsPayload);
    if (cached !== null) return cached;

    const current = await this.options.store.loadDashboardOwnStats(userId, businessDate);
    assertOwnStats(current);
    await this.#writeCache(key, businessDate, current);
    return current;
  }

  async #loadCommunityStats(businessDate: string): Promise<DashboardCommunityStats | null> {
    const key = dashboardCommunityStatsCacheKey(this.#keyPrefix);
    try {
      const cached = await this.#readCache(key, businessDate, parseCommunityStatsPayload);
      if (cached !== null) return cached;
      const current = await this.options.store.loadDashboardCommunityStats(businessDate);
      assertCommunityStats(current);
      await this.#writeCache(key, businessDate, current);
      return current;
    } catch {
      return null;
    }
  }

  async #readCache<T>(
    key: string,
    businessDate: string,
    parser: (value: unknown) => T | null,
  ): Promise<T | null> {
    try {
      const raw = await this.options.cache.get(key);
      if (raw === null) return null;
      const payload = JSON.parse(raw) as unknown;
      if (!isCacheEnvelope(payload, businessDate)) return null;
      return parser(payload);
    } catch {
      return null;
    }
  }

  async #writeCache(key: string, businessDate: string, value: object): Promise<void> {
    try {
      await this.options.cache.set(key, JSON.stringify({
        schema: statsCacheSchema,
        business_date: businessDate,
        ...bigintStrings(value),
      }), statsCacheSeconds);
    } catch {
      // A cache-write failure cannot turn a valid database response into 503.
    }
  }
}

export function dashboardOwnStatsCacheKey(keyPrefix: string, userId: number): string {
  return `${keyPrefix.replace(/:+$/, "")}:dashboard:user:${userId}:stats:v1`;
}

export function dashboardCommunityStatsCacheKey(keyPrefix: string): string {
  return `${keyPrefix.replace(/:+$/, "")}:dashboard:community-stats:v1`;
}

export function indiaBusinessDate(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year ?? ""}-${map.month ?? ""}-${map.day ?? ""}`;
}

function isCacheEnvelope(value: unknown, businessDate: string): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).schema === statsCacheSchema
    && (value as Record<string, unknown>).business_date === businessDate;
}

function parseOwnStatsPayload(value: unknown): DashboardOwnStats | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const totalLinks = parseCounter(row.totalLinks);
  const totalClicks = parseCounter(row.totalClicks);
  const clicksToday = parseCounter(row.clicksToday);
  return totalLinks === null || totalClicks === null || clicksToday === null
    ? null
    : { totalLinks, totalClicks, clicksToday };
}

function parseCommunityStatsPayload(value: unknown): DashboardCommunityStats | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const totalClicks = parseCounter(row.totalClicks);
  const clicksToday = parseCounter(row.clicksToday);
  return totalClicks === null || clicksToday === null ? null : { totalClicks, clicksToday };
}

function parseCounter(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= unsignedCounterMax ? parsed : null;
}

function assertOwnStats(value: DashboardOwnStats): void {
  assertCounter(value.totalLinks);
  assertCounter(value.totalClicks);
  assertCounter(value.clicksToday);
}

function assertCommunityStats(value: DashboardCommunityStats): void {
  assertCounter(value.totalClicks);
  assertCounter(value.clicksToday);
}

function assertCounter(value: bigint): void {
  if (value < 0n || value > unsignedCounterMax) {
    throw new Error("Dashboard store returned an invalid unsigned counter.");
  }
}

function bigintStrings(value: object): Record<string, string> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (typeof item !== "bigint") throw new Error("Dashboard cache payload contains a non-counter value.");
    return [key, item.toString()];
  }));
}
