import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { buildApplication } from "../src/app.js";
import { isBrowserScopedDefaultUser, loadRuntimeConfig, type RuntimeConfig } from "../src/config/runtime.js";
import type { DomainPolicy } from "../src/core/types.js";
import { InMemoryApplicationStore } from "../src/testing/in-memory-store.js";

const roots: string[] = [];
let app: FastifyInstance | undefined;

const singleDomain = [{
  id: 7,
  key: "solo",
  canonicalHost: "solo.local",
  aliases: ["www.solo.local"],
  label: "Solo",
  surface: "dashboard",
  active: true,
  allowCreate: true,
  publicBaseUrl: "https://solo.local",
  imageBaseUrl: "https://solo.local",
}] as const;

const multipleDomains = [
  {
    id: 1,
    key: "url6x",
    canonicalHost: "url6x.local",
    aliases: ["www.url6x.local"],
    label: "URL6X",
    surface: "dashboard",
    active: true,
    allowCreate: false,
    publicBaseUrl: "https://url6x.local",
    imageBaseUrl: "https://img.url6x.local",
  },
  {
    id: 2,
    key: "vidx1x",
    canonicalHost: "vidx1x.local",
    aliases: ["www.vidx1x.local"],
    label: "VIDX1X",
    surface: "redirect",
    active: true,
    allowCreate: true,
    publicBaseUrl: "https://vidx1x.local",
    imageBaseUrl: "https://vidx1x.local",
  },
] as const;

afterEach(async () => {
  await app?.close();
  app = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime configuration safety", () => {
  it("loads a single-domain configuration without inventing a second domain", async () => {
    const fixture = await domainFile(singleDomain);
    const config = await loadRuntimeConfig(testEnvironment(fixture.file), fixture.root);

    expect(config.registry.all().map((domain) => ({
      id: domain.id,
      key: domain.key,
      surface: domain.surface,
      allowCreate: domain.allowCreate,
    }))).toEqual([{ id: 7, key: "solo", surface: "dashboard", allowCreate: true }]);
    expect(config.registry.resolve("solo.local:3000")).toMatchObject({ isCanonical: true });
    expect(config.registry.resolve("www.solo.local")).toMatchObject({
      isCanonical: false,
      definition: { id: 7, canonicalHost: "solo.local" },
    });
    expect(config).toMatchObject({
      storageDriver: "memory",
      redirectEngine: "passthrough",
      trustProxy: false,
      links: { codeLength: 6, maxBulkLinks: 100, maxBulkImages: 100 },
      reporting: { deliveredCountryDomainIds: [] },
      image: {
        executor: "inline",
        maxUploadBytes: 8 * 1024 * 1024,
        readyPerSession: 100,
        readyTotal: 1_000,
        ownershipTtlSeconds: 86_400,
      },
      pilotDiagnostics: { enabled: false, expectedTokenSha256: "" },
      analytics: { enabled: false, measurementId: "", siteKey: "" },
    });
  });

  it("enables dashboard analytics only with a validated measurement-ID/site-key pair", async () => {
    const fixture = await domainFile(singleDomain);
    const config = await loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      ANALYTICS_MEASUREMENT_ID: "G-ABC123",
      ANALYTICS_SITE_KEY: "shortener_pilot",
    }, fixture.root);

    expect(config.analytics).toEqual({
      enabled: true,
      measurementId: "G-ABC123",
      siteKey: "shortener_pilot",
    });
    await expect(loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      ANALYTICS_MEASUREMENT_ID: "G-ABC123",
    }, fixture.root)).rejects.toThrow("must be configured together");
    await expect(loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      ANALYTICS_MEASUREMENT_ID: "UA-legacy",
      ANALYTICS_SITE_KEY: "shortener_pilot",
    }, fixture.root)).rejects.toThrow();
  });

  it("loads explicit link/upload limits and rejects an impossible ownership capacity", async () => {
    const fixture = await domainFile(singleDomain);
    const config = await loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      CODE_LENGTH: "9",
      MAX_BULK_LINKS: "17",
      MAX_BULK_IMAGES: "19",
      MAX_UPLOAD_BYTES: "9437184",
      MAX_READY_UPLOADS_PER_SESSION: "23",
      MAX_READY_UPLOADS_TOTAL: "29",
      UPLOAD_OWNERSHIP_TTL_SECONDS: "7200",
    }, fixture.root);

    expect(config).toMatchObject({
      links: { codeLength: 9, maxBulkLinks: 17, maxBulkImages: 19 },
      image: {
        maxUploadBytes: 9 * 1024 * 1024,
        readyPerSession: 23,
        readyTotal: 29,
        ownershipTtlSeconds: 7_200,
      },
    });
    await expect(loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      MAX_READY_UPLOADS_PER_SESSION: "30",
      MAX_READY_UPLOADS_TOTAL: "29",
    }, fixture.root)).rejects.toThrow("cannot exceed");
  });

  it("loads a multi-domain configuration while preserving each domain's surface and creation policy", async () => {
    const fixture = await domainFile(multipleDomains);
    const config = await loadRuntimeConfig(testEnvironment(fixture.file), fixture.root);

    expect(config.registry.all().map((domain) => ({
      id: domain.id,
      key: domain.key,
      host: domain.canonicalHost,
      surface: domain.surface,
      allowCreate: domain.allowCreate,
    }))).toEqual([
      { id: 1, key: "url6x", host: "url6x.local", surface: "dashboard", allowCreate: false },
      { id: 2, key: "vidx1x", host: "vidx1x.local", surface: "redirect", allowCreate: true },
    ]);
    expect(config.registry.resolve("url6x.local").definition.id).toBe(1);
    expect(config.registry.resolve("vidx1x.local").definition.id).toBe(2);
  });

  it("enables Delivered observation only through explicit active redirect-domain configuration", async () => {
    const fixture = await domainFile(multipleDomains);
    const config = await loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      DELIVERED_COUNTRY_DOMAIN_IDS: "2",
    }, fixture.root);
    expect(config.reporting.deliveredCountryDomainIds).toEqual([2]);

    await expect(loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      DELIVERED_COUNTRY_DOMAIN_IDS: "1",
    }, fixture.root)).rejects.toThrow(/active redirect domains/);
    await expect(loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      DELIVERED_COUNTRY_DOMAIN_IDS: "2,2",
    }, fixture.root)).rejects.toThrow(/duplicate/);
    await expect(loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      DELIVERED_COUNTRY_DOMAIN_IDS: "3",
    }, fixture.root)).rejects.toThrow(/active redirect domains/);
  });

  it("normalizes the current PHP trailing-colon prefix without creating double separators", async () => {
    const fixture = await domainFile(multipleDomains);
    const config = await loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      APP_NAMESPACE: "current-prefix::",
    }, fixture.root);

    expect(config.appNamespace).toBe("current-prefix");
    await expect(loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      APP_NAMESPACE: ":",
    }, fixture.root)).rejects.toThrow("APP_NAMESPACE must contain a non-separator character.");
  });

  it("loads exact browser-scoped default-domain identities from private deployment policy", async () => {
    const fixture = await domainFile(multipleDomains);
    const config = await loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      BROWSER_SCOPED_DEFAULT_USERS: "8:hdvideos:user,21:shared_writer:user",
    }, fixture.root);

    expect(config.browserScopedDefaultUsers).toEqual([
      { id: 8, username: "hdvideos", role: "user" },
      { id: 21, username: "shared_writer", role: "user" },
    ]);
    await expect(loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      BROWSER_SCOPED_DEFAULT_USERS: "8:hdvideos:admin",
    }, fixture.root)).rejects.toThrow();
    await expect(loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      BROWSER_SCOPED_DEFAULT_USER_IDS: "8",
    }, fixture.root)).rejects.toThrow("is unsafe");
    expect(isBrowserScopedDefaultUser(
      { id: 8, username: "hdvideos", role: "user" },
      config.browserScopedDefaultUsers,
    )).toBe(true);
    expect(isBrowserScopedDefaultUser(
      { id: 8, username: "renamed", role: "user" },
      config.browserScopedDefaultUsers,
    )).toBe(false);
    expect(isBrowserScopedDefaultUser(
      { id: 8, username: "hdvideos", role: "admin" },
      config.browserScopedDefaultUsers,
    )).toBe(false);
  });

  it("accepts the complete guarded production configuration used as the rejection-test control", async () => {
    const fixture = await domainFile(multipleDomains);
    const config = await loadRuntimeConfig(productionEnvironment(fixture.file), fixture.root);

    expect(config).toMatchObject({
      environment: "production",
      storageDriver: "mysql",
      redirectEngine: "current",
      trustProxy: "127.0.0.1",
      proxyChainVerified: true,
      image: { executor: "bullmq" },
      operations: {
        pm2ProcessPrefix: "shortener",
        webInstances: 1,
        webMaxMemoryMb: 384,
        imageWorkerMaxMemoryMb: 512,
        imageRecoveryPreflightTimeoutMs: 5_000,
      },
    });
  });

  it("keeps the production datacenter source inside the artifact-bound data directory", async () => {
    const fixture = await domainFile(multipleDomains);
    await expect(loadRuntimeConfig({
      ...productionEnvironment(fixture.file),
      DATACENTER_RANGES_FILE: "../outside-datacenter-ranges.json",
    }, fixture.root)).rejects.toThrow("must stay under the artifact-bound data directory");
  });

  const rejectedProductionModes: readonly [
    label: string,
    overrides: Readonly<Record<string, string>>,
    message: string,
  ][] = [
    [
      "a publicly exposed Node listener",
      { HOST: "0.0.0.0" },
      "Production Node must bind only to 127.0.0.1 behind the verified Cloudways proxy.",
    ],
    [
      "a public-IP Node listener",
      { HOST: "203.0.113.10" },
      "Production Node must bind only to 127.0.0.1 behind the verified Cloudways proxy.",
    ],
    [
      "an IPv6-wildcard Node listener",
      { HOST: "::" },
      "Production Node must bind only to 127.0.0.1 behind the verified Cloudways proxy.",
    ],
    [
      "passthrough redirect behavior",
      { REDIRECT_ENGINE: "passthrough" },
      "Production requires the exact-current redirect engine.",
    ],
    [
      "in-memory storage",
      { STORAGE_DRIVER: "memory" },
      "Production requires STORAGE_DRIVER=mysql.",
    ],
    [
      "inline image execution",
      { IMAGE_EXECUTOR: "inline" },
      "Production requires IMAGE_EXECUTOR=bullmq so Sharp cannot block a web process.",
    ],
    [
      "an unverified proxy flag",
      { PROXY_CHAIN_VERIFIED: "false" },
      "Production requires a verified loopback proxy chain.",
    ],
    [
      "a disabled loopback trust boundary",
      { TRUST_PROXY: "false" },
      "Production requires a verified loopback proxy chain.",
    ],
    [
      "a weak IP-hash secret",
      { IP_HASH_SECRET: "too-short" },
      "Production secrets must contain at least 32 characters",
    ],
    [
      "a weak cookie-signing secret",
      { COOKIE_SIGNING_SECRET: "too-short" },
      "Production secrets must contain at least 32 characters",
    ],
    [
      "the public local IP-hash default",
      { IP_HASH_SECRET: "local-only-ip-hash-secret-change-me" },
      "must not use defaults or placeholders",
    ],
    [
      "the public local cookie default",
      { COOKIE_SIGNING_SECRET: "local-only-cookie-secret-change-me" },
      "must not use defaults or placeholders",
    ],
    [
      "an unrendered secret placeholder",
      { IP_HASH_SECRET: "__PRIVATE_32_PLUS_CHARACTER_IP_HASH_SECRET__" },
      "must not use defaults or placeholders",
    ],
  ];

  it.each(rejectedProductionModes)("rejects %s in production", async (_label, overrides, message) => {
    const fixture = await domainFile(multipleDomains);
    const environment = { ...productionEnvironment(fixture.file), ...overrides };

    await expect(loadRuntimeConfig(environment, fixture.root)).rejects.toThrow(message);
  });

  it("rejects omitted production secrets instead of accepting public local defaults", async () => {
    const fixture = await domainFile(multipleDomains);
    const environment = productionEnvironment(fixture.file);
    delete environment.IP_HASH_SECRET;
    delete environment.COOKIE_SIGNING_SECRET;

    await expect(loadRuntimeConfig(environment, fixture.root))
      .rejects.toThrow("must not use defaults or placeholders");
  });

  it("rejects an enabled pilot diagnostic without an exact SHA-256 token digest", async () => {
    const fixture = await domainFile(multipleDomains);
    const environment = {
      ...testEnvironment(fixture.file),
      PILOT_HEADER_DIAGNOSTICS: "true",
      PILOT_DIAGNOSTIC_TOKEN_SHA256: "not-a-sha256-digest",
    };

    await expect(loadRuntimeConfig(environment, fixture.root))
      .rejects.toThrow("Pilot header diagnostics require an exact SHA-256 token value.");
  });

  it("rejects Cloudflare identity trust until origin auth and the loopback chain are both verified", async () => {
    const fixture = await domainFile(multipleDomains);
    const unsafe = {
      ...testEnvironment(fixture.file),
      TRUST_CLOUDFLARE_HEADERS: "true",
    };

    await expect(loadRuntimeConfig(unsafe, fixture.root)).rejects.toThrow(
      "Cloudflare identity headers require origin authentication, a verified loopback proxy, and proven header sanitation.",
    );
    await expect(loadRuntimeConfig({
      ...unsafe,
      ORIGIN_AUTH_ENABLED: "true",
      ORIGIN_AUTH_SHA256: "a".repeat(64),
      PROXY_CHAIN_VERIFIED: "true",
      TRUST_PROXY: "loopback",
    }, fixture.root)).rejects.toThrow(/proven header sanitation/);
    await expect(loadRuntimeConfig({
      ...unsafe,
      ORIGIN_AUTH_ENABLED: "true",
      ORIGIN_AUTH_SHA256: "a".repeat(64),
      PROXY_CHAIN_VERIFIED: "true",
      TRUST_PROXY: "loopback",
      CLOUDFLARE_HEADER_SANITIZATION_VERIFIED: "true",
    }, fixture.root)).resolves.toMatchObject({
      trustCloudflareHeaders: true,
      cloudflareHeaderSanitizationVerified: true,
      proxyChainVerified: true,
      trustProxy: "127.0.0.1",
    });
  });
});

describe("pilot header diagnostic safety", () => {
  it("does not register the diagnostic endpoint when the setting is omitted", async () => {
    const fixture = await domainFile(multipleDomains);
    const config = await loadRuntimeConfig(testEnvironment(fixture.file), fixture.root);
    app = await application(config);

    const response = await app.inject({
      method: "GET",
      url: "/__pilot/headers",
      headers: {
        host: "url6x.local",
        "x-pilot-diagnostic-token": "a-token-cannot-enable-a-disabled-route",
      },
    });

    expect(config.pilotDiagnostics).toEqual({ enabled: false, expectedTokenSha256: "" });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("Not found.\n");
  });

  it("hides an enabled diagnostic behind its token and returns only the explicit header allowlist", async () => {
    const fixture = await domainFile(multipleDomains);
    const diagnosticToken = "synthetic-pilot-diagnostic-token";
    const config = await loadRuntimeConfig({
      ...testEnvironment(fixture.file),
      PILOT_HEADER_DIAGNOSTICS: "true",
      PILOT_DIAGNOSTIC_TOKEN_SHA256: sha256(diagnosticToken),
    }, fixture.root);
    app = await application(config);

    const missingToken = await app.inject({
      method: "GET",
      url: "/__pilot/headers",
      headers: { host: "url6x.local" },
    });
    const wrongToken = await app.inject({
      method: "GET",
      url: "/__pilot/headers",
      headers: { host: "url6x.local", "x-pilot-diagnostic-token": "wrong-token" },
    });
    for (const rejected of [missingToken, wrongToken]) {
      expect(rejected.statusCode).toBe(404);
      expect(rejected.body).toBe("Not found.\n");
      expect(rejected.headers["cache-control"]).toBe("no-store, private, max-age=0");
      expect(rejected.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    }

    const sensitiveValues = {
      origin: "synthetic-origin-auth-value",
      cookie: "node_shortener_session=synthetic-cookie-value",
      authorization: "Bearer synthetic-authorization-value",
    };
    const accepted = await app.inject({
      method: "GET",
      url: "/__pilot/headers",
      headers: {
        host: "url6x.local",
        "x-pilot-diagnostic-token": diagnosticToken,
        "x-shortener-origin-auth": sensitiveValues.origin,
        cookie: sensitiveValues.cookie,
        authorization: sensitiveValues.authorization,
        forwarded: "for=198.51.100.10;proto=https",
        "x-forwarded-host": "client-supplied.example",
        "x-forwarded-for": "198.51.100.10",
        "x-real-ip": "198.51.100.10",
        "x-forwarded-proto": "https",
        "cf-connecting-ip": "198.51.100.10",
        "cf-ipcountry": "IN",
        "geoip-country-code": "IN",
        "x-geoip-country-code": "IN",
        "x-geoip-country": "India",
        "x-forwarded-country": "IN",
      },
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers["cache-control"]).toBe("no-store, private, max-age=0");
    expect(accepted.headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
    const body = accepted.json<{
      ok: boolean;
      domain_id: number;
      canonical_host: string;
      headers: Record<string, string | readonly string[] | null>;
    }>();
    expect(body).toMatchObject({
      ok: true,
      domain_id: 1,
      canonical_host: "url6x.local",
      headers: {
        host: "url6x.local",
        forwarded: "for=198.51.100.10;proto=https",
        "x-forwarded-host": "client-supplied.example",
        "x-forwarded-for": "198.51.100.10",
        "x-real-ip": "198.51.100.10",
        "x-forwarded-proto": "https",
        "cf-connecting-ip": "198.51.100.10",
        "cf-ipcountry": "IN",
        "geoip-country-code": "IN",
        "x-geoip-country-code": "IN",
        "x-geoip-country": "India",
        "x-forwarded-country": "IN",
      },
    });
    expect(Object.keys(body.headers).sort()).toEqual([
      "cf-connecting-ip",
      "cf-ipcountry",
      "forwarded",
      "geoip-country-code",
      "host",
      "x-forwarded-country",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-geoip-country",
      "x-geoip-country-code",
      "x-real-ip",
    ]);
    expect(body.headers).not.toHaveProperty("x-shortener-origin-auth");
    expect(body.headers).not.toHaveProperty("cookie");
    expect(body.headers).not.toHaveProperty("authorization");
    expect(body.headers).not.toHaveProperty("x-pilot-diagnostic-token");
    for (const sensitive of [...Object.values(sensitiveValues), diagnosticToken]) {
      expect(accepted.body).not.toContain(sensitive);
    }
  });
});

interface DomainFileFixture {
  readonly root: string;
  readonly file: string;
}

async function domainFile(definitions: readonly unknown[]): Promise<DomainFileFixture> {
  const root = await mkdtemp(join(tmpdir(), "node-shortener-runtime-safety-"));
  roots.push(root);
  const file = "domains.json";
  await writeFile(join(root, file), JSON.stringify(definitions), { encoding: "utf8", mode: 0o600 });
  return { root, file };
}

function testEnvironment(domainConfigFile: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    DOMAIN_CONFIG_FILE: domainConfigFile,
  };
}

function productionEnvironment(domainConfigFile: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    DOMAIN_CONFIG_FILE: domainConfigFile,
    ORIGIN_AUTH_ENABLED: "true",
    ORIGIN_AUTH_SHA256: "a".repeat(64),
    IP_HASH_SECRET: "i".repeat(32),
    COOKIE_SIGNING_SECRET: "c".repeat(32),
    STORAGE_DRIVER: "mysql",
    MYSQL_PASSWORD: "synthetic-database-password",
    IMAGE_EXECUTOR: "bullmq",
    PROXY_CHAIN_VERIFIED: "true",
    TRUST_PROXY: "loopback",
    REDIRECT_ENGINE: "current",
  };
}

async function application(config: RuntimeConfig): Promise<FastifyInstance> {
  const policies: DomainPolicy[] = config.registry.all().map((domain) => ({
    id: domain.id,
    domainKey: domain.key,
    hostname: domain.canonicalHost,
    label: domain.label,
    surface: domain.surface,
    active: domain.active,
    allowCreate: domain.allowCreate,
    diversionCampaign: domain.diversionCampaign,
    reportTimezone: domain.reportTimezone,
  }));
  return buildApplication({
    config,
    stores: new InMemoryApplicationStore(policies),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
