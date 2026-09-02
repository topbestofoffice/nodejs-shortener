import { lstat, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import type { Redis } from "ioredis";
import type {
  DeliveredCountryGapEvent,
  DeliveredCountryObservation,
} from "../../core/types.js";
import type { DeliveredCountryObserverStore } from "../../ports.js";
import {
  DELIVERED_COUNTRY_BUCKET_SECONDS,
  DELIVERED_COUNTRY_REDIS_RETENTION_SECONDS,
} from "./completeness.js";

export interface DeliveredCountryRedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: readonly string[]): Promise<unknown>;
}

export interface DeliveredCountryGapSink {
  mark(event: DeliveredCountryGapEvent): Promise<void>;
}

export interface RedisDeliveredCountryObserverOptions {
  readonly client: Redis | DeliveredCountryRedisEvalClient;
  readonly keyPrefix: string;
  readonly enabledDomainIds: readonly number[];
  readonly gapSink: DeliveredCountryGapSink;
}

/**
 * Domain-scoped, constant-time Redis observer for admitted Delivered outcomes.
 * It never retries an ambiguous EVAL result: the sticky gap latch makes that
 * bucket unavailable to a future publisher instead of risking a double count.
 */
export class RedisDeliveredCountryObserver implements DeliveredCountryObserverStore {
  readonly #client: DeliveredCountryRedisEvalClient;
  readonly #keyPrefix: string;
  readonly #enabledDomainIds: ReadonlySet<number>;
  readonly #gapSink: DeliveredCountryGapSink;

  public constructor(options: RedisDeliveredCountryObserverOptions) {
    const keyPrefix = options.keyPrefix.replace(/:+$/, "");
    if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(keyPrefix)) {
      throw new Error("Delivered-country observer requires an explicit Redis key prefix.");
    }
    const enabled = new Set(options.enabledDomainIds);
    if ([...enabled].some((domainId) => !Number.isInteger(domainId) || domainId < 1 || domainId > 65_535)) {
      throw new Error("Delivered-country observer contains an invalid domain ID.");
    }
    this.#client = options.client;
    this.#keyPrefix = keyPrefix;
    this.#enabledDomainIds = enabled;
    this.#gapSink = options.gapSink;
  }

  public isEnabled(domainId: number): boolean {
    return this.#enabledDomainIds.has(domainId);
  }

  public async observe(event: DeliveredCountryObservation): Promise<void> {
    if (!this.isEnabled(event.domainId)) {
      throw new Error("Delivered-country observation is not enabled for this domain.");
    }
    const bucketStart = deliveredCountryBucketStart(event.occurredAt);
    const expiresAtMs = (bucketStart + DELIVERED_COUNTRY_BUCKET_SECONDS
      + DELIVERED_COUNTRY_REDIS_RETENTION_SECONDS) * 1000;
    const key = `${this.#keyPrefix}:delivered-country-shadow:v1:d${event.domainId}:b${bucketStart}`;
    const countryField = `c:${normalizeDeliveredCountry(event.country)}`;
    const result = await this.#client.eval(
      DELIVERED_COUNTRY_OBSERVE_SCRIPT,
      1,
      key,
      countryField,
      String(expiresAtMs),
    );
    if (result !== 1) {
      throw new Error("Delivered-country Redis observer returned an invalid result.");
    }
  }

  public async markGap(event: DeliveredCountryGapEvent): Promise<void> {
    if (!this.isEnabled(event.domainId)) {
      return;
    }
    await this.#gapSink.mark(event);
  }
}

/** Sticky, first-gap-wins marker in the deployment's private runtime tree. */
export class PrivateFileDeliveredCountryGapSink implements DeliveredCountryGapSink {
  public constructor(private readonly directory: string) {}

  public async mark(event: DeliveredCountryGapEvent): Promise<void> {
    if (!Number.isInteger(event.domainId) || event.domainId < 1 || event.domainId > 65_535) {
      throw new Error("Invalid Delivered-country gap domain.");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o750 });
    const directoryStatus = await lstat(this.directory);
    if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
      throw new Error("Delivered-country gap directory is not a private regular directory.");
    }
    const path = resolve(this.directory, `delivered-country-shadow-gap-v1-d${event.domainId}.flag`);
    const bucketStart = deliveredCountryBucketStart(event.occurredAt);
    const body = `STATUS=incomplete\nFIRST_BUCKET=${bucketStart}\nREASON=${event.reason}\n`;

    let handle;
    try {
      handle = await open(path, "wx", 0o640);
    } catch (error) {
      if (isAlreadyExists(error) && await isRegularFile(path)) {
        return;
      }
      throw error;
    }
    try {
      await handle.writeFile(body, { encoding: "utf8" });
      await handle.chmod(0o640);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

export function deliveredCountryBucketStart(value: Date): number {
  const milliseconds = value.getTime();
  if (!Number.isSafeInteger(milliseconds)) {
    throw new RangeError("Delivered-country observation timestamp is invalid.");
  }
  const seconds = Math.floor(milliseconds / 1000);
  return Math.floor(seconds / DELIVERED_COUNTRY_BUCKET_SECONDS) * DELIVERED_COUNTRY_BUCKET_SECONDS;
}

export function normalizeDeliveredCountry(country: string | null): string {
  const normalized = country?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(normalized) ? normalized : "??";
}

export const DELIVERED_COUNTRY_OBSERVE_SCRIPT = `
local bucket_type = redis.pcall('TYPE', KEYS[1])
if type(bucket_type) == 'table' and bucket_type.err then
  return -2
end
local bucket_kind = type(bucket_type) == 'table' and bucket_type.ok or bucket_type
if bucket_kind ~= 'none' and bucket_kind ~= 'hash' then
  return -2
end

local observed = redis.pcall('HINCRBY', KEYS[1], '__delivered_observed', 1)
if type(observed) == 'table' and observed.err then
  return -2
end
local country = redis.pcall('HINCRBY', KEYS[1], ARGV[1], 1)
if type(country) == 'table' and country.err then
  local undo_observed = redis.pcall('HINCRBY', KEYS[1], '__delivered_observed', -1)
  if type(undo_observed) == 'number' and undo_observed == 0 then
    redis.pcall('HDEL', KEYS[1], '__delivered_observed')
  end
  return -2
end
local expiry = redis.pcall('PEXPIREAT', KEYS[1], ARGV[2])
if (type(expiry) == 'table' and expiry.err) or expiry ~= 1 then
  local undo_country = redis.pcall('HINCRBY', KEYS[1], ARGV[1], -1)
  if type(undo_country) == 'number' and undo_country == 0 then
    redis.pcall('HDEL', KEYS[1], ARGV[1])
  end
  local undo_observed = redis.pcall('HINCRBY', KEYS[1], '__delivered_observed', -1)
  if type(undo_observed) == 'number' and undo_observed == 0 then
    redis.pcall('HDEL', KEYS[1], '__delivered_observed')
  end
  return -2
end
return 1
`;

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "EEXIST";
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    return status.isFile() && !status.isSymbolicLink();
  } catch {
    return false;
  }
}
