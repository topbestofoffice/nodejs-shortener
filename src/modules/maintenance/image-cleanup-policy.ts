import { isManagedImagePath } from "../uploads/managed-image-path.js";

const dayMs = 86_400_000;
const maximumBatch = 2_000;

export interface LinkedImageCandidate {
  readonly path: string;
  readonly newestReferenceAt: Date;
  readonly latest24HourActivity: number;
  readonly referenceCount: number;
  readonly ownershipRegistered: boolean;
}

export interface OrphanImageCandidate {
  readonly path: string;
  readonly createdAt: Date;
  readonly referenceCount: number;
  readonly ownershipRegistered: boolean;
}

export interface CleanupIdentity {
  readonly path: string;
  readonly ownershipId: string;
  readonly observedReferenceCount: number;
  readonly observedAt: Date;
}

export function selectLinkedImages(
  candidates: readonly LinkedImageCandidate[],
  now: Date,
  requestedCap = maximumBatch,
): readonly LinkedImageCandidate[] {
  const cutoff = now.getTime() - 7 * dayMs;
  const cap = boundedCap(requestedCap);
  return candidates
    .filter((candidate) => isManagedImagePath(candidate.path)
      && candidate.ownershipRegistered
      && Number.isSafeInteger(candidate.referenceCount)
      && candidate.referenceCount > 0
      && Number.isSafeInteger(candidate.latest24HourActivity)
      && candidate.latest24HourActivity >= 0
      && candidate.latest24HourActivity < 100
      && validDate(candidate.newestReferenceAt)
      && candidate.newestReferenceAt.getTime() <= cutoff)
    .sort((left, right) => left.newestReferenceAt.getTime() - right.newestReferenceAt.getTime()
      || left.path.localeCompare(right.path))
    .slice(0, cap);
}

export function selectOrphanImages(
  candidates: readonly OrphanImageCandidate[],
  now: Date,
  requestedCap = maximumBatch,
): readonly OrphanImageCandidate[] {
  const cutoff = now.getTime() - dayMs;
  const cap = boundedCap(requestedCap);
  return candidates
    .filter((candidate) => isManagedImagePath(candidate.path)
      && candidate.ownershipRegistered
      && candidate.referenceCount === 0
      && validDate(candidate.createdAt)
      && candidate.createdAt.getTime() < cutoff)
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime()
      || left.path.localeCompare(right.path))
    .slice(0, cap);
}

export function exactCleanupIdentityStillMatches(before: CleanupIdentity, after: CleanupIdentity): boolean {
  return isManagedImagePath(before.path)
    && before.path === after.path
    && before.ownershipId !== ""
    && before.ownershipId === after.ownershipId
    && before.observedReferenceCount === after.observedReferenceCount
    && after.observedReferenceCount === 0
    && validDate(before.observedAt)
    && validDate(after.observedAt)
    && after.observedAt.getTime() >= before.observedAt.getTime();
}

function boundedCap(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return 0;
  return Math.min(value, maximumBatch);
}

function validDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}
