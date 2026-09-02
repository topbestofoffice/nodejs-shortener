import { describe, expect, it } from "vitest";
import { parseAdminAction, reconstructGeoQualityForm } from "../src/modules/admin/form-policy.js";
import { validateGeoQualitySave } from "../src/modules/admin/geo-quality-policy.js";

describe("Admin form boundary", () => {
  it("accepts only an exact scalar action", () => {
    expect(parseAdminAction("save_geo")).toBe("save_geo");
    expect(parseAdminAction("unknown")).toBeNull();
    expect(parseAdminAction(["save_geo"])).toBeNull();
  });

  it("reconstructs a complete bounded bracketed geo form", () => {
    const candidate = reconstructGeoQualityForm({
      geo_rows_complete: "1",
      quality_mode: "selected",
      "geo_rows[0][country]": "IN",
      "geo_rows[0][percent]": "40",
      "geo_rows[0][quality]": "1",
      "geo_rows[1][country]": "US",
      "geo_rows[1][percent]": "0",
    });
    expect(candidate).not.toBeNull();
    expect(validateGeoQualitySave(candidate)).toMatchObject({
      ok: true,
      value: {
        rules: [{ countryCode: "IN", percent: 40 }, { countryCode: "US", percent: 0 }],
        qualityPolicy: { active: true, scope: "selected", countries: ["IN"] },
      },
    });
  });

  it("rejects index gaps, oversized indexes, malformed keys and array scalars", () => {
    expect(reconstructGeoQualityForm({
      geo_rows_complete: "1",
      "geo_rows[1][country]": "IN",
    })).toBeNull();
    expect(reconstructGeoQualityForm({ "geo_rows[250][country]": "IN" })).toBeNull();
    expect(reconstructGeoQualityForm({ "geo_rows[0][__proto__]": "IN" })).toBeNull();
    expect(reconstructGeoQualityForm({ "geo_rows[0][country]": ["IN", "US"] })).toBeNull();
  });
});
