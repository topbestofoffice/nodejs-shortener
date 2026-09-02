import type { Pool, PoolConnection } from "mysql2/promise";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MysqlRuntimeReadinessStore,
  runtimeSchemaContractId,
} from "../src/infrastructure/mysql-runtime-readiness-store.js";

afterEach(() => vi.useRealTimers());

describe("bounded MariaDB runtime readiness", () => {
  it("loads the schema marker and complete domain identity on one bounded connection", async () => {
    const release = vi.fn();
    const destroy = vi.fn();
    const execute = vi.fn()
      .mockResolvedValueOnce([[{ svalue: runtimeSchemaContractId }], []])
      .mockResolvedValueOnce([[
        {
          id: 2,
          domain_key: "vidx1x",
          hostname: "vidx1x.local",
          label: "VIDX1X",
          role: "redirect",
          active: 1,
          allow_create: 0,
          diversion_campaign: "vidx1x",
          report_timezone: "UTC",
        },
      ], []]);
    const connection = { execute, release, destroy } as unknown as PoolConnection;
    const pool = { getConnection: async () => connection } as unknown as Pool;

    await expect(new MysqlRuntimeReadinessStore(pool).load(500)).resolves.toEqual({
      schemaContractId: runtimeSchemaContractId,
      domains: [{
        id: 2,
        domainKey: "vidx1x",
        hostname: "vidx1x.local",
        label: "VIDX1X",
        surface: "redirect",
        active: true,
        allowCreate: false,
        diversionCampaign: "vidx1x",
        reportTimezone: "UTC",
      }],
    });
    expect(release).toHaveBeenCalledOnce();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("destroys a connection whose query exceeds the total readiness deadline", async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    const destroy = vi.fn();
    const connection = {
      execute: vi.fn(() => new Promise(() => undefined)),
      release,
      destroy,
    } as unknown as PoolConnection;
    const pool = { getConnection: async () => connection } as unknown as Pool;

    const pending = new MysqlRuntimeReadinessStore(pool).load(100);
    const assertion = expect(pending).rejects.toThrow(/query timed out/);
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(destroy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("destroys a connection that arrives after acquisition already timed out", async () => {
    vi.useFakeTimers();
    let resolveConnection: ((connection: PoolConnection) => void) | undefined;
    const destroy = vi.fn();
    const connection = { destroy } as unknown as PoolConnection;
    const pool = {
      getConnection: () => new Promise<PoolConnection>((resolve) => { resolveConnection = resolve; }),
    } as unknown as Pool;

    const pending = new MysqlRuntimeReadinessStore(pool).load(100);
    const assertion = expect(pending).rejects.toThrow(/connection timed out/);
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    resolveConnection?.(connection);
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("does not stack pool waiters while one timed-out acquisition is still queued", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((connection: PoolConnection) => void) | undefined;
    const firstDestroy = vi.fn();
    const firstConnection = { destroy: firstDestroy } as unknown as PoolConnection;
    const secondConnection = {
      execute: vi.fn()
        .mockResolvedValueOnce([[{ svalue: runtimeSchemaContractId }], []])
        .mockResolvedValueOnce([[], []]),
      release: vi.fn(),
      destroy: vi.fn(),
    } as unknown as PoolConnection;
    const getConnection = vi.fn()
      .mockImplementationOnce(() => new Promise<PoolConnection>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(secondConnection);
    const store = new MysqlRuntimeReadinessStore({ getConnection } as unknown as Pool);

    const first = store.load(100);
    const firstAssertion = expect(first).rejects.toThrow(/connection timed out/);
    await vi.advanceTimersByTimeAsync(101);
    await firstAssertion;
    await expect(store.load(100)).rejects.toThrow(/acquisition is still pending/);
    await expect(store.load(100)).rejects.toThrow(/acquisition is still pending/);
    expect(getConnection).toHaveBeenCalledOnce();

    resolveFirst?.(firstConnection);
    await Promise.resolve();
    expect(firstDestroy).toHaveBeenCalledOnce();
    await expect(store.load(100)).resolves.toMatchObject({ schemaContractId: runtimeSchemaContractId });
    expect(getConnection).toHaveBeenCalledTimes(2);
  });
});
