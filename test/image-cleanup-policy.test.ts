import { describe, expect, it } from "vitest";
import {
  exactCleanupIdentityStillMatches,
  selectLinkedImages,
  selectOrphanImages,
} from "../src/modules/maintenance/image-cleanup-policy.js";

const now = new Date("2026-09-01T13:17:00Z");

describe("shared image cleanup policy", () => {
  it("selects only old, low-activity, registered shared references", () => {
    const eligible = candidate("uploads/0000000000000001.jpg", 8, 99, 3, true);
    expect(selectLinkedImages([
      eligible,
      candidate("uploads/0000000000000002.jpg", 6, 0, 1, true),
      candidate("uploads/0000000000000003.jpg", 8, 100, 1, true),
      candidate("uploads/0000000000000004.jpg", 8, 0, 0, true),
      candidate("uploads/0000000000000005.jpg", 8, 0, 1, false),
      candidate("legacy/nested.jpg", 8, 0, 1, true),
    ], now)).toEqual([eligible]);
  });

  it("enforces the owner cap and deterministic oldest-first ordering", () => {
    const candidates = Array.from({ length: 2_005 }, (_, index) =>
      candidate(`uploads/${index.toString(16).padStart(16, "0")}.jpg`, 8 + index, 0, 1, true));
    const selected = selectLinkedImages(candidates, now, 9_999);
    expect(selected).toHaveLength(2_000);
    expect(selected[0]?.path).toBe("uploads/00000000000007d4.jpg");
  });

  it("selects only flat registered orphans strictly older than 24 hours", () => {
    const eligible = {
      path: "uploads/0123456789abcdef.jpg",
      createdAt: new Date(now.getTime() - 86_400_001),
      referenceCount: 0,
      ownershipRegistered: true,
    };
    expect(selectOrphanImages([
      eligible,
      { ...eligible, path: "uploads/fedcba9876543210.jpg", createdAt: new Date(now.getTime() - 86_400_000) },
      { ...eligible, path: "uploads/1111111111111111.jpg", referenceCount: 1 },
      { ...eligible, path: "uploads/2222222222222222.jpg", ownershipRegistered: false },
      { ...eligible, path: "uploads/nested/3333333333333333.jpg" },
    ], now)).toEqual([eligible]);
  });

  it("requires exact ownership and zero-reference identity at final recheck", () => {
    const before = {
      path: "uploads/0123456789abcdef.jpg",
      ownershipId: "owner-row-1",
      observedReferenceCount: 0,
      observedAt: new Date(now.getTime() - 1_000),
    };
    expect(exactCleanupIdentityStillMatches(before, { ...before, observedAt: now })).toBe(true);
    expect(exactCleanupIdentityStillMatches(before, { ...before, ownershipId: "owner-row-2", observedAt: now })).toBe(false);
    expect(exactCleanupIdentityStillMatches(before, { ...before, observedReferenceCount: 1, observedAt: now })).toBe(false);
  });
});

function candidate(path: string, ageDays: number, activity: number, references: number, registered: boolean) {
  return {
    path,
    newestReferenceAt: new Date(now.getTime() - ageDays * 86_400_000),
    latest24HourActivity: activity,
    referenceCount: references,
    ownershipRegistered: registered,
  };
}
