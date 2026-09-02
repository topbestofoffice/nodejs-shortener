import { describe, expect, it, vi } from "vitest";
import type { DeliveredCountryWindowRows } from "../src/core/types.js";
import { AdminReportService, parseAdminReportRange } from "../src/modules/reporting/admin-report-service.js";
import { domainPolicies } from "./fixtures.js";

describe("Admin report service", () => {
  it("loads independent compact families and seals explicit Delivered domains", async () => {
    const source = {
      loadReportActivation: vi.fn(async () => ({
        diversionCompleteFrom: "2026-01-01 00:00:00",
        filtersCompleteFrom: "2026-01-01 00:00:00",
        deliveredCompleteFrom: "2026-01-01 00:00:00",
        deliveredSealLagSeconds: "600",
      })),
      loadCountryOutcomeAggregates: vi.fn(async () => [
        { country: "IN", delivered: 36n, diverted: 4n, filteredMeta: 2n, filteredBots: 1n, filteredOther: 0n },
      ]),
    };
    const delivered = {
      loadDeliveredCountryWindow: vi.fn(async (_domainId: number, start: Date, end: Date) => (
        completeDeliveredRows(start, end)
      )),
    };
    const service = new AdminReportService({
      source,
      delivered,
      deliveredCountryDomainIds: [2],
      clock: { now: () => new Date("2026-09-01T12:34:56.789Z") },
    });

    const snapshot = await service.load(domainPolicies[1]!, "6h");

    expect(snapshot.window.expectedBuckets).toBe(36);
    expect(snapshot.report).toMatchObject({
      available: true,
      deliveredState: "complete",
      diversionState: "complete",
      filtersState: "complete",
      totals: { delivered: "36", diverted: "4", filteredMeta: "2", filteredBots: "1", filteredOther: "0" },
      diversionPercentage: "10.00",
    });
    expect(delivered.loadDeliveredCountryWindow).toHaveBeenCalledTimes(1);
  });

  it("keeps complete diversion/filter values when Delivered configuration or publisher proof is absent", async () => {
    const source = {
      loadReportActivation: async () => ({
        diversionCompleteFrom: "2026-01-01 00:00:00",
        filtersCompleteFrom: "2026-01-01 00:00:00",
        deliveredCompleteFrom: "malformed",
        deliveredSealLagSeconds: "600",
      }),
      loadCountryOutcomeAggregates: async () => [
        { country: "US", delivered: 99n, diverted: 5n, filteredMeta: 1n, filteredBots: 0n, filteredOther: 0n },
      ],
    };
    const delivered = { loadDeliveredCountryWindow: vi.fn() };
    const service = new AdminReportService({
      source,
      delivered,
      deliveredCountryDomainIds: [2],
      clock: { now: () => new Date("2026-09-01T12:34:56.000Z") },
    });

    const snapshot = await service.load(domainPolicies[1]!, "yesterday");

    expect(snapshot.report).toMatchObject({
      deliveredState: "collecting_incomplete",
      diversionState: "complete",
      filtersState: "complete",
      totals: { delivered: null, diverted: "5", filteredMeta: "1" },
    });
    expect(delivered.loadDeliveredCountryWindow).not.toHaveBeenCalled();
  });

  it("treats a Delivered storage failure as incomplete without hiding sibling families", async () => {
    const service = new AdminReportService({
      source: {
        loadReportActivation: async () => ({
          diversionCompleteFrom: "2026-01-01 00:00:00",
          filtersCompleteFrom: "2026-01-01 00:00:00",
          deliveredCompleteFrom: "2026-01-01 00:00:00",
          deliveredSealLagSeconds: "600",
        }),
        loadCountryOutcomeAggregates: async () => [
          { country: "IN", delivered: 0n, diverted: 1n, filteredMeta: 0n, filteredBots: 0n, filteredOther: 0n },
        ],
      },
      delivered: { loadDeliveredCountryWindow: async () => { throw new Error("table unavailable"); } },
      deliveredCountryDomainIds: [2],
      clock: { now: () => new Date("2026-09-01T12:34:56.000Z") },
    });

    const snapshot = await service.load(domainPolicies[1]!, "6h");
    expect(snapshot.report).toMatchObject({
      deliveredState: "collecting_incomplete",
      totals: { delivered: null, diverted: "1" },
    });
  });

  it("accepts only the three exact ranges", () => {
    expect(parseAdminReportRange("6h")).toBe("6h");
    expect(parseAdminReportRange("yesterday")).toBe("yesterday");
    expect(parseAdminReportRange("7d")).toBe("7d");
    expect(parseAdminReportRange("today")).toBeNull();
    expect(parseAdminReportRange(["6h"])).toBeNull();
  });
});

function completeDeliveredRows(start: Date, end: Date): DeliveredCountryWindowRows {
  const states: DeliveredCountryWindowRows["states"][number][] = [];
  const history: DeliveredCountryWindowRows["history"][number][] = [];
  for (let epoch = start.getTime(); epoch < end.getTime(); epoch += 600_000) {
    const bucketStart = new Date(epoch);
    const sourceSha256 = "a".repeat(64);
    states.push({
      domainId: 2,
      bucketStart,
      status: "complete",
      deliveredTotal: 1n,
      provenance: "redis_nonempty",
      sourceSha256,
      redisRunIdSha256: "b".repeat(64),
      reasonCode: null,
      recordedAt: new Date(epoch + 60_000),
    });
    history.push({ domainId: 2, bucketStart, country: "IN", delivered: 1n });
  }
  return { states, history };
}
