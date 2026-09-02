import { describe, expect, it, vi } from "vitest";
import { MysqlApplicationStore } from "../src/infrastructure/mysql-store.js";

describe("Admin Delivered range MySQL contract", () => {
  it.each([
    ["six hours", "2026-09-01T00:00:00.000Z", "2026-09-01T06:00:00.000Z"],
    ["one day", "2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
    ["seven days", "2026-09-01T00:00:00.000Z", "2026-09-08T00:00:00.000Z"],
  ])("queries the full %s range without a presentation LIMIT", async (_label, start, end) => {
    const execute = vi.fn(async (_sql: string, _params: readonly unknown[]) => [[], []] as const);
    const store = Object.create(MysqlApplicationStore.prototype) as MysqlApplicationStore;
    Object.defineProperty(store, "pool", { value: { execute }, writable: false });

    await expect(store.loadDeliveredCountryWindow(2, new Date(start), new Date(end))).resolves.toEqual({
      states: [],
      history: [],
    });
    expect(execute).toHaveBeenCalledTimes(2);
    for (const [sql, params] of execute.mock.calls) {
      expect(String(sql)).not.toMatch(/\bLIMIT\b/i);
      expect(params).toEqual([2, start.replace("T", " ").replace(".000Z", ""), end.replace("T", " ").replace(".000Z", "")]);
    }
  });

  it("rejects empty, unaligned and over-seven-day ranges before SQL", async () => {
    const execute = vi.fn(async (_sql: string, _params: readonly unknown[]) => [[], []] as const);
    const store = Object.create(MysqlApplicationStore.prototype) as MysqlApplicationStore;
    Object.defineProperty(store, "pool", { value: { execute }, writable: false });
    const start = new Date("2026-09-01T00:00:00.000Z");

    for (const end of [
      start,
      new Date("2026-09-01T00:10:01.000Z"),
      new Date("2026-09-08T00:10:00.000Z"),
    ]) {
      await expect(store.loadDeliveredCountryWindow(2, start, end)).rejects.toThrow(/1\.\.1008/);
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
