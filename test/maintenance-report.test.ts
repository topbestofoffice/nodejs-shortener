import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMaintenanceDryRunReceipt,
  parseMaintenanceInventorySnapshot,
  type MaintenanceInventorySnapshot,
} from "../src/modules/maintenance/maintenance-report.js";
import { writeMaintenanceDryRunReceipt } from "../src/modules/maintenance/maintenance-receipt.js";

const capturedAt = new Date("2026-09-01T13:17:00.000Z");
const generatedAt = new Date("2026-09-01T13:18:00.000Z");
const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("maintenance dry-run reporting", () => {
  it("selects bounded candidates, preserves unknown counts and proves zero mutations", () => {
    const snapshot = fixture();
    const receipt = buildMaintenanceDryRunReceipt(snapshot, generatedAt, 1);

    expect(receipt).toMatchObject({
      result: "REPORT_ONLY",
      policy: { candidateCap: 1 },
      summary: {
        linked: { scanned: 3, eligibleWithinCap: 1 },
        orphan: { scanned: 3, eligibleWithinCap: 1 },
        aggregates: { staleIpGeoCacheRows: null },
        aggregateCutoffs: { terminalImageJobsBefore: null },
      },
      mutations: { attempted: "0", databaseRows: "0", files: "0", redisKeys: "0" },
    });
    expect(receipt.limitations).toContain("One or more maintenance aggregate counts were not observed; null is unknown, not zero.");
    expect(receipt.summary.linked.candidatePathSetSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.source.snapshotSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("makes the source digest independent of candidate input ordering", () => {
    const first = fixture();
    const second = {
      ...first,
      linkedImages: [...first.linkedImages].reverse(),
      orphanImages: [...first.orphanImages].reverse(),
    };
    expect(buildMaintenanceDryRunReceipt(first, generatedAt).source.snapshotSha256)
      .toBe(buildMaintenanceDryRunReceipt(second, generatedAt).source.snapshotSha256);
  });

  it("rejects unknown fields, malformed decimal counts and future snapshots", () => {
    const raw = rawFixture();
    expect(() => parseMaintenanceInventorySnapshot({ ...raw, apply: true })).toThrow();
    expect(() => parseMaintenanceInventorySnapshot({
      ...raw,
      aggregates: { ...raw.aggregates, expiredRememberTokens: "01" },
    })).toThrow();
    expect(() => buildMaintenanceDryRunReceipt(
      { ...fixture(), capturedAt: new Date("2026-09-01T13:30:00.000Z") },
      generatedAt,
    )).toThrow("more than five minutes in the future");
    expect(() => buildMaintenanceDryRunReceipt({
      ...fixture(),
      aggregateCutoffs: {
        ...fixture().aggregateCutoffs,
        legacyClicksBefore: new Date("2026-09-02T00:00:00.000Z"),
      },
    }, generatedAt)).toThrow("is after capturedAt");
    expect(() => buildMaintenanceDryRunReceipt({
      ...fixture(),
      linkedImages: [fixture().linkedImages[0]!, fixture().linkedImages[0]!],
    }, generatedAt)).toThrow("Duplicate linked-image path");
  });

  it("persists an exclusive read-back-verified receipt and never overwrites it", async () => {
    const root = await mkdtemp(join(tmpdir(), "maintenance-receipt-"));
    temporary.push(root);
    const receipt = buildMaintenanceDryRunReceipt(fixture(), generatedAt);
    const saved = await writeMaintenanceDryRunReceipt(join(root, "receipts"), receipt);
    const bytes = await readFile(saved.path);

    expect(saved.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.bytes).toBe(bytes.byteLength);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(receipt);
  });

  it("fails closed when another report writer or stale lock exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "maintenance-lock-"));
    temporary.push(root);
    const receiptDirectory = join(root, "receipts");
    await mkdir(join(receiptDirectory, ".maintenance-report.lock"), { recursive: true });

    await expect(writeMaintenanceDryRunReceipt(
      receiptDirectory,
      buildMaintenanceDryRunReceipt(fixture(), generatedAt),
    )).rejects.toThrow("MAINTENANCE_REPORT_LOCKED");
  });
});

function fixture(): MaintenanceInventorySnapshot {
  return parseMaintenanceInventorySnapshot(rawFixture());
}

function rawFixture() {
  return {
    schemaVersion: 1,
    targetId: "local-maintenance-fixture",
    capturedAt: capturedAt.toISOString(),
    linkedScanComplete: true,
    orphanScanComplete: false,
    linkedImages: [
      linked("uploads/0000000000000001.jpg", 8, 0, 1, true),
      linked("uploads/0000000000000002.jpg", 6, 0, 1, true),
      linked("uploads/0000000000000003.jpg", 8, 100, 2, true),
    ],
    orphanImages: [
      orphan("uploads/1000000000000001.jpg", 2, 0, true),
      orphan("uploads/1000000000000002.jpg", 2, 1, true),
      orphan("uploads/1000000000000003.jpg", 2, 0, false),
    ],
    aggregates: {
      legacyClicksOlderThanSevenDays: "12500",
      diversionHistoryOlderThanEightIndiaDays: "40",
      expiredRememberTokens: "2",
      authThrottleOlderThanSevenDays: "3",
      expiredReadyUploads: "4",
      expiredAttachedUploads: "5",
      terminalImageJobsPastRetention: "6",
      staleIpGeoCacheRows: null,
      staleDeliveredCountryStateRows: null,
    },
    aggregateCutoffs: {
      legacyClicksBefore: "2026-08-25T13:17:00.000Z",
      diversionHistoryBefore: "2026-08-24T18:30:00.000Z",
      rememberTokensBefore: capturedAt.toISOString(),
      authThrottleBefore: "2026-08-25T13:17:00.000Z",
      uploadExpiryBefore: capturedAt.toISOString(),
      terminalImageJobsBefore: null,
      ipGeoCacheBefore: null,
      deliveredCountryStateBefore: null,
    },
  };
}

function linked(path: string, ageDays: number, activity: number, refs: number, owned: boolean) {
  return {
    path,
    newestReferenceAt: new Date(capturedAt.getTime() - ageDays * 86_400_000).toISOString(),
    latest24HourActivity: activity,
    referenceCount: refs,
    ownershipRegistered: owned,
  };
}

function orphan(path: string, ageDays: number, refs: number, owned: boolean) {
  return {
    path,
    createdAt: new Date(capturedAt.getTime() - ageDays * 86_400_000).toISOString(),
    referenceCount: refs,
    ownershipRegistered: owned,
  };
}
