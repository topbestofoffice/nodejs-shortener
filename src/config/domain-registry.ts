import { domainToASCII } from "node:url";
import { z } from "zod";
import { MisdirectedRequestError } from "../core/errors.js";
import type { DomainContext, DomainDefinition } from "../core/types.js";

const hostPattern = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeRequestHost(rawHost: string): string | null {
  let value = rawHost.trim().toLowerCase();
  if (value.length === 0 || value.length > 259 || /[\r\n,@/\\]/.test(value) || value.startsWith("[")) {
    return null;
  }

  const portMatch = /^(.*):([0-9]{1,5})$/.exec(value);
  if (portMatch !== null) {
    const port = Number(portMatch[2]);
    if (port < 1 || port > 65_535) {
      return null;
    }
    value = portMatch[1] ?? "";
  }

  value = value.replace(/\.+$/, "");
  const ascii = domainToASCII(value);
  if (ascii.length === 0 || ascii.includes(":") || !hostPattern.test(ascii)) {
    return null;
  }
  return ascii;
}

const domainSchema = z.object({
  id: z.number().int().min(1).max(65_535),
  key: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  diversionCampaign: z.string().regex(/^[a-z0-9_-]{1,32}$/).optional(),
  reportTimezone: z.enum(["UTC", "Asia/Kolkata"]).optional(),
  canonicalHost: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  label: z.string().trim().min(1).max(64),
  surface: z.enum(["dashboard", "redirect"]),
  active: z.boolean(),
  allowCreate: z.boolean(),
  publicBaseUrl: z.url(),
  imageBaseUrl: z.url(),
  emitLocalImageAlt: z.boolean().default(false),
  compactNoImagePreview: z.boolean().default(false),
  creationFallback: z.boolean().default(false),
  acceptUnprovenDeliveredClaim: z.boolean().default(false),
});

export class DomainRegistry {
  readonly #byHost = new Map<string, DomainContext>();
  readonly #byId = new Map<number, DomainDefinition>();

  public constructor(rawDefinitions: unknown) {
    const parsed = z.array(domainSchema).min(1).parse(rawDefinitions);
    for (const item of parsed) {
      const canonicalHost = normalizeRequestHost(item.canonicalHost);
      if (canonicalHost === null) {
        throw new Error(`Invalid canonical host for domain ${item.id}`);
      }
      const baseUrls = validateDomainUrls(item.id, canonicalHost, item.publicBaseUrl, item.imageBaseUrl);
      if (this.#byId.has(item.id)) {
        throw new Error(`Duplicate domain id: ${item.id}`);
      }

      const definition: DomainDefinition = Object.freeze({
        ...item,
        diversionCampaign: item.diversionCampaign ?? item.key,
        reportTimezone: item.reportTimezone ?? "UTC",
        canonicalHost,
        publicBaseUrl: baseUrls.publicBaseUrl,
        imageBaseUrl: baseUrls.imageBaseUrl,
        aliases: Object.freeze([...item.aliases]),
      });
      this.#byId.set(definition.id, definition);
      this.#registerHost(canonicalHost, definition, true);
      for (const rawAlias of definition.aliases) {
        const alias = normalizeRequestHost(rawAlias);
        if (alias === null) {
          throw new Error(`Invalid alias for domain ${item.id}: ${rawAlias}`);
        }
        this.#registerHost(alias, definition, alias === canonicalHost);
      }
    }

    const creationFallbacks = [...this.#byId.values()].filter((domain) => domain.creationFallback);
    if (creationFallbacks.length > 1) {
      throw new Error("Only one domain can be the creation fallback.");
    }
    if (creationFallbacks.some((domain) => !domain.active || !domain.allowCreate)) {
      throw new Error("The creation fallback must be active and allow link creation.");
    }
  }

  #registerHost(host: string, definition: DomainDefinition, isCanonical: boolean): void {
    if (this.#byHost.has(host)) {
      throw new Error(`Duplicate host route: ${host}`);
    }
    this.#byHost.set(host, Object.freeze({ definition, requestHost: host, isCanonical }));
  }

  public resolve(rawHost: string | undefined): DomainContext {
    const host = normalizeRequestHost(rawHost ?? "");
    const context = host === null ? undefined : this.#byHost.get(host);
    if (context === undefined) {
      throw new MisdirectedRequestError();
    }
    return context;
  }

  public byId(id: number): DomainDefinition | undefined {
    return this.#byId.get(id);
  }

  public all(): readonly DomainDefinition[] {
    return Object.freeze([...this.#byId.values()]);
  }
}

function validateDomainUrls(
  id: number,
  canonicalHost: string,
  publicBaseUrl: string,
  imageBaseUrl: string,
): { readonly publicBaseUrl: string; readonly imageBaseUrl: string } {
  const publicUrl = new URL(publicBaseUrl);
  const imageUrl = new URL(imageBaseUrl);
  for (const [label, value] of [["public", publicUrl], ["image", imageUrl]] as const) {
    if ((value.protocol !== "http:" && value.protocol !== "https:")
      || value.username.length > 0 || value.password.length > 0
      || value.pathname !== "/" || value.search.length > 0 || value.hash.length > 0) {
      throw new Error(`Invalid ${label} base URL for domain ${id}`);
    }
  }
  if (normalizeRequestHost(publicUrl.hostname) !== canonicalHost) {
    throw new Error(`Public base URL Host does not match domain ${id}`);
  }
  return { publicBaseUrl: publicUrl.origin, imageBaseUrl: imageUrl.origin };
}
