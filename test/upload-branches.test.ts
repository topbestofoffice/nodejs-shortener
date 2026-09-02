import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AppError, ValidationError } from "../src/core/errors.js";
import type { DomainContext, RegisterUploadInput, SessionData, UserRecord } from "../src/core/types.js";
import { registerImageUploadRoutes } from "../src/modules/uploads/http.js";
import {
  SharpConcurrencyOneExecutor,
  type ImageExecutionRequest,
  type ImageExecutionResult,
  type ImageExecutor,
} from "../src/modules/uploads/image-executor.js";
import { ImageUploadService, type StagedUpload } from "../src/modules/uploads/service.js";
import type { UploadStore } from "../src/ports.js";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
const now = new Date("2026-08-23T12:00:00.000Z");
const clock = { now: () => new Date(now) };
const session: SessionData = {
  id: "a".repeat(64),
  userId: 7,
  csrfToken: "b".repeat(64),
  uploadScope: "scope-known-only-to-this-session",
  authEpoch: 0,
  createdAt: now.toISOString(),
  expiresAt: "2026-09-22T12:00:00.000Z",
  rememberSelector: null,
};
const user: UserRecord = {
  id: 7,
  username: "uploader",
  passwordHash: "not-used-by-upload-tests",
  role: "user",
  defaultDomainId: 1,
  createdAt: now,
};
const dashboardContext: DomainContext = {
  definition: {
    id: 1,
    key: "url6x",
    diversionCampaign: "url6x",
    reportTimezone: "UTC",
    canonicalHost: "url6x.local",
    aliases: [],
    label: "URL6X",
    surface: "dashboard",
    active: true,
    allowCreate: false,
    publicBaseUrl: "https://url6x.local",
    imageBaseUrl: "https://url6x.local",
    emitLocalImageAlt: false,
    compactNoImagePreview: false,
    creationFallback: false,
    acceptUnprovenDeliveredClaim: false,
  },
  requestHost: "url6x.local",
  isCanonical: true,
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("upload HTTP boundary branches", () => {
  it.each(["GET", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
    "rejects %s with a JSON 405 instead of invoking the image service",
    async (method) => {
      const fake = createHttpService();
      const app = await buildUploadApp(fake.service);

      const response = await app.inject({ method, url: "/upload.php" });

      expect(response.statusCode).toBe(405);
      expect(response.headers["content-type"]).toMatch(/^application\/json\b/);
      expect(response.json()).toEqual({ ok: false, error: "POST required" });
      expect(fake.calls.stage).toBe(0);
      expect(fake.calls.complete).toBe(0);
      expect(fake.calls.discard).toEqual([]);
    },
  );

  it("rejects HEAD with the same JSON 405 response", async () => {
    const fake = createHttpService();
    const app = await buildUploadApp(fake.service);

    const response = await app.inject({ method: "HEAD", url: "/upload.php" });

    expect(response.statusCode).toBe(405);
    expect(response.headers["content-type"]).toMatch(/^application\/json\b/);
    expect(response.json()).toEqual({ ok: false, error: "POST required" });
    expect(fake.calls.stage).toBe(0);
  });

  it("turns a non-multipart POST into a stable JSON error", async () => {
    const fake = createHttpService();
    const app = await buildUploadApp(fake.service);

    const response = await app.inject({
      method: "POST",
      url: "/upload.php",
      headers: { "content-type": "application/json" },
      payload: { csrf: session.csrfToken },
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toMatch(/^application\/json\b/);
    expect(response.json()).toEqual({ ok: false, error: "Upload failed" });
    expect(fake.calls.stage).toBe(0);
    expect(fake.calls.discard).toEqual([null]);
  });

  it("rejects a multipart request with no image after checking CSRF", async () => {
    const fake = createHttpService();
    const app = await buildUploadApp(fake.service);
    const request = multipart([{ kind: "field", name: "csrf", value: session.csrfToken }]);

    const response = await app.inject({ method: "POST", url: "/upload.php", ...request });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "No image received" });
    expect(fake.calls.stage).toBe(0);
    expect(fake.calls.discard).toEqual([null]);
  });

  it("drains and rejects a file submitted under an unexpected field name", async () => {
    const fake = createHttpService();
    const app = await buildUploadApp(fake.service);
    const request = multipart([
      { kind: "field", name: "csrf", value: session.csrfToken },
      { kind: "file", name: "avatar", filename: "avatar.jpg", contentType: "image/jpeg", data: Buffer.from("data") },
    ]);

    const response = await app.inject({ method: "POST", url: "/upload.php", ...request });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "Upload one image." });
    expect(fake.calls.stage).toBe(0);
    expect(fake.calls.discard).toEqual([null]);
  });

  it("rejects multiple file parts before passing a partial stage to completion", async () => {
    const fake = createHttpService();
    const app = await buildUploadApp(fake.service);
    const request = multipart([
      { kind: "field", name: "csrf", value: session.csrfToken },
      { kind: "file", name: "image", filename: "one.jpg", contentType: "image/jpeg", data: Buffer.from("one") },
      { kind: "file", name: "image", filename: "two.jpg", contentType: "image/jpeg", data: Buffer.from("two") },
    ]);

    const response = await app.inject({ method: "POST", url: "/upload.php", ...request });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "Upload failed" });
    expect(fake.calls.stage).toBe(1);
    expect(fake.calls.complete).toBe(0);
    expect(fake.calls.discard).toEqual([null]);
  });

  it("rejects a parser-truncated file and discards what was staged", async () => {
    const fake = createHttpService();
    const app = await buildUploadApp(fake.service, 4);
    const request = multipart([
      { kind: "field", name: "csrf", value: session.csrfToken },
      { kind: "file", name: "image", filename: "large.jpg", contentType: "image/jpeg", data: Buffer.from("12345") },
    ]);

    const response = await app.inject({ method: "POST", url: "/upload.php", ...request });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ ok: false, error: "Image file is too large." });
    expect(fake.calls.stage).toBe(1);
    expect(fake.calls.complete).toBe(0);
    expect(fake.calls.discard).toEqual([{ inputPath: "fake-1.part", bytes: 4 }]);
  });

  it("maps a non-AppError 413 from staging and hides other unexpected failures", async () => {
    const tooLarge = createHttpService({ stageError: Object.assign(new Error("parser detail"), { statusCode: 413 }) });
    const tooLargeApp = await buildUploadApp(tooLarge.service);
    const request = multipart([
      { kind: "field", name: "csrf", value: session.csrfToken },
      { kind: "file", name: "image", filename: "image.jpg", contentType: "image/jpeg", data: Buffer.from("x") },
    ]);

    const largeResponse = await tooLargeApp.inject({ method: "POST", url: "/upload.php", ...request });
    expect(largeResponse.statusCode).toBe(413);
    expect(largeResponse.json()).toEqual({ ok: false, error: "Image file is too large." });
    expect(tooLarge.calls.discard).toEqual([null]);

    const failed = createHttpService({ completeError: new Error("do not expose this") });
    const failedApp = await buildUploadApp(failed.service);
    const failedResponse = await failedApp.inject({ method: "POST", url: "/upload.php", ...request });
    expect(failedResponse.statusCode).toBe(400);
    expect(failedResponse.json()).toEqual({ ok: false, error: "Upload failed" });
    expect(failed.calls.discard).toEqual([{ inputPath: "fake-1.part", bytes: 1 }]);
  });

  it("honors an AppError status while hiding a non-exposed message", async () => {
    const fake = createHttpService({
      completeError: new AppError("internal worker detail", 503, "IMAGE_WORKER_FAILED", false),
    });
    const app = await buildUploadApp(fake.service);
    const request = multipart([
      { kind: "field", name: "csrf", value: session.csrfToken },
      { kind: "file", name: "image", filename: "image.jpg", contentType: "image/jpeg", data: Buffer.from("x") },
    ]);

    const response = await app.inject({ method: "POST", url: "/upload.php", ...request });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ ok: false, error: "Upload failed" });
    expect(fake.calls.discard).toEqual([{ inputPath: "fake-1.part", bytes: 1 }]);
  });

  it("returns a successful PHP-compatible result and transfers cleanup ownership", async () => {
    const fake = createHttpService();
    const app = await buildUploadApp(fake.service);
    const request = multipart([
      { kind: "field", name: "csrf", value: session.csrfToken },
      { kind: "file", name: "image", filename: "image.jpg", contentType: "image/jpeg", data: Buffer.from("image") },
    ]);

    const response = await app.inject({ method: "POST", url: "/upload.php", ...request });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, path: "uploads/0123456789abcdef.jpg" });
    expect(fake.calls.complete).toBe(1);
    expect(fake.calls.completeArguments).toEqual({ staged: { inputPath: "fake-1.part", bytes: 5 }, userId: 7, session });
    expect(fake.calls.discard).toEqual([null]);
  });

  it("rejects a file before a valid CSRF field without staging it", async () => {
    const fake = createHttpService();
    const app = await buildUploadApp(fake.service);
    const request = multipart([
      { kind: "file", name: "image", filename: "image.jpg", contentType: "image/jpeg", data: Buffer.alloc(128, 1) },
      { kind: "field", name: "csrf", value: session.csrfToken },
    ]);

    const response = await app.inject({ method: "POST", url: "/upload.php", ...request });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ ok: false, error: "Invalid CSRF token" });
    expect(fake.calls.stage).toBe(0);
    expect(fake.calls.discard).toEqual([null]);
  });
});

describe("ImageUploadService staging and cleanup branches", () => {
  it("rejects an empty stream and removes its private temporary file", async () => {
    const fixture = await serviceFixture();

    await expect(fixture.service.stage(Readable.from([]))).rejects.toMatchObject({ code: "EMPTY_IMAGE" });
    await expect(filesInside(fixture.privateDir)).resolves.toEqual([]);
  });

  it("enforces the byte limit while streaming and removes partial input", async () => {
    const fixture = await serviceFixture({ maxUploadBytes: 4 });

    await expect(fixture.service.stage(Readable.from([Buffer.from("123"), Buffer.from("45")])))
      .rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
    await expect(filesInside(fixture.privateDir)).resolves.toEqual([]);
  });

  it("propagates an upstream stream error without retaining partial input", async () => {
    const fixture = await serviceFixture();
    const upstreamError = new Error("source disconnected");
    const stream = Readable.from((async function* () {
      yield Buffer.from("partial");
      throw upstreamError;
    })());

    await expect(fixture.service.stage(stream)).rejects.toBe(upstreamError);
    await expect(filesInside(fixture.privateDir)).resolves.toEqual([]);
  });

  it("stages exact bytes under the private directory and discard is idempotent", async () => {
    const fixture = await serviceFixture();
    const staged = await fixture.service.stage(Readable.from(Buffer.from("private bytes")));

    expect(staged.bytes).toBe(13);
    expect(dirname(resolve(staged.inputPath))).toBe(resolve(fixture.privateDir));
    await expect(readFile(staged.inputPath, "utf8")).resolves.toBe("private bytes");

    await fixture.service.discard(staged);
    await expect(fixture.service.discard(staged)).resolves.toBeUndefined();
    await expect(fixture.service.discard(null)).resolves.toBeUndefined();
    await expect(filesInside(fixture.privateDir)).resolves.toEqual([]);
  });

  it("does not swallow cleanup errors for a non-file path", async () => {
    const fixture = await serviceFixture();
    const directory = join(fixture.privateDir, "not-a-file.part");
    await mkdir(directory, { recursive: true });

    await expect(fixture.service.discard({ inputPath: directory, bytes: 1 })).rejects.toBeInstanceOf(Error);
  });

  it("rejects undecodable bytes and removes both input and processor leftovers", async () => {
    const fixture = await serviceFixture({ executor: new SharpConcurrencyOneExecutor() });
    const staged = await fixture.service.stage(Readable.from(Buffer.from("not-an-image")));

    await expect(fixture.service.complete(staged, user.id, session)).rejects.toBeInstanceOf(Error);
    await expect(filesInside(fixture.privateDir)).resolves.toEqual([]);
    await expect(filesInside(fixture.publicDir)).resolves.toEqual([]);
  });
});

describe("ImageUploadService capacity, publication and registration branches", () => {
  it("blocks a full session before executor work starts", async () => {
    const fixture = await serviceFixture({ readyPerSession: 1, scopeCounts: [1] });
    const staged = await fixture.service.stage(Readable.from(Buffer.from("input")));

    await expect(fixture.service.complete(staged, user.id, session))
      .rejects.toMatchObject({ statusCode: 422, code: "SESSION_UPLOAD_LIMIT" });
    expect(fixture.executor.calls).toHaveLength(0);
    expect(fixture.store.totalCountCalls).toBe(0);
    await fixture.service.discard(staged);
  });

  it("blocks a globally full upload tray before executor work starts", async () => {
    const fixture = await serviceFixture({ readyTotal: 1, scopeCounts: [0], totalCounts: [1] });
    const staged = await fixture.service.stage(Readable.from(Buffer.from("input")));

    await expect(fixture.service.complete(staged, user.id, session))
      .rejects.toMatchObject({ statusCode: 422, code: "GLOBAL_UPLOAD_LIMIT" });
    expect(fixture.executor.calls).toHaveLength(0);
    await fixture.service.discard(staged);
  });

  it.each([
    { name: "session", scopeCounts: [0, 1], totalCounts: [0], code: "SESSION_UPLOAD_LIMIT" },
    { name: "global", scopeCounts: [0, 0], totalCounts: [0, 1], code: "GLOBAL_UPLOAD_LIMIT" },
  ])("removes a published file when the $name capacity recheck fails", async ({ scopeCounts, totalCounts, code }) => {
    const fixture = await serviceFixture({
      readyPerSession: 1,
      readyTotal: 1,
      scopeCounts,
      totalCounts,
    });
    const staged = await fixture.service.stage(Readable.from(Buffer.from("input")));

    await expect(fixture.service.complete(staged, user.id, session)).rejects.toMatchObject({ code });
    expect(fixture.executor.calls).toHaveLength(1);
    expect(fixture.store.registered).toEqual([]);
    await expect(filesInside(fixture.privateDir)).resolves.toEqual([]);
    await expect(filesInside(fixture.publicDir)).resolves.toEqual([]);
  });

  it("cleans input and output-temp files when the executor fails mid-operation", async () => {
    const executor = new ControlledExecutor({ failAfterWritingTemp: new ValidationError("bad decoder", "INVALID_IMAGE") });
    const fixture = await serviceFixture({ executor });
    const staged = await fixture.service.stage(Readable.from(Buffer.from("input")));

    await expect(fixture.service.complete(staged, user.id, session))
      .rejects.toMatchObject({ code: "INVALID_IMAGE" });
    await expect(filesInside(fixture.privateDir)).resolves.toEqual([]);
    await expect(filesInside(fixture.publicDir)).resolves.toEqual([]);
  });

  it("removes a published image if ownership registration fails", async () => {
    const fixture = await serviceFixture({ registerError: new Error("database unavailable") });
    const staged = await fixture.service.stage(Readable.from(Buffer.from("input")));

    await expect(fixture.service.complete(staged, user.id, session)).rejects.toThrow("database unavailable");
    expect(fixture.executor.calls).toHaveLength(1);
    await expect(filesInside(fixture.privateDir)).resolves.toEqual([]);
    await expect(filesInside(fixture.publicDir)).resolves.toEqual([]);
  });

  it("registers a successful upload with the session hash and configured ownership TTL", async () => {
    const fixture = await serviceFixture({ ownershipTtlSeconds: 90 });
    const staged = await fixture.service.stage(Readable.from(Buffer.from("input")));

    const result = await fixture.service.complete(staged, user.id, session);

    expect(result.path).toMatch(/^uploads\/[a-f0-9]{16}\.jpg$/);
    expect(result.imageInfo).toEqual({
      width: 1200,
      height: 630,
      format: "jpeg",
      sourceWidth: 10,
      sourceHeight: 20,
      level: "good",
      message: "1200×630 px — suitable for a large social preview.",
      ratio: 1.905,
    });
    expect(fixture.store.registered).toEqual([{
      path: result.path,
      userId: 7,
      sessionScopeHash: scopeHash(session),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 90_000),
    }]);
    await expect(stat(join(fixture.publicDir, result.path.slice("uploads/".length))))
      .resolves.toMatchObject({ size: 9 });
  });
});

describe("ImageUploadService ownership and reference branches", () => {
  it("rejects batches over 50 and malformed or traversal paths before store access", async () => {
    const fixture = await serviceFixture();
    const tooMany = Array.from({ length: 51 }, (_, index) => `uploads/${index.toString(16).padStart(16, "0")}.jpg`);

    await expect(fixture.service.verifyOwnedPaths(user.id, session, tooMany))
      .rejects.toMatchObject({ code: "TOO_MANY_IMAGES" });

    for (const path of [
      "../secret.jpg",
      "uploads/../../secret.jpg",
      "uploads/0123456789ABCDEf.jpg",
      "uploads/0123456789abcdef.jpeg",
      "uploads/0123456789abcdef.jpg/extra",
    ]) {
      await expect(fixture.service.verifyOwnedPaths(user.id, session, [path]))
        .rejects.toMatchObject({ statusCode: 422, code: "UPLOAD_UNAVAILABLE" });
    }
    expect(fixture.store.verifyCalls).toEqual([]);
  });

  it("passes exact owner, session hash and clock to the store", async () => {
    const fixture = await serviceFixture();
    const path = "uploads/0123456789abcdef.jpg";
    await mkdir(fixture.publicDir, { recursive: true });
    await writeFile(join(fixture.publicDir, "0123456789abcdef.jpg"), "jpeg");
    fixture.store.verifyResult = [path];

    await expect(fixture.service.verifyOwnedPaths(user.id, session, [path])).resolves.toEqual([path]);
    expect(fixture.store.verifyCalls).toEqual([{
      userId: 7,
      sessionScopeHash: scopeHash(session),
      paths: [path],
      at: now,
    }]);
  });

  it("normalizes store failures, missing files and directories into one ownership error", async () => {
    const path = "uploads/0123456789abcdef.jpg";

    const failedStore = await serviceFixture({ verifyError: new Error("private database detail") });
    await expect(failedStore.service.verifyOwnedPaths(user.id, session, [path]))
      .rejects.toMatchObject({ statusCode: 422, code: "UPLOAD_UNAVAILABLE" });

    const missing = await serviceFixture({ verifyResult: [path] });
    await expect(missing.service.verifyOwnedPaths(user.id, session, [path]))
      .rejects.toMatchObject({ statusCode: 422, code: "UPLOAD_UNAVAILABLE" });

    const directory = await serviceFixture({ verifyResult: [path] });
    await mkdir(join(directory.publicDir, "0123456789abcdef.jpg"), { recursive: true });
    await expect(directory.service.verifyOwnedPaths(user.id, session, [path]))
      .rejects.toMatchObject({ statusCode: 422, code: "UPLOAD_UNAVAILABLE" });
  });

  it("marks paths attached with the owner scope and refreshed TTL", async () => {
    const fixture = await serviceFixture({ ownershipTtlSeconds: 30 });
    const paths = ["uploads/0123456789abcdef.jpg", "uploads/fedcba9876543210.jpg"];

    await fixture.service.markAttached(user.id, session, paths);

    expect(fixture.store.markCalls).toEqual([{
      userId: 7,
      sessionScopeHash: scopeHash(session),
      paths,
      at: now,
      expiresAt: new Date(now.getTime() + 30_000),
    }]);
  });

  it("rejects empty, overlong, malformed and non-web image references", async () => {
    const fixture = await serviceFixture({ ownedImageHosts: ["images.example"] });

    for (const value of ["", "   ", "x".repeat(513), "not a URL", "javascript:alert(1)", "ftp://other.example/a.jpg"]) {
      await expect(fixture.service.authorizeReference(user.id, session, value))
        .rejects.toMatchObject({ statusCode: 422, code: "INVALID_IMAGE_URL" });
    }
  });

  it("accepts trimmed external HTTP(S) references without treating lookalike hosts as owned", async () => {
    const fixture = await serviceFixture({ ownedImageHosts: [" Images.Example "] });

    await expect(fixture.service.authorizeReference(user.id, session, " https://cdn.example/photo.jpg?q=1#hero "))
      .resolves.toBe("https://cdn.example/photo.jpg?q=1#hero");
    await expect(fixture.service.authorizeReference(user.id, session, "https://images.example.evil/uploads/0123456789abcdef.jpg"))
      .resolves.toBe("https://images.example.evil/uploads/0123456789abcdef.jpg");
    expect(fixture.store.verifyCalls).toEqual([]);
  });

  it("requires ownership for local and exact owned-host references", async () => {
    const fixture = await serviceFixture({
      ownedImageHosts: ["images.example"],
      verifyResult: ["uploads/0123456789abcdef.jpg"],
    });
    await mkdir(fixture.publicDir, { recursive: true });
    await writeFile(join(fixture.publicDir, "0123456789abcdef.jpg"), "jpeg");

    await expect(fixture.service.authorizeReference(user.id, session, " uploads/0123456789abcdef.jpg "))
      .resolves.toBe("uploads/0123456789abcdef.jpg");
    await expect(fixture.service.authorizeReference(
      user.id,
      session,
      "https://IMAGES.EXAMPLE/uploads/0123456789abcdef.jpg",
    )).resolves.toBe("uploads/0123456789abcdef.jpg");
    expect(fixture.store.verifyCalls).toHaveLength(2);
  });

  it("rejects credentials, ports, query, fragment and unsafe paths on an owned host", async () => {
    const fixture = await serviceFixture({ ownedImageHosts: ["images.example"] });

    for (const value of [
      "https://user@images.example/uploads/0123456789abcdef.jpg",
      "https://user:pass@images.example/uploads/0123456789abcdef.jpg",
      "https://images.example:8443/uploads/0123456789abcdef.jpg",
      "https://images.example/uploads/0123456789abcdef.jpg?download=1",
      "https://images.example/uploads/0123456789abcdef.jpg#fragment",
      "https://images.example/uploads/../secret.jpg",
      "https://images.example/uploads/0123456789abcdef.jpeg",
    ]) {
      await expect(fixture.service.authorizeReference(user.id, session, value))
        .rejects.toMatchObject({ statusCode: 422, code: "UPLOAD_UNAVAILABLE" });
    }
    expect(fixture.store.verifyCalls).toEqual([]);
  });
});

interface HttpServiceOptions {
  readonly stageError?: Error;
  readonly completeError?: Error;
}

function createHttpService(options: HttpServiceOptions = {}): {
  readonly service: ImageUploadService;
  readonly calls: {
    stage: number;
    complete: number;
    completeArguments: { staged: StagedUpload; userId: number; session: SessionData } | null;
    discard: Array<StagedUpload | null>;
  };
} {
  const calls = {
    stage: 0,
    complete: 0,
    completeArguments: null as { staged: StagedUpload; userId: number; session: SessionData } | null,
    discard: [] as Array<StagedUpload | null>,
  };
  const fake = {
    stage: async (stream: Readable): Promise<StagedUpload> => {
      calls.stage += 1;
      if (options.stageError !== undefined) {
        for await (const chunk of stream) {
          // Drain the part so multipart cleanup can finish before surfacing the injected error.
          void chunk;
        }
        throw options.stageError;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      return { inputPath: `fake-${calls.stage}.part`, bytes: Buffer.concat(chunks).length };
    },
    complete: async (staged: StagedUpload, userId: number, authenticatedSession: SessionData) => {
      calls.complete += 1;
      calls.completeArguments = { staged, userId, session: authenticatedSession };
      if (options.completeError !== undefined) {
        throw options.completeError;
      }
      return {
        path: "uploads/0123456789abcdef.jpg",
        imageInfo: {
          width: 1200 as const,
          height: 630 as const,
          format: "jpeg" as const,
          sourceWidth: 10,
          sourceHeight: 10,
          level: "good" as const,
          message: "ready",
          ratio: 1.905,
        },
      };
    },
    discard: async (staged: StagedUpload | null) => {
      calls.discard.push(staged);
    },
  };
  return { service: fake as unknown as ImageUploadService, calls };
}

async function buildUploadApp(service: ImageUploadService, maxUploadBytes = 2 * 1024 * 1024): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  app.decorateRequest("auth");
  app.decorateRequest("domainContext");
  app.addHook("onRequest", async (request) => {
    request.auth = { session, user };
    request.domainContext = dashboardContext;
  });
  await registerImageUploadRoutes(app, service, maxUploadBytes);
  return app;
}

type MultipartPart =
  | { readonly kind: "field"; readonly name: string; readonly value: string }
  | {
      readonly kind: "file";
      readonly name: string;
      readonly filename: string;
      readonly contentType: string;
      readonly data: Buffer;
    };

function multipart(parts: readonly MultipartPart[]): {
  readonly headers: { readonly "content-type": string };
  readonly payload: Buffer;
} {
  const boundary = "----node-shortener-upload-branches";
  const buffers: Buffer[] = [];
  for (const part of parts) {
    buffers.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    if (part.kind === "field") {
      buffers.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
        "utf8",
      ));
    } else {
      buffers.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
          + `Content-Type: ${part.contentType}\r\n\r\n`,
        "utf8",
      ));
      buffers.push(part.data, Buffer.from("\r\n", "utf8"));
    }
  }
  buffers.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(buffers),
  };
}

interface ServiceFixtureOptions {
  readonly executor?: ImageExecutor;
  readonly maxUploadBytes?: number;
  readonly maxImagePixels?: number;
  readonly readyPerSession?: number;
  readonly readyTotal?: number;
  readonly ownershipTtlSeconds?: number;
  readonly ownedImageHosts?: readonly string[];
  readonly scopeCounts?: readonly number[];
  readonly totalCounts?: readonly number[];
  readonly registerError?: Error;
  readonly verifyError?: Error;
  readonly verifyResult?: readonly string[];
}

async function serviceFixture(options: ServiceFixtureOptions = {}): Promise<{
  readonly root: string;
  readonly privateDir: string;
  readonly publicDir: string;
  readonly store: ControlledUploadStore;
  readonly executor: ControlledExecutor;
  readonly service: ImageUploadService;
}> {
  const root = await mkdtemp(join(tmpdir(), "node-shortener-upload-branches-"));
  roots.push(root);
  const privateDir = join(root, "private", "tmp");
  const publicDir = join(root, "public", "uploads");
  const store = new ControlledUploadStore({
    ...(options.scopeCounts === undefined ? {} : { scopeCounts: options.scopeCounts }),
    ...(options.totalCounts === undefined ? {} : { totalCounts: options.totalCounts }),
    ...(options.registerError === undefined ? {} : { registerError: options.registerError }),
    ...(options.verifyError === undefined ? {} : { verifyError: options.verifyError }),
    ...(options.verifyResult === undefined ? {} : { verifyResult: options.verifyResult }),
  });
  const controlledExecutor = options.executor instanceof ControlledExecutor
    ? options.executor
    : new ControlledExecutor();
  return {
    root,
    privateDir,
    publicDir,
    store,
    executor: controlledExecutor,
    service: new ImageUploadService({
      uploads: store,
      executor: options.executor ?? controlledExecutor,
      clock,
      privateTempDir: privateDir,
      publicUploadDir: publicDir,
      ...(options.maxUploadBytes === undefined ? {} : { maxUploadBytes: options.maxUploadBytes }),
      ...(options.maxImagePixels === undefined ? {} : { maxImagePixels: options.maxImagePixels }),
      ...(options.readyPerSession === undefined ? {} : { readyPerSession: options.readyPerSession }),
      ...(options.readyTotal === undefined ? {} : { readyTotal: options.readyTotal }),
      ...(options.ownershipTtlSeconds === undefined ? {} : { ownershipTtlSeconds: options.ownershipTtlSeconds }),
      ...(options.ownedImageHosts === undefined ? {} : { ownedImageHosts: options.ownedImageHosts }),
    }),
  };
}

class ControlledExecutor implements ImageExecutor {
  public readonly calls: ImageExecutionRequest[] = [];

  public constructor(private readonly options: { readonly failAfterWritingTemp?: Error } = {}) {}

  public async execute(request: ImageExecutionRequest): Promise<ImageExecutionResult> {
    this.calls.push(request);
    await mkdir(dirname(request.outputTempPath), { recursive: true });
    await writeFile(request.outputTempPath, "processed");
    if (this.options.failAfterWritingTemp !== undefined) {
      throw this.options.failAfterWritingTemp;
    }
    await mkdir(dirname(request.finalPath), { recursive: true });
    await rename(request.outputTempPath, request.finalPath);
    return { width: 1200, height: 630, format: "jpeg", sourceWidth: 10, sourceHeight: 20 };
  }
}

class ControlledUploadStore implements UploadStore {
  public readonly registered: RegisterUploadInput[] = [];
  public readonly verifyCalls: Array<{
    readonly userId: number;
    readonly sessionScopeHash: string;
    readonly paths: readonly string[];
    readonly at: Date;
  }> = [];
  public readonly markCalls: Array<{
    readonly userId: number;
    readonly sessionScopeHash: string;
    readonly paths: readonly string[];
    readonly at: Date;
    readonly expiresAt: Date;
  }> = [];
  public totalCountCalls = 0;
  public verifyResult: readonly string[] | undefined;
  readonly #scopeCounts: readonly number[];
  readonly #totalCounts: readonly number[];
  readonly #registerError: Error | undefined;
  readonly #verifyError: Error | undefined;
  #scopeIndex = 0;
  #totalIndex = 0;

  public constructor(options: {
    readonly scopeCounts?: readonly number[];
    readonly totalCounts?: readonly number[];
    readonly registerError?: Error;
    readonly verifyError?: Error;
    readonly verifyResult?: readonly string[];
  } = {}) {
    this.#scopeCounts = options.scopeCounts ?? [0, 0];
    this.#totalCounts = options.totalCounts ?? [0, 0];
    this.#registerError = options.registerError;
    this.#verifyError = options.verifyError;
    this.verifyResult = options.verifyResult;
  }

  public async countReadyForScope(_userId: number, _sessionScopeHash: string): Promise<number> {
    return sequenceValue(this.#scopeCounts, this.#scopeIndex++);
  }

  public async countReadyTotal(): Promise<number> {
    this.totalCountCalls += 1;
    return sequenceValue(this.#totalCounts, this.#totalIndex++);
  }

  public async registerReady(input: RegisterUploadInput): Promise<void> {
    if (this.#registerError !== undefined) {
      throw this.#registerError;
    }
    this.registered.push(input);
  }

  public async verifyOwnedPaths(
    userId: number,
    sessionScopeHash: string,
    paths: readonly string[],
    at: Date,
  ): Promise<readonly string[]> {
    this.verifyCalls.push({ userId, sessionScopeHash, paths, at });
    if (this.#verifyError !== undefined) {
      throw this.#verifyError;
    }
    return this.verifyResult ?? paths;
  }

  public async markAttached(
    userId: number,
    sessionScopeHash: string,
    paths: readonly string[],
    at: Date,
    expiresAt: Date,
  ): Promise<void> {
    this.markCalls.push({ userId, sessionScopeHash, paths, at, expiresAt });
  }
}

function sequenceValue(values: readonly number[], index: number): number {
  return values[index] ?? values.at(-1) ?? 0;
}

async function filesInside(path: string): Promise<readonly string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error
      && (error as { code?: unknown }).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function scopeHash(value: SessionData): string {
  return createHash("sha256").update(value.uploadScope).digest("hex");
}
