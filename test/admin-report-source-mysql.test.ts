import { describe, expect, it } from "vitest";
import type { Pool } from "mysql2/promise";
import { MysqlAdminReportStore } from "../src/infrastructure/mysql-admin-report-store.js";

describe("Admin report MariaDB source contract", () => {
  it("loads exact per-domain activation keys and all grouped country rows without LIMIT", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      execute: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        if (/FROM settings/.test(sql)) {
          return [[
            { skey: "compact_diversion_history_complete_from_d2_utc", svalue: "2026-01-01 00:00:00" },
            { skey: "delivered_country_report_seal_lag_seconds_d2", svalue: "600" },
          ], []];
        }
        return [[{
          country: "IN",
          delivered: "9007199254740993",
          diverted: "2",
          filtered_meta: "3",
          filtered_bots: "4",
          filtered_other: "5",
        }], []];
      },
    } as unknown as Pool;
    const store = new MysqlAdminReportStore(pool);

    await expect(store.loadReportActivation(2)).resolves.toMatchObject({
      diversionCompleteFrom: "2026-01-01 00:00:00",
      filtersCompleteFrom: null,
      deliveredSealLagSeconds: "600",
    });
    await expect(store.loadCountryOutcomeAggregates(
      2,
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-01T06:00:00.000Z"),
    )).resolves.toEqual([{
      country: "IN",
      delivered: 9_007_199_254_740_993n,
      diverted: 2n,
      filteredMeta: 3n,
      filteredBots: 4n,
      filteredOther: 5n,
    }]);
    expect(calls[0]?.params).toEqual([
      "compact_diversion_history_complete_from_d2_utc",
      "compact_filter_country_history_complete_from_d2_utc",
      "compact_delivered_country_history_complete_from_d2_utc",
      "delivered_country_report_seal_lag_seconds_d2",
    ]);
    expect(calls[1]?.sql).toContain("GROUP BY country");
    expect(calls[1]?.sql).not.toMatch(/\bLIMIT\b/i);
  });

  it("rejects unbounded windows and unsupported counters", async () => {
    const pool = {
      execute: async () => [[{
        country: "IN",
        delivered: "9223372036854775808",
        diverted: "0",
        filtered_meta: "0",
        filtered_bots: "0",
        filtered_other: "0",
      }], []],
    } as unknown as Pool;
    const store = new MysqlAdminReportStore(pool);
    await expect(store.loadCountryOutcomeAggregates(
      2,
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-09T00:00:00.000Z"),
    )).rejects.toThrow(/up to seven days/);
    await expect(store.loadCountryOutcomeAggregates(
      2,
      new Date("2026-09-01T00:00:00.000Z"),
      new Date("2026-09-01T06:00:00.000Z"),
    )).rejects.toThrow(/unsupported counter/);
  });
});
