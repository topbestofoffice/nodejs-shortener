import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { crashStopImageWorkerAfterLeaseLoss } from "../src/workers/lease-loss.js";

describe("image worker lease-loss process fence", () => {
  it("logs once and crash-stops synchronously without entering graceful close", () => {
    const events: string[] = [];
    const exitNow = vi.fn((code: number) => { events.push(`exit:${code}`); });

    crashStopImageWorkerAfterLeaseLoss(new Error("owner changed\nprivate detail"), {
      writeError: (message) => { events.push(`log:${message}`); },
      exitNow,
    });

    expect(events).toEqual([
      "log:image worker singleton lease lost: owner changed private detail\n",
      "exit:1",
    ]);
    expect(exitNow).toHaveBeenCalledOnce();
  });

  it("terminates a child with referenced work instead of waiting for graceful completion", () => {
    const fixture = fileURLToPath(new URL("./fixtures/image-worker-lease-loss-child.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", fixture], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("before-lease-loss");
    expect(result.stdout).not.toContain("unreachable-after-lease-loss");
    expect(result.stderr).toContain("image worker singleton lease lost: test owner conflict");
  });
});
