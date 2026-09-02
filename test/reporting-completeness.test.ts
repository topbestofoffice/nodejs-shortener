import { describe, expect, it } from "vitest";
import type {
  DeliveredCountryHistoryRow,
  DeliveredCountryStateRow,
} from "../src/core/types.js";
import {
  DELIVERED_COUNTRY_BUCKET_SECONDS,
  DELIVERED_COUNTRY_MAX_WINDOW_BUCKETS,
  DELIVERED_COUNTRY_WINDOW_BUCKETS,
  deliveredCountrySourceSha256,
  evaluateDeliveredCountryWindow,
  evaluateDeliveredCountryRange,
  reconcileDeliveredCountryBucket,
  type DeliveredCountryRedisSnapshot,
} from "../src/modules/reporting/completeness.js";

const start = new Date("2026-09-01T00:00:00.000Z");
const sourceSha256 = "a".repeat(64);
const runSha256 = "b".repeat(64);

describe("Delivered-country truthful completeness", () => {
  it("requires exactly 36 contiguous, positive and reconciled buckets", () => {
    const rows = windowRows(DELIVERED_COUNTRY_WINDOW_BUCKETS);

    expect(evaluateDeliveredCountryWindow(3, start, rows)).toEqual({
      state: "complete",
      expectedBuckets: 36,
      completeBuckets: 36,
      deliveredTotal: 108n,
      reason: null,
    });
  });

  it("derives a fresh 2/36 generation without freezing or backfilling it", () => {
    const rows = windowRows(2);

    expect(evaluateDeliveredCountryWindow(3, start, rows)).toEqual({
      state: "collecting_incomplete",
      expectedBuckets: 36,
      completeBuckets: 2,
      deliveredTotal: null,
      reason: "missing_state",
    });
  });

  it("is NULL-safe for diversion-only country rows", () => {
    const rows = windowRows(DELIVERED_COUNTRY_WINDOW_BUCKETS);
    expect(rows.history.some((row) => row.delivered === null)).toBe(true);
    expect(evaluateDeliveredCountryWindow(3, start, rows).state).toBe("complete");
  });

  it("applies the same strict checks to completed one-day and seven-day Admin ranges", () => {
    for (const bucketCount of [144, DELIVERED_COUNTRY_MAX_WINDOW_BUCKETS]) {
      const end = bucket(bucketCount);
      expect(evaluateDeliveredCountryRange(3, start, end, windowRows(bucketCount))).toEqual({
        state: "complete",
        expectedBuckets: bucketCount,
        completeBuckets: bucketCount,
        deliveredTotal: BigInt(bucketCount * 3),
        reason: null,
      });
    }
  });

  it("rejects empty, over-seven-day and unaligned Admin ranges", () => {
    expect(() => evaluateDeliveredCountryRange(3, start, start, windowRows(0))).toThrow(/1\.\.1008/);
    expect(() => evaluateDeliveredCountryRange(
      3,
      start,
      bucket(DELIVERED_COUNTRY_MAX_WINDOW_BUCKETS + 1),
      windowRows(DELIVERED_COUNTRY_MAX_WINDOW_BUCKETS + 1),
    )).toThrow(/1\.\.1008/);
    expect(() => evaluateDeliveredCountryRange(
      3,
      start,
      new Date(bucket(1).getTime() + 1_000),
      windowRows(1),
    )).toThrow(/ten-minute boundary/);
  });

  it("fails closed on zero, invalid provenance, source, or history mismatch", () => {
    const zero = windowRows(36);
    zero.states[4] = { ...zero.states[4]!, deliveredTotal: 0n };
    expect(evaluateDeliveredCountryWindow(3, start, zero)).toMatchObject({
      completeBuckets: 4,
      reason: "state_not_positive",
    });

    const provenance = windowRows(36);
    provenance.states[0] = { ...provenance.states[0]!, provenance: "health_incomplete" };
    expect(evaluateDeliveredCountryWindow(3, start, provenance).reason).toBe("invalid_provenance");

    const source = windowRows(36);
    source.states[0] = { ...source.states[0]!, sourceSha256: "invalid" };
    expect(evaluateDeliveredCountryWindow(3, start, source).reason).toBe("invalid_source");

    const history = windowRows(36);
    const first = history.history.findIndex((row) => row.bucketStart.getTime() === start.getTime()
      && row.country === "IN");
    history.history[first] = { ...history.history[first]!, delivered: 1n };
    expect(evaluateDeliveredCountryWindow(3, start, history).reason).toBe("history_mismatch");
  });
});

describe("Delivered-country pure reconciliation", () => {
  it("matches the accepted PHP publisher source hash payload", () => {
    const snapshot = redisSnapshot();
    expect(deliveredCountrySourceSha256(snapshot))
      .toBe("c4ed37ad2d9424cb008f188694cfb02205689b39e0ebcc2d70a3bc5cab410845");
  });

  it("distinguishes unchanged, replacement and invalid source decisions", () => {
    const snapshot = redisSnapshot();
    const state = stateRow(0, 3n, deliveredCountrySourceSha256(snapshot));
    const history = historyRows(0);

    expect(reconcileDeliveredCountryBucket(snapshot, state, history).action).toBe("unchanged");
    expect(reconcileDeliveredCountryBucket(snapshot, state, [
      { ...history[0]!, delivered: 1n },
      ...history.slice(1),
    ]).action).toBe("replace");
    expect(reconcileDeliveredCountryBucket(null, state, history)).toEqual({
      action: "invalidate",
      reason: "source_unavailable",
    });
    expect(reconcileDeliveredCountryBucket({ ...snapshot, observed: 4n }, state, history)).toEqual({
      action: "invalidate",
      reason: "invalid_source",
    });
  });
});

function windowRows(count: number): {
  states: DeliveredCountryStateRow[];
  history: DeliveredCountryHistoryRow[];
} {
  const states: DeliveredCountryStateRow[] = [];
  const history: DeliveredCountryHistoryRow[] = [];
  for (let index = 0; index < count; index += 1) {
    states.push(stateRow(index));
    history.push(...historyRows(index));
  }
  return { states, history };
}

function stateRow(index: number, total = 3n, hash = sourceSha256): DeliveredCountryStateRow {
  const bucketStart = bucket(index);
  return {
    domainId: 3,
    bucketStart,
    status: "complete",
    deliveredTotal: total,
    provenance: "redis_nonempty",
    sourceSha256: hash,
    redisRunIdSha256: runSha256,
    reasonCode: null,
    recordedAt: new Date(bucketStart.getTime() + 660_000),
  };
}

function historyRows(index: number): DeliveredCountryHistoryRow[] {
  const bucketStart = bucket(index);
  return [
    { domainId: 3, bucketStart, country: "IN", delivered: 2n },
    { domainId: 3, bucketStart, country: "US", delivered: 1n },
    { domainId: 3, bucketStart, country: "GB", delivered: null },
  ];
}

function redisSnapshot(): DeliveredCountryRedisSnapshot {
  return {
    domainId: 3,
    bucketStart: start,
    redisRunIdSha256: runSha256,
    observed: 3n,
    countries: { IN: 2n, US: 1n },
  };
}

function bucket(index: number): Date {
  return new Date(start.getTime() + index * DELIVERED_COUNTRY_BUCKET_SECONDS * 1000);
}
