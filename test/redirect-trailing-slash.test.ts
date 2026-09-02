import { describe, expect, it } from "vitest";
import { buildApplication } from "../src/app.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { baseLink, domainPolicies, testConfig } from "./fixtures.js";

describe("PHP-compatible trailing-slash redirects", () => {
  it("handles /code and /code/ as the same short link", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    store.seedLink(baseLink);
    const app = await buildApplication({ config: testConfig, stores: store });

    const responses = [];
    for (const url of [`/${baseLink.code}`, `/${baseLink.code}/`]) {
      const response = await app.inject({ method: "GET", url, headers: { host: baseLink.domainHostname } });
      expect(response.headers.location).toBe(baseLink.destination);
      responses.push(response);
    }
    expect(responses[1]?.statusCode).toBe(responses[0]?.statusCode);
    expect(responses[0]?.statusCode).toBeGreaterThanOrEqual(300);
    expect(responses[0]?.statusCode).toBeLessThan(400);
    await app.close();
  });
});
