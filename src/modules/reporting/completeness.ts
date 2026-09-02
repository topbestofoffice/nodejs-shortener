import { createHash } from "node:crypto";
import type {
  DeliveredCountryHistoryRow,
  DeliveredCountryStateRow,
  DeliveredCountryWindowRows,
} from "../../core/types.js";

export const DELIVERED_COUNTRY_BUCKET_SECONDS = 600;
export const DELIVERED_COUNTRY_WINDOW_BUCKETS = 36;
export const DELIVERED_COUNTRY_MAX_WINDOW_BUCKETS = 1008;
export const DELIVERED_COUNTRY_REDIS_RETENTION_SECONDS = 172_800;
export const DELIVERED_COUNTRY_MAX_COUNTRIES = 677;
const DELIVERED_COUNTRY_MAX_COUNTER = 9_223_372_036_854_775_807n;

export type DeliveredCountryIncompleteReason =
  | "invalid_rows"
  | "missing_state"
  | "state_incomplete"
  | "state_not_positive"
  | "invalid_provenance"
  | "invalid_source"
  | "missing_history"
  | "invalid_history"
  | "history_mismatch";

export interface DeliveredCountryWindowEvaluation {
  readonly state: "complete" | "collecting_incomplete";
  readonly expectedBuckets: number;
  readonly completeBuckets: number;
  readonly deliveredTotal: bigint | null;
  readonly reason: DeliveredCountryIncompleteReason | null;
}

export interface DeliveredCountryRedisSnapshot {
  readonly domainId: number;
  readonly bucketStart: Date;
  readonly redisRunIdSha256: string;
  readonly observed: bigint;
  readonly countries: Readonly<Record<string, bigint>>;
}

export type DeliveredCountryReconciliation =
  | { readonly action: "invalidate"; readonly reason: "source_unavailable" | "invalid_source" }
  | { readonly action: "replace"; readonly sourceSha256: string; readonly deliveredTotal: bigint }
  | { readonly action: "unchanged"; readonly sourceSha256: string; readonly deliveredTotal: bigint };

/**
 * Evaluate one exact six-hour reporting window without manufacturing missing
 * history. Only 36 contiguous, positive, source-bound ten-minute buckets can
 * become complete. NULL Delivered cells remain valid for diversion-only rows.
 */
export function evaluateDeliveredCountryWindow(
  domainId: number,
  start: Date,
  rows: DeliveredCountryWindowRows,
): DeliveredCountryWindowEvaluation {
  const end = new Date(
    start.getTime() + DELIVERED_COUNTRY_WINDOW_BUCKETS * DELIVERED_COUNTRY_BUCKET_SECONDS * 1000,
  );
  return evaluateDeliveredCountryRange(domainId, start, end, rows);
}

/**
 * Evaluate an exact completed Admin reporting range without manufacturing
 * missing Delivered history. The caller owns the calendar-window calculation;
 * this validator accepts only 1..1008 aligned ten-minute buckets (up to seven
 * complete days) and retains the same source/provenance/hash checks as the
 * legacy six-hour contract.
 */
export function evaluateDeliveredCountryRange(
  domainId: number,
  start: Date,
  end: Date,
  rows: DeliveredCountryWindowRows,
): DeliveredCountryWindowEvaluation {
  const startEpoch = alignedEpoch(start);
  const endEpoch = alignedEpoch(end);
  const durationSeconds = endEpoch - startEpoch;
  const expectedBuckets = durationSeconds / DELIVERED_COUNTRY_BUCKET_SECONDS;
  if (!Number.isSafeInteger(expectedBuckets)
    || expectedBuckets < 1 || expectedBuckets > DELIVERED_COUNTRY_MAX_WINDOW_BUCKETS) {
    throw new RangeError("Delivered-country range must contain 1..1008 exact ten-minute buckets.");
  }
  const states = new Map<number, DeliveredCountryStateRow>();
  const history = new Map<number, Map<string, bigint | null>>();
  let invalidRows = false;

  for (const row of rows.states) {
    const epoch = safeEpoch(row.bucketStart);
    if (row.domainId !== domainId || epoch === null || epoch < startEpoch || epoch >= endEpoch
      || epoch % DELIVERED_COUNTRY_BUCKET_SECONDS !== 0 || states.has(epoch)) {
      invalidRows = true;
      continue;
    }
    states.set(epoch, row);
  }

  for (const row of rows.history) {
    const epoch = safeEpoch(row.bucketStart);
    if (row.domainId !== domainId || epoch === null || epoch < startEpoch || epoch >= endEpoch
      || epoch % DELIVERED_COUNTRY_BUCKET_SECONDS !== 0 || !validCountry(row.country)) {
      invalidRows = true;
      continue;
    }
    const bucket = history.get(epoch) ?? new Map<string, bigint | null>();
    if (bucket.has(row.country) || (row.delivered !== null && row.delivered < 0n)) {
      invalidRows = true;
      continue;
    }
    bucket.set(row.country, row.delivered);
    history.set(epoch, bucket);
  }

  if (invalidRows) {
    return incomplete(expectedBuckets, 0, "invalid_rows");
  }

  let deliveredTotal = 0n;
  let completeBuckets = 0;
  for (let index = 0; index < expectedBuckets; index += 1) {
    const epoch = startEpoch + index * DELIVERED_COUNTRY_BUCKET_SECONDS;
    const state = states.get(epoch);
    if (state === undefined) {
      return incomplete(expectedBuckets, completeBuckets, "missing_state");
    }
    if (state.status !== "complete") {
      return incomplete(expectedBuckets, completeBuckets, "state_incomplete");
    }
    if (state.deliveredTotal === null || !validPositiveCounter(state.deliveredTotal)) {
      return incomplete(expectedBuckets, completeBuckets, "state_not_positive");
    }
    if (state.provenance !== "redis_nonempty") {
      return incomplete(expectedBuckets, completeBuckets, "invalid_provenance");
    }
    if (!validSha256(state.sourceSha256) || !validSha256(state.redisRunIdSha256)) {
      return incomplete(expectedBuckets, completeBuckets, "invalid_source");
    }

    const bucketHistory = history.get(epoch);
    if (bucketHistory === undefined) {
      return incomplete(expectedBuckets, completeBuckets, "missing_history");
    }
    let historyTotal = 0n;
    let deliveredCountries = 0;
    for (const delivered of bucketHistory.values()) {
      if (delivered === null) {
        continue;
      }
      if (!validPositiveCounter(delivered) || historyTotal > DELIVERED_COUNTRY_MAX_COUNTER - delivered) {
        return incomplete(expectedBuckets, completeBuckets, "invalid_history");
      }
      deliveredCountries += 1;
      historyTotal += delivered;
    }
    if (deliveredCountries === 0) {
      return incomplete(expectedBuckets, completeBuckets, "missing_history");
    }
    if (historyTotal !== state.deliveredTotal) {
      return incomplete(expectedBuckets, completeBuckets, "history_mismatch");
    }
    if (deliveredTotal > DELIVERED_COUNTRY_MAX_COUNTER - state.deliveredTotal) {
      return incomplete(expectedBuckets, completeBuckets, "state_not_positive");
    }
    deliveredTotal += state.deliveredTotal;
    completeBuckets += 1;
  }

  if (states.size !== expectedBuckets) {
    return incomplete(expectedBuckets, completeBuckets, "invalid_rows");
  }
  return {
    state: "complete",
    expectedBuckets,
    completeBuckets,
    deliveredTotal,
    reason: null,
  };
}

/**
 * Compare one sealed Redis source bucket to its published state/history. This
 * function decides only; the singleton publisher remains a separately gated
 * writer.
 */
export function reconcileDeliveredCountryBucket(
  snapshot: DeliveredCountryRedisSnapshot | null,
  state: DeliveredCountryStateRow | null,
  history: readonly DeliveredCountryHistoryRow[],
): DeliveredCountryReconciliation {
  if (snapshot === null) {
    return { action: "invalidate", reason: "source_unavailable" };
  }
  const normalized = normalizeSnapshot(snapshot);
  if (normalized === null) {
    return { action: "invalidate", reason: "invalid_source" };
  }
  const sourceSha256 = deliveredCountrySourceSha256(normalized);
  const matchesState = state !== null
    && state.domainId === normalized.domainId
    && safeEpoch(state.bucketStart) === safeEpoch(normalized.bucketStart)
    && state.status === "complete"
    && state.deliveredTotal === normalized.observed
    && state.provenance === "redis_nonempty"
    && state.redisRunIdSha256 === normalized.redisRunIdSha256
    && state.sourceSha256 === sourceSha256;

  const published = publishedCountryMap(normalized, history);
  if (!matchesState || published === null || !countryMapsEqual(normalized.countries, published)) {
    return { action: "replace", sourceSha256, deliveredTotal: normalized.observed };
  }
  return { action: "unchanged", sourceSha256, deliveredTotal: normalized.observed };
}

/** Exact SHA-256 payload used by the accepted D2/D3 PHP publishers. */
export function deliveredCountrySourceSha256(snapshot: DeliveredCountryRedisSnapshot): string {
  const bucketStart = alignedEpoch(snapshot.bucketStart);
  const countries = Object.entries(snapshot.countries).sort(([left], [right]) => compareAscii(left, right));
  const countryJson = countries
    .map(([country, count]) => `${JSON.stringify(country)}:${count.toString()}`)
    .join(",");
  const payload = `{"schema":1,"domain_id":${snapshot.domainId},"bucket_start":${bucketStart},`
    + `"redis_run_id_sha256":${JSON.stringify(snapshot.redisRunIdSha256)},`
    + `"observed":${snapshot.observed.toString()},"countries":{${countryJson}}}`;
  return createHash("sha256").update(payload).digest("hex");
}

function normalizeSnapshot(snapshot: DeliveredCountryRedisSnapshot): DeliveredCountryRedisSnapshot | null {
  const epoch = safeEpoch(snapshot.bucketStart);
  const entries = Object.entries(snapshot.countries).sort(([left], [right]) => compareAscii(left, right));
  if (!Number.isInteger(snapshot.domainId) || snapshot.domainId < 1 || snapshot.domainId > 65_535
    || epoch === null || epoch % DELIVERED_COUNTRY_BUCKET_SECONDS !== 0
    || !validSha256(snapshot.redisRunIdSha256) || !validPositiveCounter(snapshot.observed)
    || entries.length < 1 || entries.length > DELIVERED_COUNTRY_MAX_COUNTRIES) {
    return null;
  }
  let total = 0n;
  const countries: Record<string, bigint> = {};
  for (const [country, count] of entries) {
    if (!validCountry(country) || !validPositiveCounter(count)
      || total > DELIVERED_COUNTRY_MAX_COUNTER - count) {
      return null;
    }
    countries[country] = count;
    total += count;
  }
  if (total !== snapshot.observed) {
    return null;
  }
  return { ...snapshot, countries };
}

function publishedCountryMap(
  snapshot: DeliveredCountryRedisSnapshot,
  history: readonly DeliveredCountryHistoryRow[],
): Readonly<Record<string, bigint>> | null {
  const epoch = safeEpoch(snapshot.bucketStart);
  const countries: Record<string, bigint> = {};
  const seen = new Set<string>();
  for (const row of history) {
    if (row.domainId !== snapshot.domainId || safeEpoch(row.bucketStart) !== epoch || !validCountry(row.country)) {
      return null;
    }
    if (seen.has(row.country)) {
      return null;
    }
    seen.add(row.country);
    if (row.delivered === null) {
      continue;
    }
    if (!validPositiveCounter(row.delivered) || Object.hasOwn(countries, row.country)) {
      return null;
    }
    countries[row.country] = row.delivered;
  }
  return countries;
}

function countryMapsEqual(
  left: Readonly<Record<string, bigint>>,
  right: Readonly<Record<string, bigint>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => compareAscii(a, b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => compareAscii(a, b));
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([country, count], index) => {
      const candidate = rightEntries[index];
      return candidate !== undefined && candidate[0] === country && candidate[1] === count;
    });
}

function incomplete(
  expectedBuckets: number,
  completeBuckets: number,
  reason: DeliveredCountryIncompleteReason,
): DeliveredCountryWindowEvaluation {
  return {
    state: "collecting_incomplete",
    expectedBuckets,
    completeBuckets,
    deliveredTotal: null,
    reason,
  };
}

function alignedEpoch(value: Date): number {
  const epoch = safeEpoch(value);
  if (epoch === null || epoch % DELIVERED_COUNTRY_BUCKET_SECONDS !== 0) {
    throw new RangeError("Delivered-country window must start on an exact UTC ten-minute boundary.");
  }
  return epoch;
}

function safeEpoch(value: Date): number | null {
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds % 1000 !== 0) {
    return null;
  }
  return milliseconds / 1000;
}

function validCountry(country: string): boolean {
  return /^(?:[A-Z]{2}|\?\?)$/.test(country);
}

function validSha256(value: string | null): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validPositiveCounter(value: bigint): boolean {
  return value > 0n && value <= DELIVERED_COUNTRY_MAX_COUNTER;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
