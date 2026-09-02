import { createHash } from "node:crypto";
import { z } from "zod";
import {
  selectLinkedImages,
  selectOrphanImages,
  type LinkedImageCandidate,
  type OrphanImageCandidate,
} from "./image-cleanup-policy.js";

const maximumSnapshotRows = 100_000;
const maximumCandidateBatch = 2_000;
const targetIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const decimalCount = z.string().max(20).regex(/^(?:0|[1-9][0-9]*)$/).nullable();
const timestamp = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const nullableTimestamp = timestamp.nullable();

const linkedCandidateSchema = z.object({
  path: z.string().min(1).max(255),
  newestReferenceAt: timestamp,
  latest24HourActivity: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  referenceCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ownershipRegistered: z.boolean(),
}).strict();

const orphanCandidateSchema = z.object({
  path: z.string().min(1).max(255),
  createdAt: timestamp,
  referenceCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ownershipRegistered: z.boolean(),
}).strict();

const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  targetId: z.string().regex(targetIdPattern),
  capturedAt: timestamp,
  linkedScanComplete: z.boolean(),
  orphanScanComplete: z.boolean(),
  linkedImages: z.array(linkedCandidateSchema).max(maximumSnapshotRows),
  orphanImages: z.array(orphanCandidateSchema).max(maximumSnapshotRows),
  aggregates: z.object({
    legacyClicksOlderThanSevenDays: decimalCount,
    diversionHistoryOlderThanEightIndiaDays: decimalCount,
    expiredRememberTokens: decimalCount,
    authThrottleOlderThanSevenDays: decimalCount,
    expiredReadyUploads: decimalCount,
    expiredAttachedUploads: decimalCount,
    terminalImageJobsPastRetention: decimalCount,
    staleIpGeoCacheRows: decimalCount,
    staleDeliveredCountryStateRows: decimalCount,
  }).strict(),
  aggregateCutoffs: z.object({
    legacyClicksBefore: timestamp,
    diversionHistoryBefore: timestamp,
    rememberTokensBefore: timestamp,
    authThrottleBefore: timestamp,
    uploadExpiryBefore: timestamp,
    terminalImageJobsBefore: nullableTimestamp,
    ipGeoCacheBefore: nullableTimestamp,
    deliveredCountryStateBefore: nullableTimestamp,
  }).strict(),
}).strict();

export interface MaintenanceInventorySnapshot {
  readonly schemaVersion: 1;
  readonly targetId: string;
  readonly capturedAt: Date;
  readonly linkedScanComplete: boolean;
  readonly orphanScanComplete: boolean;
  readonly linkedImages: readonly LinkedImageCandidate[];
  readonly orphanImages: readonly OrphanImageCandidate[];
  readonly aggregates: MaintenanceAggregateCounts;
  readonly aggregateCutoffs: MaintenanceAggregateCutoffs;
}

export interface MaintenanceAggregateCounts {
  readonly legacyClicksOlderThanSevenDays: string | null;
  readonly diversionHistoryOlderThanEightIndiaDays: string | null;
  readonly expiredRememberTokens: string | null;
  readonly authThrottleOlderThanSevenDays: string | null;
  readonly expiredReadyUploads: string | null;
  readonly expiredAttachedUploads: string | null;
  readonly terminalImageJobsPastRetention: string | null;
  readonly staleIpGeoCacheRows: string | null;
  readonly staleDeliveredCountryStateRows: string | null;
}

export interface MaintenanceAggregateCutoffs {
  readonly legacyClicksBefore: Date;
  readonly diversionHistoryBefore: Date;
  readonly rememberTokensBefore: Date;
  readonly authThrottleBefore: Date;
  readonly uploadExpiryBefore: Date;
  readonly terminalImageJobsBefore: Date | null;
  readonly ipGeoCacheBefore: Date | null;
  readonly deliveredCountryStateBefore: Date | null;
}

export interface MaintenanceDryRunReceipt {
  readonly schemaVersion: 1;
  readonly kind: "nodejs-shortener-maintenance-dry-run-receipt";
  readonly result: "REPORT_ONLY";
  readonly generatedAt: string;
  readonly source: {
    readonly targetId: string;
    readonly capturedAt: string;
    readonly snapshotSha256: string;
    readonly linkedScanComplete: boolean;
    readonly orphanScanComplete: boolean;
  };
  readonly policy: {
    readonly linkedImages: "newest-reference-at-least-7d-and-latest24h-under-100-and-owned";
    readonly orphanImages: "older-than-24h-and-zero-references-and-owned";
    readonly candidateCap: number;
  };
  readonly summary: {
    readonly linked: CandidateSummary;
    readonly orphan: CandidateSummary;
    readonly aggregates: MaintenanceAggregateCounts;
    readonly aggregateCutoffs: Readonly<Record<keyof MaintenanceAggregateCutoffs, string | null>>;
  };
  readonly mutations: {
    readonly attempted: "0";
    readonly databaseRows: "0";
    readonly files: "0";
    readonly redisKeys: "0";
  };
  readonly limitations: readonly string[];
}

interface CandidateSummary {
  readonly scanned: number;
  readonly eligibleWithinCap: number;
  readonly candidatePathSetSha256: string;
}

export function parseMaintenanceInventorySnapshot(value: unknown): MaintenanceInventorySnapshot {
  return snapshotSchema.parse(value);
}

export function buildMaintenanceDryRunReceipt(
  snapshot: MaintenanceInventorySnapshot,
  generatedAt: Date,
  requestedCap = maximumCandidateBatch,
): MaintenanceDryRunReceipt {
  assertValidDate(generatedAt, "generatedAt");
  assertValidDate(snapshot.capturedAt, "capturedAt");
  if (!targetIdPattern.test(snapshot.targetId)) throw new Error("Invalid maintenance targetId.");
  if (snapshot.capturedAt.getTime() > generatedAt.getTime() + 5 * 60_000) {
    throw new Error("Maintenance snapshot is more than five minutes in the future.");
  }
  if (!Number.isSafeInteger(requestedCap) || requestedCap < 1 || requestedCap > maximumCandidateBatch) {
    throw new Error(`Maintenance candidate cap must be between 1 and ${maximumCandidateBatch}.`);
  }
  assertUniqueSnapshotPaths(snapshot);
  const cutoffEntries = Object.entries(snapshot.aggregateCutoffs) as ReadonlyArray<
    readonly [keyof MaintenanceAggregateCutoffs, Date | null]
  >;
  for (const [name, cutoff] of cutoffEntries) {
    if (cutoff !== null) {
      assertValidDate(cutoff, name);
      if (cutoff.getTime() > snapshot.capturedAt.getTime()) {
        throw new Error(`Maintenance aggregate cutoff ${name} is after capturedAt.`);
      }
    }
  }

  const normalized = normalizeSnapshot(snapshot);
  const linked = selectLinkedImages(snapshot.linkedImages, snapshot.capturedAt, requestedCap);
  const orphan = selectOrphanImages(snapshot.orphanImages, snapshot.capturedAt, requestedCap);
  const limitations = [
    "This receipt proves dry-run planning only and authorizes no deletion.",
    "No MariaDB transaction, final ownership/reference lock, filesystem identity, Redis invalidation, or restore was exercised.",
    "Cron/PM2 singleton scheduling and Cloudways resource behavior are not verified by this receipt.",
  ];
  if (!snapshot.linkedScanComplete) limitations.push("The linked-image source scan was incomplete.");
  if (!snapshot.orphanScanComplete) limitations.push("The orphan-image source scan was incomplete.");
  if (Object.values(snapshot.aggregates).some((value) => value === null)) {
    limitations.push("One or more maintenance aggregate counts were not observed; null is unknown, not zero.");
  }

  return {
    schemaVersion: 1,
    kind: "nodejs-shortener-maintenance-dry-run-receipt",
    result: "REPORT_ONLY",
    generatedAt: generatedAt.toISOString(),
    source: {
      targetId: snapshot.targetId,
      capturedAt: snapshot.capturedAt.toISOString(),
      snapshotSha256: sha256(JSON.stringify(normalized)),
      linkedScanComplete: snapshot.linkedScanComplete,
      orphanScanComplete: snapshot.orphanScanComplete,
    },
    policy: {
      linkedImages: "newest-reference-at-least-7d-and-latest24h-under-100-and-owned",
      orphanImages: "older-than-24h-and-zero-references-and-owned",
      candidateCap: requestedCap,
    },
    summary: {
      linked: candidateSummary(snapshot.linkedImages.length, linked.map((candidate) => candidate.path)),
      orphan: candidateSummary(snapshot.orphanImages.length, orphan.map((candidate) => candidate.path)),
      aggregates: { ...snapshot.aggregates },
      aggregateCutoffs: normalizeCutoffs(snapshot.aggregateCutoffs),
    },
    mutations: {
      attempted: "0",
      databaseRows: "0",
      files: "0",
      redisKeys: "0",
    },
    limitations,
  };
}

function assertUniqueSnapshotPaths(snapshot: MaintenanceInventorySnapshot): void {
  const linked = new Set<string>();
  for (const candidate of snapshot.linkedImages) {
    if (linked.has(candidate.path)) throw new Error(`Duplicate linked-image path: ${candidate.path}`);
    linked.add(candidate.path);
  }
  const orphan = new Set<string>();
  for (const candidate of snapshot.orphanImages) {
    if (orphan.has(candidate.path)) throw new Error(`Duplicate orphan-image path: ${candidate.path}`);
    if (linked.has(candidate.path)) throw new Error(`Image path appears in both linked and orphan scans: ${candidate.path}`);
    orphan.add(candidate.path);
  }
}

function normalizeSnapshot(snapshot: MaintenanceInventorySnapshot): object {
  return {
    schemaVersion: snapshot.schemaVersion,
    targetId: snapshot.targetId,
    capturedAt: snapshot.capturedAt.toISOString(),
    linkedScanComplete: snapshot.linkedScanComplete,
    orphanScanComplete: snapshot.orphanScanComplete,
    linkedImages: [...snapshot.linkedImages]
      .map((candidate) => ({
        path: candidate.path,
        newestReferenceAt: candidate.newestReferenceAt.toISOString(),
        latest24HourActivity: candidate.latest24HourActivity,
        referenceCount: candidate.referenceCount,
        ownershipRegistered: candidate.ownershipRegistered,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    orphanImages: [...snapshot.orphanImages]
      .map((candidate) => ({
        path: candidate.path,
        createdAt: candidate.createdAt.toISOString(),
        referenceCount: candidate.referenceCount,
        ownershipRegistered: candidate.ownershipRegistered,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    aggregates: { ...snapshot.aggregates },
    aggregateCutoffs: normalizeCutoffs(snapshot.aggregateCutoffs),
  };
}

function normalizeCutoffs(
  cutoffs: MaintenanceAggregateCutoffs,
): Readonly<Record<keyof MaintenanceAggregateCutoffs, string | null>> {
  return {
    legacyClicksBefore: cutoffs.legacyClicksBefore.toISOString(),
    diversionHistoryBefore: cutoffs.diversionHistoryBefore.toISOString(),
    rememberTokensBefore: cutoffs.rememberTokensBefore.toISOString(),
    authThrottleBefore: cutoffs.authThrottleBefore.toISOString(),
    uploadExpiryBefore: cutoffs.uploadExpiryBefore.toISOString(),
    terminalImageJobsBefore: cutoffs.terminalImageJobsBefore?.toISOString() ?? null,
    ipGeoCacheBefore: cutoffs.ipGeoCacheBefore?.toISOString() ?? null,
    deliveredCountryStateBefore: cutoffs.deliveredCountryStateBefore?.toISOString() ?? null,
  };
}

function candidateSummary(scanned: number, paths: readonly string[]): CandidateSummary {
  return {
    scanned,
    eligibleWithinCap: paths.length,
    candidatePathSetSha256: sha256([...paths].sort((left, right) => left.localeCompare(right)).join("\n")),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertValidDate(value: Date, name: string): void {
  if (!Number.isFinite(value.getTime())) throw new Error(`Invalid ${name}.`);
}
