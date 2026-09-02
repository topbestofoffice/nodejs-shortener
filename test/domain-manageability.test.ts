import { describe, expect, it, vi } from "vitest";
import type { DomainPolicy } from "../src/core/types.js";
import { MysqlApplicationStore } from "../src/infrastructure/mysql-store.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";

const domains: readonly DomainPolicy[] = [
  {
    id: 2,
    domainKey: "paused",
    hostname: "paused.example",
    label: "Paused",
    surface: "redirect",
    active: false,
    allowCreate: false,
    diversionCampaign: "paused",
    reportTimezone: "UTC",
  },
  {
    id: 1,
    domainKey: "dashboard",
    hostname: "dashboard.example",
    label: "Dashboard",
    surface: "dashboard",
    active: true,
    allowCreate: false,
    diversionCampaign: "dashboard",
    reportTimezone: "Asia/Kolkata",
  },
];

describe("Admin manageable-domain contract", () => {
  it("includes configured inactive and creation-paused domains in deterministic ID order", async () => {
    const memory = new InMemoryApplicationStore(domains);
    await expect(memory.listManageableDomains()).resolves.toEqual([domains[1], domains[0]]);

    const query = vi.fn(async (_sql: string) => [[
      {
        id: 1,
        domain_key: "dashboard",
        hostname: "dashboard.example",
        label: "Dashboard",
        role: "dashboard",
        active: 1,
        allow_create: 0,
        diversion_campaign: "dashboard",
        report_timezone: "Asia/Kolkata",
      },
      {
        id: 2,
        domain_key: "paused",
        hostname: "paused.example",
        label: "Paused",
        role: "redirect",
        active: 0,
        allow_create: 0,
        diversion_campaign: "paused",
        report_timezone: "UTC",
      },
    ], []]);
    const store = Object.create(MysqlApplicationStore.prototype) as MysqlApplicationStore;
    Object.defineProperty(store, "pool", { value: { query }, writable: false });

    await expect(store.listManageableDomains()).resolves.toEqual([domains[1], domains[0]]);
    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).not.toMatch(/WHERE\s+active\s*=\s*1/i);
  });
});
