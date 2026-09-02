export interface SkimSettingsCandidate {
  readonly enabled: boolean;
  readonly destinationUrl: string;
  readonly defaultPercent: number;
}

export type SkimSettingsError =
  | "malformed_settings"
  | "invalid_enabled_state"
  | "invalid_destination_url"
  | "invalid_default_percent";

export type SkimSettingsResult =
  | { readonly ok: true; readonly value: SkimSettingsCandidate }
  | { readonly ok: false; readonly code: SkimSettingsError; readonly message: string };

/** Validate the three per-domain diversion settings before any store call. */
export function validateSkimSettings(input: unknown): SkimSettingsResult {
  if (!isRecord(input)) {
    return failure("malformed_settings", "Diversion settings are malformed — nothing changed.");
  }

  const enabled = parseEnabled(input.skim_enabled);
  if (enabled === null) {
    return failure("invalid_enabled_state", "Choose a valid diversion status.");
  }

  if (typeof input.skim_destination_url !== "string") {
    return failure(
      "invalid_destination_url",
      "Destination URL is not a valid http(s) URL — not saved.",
    );
  }
  const destinationUrl = input.skim_destination_url.trim();
  if (destinationUrl !== "" && !isHttpUrl(destinationUrl)) {
    return failure(
      "invalid_destination_url",
      "Destination URL is not a valid http(s) URL — not saved.",
    );
  }

  const defaultPercent = parseWholePercent(input.skim_default_percent);
  if (defaultPercent === null) {
    return failure(
      "invalid_default_percent",
      "Default diversion percentage must be a whole number from 0 to 100.",
    );
  }

  return {
    ok: true,
    value: Object.freeze({ enabled, destinationUrl, defaultPercent }),
  };
}

function parseEnabled(value: unknown): boolean | null {
  if (value === undefined || value === null || value === false || value === "0") return false;
  if (value === true || value === "1") return true;
  return null;
}

function parseWholePercent(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 100 ? value : null;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^(?:0|[1-9]\d{0,2})$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return parsed <= 100 ? parsed : null;
}

function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\r\n]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: SkimSettingsError, message: string): SkimSettingsResult {
  return { ok: false, code, message };
}
