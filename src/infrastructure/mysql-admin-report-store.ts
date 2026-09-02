import type { Pool, RowDataPacket } from "mysql2/promise";
import type { AdminCountryAggregate } from "../modules/reporting/admin-report-policy.js";
import type {
  AdminReportActivationValues,
  AdminReportSourceStore,
} from "../modules/reporting/admin-report-service.js";

interface SettingRow extends RowDataPacket {
  skey: string;
  svalue: string | null;
}

interface AggregateRow extends RowDataPacket {
  country: string;
  delivered: string | number;
  diverted: string | number;
  filtered_meta: string | number;
  filtered_bots: string | number;
  filtered_other: string | number;
}

export class MysqlAdminReportStore implements AdminReportSourceStore {
  public constructor(private readonly pool: Pool) {}

  public async loadReportActivation(domainId: number): Promise<AdminReportActivationValues> {
    assertDomainId(domainId);
    const keys = reportSettingKeys(domainId);
    const [rows] = await this.pool.execute<SettingRow[]>(
      `SELECT skey, svalue FROM settings
        WHERE skey IN (?, ?, ?, ?)`,
      [...keys],
    );
    const values = new Map(rows.map((row) => [row.skey, row.svalue]));
    return {
      diversionCompleteFrom: values.get(keys[0]) ?? null,
      filtersCompleteFrom: values.get(keys[1]) ?? null,
      deliveredCompleteFrom: values.get(keys[2]) ?? null,
      deliveredSealLagSeconds: values.get(keys[3]) ?? null,
    };
  }

  public async loadCountryOutcomeAggregates(
    domainId: number,
    start: Date,
    end: Date,
  ): Promise<readonly AdminCountryAggregate[]> {
    assertReportWindow(domainId, start, end);
    const [rows] = await this.pool.execute<AggregateRow[]>(
      `SELECT country,
              COALESCE(SUM(delivered), 0) AS delivered,
              COALESCE(SUM(diverted), 0) AS diverted,
              COALESCE(SUM(filtered_meta), 0) AS filtered_meta,
              COALESCE(SUM(filtered_bots), 0) AS filtered_bots,
              COALESCE(SUM(filtered_other), 0) AS filtered_other
         FROM diversion_history_10m
        WHERE domain_id = ? AND bucket_start_utc >= ? AND bucket_start_utc < ?
        GROUP BY country
        ORDER BY country ASC`,
      [domainId, formatUtc(start), formatUtc(end)],
    );
    return rows.map((row) => ({
      country: row.country,
      delivered: parseCounter(row.delivered),
      diverted: parseCounter(row.diverted),
      filteredMeta: parseCounter(row.filtered_meta),
      filteredBots: parseCounter(row.filtered_bots),
      filteredOther: parseCounter(row.filtered_other),
    }));
  }
}

function reportSettingKeys(domainId: number): readonly [string, string, string, string] {
  return [
    `compact_diversion_history_complete_from_d${domainId}_utc`,
    `compact_filter_country_history_complete_from_d${domainId}_utc`,
    `compact_delivered_country_history_complete_from_d${domainId}_utc`,
    `delivered_country_report_seal_lag_seconds_d${domainId}`,
  ];
}

function assertDomainId(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError("Admin report domain ID is invalid.");
  }
}

function assertReportWindow(domainId: number, start: Date, end: Date): void {
  assertDomainId(domainId);
  const duration = end.getTime() - start.getTime();
  if (!Number.isSafeInteger(start.getTime()) || !Number.isSafeInteger(end.getTime())
    || start.getTime() % 600_000 !== 0 || end.getTime() % 600_000 !== 0
    || !Number.isSafeInteger(duration) || duration < 600_000 || duration > 7 * 86_400_000) {
    throw new RangeError("Admin report query requires a completed 10-minute-aligned window up to seven days.");
  }
}

function parseCounter(value: string | number): bigint {
  const text = String(value);
  if (!/^(?:0|[1-9]\d{0,18})$/.test(text)) {
    throw new Error("Admin report contains an unsupported counter.");
  }
  const parsed = BigInt(text);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new Error("Admin report contains an unsupported counter.");
  }
  return parsed;
}

function formatUtc(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}
