import { describe, expect, it, vi } from "vitest";
import { MysqlApplicationStore } from "../src/infrastructure/mysql-store.js";
import type { CreateRegisteredUserInput } from "../src/ports.js";

const registeredUser: CreateRegisteredUserInput = {
  username: "New.User",
  passwordHash: "$2y$synthetic",
  role: "user",
  createdAt: new Date("2026-08-23T12:34:56.000Z"),
};

describe("public registration MariaDB contract", () => {
  it("treats only the exact global setting value 1 as enabled", async () => {
    const enabled = fakeStore();
    enabled.execute.mockResolvedValueOnce([[{ svalue: "1" }], []]);
    await expect(enabled.store.isRegistrationEnabled()).resolves.toBe(true);
    expect(enabled.execute).toHaveBeenCalledWith(
      "SELECT svalue FROM settings WHERE skey = 'registration_enabled' LIMIT 1",
    );

    const missing = fakeStore();
    missing.execute.mockResolvedValueOnce([[], []]);
    await expect(missing.store.isRegistrationEnabled()).resolves.toBe(false);

    const nonExact = fakeStore();
    nonExact.execute.mockResolvedValueOnce([[{ svalue: "true" }], []]);
    await expect(nonExact.store.isRegistrationEnabled()).resolves.toBe(false);
  });

  it("passes the case-preserving username to the indexed ascii_bin lookup", async () => {
    const fixture = fakeStore();
    fixture.execute.mockResolvedValueOnce([[{ found: 1 }], []]);

    await expect(fixture.store.usernameExists("Case.User")).resolves.toBe(true);

    expect(fixture.execute).toHaveBeenCalledWith(
      "SELECT 1 FROM users WHERE username = ? LIMIT 1",
      ["Case.User"],
    );
  });

  it("uses the captured INSERT shape, forced role and exact timestamp", async () => {
    const fixture = fakeStore();
    fixture.execute.mockResolvedValueOnce([{ affectedRows: 1, insertId: 42 }, []]);

    await expect(fixture.store.createUser(registeredUser)).resolves.toBe(42);

    expect(fixture.execute).toHaveBeenCalledWith(
      "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
      ["New.User", "$2y$synthetic", "user", "2026-08-23 12:34:56"],
    );
  });

  it("accepts a lost autocommit acknowledgement only after one exact fresh readback", async () => {
    const fixture = fakeStore();
    const lostAcknowledgement = ambiguousMutationError();
    fixture.execute
      .mockRejectedValueOnce(lostAcknowledgement)
      .mockResolvedValueOnce([[committedUserRow()], []]);

    await expect(fixture.store.createUser(registeredUser)).resolves.toBe(42);

    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.execute).toHaveBeenNthCalledWith(
      1,
      "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
      ["New.User", "$2y$synthetic", "user", "2026-08-23 12:34:56"],
    );
    expect(fixture.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("DATE_FORMAT(created_at"),
      ["New.User"],
    );
    expect(fixture.execute.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO users")))
      .toHaveLength(1);
  });

  it("uses the same exact readback when the INSERT result confirms one row but omits its identity", async () => {
    const fixture = fakeStore();
    fixture.execute
      .mockResolvedValueOnce([{ affectedRows: 1, insertId: 0 }, []])
      .mockResolvedValueOnce([[committedUserRow()], []]);

    await expect(fixture.store.createUser(registeredUser)).resolves.toBe(42);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.execute.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO users")))
      .toHaveLength(1);
  });

  it.each([
    ["identity", { id: "9007199254740992" }],
    ["username", { username: "new.user" }],
    ["password hash", { password_hash: "$2y$different" }],
    ["role", { role: "admin" }],
    ["timestamp", { created_at_utc: "2026-08-23 12:34:57" }],
  ])("preserves the ambiguous insert error when the %s readback differs", async (_label, change) => {
    const fixture = fakeStore();
    const lostAcknowledgement = ambiguousMutationError();
    fixture.execute
      .mockRejectedValueOnce(lostAcknowledgement)
      .mockResolvedValueOnce([[{ ...committedUserRow(), ...change }], []]);

    await expect(fixture.store.createUser(registeredUser)).rejects.toBe(lostAcknowledgement);

    expect(fixture.execute).toHaveBeenCalledTimes(2);
    expect(fixture.execute.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO users")))
      .toHaveLength(1);
  });

  it("preserves the original ambiguous error when the exact readback is unavailable", async () => {
    const fixture = fakeStore();
    const lostAcknowledgement = ambiguousMutationError();
    fixture.execute
      .mockRejectedValueOnce(lostAcknowledgement)
      .mockRejectedValueOnce(new Error("readback unavailable"));

    await expect(fixture.store.createUser(registeredUser)).rejects.toBe(lostAcknowledgement);
    expect(fixture.execute).toHaveBeenCalledTimes(2);
  });

  it("does not read back or expose a duplicate insert as a newly created account", async () => {
    const fixture = fakeStore();
    const duplicate = Object.assign(new Error("duplicate detail"), {
      code: "ER_DUP_ENTRY",
      errno: 1062,
      fatal: true,
    });
    fixture.execute.mockRejectedValueOnce(duplicate);

    await expect(fixture.store.createUser(registeredUser)).rejects.toBe(duplicate);
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("does not perform ambiguity readback for a definite server-side rejection", async () => {
    const fixture = fakeStore();
    const rejected = Object.assign(new Error("column rejected"), {
      code: "ER_DATA_TOO_LONG",
      errno: 1406,
      fatal: false,
    });
    fixture.execute.mockRejectedValueOnce(rejected);

    await expect(fixture.store.createUser(registeredUser)).rejects.toBe(rejected);
    expect(fixture.execute).toHaveBeenCalledOnce();
  });

  it("rejects a missing-user default-domain update instead of reporting success", async () => {
    const fixture = fakeStore();
    fixture.execute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);

    await expect(fixture.store.setDefaultDomain(999, 2)).rejects.toThrow(
      "Default domain could not be saved.",
    );
  });

  it.each([1, 2])("accepts exactly one affected default-domain row, not %i rows", async (affectedRows) => {
    const fixture = fakeStore();
    fixture.execute.mockResolvedValueOnce([{ affectedRows }, []]);

    const operation = fixture.store.setDefaultDomain(10, 2);
    if (affectedRows === 1) {
      await expect(operation).resolves.toBeUndefined();
    } else {
      await expect(operation).rejects.toThrow("Default domain could not be saved.");
    }
  });
});

function fakeStore(): {
  readonly store: MysqlApplicationStore;
  readonly execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn();
  const store = Object.create(MysqlApplicationStore.prototype) as MysqlApplicationStore;
  Object.defineProperty(store, "pool", {
    configurable: false,
    enumerable: true,
    value: { execute },
    writable: false,
  });
  return { store, execute };
}

function ambiguousMutationError(): Error & { readonly code: string; readonly errno: number; readonly fatal: true } {
  return Object.assign(new Error("insert acknowledgement lost"), {
    code: "PROTOCOL_CONNECTION_LOST",
    errno: 2013,
    fatal: true as const,
  });
}

function committedUserRow(): Record<string, string | number> {
  return {
    id: "42",
    username: registeredUser.username,
    password_hash: registeredUser.passwordHash,
    role: registeredUser.role,
    created_at_utc: "2026-08-23 12:34:56",
  };
}
