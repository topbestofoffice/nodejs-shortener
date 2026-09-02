import { escapeHtml } from "../../web/escape.js";
import type { DomainDefinition, LinkRecord } from "../../core/types.js";
import { normalizeHttpDestination } from "../../core/http-destination.js";

export interface ImageMetadata {
  readonly width: number;
  readonly height: number;
  readonly mime: "image/jpeg" | "image/png" | "image/gif" | "image/webp" | null;
}

export interface ImageMetadataReader {
  read(relativePath: string): Promise<ImageMetadata | null>;
}

export const noImageMetadataReader: ImageMetadataReader = {
  read: async () => null,
};

export async function renderOpenGraphPreview(
  link: LinkRecord,
  domain: DomainDefinition,
  metadataReader: ImageMetadataReader,
): Promise<string> {
  const title = link.title?.trim() || link.domainLabel.trim() || domain.label;
  const description = link.description ?? "";
  const shortUrl = new URL(`/${encodeURIComponent(link.code)}`, domain.publicBaseUrl).toString();
  const image = resolveImage(link.image, domain);
  const metadata = image?.relativePath === undefined ? null : await metadataReader.read(image.relativePath);
  const useCompactNoImagePreview = domain.compactNoImagePreview && image === null;
  const safeDestination = normalizeHttpDestination(link.destination);
  const descriptionTag = useCompactNoImagePreview && description.trim().length === 0
    ? ""
    : `<meta property="og:description" content="${escapeHtml(description)}">`;

  const imageTags = image === null
    ? ""
    : [
        `<meta property="og:image" content="${escapeHtml(image.url)}">`,
        `<meta property="og:image:secure_url" content="${escapeHtml(image.url)}">`,
        metadata?.mime !== null && metadata?.mime !== undefined
          ? `<meta property="og:image:type" content="${metadata.mime}">`
          : "",
        image.relativePath !== undefined && domain.emitLocalImageAlt
          ? `<meta property="og:image:alt" content="${escapeHtml(title)}">`
          : "",
        metadata !== null ? `<meta property="og:image:width" content="${metadata.width}">` : "",
        metadata !== null ? `<meta property="og:image:height" content="${metadata.height}">` : "",
        `<meta name="twitter:image" content="${escapeHtml(image.url)}">`,
      ].filter(Boolean).join("\n    ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta property="og:title" content="${escapeHtml(title)}">
    ${descriptionTag}
    <meta property="og:url" content="${escapeHtml(shortUrl)}">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="${useCompactNoImagePreview ? "summary" : "summary_large_image"}">
    ${imageTags}
    <title>${escapeHtml(title)}</title>
</head>
<body>
    ${safeDestination === null
      ? "<p>Destination unavailable.</p>"
      : `<script>window.location.href = ${safeJsonForHtml(safeDestination)};</script>
    <p>Redirecting… <a href="${escapeHtml(safeDestination)}">Continue</a></p>`}
</body>
</html>`;
}

function resolveImage(image: string | null, domain: DomainDefinition): { url: string; relativePath?: string } | null {
  const value = image?.trim() ?? "";
  if (value.length === 0) {
    return null;
  }
  if (/^https?:\/\//i.test(value)) {
    return { url: value };
  }
  const relativePath = value.replace(/^\/+/, "");
  return { url: new URL(`/${relativePath}`, domain.imageBaseUrl).toString(), relativePath };
}

function safeJsonForHtml(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}
