import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { MysqlApplicationStore } from "../src/infrastructure/mysql-store.js";

describe("MariaDB dashboard history contract", () => {
  it("keeps owner scope, literal LIKE escaping, current ordering and bigint counters", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = {
      execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        if (sql.includes("COUNT(*) AS total FROM links WHERE user_id")) return [[{ total: "1" }], []];
        if (sql.includes("FROM links l") && sql.includes("ORDER BY l.id DESC")) {
          return [[historyRow()], []];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    } as unknown as Pool;
    const store = mysqlStore(pool);
    const query = "100%_!";

    await expect(store.countDashboardLinks(7, query)).resolves.toBe(1);
    const rows = await store.listDashboardLinks({ userId: 7, literalQuery: query, limit: 20, offset: 40 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.link).toMatchObject({ id: "9007199254740993", userId: 7, code: "Hist001" });
    expect(rows[0]?.countedClicks).toBe(18_446_744_073_709_551_615n);
    expect(rows[0]?.divertedClicks).toBe(2n);
    expect(rows[0]?.todayClicks).toBe(3n);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.sql).toContain("user_id = ?");
      expect(call.sql).toContain("LIKE ? ESCAPE '!'");
      expect(call.params.slice(0, 4)).toEqual([7, "%100!%!_!!%", "%100!%!_!!%", "%100!%!_!!%"]);
    }
    expect(calls[1]?.sql).toMatch(/ORDER BY l\.id DESC LIMIT 20 OFFSET 40/);
  });

  it("uses India-day own stats and excludes Admin rows from optional community totals", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = {
      execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        if (sql.includes("FROM links WHERE user_id")) {
          return [[{ total_links: "4", total_clicks: "9007199254740993", today_clicks: "12" }], []];
        }
        if (sql.includes("FROM links l JOIN users u")) {
          return [[{ total_clicks: "42", today_clicks: "5" }], []];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    } as unknown as Pool;
    const store = mysqlStore(pool);

    await expect(store.loadDashboardOwnStats(7, "2026-09-01")).resolves.toEqual({
      totalLinks: 4n,
      totalClicks: 9_007_199_254_740_993n,
      clicksToday: 12n,
    });
    await expect(store.loadDashboardCommunityStats("2026-09-01")).resolves.toEqual({
      totalClicks: 42n,
      clicksToday: 5n,
    });
    expect(calls[0]?.params).toEqual(["2026-09-01", 7]);
    expect(calls[1]?.params).toEqual(["2026-09-01"]);
    expect(calls[1]?.sql).toContain("u.role <> 'admin'");
  });
});

function mysqlStore(pool: Pool): MysqlApplicationStore {
  const store = Object.create(MysqlApplicationStore.prototype) as MysqlApplicationStore;
  Object.defineProperty(store, "pool", { value: pool, writable: false });
  return store;
}

function historyRow(): Record<string, unknown> {
  return {
    id: "9007199254740993",
    domain_id: 2,
    code: "Hist001",
    user_id: 7,
    destination: "https://destination.example/100%_!",
    title: "Literal search",
    description: null,
    image: null,
    author_role: "user",
    domain_hostname: "vidx1x.local",
    domain_label: "VIDX1X",
    diversion_campaign: "vidx1x",
    created_at: new Date("2026-09-01T12:00:00.000Z"),
    clicks: "18446744073709551615",
    diverted_clicks: "2",
    filtered_meta_clicks: "4",
    filtered_bot_clicks: "5",
    filtered_other_clicks: "6",
    today_clicks: "3",
    today_click_date: "2026-09-01",
    last_activity_at: "2026-09-01 12:30:00",
  };
}
