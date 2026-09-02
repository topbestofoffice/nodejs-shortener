import { describe, expect, it } from "vitest";
import { SharpMetadataReader } from "../src/infrastructure/sharp-metadata-reader.js";

describe("Sharp metadata reader limits", () => {
  it("requires the runtime pixel limit instead of using an internal constant", () => {
    expect(() => new SharpMetadataReader("./public/uploads", 20_000_000)).not.toThrow();
    expect(() => new SharpMetadataReader("./public/uploads", 0)).toThrow(RangeError);
    expect(() => new SharpMetadataReader("./public/uploads", Number.NaN)).toThrow(RangeError);
  });
});
