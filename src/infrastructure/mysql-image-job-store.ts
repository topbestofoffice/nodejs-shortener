import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import type { RegisterUploadInput } from "../core/types.js";
import type {
  ImageJobCompensatedCommand,
  ImageJobReadyCommand,
  ImageJobStore,
  UploadCapacity,
} from "../ports.js";
import {
  assertImageJobInvariant,
  decideImageJobCreation,
  isImageJobAttachable,
  transitionImageJob as applyImageJobTransition,
  type ImageCompensationState,
  type ImageJobCommand,
  type ImageJobCreationDecision,
  type ImageJobSnapshot,
  type ImageJobState,
  type ImagePublicationState,
  type NewImageJob,
} from "../modules/uploads/job-ledger-policy.js";

interface ImageJobRow extends RowDataPacket {
  job_id: string;
  request_key: string;
  payload_hash: string;
  domain_id: number;
  user_id: number;
  session_scope_hash: string;
  ownership_expires_at: Date | string;
  input_storage_key: string;
  output_storage_key: string;
  state: ImageJobState;
  publication_state: ImagePublicationState;
  compensation_state: ImageCompensationState;
  version: string | number;
  attempt_count: number;
  max_attempts: number;
  compensation_attempt_count: number;
  max_compensation_attempts: number;
  next_attempt_at: Date | string | null;
  first_attempt_at: Date | string | null;
  last_attempt_at: Date | string | null;
  last_compensation_attempt_at: Date | string | null;
  lease_owner: string | null;
  lease_token: string | null;
  lease_acquired_at: Date | string | null;
  lease_expires_at: Date | string | null;
  output_ready_at: Date | string | null;
  result_source_width: number | null;
  result_source_height: number | null;
  published_at: Date | string | null;
  ready_at: Date | string | null;
  failed_at: Date | string | null;
  compensation_requested_at: Date | string | null;
  compensated_at: Date | string | null;
  last_error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CountRow extends RowDataPacket {
  total: string | number;
}

interface UploadRegistrationRow extends RowDataPacket {
  path: string;
  user_id: number;
  session_scope_hash: Buffer;
  state: 1 | 2;
  expires_at: Date | string;
}

interface LinkReferenceRow extends RowDataPacket {
  id: string;
}

interface CapacityLockRow extends RowDataPacket {
  acquired: number | null;
  released: number | null;
}

const imageJobColumns = `job_id, request_key, payload_hash, domain_id, user_id,
  session_scope_hash, ownership_expires_at, input_storage_key, output_storage_key,
  state, publication_state, compensation_state, version, attempt_count, max_attempts,
  compensation_attempt_count, max_compensation_attempts, next_attempt_at,
  first_attempt_at, last_attempt_at, last_compensation_attempt_at,
  lease_owner, lease_token, lease_acquired_at, lease_expires_at,
  output_ready_at, result_source_width, result_source_height,
  published_at, ready_at, failed_at, compensation_requested_at, compensated_at,
  last_error_code, created_at, updated_at`;

const capacityLockExpression = "CONCAT('node_upload:', LEFT(SHA2(DATABASE(), 256), 40))";

export class MysqlImageJobStore implements ImageJobStore {
  public constructor(private readonly pool: Pool) {}

  public async reserveImageJob(input: NewImageJob, atMs: number): Promise<ImageJobCreationDecision> {
    const proposed = decideImageJobCreation(input, { byRequestKey: null, byJobId: null }, atMs);
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    let commitAttempted = false;
    let connectionDisposed = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      try {
        const [insert] = await connection.execute<ResultSetHeader>(
          `INSERT INTO image_job_ledger_v1
            (${imageJobColumns})
           VALUES (${new Array(36).fill("?").join(",")})`,
          imageJobInsertParams(proposed.job),
        );
        if (insert.affectedRows !== 1) {
          throw new Error("Image job ledger row was not inserted.");
        }
        commitAttempted = true;
        await connection.commit();
        transactionStarted = false;
        return proposed;
      } catch (error) {
        if (!isMysqlDuplicate(error)) {
          throw error;
        }
        const [rows] = await connection.execute<ImageJobRow[]>(
          `SELECT ${imageJobColumns} FROM image_job_ledger_v1
            WHERE request_key = ? OR job_id = ? FOR UPDATE`,
          [input.requestKey, input.jobId],
        );
        const byRequestKey = rows.find((row) => row.request_key === input.requestKey);
        const byJobId = rows.find((row) => row.job_id === input.jobId);
        if (byRequestKey === undefined && byJobId === undefined) {
          throw codedError("Image job storage key is already in use.", "IMAGE_JOB_STORAGE_CONFLICT");
        }
        const decision = decideImageJobCreation(input, {
          byRequestKey: byRequestKey === undefined ? null : mapImageJob(byRequestKey),
          byJobId: byJobId === undefined ? null : mapImageJob(byJobId),
        }, atMs);
        await connection.commit();
        transactionStarted = false;
        return decision;
      }
    } catch (error) {
      if (transactionStarted) await rollbackPreservingOriginal(connection);
      if (commitAttempted) {
        // A dropped commit acknowledgement is ambiguous: the insert may be
        // durable even though commit() rejected. Retire that connection and
        // resolve the exact idempotency keys through a fresh pool connection.
        connection.destroy();
        connectionDisposed = true;
        try {
          const observed = await observeReservedImageJob(this.pool, input, atMs);
          if (observed !== null) return observed;
        } catch {
          // Preserve the original commit error when readback itself is unavailable.
        }
      }
      throw error;
    } finally {
      if (!connectionDisposed) connection.release();
    }
  }

  public async getImageJob(jobId: string): Promise<ImageJobSnapshot | null> {
    const [rows] = await this.pool.execute<ImageJobRow[]>(
      `SELECT ${imageJobColumns} FROM image_job_ledger_v1 WHERE job_id = ? LIMIT 1`,
      [jobId],
    );
    return rows[0] === undefined ? null : mapImageJob(rows[0]);
  }

  public async transitionImageJob(jobId: string, command: ImageJobCommand): Promise<ImageJobSnapshot> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const current = await selectImageJobForUpdate(connection, jobId);
      const next = applyImageJobTransition(current, command);
      await updateImageJob(connection, next, current.version);
      await connection.commit();
      transactionStarted = false;
      return next;
    } catch (error) {
      if (transactionStarted) await rollbackPreservingOriginal(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async publishImageJobReady(
    jobId: string,
    command: ImageJobReadyCommand,
    upload: RegisterUploadInput,
    capacity: UploadCapacity,
  ): Promise<ImageJobSnapshot> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    let lockHeld = false;
    let reusableConnection = true;
    try {
      const [lockRows] = await connection.query<CapacityLockRow[]>(
        `SELECT GET_LOCK(${capacityLockExpression}, 5) AS acquired`,
      );
      if (lockRows[0]?.acquired !== 1) {
        throw codedError("Upload capacity lock unavailable.", "UPLOAD_CAPACITY_UNAVAILABLE");
      }
      lockHeld = true;
      await connection.beginTransaction();
      transactionStarted = true;
      const current = await selectImageJobForUpdate(connection, jobId);
      if (current.state === "ready") {
        if (!await hasMatchingRegistration(connection, current)) {
          throw new Error("Ready image job registration is missing.");
        }
        await connection.commit();
        transactionStarted = false;
        return current;
      }
      assertRegistrationMatchesJob(current, upload);
      const next = applyImageJobTransition(current, command);

      const [scopeRows] = await connection.execute<CountRow[]>(
        `SELECT COUNT(*) AS total FROM uploaded_images
          WHERE user_id = ? AND session_scope_hash = ? AND state = 1`,
        [upload.userId, Buffer.from(upload.sessionScopeHash, "hex")],
      );
      if (Number(scopeRows[0]?.total ?? 0) >= capacity.readyPerSession) {
        throw codedError("Session upload capacity reached.", "SESSION_UPLOAD_LIMIT");
      }
      const [totalRows] = await connection.query<CountRow[]>(
        "SELECT COUNT(*) AS total FROM uploaded_images WHERE state = 1",
      );
      if (Number(totalRows[0]?.total ?? 0) >= capacity.readyTotal) {
        throw codedError("Global upload capacity reached.", "GLOBAL_UPLOAD_LIMIT");
      }

      const [registered] = await connection.execute<ResultSetHeader>(
        `INSERT INTO uploaded_images
          (path, user_id, session_scope_hash, state, created_at, expires_at, attached_at)
         VALUES (?, ?, ?, 1, ?, ?, NULL)`,
        [
          upload.path,
          upload.userId,
          Buffer.from(upload.sessionScopeHash, "hex"),
          formatUtc(upload.createdAt),
          formatUtc(upload.expiresAt),
        ],
      );
      if (registered.affectedRows !== 1) {
        throw new Error("Ready upload was not registered.");
      }
      await updateImageJob(connection, next, current.version);
      await connection.commit();
      transactionStarted = false;
      return next;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.rollback();
        } catch {
          reusableConnection = false;
        }
      }
      throw error;
    } finally {
      if (lockHeld) {
        try {
          const [rows] = await connection.query<CapacityLockRow[]>(
            `SELECT RELEASE_LOCK(${capacityLockExpression}) AS released`,
          );
          if (rows[0]?.released !== 1) reusableConnection = false;
        } catch {
          reusableConnection = false;
        }
      }
      if (reusableConnection) connection.release();
      else connection.destroy();
    }
  }

  public async completeImageJobCompensation(
    jobId: string,
    command: ImageJobCompensatedCommand,
  ): Promise<ImageJobSnapshot> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const current = await selectImageJobForUpdate(connection, jobId);
      const [uploads] = await connection.execute<UploadRegistrationRow[]>(
        `SELECT path, user_id, session_scope_hash, state, expires_at FROM uploaded_images
          WHERE path = ? FOR UPDATE`,
        [current.outputStorageKey],
      );
      if (uploads[0]?.state === 2) {
        throw codedError("Attached image cannot be compensated automatically.", "IMAGE_JOB_ATTACHED");
      }
      const [references] = await connection.execute<LinkReferenceRow[]>(
        "SELECT id FROM links WHERE image = ? LIMIT 1 FOR UPDATE",
        [current.outputStorageKey],
      );
      if (references.length > 0) {
        throw codedError("Referenced image cannot be compensated automatically.", "IMAGE_JOB_REFERENCED");
      }
      const next = applyImageJobTransition(current, command);
      if (uploads[0]?.state === 1) {
        const [removed] = await connection.execute<ResultSetHeader>(
          "DELETE FROM uploaded_images WHERE path = ? AND state = 1",
          [current.outputStorageKey],
        );
        if (removed.affectedRows !== 1) throw new Error("Ready image registration was not compensated.");
      }
      await updateImageJob(connection, next, current.version);
      await connection.commit();
      transactionStarted = false;
      return next;
    } catch (error) {
      if (transactionStarted) await rollbackPreservingOriginal(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async assertImageJobCompensationSafe(jobId: string): Promise<void> {
    const connection = await this.pool.getConnection();
    let transactionStarted = false;
    try {
      await connection.beginTransaction();
      transactionStarted = true;
      const current = await selectImageJobForUpdate(connection, jobId);
      const [uploads] = await connection.execute<UploadRegistrationRow[]>(
        "SELECT path, user_id, session_scope_hash, state, expires_at FROM uploaded_images WHERE path = ? FOR UPDATE",
        [current.outputStorageKey],
      );
      if (uploads[0]?.state === 2) {
        throw codedError("Attached image cannot be compensated automatically.", "IMAGE_JOB_ATTACHED");
      }
      const [references] = await connection.execute<LinkReferenceRow[]>(
        "SELECT id FROM links WHERE image = ? LIMIT 1 FOR UPDATE",
        [current.outputStorageKey],
      );
      if (references.length > 0) {
        throw codedError("Referenced image cannot be compensated automatically.", "IMAGE_JOB_REFERENCED");
      }
      await connection.commit();
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) await rollbackPreservingOriginal(connection);
      throw error;
    } finally {
      connection.release();
    }
  }

  public async listImageJobsForRecovery(nowMs: number, limit: number): Promise<readonly ImageJobSnapshot[]> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Invalid image-job recovery window.");
    }
    const now = formatUtc(new Date(nowMs));
    const [rows] = await this.pool.execute<ImageJobRow[]>(
      `SELECT ${imageJobColumns} FROM image_job_ledger_v1
        WHERE state = 'requested'
           OR (state IN ('queued', 'compensation_required') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
           OR (state IN ('processing', 'output_ready', 'publishing', 'compensating') AND lease_expires_at <= ?)
        ORDER BY updated_at, id LIMIT ?`,
      [now, now, limit],
    );
    return rows.map(mapImageJob);
  }

  public async hasReadyImageRegistration(jobId: string): Promise<boolean> {
    const job = await this.getImageJob(jobId);
    if (job === null || !isImageJobAttachable(job)) return false;
    return hasMatchingRegistration(this.pool, job);
  }
}

async function observeReservedImageJob(
  pool: Pool,
  input: NewImageJob,
  atMs: number,
): Promise<ImageJobCreationDecision | null> {
  const [rows] = await pool.execute<ImageJobRow[]>(
    `SELECT ${imageJobColumns} FROM image_job_ledger_v1
      WHERE request_key = ? OR job_id = ?`,
    [input.requestKey, input.jobId],
  );
  const byRequestKey = rows.find((row) => row.request_key === input.requestKey);
  const byJobId = rows.find((row) => row.job_id === input.jobId);
  if (byRequestKey === undefined && byJobId === undefined) return null;
  return decideImageJobCreation(input, {
    byRequestKey: byRequestKey === undefined ? null : mapImageJob(byRequestKey),
    byJobId: byJobId === undefined ? null : mapImageJob(byJobId),
  }, atMs);
}

async function selectImageJobForUpdate(connection: PoolConnection, jobId: string): Promise<ImageJobSnapshot> {
  const [rows] = await connection.execute<ImageJobRow[]>(
    `SELECT ${imageJobColumns} FROM image_job_ledger_v1 WHERE job_id = ? FOR UPDATE`,
    [jobId],
  );
  if (rows[0] === undefined) throw codedError("Image job not found.", "IMAGE_JOB_NOT_FOUND");
  return mapImageJob(rows[0]);
}

async function updateImageJob(
  connection: PoolConnection,
  job: ImageJobSnapshot,
  expectedVersion: number,
): Promise<void> {
  const [result] = await connection.execute<ResultSetHeader>(
    `UPDATE image_job_ledger_v1 SET
      state = ?, publication_state = ?, compensation_state = ?, version = ?,
      attempt_count = ?, compensation_attempt_count = ?, next_attempt_at = ?,
      first_attempt_at = ?, last_attempt_at = ?, last_compensation_attempt_at = ?,
      lease_owner = ?, lease_token = ?, lease_acquired_at = ?, lease_expires_at = ?,
      output_ready_at = ?, result_source_width = ?, result_source_height = ?,
      published_at = ?, ready_at = ?, failed_at = ?, compensation_requested_at = ?,
      compensated_at = ?, last_error_code = ?, updated_at = ?
     WHERE job_id = ? AND version = ?`,
    [
      job.state,
      job.publicationState,
      job.compensationState,
      job.version,
      job.attemptCount,
      job.compensationAttemptCount,
      nullableUtc(job.nextAttemptAtMs),
      nullableUtc(job.firstAttemptAtMs),
      nullableUtc(job.lastAttemptAtMs),
      nullableUtc(job.lastCompensationAttemptAtMs),
      job.lease?.owner ?? null,
      job.lease?.token ?? null,
      nullableUtc(job.lease?.acquiredAtMs ?? null),
      nullableUtc(job.lease?.expiresAtMs ?? null),
      nullableUtc(job.outputReadyAtMs),
      job.resultSourceWidth,
      job.resultSourceHeight,
      nullableUtc(job.publishedAtMs),
      nullableUtc(job.readyAtMs),
      nullableUtc(job.failedAtMs),
      nullableUtc(job.compensationRequestedAtMs),
      nullableUtc(job.compensatedAtMs),
      job.lastErrorCode,
      formatUtc(new Date(job.updatedAtMs)),
      job.jobId,
      expectedVersion,
    ],
  );
  if (result.affectedRows !== 1) {
    throw codedError("Image job version changed.", "IMAGE_JOB_STALE_VERSION");
  }
}

function mapImageJob(row: ImageJobRow): ImageJobSnapshot {
  const leasePresent = row.lease_token !== null || row.lease_owner !== null
    || row.lease_acquired_at !== null || row.lease_expires_at !== null;
  const job: ImageJobSnapshot = {
    jobId: row.job_id,
    requestKey: row.request_key,
    payloadHash: row.payload_hash,
    domainId: Number(row.domain_id),
    userId: Number(row.user_id),
    sessionScopeHash: row.session_scope_hash,
    ownershipExpiresAtMs: dateMs(row.ownership_expires_at),
    inputStorageKey: row.input_storage_key,
    outputStorageKey: row.output_storage_key,
    state: row.state,
    publicationState: row.publication_state,
    compensationState: row.compensation_state,
    version: safeInteger(row.version, "version"),
    attemptCount: safeInteger(row.attempt_count, "attempt_count"),
    maxAttempts: safeInteger(row.max_attempts, "max_attempts"),
    compensationAttemptCount: safeInteger(row.compensation_attempt_count, "compensation_attempt_count"),
    maxCompensationAttempts: safeInteger(row.max_compensation_attempts, "max_compensation_attempts"),
    nextAttemptAtMs: nullableDateMs(row.next_attempt_at),
    firstAttemptAtMs: nullableDateMs(row.first_attempt_at),
    lastAttemptAtMs: nullableDateMs(row.last_attempt_at),
    lastCompensationAttemptAtMs: nullableDateMs(row.last_compensation_attempt_at),
    lease: leasePresent ? {
      owner: required(row.lease_owner, "lease_owner"),
      token: required(row.lease_token, "lease_token"),
      acquiredAtMs: dateMs(required(row.lease_acquired_at, "lease_acquired_at")),
      expiresAtMs: dateMs(required(row.lease_expires_at, "lease_expires_at")),
    } : null,
    outputReadyAtMs: nullableDateMs(row.output_ready_at),
    resultSourceWidth: nullableSafeInteger(row.result_source_width, "result_source_width"),
    resultSourceHeight: nullableSafeInteger(row.result_source_height, "result_source_height"),
    publishedAtMs: nullableDateMs(row.published_at),
    readyAtMs: nullableDateMs(row.ready_at),
    failedAtMs: nullableDateMs(row.failed_at),
    compensationRequestedAtMs: nullableDateMs(row.compensation_requested_at),
    compensatedAtMs: nullableDateMs(row.compensated_at),
    lastErrorCode: row.last_error_code,
    createdAtMs: dateMs(row.created_at),
    updatedAtMs: dateMs(row.updated_at),
  };
  assertImageJobInvariant(job);
  return job;
}

function imageJobInsertParams(job: ImageJobSnapshot): SqlValue[] {
  return [
    job.jobId,
    job.requestKey,
    job.payloadHash,
    job.domainId,
    job.userId,
    job.sessionScopeHash,
    formatUtc(new Date(job.ownershipExpiresAtMs)),
    job.inputStorageKey,
    job.outputStorageKey,
    job.state,
    job.publicationState,
    job.compensationState,
    job.version,
    job.attemptCount,
    job.maxAttempts,
    job.compensationAttemptCount,
    job.maxCompensationAttempts,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    formatUtc(new Date(job.createdAtMs)),
    formatUtc(new Date(job.updatedAtMs)),
  ];
}

async function hasMatchingRegistration(
  executor: Pick<Pool, "execute"> | Pick<PoolConnection, "execute">,
  job: ImageJobSnapshot,
): Promise<boolean> {
  const [rows] = await executor.execute<UploadRegistrationRow[]>(
    `SELECT path, user_id, session_scope_hash, state, expires_at FROM uploaded_images
      WHERE path = ? AND user_id = ? AND session_scope_hash = ? AND state IN (1, 2) LIMIT 1`,
    [job.outputStorageKey, job.userId, Buffer.from(job.sessionScopeHash, "hex")],
  );
  return rows.length === 1;
}

function assertRegistrationMatchesJob(job: ImageJobSnapshot, upload: RegisterUploadInput): void {
  if (upload.path !== job.outputStorageKey || upload.userId !== job.userId
    || upload.sessionScopeHash !== job.sessionScopeHash
    || upload.expiresAt.getTime() !== job.ownershipExpiresAtMs) {
    throw codedError("Ready registration does not match its image job.", "IMAGE_JOB_REGISTRATION_MISMATCH");
  }
}

function dateMs(value: Date | string): number {
  const parsed = value instanceof Date ? new Date(value) : new Date(`${value.replace(" ", "T")}Z`);
  const result = parsed.getTime();
  if (!Number.isSafeInteger(result)) throw new Error("MariaDB returned an invalid image-job timestamp.");
  return result;
}

function nullableDateMs(value: Date | string | null): number | null {
  return value === null ? null : dateMs(value);
}

function nullableUtc(value: number | null): string | null {
  return value === null ? null : formatUtc(new Date(value));
}

function formatUtc(value: Date): string {
  return value.toISOString().slice(0, 23).replace("T", " ");
}

function safeInteger(value: string | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`MariaDB returned invalid ${label}.`);
  return parsed;
}

function nullableSafeInteger(value: number | null, label: string): number | null {
  return value === null ? null : safeInteger(value, label);
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`MariaDB returned incomplete ${label}.`);
  return value;
}

async function rollbackPreservingOriginal(connection: PoolConnection): Promise<void> {
  try {
    await connection.rollback();
  } catch {
    // The mutation error remains authoritative.
  }
}

function isMysqlDuplicate(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "errno" in error && (error as { errno?: unknown }).errno === 1062;
}

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

type SqlValue = string | number | bigint | boolean | Date | null | Buffer | Uint8Array;
