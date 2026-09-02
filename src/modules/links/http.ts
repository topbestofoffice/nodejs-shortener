import { randomInt } from "node:crypto";
import type { MultipartValue } from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AppError, ValidationError } from "../../core/errors.js";
import type { SessionData } from "../../core/types.js";
import type { ApplicationStores, Clock } from "../../ports.js";
import type { DomainRegistry } from "../../config/domain-registry.js";
import { isBrowserScopedDefaultUser, type BrowserScopedDefaultUserIdentity } from "../../config/runtime.js";
import { assertCsrf, requireAuthenticated } from "../auth/http.js";
import { renderLinkCard, destinationPreview, publicImageUrl } from "../dashboard/link-card.js";
import type { ImageUploadService, StagedUpload } from "../uploads/service.js";
import type { LinkService } from "./service.js";
import { requireDashboardSurface } from "../../security/request-trust.js";
import { loadTrafficShieldReport } from "../dashboard/shield-service.js";

interface LinkApiOptions {
  readonly links: LinkService;
  readonly images: ImageUploadService;
  readonly stores: ApplicationStores;
  readonly registry: DomainRegistry;
  readonly browserScopedDefaultUsers: readonly BrowserScopedDefaultUserIdentity[];
  readonly maxBulkLinks?: number;
  readonly maxBulkImages?: number;
  readonly clock?: Clock;
}

interface ParsedMultipart {
  readonly fields: Map<string, string[]>;
  stagedImage: StagedUpload | null;
}

export function registerLinkApiRoutes(app: FastifyInstance, options: LinkApiOptions): void {
  app.post(
    "/api.php",
    { preHandler: requireDashboardSurface },
    async (request, reply) => {
      let parsed: ParsedMultipart | null = null;
      try {
        const auth = requireAuthenticated(request);
        parsed = await parseMultipart(request, options.images, options.maxBulkImages ?? 100, auth.session);
        assertCsrf(auth.session, field(parsed, "csrf"));
        const action = field(parsed, "action");
        if (action === "set_default_domain") {
          return await setDefaultDomain(reply, options, auth.user, numberField(parsed, "domain_id"));
        }
        if (action === "create_single") {
          return await createSingle(options, auth, parsed);
        }
        if (action === "create_bulk") {
          return await createBulk(options, auth, parsed);
        }
        if (action === "delete") {
          return await deleteLink(reply, options, auth.user.id, parsed);
        }
        if (action === "shield_stats") {
          return await trafficShieldStats(reply, options, auth.user.id);
        }
        throw new ValidationError("Unknown action", "UNKNOWN_ACTION");
      } catch (error) {
        return sendApiError(reply, error);
      } finally {
        if (parsed?.stagedImage !== null && parsed?.stagedImage !== undefined) {
          await options.images.discard(parsed.stagedImage);
        }
      }
    },
  );

  app.route({
    method: ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"],
    url: "/api.php",
    preHandler: requireDashboardSurface,
    handler: async (_request, reply) => reply.code(405).send({ ok: false, error: "POST required" }),
  });
}

async function trafficShieldStats(
  reply: FastifyReply,
  options: LinkApiOptions,
  userId: number,
) {
  if (options.stores.dashboard === undefined) {
    throw new AppError("Protection report unavailable right now.", 503, "SHIELD_UNAVAILABLE");
  }
  try {
    const report = await loadTrafficShieldReport(
      options.stores.dashboard,
      userId,
      options.clock?.now() ?? new Date(),
    );
    reply.header("Cache-Control", "no-store, private, max-age=0");
    return report;
  } catch {
    throw new AppError("Protection report unavailable right now.", 503, "SHIELD_UNAVAILABLE");
  }
}

async function setDefaultDomain(
  reply: FastifyReply,
  options: LinkApiOptions,
  user: { id: number; username: string; role: string },
  domainId: number,
) {
  await options.links.assertCreatableDomain(domainId);
  if (isBrowserScopedDefaultUser(user, options.browserScopedDefaultUsers)) {
    await reply.code(409).send({
      ok: false,
      error: "Refresh to save this domain on this browser.",
      preference_scope: "browser",
      persisted: false,
    });
    return;
  }
  await options.stores.auth.setDefaultDomain(user.id, domainId);
  return { ok: true, domain_id: domainId, preference_scope: "account", persisted: true };
}

async function createSingle(
  options: LinkApiOptions,
  auth: ReturnType<typeof requireAuthenticated>,
  parsed: ParsedMultipart,
) {
  const domainId = numberField(parsed, "domain_id");
  await options.links.assertCreatableDomain(domainId);
  let image: string | null = null;
  let imageInfo = null;
  if (parsed.stagedImage !== null) {
    const upload = await options.images.complete(parsed.stagedImage, auth.user.id, auth.session);
    image = upload.path;
    imageInfo = upload.imageInfo;
    parsed.stagedImage = null;
  } else {
    const imageUrl = field(parsed, "image_url").trim();
    if (imageUrl !== "") {
      image = await options.images.authorizeReference(auth.user.id, auth.session, imageUrl);
    }
  }
  const link = await options.links.create({
    domainId,
    userId: auth.user.id,
    destination: field(parsed, "destination"),
    title: field(parsed, "title"),
    description: field(parsed, "description"),
    image,
    imageSessionScopeHash: options.images.scopeHash(auth.session),
  });
  return {
    ok: true,
    card: renderLinkCard(link, options.registry),
    short: options.links.shortUrl(link),
    destination: destinationPreview(link.destination),
    destination_url: link.destination,
    image_info: imageInfo,
    retained_image_path: image?.startsWith("uploads/") === true ? image : null,
  };
}

async function createBulk(
  options: LinkApiOptions,
  auth: ReturnType<typeof requireAuthenticated>,
  parsed: ParsedMultipart,
) {
  const domainId = numberField(parsed, "domain_id");
  await options.links.assertCreatableDomain(domainId);
  const urls = field(parsed, "bulk_urls").split(/\r\n|\r|\n/).map((value) => value.trim()).filter(Boolean);
  const maxBulkLinks = options.maxBulkLinks ?? 100;
  if (urls.length === 0) {
    return { ok: false, error: "No URLs provided" };
  }
  if (urls.length > maxBulkLinks) {
    return { ok: false, error: `Too many URLs in one batch (max ${maxBulkLinks}). Split into smaller batches.` };
  }

  const rawPaths = fields(parsed, "bulk_image_paths[]", "bulk_image_paths");
  const maxBulkImages = options.maxBulkImages ?? 100;
  if (rawPaths.length > maxBulkImages) {
    throw new AppError(`Too many images in one batch (max ${maxBulkImages}).`, 422, "TOO_MANY_IMAGES");
  }
  const pool = [...await options.images.verifyOwnedPaths(auth.user.id, auth.session, rawPaths)];
  const external = field(parsed, "bulk_image_url").trim();
  if (external !== "") {
    pool.push(await options.images.authorizeReference(auth.user.id, auth.session, external));
  }
  const shuffled = shuffle([...new Set(pool)]);
  const boundedResponse = parsed.fields.has("card_limit");
  const requestedLimit = Number(field(parsed, "card_limit"));
  const cardLimit = [20, 50, 100].includes(requestedLimit) ? requestedLimit : 100;
  const cardRows = [];
  const items: Array<Record<string, string>> = [];
  const used = new Set<string>();
  let created = 0;
  let failed = 0;

  for (const [index, destination] of urls.entries()) {
    const image = shuffled.length === 0 ? null : shuffled[index % shuffled.length] ?? null;
    try {
      const link = await options.links.create({
        domainId,
        userId: auth.user.id,
        destination,
        title: field(parsed, "bulk_title"),
        description: field(parsed, "bulk_description"),
        image,
        imageSessionScopeHash: options.images.scopeHash(auth.session),
      });
      cardRows.push(link);
      if (boundedResponse && cardRows.length > cardLimit) {
        cardRows.shift();
      }
      const item: Record<string, string> = {
        short: options.links.shortUrl(link),
        destination_url: link.destination,
      };
      if (!boundedResponse || created < 20) {
        item.destination = destinationPreview(link.destination);
        item.image_url = publicImageUrl(link.image, options.registry.byId(link.domainId)?.imageBaseUrl ?? "");
      }
      items.push(item);
      created += 1;
      if (image?.startsWith("uploads/") === true) {
        used.add(image);
      }
    } catch {
      failed += 1;
    }
  }
  return {
    ok: true,
    cards: cardRows.map((link) => renderLinkCard(link, options.registry)),
    items,
    created,
    failed,
    images: shuffled.length,
    retained_image_paths: [...used],
  };
}

async function deleteLink(
  reply: FastifyReply,
  options: LinkApiOptions,
  userId: number,
  parsed: ParsedMultipart,
) {
  try {
    await options.links.deleteOwned(numberField(parsed, "domain_id"), field(parsed, "code"), userId);
    return { ok: true };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "NOT_FOUND") {
      throw error;
    }
    await reply.code(200).send({ ok: false, error: "Link not found" });
    return;
  }
}

async function parseMultipart(
  request: FastifyRequest,
  images: ImageUploadService,
  maxBulkImages: number,
  session: SessionData,
): Promise<ParsedMultipart> {
  if (!request.isMultipart()) {
    throw new AppError("Multipart form required", 415, "MULTIPART_REQUIRED");
  }
  const fieldsMap = new Map<string, string[]>();
  let stagedImage: StagedUpload | null = null;
  let csrfValidated = false;
  // `/upload.php` keeps the strict plugin defaults. `/api.php` needs room for
  // the portable 100 repeated bulk image paths plus bounded control fields.
  for await (const part of request.parts({
    limits: {
      fields: maxBulkImages + 16,
      files: 1,
      parts: maxBulkImages + 17,
    },
  })) {
    if (part.type === "file") {
      if (!csrfValidated) {
        part.file.resume();
        assertCsrf(session, undefined);
      }
      if (part.fieldname !== "upload_image" || stagedImage !== null || part.filename === "") {
        part.file.resume();
        continue;
      }
      stagedImage = await images.stage(part.file);
      if (part.file.truncated) {
        throw new ValidationError("Image file is too large.", "IMAGE_TOO_LARGE");
      }
    } else {
      const value = multipartValue(part.value);
      if (part.fieldname === "csrf") {
        assertCsrf(session, value);
        csrfValidated = true;
      }
      addField(fieldsMap, part.fieldname, value);
    }
  }
  return { fields: fieldsMap, stagedImage };
}

function addField(map: Map<string, string[]>, name: string, value: string): void {
  const current = map.get(name) ?? [];
  current.push(value);
  map.set(name, current);
}

function multipartValue(value: MultipartValue["value"]): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function field(parsed: ParsedMultipart, name: string): string {
  const values = parsed.fields.get(name) ?? [];
  if (values.length > 1) {
    throw new ValidationError(`Duplicate ${name} field.`, "DUPLICATE_FORM_FIELD");
  }
  return values[0] ?? "";
}

function fields(parsed: ParsedMultipart, ...names: readonly string[]): string[] {
  return names.flatMap((name) => parsed.fields.get(name) ?? []);
}

function numberField(parsed: ParsedMultipart, name: string): number {
  const value = Number(field(parsed, name));
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new ValidationError("Choose a valid short-link domain.", "INVALID_DOMAIN");
  }
  return value;
}

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [items[index], items[target]] = [items[target] as T, items[index] as T];
  }
  return items;
}

async function sendApiError(reply: FastifyReply, error: unknown) {
  if (error instanceof AppError) {
    const message = error.expose ? error.message : "Request failed";
    reply.header("Cache-Control", "no-store, private, max-age=0");
    if (error.statusCode === 429 && (error.code === "IMAGE_QUEUE_FULL" || error.code === "IMAGE_PROCESSOR_BUSY")) {
      await reply.code(429).send({
        ok: false,
        error: message,
        failure_code: "image_processor_busy",
        link_committed: false,
        retryable: true,
      });
      return;
    }
    await reply.code(error.statusCode).send({ ok: false, error: message });
    return;
  }
  reply.log.error({ err: error }, "link API failed");
  await reply
    .header("Cache-Control", "no-store, private, max-age=0")
    .code(500)
    .send({ ok: false, error: "Request failed" });
}
