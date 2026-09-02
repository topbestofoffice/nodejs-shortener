import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import type { CreateLinkInput } from "../src/core/types.js";
import { MysqlApplicationStore } from "../src/infrastructure/mysql-store.js";

const createdAt = new Date("2026-09-01T12:00:00.000Z");

describe("MysqlApplicationStore create-link commit ambiguity", () => {
  it("returns the exact committed row after a lost commit acknowledgement without retrying the insert", async () => {
    const input = linkInput();
    const row = linkRow(input);
    const commitError = new Error("commit acknowledgement lost");
    let executeCount = 0;
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string) => {
        executeCount += 1;
        if (sql.includes("INSERT INTO links")) return [{ affectedRows: 1 }, []];
        if (sql.includes("FROM links l")) return [[row], []];
        throw new Error(`Unexpected transaction SQL: ${sql}`);
      }),
      commit: vi.fn(async () => Promise.reject(commitError)),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const poolExecute = vi.fn(async (sql: string) => {
      expect(sql).toContain("WHERE l.domain_id = ? AND l.code = ? LIMIT 1");
      return [[row], []];
    });
    const pool = {
      getConnection: vi.fn(async () => connection),
      execute: poolExecute,
    } as unknown as Pool;
    const store = Object.create(MysqlApplicationStore.prototype) as MysqlApplicationStore;
    Object.defineProperty(store, "pool", { value: pool, writable: false });

    await expect(store.createLink(input)).resolves.toMatchObject({
      id: "501",
      domainId: 2,
      code: input.code,
      destination: input.destination,
      image: null,
    });
    expect(executeCount).toBe(2);
    expect(connection.rollback).toHaveBeenCalledOnce();
    expect(connection.destroy).toHaveBeenCalledOnce();
    expect(connection.release).not.toHaveBeenCalled();
    expect(poolExecute).toHaveBeenCalledOnce();
  });

  it("preserves the commit error when readback finds a different request tuple", async () => {
    const input = linkInput();
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string) => sql.includes("INSERT INTO links")
        ? [{ affectedRows: 1 }, []]
        : [[linkRow(input)], []]),
      commit: vi.fn(async () => Promise.reject(new Error("commit acknowledgement lost"))),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = {
      getConnection: vi.fn(async () => connection),
      execute: vi.fn(async () => [[{
        ...linkRow(input),
        destination: "https://different.example/",
      }], []]),
    } as unknown as Pool;
    const store = Object.create(MysqlApplicationStore.prototype) as MysqlApplicationStore;
    Object.defineProperty(store, "pool", { value: pool, writable: false });

    await expect(store.createLink(input)).rejects.toThrow("commit acknowledgement lost");
    expect(connection.destroy).toHaveBeenCalledOnce();
  });
});

function linkInput(): CreateLinkInput {
  return {
    domainId: 2,
    userId: 7,
    destination: "https://destination.example/path",
    title: "Title",
    description: "Description",
    image: null,
    imageSessionScopeHash: null,
    imageOwnershipExpiresAt: null,
    code: "Commit01",
    createdAt,
  };
}

function linkRow(input: CreateLinkInput): Record<string, unknown> {
  return {
    id: "501",
    domain_id: input.domainId,
    code: input.code,
    user_id: input.userId,
    destination: input.destination,
    title: input.title,
    description: input.description,
    image: input.image,
    author_role: "user",
    domain_hostname: "vidx1x.local",
    domain_label: "VIDX1X",
    diversion_campaign: "vidx1x",
    created_at: input.createdAt,
  };
}
