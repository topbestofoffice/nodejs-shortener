import { describe, expect, it } from "vitest";
import { createPreAuthCsrf, isPreAuthCsrfValid, preAuthTtlSeconds } from "../src/modules/auth/preauth-csrf.js";

const secret = "preauth-test-secret";
const nowSeconds = 1_787_486_400;

describe("pre-authentication CSRF", () => {
  it("binds one signed token pair to the dashboard domain and expiry", () => {
    const pair = createPreAuthCsrf(1, secret, nowSeconds);
    expect(pair.expiresAt).toBe(nowSeconds + preAuthTtlSeconds);
    expect(isPreAuthCsrfValid({ domainId: 1, secret, nowSeconds, cookie: pair.cookie, csrf: pair.csrf })).toBe(true);
    expect(isPreAuthCsrfValid({ domainId: 2, secret, nowSeconds, cookie: pair.cookie, csrf: pair.csrf })).toBe(false);
    expect(isPreAuthCsrfValid({
      domainId: 1,
      secret,
      nowSeconds: pair.expiresAt,
      cookie: pair.cookie,
      csrf: pair.csrf,
    })).toBe(false);
  });

  it("rejects missing, malformed, future and independently issued token pairs", () => {
    const first = createPreAuthCsrf(1, secret, nowSeconds);
    const second = createPreAuthCsrf(1, secret, nowSeconds);
    for (const candidate of [
      { cookie: undefined, csrf: first.csrf },
      { cookie: first.cookie, csrf: undefined },
      {
        cookie: `${first.cookie.slice(0, -1)}${first.cookie.endsWith("0") ? "1" : "0"}`,
        csrf: first.csrf,
      },
      { cookie: first.cookie, csrf: second.csrf },
      { cookie: first.cookie, csrf: "not-a-token" },
    ]) {
      expect(isPreAuthCsrfValid({ domainId: 1, secret, nowSeconds, ...candidate })).toBe(false);
    }
  });
});
