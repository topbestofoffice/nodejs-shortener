import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RedisCacheClaimStore } from "../src/infrastructure/redis-store.js";
import {
  PrivateFileDeliveredCountryGapSink,
  RedisDeliveredCountryObserver,
  normalizeDeliveredCountry,
  type DeliveredCountryRedisEvalClient,
} from "../src/modules/reporting/observer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

describe("Delivered-country Redis observer", () => {
  it("disables transport-level replay for ambiguous Redis mutations", async () => {
    const store = new RedisCacheClaimStore({ url: "redis://127.0.0.1:6379" });
    expect(store.client.options.autoResendUnfulfilledCommands).toBe(false);
    await store.close();
  });

  it("writes one domain-scoped ten-minute counter with the accepted absolute expiry", async () => {
    const client = new FakeEvalClient();
    const observer = new RedisDeliveredCountryObserver({
      client,
      keyPrefix: "shortener:",
      enabledDomainIds: [2, 3],
      gapSink: { mark: async () => undefined },
    });

    await observer.observe({
      domainId: 3,
      country: "in",
      occurredAt: new Date("2026-09-01T00:05:30.000Z"),
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({
      numberOfKeys: 1,
      args: [
        "shortener:delivered-country-shadow:v1:d3:b1788220800",
        "c:IN",
        "1788394200000",
      ],
    });
  });

  it("does not retry or accept an ambiguous/failed atomic observation", async () => {
    const client = new FakeEvalClient();
    client.result = -2;
    const observer = new RedisDeliveredCountryObserver({
      client,
      keyPrefix: "shortener",
      enabledDomainIds: [3],
      gapSink: { mark: async () => undefined },
    });

    await expect(observer.observe({
      domainId: 3,
      country: null,
      occurredAt: new Date("2026-09-01T00:05:30.000Z"),
    })).rejects.toThrow("invalid result");
    expect(client.calls).toHaveLength(1);
  });

  it("normalizes only trusted ISO country values", () => {
    expect(normalizeDeliveredCountry(" in ")).toBe("IN");
    expect(normalizeDeliveredCountry(null)).toBe("??");
    expect(normalizeDeliveredCountry("India")).toBe("??");
  });
});

describe("Delivered-country sticky gap", () => {
  it("keeps the first durable private gap instead of silently clearing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "node-shortener-reporting-"));
    temporaryDirectories.push(root);
    const sink = new PrivateFileDeliveredCountryGapSink(root);
    const at = new Date("2026-09-01T00:05:30.000Z");

    await sink.mark({ domainId: 3, occurredAt: at, reason: "accounting" });
    await sink.mark({ domainId: 3, occurredAt: new Date(at.getTime() + 600_000), reason: "observer" });

    await expect(readFile(join(root, "delivered-country-shadow-gap-v1-d3.flag"), "utf8"))
      .resolves.toBe("STATUS=incomplete\nFIRST_BUCKET=1788220800\nREASON=accounting\n");
  });
});

class FakeEvalClient implements DeliveredCountryRedisEvalClient {
  public result: unknown = 1;
  public readonly calls: Array<{
    script: string;
    numberOfKeys: number;
    args: readonly string[];
  }> = [];

  public async eval(script: string, numberOfKeys: number, ...args: readonly string[]): Promise<unknown> {
    this.calls.push({ script, numberOfKeys, args });
    return this.result;
  }
}
