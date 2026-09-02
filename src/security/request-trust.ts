import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest, onRequestHookHandler } from "fastify";
import { AppError, MisdirectedRequestError, TemporarilyUnavailableError } from "../core/errors.js";
import type { DomainContext, DomainPolicy } from "../core/types.js";
import type { RuntimeConfig } from "../config/runtime.js";
import type { DomainStore } from "../ports.js";
import { isManagedImageRequestPath } from "../modules/uploads/managed-image-path.js";

declare module "fastify" {
  interface FastifyRequest {
    domainContext: DomainContext;
    domainPolicy: DomainPolicy;
  }
}

export function requestTrustHook(config: RuntimeConfig, domains: DomainStore): onRequestHookHandler {
  return async (request, reply): Promise<void> => {
    verifyOriginAuthentication(request, config);
    const context = config.registry.resolve(headerString(request.headers.host));

    if (!context.definition.active) {
      throw new TemporarilyUnavailableError();
    }

    if (!context.isCanonical) {
      const rawTarget = request.raw.url ?? "/";
      const target = canonicalAliasTarget(rawTarget, context.definition.publicBaseUrl);
      await reply.redirect(target, 301);
      return;
    }

    const pathname = (request.raw.url ?? "/").split("?", 1)[0] ?? "/";
    const pathDecision = preDomainPathDecision(
      context.definition.surface,
      request.method,
      pathname,
      config.pilotDiagnostics.enabled,
    );
    if (pathDecision !== "dynamic") {
      request.domainContext = context;
      request.domainPolicy = configuredDomainPolicy(context);
      if (pathDecision === "redirect_not_found") {
        await reply
          .code(404)
          .header("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0")
          .header("Pragma", "no-cache")
          .header("Expires", "Thu, 19 Nov 1981 08:52:00 GMT")
          .type("text/html; charset=utf-8")
          .send('<!doctype html><meta charset="utf-8"><title>404</title><h1>404</h1><p>This short link does not exist.</p>');
        return;
      }
      if (pathDecision === "reject") {
        throw new AppError("Not found.", 404, "PATH_NOT_FOUND");
      }
      return;
    }

    let policy: DomainPolicy | null;
    try {
      policy = await domains.getDomain(context.definition.id);
    } catch {
      throw new TemporarilyUnavailableError();
    }
    if (policy === null || !policy.active) {
      throw new TemporarilyUnavailableError();
    }
    if (policy.id !== context.definition.id
      || policy.domainKey !== context.definition.key
      || policy.hostname !== context.definition.canonicalHost
      || policy.label !== context.definition.label
      || policy.surface !== context.definition.surface
      || policy.active !== context.definition.active
      || policy.allowCreate !== context.definition.allowCreate
      || policy.diversionCampaign !== context.definition.diversionCampaign
      || policy.reportTimezone !== context.definition.reportTimezone) {
      throw new MisdirectedRequestError();
    }

    request.domainContext = context;
    request.domainPolicy = policy;
  };
}

/**
 * Reject paths that can never reach the application before asking MariaDB for
 * mutable domain policy. Existing public files are served by the web stack in
 * production; the strict patterns below provide the same DB-free behavior in
 * the local Node server without allowing encoded/traversal lookalikes through.
 */
export function preDomainPathDecision(
  surface: DomainContext["definition"]["surface"],
  method: string,
  pathname: string,
  pilotDiagnosticsEnabled: boolean,
): "config_only" | "dynamic" | "redirect_not_found" | "reject" {
  if (pathname === "/health/live") return surface === "dashboard" ? "config_only" : "reject";
  if (pathname === "/health/ready") return surface === "dashboard" ? "config_only" : "reject";
  if (pathname === "/__pilot/headers") {
    return surface === "dashboard" && pilotDiagnosticsEnabled ? "dynamic" : "reject";
  }
  if ((method === "GET" || method === "HEAD") && isStrictPublicFile(pathname)) return "config_only";

  if (surface === "redirect" && (pathname === "/" || pathname === "/index.php")) {
    return "config_only";
  }

  if (pathname === "/"
    || pathname === "/index.php"
    || pathname === "/api.php"
    || pathname === "/upload.php"
    || pathname === "/admin.php"
    || pathname === "/auth/csrf"
    || pathname === "/auth/login"
    || pathname === "/auth/register"
    || pathname === "/auth/session"
    || pathname === "/auth/logout"
    || /^\/[A-Za-z0-9]{1,32}\/?$/.test(pathname)) {
    return "dynamic";
  }

  // Preserve the redirect route's fixed invalid-code 404 without consulting
  // link or domain storage. Multi-segment probes retain the generic 404.
  if (surface === "redirect" && (method === "GET" || method === "HEAD") && /^\/[^/]+\/?$/.test(pathname)) {
    return "redirect_not_found";
  }
  return "reject";
}

function isStrictPublicFile(pathname: string): boolean {
  if (isManagedImageRequestPath(pathname)) return true;
  return pathname.startsWith("/assets/")
    && pathname.length <= 256
    && /^\/assets\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pathname)
    && !pathname.split("/").some((segment) => segment === "." || segment === "..");
}

function configuredDomainPolicy(context: DomainContext): DomainPolicy {
  return {
    id: context.definition.id,
    domainKey: context.definition.key,
    hostname: context.definition.canonicalHost,
    label: context.definition.label,
    surface: context.definition.surface,
    active: context.definition.active,
    allowCreate: context.definition.allowCreate,
    diversionCampaign: context.definition.diversionCampaign,
    reportTimezone: context.definition.reportTimezone,
  };
}

export function canonicalAliasTarget(rawTarget: string, canonicalOrigin: string): string {
  // WHATWG URL parsing treats backslashes as authority separators for special
  // schemes. Reject raw and encoded backslashes, then build an origin-form
  // target under the already validated canonical origin without reparsing it.
  if (rawTarget.includes("\\") || hasAsciiControl(rawTarget) || /%5c/i.test(rawTarget)) {
    throw new AppError("Invalid request target.", 400, "INVALID_REQUEST_TARGET");
  }
  const originForm = `/${rawTarget.replace(/^\/+/, "")}`;
  return `${canonicalOrigin}${originForm}`;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

export function requireDashboardSurface(request: FastifyRequest, _reply: FastifyReply, done: (error?: Error) => void): void {
  if (request.domainContext.definition.surface !== "dashboard") {
    done(new AppError("Not found.", 404, "SURFACE_NOT_FOUND"));
    return;
  }
  done();
}

function verifyOriginAuthentication(request: FastifyRequest, config: RuntimeConfig): void {
  if (!config.originAuth.enabled) {
    return;
  }
  const supplied = headerString(request.headers[config.originAuth.header]);
  if (supplied.length === 0 || supplied.length > 256) {
    throw new AppError("Forbidden.", 403, "ORIGIN_AUTH_FAILED");
  }
  const actual = Buffer.from(createHash("sha256").update(supplied).digest("hex"), "ascii");
  const expected = Buffer.from(config.originAuth.expectedSha256, "ascii");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError("Forbidden.", 403, "ORIGIN_AUTH_FAILED");
  }
}

function headerString(value: string | readonly string[] | undefined): string {
  return typeof value === "string" ? value : "";
}
