export const imageJobStates = [
  "requested",
  "queued",
  "processing",
  "output_ready",
  "publishing",
  "ready",
  "failed",
  "compensation_required",
  "compensating",
  "compensated",
  "manual_review",
] as const;

export type ImageJobState = (typeof imageJobStates)[number];
export type ImagePublicationState = "private" | "publishing" | "published" | "unknown" | "removed";
export type ImageCompensationState = "not_required" | "required" | "in_progress" | "complete";

export interface ImageJobLease {
  readonly owner: string;
  readonly token: string;
  readonly acquiredAtMs: number;
  readonly expiresAtMs: number;
}

export interface ImageJobSnapshot {
  readonly jobId: string;
  readonly requestKey: string;
  readonly payloadHash: string;
  readonly domainId: number;
  readonly userId: number;
  readonly sessionScopeHash: string;
  readonly ownershipExpiresAtMs: number;
  readonly inputStorageKey: string;
  readonly outputStorageKey: string;
  readonly state: ImageJobState;
  readonly publicationState: ImagePublicationState;
  readonly compensationState: ImageCompensationState;
  readonly version: number;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly compensationAttemptCount: number;
  readonly maxCompensationAttempts: number;
  readonly nextAttemptAtMs: number | null;
  readonly firstAttemptAtMs: number | null;
  readonly lastAttemptAtMs: number | null;
  readonly lastCompensationAttemptAtMs: number | null;
  readonly lease: ImageJobLease | null;
  readonly outputReadyAtMs: number | null;
  readonly resultSourceWidth: number | null;
  readonly resultSourceHeight: number | null;
  readonly publishedAtMs: number | null;
  readonly readyAtMs: number | null;
  readonly failedAtMs: number | null;
  readonly compensationRequestedAtMs: number | null;
  readonly compensatedAtMs: number | null;
  readonly lastErrorCode: string | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface NewImageJob {
  readonly jobId: string;
  readonly requestKey: string;
  readonly payloadHash: string;
  readonly domainId: number;
  readonly userId: number;
  readonly sessionScopeHash: string;
  readonly ownershipExpiresAtMs: number;
  readonly inputStorageKey: string;
  readonly outputStorageKey: string;
  readonly maxAttempts: number;
  readonly maxCompensationAttempts: number;
}

export type ImageJobCreationDecision =
  | { readonly kind: "create"; readonly job: ImageJobSnapshot }
  | { readonly kind: "reuse"; readonly job: ImageJobSnapshot };

export interface ImageJobLookupMatches {
  readonly byRequestKey: ImageJobSnapshot | null;
  readonly byJobId: ImageJobSnapshot | null;
}

interface VersionedCommand {
  readonly expectedVersion: number;
  readonly atMs: number;
}

export type ImageJobCommand =
  | (VersionedCommand & {
    readonly type: "enqueue";
    readonly notBeforeMs: number;
  })
  | (VersionedCommand & {
    readonly type: "claim_processing";
    readonly leaseOwner: string;
    readonly leaseToken: string;
    readonly leaseExpiresAtMs: number;
  })
  | (VersionedCommand & {
    readonly type: "record_output_ready";
    readonly leaseToken: string;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
  })
  | (VersionedCommand & {
    readonly type: "begin_publication";
    readonly leaseToken: string;
  })
  | (VersionedCommand & {
    readonly type: "mark_ready";
    readonly leaseToken: string;
    readonly finalArtifactPublished: boolean;
    readonly readyRegistrationCommitted: boolean;
  })
  | (VersionedCommand & {
    readonly type: "record_failure";
    readonly leaseToken: string;
    readonly errorCode: string;
    readonly publicationMayHaveOccurred: boolean;
    readonly privateOutputRemoved: boolean;
    readonly retryAtMs: number | null;
  })
  | (VersionedCommand & {
    readonly type: "recover_ready";
    readonly finalArtifactPublished: boolean;
    readonly readyRegistrationCommitted: boolean;
  })
  | (VersionedCommand & {
    readonly type: "recover_retry";
    readonly finalArtifactAbsent: boolean;
    readonly readyRegistrationAbsent: boolean;
    readonly privateOutputRemoved: boolean;
    readonly retryAtMs: number;
    readonly errorCode: string;
  })
  | (VersionedCommand & {
    readonly type: "require_compensation";
    readonly errorCode: string;
    readonly retryAtMs: number;
  })
  | (VersionedCommand & {
    readonly type: "claim_compensation";
    readonly leaseOwner: string;
    readonly leaseToken: string;
    readonly leaseExpiresAtMs: number;
  })
  | (VersionedCommand & {
    readonly type: "mark_compensated";
    readonly leaseToken: string;
    readonly finalArtifactAbsent: boolean;
    readonly readyRegistrationAbsent: boolean;
  })
  | (VersionedCommand & {
    readonly type: "recover_compensated";
    readonly finalArtifactAbsent: boolean;
    readonly readyRegistrationAbsent: boolean;
  })
  | (VersionedCommand & {
    readonly type: "record_compensation_failure";
    readonly leaseToken: string;
    readonly errorCode: string;
    readonly retryAtMs: number;
  })
  | (VersionedCommand & {
    readonly type: "mark_manual_review";
    readonly errorCode: string;
  });

export type ArtifactObservation = "present" | "absent" | "unknown";

export interface ImageJobRestartEvidence {
  readonly finalArtifact: ArtifactObservation;
  readonly privateArtifact: ArtifactObservation;
  readonly readyRegistration: ArtifactObservation;
}

export type ImageJobRestartAction =
  | "none"
  | "enqueue"
  | "wait_until_due"
  | "claim_processing"
  | "wait_for_lease"
  | "recover_ready"
  | "clean_private_then_recover_retry"
  | "require_compensation"
  | "claim_compensation"
  | "recover_compensated"
  | "clean_private"
  | "manual_review";

export interface ImageJobRestartDecision {
  readonly action: ImageJobRestartAction;
  readonly reason: string;
}

export type ImageJobPolicyErrorCode =
  | "INVALID_JOB"
  | "REQUEST_KEY_CONFLICT"
  | "JOB_ID_CONFLICT"
  | "IDENTITY_SPLIT_BRAIN"
  | "ILLEGAL_TRANSITION"
  | "STALE_VERSION"
  | "STALE_TIMESTAMP"
  | "STALE_LEASE"
  | "LIVE_LEASE"
  | "NOT_DUE"
  | "ATTEMPTS_EXHAUSTED"
  | "PROOF_REQUIRED";

export class ImageJobPolicyError extends Error {
  public constructor(
    public readonly code: ImageJobPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImageJobPolicyError";
  }
}

const stateShape: Record<
  ImageJobState,
  readonly [ImagePublicationState, ImageCompensationState, "lease" | "no_lease"]
> = {
  requested: ["private", "not_required", "no_lease"],
  queued: ["private", "not_required", "no_lease"],
  processing: ["private", "not_required", "lease"],
  output_ready: ["private", "not_required", "lease"],
  publishing: ["publishing", "not_required", "lease"],
  ready: ["published", "not_required", "no_lease"],
  failed: ["private", "not_required", "no_lease"],
  compensation_required: ["unknown", "required", "no_lease"],
  compensating: ["unknown", "in_progress", "lease"],
  compensated: ["removed", "complete", "no_lease"],
  manual_review: ["unknown", "required", "no_lease"],
};

export function decideImageJobCreation(
  proposal: NewImageJob,
  matches: ImageJobLookupMatches,
  atMs: number,
): ImageJobCreationDecision {
  validateNewJob(proposal, atMs);
  if (
    matches.byRequestKey !== null
    && matches.byJobId !== null
    && matches.byRequestKey.jobId !== matches.byJobId.jobId
  ) {
    fail("IDENTITY_SPLIT_BRAIN", "Request key and job id resolve to different ledger rows.");
  }

  if (matches.byRequestKey !== null) {
    assertImageJobInvariant(matches.byRequestKey);
    assertSameRequest(matches.byRequestKey, proposal);
    return { kind: "reuse", job: matches.byRequestKey };
  }
  if (matches.byJobId !== null) {
    assertImageJobInvariant(matches.byJobId);
    if (matches.byJobId.requestKey !== proposal.requestKey) {
      fail("JOB_ID_CONFLICT", "Job id is already bound to another request key.");
    }
    assertSameRequest(matches.byJobId, proposal);
    return { kind: "reuse", job: matches.byJobId };
  }
  return { kind: "create", job: createImageJob(proposal, atMs) };
}

export function createImageJob(input: NewImageJob, atMs: number): ImageJobSnapshot {
  validateNewJob(input, atMs);
  const job: ImageJobSnapshot = {
    ...input,
    state: "requested",
    publicationState: "private",
    compensationState: "not_required",
    version: 0,
    attemptCount: 0,
    compensationAttemptCount: 0,
    nextAttemptAtMs: null,
    firstAttemptAtMs: null,
    lastAttemptAtMs: null,
    lastCompensationAttemptAtMs: null,
    lease: null,
    outputReadyAtMs: null,
    resultSourceWidth: null,
    resultSourceHeight: null,
    publishedAtMs: null,
    readyAtMs: null,
    failedAtMs: null,
    compensationRequestedAtMs: null,
    compensatedAtMs: null,
    lastErrorCode: null,
    createdAtMs: atMs,
    updatedAtMs: atMs,
  };
  assertImageJobInvariant(job);
  return job;
}

export function transitionImageJob(job: ImageJobSnapshot, command: ImageJobCommand): ImageJobSnapshot {
  assertImageJobInvariant(job);
  assertCommandFresh(job, command);
  let result: ImageJobSnapshot;

  switch (command.type) {
    case "enqueue":
      requireState(job, "requested");
      assertAtOrAfter(command.notBeforeMs, command.atMs, "Queue time cannot precede the transition.");
      result = advance(job, command, { state: "queued", nextAttemptAtMs: command.notBeforeMs });
      break;
    case "claim_processing":
      requireState(job, "queued");
      assertDue(job, command.atMs);
      if (job.attemptCount >= job.maxAttempts) {
        fail("ATTEMPTS_EXHAUSTED", "Processing attempts are exhausted.");
      }
      result = advance(job, command, {
        state: "processing",
        attemptCount: job.attemptCount + 1,
        firstAttemptAtMs: job.firstAttemptAtMs ?? command.atMs,
        lastAttemptAtMs: command.atMs,
        nextAttemptAtMs: null,
        lease: makeLease(command),
      });
      break;
    case "record_output_ready":
      requireState(job, "processing");
      assertCurrentLease(job, command.leaseToken, command.atMs);
      if (!isPositiveInteger(command.sourceWidth) || !isPositiveInteger(command.sourceHeight)
        || command.sourceWidth > 100_000 || command.sourceHeight > 100_000) {
        fail("PROOF_REQUIRED", "Processed image dimensions are required.");
      }
      result = advance(job, command, {
        state: "output_ready",
        outputReadyAtMs: command.atMs,
        resultSourceWidth: command.sourceWidth,
        resultSourceHeight: command.sourceHeight,
      });
      break;
    case "begin_publication":
      requireState(job, "output_ready");
      assertCurrentLease(job, command.leaseToken, command.atMs);
      result = advance(job, command, { state: "publishing", publicationState: "publishing" });
      break;
    case "mark_ready":
      requireState(job, "publishing");
      assertCurrentLease(job, command.leaseToken, command.atMs);
      requireProof(command.finalArtifactPublished && command.readyRegistrationCommitted);
      result = advance(job, command, {
        state: "ready",
        publicationState: "published",
        lease: null,
        publishedAtMs: command.atMs,
        readyAtMs: command.atMs,
      });
      break;
    case "record_failure":
      requireOneState(job, ["processing", "output_ready", "publishing"]);
      assertCurrentLease(job, command.leaseToken, command.atMs);
      validateErrorCode(command.errorCode);
      if (job.state === "publishing" || command.publicationMayHaveOccurred) {
        result = toCompensationRequired(job, command, command.errorCode, command.retryAtMs ?? command.atMs);
      } else {
        requireProof(command.privateOutputRemoved);
        result = job.attemptCount < job.maxAttempts && command.retryAtMs !== null
          ? advance(job, command, {
            state: "queued",
            lease: null,
            nextAttemptAtMs: futureOrNow(command.retryAtMs, command.atMs),
            lastErrorCode: command.errorCode,
          })
          : advance(job, command, {
            state: "failed",
            lease: null,
            nextAttemptAtMs: null,
            failedAtMs: command.atMs,
            lastErrorCode: command.errorCode,
          });
      }
      break;
    case "recover_ready":
      requireState(job, "publishing");
      assertExpiredLease(job, command.atMs);
      requireProof(command.finalArtifactPublished && command.readyRegistrationCommitted);
      result = advance(job, command, {
        state: "ready",
        publicationState: "published",
        lease: null,
        publishedAtMs: command.atMs,
        readyAtMs: command.atMs,
      });
      break;
    case "recover_retry":
      requireOneState(job, ["processing", "output_ready", "publishing"]);
      assertExpiredLease(job, command.atMs);
      requireProof(
        command.finalArtifactAbsent && command.readyRegistrationAbsent && command.privateOutputRemoved,
      );
      validateErrorCode(command.errorCode);
      result = job.attemptCount < job.maxAttempts
        ? advance(job, command, {
          state: "queued",
          publicationState: "private",
          lease: null,
          nextAttemptAtMs: futureOrNow(command.retryAtMs, command.atMs),
          lastErrorCode: command.errorCode,
        })
        : advance(job, command, {
          state: "failed",
          publicationState: "private",
          lease: null,
          nextAttemptAtMs: null,
          failedAtMs: command.atMs,
          lastErrorCode: command.errorCode,
        });
      break;
    case "require_compensation":
      if (job.state === "ready" || job.state === "compensated") {
        fail("ILLEGAL_TRANSITION", `State ${job.state} cannot enter automatic compensation.`);
      }
      if (job.lease !== null && command.atMs < job.lease.expiresAtMs) {
        fail("LIVE_LEASE", "A live lease must not be taken over by reconciliation.");
      }
      validateErrorCode(command.errorCode);
      result = toCompensationRequired(job, command, command.errorCode, command.retryAtMs);
      break;
    case "claim_compensation":
      requireState(job, "compensation_required");
      assertDue(job, command.atMs);
      if (job.compensationAttemptCount >= job.maxCompensationAttempts) {
        fail("ATTEMPTS_EXHAUSTED", "Compensation attempts are exhausted.");
      }
      result = advance(job, command, {
        state: "compensating",
        compensationState: "in_progress",
        compensationAttemptCount: job.compensationAttemptCount + 1,
        lastCompensationAttemptAtMs: command.atMs,
        nextAttemptAtMs: null,
        lease: makeLease(command),
      });
      break;
    case "mark_compensated":
      requireState(job, "compensating");
      assertCurrentLease(job, command.leaseToken, command.atMs);
      requireProof(command.finalArtifactAbsent && command.readyRegistrationAbsent);
      result = advance(job, command, {
        state: "compensated",
        publicationState: "removed",
        compensationState: "complete",
        lease: null,
        compensatedAtMs: command.atMs,
      });
      break;
    case "recover_compensated":
      requireState(job, "compensating");
      assertExpiredLease(job, command.atMs);
      requireProof(command.finalArtifactAbsent && command.readyRegistrationAbsent);
      result = advance(job, command, {
        state: "compensated",
        publicationState: "removed",
        compensationState: "complete",
        lease: null,
        compensatedAtMs: command.atMs,
      });
      break;
    case "record_compensation_failure":
      requireState(job, "compensating");
      assertCurrentLease(job, command.leaseToken, command.atMs);
      validateErrorCode(command.errorCode);
      result = job.compensationAttemptCount < job.maxCompensationAttempts
        ? advance(job, command, {
          state: "compensation_required",
          compensationState: "required",
          lease: null,
          nextAttemptAtMs: futureOrNow(command.retryAtMs, command.atMs),
          lastErrorCode: command.errorCode,
        })
        : advance(job, command, {
          state: "manual_review",
          compensationState: "required",
          lease: null,
          nextAttemptAtMs: null,
          lastErrorCode: command.errorCode,
        });
      break;
    case "mark_manual_review":
      if (job.state === "ready" || job.state === "compensated") {
        fail("ILLEGAL_TRANSITION", `State ${job.state} must remain authoritative and be reviewed in place.`);
      }
      if (job.lease !== null && command.atMs < job.lease.expiresAtMs) {
        fail("LIVE_LEASE", "A live lease must not be taken over by reconciliation.");
      }
      validateErrorCode(command.errorCode);
      result = advance(job, command, {
        state: "manual_review",
        publicationState: "unknown",
        compensationState: "required",
        lease: null,
        nextAttemptAtMs: null,
        compensationRequestedAtMs: job.compensationRequestedAtMs ?? command.atMs,
        lastErrorCode: command.errorCode,
      });
      break;
  }

  assertImageJobInvariant(result);
  return result;
}

export function isImageJobAttachable(job: ImageJobSnapshot): boolean {
  assertImageJobInvariant(job);
  return job.state === "ready"
    && job.publicationState === "published"
    && job.compensationState === "not_required"
    && job.readyAtMs !== null
    && job.resultSourceWidth !== null
    && job.resultSourceHeight !== null;
}

export function planImageJobRestart(
  job: ImageJobSnapshot,
  evidence: ImageJobRestartEvidence,
  nowMs: number,
): ImageJobRestartDecision {
  assertImageJobInvariant(job);
  assertEpoch(nowMs, "restart time");
  if (nowMs < job.updatedAtMs) {
    fail("STALE_TIMESTAMP", "Restart observation predates the ledger row.");
  }

  switch (job.state) {
    case "requested":
      return decision("enqueue", "Persisted request was never queued.");
    case "queued":
      return job.nextAttemptAtMs !== null && nowMs < job.nextAttemptAtMs
        ? decision("wait_until_due", "Retry backoff is still active.")
        : decision("claim_processing", "Queued work is due for a fresh lease.");
    case "processing":
    case "output_ready":
      if (hasLiveLease(job, nowMs)) return decision("wait_for_lease", "The current worker lease is still live.");
      if (evidence.finalArtifact !== "absent" || evidence.readyRegistration !== "absent") {
        return decision("require_compensation", "An expired worker may have published or registered output.");
      }
      return evidence.privateArtifact === "unknown"
        ? decision("manual_review", "Private artifacts cannot be proved present or absent.")
        : decision("clean_private_then_recover_retry", "No public result exists; clean private artifacts before retry.");
    case "publishing":
      if (hasLiveLease(job, nowMs)) return decision("wait_for_lease", "The publishing lease is still live.");
      if (evidence.finalArtifact === "present" && evidence.readyRegistration === "present") {
        return decision("recover_ready", "Both publication proofs exist after the publishing lease expired.");
      }
      if (evidence.finalArtifact === "absent" && evidence.readyRegistration === "absent"
        && evidence.privateArtifact !== "unknown") {
        return decision("clean_private_then_recover_retry", "Publication did not occur; private files can be cleaned.");
      }
      return decision("require_compensation", "Publication is partial or ambiguous after restart.");
    case "ready":
      return evidence.finalArtifact === "present" && evidence.readyRegistration === "present"
        ? decision("none", "Ready publication remains intact.")
        : decision("manual_review", "A ready publication lost required durable evidence; never auto-delete it.");
    case "failed":
      if (evidence.finalArtifact !== "absent" || evidence.readyRegistration !== "absent") {
        return decision("require_compensation", "A failed job still has public or ambiguous residue.");
      }
      return evidence.privateArtifact === "present"
        ? decision("clean_private", "Only private residue remains for a terminal failed job.")
        : evidence.privateArtifact === "unknown"
          ? decision("manual_review", "Failed-job private residue is unknown.")
          : decision("none", "Failed job has no remaining artifacts.");
    case "compensation_required":
      return job.nextAttemptAtMs !== null && nowMs < job.nextAttemptAtMs
        ? decision("wait_until_due", "Compensation backoff is still active.")
        : decision("claim_compensation", "Compensation is due for a fresh lease.");
    case "compensating":
      if (hasLiveLease(job, nowMs)) return decision("wait_for_lease", "The compensation lease is still live.");
      if (evidence.finalArtifact === "absent" && evidence.readyRegistration === "absent") {
        return decision("recover_compensated", "Compensation effects are already durably visible.");
      }
      return job.compensationAttemptCount < job.maxCompensationAttempts
        ? decision("require_compensation", "Expired compensation must be reclaimed.")
        : decision("manual_review", "Compensation attempts are exhausted.");
    case "compensated":
      return evidence.finalArtifact === "absent" && evidence.readyRegistration === "absent"
        ? decision("none", "Compensation remains complete.")
        : decision("manual_review", "Residue reappeared after compensation was recorded complete.");
    case "manual_review":
      return decision("manual_review", "Automated recovery is intentionally stopped for this job.");
  }
}

export function assertImageJobInvariant(job: ImageJobSnapshot): void {
  if (!/^[0-9a-f]{32}$/.test(job.jobId)
    || !/^[0-9a-f]{64}$/.test(job.requestKey)
    || !/^[0-9a-f]{64}$/.test(job.payloadHash)
    || !/^[0-9a-f]{64}$/.test(job.sessionScopeHash)
    || !isPositiveInteger(job.domainId)
    || !isPositiveInteger(job.userId)
    || !isStorageKey(job.inputStorageKey)
    || !isStorageKey(job.outputStorageKey)
    || !Number.isSafeInteger(job.version) || job.version < 0
    || !boundedAttempts(job.attemptCount, job.maxAttempts)
    || !boundedAttempts(job.compensationAttemptCount, job.maxCompensationAttempts)) {
    fail("INVALID_JOB", "Image job identity or counters are invalid.");
  }
  assertEpoch(job.createdAtMs, "createdAtMs");
  assertEpoch(job.updatedAtMs, "updatedAtMs");
  assertEpoch(job.ownershipExpiresAtMs, "ownershipExpiresAtMs");
  if (job.updatedAtMs < job.createdAtMs) fail("INVALID_JOB", "updatedAtMs precedes createdAtMs.");
  if (job.ownershipExpiresAtMs <= job.createdAtMs) fail("INVALID_JOB", "Ownership expiry must follow creation.");

  const [publication, compensation, leaseShape] = stateShape[job.state];
  if (job.publicationState !== publication || job.compensationState !== compensation) {
    fail("INVALID_JOB", `State ${job.state} has an invalid publication or compensation shape.`);
  }
  if ((leaseShape === "lease") !== (job.lease !== null)) {
    fail("INVALID_JOB", `State ${job.state} has an invalid lease shape.`);
  }
  if (job.lease !== null) validateLease(job.lease, job.updatedAtMs, false);
  if (job.nextAttemptAtMs !== null && job.state !== "queued" && job.state !== "compensation_required") {
    fail("INVALID_JOB", "Only queued work may have a next-attempt time.");
  }
  for (const [label, value] of [
    ["nextAttemptAtMs", job.nextAttemptAtMs],
    ["firstAttemptAtMs", job.firstAttemptAtMs],
    ["lastAttemptAtMs", job.lastAttemptAtMs],
    ["lastCompensationAttemptAtMs", job.lastCompensationAttemptAtMs],
    ["outputReadyAtMs", job.outputReadyAtMs],
    ["publishedAtMs", job.publishedAtMs],
    ["readyAtMs", job.readyAtMs],
    ["failedAtMs", job.failedAtMs],
    ["compensationRequestedAtMs", job.compensationRequestedAtMs],
    ["compensatedAtMs", job.compensatedAtMs],
  ] as const) {
    if (value !== null) {
      assertEpoch(value, label);
      if (value < job.createdAtMs) fail("INVALID_JOB", `${label} predates job creation.`);
    }
  }
  if (job.nextAttemptAtMs !== null && job.nextAttemptAtMs < job.updatedAtMs) {
    fail("INVALID_JOB", "Next-attempt time predates the current ledger version.");
  }
  if (job.state === "ready") {
    if (job.publishedAtMs === null || job.readyAtMs === null
      || job.resultSourceWidth === null || job.resultSourceHeight === null) {
      fail("INVALID_JOB", "Ready jobs require publication times and result dimensions.");
    }
  } else if (job.publishedAtMs !== null || job.readyAtMs !== null) {
    fail("INVALID_JOB", "Only ready jobs may carry publication times.");
  }
  if ((job.resultSourceWidth === null) !== (job.resultSourceHeight === null)
    || (job.resultSourceWidth !== null && (!isPositiveInteger(job.resultSourceWidth) || job.resultSourceWidth > 100_000))
    || (job.resultSourceHeight !== null && (!isPositiveInteger(job.resultSourceHeight) || job.resultSourceHeight > 100_000))) {
    fail("INVALID_JOB", "Image result dimensions must be paired and bounded.");
  }
  if ((job.state === "compensated") !== (job.compensatedAtMs !== null)) {
    fail("INVALID_JOB", "Compensated timestamp does not match state.");
  }
  if (job.attemptCount === 0
    ? job.firstAttemptAtMs !== null || job.lastAttemptAtMs !== null
    : job.firstAttemptAtMs === null || job.lastAttemptAtMs === null) {
    fail("INVALID_JOB", "Processing attempt timestamps do not match the attempt count.");
  }
  if (job.compensationAttemptCount === 0
    ? job.lastCompensationAttemptAtMs !== null
    : job.lastCompensationAttemptAtMs === null) {
    fail("INVALID_JOB", "Compensation timestamps do not match the attempt count.");
  }
  if (["compensation_required", "compensating", "compensated", "manual_review"].includes(job.state)
    && job.compensationRequestedAtMs === null) {
    fail("INVALID_JOB", "Compensation states require a request timestamp.");
  }
  if (job.lastErrorCode !== null) validateErrorCode(job.lastErrorCode);
}

function validateNewJob(input: NewImageJob, atMs: number): void {
  assertEpoch(atMs, "creation time");
  const probe = createProbe(input, atMs);
  assertImageJobInvariant(probe);
}

function createProbe(input: NewImageJob, atMs: number): ImageJobSnapshot {
  return {
    ...input,
    state: "requested",
    publicationState: "private",
    compensationState: "not_required",
    version: 0,
    attemptCount: 0,
    compensationAttemptCount: 0,
    nextAttemptAtMs: null,
    firstAttemptAtMs: null,
    lastAttemptAtMs: null,
    lastCompensationAttemptAtMs: null,
    lease: null,
    outputReadyAtMs: null,
    resultSourceWidth: null,
    resultSourceHeight: null,
    publishedAtMs: null,
    readyAtMs: null,
    failedAtMs: null,
    compensationRequestedAtMs: null,
    compensatedAtMs: null,
    lastErrorCode: null,
    createdAtMs: atMs,
    updatedAtMs: atMs,
  };
}

function assertSameRequest(existing: ImageJobSnapshot, proposal: NewImageJob): void {
  if (existing.requestKey !== proposal.requestKey
    || existing.payloadHash !== proposal.payloadHash
    || existing.domainId !== proposal.domainId
    || existing.userId !== proposal.userId
    || existing.sessionScopeHash !== proposal.sessionScopeHash) {
    fail("REQUEST_KEY_CONFLICT", "Idempotency key was reused for a different request payload or owner.");
  }
}

function advance(
  job: ImageJobSnapshot,
  command: VersionedCommand,
  changes: Partial<ImageJobSnapshot>,
): ImageJobSnapshot {
  return { ...job, ...changes, version: job.version + 1, updatedAtMs: command.atMs };
}

function toCompensationRequired(
  job: ImageJobSnapshot,
  command: VersionedCommand,
  errorCode: string,
  retryAtMs: number,
): ImageJobSnapshot {
  return advance(job, command, {
    state: "compensation_required",
    publicationState: "unknown",
    compensationState: "required",
    lease: null,
    nextAttemptAtMs: futureOrNow(retryAtMs, command.atMs),
    compensationRequestedAtMs: job.compensationRequestedAtMs ?? command.atMs,
    lastErrorCode: errorCode,
  });
}

function assertCommandFresh(job: ImageJobSnapshot, command: VersionedCommand): void {
  if (command.expectedVersion !== job.version) {
    fail("STALE_VERSION", `Expected version ${String(command.expectedVersion)} does not match ${String(job.version)}.`);
  }
  assertEpoch(command.atMs, "command time");
  if (command.atMs < job.updatedAtMs) fail("STALE_TIMESTAMP", "Command predates the current ledger version.");
}

function makeLease(command: {
  readonly atMs: number;
  readonly leaseOwner: string;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
}): ImageJobLease {
  const lease = {
    owner: command.leaseOwner,
    token: command.leaseToken,
    acquiredAtMs: command.atMs,
    expiresAtMs: command.leaseExpiresAtMs,
  };
  validateLease(lease, command.atMs, true);
  return lease;
}

function validateLease(lease: ImageJobLease, referenceMs: number, requireFuture: boolean): void {
  if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(lease.owner)
    || !/^[0-9a-f]{32}$/.test(lease.token)) {
    fail("INVALID_JOB", "Lease owner or token is invalid.");
  }
  assertEpoch(lease.acquiredAtMs, "lease acquisition");
  assertEpoch(lease.expiresAtMs, "lease expiry");
  if (lease.acquiredAtMs > referenceMs
    || lease.expiresAtMs <= lease.acquiredAtMs
    || (requireFuture && lease.expiresAtMs <= referenceMs)) {
    fail("INVALID_JOB", "Lease expiry must follow acquisition.");
  }
}

function assertCurrentLease(job: ImageJobSnapshot, token: string, atMs: number): void {
  if (job.lease === null || job.lease.token !== token || atMs >= job.lease.expiresAtMs) {
    fail("STALE_LEASE", "Worker lease is missing, mismatched or expired.");
  }
}

function assertExpiredLease(job: ImageJobSnapshot, atMs: number): void {
  if (job.lease === null) fail("STALE_LEASE", "Recovery requires the prior lease record.");
  if (atMs < job.lease.expiresAtMs) fail("LIVE_LEASE", "Recovery cannot take over a live lease.");
}

function hasLiveLease(job: ImageJobSnapshot, nowMs: number): boolean {
  return job.lease !== null && nowMs < job.lease.expiresAtMs;
}

function assertDue(job: ImageJobSnapshot, atMs: number): void {
  if (job.nextAttemptAtMs !== null && atMs < job.nextAttemptAtMs) {
    fail("NOT_DUE", "Job retry backoff is still active.");
  }
}

function requireState(job: ImageJobSnapshot, expected: ImageJobState): void {
  if (job.state !== expected) fail("ILLEGAL_TRANSITION", `Expected ${expected}; found ${job.state}.`);
}

function requireOneState(job: ImageJobSnapshot, expected: readonly ImageJobState[]): void {
  if (!expected.includes(job.state)) {
    fail("ILLEGAL_TRANSITION", `State ${job.state} is not valid for this transition.`);
  }
}

function requireProof(proved: boolean): void {
  if (!proved) fail("PROOF_REQUIRED", "Durable external-state proof is required for this transition.");
}

function futureOrNow(value: number, nowMs: number): number {
  assertEpoch(value, "retry time");
  return Math.max(value, nowMs);
}

function assertAtOrAfter(value: number, minimum: number, message: string): void {
  assertEpoch(value, "scheduled time");
  if (value < minimum) fail("STALE_TIMESTAMP", message);
}

function assertEpoch(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_JOB", `${label} must be an epoch millisecond.`);
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function boundedAttempts(count: number, maximum: number): boolean {
  return Number.isSafeInteger(count) && count >= 0
    && Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= 20
    && count <= maximum;
}

function isStorageKey(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) || value.includes("//")) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function validateErrorCode(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) fail("INVALID_JOB", "Error code is invalid.");
}

function decision(action: ImageJobRestartAction, reason: string): ImageJobRestartDecision {
  return { action, reason };
}

function fail(code: ImageJobPolicyErrorCode, message: string): never {
  throw new ImageJobPolicyError(code, message);
}
