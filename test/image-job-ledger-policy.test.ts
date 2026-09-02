import { describe, expect, it } from "vitest";
import {
  createImageJob,
  decideImageJobCreation,
  ImageJobPolicyError,
  imageJobStates,
  isImageJobAttachable,
  planImageJobRestart,
  transitionImageJob,
  type ImageJobCommand,
  type ImageJobSnapshot,
  type NewImageJob,
} from "../src/modules/uploads/job-ledger-policy.js";

const t0 = 1_788_249_600_000;
const workerToken = "b".repeat(32);

describe("image job ledger policy", () => {
  it("reuses an exact request and rejects request-key or job-id conflicts", () => {
    const first = createImageJob(newJob(), t0);
    expect(decideImageJobCreation(
      { ...newJob(), jobId: "2".repeat(32), inputStorageKey: "private/retry.part" },
      { byRequestKey: first, byJobId: null },
      t0 + 1,
    )).toEqual({ kind: "reuse", job: first });

    expectPolicyError(() => decideImageJobCreation(
      { ...newJob(), payloadHash: "c".repeat(64) },
      { byRequestKey: first, byJobId: first },
      t0 + 1,
    ), "REQUEST_KEY_CONFLICT");

    expectPolicyError(() => decideImageJobCreation(
      { ...newJob(), requestKey: "d".repeat(64) },
      { byRequestKey: null, byJobId: first },
      t0 + 1,
    ), "JOB_ID_CONFLICT");
  });

  it("allows link attachment only after publication and ready registration are proved", () => {
    let job = createImageJob(newJob(), t0);
    expect(isImageJobAttachable(job)).toBe(false);
    job = apply(job, { type: "enqueue", atMs: t0 + 1, notBeforeMs: t0 + 1 });
    job = apply(job, claim(t0 + 2));
    job = apply(job, {
      type: "record_output_ready",
      atMs: t0 + 3,
      leaseToken: workerToken,
      sourceWidth: 10,
      sourceHeight: 20,
    });
    job = apply(job, { type: "begin_publication", atMs: t0 + 4, leaseToken: workerToken });
    expect(isImageJobAttachable(job)).toBe(false);

    expectPolicyError(() => apply(job, {
      type: "mark_ready",
      atMs: t0 + 5,
      leaseToken: workerToken,
      finalArtifactPublished: true,
      readyRegistrationCommitted: false,
    }), "PROOF_REQUIRED");

    job = apply(job, {
      type: "mark_ready",
      atMs: t0 + 5,
      leaseToken: workerToken,
      finalArtifactPublished: true,
      readyRegistrationCommitted: true,
    });
    expect(job.state).toBe("ready");
    expect(isImageJobAttachable(job)).toBe(true);
  });

  it("rejects illegal state jumps, stale versions and expired worker completions", () => {
    const requested = createImageJob(newJob(), t0);
    expectPolicyError(() => transitionImageJob(requested, {
      type: "begin_publication",
      expectedVersion: requested.version,
      atMs: t0 + 1,
      leaseToken: workerToken,
    }), "ILLEGAL_TRANSITION");

    const queued = apply(requested, { type: "enqueue", atMs: t0 + 1, notBeforeMs: t0 + 1 });
    expectPolicyError(() => transitionImageJob(queued, {
      ...claim(t0 + 2),
      expectedVersion: 0,
    }), "STALE_VERSION");

    const processing = apply(queued, claim(t0 + 2, t0 + 10));
    expectPolicyError(() => apply(processing, {
      type: "record_output_ready",
      atMs: t0 + 10,
      leaseToken: workerToken,
      sourceWidth: 10,
      sourceHeight: 20,
    }), "STALE_LEASE");
  });

  it("routes an ambiguous publication to compensation instead of retry", () => {
    let job = processingJob();
    job = apply(job, {
      type: "record_output_ready",
      atMs: t0 + 3,
      leaseToken: workerToken,
      sourceWidth: 10,
      sourceHeight: 20,
    });
    job = apply(job, { type: "begin_publication", atMs: t0 + 4, leaseToken: workerToken });
    job = apply(job, {
      type: "record_failure",
      atMs: t0 + 5,
      leaseToken: workerToken,
      errorCode: "PUBLISH_REPLY_LOST",
      publicationMayHaveOccurred: false,
      privateOutputRemoved: false,
      retryAtMs: t0 + 100,
    });

    expect(job).toMatchObject({
      state: "compensation_required",
      publicationState: "unknown",
      compensationState: "required",
      lease: null,
    });
    expect(isImageJobAttachable(job)).toBe(false);
  });

  it("recovers an expired publishing lease only with matching durable evidence", () => {
    const publishing = publishingJob(t0 + 10);
    expect(planImageJobRestart(publishing, {
      finalArtifact: "present",
      privateArtifact: "absent",
      readyRegistration: "present",
    }, t0 + 10)).toMatchObject({ action: "recover_ready" });

    const recovered = apply(publishing, {
      type: "recover_ready",
      atMs: t0 + 10,
      finalArtifactPublished: true,
      readyRegistrationCommitted: true,
    });
    expect(isImageJobAttachable(recovered)).toBe(true);

    expect(planImageJobRestart(publishing, {
      finalArtifact: "present",
      privateArtifact: "unknown",
      readyRegistration: "absent",
    }, t0 + 10)).toMatchObject({ action: "require_compensation" });
  });

  it("retries only after an expired job is proved non-public and private files are cleaned", () => {
    const processing = processingJob(t0 + 10);
    expect(planImageJobRestart(processing, {
      finalArtifact: "absent",
      privateArtifact: "present",
      readyRegistration: "absent",
    }, t0 + 10)).toMatchObject({ action: "clean_private_then_recover_retry" });

    expectPolicyError(() => apply(processing, {
      type: "recover_retry",
      atMs: t0 + 10,
      finalArtifactAbsent: true,
      readyRegistrationAbsent: true,
      privateOutputRemoved: false,
      retryAtMs: t0 + 20,
      errorCode: "WORKER_RESTARTED",
    }), "PROOF_REQUIRED");

    const queued = apply(processing, {
      type: "recover_retry",
      atMs: t0 + 10,
      finalArtifactAbsent: true,
      readyRegistrationAbsent: true,
      privateOutputRemoved: true,
      retryAtMs: t0 + 20,
      errorCode: "WORKER_RESTARTED",
    });
    expect(queued).toMatchObject({ state: "queued", attemptCount: 1, nextAttemptAtMs: t0 + 20 });
  });

  it("uses leased, bounded compensation and verifies absence before completion", () => {
    let job = processingJob(t0 + 10);
    job = apply(job, {
      type: "require_compensation",
      atMs: t0 + 10,
      errorCode: "AMBIGUOUS_PUBLICATION",
      retryAtMs: t0 + 10,
    });
    job = apply(job, {
      type: "claim_compensation",
      atMs: t0 + 11,
      leaseOwner: "cleanup-1",
      leaseToken: "e".repeat(32),
      leaseExpiresAtMs: t0 + 20,
    });
    expectPolicyError(() => apply(job, {
      type: "mark_compensated",
      atMs: t0 + 12,
      leaseToken: "e".repeat(32),
      finalArtifactAbsent: true,
      readyRegistrationAbsent: false,
    }), "PROOF_REQUIRED");

    job = apply(job, {
      type: "mark_compensated",
      atMs: t0 + 12,
      leaseToken: "e".repeat(32),
      finalArtifactAbsent: true,
      readyRegistrationAbsent: true,
    });
    expect(job).toMatchObject({
      state: "compensated",
      publicationState: "removed",
      compensationState: "complete",
    });
  });

  it("defines a restart action for every finite state and never attaches a non-ready state", () => {
    const jobs = buildEveryState();
    expect(jobs.map((job) => job.state)).toEqual(imageJobStates);
    for (const job of jobs) {
      expect(() => planImageJobRestart(job, {
        finalArtifact: job.state === "ready" ? "present" : "absent",
        privateArtifact: "absent",
        readyRegistration: job.state === "ready" ? "present" : "absent",
      }, Math.max(t0 + 100, job.updatedAtMs))).not.toThrow();
      expect(isImageJobAttachable(job)).toBe(job.state === "ready");
    }
  });

  it("rejects absolute or traversal storage paths", () => {
    for (const inputStorageKey of ["/tmp/input.part", "C:/private/input.part", "private/../input.part"]) {
      expectPolicyError(() => createImageJob({ ...newJob(), inputStorageKey }, t0), "INVALID_JOB");
    }
  });
});

function newJob(): NewImageJob {
  return {
    jobId: "1".repeat(32),
    requestKey: "a".repeat(64),
    payloadHash: "b".repeat(64),
    domainId: 2,
    userId: 42,
    sessionScopeHash: "f".repeat(64),
    ownershipExpiresAtMs: t0 + 86_400_000,
    inputStorageKey: "private/image-jobs/input-1.part",
    outputStorageKey: "uploads/output-1.jpg",
    maxAttempts: 3,
    maxCompensationAttempts: 3,
  };
}

function apply(
  job: ImageJobSnapshot,
  command: UnversionedImageJobCommand,
): ImageJobSnapshot {
  return transitionImageJob(job, { ...command, expectedVersion: job.version });
}

function claim(atMs: number, leaseExpiresAtMs = t0 + 50): UnversionedImageJobCommand {
  return {
    type: "claim_processing",
    atMs,
    leaseOwner: "worker-1",
    leaseToken: workerToken,
    leaseExpiresAtMs,
  };
}

function processingJob(expiry = t0 + 50): ImageJobSnapshot {
  let job = createImageJob(newJob(), t0);
  job = apply(job, { type: "enqueue", atMs: t0 + 1, notBeforeMs: t0 + 1 });
  return apply(job, claim(t0 + 2, expiry));
}

function publishingJob(expiry = t0 + 50): ImageJobSnapshot {
  let job = processingJob(expiry);
  job = apply(job, {
    type: "record_output_ready",
    atMs: t0 + 3,
    leaseToken: workerToken,
    sourceWidth: 10,
    sourceHeight: 20,
  });
  return apply(job, { type: "begin_publication", atMs: t0 + 4, leaseToken: workerToken });
}

function buildEveryState(): readonly ImageJobSnapshot[] {
  const requested = createImageJob(newJob(), t0);
  const queued = apply(requested, { type: "enqueue", atMs: t0 + 1, notBeforeMs: t0 + 1 });
  const processing = apply(queued, claim(t0 + 2, t0 + 10));
  const outputReady = apply(processing, {
    type: "record_output_ready",
    atMs: t0 + 3,
    leaseToken: workerToken,
    sourceWidth: 10,
    sourceHeight: 20,
  });
  const publishing = apply(outputReady, {
    type: "begin_publication",
    atMs: t0 + 4,
    leaseToken: workerToken,
  });
  const ready = apply(publishing, {
    type: "mark_ready",
    atMs: t0 + 5,
    leaseToken: workerToken,
    finalArtifactPublished: true,
    readyRegistrationCommitted: true,
  });
  const failed = apply(processing, {
    type: "record_failure",
    atMs: t0 + 3,
    leaseToken: workerToken,
    errorCode: "DECODE_FAILED",
    publicationMayHaveOccurred: false,
    privateOutputRemoved: true,
    retryAtMs: null,
  });
  const compensationRequired = apply(processing, {
    type: "require_compensation",
    atMs: t0 + 10,
    errorCode: "AMBIGUOUS_PUBLICATION",
    retryAtMs: t0 + 10,
  });
  const compensating = apply(compensationRequired, {
    type: "claim_compensation",
    atMs: t0 + 11,
    leaseOwner: "cleanup-1",
    leaseToken: "e".repeat(32),
    leaseExpiresAtMs: t0 + 20,
  });
  const compensated = apply(compensating, {
    type: "mark_compensated",
    atMs: t0 + 12,
    leaseToken: "e".repeat(32),
    finalArtifactAbsent: true,
    readyRegistrationAbsent: true,
  });
  const manualReview = apply(compensationRequired, {
    type: "mark_manual_review",
    atMs: t0 + 11,
    errorCode: "RECOVERY_EVIDENCE_UNKNOWN",
  });
  return [
    requested,
    queued,
    processing,
    outputReady,
    publishing,
    ready,
    failed,
    compensationRequired,
    compensating,
    compensated,
    manualReview,
  ];
}

type UnversionedImageJobCommand = ImageJobCommand extends infer Command
  ? Command extends ImageJobCommand
    ? Omit<Command, "expectedVersion">
    : never
  : never;

function expectPolicyError(operation: () => unknown, expectedCode: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(ImageJobPolicyError);
    expect((error as ImageJobPolicyError).code).toBe(expectedCode);
    return;
  }
  throw new Error(`Expected policy error ${expectedCode}, but nothing was thrown.`);
}
