import { randomInt } from "node:crypto";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import type { CreateLinkInput, LinkRecord } from "../../core/types.js";
import type { DomainRegistry } from "../../config/domain-registry.js";
import type { ApplicationStores, Clock } from "../../ports.js";
import { normalizeHttpDestination } from "../../core/http-destination.js";
import {
  dashboardCommunityStatsCacheKey,
  dashboardOwnStatsCacheKey,
} from "../dashboard/history-service.js";
import { isManagedImagePath } from "../uploads/managed-image-path.js";

const codeAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export interface CreateLinkRequest {
  readonly domainId: number;
  readonly userId: number;
  readonly destination: string;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly image?: string | null;
  readonly imageSessionScopeHash?: string | null;
}

export interface LinkServiceOptions {
  readonly appNamespace: string;
  readonly registry: DomainRegistry;
  readonly stores: ApplicationStores;
  readonly clock: Clock;
  readonly codeLength?: number;
  readonly codeGenerator?: (length: number) => string;
  readonly imageOwnershipTtlSeconds?: number;
}

export class LinkService {
  readonly #codeLength: number;
  readonly #codeGenerator: (length: number) => string;
  readonly #imageOwnershipTtlSeconds: number;

  public constructor(private readonly options: LinkServiceOptions) {
    this.#codeLength = options.codeLength ?? 7;
    this.#codeGenerator = options.codeGenerator ?? generateCode;
    const requestedTtl = options.imageOwnershipTtlSeconds ?? 86_400;
    if (!Number.isSafeInteger(requestedTtl) || requestedTtl < 1) {
      throw new RangeError("Image ownership TTL must be a positive whole number of seconds.");
    }
    // PHP clamps its configured attachment TTL to at least one hour.
    this.#imageOwnershipTtlSeconds = Math.max(3_600, requestedTtl);
  }

  public async create(request: CreateLinkRequest): Promise<LinkRecord> {
    const domain = await this.assertCreatableDomain(request.domainId);
    const destination = normalizeHttpDestination(request.destination);
    if (destination === null) {
      throw new ValidationError("Invalid URL.", "INVALID_DESTINATION");
    }
    const createdAt = this.options.clock.now();
    const image = normalizeNullableText(request.image, 512);
    const base: Omit<CreateLinkInput, "code"> = {
      domainId: domain.id,
      userId: request.userId,
      destination,
      title: normalizeNullableText(request.title, 255),
      description: normalizeNullableText(request.description, 4096),
      image,
      imageSessionScopeHash: normalizeScopeHash(request.imageSessionScopeHash),
      imageOwnershipExpiresAt: isManagedUploadPath(image)
        ? new Date(createdAt.getTime() + this.#imageOwnershipTtlSeconds * 1_000)
        : null,
      createdAt,
    };

    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        const link = await this.options.stores.links.createLink({
          ...base,
          code: this.#codeGenerator(this.#codeLength),
        });
        await this.#invalidateDashboardStats(request.userId, false);
        return link;
      } catch (error) {
        if (!isDuplicateCodeError(error) || attempt === 11) {
          throw error;
        }
      }
    }
    throw new Error("Could not allocate a short code.");
  }

  public async assertCreatableDomain(domainId: number) {
    const domain = await this.options.stores.domains.getDomain(domainId);
    const configured = this.options.registry.byId(domainId);
    if (domain === null || configured === undefined || !domain.active || !domain.allowCreate
      || !configured.active || !configured.allowCreate) {
      throw new ValidationError("Choose a valid short-link domain.", "DOMAIN_NOT_CREATABLE");
    }
    if (domain.hostname !== configured.canonicalHost || domain.surface !== configured.surface
      || domain.active !== configured.active || domain.allowCreate !== configured.allowCreate) {
      throw new ValidationError("Choose a valid short-link domain.", "DOMAIN_CONFIG_MISMATCH");
    }
    return domain;
  }

  public async deleteOwned(domainId: number, code: string, userId: number): Promise<void> {
    if (!/^[A-Za-z0-9]{1,32}$/.test(code)) {
      throw new NotFoundError("Link not found.");
    }
    const domain = await this.options.stores.domains.getDomain(domainId);
    if (domain === null || !domain.active || this.options.registry.byId(domainId) === undefined) {
      throw new NotFoundError("Link not found.");
    }
    if (!await this.options.stores.links.deleteOwnedLink(domainId, code, userId)) {
      throw new NotFoundError("Link not found.");
    }
    try {
      await this.options.stores.cache.delete(
        this.#key(`domain:${domainId}:link:${code}`),
        this.#key(`domain:${domainId}:og:${code}`),
        dashboardOwnStatsCacheKey(this.options.appNamespace, userId),
        dashboardCommunityStatsCacheKey(this.options.appNamespace),
      );
    } catch {
      // The owner-scoped MariaDB delete is already committed. Cache expiry is
      // bounded to 60 seconds and invalidation failure must not report a false
      // delete failure that encourages a duplicate mutation retry.
    }
  }

  public shortUrl(link: LinkRecord): string {
    const domain = this.options.registry.byId(link.domainId);
    if (domain === undefined) {
      throw new Error("Link domain is not configured.");
    }
    return new URL(`/${encodeURIComponent(link.code)}`, domain.publicBaseUrl).toString();
  }

  #key(suffix: string): string {
    return `${this.options.appNamespace}:${suffix}`;
  }

  async #invalidateDashboardStats(userId: number, includeCommunity: boolean): Promise<void> {
    const keys = [dashboardOwnStatsCacheKey(this.options.appNamespace, userId)];
    if (includeCommunity) keys.push(dashboardCommunityStatsCacheKey(this.options.appNamespace));
    try {
      await this.options.stores.cache.delete(...keys);
    } catch {
      // The committed MariaDB mutation remains authoritative. A cache outage
      // must not encourage a duplicate create/delete retry.
    }
  }
}

function generateCode(length: number): string {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += codeAlphabet[randomInt(codeAlphabet.length)] ?? "";
  }
  return value;
}

function normalizeNullableText(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0) {
    return null;
  }
  if (normalized.length > maxLength) {
    throw new ValidationError(`Value is too long (max ${maxLength}).`);
  }
  return normalized;
}

function normalizeScopeHash(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value.length === 0) return null;
  if (!/^[0-9a-f]{64}$/.test(value)) throw new ValidationError("Image ownership is unavailable.", "UPLOAD_UNAVAILABLE");
  return value;
}

function isManagedUploadPath(value: string | null): boolean {
  return value !== null && isManagedImagePath(value);
}

function isDuplicateCodeError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "DUPLICATE_CODE";
}
