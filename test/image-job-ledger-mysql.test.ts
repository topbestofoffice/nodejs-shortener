import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { MysqlImageJobStore } from "../src/infrastructure/mysql-image-job-store.js";
import {
  createImageJob,
  isImageJobAttachable,
  transitionImageJob,
  type ImageJobSnapshot,
  type NewImageJob,
} from "../src/modules/uploads/job-ledger-policy.js";

const baseMs = Date.parse("2026-09-01T12:00:00.000Z");

describe("MysqlImageJobStore transaction contracts", () => {
  it("rolls back an uncommitted insert anomaly and a duplicate without matching idempotency keys", async () => {
    const proposal = newJob();
    for (const mode of ["short-insert", "orphan-duplicate"] as const) {
      const connection = {
        beginTransaction: vi.fn(async () => undefined),
        execute: vi.fn(async (sql: string) => {
          if (sql.includes("INSERT INTO image_job_ledger_v1")) {
            if (mode === "short-insert") return [{ affectedRows: 0 }, []];
            throw Object.assign(new Error("duplicate"), { errno: 1062 });
          }
          if (sql.includes("FOR UPDATE")) return [[], []];
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        destroy: vi.fn(() => undefined),
        release: vi.fn(() => undefined),
      };
      const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;

      if (mode === "short-insert") {
        await expect(new MysqlImageJobStore(pool).reserveImageJob(proposal, baseMs))
          .rejects.toThrow("was not inserted");
      } else {
        await expect(new MysqlImageJobStore(pool).reserveImageJob(proposal, baseMs))
          .rejects.toMatchObject({ code: "IMAGE_JOB_STORAGE_CONFLICT" });
      }
      expect(connection.rollback).toHaveBeenCalledOnce();
      expect(connection.release).toHaveBeenCalledOnce();
      expect(connection.commit).not.toHaveBeenCalled();
    }
  });

  it("resolves a duplicate row inside the original transaction without a second insert", async () => {
    const proposal = newJob();
    const existing = createImageJob(proposal, baseMs);
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO image_job_ledger_v1")) {
          throw Object.assign(new Error("duplicate"), { errno: 1062 });
        }
        if (sql.includes("FOR UPDATE")) return [[rowFromJob(existing)], []];
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;

    await expect(new MysqlImageJobStore(pool).reserveImageJob(proposal, baseMs))
      .resolves.toMatchObject({ kind: "reuse", job: { jobId: proposal.jobId } });
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(connection.rollback).not.toHaveBeenCalled();
  });

  it("resolves a lost insert commit acknowledgement through a fresh exact-key readback", async () => {
    const proposal = newJob();
    const committed = createImageJob(proposal, baseMs);
    const commitError = new Error("commit acknowledgement lost");
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("INSERT INTO image_job_ledger_v1")) return [{ affectedRows: 1 }, []];
        throw new Error(`Unexpected connection SQL: ${sql}`);
      }),
      commit: vi.fn(async () => Promise.reject(commitError)),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = {
      getConnection: vi.fn(async () => connection),
      execute: vi.fn(async (sql: string) => {
        expect(sql).toContain("WHERE request_key = ? OR job_id = ?");
        return [[rowFromJob(committed)], []];
      }),
    } as unknown as Pool;

    const decision = await new MysqlImageJobStore(pool).reserveImageJob(proposal, baseMs);

    expect(decision).toMatchObject({ kind: "reuse", job: { jobId: proposal.jobId } });
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });

  it("preserves the original lost-commit error when fresh readback proves no ledger row", async () => {
    const proposal = newJob();
    const commitError = new Error("commit acknowledgement lost");
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string) => sql.includes("INSERT INTO image_job_ledger_v1")
        ? [{ affectedRows: 1 }, []]
        : Promise.reject(new Error(`Unexpected SQL: ${sql}`))),
      commit: vi.fn(async () => Promise.reject(commitError)),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = {
      getConnection: vi.fn(async () => connection),
      execute: vi.fn(async () => [[], []]),
    } as unknown as Pool;

    await expect(new MysqlImageJobStore(pool).reserveImageJob(proposal, baseMs)).rejects.toBe(commitError);
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
  });

  it("distinguishes request-key and job-id conflicts instead of merging unrelated rows", async () => {
    const proposal = newJob();
    for (const matching of ["request", "job"] as const) {
      const conflicting = {
        ...rowFromJob(createImageJob(proposal, baseMs)),
        ...(matching === "request" ? { job_id: "2".repeat(32) } : { request_key: "d".repeat(64) }),
      };
      const connection = {
        beginTransaction: vi.fn(async () => undefined),
        execute: vi.fn(async (sql: string) => {
          if (sql.includes("INSERT INTO image_job_ledger_v1")) {
            throw Object.assign(new Error("duplicate"), { errno: 1062 });
          }
          return [[conflicting], []];
        }),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        destroy: vi.fn(() => undefined),
        release: vi.fn(() => undefined),
      };
      const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;

      const operation = new MysqlImageJobStore(pool).reserveImageJob(proposal, baseMs);
      if (matching === "request") {
        await expect(operation).resolves.toMatchObject({
          kind: "reuse",
          job: { jobId: "2".repeat(32), requestKey: proposal.requestKey },
        });
        expect(connection.commit).toHaveBeenCalledOnce();
        expect(connection.rollback).not.toHaveBeenCalled();
      } else {
        await expect(operation).rejects.toBeInstanceOf(Error);
        expect(connection.rollback).toHaveBeenCalledOnce();
      }
      expect(connection.release).toHaveBeenCalledOnce();
    }
  });

  it("commits the ready registration and ledger CAS in one capacity-locked transaction", async () => {
    const publishing = publishingJob();
    const operations: string[] = [];
    const connection = {
      beginTransaction: vi.fn(async () => { operations.push("begin"); }),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("FROM image_job_ledger_v1") && sql.includes("FOR UPDATE")) {
          operations.push("lock-ledger");
          return [[rowFromJob(publishing)], []];
        }
        if (sql.includes("COUNT(*) AS total FROM uploaded_images") && sql.includes("session_scope_hash")) {
          operations.push("count-scope");
          return [[{ total: 0 }], []];
        }
        if (sql.includes("INSERT INTO uploaded_images")) {
          operations.push("insert-registration");
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes("UPDATE image_job_ledger_v1")) {
          operations.push("cas-ledger");
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected execute SQL: ${sql}`);
      }),
      query: vi.fn(async (sql: string) => {
        if (sql.includes("GET_LOCK")) {
          operations.push("capacity-lock");
          return [[{ acquired: 1 }], []];
        }
        if (sql.includes("COUNT(*) AS total")) {
          operations.push("count-total");
          return [[{ total: 0 }], []];
        }
        if (sql.includes("RELEASE_LOCK")) {
          operations.push("capacity-unlock");
          return [[{ released: 1 }], []];
        }
        throw new Error(`Unexpected query SQL: ${sql}`);
      }),
      commit: vi.fn(async () => { operations.push("commit"); }),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;
    const store = new MysqlImageJobStore(pool);

    const ready = await store.publishImageJobReady(publishing.jobId, {
      type: "mark_ready",
      expectedVersion: publishing.version,
      atMs: baseMs + 5,
      leaseToken: publishing.lease?.token ?? "",
      finalArtifactPublished: true,
      readyRegistrationCommitted: true,
    }, {
      path: publishing.outputStorageKey,
      userId: publishing.userId,
      sessionScopeHash: publishing.sessionScopeHash,
      createdAt: new Date(baseMs + 5),
      expiresAt: new Date(publishing.ownershipExpiresAtMs),
    }, { readyPerSession: 50, readyTotal: 1_000 });

    expect(isImageJobAttachable(ready)).toBe(true);
    expect(operations).toEqual([
      "capacity-lock",
      "begin",
      "lock-ledger",
      "count-scope",
      "count-total",
      "insert-registration",
      "cas-ledger",
      "commit",
      "capacity-unlock",
    ]);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("rolls back without deleting or advancing when a link references compensation output", async () => {
    const compensating = compensatingJob();
    const mutationSql: string[] = [];
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("FROM image_job_ledger_v1") && sql.includes("FOR UPDATE")) {
          return [[rowFromJob(compensating)], []];
        }
        if (sql.includes("FROM uploaded_images")) return [[], []];
        if (sql.includes("FROM links WHERE image")) return [[{ id: "9001" }], []];
        if (sql.includes("DELETE") || sql.includes("UPDATE")) mutationSql.push(sql);
        throw new Error(`Unexpected mutation SQL: ${sql}`);
      }),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;

    await expect(new MysqlImageJobStore(pool).completeImageJobCompensation(compensating.jobId, {
      type: "mark_compensated",
      expectedVersion: compensating.version,
      atMs: baseMs + 7,
      leaseToken: compensating.lease?.token ?? "",
      finalArtifactAbsent: true,
      readyRegistrationAbsent: true,
    })).rejects.toMatchObject({ code: "IMAGE_JOB_REFERENCED" });

    expect(mutationSql).toEqual([]);
    expect(connection.commit).not.toHaveBeenCalled();
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("transitions under a row lock and fails closed on a missing or stale ledger row", async () => {
    const requested = createImageJob(newJob(), baseMs);
    const enqueue = {
      type: "enqueue" as const,
      expectedVersion: requested.version,
      atMs: baseMs + 1,
      notBeforeMs: baseMs + 1,
    };

    for (const mode of ["success", "missing", "stale"] as const) {
      const connection = {
        beginTransaction: vi.fn(async () => undefined),
        execute: vi.fn(async (sql: string) => {
          if (sql.includes("FOR UPDATE")) {
            return mode === "missing" ? [[], []] : [[rowFromJob(requested)], []];
          }
          if (sql.includes("UPDATE image_job_ledger_v1")) {
            return [{ affectedRows: mode === "stale" ? 0 : 1 }, []];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        destroy: vi.fn(() => undefined),
        release: vi.fn(() => undefined),
      };
      const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;
      const operation = new MysqlImageJobStore(pool).transitionImageJob(requested.jobId, enqueue);

      if (mode === "success") {
        await expect(operation).resolves.toMatchObject({ state: "queued", version: 1 });
        expect(connection.commit).toHaveBeenCalledOnce();
      } else {
        await expect(operation).rejects.toMatchObject({
          code: mode === "missing" ? "IMAGE_JOB_NOT_FOUND" : "IMAGE_JOB_STALE_VERSION",
        });
        expect(connection.rollback).toHaveBeenCalledOnce();
      }
      expect(connection.release).toHaveBeenCalledOnce();
    }
  });

  it("validates recovery windows and maps exact persisted rows", async () => {
    const requested = createImageJob(newJob(), baseMs);
    const execute = vi.fn(async () => [[rowFromJob(requested)], []]);
    const store = new MysqlImageJobStore({ execute } as unknown as Pool);

    for (const [nowMs, limit] of [
      [-1, 1], [1.5, 1], [baseMs, 0], [baseMs, 101], [baseMs, 1.5],
    ] as const) {
      await expect(store.listImageJobsForRecovery(nowMs, limit)).rejects.toThrow("Invalid image-job recovery window");
    }
    await expect(store.listImageJobsForRecovery(baseMs, 1)).resolves.toEqual([requested]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns null for an absent job and proves ready registration only for an attachable row", async () => {
    const requested = createImageJob(newJob(), baseMs);
    const ready = readyJob();

    const absent = new MysqlImageJobStore({
      execute: vi.fn(async () => [[], []]),
    } as unknown as Pool);
    await expect(absent.getImageJob(requested.jobId)).resolves.toBeNull();
    await expect(absent.hasReadyImageRegistration(requested.jobId)).resolves.toBe(false);

    const nonAttachable = new MysqlImageJobStore({
      execute: vi.fn(async () => [[rowFromJob(requested)], []]),
    } as unknown as Pool);
    await expect(nonAttachable.hasReadyImageRegistration(requested.jobId)).resolves.toBe(false);

    for (const registrationPresent of [false, true]) {
      const execute = vi.fn(async (sql: string) => sql.includes("FROM image_job_ledger_v1")
        ? [[rowFromJob(ready)], []]
        : [registrationPresent ? [{ path: ready.outputStorageKey }] : [], []]);
      const store = new MysqlImageJobStore({ execute } as unknown as Pool);
      await expect(store.hasReadyImageRegistration(ready.jobId)).resolves.toBe(registrationPresent);
    }
  });

  it("rejects an unavailable capacity lock without opening a transaction", async () => {
    const connection = {
      query: vi.fn(async () => [[{ acquired: 0 }], []]),
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async () => [[], []]),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;
    const publishing = publishingJob();

    await expect(new MysqlImageJobStore(pool).publishImageJobReady(
      publishing.jobId,
      readyCommand(publishing),
      uploadFor(publishing),
      { readyPerSession: 50, readyTotal: 1_000 },
    )).rejects.toMatchObject({ code: "UPLOAD_CAPACITY_UNAVAILABLE" });
    expect(connection.beginTransaction).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledOnce();
  });

  it("accepts an already-ready job only when its ready registration still exists", async () => {
    const ready = readyJob();
    for (const registrationPresent of [true, false]) {
      const connection = {
        query: vi.fn(async (sql: string) => sql.includes("GET_LOCK")
          ? [[{ acquired: 1 }], []]
          : [[{ released: 1 }], []]),
        beginTransaction: vi.fn(async () => undefined),
        execute: vi.fn(async (sql: string) => {
          if (sql.includes("FROM image_job_ledger_v1")) return [[rowFromJob(ready)], []];
          if (sql.includes("FROM uploaded_images")) {
            return [registrationPresent ? [{ path: ready.outputStorageKey }] : [], []];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        destroy: vi.fn(() => undefined),
        release: vi.fn(() => undefined),
      };
      const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;
      const operation = new MysqlImageJobStore(pool).publishImageJobReady(
        ready.jobId,
        readyCommand(ready),
        uploadFor(ready),
        { readyPerSession: 50, readyTotal: 1_000 },
      );

      if (registrationPresent) {
        await expect(operation).resolves.toEqual(ready);
        expect(connection.commit).toHaveBeenCalledOnce();
      } else {
        await expect(operation).rejects.toThrow("registration is missing");
        expect(connection.rollback).toHaveBeenCalledOnce();
      }
      expect(connection.release).toHaveBeenCalledOnce();
    }
  });

  it("rejects a ready-registration tuple that does not belong to the locked image job", async () => {
    const publishing = publishingJob();
    const connection = {
      query: vi.fn(async (sql: string) => sql.includes("GET_LOCK")
        ? [[{ acquired: 1 }], []]
        : [[{ released: 1 }], []]),
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string) => sql.includes("FROM image_job_ledger_v1")
        ? [[rowFromJob(publishing)], []]
        : Promise.reject(new Error(`Unexpected SQL: ${sql}`))),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;

    await expect(new MysqlImageJobStore(pool).publishImageJobReady(
      publishing.jobId,
      readyCommand(publishing),
      { ...uploadFor(publishing), path: "uploads/fedcba9876543210.jpg" },
      { readyPerSession: 50, readyTotal: 1_000 },
    )).rejects.toMatchObject({ code: "IMAGE_JOB_REGISTRATION_MISMATCH" });
    expect(connection.rollback).toHaveBeenCalledOnce();
  });

  it("enforces both capacity dimensions and destroys a connection after a failed unlock", async () => {
    const publishing = publishingJob();
    for (const full of ["session", "global"] as const) {
      const connection = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }], []];
          if (sql.includes("COUNT(*) AS total")) return [[{ total: full === "global" ? 1_000 : 0 }], []];
          if (sql.includes("RELEASE_LOCK")) return [[{ released: 0 }], []];
          throw new Error(`Unexpected query SQL: ${sql}`);
        }),
        beginTransaction: vi.fn(async () => undefined),
        execute: vi.fn(async (sql: string) => {
          if (sql.includes("FOR UPDATE")) return [[rowFromJob(publishing)], []];
          if (sql.includes("COUNT(*) AS total")) return [[{ total: full === "session" ? 50 : 0 }], []];
          throw new Error(`Unexpected execute SQL: ${sql}`);
        }),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        destroy: vi.fn(() => undefined),
        release: vi.fn(() => undefined),
      };
      const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;

      await expect(new MysqlImageJobStore(pool).publishImageJobReady(
        publishing.jobId,
        readyCommand(publishing),
        uploadFor(publishing),
        { readyPerSession: 50, readyTotal: 1_000 },
      )).rejects.toMatchObject({
        code: full === "session" ? "SESSION_UPLOAD_LIMIT" : "GLOBAL_UPLOAD_LIMIT",
      });
      expect(connection.rollback).toHaveBeenCalledOnce();
      expect(connection.destroy).toHaveBeenCalledOnce();
      expect(connection.release).not.toHaveBeenCalled();
    }
  });

  it("completes safe compensation and removes an unconsumed ready registration atomically", async () => {
    const compensating = compensatingJob();
    const operations: string[] = [];
    const connection = {
      beginTransaction: vi.fn(async () => { operations.push("begin"); }),
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("FROM image_job_ledger_v1")) return [[rowFromJob(compensating)], []];
        if (sql.includes("DELETE FROM uploaded_images")) {
          operations.push("delete-ready");
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes("FROM uploaded_images")) return [[{
          path: compensating.outputStorageKey,
          user_id: compensating.userId,
          session_scope_hash: Buffer.from(compensating.sessionScopeHash, "hex"),
          state: 1,
          expires_at: new Date(compensating.ownershipExpiresAtMs),
        }], []];
        if (sql.includes("FROM links")) return [[], []];
        if (sql.includes("UPDATE image_job_ledger_v1")) {
          operations.push("update-ledger");
          return [{ affectedRows: 1 }, []];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
      commit: vi.fn(async () => { operations.push("commit"); }),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;

    await expect(new MysqlImageJobStore(pool).completeImageJobCompensation(compensating.jobId, {
      type: "mark_compensated",
      expectedVersion: compensating.version,
      atMs: baseMs + 7,
      leaseToken: compensating.lease?.token ?? "",
      finalArtifactAbsent: true,
      readyRegistrationAbsent: true,
    })).resolves.toMatchObject({ state: "compensated" });
    expect(operations).toEqual(["begin", "delete-ready", "update-ledger", "commit"]);
  });

  it("proves compensation safety and rejects attached or referenced images under the same lock", async () => {
    const compensating = compensatingJob();
    for (const mode of ["safe", "attached", "referenced"] as const) {
      const connection = {
        beginTransaction: vi.fn(async () => undefined),
        execute: vi.fn(async (sql: string) => {
          if (sql.includes("FROM image_job_ledger_v1")) return [[rowFromJob(compensating)], []];
          if (sql.includes("FROM uploaded_images")) {
            return [mode === "attached" ? [{ state: 2 }] : [], []];
          }
          if (sql.includes("FROM links")) {
            return [mode === "referenced" ? [{ id: "9001" }] : [], []];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        destroy: vi.fn(() => undefined),
        release: vi.fn(() => undefined),
      };
      const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;
      const operation = new MysqlImageJobStore(pool).assertImageJobCompensationSafe(compensating.jobId);

      if (mode === "safe") {
        await expect(operation).resolves.toBeUndefined();
        expect(connection.commit).toHaveBeenCalledOnce();
      } else {
        await expect(operation).rejects.toMatchObject({
          code: mode === "attached" ? "IMAGE_JOB_ATTACHED" : "IMAGE_JOB_REFERENCED",
        });
        expect(connection.rollback).toHaveBeenCalledOnce();
      }
      expect(connection.release).toHaveBeenCalledOnce();
    }
  });

  it("rejects attached compensation and compensates safely when no ready registration exists", async () => {
    const compensating = compensatingJob();
    for (const mode of ["attached", "absent"] as const) {
      const connection = {
        beginTransaction: vi.fn(async () => undefined),
        execute: vi.fn(async (sql: string) => {
          if (sql.includes("FROM image_job_ledger_v1")) return [[rowFromJob(compensating)], []];
          if (sql.includes("FROM uploaded_images")) return [mode === "attached" ? [{ state: 2 }] : [], []];
          if (sql.includes("FROM links")) return [[], []];
          if (sql.includes("UPDATE image_job_ledger_v1")) return [{ affectedRows: 1 }, []];
          throw new Error(`Unexpected SQL: ${sql}`);
        }),
        commit: vi.fn(async () => undefined),
        rollback: vi.fn(async () => undefined),
        destroy: vi.fn(() => undefined),
        release: vi.fn(() => undefined),
      };
      const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;
      const operation = new MysqlImageJobStore(pool).completeImageJobCompensation(
        compensating.jobId,
        compensatedCommand(compensating),
      );

      if (mode === "attached") {
        await expect(operation).rejects.toMatchObject({ code: "IMAGE_JOB_ATTACHED" });
        expect(connection.rollback).toHaveBeenCalledOnce();
      } else {
        await expect(operation).resolves.toMatchObject({ state: "compensated" });
        expect(connection.commit).toHaveBeenCalledOnce();
      }
    }
  });
});

function publishingJob(): ImageJobSnapshot {
  let job = createImageJob(newJob(), baseMs);
  job = transitionImageJob(job, {
    type: "enqueue",
    expectedVersion: job.version,
    atMs: baseMs + 1,
    notBeforeMs: baseMs + 1,
  });
  job = transitionImageJob(job, {
    type: "claim_processing",
    expectedVersion: job.version,
    atMs: baseMs + 2,
    leaseOwner: "worker-a",
    leaseToken: "c".repeat(32),
    leaseExpiresAtMs: baseMs + 100,
  });
  job = transitionImageJob(job, {
    type: "record_output_ready",
    expectedVersion: job.version,
    atMs: baseMs + 3,
    leaseToken: "c".repeat(32),
    sourceWidth: 10,
    sourceHeight: 20,
  });
  return transitionImageJob(job, {
    type: "begin_publication",
    expectedVersion: job.version,
    atMs: baseMs + 4,
    leaseToken: "c".repeat(32),
  });
}

function compensatingJob(): ImageJobSnapshot {
  let job = publishingJob();
  job = transitionImageJob(job, {
    type: "record_failure",
    expectedVersion: job.version,
    atMs: baseMs + 5,
    leaseToken: "c".repeat(32),
    errorCode: "AMBIGUOUS_PUBLICATION",
    publicationMayHaveOccurred: true,
    privateOutputRemoved: false,
    retryAtMs: baseMs + 5,
  });
  return transitionImageJob(job, {
    type: "claim_compensation",
    expectedVersion: job.version,
    atMs: baseMs + 6,
    leaseOwner: "compensator",
    leaseToken: "d".repeat(32),
    leaseExpiresAtMs: baseMs + 100,
  });
}

function readyJob(): ImageJobSnapshot {
  const publishing = publishingJob();
  return transitionImageJob(publishing, readyCommand(publishing));
}

function readyCommand(job: ImageJobSnapshot) {
  return {
    type: "mark_ready" as const,
    expectedVersion: job.version,
    atMs: baseMs + 5,
    leaseToken: job.lease?.token ?? "",
    finalArtifactPublished: true as const,
    readyRegistrationCommitted: true as const,
  };
}

function uploadFor(job: ImageJobSnapshot) {
  return {
    path: job.outputStorageKey,
    userId: job.userId,
    sessionScopeHash: job.sessionScopeHash,
    createdAt: new Date(baseMs + 5),
    expiresAt: new Date(job.ownershipExpiresAtMs),
  };
}

function compensatedCommand(job: ImageJobSnapshot) {
  return {
    type: "mark_compensated" as const,
    expectedVersion: job.version,
    atMs: baseMs + 7,
    leaseToken: job.lease?.token ?? "",
    finalArtifactAbsent: true as const,
    readyRegistrationAbsent: true as const,
  };
}

function newJob(): NewImageJob {
  return {
    jobId: "1".repeat(32),
    requestKey: "a".repeat(64),
    payloadHash: "b".repeat(64),
    domainId: 1,
    userId: 7,
    sessionScopeHash: "c".repeat(64),
    ownershipExpiresAtMs: baseMs + 86_400_000,
    inputStorageKey: `private/job-${"1".repeat(32)}.input`,
    outputStorageKey: "uploads/0000000000000001.jpg",
    maxAttempts: 3,
    maxCompensationAttempts: 5,
  };
}

function rowFromJob(job: ImageJobSnapshot): Record<string, unknown> {
  return {
    job_id: job.jobId,
    request_key: job.requestKey,
    payload_hash: job.payloadHash,
    domain_id: job.domainId,
    user_id: job.userId,
    session_scope_hash: job.sessionScopeHash,
    ownership_expires_at: new Date(job.ownershipExpiresAtMs),
    input_storage_key: job.inputStorageKey,
    output_storage_key: job.outputStorageKey,
    state: job.state,
    publication_state: job.publicationState,
    compensation_state: job.compensationState,
    version: job.version,
    attempt_count: job.attemptCount,
    max_attempts: job.maxAttempts,
    compensation_attempt_count: job.compensationAttemptCount,
    max_compensation_attempts: job.maxCompensationAttempts,
    next_attempt_at: nullableDate(job.nextAttemptAtMs),
    first_attempt_at: nullableDate(job.firstAttemptAtMs),
    last_attempt_at: nullableDate(job.lastAttemptAtMs),
    last_compensation_attempt_at: nullableDate(job.lastCompensationAttemptAtMs),
    lease_owner: job.lease?.owner ?? null,
    lease_token: job.lease?.token ?? null,
    lease_acquired_at: nullableDate(job.lease?.acquiredAtMs ?? null),
    lease_expires_at: nullableDate(job.lease?.expiresAtMs ?? null),
    output_ready_at: nullableDate(job.outputReadyAtMs),
    result_source_width: job.resultSourceWidth,
    result_source_height: job.resultSourceHeight,
    published_at: nullableDate(job.publishedAtMs),
    ready_at: nullableDate(job.readyAtMs),
    failed_at: nullableDate(job.failedAtMs),
    compensation_requested_at: nullableDate(job.compensationRequestedAtMs),
    compensated_at: nullableDate(job.compensatedAtMs),
    last_error_code: job.lastErrorCode,
    created_at: new Date(job.createdAtMs),
    updated_at: new Date(job.updatedAtMs),
  };
}

function nullableDate(value: number | null): Date | null {
  return value === null ? null : new Date(value);
}
