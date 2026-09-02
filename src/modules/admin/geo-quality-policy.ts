import type { CountryQualityPolicy } from "../redirect/policy.js";

const supportedCountryCodes = new Set(
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" "),
);

export type QualityMode = "off" | "selected" | "all";

export interface GeoRuleCandidate {
  readonly countryCode: string;
  readonly percent: number;
}

export interface GeoQualityCandidate {
  readonly rules: readonly GeoRuleCandidate[];
  readonly qualityPolicy: CountryQualityPolicy;
}

export type GeoQualityError =
  | "incomplete_rows"
  | "missing_rows"
  | "too_many_rows"
  | "invalid_quality_mode"
  | "all_confirmation_required"
  | "malformed_row"
  | "incomplete_row"
  | "invalid_country_code"
  | "invalid_percent"
  | "invalid_quality_choice"
  | "duplicate_country";

export type GeoQualityResult =
  | { readonly ok: true; readonly value: GeoQualityCandidate }
  | { readonly ok: false; readonly code: GeoQualityError; readonly message: string };

/**
 * Build one immutable geo + Quality candidate. Callers receive no candidate on
 * any error, so validation cannot leak a partially accepted row set into a
 * later store mutation. Persistence still needs one database transaction.
 */
export function validateGeoQualitySave(input: unknown): GeoQualityResult {
  if (!isRecord(input) || input.geo_rows_complete !== "1") {
    return failure(
      "incomplete_rows",
      "Country rows were incomplete — reload and try again. Nothing changed.",
    );
  }
  if (!Array.isArray(input.geo_rows)) {
    return failure("missing_rows", "Country rows are missing — reload and try again.");
  }
  if (input.geo_rows.length > 250) {
    return failure("too_many_rows", "At most 250 country rules can be saved.");
  }

  const quality = parseQualityState(input);
  if (quality === null) {
    return failure("invalid_quality_mode", "Choose a valid Quality traffic status and scope.");
  }
  if (quality.mode === "all" && input.quality_all_confirm !== "1") {
    return failure(
      "all_confirmation_required",
      "Confirm All diverting countries before saving Quality traffic.",
    );
  }

  const rules = new Map<string, number>();
  const qualityCountries: string[] = [];
  for (const row of input.geo_rows) {
    if (!isRecord(row)) {
      return failure("malformed_row", "A country row is malformed — reload and try again.");
    }
    const countryRaw = scalarFormString(row.country);
    const percentRaw = scalarFormString(row.percent);
    const qualityRaw = row.quality === undefined ? "0" : scalarFormString(row.quality);
    if (countryRaw === null || percentRaw === null || qualityRaw === null) {
      return failure("malformed_row", "A country row is malformed — reload and try again.");
    }

    const country = countryRaw.trim().toUpperCase();
    const percentText = percentRaw.trim();
    if (country === "" && percentText === "") {
      continue;
    }
    if (country === "" || percentText === "") {
      return failure(
        "incomplete_row",
        "Every country row needs both a 2-letter code and a percentage.",
      );
    }
    if (!/^[A-Z]{2}$/.test(country) || !supportedCountryCodes.has(country)) {
      return failure(
        "invalid_country_code",
        "Use a valid 2-letter country code, for example US or ID.",
      );
    }
    const percent = parseWholePercent(percentText);
    if (percent === null) {
      return failure(
        "invalid_percent",
        "Each diversion percentage must be a whole number from 0 to 100.",
      );
    }
    if (qualityRaw !== "0" && qualityRaw !== "1") {
      return failure(
        "invalid_quality_choice",
        "A Quality Control choice is malformed — reload and try again.",
      );
    }
    if (rules.has(country)) {
      return failure(
        "duplicate_country",
        `Country ${country} appears more than once. Keep only one row per country.`,
      );
    }

    rules.set(country, percent);
    if (qualityRaw === "1" && percent > 0) {
      qualityCountries.push(country);
    }
  }

  const sortedRules = [...rules]
    .sort(([left], [right]) => compareAscii(left, right))
    .map(([countryCode, percent]) => Object.freeze({ countryCode, percent }));
  qualityCountries.sort(compareAscii);
  const qualityPolicy: CountryQualityPolicy = Object.freeze({
    active: quality.mode !== "off",
    scope: quality.scope,
    countries: Object.freeze(qualityCountries),
  });

  return {
    ok: true,
    value: Object.freeze({
      rules: Object.freeze(sortedRules),
      qualityPolicy,
    }),
  };
}

interface ParsedQualityState {
  readonly mode: QualityMode;
  readonly scope: "selected" | "all";
}

function parseQualityState(input: Record<string, unknown>): ParsedQualityState | null {
  if (Object.prototype.hasOwnProperty.call(input, "quality_mode")) {
    if (input.quality_mode !== "off"
      && input.quality_mode !== "selected"
      && input.quality_mode !== "all") {
      return null;
    }
    return {
      mode: input.quality_mode,
      scope: input.quality_mode === "all" ? "all" : "selected",
    };
  }

  if (!Object.prototype.hasOwnProperty.call(input, "quality_active")
    || !Object.prototype.hasOwnProperty.call(input, "quality_scope")
    || (input.quality_active !== "0" && input.quality_active !== "1")
    || (input.quality_scope !== "selected" && input.quality_scope !== "all")) {
    return null;
  }

  return {
    mode: input.quality_active === "1" ? input.quality_scope : "off",
    scope: input.quality_scope,
  };
}

function parseWholePercent(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,2})$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= 100 ? parsed : null;
}

function scalarFormString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: GeoQualityError, message: string): GeoQualityResult {
  return { ok: false, code, message };
}
