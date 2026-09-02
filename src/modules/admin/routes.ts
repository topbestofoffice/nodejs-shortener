import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeConfig } from "../../config/runtime.js";
import { AppError } from "../../core/errors.js";
import {
  assertCsrf,
  clearAuthCookies,
  requireAuthenticated,
  setAuthCookies,
} from "../auth/http.js";
import {
  GlobalSessionResetError,
  type AuthService,
} from "../auth/service.js";
import { requireDashboardSurface } from "../../security/request-trust.js";
import { parseAdminReportRange } from "../reporting/admin-report-service.js";
import type { AdminReportRange } from "../reporting/report-window.js";
import { parseAdminAction, reconstructGeoQualityForm } from "./form-policy.js";
import type { AdminService } from "./service.js";
import { renderAdminPage } from "./view.js";

export function registerAdminRoutes(
  app: FastifyInstance,
  service: AdminService,
  authService: AuthService,
  config: RuntimeConfig,
): void {
  app.get(
    "/admin.php",
    { preHandler: requireDashboardSurface },
    async (request, reply) => withAdminFailureBoundary(request, async () => {
      const auth = requireExactAdmin(request);
      const query = recordOrEmpty(request.query);
      const reportRange = parseOptionalReportRange(query.history_range);
      const snapshot = await service.load(query.domain_id, reportRange);
      setAdminDocumentHeaders(reply);
      await reply.type("text/html; charset=utf-8").send(renderAdminPage({
        brand: request.domainContext.definition.label,
        username: auth.user.username,
        csrf: auth.session.csrfToken,
        snapshot,
        noticeCode: scalar(query.notice),
      }));
    }),
  );

  app.post(
    "/admin.php",
    { preHandler: requireDashboardSurface },
    async (request, reply) => withAdminFailureBoundary(request, async () => {
      const auth = requireExactAdmin(request);
      const body = requireRecord(request.body);
      assertCsrf(auth.session, body.csrf);
      const action = parseAdminAction(body.action);
      if (action === null) {
        throw new AppError("Choose a valid Admin action.", 400, "INVALID_ADMIN_ACTION");
      }

      let domainId: number;
      let notice: string;
      switch (action) {
        case "save_settings":
          domainId = await service.saveSkim(body.domain_id, body);
          notice = "settings_saved";
          break;
        case "save_geo": {
          // fast-querystring uses a hardened dictionary prototype. Copy only
          // enumerable own entries into a plain record before the strict
          // bracket-field parser; keys and scalar values are still validated.
          const reconstructed = reconstructGeoQualityForm(Object.fromEntries(Object.entries(body)));
          if (reconstructed === null) {
            throw new AppError(
              "Country rows are malformed — reload and try again. Nothing changed.",
              422,
              "MALFORMED_GEO_FORM",
            );
          }
          domainId = await service.saveGeo(body.domain_id, reconstructed);
          notice = "geo_saved";
          break;
        }
        case "add_user": {
          const username = requireScalar(body.new_username, "Username is malformed.");
          const password = requireScalar(body.new_password, "Password is malformed.");
          const password2 = requireScalar(body.new_password2, "Password confirmation is malformed.");
          const created = await service.addUser(body.domain_id, { username, password, password2 });
          domainId = created.domainId;
          notice = "user_added";
          break;
        }
        case "delete_user":
          domainId = await service.deleteUser(body.domain_id, parseUserId(body.user_id));
          notice = "user_deleted";
          break;
        case "save_registration": {
          const enabled = parseRegistrationEnabled(body.registration_enabled);
          domainId = await service.saveRegistration(body.domain_id, enabled);
          notice = enabled ? "registration_on" : "registration_off";
          break;
        }
        case "reset_sessions": {
          domainId = await service.requireManageableDomain(body.domain_id);
          try {
            const refreshed = await authService.resetAllSessions(auth.session, auth.user);
            setAuthCookies(reply, request, refreshed, authService, config);
          } catch (error) {
            if (error instanceof GlobalSessionResetError) {
              clearAuthCookies(reply);
            }
            throw error;
          }
          notice = "sessions_reset";
          break;
        }
        case "load_diversion_history": {
          const reportRange = requireReportRange(body.history_range, 422);
          domainId = await service.requireManageableDomain(body.domain_id);
          await reply.redirect(
            `/admin.php?domain_id=${domainId}&history_range=${reportRange}`,
            303,
          );
          return;
        }
      }

      await reply.redirect(`/admin.php?domain_id=${domainId}&notice=${notice}`, 303);
    }),
  );
}

function requireExactAdmin(request: FastifyRequest) {
  const auth = requireAuthenticated(request);
  if (auth.user.role !== "admin") {
    throw new AppError("Administrator access is required.", 403, "ADMIN_REQUIRED");
  }
  return auth;
}

async function withAdminFailureBoundary(
  request: FastifyRequest,
  operation: () => Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    request.log.error({ err: error }, "Admin operation failed");
    throw new AppError(
      "Admin operation is temporarily unavailable. Nothing should be retried automatically.",
      503,
      "ADMIN_UNAVAILABLE",
    );
  }
}

function setAdminDocumentHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "no-store, private, max-age=0");
  reply.header("Pragma", "no-cache");
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  reply.header("Referrer-Policy", "same-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppError("Admin form is malformed.", 400, "MALFORMED_ADMIN_FORM");
  }
  return value as Record<string, unknown>;
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function scalar(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function requireScalar(value: unknown, message: string): string {
  if (typeof value !== "string") throw new AppError(message, 422, "MALFORMED_ADMIN_FIELD");
  return value;
}

function parseUserId(value: unknown): number {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new AppError("Choose a valid user.", 422, "INVALID_USER_ID");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError("Choose a valid user.", 422, "INVALID_USER_ID");
  }
  return parsed;
}

function parseRegistrationEnabled(value: unknown): boolean {
  if (value === undefined || value === null || value === "0") return false;
  if (value === "1") return true;
  throw new AppError("Public sign-up setting is malformed.", 422, "INVALID_REGISTRATION_SETTING");
}

function parseOptionalReportRange(value: unknown): AdminReportRange | null {
  if (value === undefined) return null;
  return requireReportRange(value, 400);
}

function requireReportRange(value: unknown, statusCode: 400 | 422): AdminReportRange {
  const range = parseAdminReportRange(value);
  if (range === null) {
    throw new AppError(
      "Choose a valid Admin history range.",
      statusCode,
      "INVALID_ADMIN_REPORT_RANGE",
    );
  }
  return range;
}
