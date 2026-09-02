import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import type { CreateLinkInput } from "../src/core/types.js";
import { MysqlApplicationStore } from "../src/infrastructure/mysql-store.js";

describe("MysqlApplicationStore managed-image attachment", () => {
  it.each(["jpg", "png", "gif", "webp"] as const)(
    "refreshes READY or ATTACHED .%s ownership inside the same link transaction",
    async (extension) => {
    const createdAt = new Date("2026-09-02T11:59:00.000Z");
    const expiresAt = new Date("2026-09-03T11:59:00.000Z");
    const input: CreateLinkInput = {
      domainId: 2,
      userId: 7,
      destination: "https://destination.example/reused",
      title: null,
      description: null,
      image: `uploads/0123456789abcdef.${extension}`,
      imageSessionScopeHash: "a".repeat(64),
      imageOwnershipExpiresAt: expiresAt,
      code: "Reuse001",
      createdAt,
    };
    const updateCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const insertCalls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("FROM uploaded_images u")) {
          return [[{
            path: input.image,
            state: 2,
            ledger_job_id: null,
            ledger_user_id: null,
            ledger_state: null,
            ledger_publication_state: null,
            ledger_compensation_state: null,
          }], []];
        }
        if (sql.includes("INSERT INTO links")) {
          insertCalls.push({ sql, params: params ?? [] });
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes("UPDATE uploaded_images")) {
          updateCalls.push({ sql, params: params ?? [] });
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes("FROM links l")) return [[linkRow(input)], []];
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      destroy: vi.fn(() => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;
    const store = Object.create(MysqlApplicationStore.prototype) as MysqlApplicationStore;
    Object.defineProperty(store, "pool", { value: pool, writable: false });

    await expect(store.createLink(input)).resolves.toMatchObject({ code: input.code, image: input.image });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.sql).toMatch(/clicks, recent_activity_epochs, created_at/);
    expect(insertCalls[0]?.params).toEqual([
      input.domainId,
      input.code,
      input.userId,
      input.destination,
      input.title,
      input.description,
      input.image,
      "[]",
      "2026-09-02 11:59:00",
    ]);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.sql).toMatch(/expires_at = \?[\s\S]*state IN \(1, 2\)/);
    expect(updateCalls[0]?.params).toEqual([
      "2026-09-02 11:59:00",
      "2026-09-03 11:59:00",
      input.image,
      input.userId,
      Buffer.from(input.imageSessionScopeHash ?? "", "hex"),
    ]);
    expect(connection.commit).toHaveBeenCalledOnce();
    },
  );
});

function linkRow(input: CreateLinkInput): Record<string, unknown> {
  return {
    id: "701",
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
