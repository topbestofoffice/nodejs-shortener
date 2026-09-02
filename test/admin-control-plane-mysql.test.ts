import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { MysqlControlPlaneStore } from "../src/infrastructure/mysql-control-plane-store.js";

describe("MysqlControlPlaneStore", () => {
  it("reuses the caller-owned pool and reads bounded domain state", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([[
        { skey: "skim_enabled", svalue: "1" },
        { skey: "skim_destination_url", svalue: "https://landing.example/" },
        { skey: "skim_default_percent", svalue: "25" },
        { skey: "skim_quality_policy_v1", svalue: '{"active":true,"scope":"selected","countries":["IN"]}' },
      ], []])
      .mockResolvedValueOnce([[
        { country_code: "IN", percent: 30 },
        { country_code: "US", percent: "10" },
      ], []]);
    const pool = { execute } as unknown as Pool;
    const store = new MysqlControlPlaneStore(pool);

    expect(store.pool).toBe(pool);
    await expect(store.loadDomainState(2)).resolves.toEqual({
      skim: { enabled: true, destinationUrl: "https://landing.example/", defaultPercent: 25 },
      geoRules: [
        { countryCode: "IN", percent: 30 },
        { countryCode: "US", percent: 10 },
      ],
      qualityPolicy: { active: true, scope: "selected", countries: ["IN"] },
    });
    expect(execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("FROM domain_settings"),
      [2, "skim_enabled", "skim_destination_url", "skim_default_percent", "skim_quality_policy_v1"],
    );
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("FROM geo_rules"),
      [2],
    );
  });

  it("saves skim settings as one transaction and never owns connection shutdown", async () => {
    const fixture = transactionFixture();
    const store = new MysqlControlPlaneStore(fixture.pool);

    await store.saveSkimSettings(2, {
      enabled: true,
      destinationUrl: "https://landing.example/path",
      defaultPercent: 40,
    });

    expect(fixture.connection.beginTransaction).toHaveBeenCalledOnce();
    expect(fixture.connection.execute).toHaveBeenCalledTimes(3);
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("INSERT INTO domain_settings"),
      [2, "skim_enabled", "1"],
    );
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("INSERT INTO domain_settings"),
      [2, "skim_destination_url", "https://landing.example/path"],
    );
    expect(fixture.connection.execute).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO domain_settings"),
      [2, "skim_default_percent", "40"],
    );
    expect(fixture.connection.commit).toHaveBeenCalledOnce();
    expect(fixture.connection.rollback).not.toHaveBeenCalled();
    expect(fixture.connection.release).toHaveBeenCalledOnce();
  });

  it("rolls back the complete geo and Quality mutation after any write failure", async () => {
    const fixture = transactionFixture();
    fixture.connection.execute
      .mockResolvedValueOnce([{ affectedRows: 2 }, []])
      .mockRejectedValueOnce(new Error("country insert failed"));
    const store = new MysqlControlPlaneStore(fixture.pool);

    await expect(store.saveGeoQuality(2, {
      rules: [{ countryCode: "IN", percent: 25 }],
      qualityPolicy: { active: true, scope: "selected", countries: ["IN"] },
    })).rejects.toThrow("country insert failed");

    expect(fixture.connection.beginTransaction).toHaveBeenCalledOnce();
    expect(fixture.connection.commit).not.toHaveBeenCalled();
    expect(fixture.connection.rollback).toHaveBeenCalledOnce();
    expect(fixture.connection.release).toHaveBeenCalledOnce();
  });

  it("locks the user, blocks Admin/upload owners, and returns cache identities only after commit", async () => {
    const admin = transactionFixture();
    admin.connection.execute.mockResolvedValueOnce([[{ id: 1, role: "admin" }], []]);
    await expect(new MysqlControlPlaneStore(admin.pool).deleteRegularUser(1))
      .resolves.toEqual({ status: "admin" });
    expect(admin.connection.execute).toHaveBeenCalledWith(
      "SELECT id, role FROM users WHERE id = ? LIMIT 1 FOR UPDATE",
      [1],
    );
    expect(admin.connection.rollback).toHaveBeenCalledOnce();

    const uploads = transactionFixture();
    uploads.connection.execute
      .mockResolvedValueOnce([[{ id: 7, role: "user" }], []])
      .mockResolvedValueOnce([[{ found: 1 }], []]);
    await expect(new MysqlControlPlaneStore(uploads.pool).deleteRegularUser(7))
      .resolves.toEqual({ status: "uploads_present" });
    expect(uploads.connection.commit).not.toHaveBeenCalled();
    expect(uploads.connection.rollback).toHaveBeenCalledOnce();

    const deleted = transactionFixture();
    deleted.connection.execute
      .mockResolvedValueOnce([[{ id: 8, role: "user" }], []])
      .mockResolvedValueOnce([[], []])
      .mockResolvedValueOnce([[
        { domain_id: 2, code: "Ab12Cd" },
        { domain_id: 3, code: "Ef34Gh" },
      ], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    await expect(new MysqlControlPlaneStore(deleted.pool).deleteRegularUser(8)).resolves.toEqual({
      status: "deleted",
      userId: 8,
      links: [
        { domainId: 2, code: "Ab12Cd" },
        { domainId: 3, code: "Ef34Gh" },
      ],
    });
    expect(deleted.connection.commit).toHaveBeenCalledOnce();
    expect(deleted.connection.rollback).not.toHaveBeenCalled();
    expect(deleted.connection.release).toHaveBeenCalledOnce();
  });

  it("persists the global registration switch through the shared pool", async () => {
    const execute = vi.fn(async () => [{ affectedRows: 1 }, []]);
    const pool = { execute } as unknown as Pool;
    const store = new MysqlControlPlaneStore(pool);

    await store.setRegistrationEnabled(true);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO settings"),
      ["1"],
    );
  });
});

function transactionFixture(): {
  readonly pool: Pool;
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
    execute: vi.fn(async () => [{ affectedRows: 1 }, []]),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(() => undefined),
  };
  return {
    pool: { getConnection: vi.fn(async () => connection) } as unknown as Pool,
    connection,
  };
}
