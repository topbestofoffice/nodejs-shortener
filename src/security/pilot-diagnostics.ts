import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { RuntimeConfig } from "../config/runtime.js";
import { AppError } from "../core/errors.js";

const diagnosticHeader = "x-pilot-diagnostic-token";
const observedHeaders = [
  "host",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-proto",
  "cf-connecting-ip",
  "cf-ipcountry",
  "geoip-country-code",
  "x-geoip-country-code",
  "x-geoip-country",
  "x-forwarded-country",
] as const;

export function registerPilotDiagnostics(app: FastifyInstance, config: RuntimeConfig): void {
  if (!config.pilotDiagnostics.enabled) {
    return;
  }
  app.get("/__pilot/headers", async (request, reply) => {
    verifyToken(request.headers[diagnosticHeader], config.pilotDiagnostics.expectedTokenSha256);
    const headers = Object.fromEntries(observedHeaders.map((name) => [name, headerValue(request.headers[name])]));
    await reply
      .header("Cache-Control", "no-store, private, max-age=0")
      .header("X-Robots-Tag", "noindex, nofollow, noarchive")
      .send({
        ok: true,
        domain_id: request.domainContext.definition.id,
        canonical_host: request.domainContext.definition.canonicalHost,
        fastify_ip: request.ip,
        fastify_protocol: request.protocol,
        client_identity: request.clientIdentity,
        headers,
      });
  });
}

function verifyToken(rawValue: string | readonly string[] | undefined, expectedHash: string): void {
  const supplied = typeof rawValue === "string" ? rawValue : "";
  const actual = Buffer.from(createHash("sha256").update(supplied).digest("hex"), "ascii");
  const expected = Buffer.from(expectedHash, "ascii");
  if (supplied.length === 0 || supplied.length > 256
    || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError("Not found.", 404, "PILOT_DIAGNOSTIC_NOT_FOUND");
  }
}

function headerValue(value: string | readonly string[] | undefined): string | readonly string[] | null {
  if (typeof value === "string") {
    return value.slice(0, 1_024);
  }
  if (value !== undefined) {
    return value.slice(0, 8).map((item) => item.slice(0, 1_024));
  }
  return null;
}
