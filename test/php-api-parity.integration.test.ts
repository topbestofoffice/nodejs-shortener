import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApplication } from "../src/app.js";
import { AuthService } from "../src/modules/auth/service.js";
import { createPhpCompatiblePasswordHash } from "../src/modules/auth/passwords.js";
import { LinkService } from "../src/modules/links/service.js";
import {
  SharpConcurrencyOneExecutor,
  type ImageExecutionRequest,
  type ImageExecutionResult,
  type ImageExecutor,
} from "../src/modules/uploads/image-executor.js";
import { ImageUploadService } from "../src/modules/uploads/service.js";
import { InMemoryApplicationStore, InMemorySessionStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

const fixedClock = { now: () => new Date("2026-08-23T12:00:00.000Z") };
const password = "parity-test-password";
let passwordHash = "";
let app: FastifyInstance | undefined;
const roots: string[] = [];

beforeAll(async () => {
  passwordHash = await createPhpCompatiblePasswordHash(password);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  app = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(() => {
  passwordHash = "";
});

describe("live PHP /api.php and /upload.php parity", () => {
  it("returns the exact JSON authentication gate before processing /api.php", async () => {
    const fixture = await createFixture();
    const response = await apiRequest(fixture.app, null, {
      csrf: "0".repeat(64),
      action: "create_single",
      domain_id: "2",
      destination: "https://destination.example/should-not-run",
    });

    expectJsonResponse(response, 401, { ok: false, error: "Not authenticated" });
    expect(fixture.generatedCodes).toEqual([]);
  });

  it("returns the exact JSON CSRF gate for an authenticated /api.php request", async () => {
    const fixture = await createFixture();
    const auth = await login(fixture.app, "author");
    const response = await apiRequest(fixture.app, auth.cookie, {
      csrf: "invalid",
      action: "create_single",
      domain_id: "2",
      destination: "https://destination.example/should-not-run",
    });

    expectJsonResponse(response, 403, { ok: false, error: "Invalid CSRF token" });
    expect(fixture.generatedCodes).toEqual([]);
  });

  it("rejects duplicate security/control fields instead of choosing one ambiguous value", async () => {
    const fixture = await createFixture();
    const auth = await login(fixture.app, "author");
    const response = await apiRequestEntries(fixture.app, auth.cookie, [
      ["csrf", auth.csrf],
      ["action", "create_single"],
      ["action", "delete"],
      ["domain_id", "2"],
      ["destination", "https://destination.example/ambiguous"],
    ]);

    expectJsonResponse(response, 400, { ok: false, error: "Duplicate action field." });
    expect(fixture.generatedCodes).toEqual([]);
  });

  it("rejects an /api.php file part before CSRF without staging it", async () => {
    const fixture = await createFixture();
    const auth = await login(fixture.app, "author");
    const stage = vi.spyOn(fixture.imageUploadService, "stage");
    const request = multipartWithImage({
      csrf: auth.csrf,
      action: "create_single",
      domain_id: "2",
      destination: "https://destination.example/should-not-run",
    }, Buffer.from("not-an-image"), true);

    const response = await fixture.app.inject({
      method: "POST",
      url: "/api.php",
      headers: { host: "url6x.local", cookie: auth.cookie, ...request.headers },
      payload: request.payload,
    });

    expectJsonResponse(response, 403, { ok: false, error: "Invalid CSRF token" });
    expect(stage).not.toHaveBeenCalled();
    expect(fixture.generatedCodes).toEqual([]);
  });

  it("keeps active URL6X (D1) creation paused without writing a link", async () => {
    const fixture = await createFixture(["Pause01"]);
    const auth = await login(fixture.app, "author");
    const response = await apiRequest(fixture.app, auth.cookie, {
      csrf: auth.csrf,
      action: "create_single",
      domain_id: "1",
      destination: "https://destination.example/paused",
    });

    expectJsonResponse(response, 400, { ok: false, error: "Choose a valid short-link domain." });
    expect(fixture.generatedCodes).toEqual([]);
    await expect(fixture.store.findLink(1, "Pause01", "url6x.local", "dashboard")).resolves.toBeNull();
  });

  it("creates on VIDX1X (D2) and permits deletion only by the owning user", async () => {
    const fixture = await createFixture(["Own0001"]);
    const owner = await login(fixture.app, "author");
    const create = await apiRequest(fixture.app, owner.cookie, {
      csrf: owner.csrf,
      action: "create_single",
      domain_id: "2",
      destination: "https://destination.example/owned",
      title: "Owned link",
      description: "Owner-only deletion",
    });

    expect(create.statusCode).toBe(200);
    expect(create.headers["content-type"]).toMatch(/^application\/json\b/);
    expect(create.json()).toMatchObject({
      ok: true,
      short: "https://vidx1x.local/Own0001",
      destination_url: "https://destination.example/owned",
      image_info: null,
      retained_image_path: null,
    });
    expect(create.json<{ card: unknown }>().card).toEqual(expect.any(String));
    await expect(fixture.store.findLink(2, "Own0001", "vidx1x.local", "redirect"))
      .resolves.toMatchObject({ userId: 42, domainId: 2, code: "Own0001" });

    const intruder = await login(fixture.app, "intruder");
    const rejectedDelete = await apiRequest(fixture.app, intruder.cookie, {
      csrf: intruder.csrf,
      action: "delete",
      domain_id: "2",
      code: "Own0001",
    });
    expectJsonResponse(rejectedDelete, 200, { ok: false, error: "Link not found" });
    await expect(fixture.store.findLink(2, "Own0001", "vidx1x.local", "redirect"))
      .resolves.toMatchObject({ userId: 42 });

    const acceptedDelete = await apiRequest(fixture.app, owner.cookie, {
      csrf: owner.csrf,
      action: "delete",
      domain_id: "2",
      code: "Own0001",
    });
    expectJsonResponse(acceptedDelete, 200, { ok: true });
    await expect(fixture.store.findLink(2, "Own0001", "vidx1x.local", "redirect")).resolves.toBeNull();
  });

  it("keeps hdvideos default-domain preference browser-local and returns 409", async () => {
    const fixture = await createFixture();
    const auth = await login(fixture.app, "hdvideos");
    const response = await apiRequest(fixture.app, auth.cookie, {
      csrf: auth.csrf,
      action: "set_default_domain",
      domain_id: "2",
    });

    expectJsonResponse(response, 409, {
      ok: false,
      error: "Refresh to save this domain on this browser.",
      preference_scope: "browser",
      persisted: false,
    });
    await expect(fixture.store.findUserById(8)).resolves.toMatchObject({ defaultDomainId: 1 });
  });

  it("keeps successful rows when a bulk create has a mixture of valid and invalid URLs", async () => {
    const fixture = await createFixture(["Bulk001"]);
    const auth = await login(fixture.app, "author");
    const response = await apiRequest(fixture.app, auth.cookie, {
      csrf: auth.csrf,
      action: "create_bulk",
      domain_id: "2",
      bulk_urls: "https://one.example/path\nnot a url",
      card_limit: "20",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/^application\/json\b/);
    expect(response.json()).toMatchObject({
      ok: true,
      created: 1,
      failed: 1,
      images: 0,
      retained_image_paths: [],
      items: [{
        short: "https://vidx1x.local/Bulk001",
        destination_url: "https://one.example/path",
        destination: "one.example/path",
        image_url: "",
      }],
    });
    expect(response.json<{ cards: unknown[] }>().cards).toHaveLength(1);
    await expect(fixture.store.findLink(2, "Bulk001", "vidx1x.local", "redirect"))
      .resolves.toMatchObject({ destination: "https://one.example/path" });
  });

  it("reports an all-invalid bulk as a successful batch with zero created rows", async () => {
    const fixture = await createFixture(["Never01"]);
    const auth = await login(fixture.app, "author");
    const response = await apiRequest(fixture.app, auth.cookie, {
      csrf: auth.csrf,
      action: "create_bulk",
      domain_id: "2",
      bulk_urls: "not a url\njavascript:alert(1)",
      card_limit: "20",
    });

    expectJsonResponse(response, 200, {
      ok: true,
      cards: [],
      items: [],
      created: 0,
      failed: 2,
      images: 0,
      retained_image_paths: [],
    });
    expect(fixture.generatedCodes).toEqual([]);
  });

  it("parses the configured 100 repeated bulk image paths and rejects 101 at the application boundary", async () => {
    const fixture = await createFixture();
    const auth = await login(fixture.app, "author");
    const controls: readonly [string, string][] = [
      ["csrf", auth.csrf],
      ["action", "create_bulk"],
      ["domain_id", "2"],
      ["bulk_urls", "https://one.example/path"],
    ];
    const paths = Array.from({ length: 101 }, (_, index): [string, string] => [
      "bulk_image_paths[]",
      `uploads/${index.toString(16).padStart(16, "0")}.jpg`,
    ]);

    const acceptedByParser = await apiRequestEntries(fixture.app, auth.cookie, [...controls, ...paths.slice(0, 100)]);
    expect(acceptedByParser.statusCode, acceptedByParser.body).toBe(422);
    expect(acceptedByParser.body).toContain("unavailable");

    const rejectedByApplication = await apiRequestEntries(fixture.app, auth.cookie, [...controls, ...paths]);
    expectJsonResponse(rejectedByApplication, 422, {
      ok: false,
      error: "Too many images in one batch (max 100).",
    });
  });

  it("returns the exact JSON authentication error from /upload.php", async () => {
    const fixture = await createFixture();
    const response = await uploadRequest(fixture.app, null, { csrf: "0".repeat(64) });

    expectJsonResponse(response, 401, { ok: false, error: "Not authenticated" });
  });

  it("returns the exact JSON CSRF error from /upload.php", async () => {
    const fixture = await createFixture();
    const auth = await login(fixture.app, "author");
    const response = await uploadRequest(fixture.app, auth.cookie, { csrf: "invalid" });

    expectJsonResponse(response, 403, { ok: false, error: "Invalid CSRF token" });
  });

  it("returns the PHP-compatible JSON error when /upload.php receives no image", async () => {
    const fixture = await createFixture();
    const auth = await login(fixture.app, "author");
    const response = await uploadRequest(fixture.app, auth.cookie, { csrf: auth.csrf });

    expectJsonResponse(response, 400, { ok: false, error: "No image received" });
  });

  it("reuses the retained managed image on a second create without another Sharp execution", async () => {
    const fixture = await createFixture();
    const auth = await login(fixture.app, "author");
    const image = await sharp({ create: { width: 40, height: 40, channels: 3, background: "red" } }).png().toBuffer();
    const firstRequest = multipartWithImage({
      csrf: auth.csrf,
      action: "create_single",
      domain_id: "2",
      destination: "https://destination.example/first",
    }, image);
    const first = await fixture.app.inject({
      method: "POST",
      url: "/api.php",
      headers: { host: "url6x.local", cookie: auth.cookie, ...firstRequest.headers },
      payload: firstRequest.payload,
    });
    expect(first.statusCode).toBe(200);
    const retained = first.json<{ retained_image_path: string }>().retained_image_path;
    expect(retained).toMatch(/^uploads\/[a-f0-9]{16}\.jpg$/);
    expect(fixture.imageExecutor.calls).toBe(1);

    const second = await apiRequest(fixture.app, auth.cookie, {
      csrf: auth.csrf,
      action: "create_single",
      domain_id: "2",
      destination: "https://destination.example/second",
      image_url: retained,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ retained_image_path: string }>().retained_image_path).toBe(retained);
    expect(fixture.imageExecutor.calls).toBe(1);
  });
});

interface Fixture {
  readonly app: FastifyInstance;
  readonly store: InMemoryApplicationStore;
  readonly generatedCodes: string[];
  readonly imageExecutor: CountingImageExecutor;
  readonly imageUploadService: ImageUploadService;
}

interface Login {
  readonly cookie: string;
  readonly csrf: string;
}

async function createFixture(codes: readonly string[] = []): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "node-shortener-php-parity-"));
  roots.push(root);
  const store = new InMemoryApplicationStore(domainPolicies);
  for (const user of [
    { id: 42, username: "author", defaultDomainId: 2 },
    { id: 43, username: "intruder", defaultDomainId: 2 },
    { id: 8, username: "hdvideos", defaultDomainId: 1 },
  ]) {
    store.seedUser({
      ...user,
      passwordHash,
      role: "user",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  }

  const sessions = new InMemorySessionStore();
  const authService = new AuthService({
    authStore: store,
    sessions,
    clock: fixedClock,
    ipHashSecret: testConfig.ipHashSecret,
  });
  const imageExecutor = new CountingImageExecutor(new SharpConcurrencyOneExecutor());
  const imageUploadService = new ImageUploadService({
    uploads: store,
    executor: imageExecutor,
    clock: fixedClock,
    privateTempDir: join(root, "private", "tmp"),
    publicUploadDir: join(root, "public", "uploads"),
    maxOwnedPaths: testConfig.links.maxBulkImages,
  });
  const generatedCodes: string[] = [];
  let nextCode = 0;
  const linkService = new LinkService({
    appNamespace: testConfig.appNamespace,
    registry: testConfig.registry,
    stores: store,
    clock: fixedClock,
    codeGenerator: () => {
      const code = codes[nextCode] ?? `Code${String(nextCode + 1).padStart(3, "0")}`;
      nextCode += 1;
      generatedCodes.push(code);
      return code;
    },
  });
  app = await buildApplication({
    config: testConfig,
    stores: store,
    authService,
    imageUploadService,
    linkService,
  });
  return { app, store, generatedCodes, imageExecutor, imageUploadService };
}

async function login(target: FastifyInstance, username: string): Promise<Login> {
  const csrfResponse = await target.inject({
    method: "GET",
    url: "/auth/csrf",
    headers: { host: "url6x.local" },
  });
  expect(csrfResponse.statusCode).toBe(200);
  const preAuthCookie = csrfResponse.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  const preAuthCsrf = csrfResponse.json<{ csrf: string }>().csrf;
  const response = await target.inject({
    method: "POST",
    url: "/auth/login",
    headers: {
      host: "url6x.local",
      "content-type": "application/x-www-form-urlencoded",
      cookie: preAuthCookie,
    },
    payload: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&csrf=${preAuthCsrf}`,
  });
  expect(response.statusCode).toBe(200);
  return {
    cookie: response.cookies.map((item) => `${item.name}=${item.value}`).join("; "),
    csrf: response.json<{ csrf: string }>().csrf,
  };
}

async function apiRequest(
  target: FastifyInstance,
  cookie: string | null,
  fields: Readonly<Record<string, string>>,
) {
  const request = multipart(fields);
  return target.inject({
    method: "POST",
    url: "/api.php",
    headers: {
      host: "url6x.local",
      ...request.headers,
      ...(cookie === null ? {} : { cookie }),
    },
    payload: request.payload,
  });
}

async function apiRequestEntries(
  target: FastifyInstance,
  cookie: string,
  fields: readonly (readonly [string, string])[],
) {
  const request = multipartEntries(fields);
  return target.inject({
    method: "POST",
    url: "/api.php",
    headers: { host: "url6x.local", ...request.headers, cookie },
    payload: request.payload,
  });
}

async function uploadRequest(
  target: FastifyInstance,
  cookie: string | null,
  fields: Readonly<Record<string, string>>,
) {
  const request = multipart(fields);
  return target.inject({
    method: "POST",
    url: "/upload.php",
    headers: {
      host: "url6x.local",
      ...request.headers,
      ...(cookie === null ? {} : { cookie }),
    },
    payload: request.payload,
  });
}

function multipart(fields: Readonly<Record<string, string>>): {
  readonly headers: { readonly "content-type": string };
  readonly payload: Buffer;
} {
  return multipartEntries(Object.entries(fields));
}

function multipartEntries(fields: readonly (readonly [string, string])[]): {
  readonly headers: { readonly "content-type": string };
  readonly payload: Buffer;
} {
  const boundary = "----node-shortener-php-parity-boundary";
  const chunks = fields.map(([name, value]) => [
    `--${boundary}\r\n`,
    `Content-Disposition: form-data; name="${name}"\r\n\r\n`,
    `${value}\r\n`,
  ].join(""));
  chunks.push(`--${boundary}--\r\n`);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(chunks.join(""), "utf8"),
  };
}

function multipartWithImage(fields: Readonly<Record<string, string>>, image: Buffer, fileFirst = false): {
  readonly headers: { readonly "content-type": string };
  readonly payload: Buffer;
} {
  const boundary = "----node-shortener-retained-image-boundary";
  const chunks: Buffer[] = [];
  const fieldChunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    fieldChunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  const fileChunks = [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="upload_image"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`),
    image,
    Buffer.from("\r\n"),
  ];
  chunks.push(...(fileFirst ? [...fileChunks, ...fieldChunks] : [...fieldChunks, ...fileChunks]));
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}

class CountingImageExecutor implements ImageExecutor {
  public calls = 0;

  public constructor(private readonly delegate: ImageExecutor) {}

  public async execute(request: ImageExecutionRequest): Promise<ImageExecutionResult> {
    this.calls += 1;
    return this.delegate.execute(request);
  }
}

function expectJsonResponse(
  response: { readonly statusCode: number; readonly headers: Record<string, number | string | string[] | undefined>; readonly body: string },
  statusCode: number,
  expectedBody: unknown,
): void {
  let parsed: unknown = { nonJsonBody: response.body };
  try {
    parsed = JSON.parse(response.body) as unknown;
  } catch {
    // Keep the raw body in the assertion so a plain-text parity gap is explicit.
  }
  expect.soft(response.statusCode).toBe(statusCode);
  expect.soft(response.headers["content-type"]).toMatch(/^application\/json\b/);
  expect.soft(parsed).toEqual(expectedBody);
}
