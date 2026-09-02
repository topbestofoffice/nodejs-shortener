import type { Pool, PoolConnection } from "mysql2/promise";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MysqlApplicationStore } from "../src/infrastructure/mysql-store.js";

const at = new Date("2026-09-01T12:34:56.000Z");
const expires = new Date("2026-10-01T12:34:56.000Z");
const selector = "a".repeat(24);
const validatorHash = hash("old-validator");
const rotatedHash = hash("new-validator");

describe("MariaDB auth-epoch ordering contract", () => {
  it("takes the shared epoch lock before creating any persistent credential", async () => {
    const fixture = transactionFixture();
    fixture.connection.execute
      .mockResolvedValueOnce([[{ svalue: "7" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await expect(fixture.store.createRememberToken({
      userId: 10,
      selector,
      validatorHash,
      expiresAt: expires,
      createdAt: at,
    })).resolves.toEqual({ authEpoch: 7 });

    expect(fixture.connection.beginTransaction).toHaveBeenCalledOnce();
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/auth_epoch.*LOCK IN SHARE MODE/s),
    );
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO remember_tokens"),
      [10, selector, validatorHash, "2026-10-01 12:34:56", "2026-09-01 12:34:56"],
    );
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
    expect(fixture.connection.rollback).not.toHaveBeenCalled();
    expect(fixture.connection.release).toHaveBeenCalledOnce();
  });

  it("locks epoch then token, validates and rotates before releasing the shared order", async () => {
    const fixture = transactionFixture();
    fixture.connection.execute
      .mockResolvedValueOnce([[{ svalue: "7" }], []])
      .mockResolvedValueOnce([[
        {
          id: "91",
          user_id: 10,
          selector,
          validator_hash: validatorHash,
          expires_at: expires,
        },
      ], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await expect(fixture.store.restoreRememberToken({
      selector,
      validatorHash,
      rotatedValidatorHash: rotatedHash,
      now: at,
      expiresAt: expires,
    })).resolves.toEqual({
      status: "rotated",
      userId: 10,
      selector,
      authEpoch: 7,
    });

    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/auth_epoch.*LOCK IN SHARE MODE/s),
    );
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/remember_tokens.*selector.*FOR UPDATE/s),
      [selector],
    );
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("UPDATE remember_tokens"),
      [rotatedHash, "2026-10-01 12:34:56", "91"],
    );
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
  });

  it("keeps the legacy ID-based rotation helper behind the same shared epoch lock", async () => {
    const fixture = transactionFixture();
    fixture.connection.execute
      .mockResolvedValueOnce([[{ svalue: "7" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await expect(fixture.store.rotateRememberToken("91", rotatedHash, expires))
      .resolves.toBeUndefined();

    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/auth_epoch.*LOCK IN SHARE MODE/s),
    );
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      2,
      "UPDATE remember_tokens SET validator_hash = ?, expires_at = ? WHERE id = ?",
      [rotatedHash, "2026-10-01 12:34:56", "91"],
    );
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
  });

  it("deletes a mismatched remember token inside the same ordered transaction", async () => {
    const fixture = transactionFixture();
    fixture.connection.execute
      .mockResolvedValueOnce([[{ svalue: "7" }], []])
      .mockResolvedValueOnce([[
        {
          id: "91",
          user_id: 10,
          selector,
          validator_hash: validatorHash,
          expires_at: expires,
        },
      ], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await expect(fixture.store.restoreRememberToken({
      selector,
      validatorHash: hash("wrong-validator"),
      rotatedValidatorHash: rotatedHash,
      now: at,
      expiresAt: expires,
    })).resolves.toEqual({ status: "invalid" });

    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      3,
      "DELETE FROM remember_tokens WHERE id = ?",
      ["91"],
    );
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
  });

  it("exclusively locks and bumps epoch, revokes all tokens, then issues only the Admin token", async () => {
    const fixture = transactionFixture();
    fixture.connection.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([[{ svalue: "7" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 12 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);

    await expect(fixture.store.resetAllAuthCredentials({
      adminUserId: 1,
      selector,
      validatorHash,
      expiresAt: expires,
      createdAt: at,
    })).resolves.toEqual({ authEpoch: 8 });

    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO settings"),
    );
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/auth_epoch.*FOR UPDATE/s),
    );
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      3,
      "UPDATE settings SET svalue = ? WHERE skey = 'auth_epoch'",
      ["8"],
    );
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(4, "DELETE FROM remember_tokens");
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining("INSERT INTO remember_tokens"),
      [1, selector, validatorHash, "2026-10-01 12:34:56", "2026-09-01 12:34:56"],
    );
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
    expect(fixture.connection.rollback).not.toHaveBeenCalled();
  });

  it("rolls back and never retries an unacknowledged global reset mutation", async () => {
    const fixture = transactionFixture();
    const lost = new Error("commit acknowledgement lost");
    fixture.connection.execute
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([[{ svalue: "7" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 12 }, []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    fixture.connection.commit.mockRejectedValueOnce(lost);

    await expect(fixture.store.resetAllAuthCredentials({
      adminUserId: 1,
      selector,
      validatorHash,
      expiresAt: expires,
      createdAt: at,
    })).rejects.toBe(lost);

    expect(fixture.connection.commit).toHaveBeenCalledOnce();
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.connection.execute).toHaveBeenCalledTimes(5);
    expect(fixture.connection.release).toHaveBeenCalledOnce();
  });
});

function transactionFixture(): {
  readonly store: MysqlApplicationStore;
  readonly connection: {
    readonly beginTransaction: ReturnType<typeof vi.fn>;
    readonly execute: ReturnType<typeof vi.fn>;
    readonly commit: ReturnType<typeof vi.fn>;
    readonly rollback: ReturnType<typeof vi.fn>;
    readonly release: ReturnType<typeof vi.fn>;
  };
} {
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute: vi.fn(),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(() => undefined),
  };
  const pool = {
    getConnection: vi.fn(async () => connection as unknown as PoolConnection),
  } as unknown as Pool;
  const store = Object.create(MysqlApplicationStore.prototype) as MysqlApplicationStore;
  Object.defineProperty(store, "pool", { value: pool, writable: false });
  return { store, connection };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
