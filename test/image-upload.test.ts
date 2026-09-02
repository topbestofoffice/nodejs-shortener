import { Readable } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { ImageUploadService } from "../src/modules/uploads/service.js";
import { SharpConcurrencyOneExecutor } from "../src/modules/uploads/image-executor.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { domainPolicies } from "./fixtures.js";
import type { SessionData } from "../src/core/types.js";

const roots: string[] = [];
const fixedClock = { now: () => new Date("2026-08-23T12:00:00Z") };
const session: SessionData = {
  id: "a".repeat(64),
  userId: 7,
  csrfToken: "b".repeat(64),
  uploadScope: "c".repeat(64),
  authEpoch: 0,
  createdAt: "2026-08-23T12:00:00.000Z",
  expiresAt: "2026-09-22T12:00:00.000Z",
  rememberSelector: null,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ImageUploadService", () => {
  it("streams, normalizes and atomically publishes a 1200x630 JPEG", async () => {
    const { service, publicDir } = await fixture();
    const input = await sharp({
      create: { width: 400, height: 800, channels: 4, background: { r: 20, g: 80, b: 140, alpha: 1 } },
    }).png().toBuffer();
    const staged = await service.stage(Readable.from(input));

    const result = await service.complete(staged, 7, session);
    const output = await sharp(await readFile(join(publicDir, result.path.replace("uploads/", "")))).metadata();

    expect(result.path).toMatch(/^uploads\/[a-f0-9]{16}\.jpg$/);
    expect(output).toMatchObject({ format: "jpeg", width: 1200, height: 630 });
    await expect(service.verifyOwnedPaths(7, session, [result.path])).resolves.toEqual([result.path]);
  });

  it("rejects a compressed image whose decoded pixels exceed the limit", async () => {
    const { service } = await fixture({ maxImagePixels: 1000 });
    const input = await sharp({
      create: { width: 40, height: 40, channels: 3, background: "white" },
    }).png().toBuffer();
    const staged = await service.stage(Readable.from(input));

    await expect(service.complete(staged, 7, session)).rejects.toThrow();
  });

  it("rejects oversized input while streaming", async () => {
    const { service } = await fixture({ maxUploadBytes: 10 });
    await expect(service.stage(Readable.from(Buffer.alloc(11)))).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
  });

  it("fails image ownership generically across sessions", async () => {
    const { service } = await fixture();
    const input = await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } }).jpeg().toBuffer();
    const result = await service.complete(await service.stage(Readable.from(input)), 7, session);
    const otherSession = { ...session, uploadScope: "d".repeat(64) };

    await expect(service.verifyOwnedPaths(7, otherSession, [result.path]))
      .rejects.toMatchObject({ statusCode: 422, code: "UPLOAD_UNAVAILABLE" });
  });
});

async function fixture(overrides: { maxUploadBytes?: number; maxImagePixels?: number } = {}): Promise<{
  service: ImageUploadService;
  publicDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "node-shortener-image-"));
  roots.push(root);
  const publicDir = join(root, "public", "uploads");
  const store = new InMemoryApplicationStore(domainPolicies);
  return {
    publicDir,
    service: new ImageUploadService({
      uploads: store,
      executor: new SharpConcurrencyOneExecutor(),
      clock: fixedClock,
      privateTempDir: join(root, "private", "tmp"),
      publicUploadDir: publicDir,
      ...overrides,
    }),
  };
}
