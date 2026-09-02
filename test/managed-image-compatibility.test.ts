import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { CreateLinkInput, DomainPolicy, RegisterUploadInput } from "../src/core/types.js";
import { SharpMetadataReader } from "../src/infrastructure/sharp-metadata-reader.js";
import { selectOrphanImages } from "../src/modules/maintenance/image-cleanup-policy.js";
import {
  isManagedImagePath,
  isManagedImageRequestPath,
  managedImageFilename,
} from "../src/modules/uploads/managed-image-path.js";
import { preDomainPathDecision } from "../src/security/request-trust.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";

const extensions = ["jpg", "png", "gif", "webp"] as const;
const stem = "0123456789abcdef";
const now = new Date("2026-09-01T12:00:00.000Z");
const expiresAt = new Date("2026-09-03T12:00:00.000Z");
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

describe("portable managed-image compatibility", () => {
  it.each(extensions)("accepts the exact PHP-compatible lowercase .%s identity", (extension) => {
    const path = `uploads/${stem}.${extension}`;

    expect(isManagedImagePath(path)).toBe(true);
    expect(isManagedImageRequestPath(`/${path}`)).toBe(true);
    expect(managedImageFilename(path)).toBe(`${stem}.${extension}`);
    expect(preDomainPathDecision("dashboard", "GET", `/${path}`, false)).toBe("config_only");
    expect(preDomainPathDecision("redirect", "HEAD", `/${path}`, false)).toBe("config_only");
    expect(preDomainPathDecision("dashboard", "POST", `/${path}`, false)).toBe("reject");
  });

  it.each([
    `../uploads/${stem}.jpg`,
    `uploads/../${stem}.jpg`,
    `uploads/nested/${stem}.jpg`,
    `uploads/${stem.toUpperCase()}.jpg`,
    `uploads/${stem}.JPG`,
    `uploads/${stem}.jpeg`,
    `uploads/${stem}.svg`,
    `uploads/${stem}.jpg/extra`,
    `uploads/${stem}.jpg?download=1`,
    `/uploads/${stem}.jpg`,
    `uploads/${stem.slice(1)}.jpg`,
    `uploads/${stem}0.jpg`,
  ])("rejects traversal and lookalike identity %s", (path) => {
    expect(isManagedImagePath(path)).toBe(false);
    expect(managedImageFilename(path)).toBeNull();
  });

  it("keeps ownership attachment atomic for every legacy extension", async () => {
    const store = new InMemoryApplicationStore([domain]);

    for (const [index, extension] of extensions.entries()) {
      const path = `uploads/${index.toString(16).padStart(16, "0")}.${extension}`;
      const upload: RegisterUploadInput = {
        path,
        userId: 42,
        sessionScopeHash: "scope-a",
        createdAt: now,
        expiresAt,
      };
      await store.registerReady(upload, { readyPerSession: 10, readyTotal: 10 });
      const input: CreateLinkInput = {
        domainId: domain.id,
        userId: 42,
        destination: "https://destination.example/path",
        title: null,
        description: null,
        image: path,
        imageSessionScopeHash: "scope-a",
        imageOwnershipExpiresAt: expiresAt,
        code: `Legacy${index}`,
        createdAt: now,
      };

      await expect(store.createLink(input)).resolves.toMatchObject({ image: path });
      await expect(store.verifyOwnedPaths(42, "scope-a", [path], now)).resolves.toEqual([path]);
    }

    await expect(store.countReadyForScope(42, "scope-a")).resolves.toBe(0);
  });

  it("keeps all strict legacy extensions eligible for the same guarded cleanup policy", () => {
    const candidates = extensions.map((extension, index) => ({
      path: `uploads/${index.toString(16).padStart(16, "0")}.${extension}`,
      createdAt: new Date(now.getTime() - 86_400_001),
      referenceCount: 0,
      ownershipRegistered: true,
    }));

    expect(selectOrphanImages(candidates, now)).toEqual(candidates);
    expect(selectOrphanImages([
      { ...candidates[0]!, path: `uploads/${stem}.jpeg` },
      { ...candidates[0]!, path: `uploads/../${stem}.jpg` },
    ], now)).toEqual([]);
  });

  it("reads dimensions and truthful MIME metadata for every strict legacy extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-image-compat-"));
    try {
      sharp.cache({ files: 0 });
      const reader = new SharpMetadataReader(root, 1_000_000);
      const expectedMime = {
        jpg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        webp: "image/webp",
      } as const;

      for (const extension of extensions) {
        const path = `uploads/${stem}.${extension}`;
        await sharp({
          create: { width: 3, height: 2, channels: 3, background: "#123456" },
        }).toFormat(extension === "jpg" ? "jpeg" : extension).toFile(join(root, `${stem}.${extension}`));

        await expect(reader.read(path)).resolves.toEqual({
          width: 3,
          height: 2,
          mime: expectedMime[extension],
        });
      }

      await expect(reader.read(`uploads/../${stem}.jpg`)).resolves.toBeNull();
      await expect(reader.read(`uploads/${stem}.JPG`)).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
