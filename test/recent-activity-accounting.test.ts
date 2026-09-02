import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import type { AccountingOutcome, LinkAccountingEvent } from "../src/core/types.js";
import { MysqlApplicationStore } from "../src/infrastructure/mysql-store.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { baseLink, domainPolicies } from "./fixtures.js";

const occurredAt = new Date("2026-09-01T12:34:56.789Z");
const activityEpoch = Math.floor(occurredAt.getTime() / 1000);

describe("compact recent-activity accounting parity", () => {
  it("loads the persisted non-null compact marker with the link", async () => {
    const execute = vi.fn(async (sql: string) => {
      expect(sql).toContain("(l.recent_activity_epochs IS NOT NULL) AS compact_activity_tracked");
      return [[{
        id: baseLink.id,
        domain_id: baseLink.domainId,
        code: baseLink.code,
        user_id: baseLink.userId,
        destination: baseLink.destination,
        title: baseLink.title,
        description: baseLink.description,
        image: null,
        compact_activity_tracked: 1,
        author_role: baseLink.authorRole,
        domain_hostname: baseLink.domainHostname,
        domain_label: baseLink.domainLabel,
        diversion_campaign: baseLink.diversionCampaign,
        created_at: baseLink.createdAt,
      }], []];
    });
    const store = mysqlStore({ execute } as unknown as Pool);

    await expect(store.findLink(2, baseLink.code, baseLink.domainHostname, "redirect"))
      .resolves.toMatchObject({ compactActivityTracked: true, image: null });
  });

  it("appends the epoch in the same delivered-accounting UPDATE with the strict last-100 SQL bound", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = {
      execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return [{ affectedRows: 1 }, []];
      }),
    } as unknown as Pool;
    const store = mysqlStore(pool);

    await store.record(event("delivered"));

    expect(calls).toHaveLength(1);
    const update = calls[0];
    expect(update?.sql).toContain("UPDATE links SET");
    expect(update?.sql).toContain("recent_activity_epochs = CASE");
    expect(update?.sql).toContain("JSON_LENGTH(recent_activity_epochs) < 100");
    expect(update?.sql).toContain("JSON_REMOVE(recent_activity_epochs, '$[0]')");
    expect(update?.params.slice(-5)).toEqual([
      activityEpoch,
      activityEpoch,
      activityEpoch,
      "9007199254740993",
      2,
    ]);
  });

  it("keeps the JSON ring expression off PHP-untracked redirect updates", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const pool = {
      execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return [{ affectedRows: 1 }, []];
      }),
    } as unknown as Pool;
    const store = mysqlStore(pool);

    await store.record(event("delivered", false));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).not.toContain("recent_activity_epochs = CASE");
    expect(calls[0]?.params.slice(-2)).toEqual(["9007199254740993", 2]);
  });

  it("keeps a filtered ring append atomic with its existing country-history transaction", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const connection = {
      beginTransaction: vi.fn(async () => undefined),
      execute: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return [{ affectedRows: 1 }, []];
      }),
      commit: vi.fn(async () => undefined),
      rollback: vi.fn(async () => undefined),
      release: vi.fn(() => undefined),
    };
    const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool;
    const store = mysqlStore(pool);

    await store.record(event("filtered_meta"));

    expect(connection.beginTransaction).toHaveBeenCalledOnce();
    expect(connection.commit).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("recent_activity_epochs = CASE");
    expect(calls[0]?.sql).toMatch(/^SET STATEMENT max_statement_time=0\.25 FOR UPDATE links SET/);
    expect(calls[1]?.sql).toContain("INSERT INTO diversion_history_10m");
    expect(calls[0]?.params.slice(-6, -3)).toEqual([activityEpoch, activityEpoch, activityEpoch]);
  });

  it("tracks every admitted outcome and retains only the newest 100 epochs in memory", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    const outcomes: readonly AccountingOutcome[] = [
      "delivered",
      "diverted",
      "filtered_meta",
      "filtered_bot",
      "filtered_other",
    ];

    for (let index = 0; index < 105; index += 1) {
      await store.record({
        ...event(outcomes[index % outcomes.length] ?? "delivered"),
        occurredAt: new Date(occurredAt.getTime() + index * 1000),
      });
    }

    const epochs = store.recentActivityEpochsForTest(baseLink.domainId, baseLink.code);
    expect(epochs).toHaveLength(100);
    expect(epochs?.[0]).toBe(activityEpoch + 5);
    expect(epochs?.[99]).toBe(activityEpoch + 104);
    expect(new Set(store.accountingEvents.slice(0, 5).map((item) => item.outcome))).toEqual(new Set(outcomes));
  });

  it("preserves PHP's exact compact condition: existing non-null ring or case-sensitive uploads/ prefix", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    const migrated = { ...baseLink, id: "21", code: "Migrated", image: null };
    const legacyImage = { ...baseLink, id: "22", code: "Legacy01", image: "uploads/legacy-name.jpeg" };
    const uppercase = { ...baseLink, id: "23", code: "Upper001", image: "Uploads/legacy-name.jpg" };
    store.seedLink(migrated, { recentActivityEpochs: [] });
    store.seedLink(legacyImage);
    store.seedLink(uppercase);

    await store.record({ ...event("diverted", true), linkId: migrated.id });
    await store.record({ ...event("filtered_bot", true), linkId: legacyImage.id });
    await store.record({ ...event("delivered", false), linkId: uppercase.id });

    expect(store.recentActivityEpochsForTest(2, migrated.code)).toEqual([activityEpoch]);
    expect(store.recentActivityEpochsForTest(2, legacyImage.code)).toEqual([activityEpoch]);
    expect(store.recentActivityEpochsForTest(2, uppercase.code)).toBeNull();
  });
});

function event(outcome: AccountingOutcome, trackRecentActivity = true): LinkAccountingEvent {
  return {
    linkId: baseLink.id,
    domainId: baseLink.domainId,
    outcome,
    country: "IN",
    occurredAt,
    trackRecentActivity,
  };
}

function mysqlStore(pool: Pool): MysqlApplicationStore {
  const store = new MysqlApplicationStore({
    host: "127.0.0.1",
    port: 3306,
    database: "contract_test",
    user: "contract_test",
    password: "",
  });
  Object.defineProperty(store, "pool", { value: pool, writable: false });
  return store;
}
