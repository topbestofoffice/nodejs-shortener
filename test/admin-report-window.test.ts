import { describe, expect, it } from "vitest";
import { buildAdminReportWindow } from "../src/modules/reporting/report-window.js";

describe("Admin completed report windows", () => {
  const now = new Date("2026-09-01T12:34:56.000Z");

  it("builds the ordinary six completed hours on a ten-minute edge", () => {
    expect(buildAdminReportWindow({
      range: "6h",
      timezone: "UTC",
      now,
      deliveredConfigured: false,
      deliveredSealLagSeconds: null,
    })).toEqual({
      range: "6h",
      timezone: "UTC",
      start: new Date("2026-09-01T06:30:00.000Z"),
      end: new Date("2026-09-01T12:30:00.000Z"),
      expectedBuckets: 36,
    });
  });

  it("keeps a Delivered window two buckets plus the configured seal lag behind", () => {
    expect(buildAdminReportWindow({
      range: "6h",
      timezone: "Asia/Kolkata",
      now,
      deliveredConfigured: true,
      deliveredSealLagSeconds: 600,
    })).toMatchObject({
      start: new Date("2026-09-01T06:00:00.000Z"),
      end: new Date("2026-09-01T12:00:00.000Z"),
      expectedBuckets: 36,
    });
  });

  it("uses the domain timezone for yesterday and seven completed days", () => {
    expect(buildAdminReportWindow({
      range: "yesterday",
      timezone: "UTC",
      now,
      deliveredConfigured: false,
      deliveredSealLagSeconds: null,
    })).toMatchObject({
      start: new Date("2026-08-31T00:00:00.000Z"),
      end: new Date("2026-09-01T00:00:00.000Z"),
      expectedBuckets: 144,
    });
    expect(buildAdminReportWindow({
      range: "7d",
      timezone: "Asia/Kolkata",
      now,
      deliveredConfigured: true,
      deliveredSealLagSeconds: 1,
    })).toMatchObject({
      start: new Date("2026-08-24T18:30:00.000Z"),
      end: new Date("2026-08-31T18:30:00.000Z"),
      expectedBuckets: 1008,
    });
  });

  it("fails closed on inconsistent or invalid Delivered seal configuration", () => {
    expect(() => buildAdminReportWindow({
      range: "6h",
      timezone: "UTC",
      now,
      deliveredConfigured: true,
      deliveredSealLagSeconds: null,
    })).toThrow(/1 to 3600/);
    expect(() => buildAdminReportWindow({
      range: "6h",
      timezone: "UTC",
      now,
      deliveredConfigured: false,
      deliveredSealLagSeconds: 600,
    })).toThrow(/non-Delivered/);
  });
});
