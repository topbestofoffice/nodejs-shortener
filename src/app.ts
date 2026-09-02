import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { RuntimeConfig } from "./config/runtime.js";
import { AppError } from "./core/errors.js";
import type { ApplicationStores, Clock } from "./ports.js";
import { systemClock } from "./ports.js";
import { PassThroughDecisionEngine, type RedirectDecisionEngine } from "./modules/redirect/classification.js";
import { noImageMetadataReader, type ImageMetadataReader } from "./modules/redirect/preview.js";
import { RedirectService } from "./modules/redirect/service.js";
import { registerRedirectRoutes } from "./modules/redirect/routes.js";
import { requestTrustHook } from "./security/request-trust.js";
import type { AuthService } from "./modules/auth/service.js";
import { registerAuth } from "./modules/auth/http.js";
import type { ImageUploadService } from "./modules/uploads/service.js";
import { registerImageUploadRoutes } from "./modules/uploads/http.js";
import type { LinkService } from "./modules/links/service.js";
import { registerLinkApiRoutes } from "./modules/links/http.js";
import { registerPilotDiagnostics } from "./security/pilot-diagnostics.js";
import { createClientIdentityResolver } from "./security/client-identity.js";
import { registerDashboardShell } from "./modules/dashboard/shell-routes.js";
import { DashboardHistoryService } from "./modules/dashboard/history-service.js";
import {
  createDeterministicReadinessProbe,
  type RuntimeReadinessProbe,
} from "./infrastructure/runtime-readiness.js";
import { AdminService } from "./modules/admin/service.js";
import { registerAdminRoutes } from "./modules/admin/routes.js";
import { AdminReportService } from "./modules/reporting/admin-report-service.js";

export interface BuildApplicationOptions {
  readonly config: RuntimeConfig;
  readonly stores: ApplicationStores;
  readonly clock?: Clock;
  readonly decisions?: RedirectDecisionEngine;
  readonly metadataReader?: ImageMetadataReader;
  readonly logger?: boolean | { readonly level: string };
  readonly authService?: AuthService;
  readonly imageUploadService?: ImageUploadService;
  readonly linkService?: LinkService;
  readonly readiness?: RuntimeReadinessProbe;
}

export async function buildApplication(options: BuildApplicationOptions): Promise<FastifyInstance> {
  const app = Fastify({
    // The multipart envelope also contains bounded link/form fields. Keep one
    // source of truth for the file limit while leaving explicit envelope room.
    bodyLimit: options.config.image.maxUploadBytes + 4 * 1024 * 1024,
    logger: options.logger ?? false,
    trustProxy: options.config.trustProxy,
  });

  const resolveClientIdentity = createClientIdentityResolver(options.config.trustCloudflareHeaders
    ? {
        cloudflare: {
          clientIpHeader: "cf-connecting-ip",
          countryHeader: "cf-ipcountry",
          trustedProxyCidrs: ["127.0.0.1"],
        },
      }
    : {});
  app.decorateRequest("clientIdentity");
  app.decorateRequest("domainContext");
  app.decorateRequest("domainPolicy");
  app.addHook("onRequest", async (request) => {
    request.clientIdentity = resolveClientIdentity(request);
  });
  app.addHook("onRequest", requestTrustHook(options.config, options.stores.domains));
  app.addHook("onRequest", async (request, reply) => {
    if (reply.sent || request.domainContext.definition.surface !== "redirect") {
      return;
    }
    const pathname = (request.raw.url ?? "/").split("?", 1)[0];
    if (pathname !== "/" && pathname !== "/index.php") {
      return;
    }
    await reply
      .code(404)
      .header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
      .header("Pragma", "no-cache")
      .header("Expires", "Thu, 19 Nov 1981 08:52:00 GMT")
      .header("X-Robots-Tag", "noindex, nofollow, noarchive")
      .type("text/plain; charset=utf-8")
      .send("");
  });
  if (options.authService !== undefined) {
    await registerAuth(app, options.authService, options.config);
    app.register(fastifyStatic, {
      root: new URL("../public/assets/", import.meta.url),
      prefix: "/assets/",
      decorateReply: false,
      cacheControl: false,
      etag: true,
      lastModified: true,
      index: false,
      allowedPath: (_path, _root, request) => request.domainPolicy.surface === "dashboard",
      setHeaders: (reply) => {
        reply.header("X-Content-Type-Options", "nosniff");
        reply.header(
          "Cache-Control",
          options.config.environment === "production"
            ? "public, max-age=300, must-revalidate"
            : "no-store, max-age=0",
        );
      },
    });
    const dashboardHistory = options.stores.dashboard === undefined
      ? undefined
      : new DashboardHistoryService({
          store: options.stores.dashboard,
          cache: options.stores.cache,
          clock: options.clock ?? systemClock,
          keyPrefix: options.config.appNamespace,
        });
    registerDashboardShell(app, {
      config: options.config,
      stores: options.stores,
      history: dashboardHistory,
    });
    if (options.stores.admin !== undefined) {
      const adminReporting = options.stores.adminReports !== undefined
        && options.stores.deliveredCountryReports !== undefined
        ? new AdminReportService({
            source: options.stores.adminReports,
            delivered: options.stores.deliveredCountryReports,
            deliveredCountryDomainIds: options.config.reporting.deliveredCountryDomainIds,
            clock: options.clock ?? systemClock,
          })
        : undefined;
      registerAdminRoutes(app, new AdminService({
        domains: options.stores.domains,
        controlPlane: options.stores.admin,
        registration: options.stores.auth,
        cache: options.stores.cache,
        registry: options.config.registry,
        clock: options.clock ?? systemClock,
        appNamespace: options.config.appNamespace,
        reporting: adminReporting,
      }), options.authService, options.config);
    }
  }
  if (options.imageUploadService !== undefined) {
    if (options.authService === undefined) {
      throw new Error("Image upload routes require authentication.");
    }
    await registerImageUploadRoutes(app, options.imageUploadService, options.config.image.maxUploadBytes);
  }
  if (options.linkService !== undefined) {
    if (options.authService === undefined || options.imageUploadService === undefined) {
      throw new Error("Link API routes require authentication and image services.");
    }
    registerLinkApiRoutes(app, {
      links: options.linkService,
      images: options.imageUploadService,
      stores: options.stores,
      registry: options.config.registry,
      browserScopedDefaultUsers: options.config.browserScopedDefaultUsers,
      maxBulkLinks: options.config.links.maxBulkLinks,
      maxBulkImages: options.config.links.maxBulkImages,
    });
  }

  app.get("/health/live", async () => ({ ok: true }));
  const readiness = options.readiness
    ?? createDeterministicReadinessProbe(options.config.storageDriver === "memory");
  app.get("/health/ready", async (request, reply) => {
    reply
      .header("Cache-Control", "no-store, private, max-age=0")
      .header("X-Robots-Tag", "noindex, nofollow, noarchive");
    const ready = await readiness.check().catch(() => false);
    if (!ready) {
      await reply
        .code(503)
        .type("text/plain; charset=utf-8")
        .send("Temporarily unavailable.\n");
      return;
    }
    return { ok: true, domain_id: request.domainPolicy.id };
  });
  registerPilotDiagnostics(app, options.config);

  const redirectService = new RedirectService({
    appNamespace: options.config.appNamespace,
    ipHashSecret: options.config.ipHashSecret,
    stores: options.stores,
    clock: options.clock ?? systemClock,
    decisions: options.decisions ?? new PassThroughDecisionEngine(),
    metadataReader: options.metadataReader ?? noImageMetadataReader,
  });
  await registerRedirectRoutes(app, redirectService);

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).type("text/plain; charset=utf-8").send("Not found.\n");
  });
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      await reply
        .code(error.statusCode)
        .header("Cache-Control", "no-store, private, max-age=0")
        .header("X-Robots-Tag", "noindex, nofollow, noarchive")
        .type("text/plain; charset=utf-8")
        .send(`${error.expose ? error.message : "Unexpected error."}\n`);
      return;
    }
    request.log.error({ err: error }, "request failed");
    await reply
      .code(500)
      .header("Cache-Control", "no-store, private, max-age=0")
      .header("X-Robots-Tag", "noindex, nofollow, noarchive")
      .type("text/plain; charset=utf-8")
      .send("Unexpected error.\n");
  });

  return app;
}
