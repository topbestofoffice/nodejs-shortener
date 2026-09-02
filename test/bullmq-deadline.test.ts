import { afterEach, describe, expect, it, vi } from "vitest";
import { withDeadline } from "../src/modules/uploads/bullmq-executor.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("BullMQ web-path deadline", () => {
  it("returns a result that arrives before the deadline", async () => {
    await expect(withDeadline(Promise.resolve("ready"), 100)).resolves.toBe("ready");
  });

  it("rejects a Redis operation that never settles", async () => {
    vi.useFakeTimers();
    const result = expect(withDeadline(new Promise<never>(() => undefined), 100))
      .rejects.toThrow("Operation timed out.");
    await vi.advanceTimersByTimeAsync(100);
    await result;
  });

  it("rejects invalid deadline configuration", async () => {
    await expect(withDeadline(Promise.resolve("unused"), 0)).rejects.toThrow("positive safe integer");
  });
});
