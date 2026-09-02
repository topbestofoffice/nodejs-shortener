import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { MysqlApplicationStore } from "../src/infrastructure/mysql-store.js";
import { loadTrafficShieldReport } from "../src/modules/dashboard/shield-service.js";

describe("MariaDB Traffic Shield reader contract", () => {
  it("uses one owner-wide bounded aggregate with internally selected ring columns", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = {
      execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return [[{
          activation_started_at_utc: "2026-08-25 18:30:00",
          lifetime_total: "9007199254740993",
          d0: "1", d1: "2", d2: "3", d3: "4", d4: "5", d5: "6", d6: "7",
        }], []];
      }),
    } as unknown as Pool;
    const store = mysqlStore(pool);

    const report = await loadTrafficShieldReport(store, 77, new Date("2026-09-01T12:00:00.000Z"));

    expect(report.total).toBe("9007199254740993");
    expect(report.history_total).toBe("28");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.sql).toContain("FROM links");
    expect(call?.sql).toContain("WHERE user_id = ?");
    expect(call?.sql).toContain("compact_filtered_history_started_at_utc");
    expect(call?.sql).not.toContain("domain_id");
    expect(call?.sql).not.toMatch(/country|diversion_history/i);
    expect(call?.sql.match(/filtered_d[0-6] = \?/g)).toHaveLength(7);
    expect(call?.sql.match(/filtered_c[0-6]/g)).toHaveLength(7);
    expect(call?.params).toEqual([
      "2026-09-01", "2026-08-31", "2026-08-30", "2026-08-29", "2026-08-28", "2026-08-27", "2026-08-26", 77,
    ]);
  });

  it("fails closed on settings/query errors or invalid MariaDB values", async () => {
    const failingPool = {
      execute: vi.fn(async () => Promise.reject(new Error("settings unavailable"))),
    } as unknown as Pool;
    await expect(loadTrafficShieldReport(
      mysqlStore(failingPool),
      1,
      new Date("2026-09-01T12:00:00.000Z"),
    )).rejects.toThrow("settings unavailable");

    for (const invalid of [
      { activation_started_at_utc: null, lifetime_total: "-1" },
      { activation_started_at_utc: Buffer.from("bad"), lifetime_total: "0" },
      { activation_started_at_utc: null, lifetime_total: "18446744073709551616" },
    ]) {
      const pool = {
        execute: vi.fn(async () => [[{
          d0: "0", d1: "0", d2: "0", d3: "0", d4: "0", d5: "0", d6: "0",
          ...invalid,
        }], []]),
      } as unknown as Pool;
      await expect(loadTrafficShieldReport(
        mysqlStore(pool),
        1,
        new Date("2026-09-01T12:00:00.000Z"),
      )).rejects.toThrow(/Traffic Shield|invalid/);
    }
  });

  it("rejects a mismatched date/slot before producing SQL", async () => {
    const execute = vi.fn();
    const store = mysqlStore({ execute } as unknown as Pool);
    await expect(store.loadTrafficShieldAggregate(1, [
      { slot: 0, date: "2026-09-01" },
      { slot: 1, date: "2026-08-31" },
      { slot: 2, date: "2026-08-30" },
      { slot: 3, date: "2026-08-29" },
      { slot: 4, date: "2026-08-28" },
      { slot: 5, date: "2026-08-27" },
      { slot: 6, date: "2026-08-26" },
    ])).rejects.toThrow("Invalid Traffic Shield aggregate request");
    expect(execute).not.toHaveBeenCalled();
  });
});

function mysqlStore(pool: Pool): MysqlApplicationStore {
  const store = Object.create(MysqlApplicationStore.prototype) as MysqlApplicationStore;
  Object.defineProperty(store, "pool", { value: pool, writable: false });
  return store;
}
