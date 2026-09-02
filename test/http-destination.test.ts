import { describe, expect, it } from "vitest";
import {
  maximumHttpDestinationLength,
  normalizeHttpDestination,
} from "../src/core/http-destination.js";

describe("shared HTTP destination policy", () => {
  it("trims only surrounding spaces and preserves accepted URL spelling", () => {
    expect(normalizeHttpDestination("  HTTPS://EXAMPLE.COM/%2fPath?Q=%2f&Mixed=VaLue  "))
      .toBe("HTTPS://EXAMPLE.COM/%2fPath?Q=%2f&Mixed=VaLue");
  });

  it("accepts exactly 4096 characters and rejects 4097", () => {
    const prefix = "https://example.com/";
    const exact = `${prefix}${"a".repeat(maximumHttpDestinationLength - prefix.length)}`;
    expect(exact).toHaveLength(maximumHttpDestinationLength);
    expect(normalizeHttpDestination(exact)).toBe(exact);
    expect(normalizeHttpDestination(`${exact}a`)).toBeNull();
  });

  it.each([
    "",
    "   ",
    "javascript:alert(1)",
    "ftp://example.com/file",
    "https://user@example.com/private",
    "https://user:pass@example.com/private",
    "https:///",
    "not a url",
    "https://example.com/a\tb",
    "https://example.com/a\nb",
    "https://example.com/a\0b",
    "https://example.com/a\u007fb",
  ])("rejects %j", (value) => {
    expect(normalizeHttpDestination(value)).toBeNull();
  });
});
