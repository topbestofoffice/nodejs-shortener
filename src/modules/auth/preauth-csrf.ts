import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const preAuthCookieName = "node_shortener_preauth";
export const preAuthTtlSeconds = 30 * 60;
const futureSkewSeconds = 60;

export interface PreAuthCsrfPair {
  readonly cookie: string;
  readonly csrf: string;
  readonly expiresAt: number;
}

export function createPreAuthCsrf(
  domainId: number,
  secret: string,
  nowSeconds: number,
): PreAuthCsrfPair {
  assertInput(domainId, secret, nowSeconds);
  const expiresAt = nowSeconds + preAuthTtlSeconds;
  const nonce = randomBytes(32).toString("hex");
  return {
    cookie: `${expiresAt}.${nonce}.${signature("cookie", domainId, expiresAt, nonce, secret)}`,
    csrf: signature("csrf", domainId, expiresAt, nonce, secret),
    expiresAt,
  };
}

export function isPreAuthCsrfValid(input: {
  readonly domainId: number;
  readonly secret: string;
  readonly nowSeconds: number;
  readonly cookie: string | undefined;
  readonly csrf: string | undefined;
}): boolean {
  try {
    assertInput(input.domainId, input.secret, input.nowSeconds);
  } catch {
    return false;
  }
  if (input.cookie === undefined || input.csrf === undefined || input.cookie.length > 160
    || !/^[a-f0-9]{64}$/.test(input.csrf)) {
    return false;
  }
  const match = /^([1-9][0-9]{9})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(input.cookie);
  if (match === null) return false;
  const expiresAt = Number(match[1]);
  const nonce = match[2] ?? "";
  const suppliedCookieSignature = match[3] ?? "";
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= input.nowSeconds
    || expiresAt > input.nowSeconds + preAuthTtlSeconds + futureSkewSeconds) {
    return false;
  }
  return safeEqual(
    suppliedCookieSignature,
    signature("cookie", input.domainId, expiresAt, nonce, input.secret),
  ) && safeEqual(
    input.csrf,
    signature("csrf", input.domainId, expiresAt, nonce, input.secret),
  );
}

function signature(
  purpose: "cookie" | "csrf",
  domainId: number,
  expiresAt: number,
  nonce: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`preauth-${purpose}-v1|${domainId}|${expiresAt}|${nonce}`)
    .digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const actual = Buffer.from(left, "ascii");
  const expected = Buffer.from(right, "ascii");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertInput(domainId: number, secret: string, nowSeconds: number): void {
  if (!Number.isSafeInteger(domainId) || domainId < 1 || !Number.isSafeInteger(nowSeconds)
    || nowSeconds < 0 || secret.length < 1) {
    throw new TypeError("Invalid pre-authentication CSRF input.");
  }
}
