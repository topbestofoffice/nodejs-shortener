import { describe, expect, it } from "vitest";
import {
  escapeDashboardLikeLiteral,
  parseDashboardHistoryRequest,
  resolveDashboardPagination,
} from "../src/modules/dashboard/history-policy.js";

describe("dashboard history request policy", () => {
  it("normalizes search, page size and page without accepting coercion tricks", () => {
    expect(parseDashboardHistoryRequest({ q: "  encoded_%!  ", per: "50", page: "3" })).toEqual({
      query: "encoded_%!",
      perPage: 50,
      requestedPage: 3,
    });
    expect(parseDashboardHistoryRequest({ q: ["not", "scalar"], per: "20x", page: "2x" })).toEqual({
      query: "",
      perPage: 20,
      requestedPage: 1,
    });
    expect(parseDashboardHistoryRequest({ per: "100", page: "9007199254740992" })).toEqual({
      query: "",
      perPage: 100,
      requestedPage: 1,
    });
  });

  it("escapes literal LIKE metacharacters with the portable PHP escape contract", () => {
    expect(escapeDashboardLikeLiteral("a!b%c_d")).toBe("a!!b!%c!_d");
  });

  it("uses current match count to clamp stale or out-of-range page requests", () => {
    const request = parseDashboardHistoryRequest({ q: "news", per: "20", page: "99" });
    expect(resolveDashboardPagination(request, 41)).toEqual({
      query: "news",
      perPage: 20,
      requestedPage: 99,
      matchCount: 41,
      page: 3,
      totalPages: 3,
      offset: 40,
    });
  });

  it("keeps the empty history on a real first page and fails invalid counts closed", () => {
    const request = parseDashboardHistoryRequest({ per: "50", page: "4" });
    expect(resolveDashboardPagination(request, 0)).toMatchObject({
      matchCount: 0,
      page: 1,
      totalPages: 1,
      offset: 0,
    });
    expect(resolveDashboardPagination(request, Number.NaN)).toMatchObject({
      matchCount: 0,
      page: 1,
      totalPages: 1,
      offset: 0,
    });
  });
});
