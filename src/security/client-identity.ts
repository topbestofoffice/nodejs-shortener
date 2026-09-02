import { BlockList, isIP } from "node:net";
import type { FastifyRequest } from "fastify";

const countryCodes = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" "),
);

const maximumTrustedProxyRanges = 128;
const maximumIpHeaderLength = 64;

export interface ClientIdentityConfig {
  readonly cloudflare?: {
    readonly clientIpHeader: string;
    readonly countryHeader: string;
    /** Entries may be individual IPv4/IPv6 addresses or CIDR ranges. */
    readonly trustedProxyCidrs: readonly string[];
  };
}

export type ClientIdentityRequest = Pick<FastifyRequest, "headers" | "ip" | "raw">;

export type ImmediatePeerStatus = "not_configured" | "unavailable" | "invalid" | "untrusted" | "trusted";
export type ObservedHeaderStatus = "not_configured" | "not_checked" | "missing" | "invalid" | "unavailable" | "accepted";

export interface ClientIdentityObservation {
  /** This describes request evidence only; it is not a claim about a person. */
  readonly classification: "OBSERVED";
  readonly clientIpSource: "fastify_request_ip" | "trusted_cloudflare_header";
  readonly countrySource: "none" | "trusted_cloudflare_header";
  readonly immediatePeerStatus: ImmediatePeerStatus;
  readonly clientIpHeaderStatus: ObservedHeaderStatus;
  readonly countryHeaderStatus: ObservedHeaderStatus;
}

export interface ClientIdentity {
  readonly ip: string;
  readonly country: string | null;
  /** Safe source/status fields for pilot logs; raw header values and proxy ranges are omitted. */
  readonly observed: ClientIdentityObservation;
}

declare module "fastify" {
  interface FastifyRequest {
    clientIdentity: ClientIdentity;
  }
}

export type ClientIdentityResolver = (request: ClientIdentityRequest) => ClientIdentity;

interface CompiledCloudflareConfig {
  readonly clientIpHeader: string;
  readonly countryHeader: string;
  readonly trustedPeers: BlockList;
}

/**
 * Compile proxy trust once at startup, then resolve identities without parsing
 * CIDRs on every request. Cloudflare headers are never used without a trusted
 * immediate peer.
 */
export function createClientIdentityResolver(config: ClientIdentityConfig = {}): ClientIdentityResolver {
  const cloudflare = compileCloudflareConfig(config.cloudflare);

  return (request): ClientIdentity => {
    const fastifyIp = normalizeIpAddress(request.ip);
    if (fastifyIp === null) {
      throw new TypeError("Fastify request.ip must be a valid IP address.");
    }

    if (cloudflare === null) {
      return identity(fastifyIp, null, {
        clientIpSource: "fastify_request_ip",
        countrySource: "none",
        immediatePeerStatus: "not_configured",
        clientIpHeaderStatus: "not_configured",
        countryHeaderStatus: "not_configured",
      });
    }

    const peerValue = request.raw.socket.remoteAddress;
    if (peerValue === undefined || peerValue.length === 0) {
      return fallbackIdentity(fastifyIp, "unavailable");
    }
    const peerIp = normalizeIpAddress(peerValue);
    if (peerIp === null) {
      return fallbackIdentity(fastifyIp, "invalid");
    }
    const peerFamily = isIP(peerIp) === 4 ? "ipv4" : "ipv6";
    if (!cloudflare.trustedPeers.check(peerIp, peerFamily)) {
      return fallbackIdentity(fastifyIp, "untrusted");
    }

    const clientIpHeader = readSingleHeader(request.headers[cloudflare.clientIpHeader]);
    if (clientIpHeader.status !== "accepted") {
      return identity(fastifyIp, null, {
        clientIpSource: "fastify_request_ip",
        countrySource: "none",
        immediatePeerStatus: "trusted",
        clientIpHeaderStatus: clientIpHeader.status,
        countryHeaderStatus: "not_checked",
      });
    }
    const clientIp = normalizeIpAddress(clientIpHeader.value);
    if (clientIp === null) {
      return identity(fastifyIp, null, {
        clientIpSource: "fastify_request_ip",
        countrySource: "none",
        immediatePeerStatus: "trusted",
        clientIpHeaderStatus: "invalid",
        countryHeaderStatus: "not_checked",
      });
    }

    const countryHeader = readCountryHeader(request.headers[cloudflare.countryHeader]);
    return identity(clientIp, countryHeader.country, {
      clientIpSource: "trusted_cloudflare_header",
      countrySource: countryHeader.status === "accepted" ? "trusted_cloudflare_header" : "none",
      immediatePeerStatus: "trusted",
      clientIpHeaderStatus: "accepted",
      countryHeaderStatus: countryHeader.status,
    });

    function fallbackIdentity(ip: string, peerStatus: ImmediatePeerStatus): ClientIdentity {
      return identity(ip, null, {
        clientIpSource: "fastify_request_ip",
        countrySource: "none",
        immediatePeerStatus: peerStatus,
        clientIpHeaderStatus: "not_checked",
        countryHeaderStatus: "not_checked",
      });
    }
  };
}

/** Normalize ordinary IPs and collapse IPv4-mapped IPv6 to dotted IPv4. */
export function normalizeIpAddress(rawValue: string): string | null {
  if (rawValue.length === 0 || rawValue.length > maximumIpHeaderLength
    || rawValue !== rawValue.trim() || rawValue.includes(",") || rawValue.includes("%")) {
    return null;
  }
  const family = isIP(rawValue);
  if (family === 0) {
    return null;
  }
  if (family === 4) {
    return rawValue;
  }

  const words = expandIpv6(rawValue);
  if (words !== null
    && words.slice(0, 5).every((word) => word === 0)
    && words[5] === 0xffff) {
    const high = words[6];
    const low = words[7];
    if (high !== undefined && low !== undefined) {
      return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
    }
  }
  return rawValue.toLowerCase();
}

/** Normalize a country code only when it belongs to the explicit supported set. */
export function normalizeCountryCode(rawValue: string | null): string | null {
  const country = rawValue?.trim().toUpperCase() ?? "";
  return countryCodes.has(country) ? country : null;
}

function compileCloudflareConfig(
  config: ClientIdentityConfig["cloudflare"],
): CompiledCloudflareConfig | null {
  if (config === undefined) {
    return null;
  }
  if (config.trustedProxyCidrs.length > maximumTrustedProxyRanges) {
    throw new TypeError(`At most ${maximumTrustedProxyRanges} trusted proxy ranges may be configured.`);
  }

  const clientIpHeader = normalizeHeaderName(config.clientIpHeader);
  const countryHeader = normalizeHeaderName(config.countryHeader);
  if (clientIpHeader === countryHeader) {
    throw new TypeError("Client IP and country header names must be different.");
  }

  const trustedPeers = new BlockList();
  for (const configuredRange of config.trustedProxyCidrs) {
    addTrustedRange(trustedPeers, configuredRange);
  }
  return Object.freeze({ clientIpHeader, countryHeader, trustedPeers });
}

function normalizeHeaderName(value: string): string {
  const normalized = value.toLowerCase();
  if (value !== value.trim() || !/^[a-z0-9-]{1,64}$/.test(normalized)) {
    throw new TypeError("Configured client identity headers must be valid HTTP header names.");
  }
  return normalized;
}

function addTrustedRange(blockList: BlockList, configuredRange: string): void {
  if (configuredRange.length === 0 || configuredRange !== configuredRange.trim()) {
    throw new TypeError(`Invalid trusted proxy range: ${configuredRange}`);
  }
  const slash = configuredRange.indexOf("/");
  if (slash === -1) {
    const address = normalizeIpAddress(configuredRange);
    if (address === null) {
      throw new TypeError(`Invalid trusted proxy range: ${configuredRange}`);
    }
    blockList.addAddress(address, isIP(address) === 4 ? "ipv4" : "ipv6");
    return;
  }
  if (slash === 0 || slash !== configuredRange.lastIndexOf("/")) {
    throw new TypeError(`Invalid trusted proxy range: ${configuredRange}`);
  }

  const rawAddress = configuredRange.slice(0, slash);
  const rawPrefix = configuredRange.slice(slash + 1);
  if (!/^\d{1,3}$/.test(rawPrefix)) {
    throw new TypeError(`Invalid trusted proxy range: ${configuredRange}`);
  }
  const originalFamily = isIP(rawAddress);
  const address = normalizeIpAddress(rawAddress);
  if (originalFamily === 0 || address === null) {
    throw new TypeError(`Invalid trusted proxy range: ${configuredRange}`);
  }

  let prefix = Number(rawPrefix);
  if (originalFamily === 6 && isIP(address) === 4) {
    if (prefix < 96 || prefix > 128) {
      throw new TypeError(`Invalid IPv4-mapped trusted proxy range: ${configuredRange}`);
    }
    prefix -= 96;
  }
  const maximumPrefix = isIP(address) === 4 ? 32 : 128;
  if (prefix > maximumPrefix) {
    throw new TypeError(`Invalid trusted proxy range: ${configuredRange}`);
  }
  blockList.addSubnet(address, prefix, maximumPrefix === 32 ? "ipv4" : "ipv6");
}

function readSingleHeader(value: string | readonly string[] | undefined):
  | { readonly status: "missing" | "invalid" }
  | { readonly status: "accepted"; readonly value: string } {
  if (value === undefined) {
    return { status: "missing" };
  }
  if (typeof value !== "string" || value.length === 0 || value.length > maximumIpHeaderLength
    || value !== value.trim() || value.includes(",") || containsControlCharacter(value)) {
    return { status: "invalid" };
  }
  return { status: "accepted", value };
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function readCountryHeader(value: string | readonly string[] | undefined): {
  readonly status: "missing" | "invalid" | "unavailable" | "accepted";
  readonly country: string | null;
} {
  if (value === undefined) {
    return { status: "missing", country: null };
  }
  if (typeof value !== "string" || value !== value.trim() || value.includes(",")) {
    return { status: "invalid", country: null };
  }
  const country = value.toUpperCase();
  if (country === "XX" || country === "T1") {
    return { status: "unavailable", country: null };
  }
  const normalized = normalizeCountryCode(country);
  if (normalized === null) {
    return { status: "invalid", country: null };
  }
  return { status: "accepted", country: normalized };
}

function identity(
  ip: string,
  country: string | null,
  observed: Omit<ClientIdentityObservation, "classification">,
): ClientIdentity {
  return Object.freeze({
    ip,
    country,
    observed: Object.freeze({ classification: "OBSERVED", ...observed }),
  });
}

function expandIpv6(value: string): readonly number[] | null {
  let hexadecimal = value;
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const ipv4 = value.slice(lastColon + 1).split(".").map(Number);
    if (lastColon === -1 || ipv4.length !== 4
      || ipv4.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return null;
    }
    const first = ipv4[0];
    const second = ipv4[1];
    const third = ipv4[2];
    const fourth = ipv4[3];
    if (first === undefined || second === undefined || third === undefined || fourth === undefined) {
      return null;
    }
    hexadecimal = `${value.slice(0, lastColon)}:${((first << 8) | second).toString(16)}:${((third << 8) | fourth).toString(16)}`;
  }

  const halves = hexadecimal.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0]?.length === 0 ? [] : halves[0]?.split(":") ?? [];
  const right = halves.length === 1 || halves[1]?.length === 0 ? [] : halves[1]?.split(":") ?? [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  return [...left, ...Array.from({ length: missing }, () => "0"), ...right].map((word) => Number.parseInt(word, 16));
}
