import { describe, expect, it, vi } from "vitest";
import type { DecisionSqlExecutor } from "../src/infrastructure/current-decision-provider.js";
import { isPublicRoutableIp, MysqlCachedCountryResolver } from "../src/infrastructure/country-resolver.js";

const now = new Date("2026-08-23T12:00:00.000Z");

describe("MysqlCachedCountryResolver", () => {
  it("returns a valid cached country without an external request", async () => {
    const state = fixture([[[{ country: "in", fetched_at: "2026-08-01 00:00:00" }], {}]]);
    await expect(state.resolver.resolve("8.8.8.8")).resolves.toBe("IN");
    expect(state.fetch).not.toHaveBeenCalled();
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state.execute.mock.calls)).not.toContain("8.8.8.8");
  });

  it("does not hammer the API after a recent cached failure", async () => {
    const state = fixture([[[{ country: null, fetched_at: "2026-08-23 11:30:01" }], {}]]);
    await expect(state.resolver.resolve("8.8.4.4")).resolves.toBeNull();
    expect(state.fetch).not.toHaveBeenCalled();
  });

  it("performs one bounded async lookup and upserts the privacy-hashed cache row", async () => {
    const state = fixture([
      [[], {}],
      [{ affectedRows: 1 }, {}],
    ], new Response(JSON.stringify({ status: "success", countryCode: "us" })));
    await expect(state.resolver.resolve("1.1.1.1")).resolves.toBe("US");
    expect(state.fetch).toHaveBeenCalledTimes(1);
    expect(state.fetch.mock.calls[0]?.[0]).toBe("http://ip-api.com/json/1.1.1.1?fields=status,countryCode");
    expect(state.fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const write = state.execute.mock.calls[1];
    expect(write?.[0]).toContain("ON DUPLICATE KEY UPDATE");
    expect(write?.[1]?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(write?.[1]).toContain("US");
    expect(JSON.stringify(write)).not.toContain("1.1.1.1");
  });

  it("fails safely on SQL, HTTP, oversized or malformed responses", async () => {
    const sqlFailure = fixture([], new Response("unused"), new Error("database detail"));
    await expect(sqlFailure.resolver.resolve("9.9.9.9")).resolves.toBeNull();

    for (const response of [
      new Response("x".repeat(4_097)),
      new Response("not-json"),
      new Response(JSON.stringify({ status: "fail", countryCode: "US" })),
      new Response(JSON.stringify({ status: "success", countryCode: "XX" })),
      new Response(JSON.stringify({ status: "success", countryCode: "ZZ" })),
    ]) {
      const state = fixture([[[], {}], [{ affectedRows: 1 }, {}]], response);
      await expect(state.resolver.resolve("9.9.9.9")).resolves.toBeNull();
    }
  });

  it("never queries or sends private, reserved, malformed or mapped-private addresses", async () => {
    const state = fixture([]);
    for (const ip of ["127.0.0.1", "10.0.0.1", "192.0.2.1", "::1", "2001:db8::1", "::ffff:10.0.0.1", "bad"] ) {
      await expect(state.resolver.resolve(ip)).resolves.toBeNull();
    }
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.fetch).not.toHaveBeenCalled();
    expect(isPublicRoutableIp("8.8.8.8")).toBe(true);
    expect(isPublicRoutableIp("2001:4860:4860::8888")).toBe(true);
  });
});

function fixture(
  replies: readonly unknown[],
  response: Response = new Response(JSON.stringify({ status: "success", countryCode: "IN" })),
  executeError: Error | null = null,
) {
  let index = 0;
  const execute = vi.fn(async (_sql: string, _values?: readonly unknown[]) => {
    if (executeError !== null) throw executeError;
    return replies[index++] ?? [[], {}];
  });
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response);
  const resolver = new MysqlCachedCountryResolver({
    sql: { execute } as unknown as DecisionSqlExecutor,
    ipHashSecret: "synthetic-secret-with-at-least-32-characters",
    clock: { now: () => new Date(now) },
    fetch,
    requestTimeoutMs: 100,
  });
  return { resolver, execute, fetch };
}
