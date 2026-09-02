import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError, ValidationError } from "../../core/errors.js";
import type { Clock, ImageJobStore, UploadStore } from "../../ports.js";
import type { SessionData } from "../../core/types.js";
import { removeFileIfPresent, type ImageExecutionResult, type ImageExecutor } from "./image-executor.js";
import {
  isImageJobAttachable,
  planImageJobRestart,
  type ImageJobSnapshot,
  type NewImageJob,
} from "./job-ledger-policy.js";
import { isManagedImagePath, isManagedImageRequestPath } from "./managed-image-path.js";

export interface StagedUpload {
  readonly inputPath: string;
  readonly bytes: number;
  readonly requestKey?: string;
  readonly payloadHash?: string;
  readonly inputStorageKey?: string;
}

export interface ImageUploadResult {
  readonly path: string;
  readonly imageInfo: ImageExecutionResult & {
    readonly level: "good";
    readonly message: string;
    readonly ratio: number;
  };
}

export interface ImageUploadServiceOptions {
  readonly uploads: UploadStore;
  readonly executor: ImageExecutor;
  readonly clock: Clock;
  readonly privateTempDir: string;
  readonly publicUploadDir: string;
  readonly maxUploadBytes?: number;
  readonly maxImagePixels?: number;
  readonly readyPerSession?: number;
  readonly readyTotal?: number;
  readonly ownershipTtlSeconds?: number;
  readonly maxOwnedPaths?: number;
  readonly ownedImageHosts?: readonly string[];
  readonly imageJobs?: ImageJobStore;
  readonly ledgerDomainId?: number;
  readonly jobLeaseMs?: number;
}

export class ImageUploadService {
  readonly #privateTempDir: string;
  readonly #publicUploadDir: string;
  readonly #maxUploadBytes: number;
  readonly #maxImagePixels: number;
  readonly #readyPerSession: number;
  readonly #readyTotal: number;
  readonly #ownershipTtlSeconds: number;
  readonly #maxOwnedPaths: number;
  readonly #ownedImageHosts: ReadonlySet<string>;
  readonly #imageJobs: ImageJobStore | null;
  readonly #ledgerDomainId: number;
  readonly #jobLeaseMs: number;

  public constructor(private readonly options: ImageUploadServiceOptions) {
    this.#privateTempDir = resolve(options.privateTempDir);
    this.#publicUploadDir = resolve(options.publicUploadDir);
    this.#maxUploadBytes = options.maxUploadBytes ?? 2 * 1024 * 1024;
    this.#maxImagePixels = options.maxImagePixels ?? 20_000_000;
    this.#readyPerSession = options.readyPerSession ?? 50;
    this.#readyTotal = options.readyTotal ?? 1000;
    this.#ownershipTtlSeconds = options.ownershipTtlSeconds ?? 86_400;
    this.#maxOwnedPaths = options.maxOwnedPaths ?? 50;
    if (!Number.isSafeInteger(this.#maxOwnedPaths) || this.#maxOwnedPaths < 1 || this.#maxOwnedPaths > 500) {
      throw new RangeError("Maximum owned image paths must be between 1 and 500.");
    }
    this.#ownedImageHosts = new Set((options.ownedImageHosts ?? []).map((host) => host.trim().toLowerCase()));
    this.#imageJobs = options.imageJobs ?? null;
    this.#ledgerDomainId = options.ledgerDomainId ?? 1;
    this.#jobLeaseMs = options.jobLeaseMs ?? 120_000;
  }

  public async stage(stream: Readable): Promise<StagedUpload> {
    await mkdir(this.#privateTempDir, { recursive: true });
    const stageId = randomBytes(16).toString("hex");
    const inputPath = resolve(this.#privateTempDir, `input-${stageId}.part`);
    let bytes = 0;
    const payloadHasher = createHash("sha256");
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        bytes += chunk.length;
        payloadHasher.update(chunk);
        if (bytes > this.#maxUploadBytes) {
          callback(new ValidationError("Image file is too large.", "IMAGE_TOO_LARGE"));
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, limiter, createWriteStream(inputPath, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      await removeFileIfPresent(inputPath);
      throw error;
    }
    if (bytes === 0) {
      await removeFileIfPresent(inputPath);
      throw new ValidationError("Upload an image.", "EMPTY_IMAGE");
    }
    return {
      inputPath,
      bytes,
      requestKey: sha256(`image-upload-v1\0${stageId}`),
      payloadHash: payloadHasher.digest("hex"),
      inputStorageKey: `private/${basename(inputPath)}`,
    };
  }

  public scopeHash(session: SessionData): string {
    return sha256(session.uploadScope);
  }

  public async complete(staged: StagedUpload, userId: number, session: SessionData): Promise<ImageUploadResult> {
    if (this.#imageJobs !== null) {
      return this.#completeDurable(staged, userId, session);
    }
    return this.#completeLegacy(staged, userId, session);
  }

  async #completeLegacy(staged: StagedUpload, userId: number, session: SessionData): Promise<ImageUploadResult> {
    const scopeHash = sha256(session.uploadScope);
    await this.#assertCapacity(userId, scopeHash);
    const basename = randomBytes(8).toString("hex");
    const relativePath = `uploads/${basename}.jpg`;
    const outputTempPath = resolve(this.#privateTempDir, `output-${basename}.jpg.part`);
    const finalPath = resolve(this.#publicUploadDir, `${basename}.jpg`);
    let published = false;
    try {
      const execution = await this.options.executor.execute({
        jobId: randomBytes(16).toString("hex"),
        attempt: 1,
        inputPath: staged.inputPath,
        outputTempPath,
        finalPath,
        maxPixels: this.#maxImagePixels,
        deferPublication: false,
      });
      published = true;
      await this.#assertCapacity(userId, scopeHash);
      const now = this.options.clock.now();
      const expiresAt = new Date(now.getTime() + this.#ownershipTtlSeconds * 1000);
      try {
        await this.options.uploads.registerReady({
          path: relativePath,
          userId,
          sessionScopeHash: scopeHash,
          createdAt: now,
          expiresAt,
        }, {
          readyPerSession: this.#readyPerSession,
          readyTotal: this.#readyTotal,
        });
      } catch (error) {
        if (hasErrorCode(error, "SESSION_UPLOAD_LIMIT")) {
          throw new AppError(
            "This upload tray is full. Create links with the ready images before adding more.",
            422,
            "SESSION_UPLOAD_LIMIT",
          );
        }
        if (hasErrorCode(error, "GLOBAL_UPLOAD_LIMIT")) {
          throw new AppError(
            "Image uploads are temporarily full. Existing links still work.",
            422,
            "GLOBAL_UPLOAD_LIMIT",
          );
        }
        if (hasErrorCode(error, "UPLOAD_CAPACITY_UNAVAILABLE")) {
          throw new AppError(
            "Image uploads are temporarily busy. Existing links still work.",
            503,
            "UPLOAD_CAPACITY_UNAVAILABLE",
          );
        }
        throw error;
      }
      return {
        path: relativePath,
        imageInfo: {
          ...execution,
          level: "good",
          message: "1200×630 px — suitable for a large social preview.",
          ratio: Number((1200 / 630).toFixed(3)),
        },
      };
    } catch (error) {
      if (published) {
        await removeFileIfPresent(finalPath);
      }
      await removeFileIfPresent(outputTempPath);
      throw error;
    } finally {
      await removeFileIfPresent(staged.inputPath);
    }
  }

  async #completeDurable(staged: StagedUpload, userId: number, session: SessionData): Promise<ImageUploadResult> {
    const imageJobs = this.#requiredImageJobs();
    const scopeHash = sha256(session.uploadScope);
    await this.#assertCapacity(userId, scopeHash);
    const now = this.options.clock.now();
    const jobId = randomBytes(16).toString("hex");
    const outputBasename = randomBytes(8).toString("hex");
    const durableInputPath = resolve(this.#privateTempDir, `job-${jobId}.input`);
    const outputStorageKey = `uploads/${outputBasename}.jpg`;
    const proposal: NewImageJob = {
      jobId,
      requestKey: staged.requestKey ?? sha256(`image-upload-v1\0${jobId}`),
      payloadHash: staged.payloadHash ?? sha256Bytes(await readFile(staged.inputPath)),
      domainId: this.#ledgerDomainId,
      userId,
      sessionScopeHash: scopeHash,
      ownershipExpiresAtMs: now.getTime() + this.#ownershipTtlSeconds * 1000,
      inputStorageKey: `private/${basename(durableInputPath)}`,
      outputStorageKey,
      maxAttempts: 3,
      maxCompensationAttempts: 5,
    };

    await mkdir(this.#privateTempDir, { recursive: true });
    await rename(staged.inputPath, durableInputPath);
    let decision;
    try {
      decision = await imageJobs.reserveImageJob(proposal, now.getTime());
    } catch (error) {
      await removeFileIfPresent(durableInputPath);
      throw error;
    }
    if (decision.kind === "reuse" && decision.job.jobId !== proposal.jobId) {
      await removeFileIfPresent(durableInputPath);
    }
    return this.#driveImageJob(decision.job);
  }

  async #driveImageJob(initial: ImageJobSnapshot): Promise<ImageUploadResult> {
    const imageJobs = this.#requiredImageJobs();
    let job = initial;
    if (job.state === "ready") {
      return this.#readyResult(job);
    }
    if (job.state === "requested") {
      const atMs = this.options.clock.now().getTime();
      job = await imageJobs.transitionImageJob(job.jobId, {
        type: "enqueue",
        expectedVersion: job.version,
        atMs,
        notBeforeMs: atMs,
      });
    }
    if (job.state !== "queued") {
      throw new AppError("Image processing is already in progress.", 503, "IMAGE_JOB_IN_PROGRESS", false);
    }

    const claimAtMs = this.options.clock.now().getTime();
    const leaseToken = randomBytes(16).toString("hex");
    job = await imageJobs.transitionImageJob(job.jobId, {
      type: "claim_processing",
      expectedVersion: job.version,
      atMs: claimAtMs,
      leaseOwner: `web-${process.pid}`,
      leaseToken,
      leaseExpiresAtMs: claimAtMs + this.#jobLeaseMs,
    });

    const paths = this.#pathsForJob(job);
    let execution: ImageExecutionResult | null = null;
    let finalPublished = false;
    try {
      execution = await this.options.executor.execute({
        jobId: job.jobId,
        attempt: job.attemptCount,
        inputPath: paths.inputPath,
        outputTempPath: paths.outputTempPath,
        finalPath: paths.finalPath,
        maxPixels: this.#maxImagePixels,
        deferPublication: true,
      });
      const outputAtMs = this.options.clock.now().getTime();
      job = await imageJobs.transitionImageJob(job.jobId, {
        type: "record_output_ready",
        expectedVersion: job.version,
        atMs: outputAtMs,
        leaseToken,
        sourceWidth: execution.sourceWidth,
        sourceHeight: execution.sourceHeight,
      });
      const publishAtMs = this.options.clock.now().getTime();
      job = await imageJobs.transitionImageJob(job.jobId, {
        type: "begin_publication",
        expectedVersion: job.version,
        atMs: publishAtMs,
        leaseToken,
      });
      await mkdir(dirname(paths.finalPath), { recursive: true });
      await chmod(paths.outputTempPath, 0o644);
      await rename(paths.outputTempPath, paths.finalPath);
      finalPublished = true;

      const readyAt = this.options.clock.now();
      try {
        job = await imageJobs.publishImageJobReady(job.jobId, {
          type: "mark_ready",
          expectedVersion: job.version,
          atMs: readyAt.getTime(),
          leaseToken,
          finalArtifactPublished: true,
          readyRegistrationCommitted: true,
        }, {
          path: job.outputStorageKey,
          userId: job.userId,
          sessionScopeHash: job.sessionScopeHash,
          createdAt: readyAt,
          expiresAt: new Date(job.ownershipExpiresAtMs),
        }, {
          readyPerSession: this.#readyPerSession,
          readyTotal: this.#readyTotal,
        });
      } catch (error) {
        const observed = await imageJobs.getImageJob(job.jobId).catch(() => null);
        if (observed?.state === "ready" && await isFile(paths.finalPath)) {
          job = observed;
        } else if (observed === null) {
          // Commit outcome is unknown. Keep the final artifact for bounded
          // reconciliation; deleting it could corrupt an already-committed row.
          throw error;
        } else {
          await this.#compensatePublishedJob(observed, error);
          throw mapUploadError(error);
        }
      }
      await removeFileIfPresent(paths.inputPath);
      return imageResult(job, execution);
    } catch (error) {
      const observed = await imageJobs.getImageJob(job.jobId).catch(() => null);
      if (observed?.state === "ready" && await isFile(paths.finalPath)) {
        await removeFileIfPresent(paths.inputPath);
        return imageResult(observed, execution);
      }
      if ((finalPublished || observed?.state === "publishing")
        && !hasErrorCode(error, "IMAGE_JOB_REFERENCED") && !hasErrorCode(error, "IMAGE_JOB_ATTACHED")) {
        if (observed !== null && observed.state !== "compensated") {
          await this.#compensatePublishedJob(observed, error).catch(() => undefined);
        }
      } else if (!isAmbiguousExecutionError(error) && observed !== null
        && (observed.state === "processing" || observed.state === "output_ready")) {
        await Promise.all([
          removeFileIfPresent(paths.outputTempPath),
          removeFileIfPresent(paths.inputPath),
        ]);
        if (observed.lease !== null) {
          await imageJobs.transitionImageJob(observed.jobId, {
            type: "record_failure",
            expectedVersion: observed.version,
            atMs: this.options.clock.now().getTime(),
            leaseToken: observed.lease.token,
            errorCode: safeErrorCode(error),
            publicationMayHaveOccurred: false,
            privateOutputRemoved: true,
            retryAtMs: null,
          }).catch(() => undefined);
        }
      }
      throw mapUploadError(error);
    }
  }

  async #readyResult(job: ImageJobSnapshot): Promise<ImageUploadResult> {
    const paths = this.#pathsForJob(job);
    if (!isImageJobAttachable(job)
      || !await this.#requiredImageJobs().hasReadyImageRegistration(job.jobId)
      || !await isFile(paths.finalPath)) {
      throw new AppError("A completed image is unavailable.", 503, "IMAGE_JOB_READY_MISSING", false);
    }
    return imageResult(job, null);
  }

  async #compensatePublishedJob(job: ImageJobSnapshot, reason: unknown): Promise<void> {
    const imageJobs = this.#requiredImageJobs();
    let current = job;
    const nowMs = this.options.clock.now().getTime();
    if (current.state !== "compensation_required" && current.state !== "compensating") {
      current = current.lease !== null && nowMs < current.lease.expiresAtMs
        && (current.state === "processing" || current.state === "output_ready" || current.state === "publishing")
        ? await imageJobs.transitionImageJob(current.jobId, {
          type: "record_failure",
          expectedVersion: current.version,
          atMs: nowMs,
          leaseToken: current.lease.token,
          errorCode: safeErrorCode(reason),
          publicationMayHaveOccurred: true,
          privateOutputRemoved: false,
          retryAtMs: nowMs,
        })
        : await imageJobs.transitionImageJob(current.jobId, {
          type: "require_compensation",
          expectedVersion: current.version,
          atMs: nowMs,
          errorCode: safeErrorCode(reason),
          retryAtMs: nowMs,
        });
    }
    if (current.state === "compensation_required") {
      const claimAtMs = this.options.clock.now().getTime();
      current = await imageJobs.transitionImageJob(current.jobId, {
        type: "claim_compensation",
        expectedVersion: current.version,
        atMs: claimAtMs,
        leaseOwner: `web-compensation-${process.pid}`,
        leaseToken: randomBytes(16).toString("hex"),
        leaseExpiresAtMs: claimAtMs + this.#jobLeaseMs,
      });
    }
    if (current.state !== "compensating" || current.lease === null) return;
    const paths = this.#pathsForJob(current);
    try {
      await imageJobs.assertImageJobCompensationSafe(current.jobId);
    } catch (error) {
      await imageJobs.transitionImageJob(current.jobId, {
        type: "record_compensation_failure",
        expectedVersion: current.version,
        atMs: this.options.clock.now().getTime(),
        leaseToken: current.lease.token,
        errorCode: safeErrorCode(error),
        retryAtMs: this.options.clock.now().getTime() + this.#jobLeaseMs,
      }).catch(() => undefined);
      throw error;
    }
    await Promise.all([
      removeFileIfPresent(paths.finalPath),
      removeFileIfPresent(paths.outputTempPath),
      removeFileIfPresent(paths.inputPath),
    ]);
    await imageJobs.completeImageJobCompensation(current.jobId, {
      type: "mark_compensated",
      expectedVersion: current.version,
      atMs: this.options.clock.now().getTime(),
      leaseToken: current.lease.token,
      finalArtifactAbsent: true,
      readyRegistrationAbsent: true,
    });
  }

  #pathsForJob(job: ImageJobSnapshot): {
    readonly inputPath: string;
    readonly outputTempPath: string;
    readonly finalPath: string;
  } {
    return {
      inputPath: resolveStorageKey(this.#privateTempDir, job.inputStorageKey, "private/"),
      outputTempPath: resolve(this.#privateTempDir, `output-${job.jobId}.jpg.part`),
      finalPath: resolveStorageKey(this.#publicUploadDir, job.outputStorageKey, "uploads/"),
    };
  }

  #requiredImageJobs(): ImageJobStore {
    if (this.#imageJobs === null) throw new Error("Durable image job store is unavailable.");
    return this.#imageJobs;
  }

  public async discard(staged: StagedUpload | null): Promise<void> {
    if (staged !== null) {
      await removeFileIfPresent(staged.inputPath);
    }
  }

  /**
   * Read-only startup proof that the durable ledger can be queried. Processing
   * is intentionally deferred until after listen so PM2 web startup never
   * depends on the separately managed BullMQ worker becoming ready first.
   */
  public async probeRecoveryBacklog(limit = 1): Promise<{ readonly dueJobsObserved: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Invalid image-job recovery probe bound.");
    }
    if (this.#imageJobs === null) return { dueJobsObserved: 0 };
    const jobs = await this.#imageJobs.listImageJobsForRecovery(this.options.clock.now().getTime(), limit);
    return { dueJobsObserved: jobs.length };
  }

  public async reconcileOnStartup(limit = 10, maxBatches = 10): Promise<{
    readonly inspected: number;
    readonly recovered: number;
    readonly manualReview: number;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 100) {
      throw new RangeError("Invalid image-job reconciliation bound.");
    }
    if (this.#imageJobs === null) return { inspected: 0, recovered: 0, manualReview: 0 };
    let inspected = 0;
    let recovered = 0;
    let manualReview = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const nowMs = this.options.clock.now().getTime();
      const jobs = await this.#imageJobs.listImageJobsForRecovery(nowMs, limit);
      if (jobs.length === 0) break;
      inspected += jobs.length;
      for (const initial of jobs) {
      const paths = this.#pathsForJob(initial);
      const evidence = {
        finalArtifact: await observeFile(paths.finalPath),
        privateArtifact: mergeArtifactObservations(
          await observeFile(paths.inputPath),
          await observeFile(paths.outputTempPath),
        ),
        readyRegistration: await this.#imageJobs.hasReadyImageRegistration(initial.jobId)
          .then((value) => value ? "present" as const : "absent" as const)
          .catch(() => "unknown" as const),
      };
      const decision = planImageJobRestart(initial, evidence, nowMs);
      let job = initial;
      try {
        switch (decision.action) {
        case "none":
        case "wait_until_due":
        case "wait_for_lease":
          continue;
        case "enqueue":
          job = await this.#imageJobs.transitionImageJob(job.jobId, {
            type: "enqueue",
            expectedVersion: job.version,
            atMs: nowMs,
            notBeforeMs: nowMs,
          });
          await this.#driveImageJob(job);
          recovered += 1;
          break;
        case "claim_processing":
          await this.#driveImageJob(job);
          recovered += 1;
          break;
        case "recover_ready":
          job = await this.#imageJobs.transitionImageJob(job.jobId, {
            type: "recover_ready",
            expectedVersion: job.version,
            atMs: nowMs,
            finalArtifactPublished: true,
            readyRegistrationCommitted: true,
          });
          if (!isImageJobAttachable(job)) throw new Error("Recovered image job is not attachable.");
          recovered += 1;
          break;
        case "clean_private_then_recover_retry":
          await removeFileIfPresent(paths.outputTempPath);
          job = await this.#imageJobs.transitionImageJob(job.jobId, {
            type: "recover_retry",
            expectedVersion: job.version,
            atMs: nowMs,
            finalArtifactAbsent: true,
            readyRegistrationAbsent: true,
            privateOutputRemoved: true,
            retryAtMs: nowMs,
            errorCode: "WORKER_RESTARTED",
          });
          if (job.state === "queued") await this.#driveImageJob(job);
          else await removeFileIfPresent(paths.inputPath);
          recovered += 1;
          break;
        case "require_compensation":
        case "claim_compensation":
          await this.#compensatePublishedJob(job, new Error("IMAGE_RESTART_RECONCILIATION"));
          recovered += 1;
          break;
        case "recover_compensated":
          await this.#imageJobs.assertImageJobCompensationSafe(job.jobId);
          await Promise.all([
            removeFileIfPresent(paths.finalPath),
            removeFileIfPresent(paths.outputTempPath),
            removeFileIfPresent(paths.inputPath),
          ]);
          await this.#imageJobs.completeImageJobCompensation(job.jobId, {
            type: "recover_compensated",
            expectedVersion: job.version,
            atMs: nowMs,
            finalArtifactAbsent: true,
            readyRegistrationAbsent: true,
          });
          recovered += 1;
          break;
        case "clean_private":
          await Promise.all([removeFileIfPresent(paths.outputTempPath), removeFileIfPresent(paths.inputPath)]);
          recovered += 1;
          break;
        case "manual_review":
          if (job.state !== "ready" && job.state !== "compensated" && job.state !== "manual_review") {
            await this.#imageJobs.transitionImageJob(job.jobId, {
              type: "mark_manual_review",
              expectedVersion: job.version,
              atMs: nowMs,
              errorCode: "RECOVERY_EVIDENCE_UNKNOWN",
            });
          }
          manualReview += 1;
          break;
        }
      } catch (error) {
        if (hasErrorCode(error, "STALE_VERSION") || hasErrorCode(error, "IMAGE_JOB_STALE_VERSION")) {
          continue;
        }
        if (hasErrorCode(error, "IMAGE_JOB_REFERENCED") || hasErrorCode(error, "IMAGE_JOB_ATTACHED")) {
          // A reference is not a transient compensation failure. Move the row
          // out of the due queue so it cannot permanently starve later jobs.
          const observed = await this.#imageJobs.getImageJob(job.jobId).catch(() => null);
          if (observed !== null && observed.state !== "ready" && observed.state !== "compensated"
            && observed.state !== "manual_review" && observed.lease === null) {
            await this.#imageJobs.transitionImageJob(observed.jobId, {
              type: "mark_manual_review",
              expectedVersion: observed.version,
              atMs: this.options.clock.now().getTime(),
              errorCode: safeErrorCode(error),
            }).catch((transitionError: unknown) => {
              if (!hasErrorCode(transitionError, "STALE_VERSION")
                && !hasErrorCode(transitionError, "IMAGE_JOB_STALE_VERSION")) throw transitionError;
            });
          }
          manualReview += 1;
          continue;
        }
        throw error;
      }
      }
      if (jobs.length < limit) break;
    }
    return { inspected, recovered, manualReview };
  }

  public async verifyOwnedPaths(userId: number, session: SessionData, paths: readonly string[]): Promise<readonly string[]> {
    if (paths.length > this.#maxOwnedPaths) {
      throw new ValidationError(
        `Too many images in one batch (max ${this.#maxOwnedPaths}).`,
        "TOO_MANY_IMAGES",
      );
    }
    for (const path of paths) {
      if (!isManagedImagePath(path)) {
        throw new AppError(
          "One or more uploaded images are unavailable. Re-upload them.",
          422,
          "UPLOAD_UNAVAILABLE",
        );
      }
    }
    try {
      const verified = await this.options.uploads.verifyOwnedPaths(
        userId,
        sha256(session.uploadScope),
        paths,
        this.options.clock.now(),
      );
      for (const path of verified) {
        const file = await stat(resolve(this.#publicUploadDir, path.slice("uploads/".length)));
        if (!file.isFile()) {
          throw new Error("Upload is not a file.");
        }
      }
      return verified;
    } catch {
      throw new AppError(
        "One or more uploaded images are unavailable. Re-upload them.",
        422,
        "UPLOAD_UNAVAILABLE",
      );
    }
  }

  public async markAttached(userId: number, session: SessionData, paths: readonly string[]): Promise<void> {
    const now = this.options.clock.now();
    await this.options.uploads.markAttached(
      userId,
      sha256(session.uploadScope),
      paths,
      now,
      new Date(now.getTime() + this.#ownershipTtlSeconds * 1000),
    );
  }

  public async authorizeReference(userId: number, session: SessionData, rawValue: string): Promise<string> {
    const value = rawValue.trim();
    if (value.length === 0 || value.length > 512) {
      throw new AppError("Invalid image URL", 422, "INVALID_IMAGE_URL");
    }
    if (value.startsWith("uploads/")) {
      return (await this.verifyOwnedPaths(userId, session, [value]))[0] ?? "";
    }

    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new AppError("Invalid image URL", 422, "INVALID_IMAGE_URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new AppError("Invalid image URL", 422, "INVALID_IMAGE_URL");
    }
    if (this.#ownedImageHosts.has(parsed.hostname.toLowerCase())) {
      if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.port.length > 0
        || parsed.search.length > 0 || parsed.hash.length > 0
        || !isManagedImageRequestPath(parsed.pathname)) {
        throw new AppError(
          "One or more uploaded images are unavailable. Re-upload them.",
          422,
          "UPLOAD_UNAVAILABLE",
        );
      }
      const path = parsed.pathname.slice(1);
      return (await this.verifyOwnedPaths(userId, session, [path]))[0] ?? "";
    }
    return value;
  }

  async #assertCapacity(userId: number, scopeHash: string): Promise<void> {
    if (await this.options.uploads.countReadyForScope(userId, scopeHash) >= this.#readyPerSession) {
      throw new AppError(
        "This upload tray is full. Create links with the ready images before adding more.",
        422,
        "SESSION_UPLOAD_LIMIT",
      );
    }
    if (await this.options.uploads.countReadyTotal() >= this.#readyTotal) {
      throw new AppError(
        "Image uploads are temporarily full. Existing links still work.",
        422,
        "GLOBAL_UPLOAD_LIMIT",
      );
    }
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === code;
}

function mapUploadError(error: unknown): unknown {
  if (hasErrorCode(error, "SESSION_UPLOAD_LIMIT")) {
    return new AppError(
      "This upload tray is full. Create links with the ready images before adding more.",
      422,
      "SESSION_UPLOAD_LIMIT",
    );
  }
  if (hasErrorCode(error, "GLOBAL_UPLOAD_LIMIT")) {
    return new AppError(
      "Image uploads are temporarily full. Existing links still work.",
      422,
      "GLOBAL_UPLOAD_LIMIT",
    );
  }
  if (hasErrorCode(error, "UPLOAD_CAPACITY_UNAVAILABLE")) {
    return new AppError(
      "Image uploads are temporarily busy. Existing links still work.",
      503,
      "UPLOAD_CAPACITY_UNAVAILABLE",
    );
  }
  return error;
}

function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  }
  return "IMAGE_JOB_FAILED";
}

function isAmbiguousExecutionError(error: unknown): boolean {
  return hasErrorCode(error, "IMAGE_JOB_TIMEOUT") || hasErrorCode(error, "IMAGE_QUEUE_UNAVAILABLE");
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function observeFile(path: string): Promise<"present" | "absent" | "unknown"> {
  try {
    return (await stat(path)).isFile() ? "present" : "unknown";
  } catch (error) {
    return hasErrorCode(error, "ENOENT") ? "absent" : "unknown";
  }
}

function mergeArtifactObservations(
  left: "present" | "absent" | "unknown",
  right: "present" | "absent" | "unknown",
): "present" | "absent" | "unknown" {
  if (left === "present" || right === "present") return "present";
  if (left === "unknown" || right === "unknown") return "unknown";
  return "absent";
}

function resolveStorageKey(root: string, key: string, prefix: string): string {
  if (!key.startsWith(prefix)) throw new Error("Image storage key has the wrong namespace.");
  const relativeKey = key.slice(prefix.length);
  if (relativeKey.length === 0 || relativeKey.includes("\\") || relativeKey.startsWith("/")
    || relativeKey.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Image storage key is invalid.");
  }
  const candidate = resolve(root, relativeKey);
  const relation = relative(resolve(root), candidate);
  if (relation.length === 0 || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("Image storage key escapes its configured root.");
  }
  return candidate;
}

function imageResult(job: ImageJobSnapshot, execution: ImageExecutionResult | null): ImageUploadResult {
  if (!isImageJobAttachable(job) || job.resultSourceWidth === null || job.resultSourceHeight === null) {
    throw new Error("Image job is not ready for a public response.");
  }
  return {
    path: job.outputStorageKey,
    imageInfo: {
      width: 1200,
      height: 630,
      format: "jpeg",
      sourceWidth: execution?.sourceWidth ?? job.resultSourceWidth,
      sourceHeight: execution?.sourceHeight ?? job.resultSourceHeight,
      level: "good",
      message: "1200×630 px — suitable for a large social preview.",
      ratio: Number((1200 / 630).toFixed(3)),
    },
  };
}
