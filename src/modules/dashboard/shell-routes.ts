import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isBrowserScopedDefaultUser, type RuntimeConfig } from "../../config/runtime.js";
import type { ApplicationStores } from "../../ports.js";
import { AppError } from "../../core/errors.js";
import { requireDashboardSurface } from "../../security/request-trust.js";
import type { DashboardHistoryService } from "./history-service.js";
import {
  renderAuthenticatedShell,
  renderPublicShell,
  type DashboardShellDomain,
} from "./shell-view.js";

interface DashboardShellOptions {
  readonly config: RuntimeConfig;
  readonly stores: ApplicationStores;
  readonly history: DashboardHistoryService | undefined;
}

export function registerDashboardShell(app: FastifyInstance, options: DashboardShellOptions): void {
  const handler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    setDocumentHeaders(reply, request.auth !== null && options.config.analytics.enabled);
    const brand = request.domainContext.definition.label;
    if (request.auth === null) {
      let registrationState: "open" | "closed" | "unavailable";
      try {
        registrationState = await options.stores.auth.isRegistrationEnabled() ? "open" : "closed";
      } catch {
        registrationState = "unavailable";
      }
      await reply.type("text/html; charset=utf-8").send(renderPublicShell({ brand, registrationState }));
      return;
    }

    const selectable = await options.stores.domains.listSelectableDomains();
    const domains: DashboardShellDomain[] = selectable.flatMap((policy) => {
      const definition = options.config.registry.byId(policy.id);
      if (definition === undefined || !policy.active || !policy.allowCreate
        || !definition.active || !definition.allowCreate) {
        return [];
      }
      return [{ id: policy.id, label: policy.label, hostname: definition.canonicalHost }];
    });
    const preferenceScope = isBrowserScopedDefaultUser(request.auth.user, options.config.browserScopedDefaultUsers)
      ? "browser" as const
      : "account" as const;
    if (options.history === undefined) {
      throw new AppError("Dashboard history is temporarily unavailable.", 503, "DASHBOARD_HISTORY_UNAVAILABLE");
    }
    const history = await options.history.load(request.auth.user.id, request.query);
    await reply.type("text/html; charset=utf-8").send(renderAuthenticatedShell({
      brand,
      username: request.auth.user.username,
      userRole: request.auth.user.role,
      userId: request.auth.user.id,
      csrf: request.auth.session.csrfToken,
      domains,
      // Shared-author accounts intentionally keep this preference in the
      // browser profile. Ignore a stale account-level value on first use.
      defaultDomainId: preferenceScope === "browser" ? null : request.auth.user.defaultDomainId,
      preferenceScope,
      maxBulkLinks: options.config.links.maxBulkLinks,
      maxBulkImages: options.config.links.maxBulkImages,
      history,
      registry: options.config.registry,
      analytics: options.config.analytics,
    }));
  };

  app.get("/", { preHandler: requireDashboardSurface }, handler);
  app.get("/index.php", { preHandler: requireDashboardSurface }, handler);
}

function setDocumentHeaders(reply: FastifyReply, analyticsEnabled: boolean): void {
  reply.header("Cache-Control", "no-store, private, max-age=0");
  reply.header("Pragma", "no-cache");
  const analyticsConnect = analyticsEnabled
    ? " https://www.google-analytics.com https://region1.google-analytics.com"
    : "";
  const analyticsScript = analyticsEnabled ? " https://www.googletagmanager.com" : "";
  reply.header("Content-Security-Policy", `default-src 'self'; base-uri 'none'; connect-src 'self'${analyticsConnect}; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob: http: https:; object-src 'none'; script-src 'self'${analyticsScript}; style-src 'self'`);
  reply.header("Referrer-Policy", "same-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  reply.header("Cross-Origin-Opener-Policy", "same-origin");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
}
