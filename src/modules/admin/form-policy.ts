const geoFieldPattern = /^geo_rows\[(0|[1-9][0-9]{0,2})\]\[(country|percent|quality)\]$/;

export type AdminAction =
  | "add_user"
  | "delete_user"
  | "save_settings"
  | "save_geo"
  | "save_registration"
  | "reset_sessions"
  | "load_diversion_history";

const adminActions = new Set<AdminAction>([
  "add_user",
  "delete_user",
  "save_settings",
  "save_geo",
  "save_registration",
  "reset_sessions",
  "load_diversion_history",
]);

/** Strict scalar discriminator; arrays and unknown actions never reach a store. */
export function parseAdminAction(value: unknown): AdminAction | null {
  return typeof value === "string" && adminActions.has(value as AdminAction)
    ? value as AdminAction
    : null;
}

/**
 * Reconstruct bounded PHP-style bracketed geo fields from Fastify formbody.
 * Unknown geo keys, duplicate/array scalars and index gaps fail closed so a
 * truncated form cannot become an authoritative delete-all save.
 */
export function reconstructGeoQualityForm(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const rows = new Map<number, Record<string, string>>();
  for (const [key, raw] of Object.entries(body)) {
    if (!key.startsWith("geo_rows")) continue;
    if (key === "geo_rows_complete") continue;
    const match = geoFieldPattern.exec(key);
    if (match === null || typeof raw !== "string") return null;
    const index = Number(match[1]);
    if (index > 249) return null;
    const field = match[2] as "country" | "percent" | "quality";
    const row = rows.get(index) ?? {};
    if (Object.hasOwn(row, field)) return null;
    row[field] = raw;
    rows.set(index, row);
  }

  const indexes = [...rows.keys()].sort((left, right) => left - right);
  if (indexes.some((index, position) => index !== position)) return null;
  const scalar = (key: string): string | undefined => {
    const value = body[key];
    return typeof value === "string" ? value : undefined;
  };
  return Object.freeze({
    geo_rows_complete: scalar("geo_rows_complete"),
    quality_mode: scalar("quality_mode"),
    quality_active: scalar("quality_active"),
    quality_scope: scalar("quality_scope"),
    quality_all_confirm: scalar("quality_all_confirm"),
    geo_rows: Object.freeze(indexes.map((index) => Object.freeze(rows.get(index) ?? {}))),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
