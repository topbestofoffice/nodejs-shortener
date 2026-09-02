import cookie from "@fastify/cookie";
import formbody from "@fastify/formbody";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest, onRequestHookHandler } from "fastify";
import type { RuntimeConfig } from "../../config/runtime.js";
import { AppError, TemporarilyUnavailableError } from "../../core/errors.js";
import type { SessionData, UserRecord } from "../../core/types.js";
import type { AuthService, AuthenticatedSession } from "./service.js";
import { requireDashboardSurface } from "../../security/request-trust.js";
import {
  createPreAuthCsrf,
  isPreAuthCsrfValid,
  preAuthCookieName,
  preAuthTtlSeconds,
} from "./preauth-csrf.js";

const sessionCookieName = "node_shortener_session";
const rememberCookieName = "fs_remember";

declare module "fastify" {
  interface FastifyRequest {
    auth: { session: SessionData; user: UserRecord } | null;
  }
}

export async function registerAuth(
  app: FastifyInstance,
  service: AuthService,
  config: RuntimeConfig,
): Promise<void> {
  await app.register(cookie);
  await app.register(formbody);
  app.decorateRequest("auth");
  app.addHook("onRequest", authenticationHook(service, config));
  app.addHook("onSend", async (request, reply, payload) => {
    const pathname = (request.raw.url ?? "/").split("?", 1)[0] ?? "/";
    if (pathname.startsWith("/auth/")) {
      reply.header("Cache-Control", "no-store, private, max-age=0");
      reply.header("Pragma", "no-cache");
    }
    return payload;
  });

  app.get("/auth/csrf", { preHandler: requireDashboardSurface }, async (request, reply) => {
    const issued = createPreAuthCsrf(
      request.domainPolicy.id,
      config.cookieSigningSecret,
      Math.floor(Date.now() / 1000),
    );
    reply.setCookie(preAuthCookieName, issued.cookie, {
      httpOnly: true,
      maxAge: preAuthTtlSeconds,
      path: "/",
      sameSite: "lax",
      secure: config.environment === "production" || request.protocol === "https",
    });
    return { ok: true, csrf: issued.csrf };
  });

  app.post<{ Body: { username?: string; password?: string; csrf?: string } }>(
    "/auth/login",
    { preHandler: requireDashboardSurface },
    async (request, reply) => {
      if (!isPreAuthCsrfValid({
        domainId: request.domainPolicy.id,
        secret: config.cookieSigningSecret,
        nowSeconds: Math.floor(Date.now() / 1000),
        cookie: request.cookies[preAuthCookieName],
        csrf: request.body?.csrf,
      })) {
        throw new AppError("Your session expired — please try again.", 403, "INVALID_PREAUTH_CSRF");
      }
      const username = typeof request.body?.username === "string" ? request.body.username : "";
      const password = typeof request.body?.password === "string" ? request.body.password : "";
      const authenticated = await service.login(username, password, request.clientIdentity.ip);
      reply.clearCookie(preAuthCookieName, { path: "/" });
      setAuthCookies(reply, request, authenticated, service, config);
      return {
        ok: true,
        user: { id: authenticated.user.id, username: authenticated.user.username, role: authenticated.user.role },
        csrf: authenticated.session.csrfToken,
      };
    },
  );

  app.post<{
    Body: { username?: string; password?: string; password2?: string; csrf?: string };
  }>(
    "/auth/register",
    { preHandler: requireDashboardSurface },
    async (request, reply) => {
      if (!isPreAuthCsrfValid({
        domainId: request.domainPolicy.id,
        secret: config.cookieSigningSecret,
        nowSeconds: Math.floor(Date.now() / 1000),
        cookie: request.cookies[preAuthCookieName],
        csrf: request.body?.csrf,
      })) {
        throw new AppError("Your session expired — please try again.", 403, "INVALID_PREAUTH_CSRF");
      }

      const result = await service.registerPublic({
        username: typeof request.body?.username === "string" ? request.body.username : "",
        password: typeof request.body?.password === "string" ? request.body.password : "",
        passwordConfirmation: typeof request.body?.password2 === "string" ? request.body.password2 : "",
      }, request.clientIdentity.ip);
      reply.clearCookie(preAuthCookieName, { path: "/" });

      if (result.status === "account_created") {
        clearAuthCookies(reply);
        return reply.code(201).send({
          ok: true,
          status: "account_created",
          login_required: true,
          user: {
            id: result.account.id,
            username: result.account.username,
            role: result.account.role,
          },
        });
      }

      setAuthCookies(reply, request, result.authenticated, service, config);
      return reply.code(201).send({
        ok: true,
        status: "authenticated",
        login_required: false,
        user: {
          id: result.authenticated.user.id,
          username: result.authenticated.user.username,
          role: result.authenticated.user.role,
        },
        csrf: result.authenticated.session.csrfToken,
      });
    },
  );

  app.get("/auth/session", { preHandler: requireDashboardSurface }, async (request, reply) => {
    if (request.auth === null) {
      await reply.code(401).send({ ok: false, error: "Not authenticated" });
      return;
    }
    return {
      ok: true,
      user: { id: request.auth.user.id, username: request.auth.user.username, role: request.auth.user.role },
      csrf: request.auth.session.csrfToken,
    };
  });

  app.post<{ Body: { csrf?: string } }>(
    "/auth/logout",
    { preHandler: requireDashboardSurface },
    async (request, reply) => {
      const auth = requireAuthenticated(request);
      assertCsrf(auth.session, request.body?.csrf);
      try {
        await service.logout(auth.session);
      } finally {
        clearAuthCookies(reply);
      }
      return { ok: true };
    },
  );
}

export function requireAuthenticated(request: FastifyRequest): { session: SessionData; user: UserRecord } {
  if (request.auth === null) {
    throw new AppError("Not authenticated", 401, "NOT_AUTHENTICATED");
  }
  return request.auth;
}

export function assertCsrf(session: SessionData, supplied: unknown): void {
  if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)) {
    throw new AppError("Invalid CSRF token", 403, "INVALID_CSRF");
  }
  const actual = Buffer.from(supplied, "ascii");
  const expected = Buffer.from(session.csrfToken, "ascii");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new AppError("Invalid CSRF token", 403, "INVALID_CSRF");
  }
}

function authenticationHook(service: AuthService, config: RuntimeConfig): onRequestHookHandler {
  return async (request, reply): Promise<void> => {
    request.auth = null;
    if (request.domainPolicy.surface !== "dashboard") {
      return;
    }
    if (doesNotNeedAuthentication(request)) {
      return;
    }
    try {
      const signed = request.cookies[sessionCookieName];
      const sessionId = signed === undefined ? null : service.verifySignedSessionId(signed, config.cookieSigningSecret);
      let authenticated = sessionId === null ? null : await service.getSession(sessionId);

      if (authenticated === null) {
        const remember = request.cookies[rememberCookieName];
        if (remember !== undefined) {
          authenticated = await service.restoreRemember(remember);
          if (authenticated !== null) {
            setAuthCookies(reply, request, authenticated, service, config);
          } else {
            clearAuthCookies(reply);
          }
        }
      }
      request.auth = authenticated === null ? null : { session: authenticated.session, user: authenticated.user };
    } catch {
      throw new TemporarilyUnavailableError();
    }
  };
}

function doesNotNeedAuthentication(request: FastifyRequest): boolean {
  const path = (request.raw.url ?? "/").split("?", 1)[0] ?? "/";
  if (request.method === "GET" || request.method === "HEAD") {
    return /^[/]?[A-Za-z0-9]{1,32}\/?$/.test(path)
      || path.startsWith("/assets/")
      || path.startsWith("/uploads/")
      || path.startsWith("/health/")
      || path === "/__pilot/headers";
  }
  return false;
}

export function setAuthCookies(
  reply: FastifyReply,
  request: FastifyRequest,
  authenticated: AuthenticatedSession,
  service: AuthService,
  config: RuntimeConfig,
): void {
  const secure = config.environment === "production" || request.protocol === "https";
  reply.setCookie(sessionCookieName, service.signSessionId(authenticated.session.id, config.cookieSigningSecret), {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure,
  });
  if (authenticated.rememberCookie !== null) {
    reply.setCookie(rememberCookieName, authenticated.rememberCookie, {
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60,
      path: "/",
      sameSite: "lax",
      secure,
    });
  }
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(sessionCookieName, { path: "/" });
  reply.clearCookie(rememberCookieName, { path: "/" });
}
