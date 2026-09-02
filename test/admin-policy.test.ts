import { describe, expect, it } from "vitest";
import { selectManageableDomain } from "../src/modules/admin/domain-selection-policy.js";
import { validateGeoQualitySave } from "../src/modules/admin/geo-quality-policy.js";
import { validateSkimSettings } from "../src/modules/admin/skim-settings-policy.js";

describe("Admin manageable-domain selection", () => {
  it("defaults to the lowest configured manageable domain and allows a paused create domain", () => {
    expect(selectManageableDomain([3, 1, 2], undefined)).toEqual({
      ok: true,
      value: { domainId: 1, usedDefault: true },
    });
    expect(selectManageableDomain([1, 2, 3], "3")).toEqual({
      ok: true,
      value: { domainId: 3, usedDefault: false },
    });
  });

  it("never falls back when an explicit selection is invalid or not manageable", () => {
    expect(selectManageableDomain([1, 2, 3], "4")).toMatchObject({
      ok: false,
      code: "invalid_domain_selection",
    });
    expect(selectManageableDomain([1, 2, 3], "02")).toMatchObject({
      ok: false,
      code: "invalid_domain_selection",
    });
    expect(selectManageableDomain([1, 2, 3], "")).toMatchObject({
      ok: false,
      code: "invalid_domain_selection",
    });
    expect(selectManageableDomain([], undefined)).toMatchObject({
      ok: false,
      code: "no_manageable_domains",
    });
    expect(selectManageableDomain([1, 1], undefined)).toMatchObject({
      ok: false,
      code: "invalid_manageable_domain_configuration",
    });
  });
});

describe("Admin diversion settings policy", () => {
  it("normalizes enabled, trimmed http(s) destination and a whole default percent", () => {
    expect(validateSkimSettings({
      skim_enabled: "1",
      skim_destination_url: "  https://landing.example/path?q=1  ",
      skim_default_percent: "35",
    })).toEqual({
      ok: true,
      value: {
        enabled: true,
        destinationUrl: "https://landing.example/path?q=1",
        defaultPercent: 35,
      },
    });
    expect(validateSkimSettings({
      skim_destination_url: "",
      skim_default_percent: 0,
    })).toMatchObject({
      ok: true,
      value: { enabled: false, destinationUrl: "", defaultPercent: 0 },
    });
  });

  it.each([
    ["javascript:alert(1)", "40", "invalid_destination_url"],
    ["//landing.example/path", "40", "invalid_destination_url"],
    ["https://landing.example", "10.5", "invalid_default_percent"],
    ["https://landing.example", "101", "invalid_default_percent"],
    ["https://landing.example", "01", "invalid_default_percent"],
  ])("rejects destination=%s percent=%s without a candidate", (destination, percent, code) => {
    const result = validateSkimSettings({
      skim_enabled: "1",
      skim_destination_url: destination,
      skim_default_percent: percent,
    });
    expect(result).toMatchObject({ ok: false, code });
    expect(result).not.toHaveProperty("value");
  });
});

describe("Admin geo + Quality Control atomic validation", () => {
  it("normalizes, prunes selected zero-percent Quality, and sorts deterministically", () => {
    const result = validateGeoQualitySave(form({
      geo_rows: [
        { country: " us ", percent: "0", quality: "1" },
        { country: "id", percent: "75", quality: "1" },
        { country: "BR", percent: 20, quality: "0" },
        { country: "", percent: "", quality: "0" },
      ],
    }));

    expect(result).toEqual({
      ok: true,
      value: {
        rules: [
          { countryCode: "BR", percent: 20 },
          { countryCode: "ID", percent: 75 },
          { countryCode: "US", percent: 0 },
        ],
        qualityPolicy: {
          active: true,
          scope: "selected",
          countries: ["ID"],
        },
      },
    });
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.rules)).toBe(true);
      expect(Object.isFrozen(result.value.qualityPolicy.countries)).toBe(true);
    }
  });

  it("supports Off, Selected, and confirmed All while preserving current scope semantics", () => {
    expect(validateGeoQualitySave(form({ quality_mode: "off" }))).toMatchObject({
      ok: true,
      value: { qualityPolicy: { active: false, scope: "selected" } },
    });
    expect(validateGeoQualitySave(form({ quality_mode: "selected" }))).toMatchObject({
      ok: true,
      value: { qualityPolicy: { active: true, scope: "selected" } },
    });
    expect(validateGeoQualitySave(form({
      quality_mode: "all",
      quality_all_confirm: "1",
    }))).toMatchObject({
      ok: true,
      value: { qualityPolicy: { active: true, scope: "all" } },
    });
    expect(validateGeoQualitySave({
      geo_rows_complete: "1",
      geo_rows: [],
      quality_active: "0",
      quality_scope: "all",
    })).toMatchObject({
      ok: true,
      value: { qualityPolicy: { active: false, scope: "all" } },
    });
  });

  it("requires the post-row complete marker before accepting an intentional empty save", () => {
    expect(validateGeoQualitySave(form({ geo_rows_complete: undefined, geo_rows: [] }))).toMatchObject({
      ok: false,
      code: "incomplete_rows",
    });
    expect(validateGeoQualitySave(form({ geo_rows: [] }))).toEqual({
      ok: true,
      value: {
        rules: [],
        qualityPolicy: { active: true, scope: "selected", countries: [] },
      },
    });
  });

  it("requires explicit confirmation for active All scope", () => {
    const result = validateGeoQualitySave(form({ quality_mode: "all" }));
    expect(result).toMatchObject({ ok: false, code: "all_confirmation_required" });
    expect(result).not.toHaveProperty("value");
  });

  it("allows exactly 250 rows and rejects a truncated or oversized submission before row parsing", () => {
    const countries = supportedCodes().slice(0, 250);
    expect(countries).toHaveLength(250);
    expect(validateGeoQualitySave(form({
      geo_rows: countries.map((country) => ({ country, percent: "1", quality: "0" })),
    }))).toMatchObject({ ok: true });

    const tooMany = countries.map((country) => ({ country, percent: "1", quality: "0" }));
    tooMany.push({ country: "US", percent: "1", quality: "0" });
    expect(validateGeoQualitySave(form({ geo_rows: tooMany }))).toMatchObject({
      ok: false,
      code: "too_many_rows",
    });
  });

  it.each([
    [[{ country: "U", percent: "10", quality: "0" }], "invalid_country_code"],
    [[{ country: "ZZ", percent: "10", quality: "0" }], "invalid_country_code"],
    [[{ country: "US", percent: "10.5", quality: "0" }], "invalid_percent"],
    [[{ country: "US", percent: "-1", quality: "0" }], "invalid_percent"],
    [[{ country: "US", percent: "101", quality: "0" }], "invalid_percent"],
    [[{ country: "US", percent: "010", quality: "0" }], "invalid_percent"],
    [[{ country: "US", percent: "10", quality: "yes" }], "invalid_quality_choice"],
    [[{ country: "US", percent: "10", quality: "0" }, { country: "us", percent: "20", quality: "0" }], "duplicate_country"],
    [[{ country: "US", percent: "", quality: "0" }], "incomplete_row"],
    [["not-a-row"], "malformed_row"],
  ])("rejects bad rows atomically: %j", (geoRows, code) => {
    const original = structuredClone(geoRows);
    const result = validateGeoQualitySave(form({ geo_rows: geoRows }));

    expect(result).toMatchObject({ ok: false, code });
    expect(result).not.toHaveProperty("value");
    expect(geoRows).toEqual(original);
  });

  it("accepts the PHP-supported XK code but rejects pseudo country markers", () => {
    expect(validateGeoQualitySave(form({
      geo_rows: [{ country: "XK", percent: "10", quality: "1" }],
    }))).toMatchObject({ ok: true });
    for (const country of ["XX", "T1"]) {
      expect(validateGeoQualitySave(form({
        geo_rows: [{ country, percent: "10", quality: "1" }],
      }))).toMatchObject({ ok: false, code: "invalid_country_code" });
    }
  });
});

function form(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    geo_rows_complete: "1",
    geo_rows: [{ country: "US", percent: "50", quality: "1" }],
    quality_mode: "selected",
    quality_all_confirm: "0",
    ...overrides,
  };
}

function supportedCodes(): string[] {
  return "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" ");
}
