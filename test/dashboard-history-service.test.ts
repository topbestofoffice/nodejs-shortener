import { describe, expect, it } from "vitest";
import type { CacheStore } from "../src/ports.js";
import {
  DashboardHistoryService,
  indiaBusinessDate,
  type DashboardHistoryLink,
  type DashboardHistoryStore,
} from "../src/modules/dashboard/history-service.js";

describe("dashboard history service", () => {
  it("loads current pagination truth while caching the heavier summary for 60 seconds", async () => {
    const store = new FakeDashboardStore();
    store.matchCount = 41;
    const cache = new FakeCache();
    const service = new DashboardHistoryService({
      store,
      cache,
      clock: { now: () => new Date("2026-09-01T18:31:00Z") },
      keyPrefix: "test-shortener",
    });

    const first = await service.load(7, { q: "  news_%  ", per: "20", page: "9" });
    const second = await service.load(7, { per: "20", page: "1" });

    expect(first.pagination).toMatchObject({ query: "news_%", matchCount: 41, page: 3, offset: 40 });
    expect(store.listInputs[0]).toEqual({ userId: 7, literalQuery: "news_%", limit: 20, offset: 40 });
    expect(first.stats).toEqual({ totalLinks: 99n, totalClicks: 123n, clicksToday: 8n });
    expect(first.community).toEqual({ totalClicks: 900n, clicksToday: 30n });
    expect(second.pagination.matchCount).toBe(41);
    expect(store.ownStatsCalls).toBe(1);
    expect(store.communityStatsCalls).toBe(1);
    expect(store.countCalls).toBe(2);
    expect(cache.lastTtl).toBe(60);
  });

  it("hides optional community totals when their source fails without hiding own links", async () => {
    const store = new FakeDashboardStore();
    store.failCommunity = true;
    const service = new DashboardHistoryService({
      store,
      cache: new FakeCache(),
      clock: { now: () => new Date("2026-09-01T12:00:00Z") },
      keyPrefix: "test-shortener",
    });

    const snapshot = await service.load(1, {});
    expect(snapshot.community).toBeNull();
    expect(snapshot.stats.totalLinks).toBe(99n);
  });

  it("invalidates only the committed user's cached summary and ignores cache outages", async () => {
    const cache = new FakeCache();
    cache.failDelete = true;
    const service = new DashboardHistoryService({
      store: new FakeDashboardStore(),
      cache,
      clock: { now: () => new Date() },
      keyPrefix: "test-shortener:",
    });

    await expect(service.invalidateUserStats(12)).resolves.toBeUndefined();
    expect(cache.deleted).toEqual(["test-shortener:dashboard:user:12:stats:v1"]);
  });

  it("uses the India business-day boundary", () => {
    expect(indiaBusinessDate(new Date("2026-09-01T18:29:59Z"))).toBe("2026-09-01");
    expect(indiaBusinessDate(new Date("2026-09-01T18:30:00Z"))).toBe("2026-09-02");
  });
});

class FakeDashboardStore implements DashboardHistoryStore {
  public matchCount = 0;
  public ownStatsCalls = 0;
  public communityStatsCalls = 0;
  public countCalls = 0;
  public failCommunity = false;
  public readonly listInputs: Array<{ userId: number; literalQuery: string; limit: number; offset: number }> = [];

  public async loadDashboardOwnStats(): Promise<{ totalLinks: bigint; totalClicks: bigint; clicksToday: bigint }> {
    this.ownStatsCalls += 1;
    return { totalLinks: 99n, totalClicks: 123n, clicksToday: 8n };
  }

  public async loadDashboardCommunityStats(): Promise<{ totalClicks: bigint; clicksToday: bigint }> {
    this.communityStatsCalls += 1;
    if (this.failCommunity) throw new Error("optional aggregate unavailable");
    return { totalClicks: 900n, clicksToday: 30n };
  }

  public async countDashboardLinks(): Promise<number> {
    this.countCalls += 1;
    return this.matchCount;
  }

  public async listDashboardLinks(input: {
    userId: number;
    literalQuery: string;
    limit: number;
    offset: number;
  }): Promise<readonly DashboardHistoryLink[]> {
    this.listInputs.push(input);
    return [];
  }

  public async loadTrafficShieldAggregate(): Promise<never> {
    throw new Error("Traffic Shield is outside this dashboard-history fixture.");
  }
}

class FakeCache implements CacheStore {
  readonly rows = new Map<string, string>();
  readonly deleted: string[] = [];
  public lastTtl = 0;
  public failDelete = false;

  public async get(key: string): Promise<string | null> {
    return this.rows.get(key) ?? null;
  }

  public async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.rows.set(key, value);
    this.lastTtl = ttlSeconds;
  }

  public async delete(...keys: readonly string[]): Promise<void> {
    this.deleted.push(...keys);
    if (this.failDelete) throw new Error("cache unavailable");
    for (const key of keys) this.rows.delete(key);
  }
}
