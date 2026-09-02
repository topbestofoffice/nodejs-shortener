import { describe, expect, it } from "vitest";
import { buildAdminCountryOutcomeReport } from "../src/modules/reporting/admin-report-policy.js";
import type { DeliveredCountryWindowEvaluation } from "../src/modules/reporting/completeness.js";
import { buildAdminReportWindow } from "../src/modules/reporting/report-window.js";

const now = new Date("2026-09-01T12:34:56.000Z");
const window = buildAdminReportWindow({
  range: "6h",
  timezone: "UTC",
  now,
  deliveredConfigured: true,
  deliveredSealLagSeconds: 600,
});
const completeAt = new Date("2026-01-01T00:00:00.000Z");
const deliveredEvaluation: DeliveredCountryWindowEvaluation = {
  state: "complete",
  expectedBuckets: 36,
  completeBuckets: 36,
  deliveredTotal: 3n,
  reason: null,
};

describe("Admin compact outcome report policy", () => {
  it("keeps all complete families, sorts rows and computes the exact percentage", () => {
    const report = buildAdminCountryOutcomeReport({
      window,
      deliveredApplicable: true,
      diversionCompleteFrom: completeAt,
      filtersCompleteFrom: completeAt,
      deliveredCompleteFrom: completeAt,
      deliveredEvaluation,
      rows: [
        { country: "US", delivered: 1n, diverted: 0n, filteredMeta: 0n, filteredBots: 0n, filteredOther: 0n },
        { country: "IN", delivered: 2n, diverted: 1n, filteredMeta: 2n, filteredBots: 0n, filteredOther: 0n },
      ],
    });
    expect(report).toMatchObject({
      available: true,
      diversionState: "complete",
      filtersState: "complete",
      deliveredState: "complete",
      diversionPercentageState: "complete",
      diversionPercentage: "25.00",
      totals: {
        delivered: "3",
        diverted: "1",
        filteredMeta: "2",
        filteredBots: "0",
        filteredOther: "0",
      },
    });
    expect(report.rows.map((row) => row.country)).toEqual(["IN", "US"]);
  });

  it("does not let missing Delivered history hide complete diversion and filter data", () => {
    const report = buildAdminCountryOutcomeReport({
      window,
      deliveredApplicable: true,
      diversionCompleteFrom: completeAt,
      filtersCompleteFrom: completeAt,
      deliveredCompleteFrom: null,
      deliveredEvaluation: null,
      rows: [
        { country: "IN", delivered: null, diverted: 4n, filteredMeta: 1n, filteredBots: 2n, filteredOther: 3n },
      ],
    });
    expect(report).toMatchObject({
      available: true,
      deliveredState: "collecting_incomplete",
      diversionPercentageState: "collecting_incomplete",
      diversionPercentage: null,
      totals: { delivered: null, diverted: "4", filteredMeta: "1", filteredBots: "2", filteredOther: "3" },
    });
  });

  it("marks Delivered percentage not applicable on an ordinary domain", () => {
    const report = buildAdminCountryOutcomeReport({
      window,
      deliveredApplicable: false,
      diversionCompleteFrom: completeAt,
      filtersCompleteFrom: null,
      deliveredCompleteFrom: null,
      deliveredEvaluation: null,
      rows: [
        { country: "IN", delivered: null, diverted: 0n, filteredMeta: null, filteredBots: null, filteredOther: null },
      ],
    });
    expect(report).toMatchObject({
      deliveredState: "not_applicable",
      diversionPercentageState: "not_applicable",
      totals: { delivered: null, diverted: "0" },
      rows: [],
    });
  });

  it("never reports false zero for unavailable dimensions and rejects mismatched Delivered totals", () => {
    const collecting = buildAdminCountryOutcomeReport({
      window,
      deliveredApplicable: true,
      diversionCompleteFrom: null,
      filtersCompleteFrom: null,
      deliveredCompleteFrom: null,
      deliveredEvaluation: null,
      rows: [],
    });
    expect(collecting).toMatchObject({
      available: false,
      totals: { delivered: null, diverted: null, filteredMeta: null, filteredBots: null, filteredOther: null },
    });

    expect(() => buildAdminCountryOutcomeReport({
      window,
      deliveredApplicable: true,
      diversionCompleteFrom: completeAt,
      filtersCompleteFrom: completeAt,
      deliveredCompleteFrom: completeAt,
      deliveredEvaluation,
      rows: [
        { country: "IN", delivered: 2n, diverted: 0n, filteredMeta: 0n, filteredBots: 0n, filteredOther: 0n },
      ],
    })).toThrow(/does not match/);
  });
});
