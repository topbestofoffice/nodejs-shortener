import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { RowDataPacket } from "mysql2/promise";
import type { CacheStore } from "../ports.js";
import type {
  CurrentBaseSettings,
  CurrentDecisionProvider,
  CurrentDiversionContext,
  DatacenterClassificationInput,
  DiversionContextInput,
  ReplayDetection,
  ReplayDetectionInput,
} from "../modules/redirect/current-decision.js";
import { normalizeCountryCode, normalizeIpAddress } from "../security/client-identity.js";

const qualityPolicyKey = "__quality_policy_v1";
const storedQualityPolicyKey = "skim_quality_policy_v1";
const settingsTtlSeconds = 60;
const replayScript = `local key = KEYS[1]
local field = ARGV[1]
local ttl = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local total = redis.call('HINCRBY', key, '_total', 1)
local replay = redis.call('HINCRBY', key, field, 1)
if total == 1 or redis.call('TTL', key) < 0 then redis.call('EXPIRE', key, ttl) end
if redis.call('HLEN', key) > cap + 1 then
  local entries = redis.call('HGETALL', key)
  local victim = nil
  local victimCount = nil
  for i = 1, #entries, 2 do
    local candidate = entries[i]
    if candidate ~= '_total' and candidate ~= field then
      local candidateCount = tonumber(entries[i + 1]) or 0
      if victimCount == nil or candidateCount < victimCount then
        victim = candidate
        victimCount = candidateCount
      end
    end
  end
  if victim ~= nil then redis.call('HDEL', key, victim) end
end
return {total, replay}`;

const metaCidrs = [
  "31.13.24.0/21", "31.13.64.0/18", "31.13.96.0/19", "45.64.40.0/22", "66.220.144.0/20",
  "57.141.0.0/16", "57.142.0.0/15", "57.144.0.0/14", "57.148.0.0/15", "69.63.176.0/20",
  "69.171.224.0/19", "74.119.76.0/22", "102.132.96.0/20", "103.4.96.0/22", "129.134.0.0/17",
  "157.240.0.0/16", "163.70.128.0/17", "163.77.132.0/23", "163.77.136.0/23", "173.252.64.0/18",
  "179.60.192.0/22", "185.60.216.0/22", "185.89.216.0/22", "204.15.20.0/22",
  "2a03:2880::/32", "2620:0:1c00::/40",
] as const;

export interface DecisionSqlExecutor {
  execute<T extends RowDataPacket[][] | RowDataPacket[] | object>(sql: string, values?: readonly unknown[]): Promise<[T, unknown]>;
}

export interface ReplayRedisClient {
  readonly status: string;
  connect(): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...arguments_: readonly (string | number)[]): Promise<unknown>;
}

export interface DatacenterIpv4Ranges {
  readonly starts: readonly number[];
  readonly ends: readonly number[];
}

export interface CurrentDecisionProviderOptions {
  readonly sql: DecisionSqlExecutor;
  readonly cache: CacheStore;
  readonly replayRedis: ReplayRedisClient;
  readonly appNamespace: string;
  readonly ipHashSecret: string;
  readonly datacenterIpv4: DatacenterIpv4Ranges;
  readonly resolveCountry: (clientIp: string) => Promise<string | null>;
}

interface SettingRow extends RowDataPacket {
  skey: string;
  svalue: string | null;
}

interface GeoStateRow extends RowDataPacket {
  country_code: string | null;
  percent: number | string | null;
  policy_json: string | null;
}

/** Exact-current data provider with bounded SQL, Redis-compatible keys and local IP classifiers. */
export class MysqlRedisCurrentDecisionProvider implements CurrentDecisionProvider {
  readonly #metaNetworks = compileMetaNetworks();
  readonly #ranges: DatacenterIpv4Ranges;

  public constructor(private readonly options: CurrentDecisionProviderOptions) {
    if (options.datacenterIpv4.starts.length !== options.datacenterIpv4.ends.length) {
      throw new TypeError("Datacenter range starts and ends must have equal length.");
    }
    this.#ranges = options.datacenterIpv4;
  }

  public async getBaseSettings(domainId: number): Promise<CurrentBaseSettings> {
    const settings = await this.#getSettings(domainId, ["skim_enabled", "skim_debug"]);
    return {
      skimEnabled: settings.skim_enabled === "1",
      debugEnabled: settings.skim_debug === "1",
    };
  }

  public async isMetaNetwork(clientIp: string): Promise<boolean> {
    const ip = normalizeIpAddress(clientIp);
    if (ip === null) return false;
    return this.#metaNetworks.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
  }

  public async isDatacenterBot(input: DatacenterClassificationInput): Promise<boolean> {
    if (input.isCrawler || input.metaNetwork) return false;
    const ip = normalizeIpAddress(input.clientIp);
    return ip === null ? false : containsIpv4(this.#ranges, ip);
  }

  public async detectReplay(input: ReplayDetectionInput): Promise<ReplayDetection> {
    const ip = normalizeIpAddress(input.clientIp);
    if (input.token === "" || Buffer.byteLength(input.token, "utf8") > 512 || ip === null
      || input.windowSeconds < 60 || input.minimumTotal < 1 || input.minimumToken < 2
      || input.tokenFieldCap < 2 || input.minimumToken > input.minimumTotal) {
      return { detected: false, total: 0, token: 0 };
    }
    if (this.options.replayRedis.status === "wait") {
      await this.options.replayRedis.connect();
    }
    const ipHash = createHash("sha256").update(`${ip}|${this.options.ipHashSecret}`).digest("hex").slice(0, 32);
    const tokenHash = createHash("sha256").update(input.token).digest("hex").slice(0, 32);
    const result = await this.options.replayRedis.eval(
      replayScript,
      1,
      this.#key(`domain:${input.domainId}:fbr:${ipHash}`),
      `t:${tokenHash}`,
      input.windowSeconds,
      input.tokenFieldCap,
    );
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error("Replay Redis returned an invalid result.");
    }
    const total = nonNegativeInteger(result[0]);
    const token = nonNegativeInteger(result[1]);
    return {
      detected: total >= input.minimumTotal && token >= input.minimumToken,
      total,
      token,
    };
  }

  public async getDiversionContext(input: DiversionContextInput): Promise<CurrentDiversionContext> {
    const [settings, geoState, country] = await Promise.all([
      this.#getSettings(input.domainId, ["skim_destination_url", "skim_default_percent"]),
      this.#getGeoState(input.domainId),
      this.#resolveCountry(input),
    ]);
    return {
      skimDestinationUrl: settings.skim_destination_url ?? "",
      country,
      defaultCountryPercent: boundedPercent(settings.skim_default_percent),
      explicitCountryPercentages: geoState.percentages,
      countryQualityPolicy: geoState.qualityPolicy,
    };
  }

  async #resolveCountry(input: DiversionContextInput): Promise<string | null> {
    const trusted = normalizeCountryCode(input.trustedCountry ?? null);
    if (trusted !== null) return trusted;
    return normalizeCountryCode(await this.options.resolveCountry(input.clientIp));
  }

  async #getSettings(domainId: number, keys: readonly string[]): Promise<Record<string, string | null>> {
    const values: Record<string, string | null> = {};
    const misses: string[] = [];
    await Promise.all(keys.map(async (key) => {
      try {
        const cached = await this.options.cache.get(this.#key(`domain:${domainId}:set:${key}`));
        if (cached?.startsWith("v") === true) {
          values[key] = cached.slice(1);
          return;
        }
        if (cached === "n") {
          values[key] = null;
          return;
        }
      } catch {
        // MariaDB remains authoritative when Redis is unavailable.
      }
      misses.push(key);
    }));
    if (misses.length === 0) return values;

    const placeholders = misses.map(() => "?").join(",");
    const [rows] = await this.options.sql.execute<SettingRow[]>(
      `SET STATEMENT max_statement_time=0.25 FOR
       SELECT skey, svalue FROM domain_settings WHERE domain_id = ? AND skey IN (${placeholders})`,
      [domainId, ...misses],
    );
    const found = new Map(rows.map((row) => [row.skey, row.svalue === null ? "" : String(row.svalue)]));
    await Promise.allSettled(misses.map(async (key) => {
      const value = found.get(key) ?? null;
      values[key] = value;
      await this.options.cache.set(
        this.#key(`domain:${domainId}:set:${key}`),
        value === null ? "n" : `v${value}`,
        settingsTtlSeconds,
      );
    }));
    return values;
  }

  async #getGeoState(domainId: number): Promise<{
    percentages: Readonly<Record<string, number>>;
    qualityPolicy: unknown;
  }> {
    const key = this.#key(`domain:${domainId}:georules`);
    try {
      const cached = await this.options.cache.get(key);
      if (cached !== null) {
        const parsed = decodeGeoState(cached);
        if (parsed !== null) return parsed;
      }
    } catch {
      // Use the bounded MariaDB state query below.
    }

    const [rows] = await this.options.sql.execute<GeoStateRow[]>(
      `SET STATEMENT max_statement_time=0.25 FOR
       SELECT country_code, percent, NULL AS policy_json FROM geo_rules WHERE domain_id = ?
       UNION ALL
       SELECT NULL AS country_code, NULL AS percent, svalue AS policy_json
         FROM domain_settings WHERE domain_id = ? AND skey = ?`,
      [domainId, domainId, storedQualityPolicyKey],
    );
    const serialized: Record<string, unknown> = {};
    for (const row of rows) {
      if (row.country_code === null) {
        serialized[qualityPolicyKey] = parseJsonOrNull(row.policy_json);
        continue;
      }
      const country = normalizeCountryCode(row.country_code);
      if (country !== null) serialized[country] = boundedPercent(row.percent);
    }
    const state = decodeGeoState(JSON.stringify(serialized)) ?? { percentages: {}, qualityPolicy: null };
    await Promise.allSettled([this.options.cache.set(key, JSON.stringify(serialized), settingsTtlSeconds)]);
    return state;
  }

  #key(suffix: string): string {
    return `${this.options.appNamespace}:${suffix}`;
  }
}

export function containsIpv4(ranges: DatacenterIpv4Ranges, rawIp: string): boolean {
  const value = ipv4ToUnsigned(rawIp);
  if (value === null || ranges.starts.length !== ranges.ends.length) return false;
  let low = 0;
  let high = ranges.starts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = ranges.starts[middle];
    const end = ranges.ends[middle];
    if (start === undefined || end === undefined || !Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (value < start) high = middle - 1;
    else if (value > end) low = middle + 1;
    else return true;
  }
  return false;
}

function compileMetaNetworks(): BlockList {
  const result = new BlockList();
  for (const cidr of metaCidrs) {
    const [address = "", rawPrefix = ""] = cidr.split("/", 2);
    const family = isIP(address) === 4 ? "ipv4" : "ipv6";
    result.addSubnet(address, Number(rawPrefix), family);
  }
  return result;
}

function decodeGeoState(raw: string): { percentages: Readonly<Record<string, number>>; qualityPolicy: unknown } | null {
  if (Buffer.byteLength(raw, "utf8") > 32_768) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || Object.keys(value).length > 251) return null;
    const percentages: Record<string, number> = {};
    for (const [key, stored] of Object.entries(value)) {
      if (key === qualityPolicyKey) continue;
      const country = normalizeCountryCode(key);
      if (country === null || (typeof stored !== "number" && typeof stored !== "string")) return null;
      percentages[country] = boundedPercent(stored);
    }
    return { percentages, qualityPolicy: value[qualityPolicyKey] ?? null };
  } catch {
    return null;
  }
}

function boundedPercent(value: unknown): number {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  const match = text.match(/^-?[0-9]+/);
  const parsed = match === null ? 0 : Number(match[0]);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.trunc(parsed))) : 0;
}

function ipv4ToUnsigned(value: string): number | null {
  if (isIP(value) !== 4) return null;
  const parts = value.split(".").map(Number);
  if (parts.length !== 4) return null;
  return (((parts[0] ?? 0) * 0x1000000)
    + ((parts[1] ?? 0) * 0x10000)
    + ((parts[2] ?? 0) * 0x100)
    + (parts[3] ?? 0)) >>> 0;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function parseJsonOrNull(value: string | null): unknown {
  if (value === null || Buffer.byteLength(value, "utf8") > 4_096) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
