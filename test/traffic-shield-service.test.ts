import { describe, expect, it } from "vitest";
import {
  loadTrafficShieldReport,
  trafficShieldSlot,
  trafficShieldSlotForDate,
  type TrafficShieldAggregate,
  type TrafficShieldDateSlot,
  type TrafficShieldStore,
} from "../src/modules/dashboard/shield-service.js";

const now = new Date("2026-09-01T12:00:00.000Z");

describe("Traffic Shield compact report service", () => {
  it("preserves the PHP India-date ring anchor and midnight boundary", () => {
    expect(trafficShieldSlot(new Date("1970-01-04T18:29:59.000Z"))).toEqual({ slot: 6, date: "1970-01-04" });
    expect(trafficShieldSlot(new Date("1970-01-04T18:30:00.000Z"))).toEqual({ slot: 0, date: "1970-01-05" });
    expect(trafficShieldSlotForDate("1970-01-11")).toBe(6);
    expect(trafficShieldSlotForDate("1970-01-12")).toBe(0);
  });

  it("returns seven exact author-wide buckets and serializes large counters losslessly", async () => {
    const store = new FakeShieldStore({
      activationStartedAtUtc: "2026-08-25 18:30:00",
      lifetimeTotal: 9_007_199_254_740_993n,
      dailyTotals: [1n, 2n, 3n, 4n, 5n, 6n, 7n],
    });

    await expect(loadTrafficShieldReport(store, 42, now)).resolves.toEqual({
      ok: true,
      total: "9007199254740993",
      history_total: "28",
      history_state: "exact",
      history_started_at: "2026-08-25 18:30:00",
      days: [
        { label: "Today so far", iso: "2026-09-01", count: "1", state: "exact_so_far" },
        { label: "Yesterday", iso: "2026-08-31", count: "2", state: "exact" },
        { label: "Sun 30 Aug", iso: "2026-08-30", count: "3", state: "exact" },
        { label: "Sat 29 Aug", iso: "2026-08-29", count: "4", state: "exact" },
        { label: "Fri 28 Aug", iso: "2026-08-28", count: "5", state: "exact" },
        { label: "Thu 27 Aug", iso: "2026-08-27", count: "6", state: "exact" },
        { label: "Wed 26 Aug", iso: "2026-08-26", count: "7", state: "exact" },
      ],
    });
    expect(store.userIds).toEqual([42]);
    expect(store.slots).toHaveLength(7);
    expect(new Set(store.slots.map((entry) => entry.slot)).size).toBe(7);
    expect(store.slots.map((entry) => entry.date)).toEqual([
      "2026-09-01", "2026-08-31", "2026-08-30", "2026-08-29", "2026-08-28", "2026-08-27", "2026-08-26",
    ]);
  });

  it("exposes only covered dates and marks a mid-day activation as partial", async () => {
    const store = new FakeShieldStore({
      activationStartedAtUtc: "2026-08-30 04:30:00",
      lifetimeTotal: 100n,
      dailyTotals: [11n, 12n, 13n, 14n, 15n, 16n, 17n],
    });

    const report = await loadTrafficShieldReport(store, 7, now);

    expect(report.history_state).toBe("collecting");
    expect(report.history_total).toBe("36");
    expect(report.days.map((day) => [day.iso, day.count, day.state])).toEqual([
      ["2026-09-01", "11", "exact_so_far"],
      ["2026-08-31", "12", "exact"],
      ["2026-08-30", "13", "collecting"],
      ["2026-08-29", null, "collecting"],
      ["2026-08-28", null, "collecting"],
      ["2026-08-27", null, "collecting"],
      ["2026-08-26", null, "collecting"],
    ]);
  });

  it.each([null, "not-a-timestamp", "2026-02-30 00:00:00"])(
    "treats a missing or malformed activation marker as collecting, never zero (%s)",
    async (activation) => {
      const report = await loadTrafficShieldReport(new FakeShieldStore({
        activationStartedAtUtc: activation,
        lifetimeTotal: 19n,
        dailyTotals: [0n, 0n, 0n, 0n, 0n, 0n, 0n],
      }), 9, now);

      expect(report.total).toBe("19");
      expect(report.history_started_at).toBeNull();
      expect(report.history_total).toBeNull();
      expect(report.history_state).toBe("collecting");
      expect(report.days.every((day) => day.count === null && day.state === "collecting")).toBe(true);
    },
  );

  it("mirrors the oracle's future-marker boundary without inventing older zeroes", async () => {
    const report = await loadTrafficShieldReport(new FakeShieldStore({
      activationStartedAtUtc: "2026-09-02 00:00:00",
      lifetimeTotal: 7n,
      dailyTotals: [5n, 4n, 3n, 2n, 1n, 0n, 0n],
    }), 9, now);

    expect(report.history_total).toBe("5");
    expect(report.days[0]).toMatchObject({ count: "5", state: "collecting" });
    expect(report.days.slice(1).every((day) => day.count === null)).toBe(true);
  });

  it("propagates storage failure and rejects invalid/overflowing aggregates", async () => {
    const failing: TrafficShieldStore = {
      loadTrafficShieldAggregate: async () => Promise.reject(new Error("database unavailable")),
    };
    await expect(loadTrafficShieldReport(failing, 1, now)).rejects.toThrow("database unavailable");

    for (const aggregate of [
      aggregateWith({ lifetimeTotal: -1n }),
      aggregateWith({ lifetimeTotal: 18_446_744_073_709_551_616n }),
      aggregateWith({ dailyTotals: [0n] }),
      aggregateWith({ dailyTotals: [0n, 0n, 0n, 0n, 0n, 0n, -1n] }),
    ]) {
      await expect(loadTrafficShieldReport(new FakeShieldStore(aggregate), 1, now)).rejects.toThrow(/Traffic Shield/);
    }
  });
});

class FakeShieldStore implements TrafficShieldStore {
  public readonly userIds: number[] = [];
  public slots: readonly TrafficShieldDateSlot[] = [];

  public constructor(private readonly aggregate: TrafficShieldAggregate) {}

  public async loadTrafficShieldAggregate(
    userId: number,
    slots: readonly TrafficShieldDateSlot[],
  ): Promise<TrafficShieldAggregate> {
    this.userIds.push(userId);
    this.slots = slots;
    return this.aggregate;
  }
}

function aggregateWith(overrides: Partial<TrafficShieldAggregate>): TrafficShieldAggregate {
  return {
    activationStartedAtUtc: "2026-08-25 18:30:00",
    lifetimeTotal: 0n,
    dailyTotals: [0n, 0n, 0n, 0n, 0n, 0n, 0n],
    ...overrides,
  };
}
