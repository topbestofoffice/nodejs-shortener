import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import type { CacheStore, ClaimResult, DuplicateClaimStore } from "../ports.js";

export interface RedisStoreOptions {
  readonly url: string;
  readonly connectTimeoutMs?: number;
  readonly commandTimeoutMs?: number;
}

export interface RedisClaimClient {
  set(key: string, value: string, expiryMode: "EX", ttlSeconds: number, condition: "NX"): Promise<unknown>;
  get(key: string): Promise<unknown>;
}

/**
 * Claim one Redis key with a per-request ownership token. A SET reply can be
 * lost after Redis commits it, so every non-successful reply is resolved by a
 * readback: our token is a winner, another token is a confirmed duplicate,
 * and a missing/unreadable value remains honestly unavailable.
 */
export async function claimWithOwnership(
  client: RedisClaimClient,
  key: string,
  ttlSeconds: number,
  token: string,
): Promise<ClaimResult> {
  try {
    const result = await client.set(key, token, "EX", ttlSeconds, "NX");
    if (result === "OK" || result === true) {
      return "winner";
    }
  } catch {
    // Redis may have accepted SET before the connection lost its reply.
  }

  try {
    const stored = await client.get(key);
    if (typeof stored !== "string" || stored.length === 0) {
      return "unavailable";
    }
    return stored === token ? "winner" : "duplicate";
  } catch {
    return "unavailable";
  }
}

export class RedisCacheClaimStore implements CacheStore, DuplicateClaimStore {
  public readonly client: Redis;

  public constructor(options: RedisStoreOptions) {
    this.client = new Redis(options.url, {
      connectTimeout: options.connectTimeoutMs ?? 500,
      commandTimeout: options.commandTimeoutMs ?? 200,
      // Reporting EVAL and token-owned SET NX operations must never be
      // transparently replayed after an ambiguous connection loss.
      autoResendUnfulfilledCommands: false,
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
  }

  public async connect(): Promise<void> {
    if (this.client.status === "wait") {
      await this.client.connect();
    }
  }

  public async get(key: string): Promise<string | null> {
    await this.connect();
    return this.client.get(key);
  }

  public async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.connect();
    await this.client.set(key, value, "EX", ttlSeconds);
  }

  public async delete(...keys: readonly string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.connect();
    await this.client.del(...keys);
  }

  public async claim(key: string, ttlSeconds: number): Promise<ClaimResult> {
    let token: string;
    try {
      token = randomBytes(16).toString("hex");
    } catch {
      return "unavailable";
    }
    try {
      await this.connect();
      return await claimWithOwnership(this.client, key, ttlSeconds, token);
    } catch {
      return "unavailable";
    }
  }

  public async close(): Promise<void> {
    if (this.client.status !== "end") {
      this.client.disconnect(false);
    }
  }
}
