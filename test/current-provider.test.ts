import { describe, expect, it, vi } from "vitest";
import {
  MysqlRedisCurrentDecisionProvider,
  containsIpv4,
  type CurrentDecisionProviderOptions,
  type DecisionSqlExecutor,
} from "../src/infrastructure/current-decision-provider.js";
import type { CacheStore } from "../src/ports.js";

describe("MysqlRedisCurrentDecisionProvider", () => {
  it("reads PHP-compatible tagged setting-cache values without SQL", async () => {
    const state = fixture({
      cached: {
        "fleet:domain:2:set:skim_enabled": "v1",
        "fleet:domain:2:set:skim_debug": "n",
      },
    });
    await expect(state.provider.getBaseSettings(2)).resolves.toEqual({ skimEnabled: true, debugEnabled: false });
    expect(state.sql).not.toHaveBeenCalled();
  });

  it("loads missing base settings in one bounded SQL query and repopulates positive and negative cache tags", async () => {
    const state = fixture({ settingRows: [{ skey: "skim_enabled", svalue: "1" }] });
    await expect(state.provider.getBaseSettings(2)).resolves.toEqual({ skimEnabled: true, debugEnabled: false });
    expect(state.sql).toHaveBeenCalledTimes(1);
    expect(state.sql.mock.calls[0]?.[0]).toContain("max_statement_time=0.25");
    expect(state.cache.values.get("fleet:domain:2:set:skim_enabled")).toBe("v1");
    expect(state.cache.values.get("fleet:domain:2:set:skim_debug")).toBe("n");
  });

  it("combines settings, geo rows and the strict policy while preferring a trusted request country", async () => {
    const state = fixture({
      settingRows: [
        { skey: "skim_destination_url", svalue: "https://skim.example/path" },
        { skey: "skim_default_percent", svalue: "125junk" },
      ],
      geoRows: [
        { country_code: "IN", percent: 45, policy_json: null },
        { country_code: "US", percent: "9", policy_json: null },
        { country_code: null, percent: null, policy_json: JSON.stringify({ active: true, scope: "selected", countries: ["IN"] }) },
      ],
    });
    const context = await state.provider.getDiversionContext({
      domainId: 2,
      clientIp: "198.51.100.2",
      trustedCountry: "in",
    });
    expect(context).toEqual({
      skimDestinationUrl: "https://skim.example/path",
      country: "IN",
      defaultCountryPercent: 100,
      explicitCountryPercentages: { IN: 45, US: 9 },
      countryQualityPolicy: { active: true, scope: "selected", countries: ["IN"] },
    });
    expect(state.resolveCountry).not.toHaveBeenCalled();
    expect(state.cache.values.get("fleet:domain:2:georules")).toContain("__quality_policy_v1");
  });

  it("uses the injected fallback resolver only when trusted country evidence is unavailable", async () => {
    const state = fixture({ resolvedCountry: "us" });
    await expect(state.provider.getDiversionContext({ domainId: 2, clientIp: "198.51.100.3" }))
      .resolves.toMatchObject({ country: "US" });
    expect(state.resolveCountry).toHaveBeenCalledWith("198.51.100.3");
  });

  it("rejects syntactically valid but unsupported country codes from every source", async () => {
    const state = fixture({ resolvedCountry: "ZZ" });
    await expect(state.provider.getDiversionContext({
      domainId: 2,
      clientIp: "198.51.100.3",
      trustedCountry: "ZZ",
    })).resolves.toMatchObject({ country: null });
    expect(state.resolveCountry).toHaveBeenCalledWith("198.51.100.3");
  });

  it("uses the exact Meta list and bounded IPv4 datacenter binary search", async () => {
    const state = fixture({ ranges: { starts: [0x0a000000, 0xc6336400], ends: [0x0affffff, 0xc63364ff] } });
    await expect(state.provider.isMetaNetwork("157.240.1.1")).resolves.toBe(true);
    await expect(state.provider.isMetaNetwork("198.51.100.1")).resolves.toBe(false);
    await expect(state.provider.isDatacenterBot({ clientIp: "198.51.100.40", isCrawler: false, metaNetwork: false }))
      .resolves.toBe(true);
    await expect(state.provider.isDatacenterBot({ clientIp: "198.51.100.40", isCrawler: true, metaNetwork: false }))
      .resolves.toBe(false);
    await expect(state.provider.isDatacenterBot({ clientIp: "2001:db8::1", isCrawler: false, metaNetwork: false }))
      .resolves.toBe(false);
    expect(containsIpv4({ starts: [100], ends: [] }, "198.51.100.1")).toBe(false);
  });

  it("executes the PHP-compatible bounded replay counter and returns both observed counts", async () => {
    const state = fixture({ replayResult: [50, 50], replayStatus: "wait" });
    const result = await state.provider.detectReplay({
      token: "click-token",
      clientIp: "198.51.100.5",
      domainId: 2,
      windowSeconds: 7_200,
      minimumTotal: 30,
      minimumToken: 10,
      tokenFieldCap: 8,
    });
    expect(result).toEqual({ detected: true, total: 50, token: 50 });
    expect(state.redis.connect).toHaveBeenCalledTimes(1);
    expect(state.redis.eval).toHaveBeenCalledTimes(1);
    const call = state.redis.eval.mock.calls[0] ?? [];
    expect(call[0]).toContain("HINCRBY");
    expect(call[2]).toMatch(/^fleet:domain:2:fbr:[a-f0-9]{32}$/);
    expect(call[3]).toMatch(/^t:[a-f0-9]{32}$/);
    expect(JSON.stringify(call)).not.toContain("198.51.100.5");
    expect(JSON.stringify(call)).not.toContain("click-token");
  });

  it("does no Redis work for malformed replay evidence and rejects malformed Redis replies", async () => {
    const state = fixture({ replayResult: "bad" });
    await expect(state.provider.detectReplay({
      token: "",
      clientIp: "not-an-ip",
      domainId: 2,
      windowSeconds: 1,
      minimumTotal: 0,
      minimumToken: 0,
      tokenFieldCap: 0,
    })).resolves.toEqual({ detected: false, total: 0, token: 0 });
    expect(state.redis.eval).not.toHaveBeenCalled();

    await expect(state.provider.detectReplay({
      token: "valid-token",
      clientIp: "198.51.100.6",
      domainId: 2,
      windowSeconds: 7_200,
      minimumTotal: 30,
      minimumToken: 10,
      tokenFieldCap: 8,
    })).rejects.toThrow("invalid result");
  });

  it("rejects misaligned range data at startup", () => {
    expect(() => fixture({ ranges: { starts: [1], ends: [] } })).toThrow("equal length");
  });
});

interface FixtureOptions {
  readonly cached?: Readonly<Record<string, string>>;
  readonly settingRows?: readonly { readonly skey: string; readonly svalue: string | null }[];
  readonly geoRows?: readonly { readonly country_code: string | null; readonly percent: number | string | null; readonly policy_json: string | null }[];
  readonly ranges?: { readonly starts: readonly number[]; readonly ends: readonly number[] };
  readonly resolvedCountry?: string | null;
  readonly replayResult?: unknown;
  readonly replayStatus?: string;
}

function fixture(options: FixtureOptions = {}) {
  const cache = new MemoryCache(options.cached);
  const sql = vi.fn(async (statement: string) => {
    return [statement.includes("UNION ALL") ? options.geoRows ?? [] : options.settingRows ?? [], {}];
  });
  const redis = {
    status: options.replayStatus ?? "ready",
    connect: vi.fn(async () => undefined),
    eval: vi.fn(async (_script: string, _numberOfKeys: number, ..._arguments: readonly (string | number)[]) => (
      options.replayResult ?? [0, 0]
    )),
  };
  const resolveCountry = vi.fn(async () => options.resolvedCountry ?? null);
  const providerOptions: CurrentDecisionProviderOptions = {
    sql: { execute: sql } as unknown as DecisionSqlExecutor,
    cache,
    replayRedis: redis,
    appNamespace: "fleet",
    ipHashSecret: "synthetic-secret-with-at-least-32-characters",
    datacenterIpv4: options.ranges ?? { starts: [], ends: [] },
    resolveCountry,
  };
  return {
    provider: new MysqlRedisCurrentDecisionProvider(providerOptions),
    cache,
    sql,
    redis,
    resolveCountry,
  };
}

class MemoryCache implements CacheStore {
  public readonly values: Map<string, string>;

  public constructor(initial: Readonly<Record<string, string>> = {}) {
    this.values = new Map(Object.entries(initial));
  }

  public async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  public async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  public async delete(...keys: readonly string[]): Promise<void> { keys.forEach((key) => this.values.delete(key)); }
}
