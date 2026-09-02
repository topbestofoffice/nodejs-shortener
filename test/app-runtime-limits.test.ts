import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApplication } from "../src/app.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";
import { domainPolicies, testConfig } from "./fixtures.js";

describe("application request limits", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("derives the Fastify body limit from MAX_UPLOAD_BYTES plus bounded multipart overhead", async () => {
    const maxUploadBytes = 17 * 1024 * 1024;
    app = await buildApplication({
      config: {
        ...testConfig,
        image: { ...testConfig.image, maxUploadBytes },
      },
      stores: new InMemoryApplicationStore(domainPolicies),
    });

    expect(app.initialConfig.bodyLimit).toBe(maxUploadBytes + 4 * 1024 * 1024);
  });

  it("marks unexpected 500 responses as private and non-cacheable", async () => {
    const store = new InMemoryApplicationStore(domainPolicies);
    vi.spyOn(store, "findLink").mockRejectedValue(new Error("forced test failure"));
    app = await buildApplication({
      config: testConfig,
      stores: store,
    });

    const response = await app.inject({ method: "GET", url: "/Boom001", headers: { host: "vidx1x.local" } });
    expect(response.statusCode).toBe(500);
    expect(response.headers["cache-control"]).toBe("no-store, private, max-age=0");
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
  });
});
