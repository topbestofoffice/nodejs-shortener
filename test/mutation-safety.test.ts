import { describe, expect, it } from "vitest";
import type { CreateLinkInput, DomainPolicy, RegisterUploadInput } from "../src/core/types.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";

const now = new Date("2026-09-01T12:00:00.000Z");
const later = new Date("2026-09-02T12:00:00.000Z");
const domain: DomainPolicy = {
  id: 2,
  domainKey: "default",
  hostname: "go.example.test",
  label: "Go",
  surface: "redirect",
  active: true,
  allowCreate: true,
  diversionCampaign: "default",
  reportTimezone: "UTC",
};

describe("mutation safety", () => {
  it("commits a link and its managed image attachment as one store mutation", async () => {
    const store = new InMemoryApplicationStore([domain]);
    const upload = readyUpload("uploads/0000000000000001.jpg", 42, "scope-a");
    await store.registerReady(upload, { readyPerSession: 1, readyTotal: 1 });

    const first = await store.createLink(linkInput("First001", upload.path, 42));
    expect(first).toMatchObject({ code: "First001", image: upload.path, userId: 42 });
    expect(store.recentActivityEpochsForTest(domain.id, first.code)).toEqual([]);
    await expect(store.countReadyForScope(42, "scope-a")).resolves.toBe(0);
    await expect(store.verifyOwnedPaths(42, "scope-a", [upload.path], now)).resolves.toEqual([upload.path]);

    await expect(store.createLink(linkInput("Second01", upload.path, 42)))
      .resolves.toMatchObject({ code: "Second01", image: upload.path });
  });

  it("refreshes an already-attached image TTL on every confirmed reuse", async () => {
    const store = new InMemoryApplicationStore([domain]);
    const upload = readyUpload("uploads/0000000000000010.jpg", 42, "scope-a");
    await store.registerReady(upload, { readyPerSession: 1, readyTotal: 1 });
    const nearExpiry = new Date("2026-09-02T11:59:00.000Z");
    const refreshedExpiry = new Date("2026-09-03T11:59:00.000Z");

    await store.createLink(linkInput("Refresh1", upload.path, 42, nearExpiry, refreshedExpiry));
    await store.createLink(linkInput("Refresh2", upload.path, 42, nearExpiry, refreshedExpiry));

    await expect(store.verifyOwnedPaths(
      42,
      "scope-a",
      [upload.path],
      new Date("2026-09-02T12:01:00.000Z"),
    )).resolves.toEqual([upload.path]);
  });

  it("does not create a link when the managed image is missing or belongs to another user", async () => {
    const store = new InMemoryApplicationStore([domain]);
    const foreign = readyUpload("uploads/0000000000000002.jpg", 99, "scope-b");
    await store.registerReady(foreign, { readyPerSession: 5, readyTotal: 5 });

    await expect(store.createLink(linkInput("Missing1", "uploads/0000000000000003.jpg", 42)))
      .rejects.toMatchObject({ statusCode: 422, code: "UPLOAD_UNAVAILABLE" });
    await expect(store.createLink(linkInput("Foreign1", foreign.path, 42)))
      .rejects.toMatchObject({ statusCode: 422, code: "UPLOAD_UNAVAILABLE" });
    await expect(store.findLink(2, "Missing1", domain.hostname, domain.surface)).resolves.toBeNull();
    await expect(store.findLink(2, "Foreign1", domain.hostname, domain.surface)).resolves.toBeNull();
    await expect(store.countReadyForScope(99, "scope-b")).resolves.toBe(1);
  });

  it("reserves per-session upload capacity atomically under concurrent calls", async () => {
    const store = new InMemoryApplicationStore([domain]);
    const capacity = { readyPerSession: 1, readyTotal: 10 };
    const results = await Promise.allSettled([
      store.registerReady(readyUpload("uploads/0000000000000004.jpg", 42, "scope-c"), capacity),
      store.registerReady(readyUpload("uploads/0000000000000005.jpg", 42, "scope-c"), capacity),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "SESSION_UPLOAD_LIMIT" } });
    await expect(store.countReadyForScope(42, "scope-c")).resolves.toBe(1);
  });

  it("reserves global upload capacity atomically across different sessions", async () => {
    const store = new InMemoryApplicationStore([domain]);
    const capacity = { readyPerSession: 10, readyTotal: 1 };
    const results = await Promise.allSettled([
      store.registerReady(readyUpload("uploads/0000000000000006.jpg", 42, "scope-d"), capacity),
      store.registerReady(readyUpload("uploads/0000000000000007.jpg", 43, "scope-e"), capacity),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "GLOBAL_UPLOAD_LIMIT" } });
    await expect(store.countReadyTotal()).resolves.toBe(1);
  });

  it("keeps attachment state unchanged when any requested path fails validation", async () => {
    const store = new InMemoryApplicationStore([domain]);
    const upload = readyUpload("uploads/0000000000000008.jpg", 42, "scope-f");
    await store.registerReady(upload, { readyPerSession: 5, readyTotal: 5 });

    await expect(store.markAttached(
      42,
      "scope-f",
      [upload.path, "uploads/0000000000000009.jpg"],
      now,
      later,
    )).rejects.toMatchObject({ statusCode: 422, code: "UPLOAD_UNAVAILABLE" });
    await expect(store.countReadyForScope(42, "scope-f")).resolves.toBe(1);
  });
});

function readyUpload(path: string, userId: number, sessionScopeHash: string): RegisterUploadInput {
  return { path, userId, sessionScopeHash, createdAt: now, expiresAt: later };
}

function linkInput(
  code: string,
  image: string | null,
  userId: number,
  createdAt = now,
  imageOwnershipExpiresAt = image === null ? null : later,
): CreateLinkInput {
  return {
    domainId: domain.id,
    userId,
    destination: "https://destination.example/path",
    title: null,
    description: null,
    image,
    imageSessionScopeHash: image === null ? null : "scope-a",
    imageOwnershipExpiresAt,
    code,
    createdAt,
  };
}
