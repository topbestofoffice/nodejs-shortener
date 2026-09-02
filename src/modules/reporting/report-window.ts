import { DELIVERED_COUNTRY_BUCKET_SECONDS } from "./completeness.js";

export type AdminReportRange = "6h" | "yesterday" | "7d";
export type AdminReportTimezone = "UTC" | "Asia/Kolkata";

export interface AdminReportWindowInput {
  readonly range: AdminReportRange;
  readonly timezone: AdminReportTimezone;
  readonly now: Date;
  /** True only after the exact domain's external Delivered contract is enabled. */
  readonly deliveredConfigured: boolean;
  /** Validated publisher seal lag. Must be 1..3600 when Delivered is configured. */
  readonly deliveredSealLagSeconds: number | null;
}

export interface AdminReportWindow {
  readonly range: AdminReportRange;
  readonly timezone: AdminReportTimezone;
  readonly start: Date;
  readonly end: Date;
  readonly expectedBuckets: number;
}

const secondsPerDay = 86_400;
const publisherMissToleranceSeconds = 1_200;

/**
 * Reproduce the accepted PHP Admin's completed-window boundaries. Calendar
 * ranges use the selected domain's explicit timezone. Delivered-enabled 6h
 * ranges remain two buckets behind the publisher seal clock so one missed
 * writer-lock slot does not become a false complete edge.
 */
export function buildAdminReportWindow(input: AdminReportWindowInput): AdminReportWindow {
  const nowEpoch = exactEpoch(input.now);
  const offset = timezoneOffsetSeconds(input.timezone);
  let startEpoch: number;
  let endEpoch: number;

  if (input.range === "6h") {
    const sealLag = deliveredSealLag(input.deliveredConfigured, input.deliveredSealLagSeconds);
    const edgeTolerance = input.deliveredConfigured ? publisherMissToleranceSeconds : 0;
    endEpoch = Math.floor(
      (nowEpoch - sealLag - edgeTolerance) / DELIVERED_COUNTRY_BUCKET_SECONDS,
    ) * DELIVERED_COUNTRY_BUCKET_SECONDS;
    startEpoch = endEpoch - 6 * 60 * 60;
  } else {
    deliveredSealLag(input.deliveredConfigured, input.deliveredSealLagSeconds);
    const todayStartEpoch = Math.floor((nowEpoch + offset) / secondsPerDay) * secondsPerDay - offset;
    endEpoch = todayStartEpoch;
    startEpoch = endEpoch - (input.range === "yesterday" ? secondsPerDay : 7 * secondsPerDay);
  }

  const expectedBuckets = (endEpoch - startEpoch) / DELIVERED_COUNTRY_BUCKET_SECONDS;
  if (!Number.isSafeInteger(expectedBuckets) || expectedBuckets < 1 || expectedBuckets > 1008) {
    throw new RangeError("Admin report window is outside the supported completed range.");
  }
  return Object.freeze({
    range: input.range,
    timezone: input.timezone,
    start: new Date(startEpoch * 1000),
    end: new Date(endEpoch * 1000),
    expectedBuckets,
  });
}

function deliveredSealLag(configured: boolean, value: number | null): number {
  if (!configured) {
    if (value !== null && value !== 0) {
      throw new RangeError("A Delivered seal lag cannot be set for a non-Delivered report domain.");
    }
    return 0;
  }
  if (!Number.isSafeInteger(value) || value === null || value < 1 || value > 3_600) {
    throw new RangeError("Delivered seal lag must be a whole number from 1 to 3600 seconds.");
  }
  return value;
}

function timezoneOffsetSeconds(value: AdminReportTimezone): number {
  switch (value) {
    case "UTC": return 0;
    case "Asia/Kolkata": return 5 * 60 * 60 + 30 * 60;
  }
}

function exactEpoch(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds) || milliseconds % 1000 !== 0) {
    throw new RangeError("Admin report time must be an exact whole second.");
  }
  return milliseconds / 1000;
}
