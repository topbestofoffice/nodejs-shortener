import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ImageExecutionRequest } from "../src/modules/uploads/image-executor.js";
import {
  buildQueuedImageExecutionRequest,
  decideBullMqJobReplay,
  imageAdmissionKey,
  imageWorkerHeartbeatKey,
  imageWorkerHeartbeatObserved,
  withDeadline,
} from "../src/modules/uploads/bullmq-executor.js";

describe("BullMQ pure safety contracts", () => {
  it("rejects every malformed replay generation and handles all safe queue states", () => {
    for (const [stored, requested] of [
      [0, 1], [21, 1], [1.5, 1], [1, 0], [1, 21], [1, 1.5],
    ] as const) {
      expect(decideBullMqJobReplay(stored, requested, "completed")).toBe("reject");
    }
    expect(decideBullMqJobReplay(3, 2, "completed")).toBe("reject");
    expect(decideBullMqJobReplay(2, 2, "unknown")).toBe("reuse");
    expect(decideBullMqJobReplay(1, 2, "active")).toBe("reuse");
    expect(decideBullMqJobReplay(1, 2, "waiting-children")).toBe("reuse");
    for (const state of ["completed", "failed", "waiting", "delayed", "prioritized"]) {
      expect(decideBullMqJobReplay(1, 2, state)).toBe("replace");
    }
    expect(decideBullMqJobReplay(1, 2, "unknown")).toBe("reject");
  });

  it("builds only exact relative queue keys and rejects unsafe request identities", () => {
    const privateDir = join(process.cwd(), "private", "queue-tests");
    const publicDir = join(process.cwd(), "public", "queue-tests");
    const request = validRequest(privateDir, publicDir);

    expect(buildQueuedImageExecutionRequest(request, privateDir, publicDir)).toMatchObject({
      jobId: request.jobId,
      attempt: 1,
      inputKey: "input.part",
      outputTempKey: "output.part",
      finalKey: "image.jpg",
      deferPublication: true,
    });

    for (const invalid of [
      { ...request, jobId: "not-a-job" },
      { ...request, deferPublication: false },
      { ...request, attempt: 0 },
      { ...request, attempt: 21 },
      { ...request, attempt: 1.5 },
    ] as ImageExecutionRequest[]) {
      expect(() => buildQueuedImageExecutionRequest(invalid, privateDir, publicDir)).toThrow();
    }

    for (const invalid of [
      { ...request, inputPath: join(privateDir, "..", "outside.input") },
      { ...request, inputPath: privateDir },
      { ...request, outputTempPath: join(privateDir, "..", "outside.output") },
      { ...request, finalPath: join(publicDir, "..", "outside.jpg") },
    ]) {
      expect(() => buildQueuedImageExecutionRequest(invalid, privateDir, publicDir)).toThrow(
        /outside its configured directory/,
      );
    }
  });

  it("binds queue keys and heartbeat acceptance to one exact deployment", () => {
    const identity = "a".repeat(64);
    const valid = `${identity}:123:1f4ed7e5-9854-4fae-abd8-217909229af1`;
    expect(imageAdmissionKey("pilot")).toBe("pilot:image-normalization:admission:v1");
    expect(imageWorkerHeartbeatKey("pilot")).toBe("pilot:image-normalization:worker-singleton:v2");
    expect(imageWorkerHeartbeatObserved(valid, identity)).toBe(true);
    expect(imageWorkerHeartbeatObserved(null, identity)).toBe(false);
    expect(imageWorkerHeartbeatObserved(`bad:${valid}`, identity)).toBe(false);
    expect(imageWorkerHeartbeatObserved(`${identity}:not-valid`, identity)).toBe(false);
    expect(() => imageWorkerHeartbeatObserved(valid, "invalid")).toThrow("deployment identity is invalid");
  });

  it("normalizes non-Error promise rejection without leaking its value", async () => {
    // Deliberately model a non-conforming provider that rejects with a string.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(withDeadline(Promise.reject("private Redis detail"), 100))
      .rejects.toThrow("Operation failed.");
  });
});

function validRequest(privateDir: string, publicDir: string): ImageExecutionRequest {
  return {
    jobId: "a".repeat(32),
    attempt: 1,
    inputPath: join(privateDir, "input.part"),
    outputTempPath: join(privateDir, "output.part"),
    finalPath: join(publicDir, "image.jpg"),
    maxPixels: 20_000_000,
    deferPublication: true,
  };
}
