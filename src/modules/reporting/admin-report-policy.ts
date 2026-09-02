import type { DeliveredCountryWindowEvaluation } from "./completeness.js";
import type { AdminReportWindow } from "./report-window.js";

const maxCounter = 9_223_372_036_854_775_807n;

export interface AdminCountryAggregate {
  readonly country: string;
  readonly delivered: bigint | null;
  readonly diverted: bigint | null;
  readonly filteredMeta: bigint | null;
  readonly filteredBots: bigint | null;
  readonly filteredOther: bigint | null;
}

export interface AdminReportPolicyInput {
  readonly window: AdminReportWindow;
  readonly deliveredApplicable: boolean;
  readonly diversionCompleteFrom: Date | null;
  readonly filtersCompleteFrom: Date | null;
  readonly deliveredCompleteFrom: Date | null;
  readonly deliveredEvaluation: DeliveredCountryWindowEvaluation | null;
  readonly rows: readonly AdminCountryAggregate[];
}

export interface AdminCountryOutcomeRow {
  readonly country: string;
  readonly delivered: string | null;
  readonly diverted: string | null;
  readonly filteredMeta: string | null;
  readonly filteredBots: string | null;
  readonly filteredOther: string | null;
  readonly total: string;
}

export interface AdminCountryOutcomeReport {
  readonly available: boolean;
  readonly diversionState: "complete" | "collecting_incomplete";
  readonly filtersState: "complete" | "collecting_incomplete";
  readonly deliveredState: "complete" | "collecting_incomplete" | "not_applicable";
  readonly diversionPercentageState:
    | "complete"
    | "no_eligible_clicks"
    | "collecting_incomplete"
    | "not_applicable";
  readonly diversionPercentage: string | null;
  readonly totals: {
    readonly delivered: string | null;
    readonly diverted: string | null;
    readonly filteredMeta: string | null;
    readonly filteredBots: string | null;
    readonly filteredOther: string | null;
  };
  readonly rows: readonly AdminCountryOutcomeRow[];
}

/**
 * Keep each compact metric family independent. Missing activation/history is
 * never converted to zero and never hides a complete sibling family.
 */
export function buildAdminCountryOutcomeReport(
  input: AdminReportPolicyInput,
): AdminCountryOutcomeReport {
  const diversionAvailable = activationCovers(input.diversionCompleteFrom, input.window.start);
  const filtersAvailable = activationCovers(input.filtersCompleteFrom, input.window.start);
  const deliveredAvailable = input.deliveredApplicable
    && activationCovers(input.deliveredCompleteFrom, input.window.start)
    && input.deliveredEvaluation?.state === "complete";
  const deliveredState = !input.deliveredApplicable
    ? "not_applicable" as const
    : deliveredAvailable ? "complete" as const : "collecting_incomplete" as const;

  const seen = new Set<string>();
  const totals = {
    delivered: deliveredAvailable ? 0n : null,
    diverted: diversionAvailable ? 0n : null,
    filteredMeta: filtersAvailable ? 0n : null,
    filteredBots: filtersAvailable ? 0n : null,
    filteredOther: filtersAvailable ? 0n : null,
  };
  const rows: Array<AdminCountryOutcomeRow & { readonly numericTotal: bigint }> = [];

  for (const raw of input.rows) {
    if (!/^(?:[A-Z]{2}|\?\?)$/.test(raw.country) || seen.has(raw.country)) {
      throw new Error("Admin country report contains an invalid or duplicate country.");
    }
    seen.add(raw.country);
    const delivered = enabledCounter(raw.delivered, deliveredAvailable, "Delivered");
    const diverted = enabledCounter(raw.diverted, diversionAvailable, "diversion");
    const filteredMeta = enabledCounter(raw.filteredMeta, filtersAvailable, "Meta filter");
    const filteredBots = enabledCounter(raw.filteredBots, filtersAvailable, "bot filter");
    const filteredOther = enabledCounter(raw.filteredOther, filtersAvailable, "other filter");
    const numericTotal = checkedSum([delivered, diverted, filteredMeta, filteredBots, filteredOther]);
    if (numericTotal === 0n) continue;

    totals.delivered = addNullable(totals.delivered, delivered);
    totals.diverted = addNullable(totals.diverted, diverted);
    totals.filteredMeta = addNullable(totals.filteredMeta, filteredMeta);
    totals.filteredBots = addNullable(totals.filteredBots, filteredBots);
    totals.filteredOther = addNullable(totals.filteredOther, filteredOther);
    rows.push({
      country: raw.country,
      delivered: decimalOrNull(delivered),
      diverted: decimalOrNull(diverted),
      filteredMeta: decimalOrNull(filteredMeta),
      filteredBots: decimalOrNull(filteredBots),
      filteredOther: decimalOrNull(filteredOther),
      total: numericTotal.toString(),
      numericTotal,
    });
  }

  if (deliveredAvailable && input.deliveredEvaluation?.deliveredTotal !== totals.delivered) {
    throw new Error("Admin Delivered country total does not match the sealed bucket state.");
  }
  rows.sort((left, right) => left.numericTotal === right.numericTotal
    ? compareAscii(left.country, right.country)
    : left.numericTotal > right.numericTotal ? -1 : 1);

  const percentage = diversionPercentage(
    input.deliveredApplicable,
    totals.delivered,
    totals.diverted,
  );
  return Object.freeze({
    available: diversionAvailable || filtersAvailable || deliveredAvailable,
    diversionState: diversionAvailable ? "complete" : "collecting_incomplete",
    filtersState: filtersAvailable ? "complete" : "collecting_incomplete",
    deliveredState,
    diversionPercentageState: percentage.state,
    diversionPercentage: percentage.value,
    totals: Object.freeze({
      delivered: decimalOrNull(totals.delivered),
      diverted: decimalOrNull(totals.diverted),
      filteredMeta: decimalOrNull(totals.filteredMeta),
      filteredBots: decimalOrNull(totals.filteredBots),
      filteredOther: decimalOrNull(totals.filteredOther),
    }),
    rows: Object.freeze(rows.map(({ numericTotal: _numericTotal, ...row }) => Object.freeze(row))),
  });
}

function activationCovers(activation: Date | null, start: Date): boolean {
  if (activation === null) return false;
  const activationMs = activation.getTime();
  const startMs = start.getTime();
  if (!Number.isSafeInteger(activationMs) || !Number.isSafeInteger(startMs)
    || activationMs % 1000 !== 0 || startMs % 1000 !== 0) {
    throw new Error("Admin report activation boundary is invalid.");
  }
  return activationMs <= startMs;
}

function enabledCounter(value: bigint | null, enabled: boolean, label: string): bigint | null {
  if (!enabled) return null;
  if (value === null || value < 0n || value > maxCounter) {
    throw new Error(`${label} country counter is unavailable or unsupported.`);
  }
  return value;
}

function checkedSum(values: readonly (bigint | null)[]): bigint {
  let total = 0n;
  for (const value of values) {
    if (value === null) continue;
    if (total > maxCounter - value) {
      throw new Error("Admin country report total exceeds the supported integer range.");
    }
    total += value;
  }
  return total;
}

function addNullable(total: bigint | null, value: bigint | null): bigint | null {
  if (total === null || value === null) return total;
  if (total > maxCounter - value) {
    throw new Error("Admin country report total exceeds the supported integer range.");
  }
  return total + value;
}

function decimalOrNull(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

function diversionPercentage(
  applicable: boolean,
  delivered: bigint | null,
  diverted: bigint | null,
): { readonly state: AdminCountryOutcomeReport["diversionPercentageState"]; readonly value: string | null } {
  if (!applicable) return { state: "not_applicable", value: null };
  if (delivered === null || diverted === null) return { state: "collecting_incomplete", value: null };
  const denominator = delivered + diverted;
  if (denominator === 0n) return { state: "no_eligible_clicks", value: null };
  const hundredths = (diverted * 10_000n + denominator / 2n) / denominator;
  return {
    state: "complete",
    value: `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`,
  };
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
