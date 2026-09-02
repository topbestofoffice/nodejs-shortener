import { describe, expect, it } from "vitest";
import {
  assertProductionStartupAllowed,
  productionStartupBlockedMessage,
} from "../src/config/production-startup.js";

describe("shared production startup lock", () => {
  it("allows local development and test execution", () => {
    expect(() => assertProductionStartupAllowed({ environment: "development" })).not.toThrow();
    expect(() => assertProductionStartupAllowed({ environment: "test" })).not.toThrow();
  });

  it("blocks every persistent process configured for production", () => {
    expect(() => assertProductionStartupAllowed({ environment: "production" }))
      .toThrow(productionStartupBlockedMessage);
  });
});
