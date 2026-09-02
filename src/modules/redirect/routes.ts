import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RedirectService } from "./service.js";
import type { DecisionCookieIntent } from "./current-decision.js";

interface RouteParameters {
  code: string;
}

export async function registerRedirectRoutes(app: FastifyInstance, service: RedirectService): Promise<void> {
  const handler = async (
    request: FastifyRequest<{ Params: RouteParameters }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const result = await service.handle({
        context: request.domainContext,
        code: request.params.code,
        ip: request.clientIdentity.ip,
        country: request.clientIdentity.country,
        method: request.method,
        userAgent: headerString(request.headers["user-agent"]),
        query: flattenQuery(request),
        headers: flattenHeaders(request),
      });

      reply.header("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
      reply.header("Pragma", "no-cache");
      reply.header("Expires", "Thu, 19 Nov 1981 08:52:00 GMT");

      if (result.kind === "not_found") {
        await reply.code(404).type("text/html; charset=utf-8").send(
          '<!doctype html><meta charset="utf-8"><title>404</title><h1>404</h1><p>This short link does not exist.</p>',
        );
        return;
      }
      if (result.kind === "preview") {
        await reply.code(200).type("text/html; charset=utf-8").send(request.method === "HEAD" ? "" : result.html);
        return;
      }
      if (result.kind === "blocked") {
        reply.header("X-Robots-Tag", "noindex, nofollow, noarchive");
        const message = result.reason === "aws_dc"
          ? "Access from this hosting, VPN, or proxy network is not allowed.\nTurn it off and open the link again.\n"
          : "Access denied.\n";
        await reply.code(403).type("text/plain; charset=utf-8").send(request.method === "HEAD" ? "" : message);
        return;
      }
      if (result.decisionCookie !== null) {
        try {
          reply.header("Set-Cookie", serializeDecisionCookie(result.decisionCookie));
        } catch {
          // Cookie transport is best-effort and cannot change the selected redirect target.
        }
      }
    await reply.redirect(result.location, result.statusCode);
  };

  // The PHP rewrite accepts both `/code` and `/code/`. Register both narrowly
  // instead of enabling global trailing-slash tolerance for auth/API routes.
  for (const url of ["/:code", "/:code/"] as const) {
    app.route<{ Params: RouteParameters }>({ method: ["GET", "HEAD"], url, handler });
  }
}

function serializeDecisionCookie(cookie: DecisionCookieIntent): string {
  return `${cookie.name}=${cookie.value}; Expires=${cookie.expires.toUTCString()}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

function flattenQuery(request: FastifyRequest): Readonly<Record<string, string | undefined>> {
  const raw = request.query as Record<string, unknown>;
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, typeof value === "string" ? value : undefined]));
}

function flattenHeaders(request: FastifyRequest): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, headerString(value)]));
}

function headerString(value: string | readonly string[] | undefined): string {
  return typeof value === "string" ? value : "";
}
