import type { DomainPolicy } from "../../core/types.js";
import type { Clock, DeliveredCountryReportStore } from "../../ports.js";
import {
  buildAdminCountryOutcomeReport,
  type AdminCountryAggregate,
  type AdminCountryOutcomeReport,
} from "./admin-report-policy.js";
import { evaluateDeliveredCountryRange } from "./completeness.js";
import {
  buildAdminReportWindow,
  type AdminReportRange,
  type AdminReportWindow,
} from "./report-window.js";

export interface AdminReportActivationValues {
  readonly diversionCompleteFrom: string | null;
  readonly filtersCompleteFrom: string | null;
  readonly deliveredCompleteFrom: string | null;
  readonly deliveredSealLagSeconds: string | null;
}

export interface AdminReportSourceStore {
  loadReportActivation(domainId: number): Promise<AdminReportActivationValues>;
  loadCountryOutcomeAggregates(
    domainId: number,
    start: Date,
    end: Date,
  ): Promise<readonly AdminCountryAggregate[]>;
}

export interface AdminReportSnapshot {
  readonly range: AdminReportRange;
  readonly label: string;
  readonly through: string;
  readonly window: AdminReportWindow;
  readonly diversionCompleteFrom: string | null;
  readonly filtersCompleteFrom: string | null;
  readonly deliveredCompleteFrom: string | null;
  readonly deliveredSealLagSeconds: number | null;
  readonly report: AdminCountryOutcomeReport;
}

export class AdminReportService {
  readonly #deliveredDomainIds: ReadonlySet<number>;

  public constructor(private readonly options: {
    readonly source: AdminReportSourceStore;
    readonly delivered: DeliveredCountryReportStore;
    readonly deliveredCountryDomainIds: readonly number[];
    readonly clock: Clock;
  }) {
    this.#deliveredDomainIds = new Set(options.deliveredCountryDomainIds);
  }

  public async load(domain: DomainPolicy, range: AdminReportRange): Promise<AdminReportSnapshot> {
    const activation = await this.options.source.loadReportActivation(domain.id);
    const diversionCompleteFrom = parseUtcSetting(activation.diversionCompleteFrom);
    const filtersCompleteFrom = parseUtcSetting(activation.filtersCompleteFrom);
    const deliveredCompleteFrom = parseUtcSetting(activation.deliveredCompleteFrom);
    const deliveredApplicable = this.#deliveredDomainIds.has(domain.id);
    const sealLag = parseSealLag(activation.deliveredSealLagSeconds);
    const deliveredConfigured = deliveredApplicable
      && deliveredCompleteFrom !== null
      && deliveredCompleteFrom.getTime() % (10 * 60 * 1000) === 0
      && sealLag !== null;
    const observedNow = this.options.clock.now().getTime();
    if (!Number.isSafeInteger(observedNow)) throw new Error("Admin report clock is invalid.");
    const window = buildAdminReportWindow({
      range,
      timezone: domain.reportTimezone,
      now: new Date(Math.floor(observedNow / 1000) * 1000),
      deliveredConfigured,
      deliveredSealLagSeconds: deliveredConfigured ? sealLag : null,
    });

    const [rows, deliveredRows] = await Promise.all([
      this.options.source.loadCountryOutcomeAggregates(domain.id, window.start, window.end),
      deliveredConfigured && deliveredCompleteFrom <= window.start
        ? this.options.delivered.loadDeliveredCountryWindow(domain.id, window.start, window.end)
          .catch(() => null)
        : Promise.resolve(null),
    ]);
    const deliveredEvaluation = deliveredRows === null
      ? null
      : evaluateDeliveredCountryRange(domain.id, window.start, window.end, deliveredRows);
    const report = buildAdminCountryOutcomeReport({
      window,
      deliveredApplicable,
      diversionCompleteFrom,
      filtersCompleteFrom,
      deliveredCompleteFrom,
      deliveredEvaluation,
      rows,
    });

    return Object.freeze({
      range,
      label: range === "6h"
        ? "Last 6 completed hours"
        : range === "yesterday" ? "Yesterday" : "Previous 7 complete days",
      through: formatThrough(window.end, domain.reportTimezone),
      window,
      diversionCompleteFrom: canonicalOrNull(diversionCompleteFrom),
      filtersCompleteFrom: canonicalOrNull(filtersCompleteFrom),
      deliveredCompleteFrom: canonicalOrNull(deliveredCompleteFrom),
      deliveredSealLagSeconds: deliveredConfigured ? sealLag : null,
      report,
    });
  }
}

export function parseAdminReportRange(value: unknown): AdminReportRange | null {
  return value === "6h" || value === "yesterday" || value === "7d" ? value : null;
}

function parseUtcSetting(value: string | null): Date | null {
  if (value === null || value === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const date = new Date(`${value.replace(" ", "T")}Z`);
  return Number.isSafeInteger(date.getTime())
    && date.toISOString().slice(0, 19) === `${value.replace(" ", "T")}`
    ? date
    : null;
}

function parseSealLag(value: string | null): number | null {
  if (value === null || !/^[1-9]\d{0,3}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 3_600 ? parsed : null;
}

function canonicalOrNull(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function formatThrough(end: Date, timezone: DomainPolicy["reportTimezone"]): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  return formatter.format(end);
}
