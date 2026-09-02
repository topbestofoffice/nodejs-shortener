import { describe, expect, it } from "vitest";
import {
  bulkCreateAnalyticsResult,
  bulkCreateCompleted,
  classifyCreateResponse,
  countBucket,
} from "../src/modules/dashboard/client-contract.js";

describe("current dashboard mutation contract", () => {
  it("recognizes only the exact marked pre-commit 429 as manually retryable", () => {
    const exact = {
      ok: false,
      failure_code: "image_processor_busy",
      link_committed: false,
      retryable: true,
    };
    expect(classifyCreateResponse(429, exact)).toBe("retryable_precommit");
    expect(classifyCreateResponse(429, { ...exact, retryable: false })).toBe("uncertain");
    expect(classifyCreateResponse(429, { ...exact, failure_code: "wrong" })).toBe("uncertain");
    expect(classifyCreateResponse(429, "<html>edge limit</html>")).toBe("uncertain");
  });

  it.each([408, 500, 503])("keeps HTTP %i commit-uncertain", (status) => {
    expect(classifyCreateResponse(status, { ok: false })).toBe("uncertain");
  });

  it("uses one complete-only predicate for Quick Reuse and Remember", () => {
    expect(bulkCreateCompleted({ created: 2, failed: 0 })).toBe(true);
    expect(bulkCreateCompleted({ created: 2, failed: 1 })).toBe(false);
    expect(bulkCreateCompleted({ created: 0, failed: 0 })).toBe(false);
    expect(bulkCreateCompleted({ created: 0, failed: 3 })).toBe(false);
  });

  it("classifies complete, mixed, empty and failed Bulk truthfully", () => {
    expect(bulkCreateAnalyticsResult({ created: 2, failed: 0 })).toBe("success");
    expect(bulkCreateAnalyticsResult({ created: 2, failed: 1 })).toBe("partial");
    expect(bulkCreateAnalyticsResult({ created: 0, failed: 0 })).toBe("failure");
    expect(bulkCreateAnalyticsResult({ created: 0, failed: 3 })).toBe("failure");
    expect(bulkCreateAnalyticsResult({ created: "2", failed: "1" })).toBe("partial");
    expect(bulkCreateAnalyticsResult({ created: -2, failed: Number.NaN })).toBe("failure");
  });

  it("retains a truthful zero count bucket", () => {
    expect([0, 1, 2, 6, 21, 101].map(countBucket)).toEqual(["0", "1", "2_5", "6_20", "21_100", "101_plus"]);
  });
});
