import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  createClientIdentityResolver,
  normalizeIpAddress,
  type ClientIdentityRequest,
} from "../src/security/client-identity.js";

const trustedConfiguration = {
  cloudflare: {
    clientIpHeader: "CF-Connecting-IP",
    countryHeader: "CF-IPCountry",
    trustedProxyCidrs: ["127.0.0.1", "10.20.0.0/16", "2001:db8:1234::/48"],
  },
} as const;

describe("normalizeIpAddress", () => {
  it.each([
    ["198.51.100.12", "198.51.100.12"],
    ["2001:DB8::1", "2001:db8::1"],
    ["::ffff:192.0.2.128", "192.0.2.128"],
    ["::FFFF:C000:0280", "192.0.2.128"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeIpAddress(input)).toBe(expected);
  });

  it.each(["", " 198.51.100.12", "198.51.100.12, 10.0.0.1", "198.51.100.12:443", "[2001:db8::1]", "fe80::1%eth0"])(
    "rejects spoof-shaped or non-address value %s",
    (input) => {
      expect(normalizeIpAddress(input)).toBeNull();
    },
  );
});

describe("createClientIdentityResolver", () => {
  it("defaults to Fastify's resolved IP and does not consume country headers", () => {
    const resolve = createClientIdentityResolver();
    expect(resolve(request("::ffff:192.0.2.10", "127.0.0.1", {
      "cf-connecting-ip": "203.0.113.9",
      "cf-ipcountry": "IN",
    }))).toEqual({
      ip: "192.0.2.10",
      country: null,
      observed: {
        classification: "OBSERVED",
        clientIpSource: "fastify_request_ip",
        countrySource: "none",
        immediatePeerStatus: "not_configured",
        clientIpHeaderStatus: "not_configured",
        countryHeaderStatus: "not_configured",
      },
    });
  });

  it.each([
    ["127.0.0.1", "203.0.113.1"],
    ["10.20.44.7", "2001:db8:abcd::9"],
    ["2001:db8:1234:5::9", "203.0.113.2"],
  ])("accepts valid Cloudflare identity through trusted peer %s", (peer, clientIp) => {
    const resolve = createClientIdentityResolver(trustedConfiguration);
    expect(resolve(request("10.20.44.7", peer, {
      "cf-connecting-ip": clientIp,
      "cf-ipcountry": "in",
    }))).toEqual({
      ip: clientIp.toLowerCase(),
      country: "IN",
      observed: {
        classification: "OBSERVED",
        clientIpSource: "trusted_cloudflare_header",
        countrySource: "trusted_cloudflare_header",
        immediatePeerStatus: "trusted",
        clientIpHeaderStatus: "accepted",
        countryHeaderStatus: "accepted",
      },
    });
  });

  it("normalizes an IPv4-mapped Cloudflare client address", () => {
    const resolve = createClientIdentityResolver(trustedConfiguration);
    expect(resolve(request("127.0.0.1", "::ffff:127.0.0.1", {
      "cf-connecting-ip": "::ffff:203.0.113.4",
      "cf-ipcountry": "US",
    })).ip).toBe("203.0.113.4");
  });

  it("ignores even valid-looking Cloudflare headers from an untrusted immediate peer", () => {
    const resolve = createClientIdentityResolver(trustedConfiguration);
    const result = resolve(request("192.0.2.77", "192.0.2.77", {
      "cf-connecting-ip": "203.0.113.8",
      "cf-ipcountry": "US",
    }));
    expect(result).toMatchObject({
      ip: "192.0.2.77",
      country: null,
      observed: {
        clientIpSource: "fastify_request_ip",
        countrySource: "none",
        immediatePeerStatus: "untrusted",
        clientIpHeaderStatus: "not_checked",
        countryHeaderStatus: "not_checked",
      },
    });
  });

  it.each([
    [["203.0.113.5", "203.0.113.6"]],
    ["203.0.113.5, 203.0.113.6"],
    ["for=203.0.113.5"],
    ["203.0.113.5:443"],
    [" 203.0.113.5"],
  ])("falls back when the client IP header is duplicate or invalid: %j", (headerValue) => {
    const resolve = createClientIdentityResolver(trustedConfiguration);
    const result = resolve(request("127.0.0.1", "127.0.0.1", {
      "cf-connecting-ip": headerValue,
      "cf-ipcountry": "IN",
    }));
    expect(result).toMatchObject({
      ip: "127.0.0.1",
      country: null,
      observed: {
        immediatePeerStatus: "trusted",
        clientIpHeaderStatus: "invalid",
        countryHeaderStatus: "not_checked",
      },
    });
  });

  it("accepts the trusted client IP but no country for missing, duplicate, invalid, and unavailable country values", () => {
    const resolve = createClientIdentityResolver(trustedConfiguration);
    for (const [countryValue, status] of [
      [undefined, "missing"],
      [["IN", "US"], "invalid"],
      ["IN,US", "invalid"],
      ["ZZ", "invalid"],
      ["XX", "unavailable"],
      ["T1", "unavailable"],
    ] as const) {
      const result = resolve(request("127.0.0.1", "127.0.0.1", {
        "cf-connecting-ip": "203.0.113.12",
        ...(countryValue === undefined ? {} : { "cf-ipcountry": countryValue }),
      }));
      expect(result.ip).toBe("203.0.113.12");
      expect(result.country).toBeNull();
      expect(result.observed.countrySource).toBe("none");
      expect(result.observed.countryHeaderStatus).toBe(status);
    }
  });

  it("reports a missing or malformed immediate peer without inspecting headers", () => {
    const resolve = createClientIdentityResolver(trustedConfiguration);
    expect(resolve(request("192.0.2.4", undefined, { "cf-connecting-ip": "203.0.113.1" })).observed)
      .toMatchObject({ immediatePeerStatus: "unavailable", clientIpHeaderStatus: "not_checked" });
    expect(resolve(request("192.0.2.4", "not-an-ip", { "cf-connecting-ip": "203.0.113.1" })).observed)
      .toMatchObject({ immediatePeerStatus: "invalid", clientIpHeaderStatus: "not_checked" });
  });

  it.each([
    [{ ...trustedConfiguration, cloudflare: { ...trustedConfiguration.cloudflare, trustedProxyCidrs: ["10.0.0.1/99"] } }],
    [{ ...trustedConfiguration, cloudflare: { ...trustedConfiguration.cloudflare, clientIpHeader: "bad header" } }],
    [{ ...trustedConfiguration, cloudflare: { ...trustedConfiguration.cloudflare, countryHeader: "cf-connecting-ip" } }],
  ])("rejects unsafe configuration at startup", (configuration) => {
    expect(() => createClientIdentityResolver(configuration)).toThrow(TypeError);
  });

  it("rejects an invalid Fastify IP instead of returning an attacker-controlled identity", () => {
    const resolve = createClientIdentityResolver();
    expect(() => resolve(request("198.51.100.1, 10.0.0.1", "127.0.0.1"))).toThrow(TypeError);
  });
});

function request(
  fastifyIp: string,
  immediatePeer: string | undefined,
  headers: Record<string, string | readonly string[] | undefined> = {},
): ClientIdentityRequest {
  return {
    ip: fastifyIp,
    headers,
    raw: { socket: { remoteAddress: immediatePeer } },
  } as unknown as Pick<FastifyRequest, "headers" | "ip" | "raw">;
}
