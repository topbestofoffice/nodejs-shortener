import type { DomainRegistry } from "../../config/domain-registry.js";
import type { LinkRecord } from "../../core/types.js";
import { escapeHtml } from "../../web/escape.js";

export interface LinkCardOptions {
  readonly canDelete?: boolean;
  readonly countedClicks?: bigint;
}

export function renderLinkCard(
  link: LinkRecord,
  registry: DomainRegistry,
  options: LinkCardOptions = {},
): string {
  const domain = registry.byId(link.domainId);
  if (domain === undefined) {
    return renderUnavailableDomainCard(link, options);
  }
  const shortUrl = new URL(`/${encodeURIComponent(link.code)}`, domain.publicBaseUrl).toString();
  const title = link.title?.trim() || "Untitled link";
  const image = publicImageUrl(link.image, domain.imageBaseUrl);
  const date = formatCreatedAt(link.createdAt);
  const countedClicks = options.countedClicks !== undefined && options.countedClicks >= 0n
    ? options.countedClicks
    : 0n;
  const formattedClicks = new Intl.NumberFormat("en-IN").format(countedClicks);
  const imageMarkup = image === ""
    ? '<i class="fas fa-image" aria-hidden="true"></i>'
    : `<img hidden data-dashboard-src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async" width="58" height="44"><noscript><img src="${escapeHtml(image)}" alt="" loading="lazy" decoding="async" width="58" height="44"></noscript>`;
  const deleteMarkup = options.canDelete !== false
    ? `<button type="button" data-delete-link data-code="${escapeHtml(link.code)}" data-domain-id="${link.domainId}" class="link-delete"><span aria-hidden="true">×</span><span>Delete</span></button>`
    : "";

  return `<div class="link-row" id="link-card-${link.domainId}-${escapeHtml(link.code)}">
<span class="link-status" aria-label="Active link"></span>
<div class="link-thumb">${imageMarkup}</div>
<div class="link-main">
<p class="link-title" title="${escapeHtml(title)}">${escapeHtml(title)}</p>
<div class="link-short-line"><a href="${escapeHtml(shortUrl)}" target="_blank" rel="noopener noreferrer" class="link-short">${escapeHtml(shortUrl)}</a><button type="button" data-copy-link data-short-url="${escapeHtml(shortUrl)}" class="link-copy" aria-label="Copy short link" title="Copy short link"><span aria-hidden="true">Copy</span></button></div>
<p class="link-meta" title="${escapeHtml(link.destination)}">${escapeHtml(destinationPreview(link.destination))} <span aria-hidden="true">·</span> ${escapeHtml(date)}</p>
${link.description === null ? "" : `<p class="link-description" title="${escapeHtml(link.description)}">${escapeHtml(link.description)}</p>`}
</div>
<span class="link-clicks" title="Counted clicks" aria-label="${formattedClicks} counted clicks"><i class="fas fa-chart-simple" aria-hidden="true"></i><span class="link-clicks-value">${formattedClicks}</span><span class="link-clicks-unit">clicks</span></span>
<div class="link-actions"><button type="button" data-kebab-toggle aria-haspopup="true" aria-expanded="false" aria-label="More actions for ${escapeHtml(shortUrl)}" title="Link actions" class="kebab-toggle"><span aria-hidden="true">⋮</span></button><div data-kebab-menu class="hidden">${deleteMarkup}</div></div>
</div>`;
}

function renderUnavailableDomainCard(link: LinkRecord, options: LinkCardOptions): string {
  const title = link.title?.trim() || "Untitled link";
  const date = formatCreatedAt(link.createdAt);
  const countedClicks = options.countedClicks !== undefined && options.countedClicks >= 0n
    ? options.countedClicks
    : 0n;
  const formattedClicks = new Intl.NumberFormat("en-IN").format(countedClicks);
  const unavailableCode = `Unavailable domain · ${link.code}`;
  return `<div class="link-row link-domain-unavailable" id="link-card-${link.domainId}-${escapeHtml(link.code)}" data-domain-unavailable="true">
<span class="link-status" aria-label="Link domain unavailable"></span>
<div class="link-thumb"><i class="fas fa-triangle-exclamation" aria-hidden="true"></i></div>
<div class="link-main">
<p class="link-title" title="${escapeHtml(title)}">${escapeHtml(title)}</p>
<div class="link-short-line"><span class="link-short" title="This legacy domain is not configured">${escapeHtml(unavailableCode)}</span></div>
<p class="link-meta" title="${escapeHtml(link.destination)}">${escapeHtml(destinationPreview(link.destination))} <span aria-hidden="true">·</span> ${escapeHtml(date)}</p>
${link.description === null ? "" : `<p class="link-description" title="${escapeHtml(link.description)}">${escapeHtml(link.description)}</p>`}
</div>
<span class="link-clicks" title="Counted clicks" aria-label="${formattedClicks} counted clicks"><i class="fas fa-chart-simple" aria-hidden="true"></i><span class="link-clicks-value">${formattedClicks}</span><span class="link-clicks-unit">clicks</span></span>
<div class="link-actions"></div>
</div>`;
}

export function destinationPreview(value: string): string {
  try {
    const url = new URL(value);
    const path = `${url.hostname}${url.pathname}`;
    let preview = truncatePreview(path);
    const source = url.searchParams.get("utm_source");
    const medium = url.searchParams.get("utm_medium");
    if (source) {
      preview += ` | Src: ${source}`;
    }
    if (medium) {
      preview += ` | Med: ${medium}`;
    }
    return preview;
  } catch {
    return truncatePreview(value.trim());
  }
}

export function publicImageUrl(image: string | null, imageBaseUrl: string): string {
  const value = image?.trim() ?? "";
  if (value === "") {
    return "";
  }
  return /^https?:\/\//i.test(value) ? value : new URL(`/${value.replace(/^\/+/, "")}`, imageBaseUrl).toString();
}

function truncatePreview(value: string): string {
  return value.length > 18 ? `${value.slice(0, 18)}...` : value;
}

function formatCreatedAt(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return "Date unavailable";
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "short",
      day: "2-digit",
    }).format(value);
  } catch {
    return "Date unavailable";
  }
}
