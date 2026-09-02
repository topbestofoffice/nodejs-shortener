import { describe, expect, it } from "vitest";
import {
  claimWithOwnership,
  type RedisClaimClient,
} from "../src/infrastructure/redis-store.js";

describe("D3 token-owned Redis click claim", () => {
  it("recovers an accepted SET whose reply was lost only when readback proves ownership", async () => {
    const client = new FakeClaimClient();
    client.mode = "lost_reply_after_accept";
    const token = "a".repeat(32);

    await expect(claimWithOwnership(client, "click:d3", 15, token)).resolves.toBe("winner");
    expect(client.values.get("click:d3")).toBe(token);
  });

  it("distinguishes a confirmed duplicate from an expired or unknown claim", async () => {
    const duplicate = new FakeClaimClient();
    duplicate.mode = "nx_miss";
    duplicate.values.set("click:d3", "b".repeat(32));
    await expect(claimWithOwnership(duplicate, "click:d3", 15, "a".repeat(32)))
      .resolves.toBe("duplicate");

    const legacy = new FakeClaimClient();
    legacy.mode = "nx_miss";
    legacy.values.set("click:d3", "1");
    await expect(claimWithOwnership(legacy, "click:d3", 15, "a".repeat(32)))
      .resolves.toBe("duplicate");

    const expired = new FakeClaimClient();
    expired.mode = "nx_miss";
    await expect(claimWithOwnership(expired, "click:d3", 15, "a".repeat(32)))
      .resolves.toBe("unavailable");
  });

  it("fails open when SET ownership or its readback cannot be proved", async () => {
    const beforeAccept = new FakeClaimClient();
    beforeAccept.mode = "set_failure_before_accept";
    await expect(claimWithOwnership(beforeAccept, "click:d3", 15, "a".repeat(32)))
      .resolves.toBe("unavailable");

    const unreadable = new FakeClaimClient();
    unreadable.mode = "get_failure";
    unreadable.values.set("click:d3", "b".repeat(32));
    await expect(claimWithOwnership(unreadable, "click:d3", 15, "a".repeat(32)))
      .resolves.toBe("unavailable");
  });

  it("keeps D2 and D3 key namespaces independent", async () => {
    const client = new FakeClaimClient();
    const token2 = "2".repeat(32);
    const token3 = "3".repeat(32);

    await expect(claimWithOwnership(client, "click-dedup:v1:d2:l77:hhash", 15, token2))
      .resolves.toBe("winner");
    await expect(claimWithOwnership(client, "click-dedup:v1:d3:l77:hhash", 15, token3))
      .resolves.toBe("winner");
    expect(client.values.size).toBe(2);
  });
});

type FakeMode = "normal" | "lost_reply_after_accept" | "nx_miss" | "set_failure_before_accept" | "get_failure";

class FakeClaimClient implements RedisClaimClient {
  public readonly values = new Map<string, string>();
  public mode: FakeMode = "normal";

  public async set(
    key: string,
    value: string,
    _expiryMode: "EX",
    _ttlSeconds: number,
    _condition: "NX",
  ): Promise<unknown> {
    if (this.mode === "lost_reply_after_accept") {
      this.values.set(key, value);
      throw new Error("SET reply lost");
    }
    if (this.mode === "set_failure_before_accept") {
      throw new Error("SET unavailable");
    }
    if (this.mode === "nx_miss" || this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);
    return "OK";
  }

  public async get(key: string): Promise<unknown> {
    if (this.mode === "get_failure") {
      throw new Error("GET unavailable");
    }
    return this.values.get(key) ?? null;
  }
}
