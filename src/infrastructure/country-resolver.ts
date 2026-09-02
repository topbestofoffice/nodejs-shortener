import { createHash } from "node:crypto";
import { BlockList, isIP } from "node:net";
import type { RowDataPacket } from "mysql2/promise";
import type { Clock } from "../ports.js";
import { normalizeCountryCode, normalizeIpAddress } from "../security/client-identity.js";
import type { DecisionSqlExecutor } from "./current-decision-provider.js";

interface CountryRow extends RowDataPacket {
  country: string | null;
  fetched_at: Date | string;
}

export interface CountryResolverOptions {
  readonly sql: DecisionSqlExecutor;
  readonly ipHashSecret: string;
  readonly clock: Clock;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

/** Current PHP-compatible IP geo cache with a bounded, fail-safe async lookup. */
export class MysqlCachedCountryResolver {
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  public constructor(private readonly options: CountryResolverOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.requestTimeoutMs ?? 2_000;
  }

  public async resolve(rawIp: string): Promise<string | null> {
    const ip = normalizeIpAddress(rawIp);
    if (ip === null || !isPublicRoutableIp(ip)) return null;
    try {
      const ipHash = createHash("sha256").update(`${ip}|${this.options.ipHashSecret}`).digest("hex");
      const [rows] = await this.options.sql.execute<CountryRow[]>(
        `SET STATEMENT max_statement_time=0.25 FOR
         SELECT country, fetched_at FROM ip_geo_cache WHERE ip_hash = ? LIMIT 1`,
        [ipHash],
      );
      const existing = rows[0];
      const cachedCountry = normalizeCountryCode(existing?.country ?? null);
      if (cachedCountry !== null) return cachedCountry;
      if (existing !== undefined && isRecent(existing.fetched_at, this.options.clock.now(), 3_600_000)) return null;

      const country = await this.#lookup(ip);
      const timestamp = formatUtc(this.options.clock.now());
      await this.options.sql.execute(
        `SET STATEMENT max_statement_time=0.25 FOR
         INSERT INTO ip_geo_cache (ip_hash, country, fetched_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE country = VALUES(country), fetched_at = VALUES(fetched_at)`,
        [ipHash, country, timestamp],
      );
      return country;
    } catch {
      return null;
    }
  }

  async #lookup(ip: string): Promise<string | null> {
    try {
      const response = await this.#fetch(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,countryCode`,
        { signal: AbortSignal.timeout(this.#timeoutMs) },
      );
      const raw = await response.text();
      if (Buffer.byteLength(raw, "utf8") > 4_096) return null;
      const decoded = JSON.parse(raw) as unknown;
      if (!isRecord(decoded) || decoded.status !== "success" || typeof decoded.countryCode !== "string") return null;
      return normalizeCountryCode(decoded.countryCode.slice(0, 2));
    } catch {
      return null;
    }
  }
}

const nonPublicNetworks = compileNonPublicNetworks();

export function isPublicRoutableIp(rawIp: string): boolean {
  const ip = normalizeIpAddress(rawIp);
  if (ip === null) return false;
  return !nonPublicNetworks.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
}

function compileNonPublicNetworks(): BlockList {
  const result = new BlockList();
  for (const cidr of [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
    "::/128", "::1/128", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8",
  ]) {
    const [address = "", prefix = ""] = cidr.split("/", 2);
    result.addSubnet(address, Number(prefix), isIP(address) === 4 ? "ipv4" : "ipv6");
  }
  return result;
}

function isRecent(value: Date | string, now: Date, windowMs: number): boolean {
  const normalized = value instanceof Date || /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)
    ? value
    : `${value.replace(" ", "T")}Z`;
  const timestamp = normalized instanceof Date ? normalized.getTime() : Date.parse(normalized);
  return Number.isFinite(timestamp) && timestamp > now.getTime() - windowMs;
}

function formatUtc(value: Date): string {
  return value.toISOString().slice(0, 19).replace("T", " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
