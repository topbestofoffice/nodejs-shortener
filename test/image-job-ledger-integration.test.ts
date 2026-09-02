import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import multipartPlugin from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../src/core/errors.js";
import type { DomainContext, LinkRecord, SessionData, UserRecord } from "../src/core/types.js";
import { RecoveryDrainer } from "../src/infrastructure/startup-recovery.js";
import { registerLinkApiRoutes } from "../src/modules/links/http.js";
import type { LinkService } from "../src/modules/links/service.js";
import {
  buildQueuedImageExecutionRequest,
  decideBullMqJobReplay,
} from "../src/modules/uploads/bullmq-executor.js";
import type {
  ImageExecutionRequest,
  ImageExecutionResult,
  ImageExecutor,
} from "../src/modules/uploads/image-executor.js";
import {
  isImageJobAttachable,
  type ImageJobSnapshot,
  type NewImageJob,
} from "../src/modules/uploads/job-ledger-policy.js";
import { ImageUploadService, type StagedUpload } from "../src/modules/uploads/service.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

const roots: string[] = [];
const apps: FastifyInstance[] = [];
const baseMs = Date.parse("2026-09-01T12:00:00.000Z");
const session: SessionData = {
  id: "a".repeat(64),
  userId: 7,
  csrfToken: "b".repeat(64),
  uploadScope: "durable-upload-scope",
  authEpoch: 0,
  createdAt: new Date(baseMs).toISOString(),
  expiresAt: new Date(baseMs + 86_400_000).toISOString(),
  rememberSelector: null,
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("durable image-job integration", () => {
  it("publishes and registers atomically before a managed image can be attached", async () => {
    const fixture = await durableFixture();
    const staged = await fixture.service.stage(Readable.from(Buffer.from("source-image")));

    const result = await fixture.service.complete(staged, 7, session);
    const jobId = fixture.executor.calls[0]?.jobId ?? "";
    const job = await fixture.store.getImageJob(jobId);

    expect(job).not.toBeNull();
    expect(job === null ? false : isImageJobAttachable(job)).toBe(true);
    await expect(fixture.store.hasReadyImageRegistration(jobId)).resolves.toBe(true);
    await expect(readFile(join(fixture.publicDir, result.path.slice("uploads/".length)), "utf8"))
      .resolves.toBe("processed");
    expect(fixture.executor.calls[0]).toMatchObject({ jobId, deferPublication: true });

    const link = await fixture.store.createLink({
      domainId: 2,
      userId: 7,
      destination: "https://destination.example/ready",
      title: null,
      description: null,
      image: result.path,
      imageSessionScopeHash: fixture.service.scopeHash(session),
      imageOwnershipExpiresAt: new Date(baseMs + 86_400_000),
      code: "Ready001",
      createdAt: new Date(baseMs),
    });
    expect(link.image).toBe(result.path);
  });

  it("rejects a ready-looking upload row while its ledger job is still pending", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const proposal = newJob();
    await store.reserveImageJob(proposal, baseMs);
    await store.registerReady({
      path: proposal.outputStorageKey,
      userId: proposal.userId,
      sessionScopeHash: proposal.sessionScopeHash,
      createdAt: new Date(baseMs),
      expiresAt: new Date(proposal.ownershipExpiresAtMs),
    });

    await expect(store.createLink({
      domainId: 2,
      userId: proposal.userId,
      destination: "https://destination.example/pending",
      title: null,
      description: null,
      image: proposal.outputStorageKey,
      imageSessionScopeHash: proposal.sessionScopeHash,
      imageOwnershipExpiresAt: new Date(proposal.ownershipExpiresAtMs),
      code: "Pend0001",
      createdAt: new Date(baseMs),
    })).rejects.toMatchObject({ statusCode: 422, code: "UPLOAD_UNAVAILABLE" });
    await expect(store.findLink(2, "Pend0001", "vidx1x.local", "redirect")).resolves.toBeNull();
  });

  it("uses exact request idempotency and permits only one versioned processing claim", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const proposal = newJob();
    await expect(store.reserveImageJob(proposal, baseMs)).resolves.toMatchObject({ kind: "create" });
    await expect(store.reserveImageJob(proposal, baseMs)).resolves.toMatchObject({
      kind: "reuse",
      job: { jobId: proposal.jobId },
    });
    await expect(store.reserveImageJob({
      ...proposal,
      jobId: "2".repeat(32),
      payloadHash: "3".repeat(64),
    }, baseMs)).rejects.toMatchObject({ code: "REQUEST_KEY_CONFLICT" });

    const queued = await store.transitionImageJob(proposal.jobId, {
      type: "enqueue",
      expectedVersion: 0,
      atMs: baseMs + 1,
      notBeforeMs: baseMs + 1,
    });
    const claims = await Promise.allSettled([
      store.transitionImageJob(proposal.jobId, {
        type: "claim_processing",
        expectedVersion: queued.version,
        atMs: baseMs + 2,
        leaseOwner: "worker-a",
        leaseToken: "a".repeat(32),
        leaseExpiresAtMs: baseMs + 10_000,
      }),
      store.transitionImageJob(proposal.jobId, {
        type: "claim_processing",
        expectedVersion: queued.version,
        atMs: baseMs + 2,
        leaseOwner: "worker-b",
        leaseToken: "b".repeat(32),
        leaseExpiresAtMs: baseMs + 10_000,
      }),
    ]);
    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.find((claim) => claim.status === "rejected"))
      .toMatchObject({ reason: { code: "STALE_VERSION" } });
  });

  it("keeps the pre-listen recovery probe read-only and independent of the image worker", async () => {
    const fixture = await durableFixture();
    const proposal = newJob();
    await fixture.store.reserveImageJob(proposal, baseMs);

    await expect(fixture.service.probeRecoveryBacklog(1)).resolves.toEqual({ dueJobsObserved: 1 });
    await expect(fixture.store.getImageJob(proposal.jobId)).resolves.toMatchObject({
      state: "requested",
      version: 0,
    });
    expect(fixture.executor.calls).toHaveLength(0);
  });

  it("drains more than 100 real durable ledger rows after the bounded preflight", async () => {
    const total = 105;
    const fixture = await durableFixture({ readyPerSession: 200, readyTotal: 200 });
    await mkdir(fixture.privateDir, { recursive: true });
    for (let index = 1; index <= total; index += 1) {
      const jobId = index.toString(16).padStart(32, "0");
      const proposal = newJob({
        jobId,
        requestKey: createHash("sha256").update(`request-${index}`).digest("hex"),
        payloadHash: createHash("sha256").update(`payload-${index}`).digest("hex"),
        inputStorageKey: `private/job-${jobId}.input`,
        outputStorageKey: `uploads/${index.toString(16).padStart(16, "0")}.jpg`,
      });
      await fixture.store.reserveImageJob(proposal, baseMs);
      await writeFile(join(fixture.privateDir, `job-${jobId}.input`), `input-${index}`);
    }
    await expect(fixture.service.probeRecoveryBacklog(1)).resolves.toEqual({ dueJobsObserved: 1 });

    let recovered = 0;
    let resolveDrained: (() => void) | undefined;
    const drained = new Promise<void>((resolve) => { resolveDrained = resolve; });
    const drainer = new RecoveryDrainer({
      owner: true,
      batchSize: 1,
      drainBatch: () => fixture.service.reconcileOnStartup(1, 1),
      continuationDelayMs: 0,
      idleDelayMs: 60_000,
      errorDelayMs: 60_000,
      onResult: (result) => {
        recovered += result.recovered;
        if (recovered === total) resolveDrained?.();
      },
    });
    drainer.start();
    await drained;
    await drainer.stop();

    expect(recovered).toBe(total);
    expect(fixture.executor.calls).toHaveLength(total);
    await expect(fixture.store.listImageJobsForRecovery(baseMs, 1)).resolves.toEqual([]);
  }, 15_000);

  it("keeps an ambiguous late private completion non-public and finishes it by restart reconciliation", async () => {
    const clock = new MutableClock(baseMs);
    const executor = new DeferredTestExecutor(true);
    const fixture = await durableFixture({ clock, executor, jobLeaseMs: 1_000 });
    const staged = await fixture.service.stage(Readable.from(Buffer.from("source-image")));

    await expect(fixture.service.complete(staged, 7, session))
      .rejects.toMatchObject({ statusCode: 503, code: "IMAGE_QUEUE_UNAVAILABLE" });
    const jobId = executor.calls[0]?.jobId ?? "";
    const ambiguous = await requiredJob(fixture.store, jobId);
    expect(ambiguous.state).toBe("processing");
    expect(await isFile(join(fixture.publicDir, ambiguous.outputStorageKey.slice("uploads/".length)))).toBe(false);
    expect(await isFile(join(fixture.privateDir, `output-${jobId}.jpg.part`))).toBe(true);

    clock.at(baseMs + 1_001);
    executor.failAmbiguously = false;
    await expect(fixture.service.reconcileOnStartup()).resolves.toEqual({
      inspected: 1,
      recovered: 1,
      manualReview: 0,
    });
    const recovered = await requiredJob(fixture.store, jobId);
    expect(isImageJobAttachable(recovered)).toBe(true);
    expect(executor.calls).toHaveLength(2);
    expect(await isFile(join(fixture.publicDir, recovered.outputStorageKey.slice("uploads/".length)))).toBe(true);
  });

  it("does not allow an expired worker lease to begin public publication", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const proposal = newJob();
    await store.reserveImageJob(proposal, baseMs);
    let job = await store.transitionImageJob(proposal.jobId, {
      type: "enqueue",
      expectedVersion: 0,
      atMs: baseMs + 1,
      notBeforeMs: baseMs + 1,
    });
    job = await store.transitionImageJob(job.jobId, {
      type: "claim_processing",
      expectedVersion: job.version,
      atMs: baseMs + 2,
      leaseOwner: "worker-a",
      leaseToken: "c".repeat(32),
      leaseExpiresAtMs: baseMs + 5,
    });
    job = await store.transitionImageJob(job.jobId, {
      type: "record_output_ready",
      expectedVersion: job.version,
      atMs: baseMs + 3,
      leaseToken: "c".repeat(32),
      sourceWidth: 10,
      sourceHeight: 20,
    });

    await expect(store.transitionImageJob(job.jobId, {
      type: "begin_publication",
      expectedVersion: job.version,
      atMs: baseMs + 6,
      leaseToken: "c".repeat(32),
    })).rejects.toMatchObject({ code: "STALE_LEASE" });
    expect(isImageJobAttachable(await requiredJob(store, job.jobId))).toBe(false);
  });

  it("refuses compensation when any link still references the ledger output", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const proposal = newJob();
    await store.reserveImageJob(proposal, baseMs);
    let job = await store.transitionImageJob(proposal.jobId, {
      type: "enqueue",
      expectedVersion: 0,
      atMs: baseMs + 1,
      notBeforeMs: baseMs + 1,
    });
    job = await store.transitionImageJob(job.jobId, {
      type: "claim_processing",
      expectedVersion: job.version,
      atMs: baseMs + 2,
      leaseOwner: "worker-a",
      leaseToken: "d".repeat(32),
      leaseExpiresAtMs: baseMs + 100,
    });
    job = await store.transitionImageJob(job.jobId, {
      type: "record_failure",
      expectedVersion: job.version,
      atMs: baseMs + 3,
      leaseToken: "d".repeat(32),
      errorCode: "AMBIGUOUS_PUBLICATION",
      publicationMayHaveOccurred: true,
      privateOutputRemoved: false,
      retryAtMs: baseMs + 3,
    });
    job = await store.transitionImageJob(job.jobId, {
      type: "claim_compensation",
      expectedVersion: job.version,
      atMs: baseMs + 4,
      leaseOwner: "compensator",
      leaseToken: "e".repeat(32),
      leaseExpiresAtMs: baseMs + 100,
    });
    store.seedLink(linkReferencing(proposal.outputStorageKey));

    await expect(store.completeImageJobCompensation(job.jobId, {
      type: "mark_compensated",
      expectedVersion: job.version,
      atMs: baseMs + 5,
      leaseToken: "e".repeat(32),
      finalArtifactAbsent: true,
      readyRegistrationAbsent: true,
    })).rejects.toMatchObject({ code: "IMAGE_JOB_REFERENCED" });
    await expect(store.getImageJob(job.jobId)).resolves.toMatchObject({ state: "compensating" });
  });

  it("preserves the public file when restart compensation discovers a link reference", async () => {
    const clock = new MutableClock(baseMs + 6);
    const fixture = await durableFixture({ clock, jobLeaseMs: 1_000 });
    const proposal = newJob();
    await fixture.store.reserveImageJob(proposal, baseMs);
    let job = await fixture.store.transitionImageJob(proposal.jobId, {
      type: "enqueue",
      expectedVersion: 0,
      atMs: baseMs + 1,
      notBeforeMs: baseMs + 1,
    });
    job = await fixture.store.transitionImageJob(job.jobId, {
      type: "claim_processing",
      expectedVersion: job.version,
      atMs: baseMs + 2,
      leaseOwner: "expired-worker",
      leaseToken: "9".repeat(32),
      leaseExpiresAtMs: baseMs + 5,
    });
    job = await fixture.store.transitionImageJob(job.jobId, {
      type: "record_output_ready",
      expectedVersion: job.version,
      atMs: baseMs + 3,
      leaseToken: "9".repeat(32),
      sourceWidth: 10,
      sourceHeight: 20,
    });
    await fixture.store.transitionImageJob(job.jobId, {
      type: "begin_publication",
      expectedVersion: job.version,
      atMs: baseMs + 4,
      leaseToken: "9".repeat(32),
    });
    fixture.store.seedLink(linkReferencing(proposal.outputStorageKey));
    const finalPath = join(fixture.publicDir, proposal.outputStorageKey.slice("uploads/".length));
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, "must-survive");

    await expect(fixture.service.reconcileOnStartup()).resolves.toEqual({
      inspected: 1,
      recovered: 0,
      manualReview: 1,
    });
    await expect(readFile(finalPath, "utf8")).resolves.toBe("must-survive");
    await expect(fixture.store.getImageJob(proposal.jobId)).resolves.toMatchObject({
      state: "manual_review",
      lastErrorCode: "IMAGE_JOB_REFERENCED",
    });
    await expect(fixture.store.listImageJobsForRecovery(clock.now().getTime(), 1)).resolves.toEqual([]);
  });

  it("queues only the ledger job id and relative private/public storage keys", async () => {
    const root = await temporaryRoot("node-shortener-ledger-queue-");
    const privateDir = join(root, "private");
    const publicDir = join(root, "public");
    const request: ImageExecutionRequest = {
      jobId: "f".repeat(32),
      attempt: 2,
      inputPath: join(privateDir, "job.input"),
      outputTempPath: join(privateDir, "job.output.part"),
      finalPath: join(publicDir, "image.jpg"),
      maxPixels: 1_000,
      deferPublication: true,
    };

    const queued = buildQueuedImageExecutionRequest(request, privateDir, publicDir);

    expect(queued).toEqual({
      jobId: request.jobId,
      attempt: 2,
      inputKey: "job.input",
      outputTempKey: "job.output.part",
      finalKey: "image.jpg",
      maxPixels: 1_000,
      deferPublication: true,
    });
    expect(JSON.stringify(queued)).not.toContain(root);
  });

  it.each([
    { stored: 1, requested: 1, state: "completed", expected: "reuse" },
    { stored: 1, requested: 2, state: "completed", expected: "replace" },
    { stored: 1, requested: 2, state: "failed", expected: "replace" },
    { stored: 1, requested: 2, state: "waiting", expected: "replace" },
    { stored: 1, requested: 2, state: "active", expected: "reuse" },
    { stored: 3, requested: 2, state: "completed", expected: "reject" },
  ])("makes retained BullMQ job replay generation-safe: $state $stored->$requested", (entry) => {
    expect(decideBullMqJobReplay(entry.stored, entry.requested, entry.state)).toBe(entry.expected);
  });
});

describe("link API image busy contract", () => {
  it("preserves the exact pre-commit 429 response when the image processor is busy", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(multipartPlugin);
    const store = new InMemoryApplicationStore(domainPolicies);
    const definition = testConfig.registry.byId(1);
    if (definition === undefined) throw new Error("Dashboard fixture domain is missing.");
    const context: DomainContext = { definition, requestHost: definition.canonicalHost, isCanonical: true };
    const user: UserRecord = {
      id: 7,
      username: "author",
      passwordHash: "not-used",
      role: "user",
      defaultDomainId: 2,
      createdAt: new Date(baseMs),
    };
    app.decorateRequest("auth");
    app.decorateRequest("domainContext");
    app.addHook("onRequest", async (request) => {
      request.auth = { session, user };
      request.domainContext = context;
    });
    const images = busyImageService();
    const links = {
      assertCreatableDomain: async () => undefined,
    } as unknown as LinkService;
    registerLinkApiRoutes(app, {
      links,
      images,
      stores: store,
      registry: testConfig.registry,
      browserScopedDefaultUsers: [],
    });

    const request = multipart([
      ["action", "create_single"],
      ["csrf", session.csrfToken],
      ["domain_id", "2"],
      ["destination", "https://destination.example/busy"],
    ], Buffer.from("image"));
    const response = await app.inject({
      method: "POST",
      url: "/api.php",
      headers: { host: definition.canonicalHost, ...request.headers },
      payload: request.payload,
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers["cache-control"]).toBe("no-store, private, max-age=0");
    expect(response.json()).toEqual({
      ok: false,
      error: "Image processor is temporarily unavailable",
      failure_code: "image_processor_busy",
      link_committed: false,
      retryable: true,
    });
    await expect(store.findLink(2, "Code001", "vidx1x.local", "redirect")).resolves.toBeNull();
  });
});

class MutableClock {
  public constructor(private currentMs: number) {}
  public now(): Date {
    return new Date(this.currentMs);
  }
  public at(value: number): void {
    this.currentMs = value;
  }
}

class DeferredTestExecutor implements ImageExecutor {
  public readonly calls: ImageExecutionRequest[] = [];
  public constructor(public failAmbiguously = false) {}

  public async execute(request: ImageExecutionRequest): Promise<ImageExecutionResult> {
    this.calls.push(request);
    if (!request.deferPublication) throw new Error("Durable executor must defer publication.");
    await mkdir(dirname(request.outputTempPath), { recursive: true });
    await writeFile(request.outputTempPath, "processed");
    if (this.failAmbiguously) {
      throw new AppError("Queue acknowledgement was lost", 503, "IMAGE_QUEUE_UNAVAILABLE", false);
    }
    return { width: 1200, height: 630, format: "jpeg", sourceWidth: 10, sourceHeight: 20 };
  }
}

async function durableFixture(options: {
  readonly clock?: MutableClock;
  readonly executor?: DeferredTestExecutor;
  readonly jobLeaseMs?: number;
  readonly readyPerSession?: number;
  readonly readyTotal?: number;
} = {}): Promise<{
  readonly root: string;
  readonly privateDir: string;
  readonly publicDir: string;
  readonly store: InMemoryApplicationStore;
  readonly executor: DeferredTestExecutor;
  readonly service: ImageUploadService;
}> {
  const root = await temporaryRoot("node-shortener-ledger-integration-");
  const privateDir = join(root, "private");
  const publicDir = join(root, "public");
  const store = new InMemoryApplicationStore(domainPolicies);
  const executor = options.executor ?? new DeferredTestExecutor();
  const clock = options.clock ?? new MutableClock(baseMs);
  return {
    root,
    privateDir,
    publicDir,
    store,
    executor,
    service: new ImageUploadService({
      uploads: store,
      imageJobs: store,
      executor,
      clock,
      privateTempDir: privateDir,
      publicUploadDir: publicDir,
      ledgerDomainId: 1,
      jobLeaseMs: options.jobLeaseMs ?? 30_000,
      ...(options.readyPerSession === undefined ? {} : { readyPerSession: options.readyPerSession }),
      ...(options.readyTotal === undefined ? {} : { readyTotal: options.readyTotal }),
    }),
  };
}

function newJob(overrides: Partial<NewImageJob> = {}): NewImageJob {
  return {
    jobId: "1".repeat(32),
    requestKey: "a".repeat(64),
    payloadHash: "b".repeat(64),
    domainId: 1,
    userId: 7,
    sessionScopeHash: createHash("sha256").update(session.uploadScope).digest("hex"),
    ownershipExpiresAtMs: baseMs + 86_400_000,
    inputStorageKey: `private/job-${"1".repeat(32)}.input`,
    outputStorageKey: "uploads/0000000000000001.jpg",
    maxAttempts: 3,
    maxCompensationAttempts: 5,
    ...overrides,
  };
}

function linkReferencing(image: string): LinkRecord {
  return {
    id: "9001",
    domainId: 2,
    code: "Ref00001",
    userId: 7,
    destination: "https://destination.example/reference",
    title: null,
    description: null,
    image,
    authorRole: "user",
    domainHostname: "vidx1x.local",
    domainLabel: "VIDX1X",
    diversionCampaign: "vidx1x",
    createdAt: new Date(baseMs),
  };
}

async function requiredJob(store: InMemoryApplicationStore, jobId: string): Promise<ImageJobSnapshot> {
  const job = await store.getImageJob(jobId);
  if (job === null) throw new Error("Expected image job was not found.");
  return job;
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error
      && (error as { code?: unknown }).code === "ENOENT") return false;
    throw error instanceof Error ? error : new Error("File observation failed.");
  }
}

function busyImageService(): ImageUploadService {
  const staged: StagedUpload = { inputPath: "private/fake.part", bytes: 5 };
  return {
    stage: async (stream: Readable) => {
      for await (const chunk of stream) void chunk;
      return staged;
    },
    complete: async () => {
      throw new AppError("Image processor is temporarily unavailable", 429, "IMAGE_PROCESSOR_BUSY");
    },
    discard: async () => undefined,
    scopeHash: () => "f".repeat(64),
  } as unknown as ImageUploadService;
}

function multipart(
  fields: readonly (readonly [string, string])[],
  file: Buffer,
): { readonly headers: { readonly "content-type": string }; readonly payload: Buffer } {
  const boundary = "----durable-image-ledger-contract";
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      "utf8",
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="upload_image"; filename="image.jpg"\r\n`
      + "Content-Type: image/jpeg\r\n\r\n",
    "utf8",
  ));
  chunks.push(file, Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}
