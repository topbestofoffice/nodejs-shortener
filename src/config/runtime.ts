import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";
import { DomainRegistry } from "./domain-registry.js";
import type { UserRecord } from "../core/types.js";

const booleanFromString = z.string().transform((value, context) => {
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0" || value === "") {
    return false;
  }
  context.addIssue({ code: "custom", message: "Expected true/false" });
  return z.NEVER;
});

const localIpHashSecret = "local-only-ip-hash-secret-change-me";
const localCookieSigningSecret = "local-only-cookie-secret-change-me";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_NAMESPACE: z.string().regex(/^[a-z0-9:_-]{1,64}$/).default("node-shortener-local"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"]).default("info"),
  DOMAIN_CONFIG_FILE: z.string().default("./config/domains.local.json"),
  TRUST_PROXY: z.string().default("false"),
  TRUST_CLOUDFLARE_HEADERS: booleanFromString.default(false),
  CLOUDFLARE_HEADER_SANITIZATION_VERIFIED: booleanFromString.default(false),
  ORIGIN_AUTH_ENABLED: booleanFromString.default(false),
  ORIGIN_AUTH_HEADER: z.string().regex(/^[a-z0-9-]+$/).default("x-shortener-origin-auth"),
  ORIGIN_AUTH_SHA256: z.string().default(""),
  IP_HASH_SECRET: z.string().default(localIpHashSecret),
  COOKIE_SIGNING_SECRET: z.string().default(localCookieSigningSecret),
  PROXY_CHAIN_VERIFIED: booleanFromString.default(false),
  STORAGE_DRIVER: z.enum(["memory", "mysql"]).default("memory"),
  MYSQL_HOST: z.string().default("127.0.0.1"),
  MYSQL_PORT: z.coerce.number().int().min(1).max(65_535).default(3306),
  MYSQL_DATABASE: z.string().default("shortener"),
  MYSQL_USER: z.string().default("shortener"),
  MYSQL_PASSWORD: z.string().default(""),
  MYSQL_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(64).default(4),
  MYSQL_QUEUE_LIMIT: z.coerce.number().int().min(1).max(10_000).default(64),
  REDIS_URL: z.url().default("redis://127.0.0.1:6379"),
  REDIS_KEY_PREFIX: z.string().regex(/^[a-zA-Z0-9:_-]{1,128}$/).default("node-shortener-local"),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(500),
  REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(50).max(5_000).default(200),
  DELIVERED_COUNTRY_DOMAIN_IDS: z.string().regex(
    /^(?:|[1-9][0-9]{0,4}(?:,[1-9][0-9]{0,4})*)$/,
  ).default(""),
  SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(31_536_000).default(2_592_000),
  PM2_PROCESS_PREFIX: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/).default("shortener"),
  WEB_INSTANCES: z.coerce.number().int().min(1).max(4).default(1),
  WEB_MAX_MEMORY_MB: z.coerce.number().int().min(384).max(4_096).default(384),
  IMAGE_WORKER_MAX_MEMORY_MB: z.coerce.number().int().min(512).max(4_096).default(512),
  IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
  CODE_LENGTH: z.coerce.number().int().min(4).max(32).default(6),
  MAX_BULK_LINKS: z.coerce.number().int().min(1).max(500).default(100),
  MAX_BULK_IMAGES: z.coerce.number().int().min(1).max(500).default(100),
  BROWSER_SCOPED_DEFAULT_USERS: z.string().regex(
    /^(?:|[1-9][0-9]*:[A-Za-z0-9_.-]{3,64}:user(?:,[1-9][0-9]*:[A-Za-z0-9_.-]{3,64}:user)*)$/,
  ).default(""),
  BROWSER_SCOPED_DEFAULT_USER_IDS: z.string().default(""),
  IMAGE_EXECUTOR: z.enum(["inline", "bullmq"]).default("inline"),
  PRIVATE_TEMP_DIR: z.string().default("./private/tmp"),
  PUBLIC_UPLOAD_DIR: z.string().default("./public/uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1_024).max(100 * 1_024 * 1_024).default(8 * 1_024 * 1_024),
  MAX_IMAGE_PIXELS: z.coerce.number().int().min(1_000_000).max(100_000_000).default(20_000_000),
  MAX_READY_UPLOADS_PER_SESSION: z.coerce.number().int().min(1).max(10_000).default(100),
  MAX_READY_UPLOADS_TOTAL: z.coerce.number().int().min(1).max(1_000_000).default(1_000),
  UPLOAD_OWNERSHIP_TTL_SECONDS: z.coerce.number().int().min(3_600).max(31_536_000).default(86_400),
  IMAGE_JOB_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
  SERVE_STATIC_UPLOADS: booleanFromString.default(false),
  DEV_SEED_USERNAME: z.string().trim().max(64).default(""),
  DEV_SEED_PASSWORD: z.string().max(256).default(""),
  REDIRECT_ENGINE: z.enum(["passthrough", "current"]).default("passthrough"),
  DATACENTER_RANGES_FILE: z.string().default("./data/datacenter-ranges.json"),
  PILOT_HEADER_DIAGNOSTICS: booleanFromString.default(false),
  PILOT_DIAGNOSTIC_TOKEN_SHA256: z.string().default(""),
  ANALYTICS_MEASUREMENT_ID: z.string().regex(/^(?:|G-[A-Z0-9]+)$/).default(""),
  ANALYTICS_SITE_KEY: z.string().regex(/^(?:|[a-z0-9_-]{1,32})$/).default(""),
});

export interface RuntimeConfig {
  readonly environment: "development" | "test" | "production";
  readonly appNamespace: string;
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly registry: DomainRegistry;
  readonly trustProxy: false | "127.0.0.1";
  readonly trustCloudflareHeaders: boolean;
  readonly cloudflareHeaderSanitizationVerified: boolean;
  readonly originAuth: {
    readonly enabled: boolean;
    readonly header: string;
    readonly expectedSha256: string;
  };
  readonly ipHashSecret: string;
  readonly cookieSigningSecret: string;
  readonly proxyChainVerified: boolean;
  readonly storageDriver: "memory" | "mysql";
  readonly mysql: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly connectionLimit: number;
    readonly queueLimit: number;
  };
  readonly redis: {
    readonly url: string;
    readonly keyPrefix: string;
    readonly connectTimeoutMs: number;
    readonly commandTimeoutMs: number;
  };
  readonly sessionTtlSeconds: number;
  readonly reporting: {
    /** Empty until the exact domain's singleton private publisher is proven. */
    readonly deliveredCountryDomainIds: readonly number[];
  };
  readonly operations: {
    readonly pm2ProcessPrefix: string;
    readonly webInstances: number;
    readonly webMaxMemoryMb: number;
    readonly imageWorkerMaxMemoryMb: number;
    readonly imageRecoveryPreflightTimeoutMs: number;
  };
  readonly links: {
    readonly codeLength: number;
    readonly maxBulkLinks: number;
    readonly maxBulkImages: number;
  };
  readonly browserScopedDefaultUsers: readonly BrowserScopedDefaultUserIdentity[];
  readonly image: {
    readonly executor: "inline" | "bullmq";
    readonly privateTempDir: string;
    readonly publicUploadDir: string;
    readonly maxUploadBytes: number;
    readonly maxImagePixels: number;
    readonly readyPerSession: number;
    readonly readyTotal: number;
    readonly ownershipTtlSeconds: number;
    readonly jobTimeoutMs: number;
    readonly serveStaticUploads: boolean;
  };
  readonly developmentSeed: {
    readonly username: string;
    readonly password: string;
  };
  readonly redirectEngine: "passthrough" | "current";
  readonly datacenterRangesFile: string;
  readonly pilotDiagnostics: {
    readonly enabled: boolean;
    readonly expectedTokenSha256: string;
  };
  readonly analytics: {
    readonly enabled: boolean;
    readonly measurementId: string;
    readonly siteKey: string;
  };
}

export interface BrowserScopedDefaultUserIdentity {
  readonly id: number;
  readonly username: string;
  readonly role: "user";
}

export async function loadRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Promise<RuntimeConfig> {
  const parsed = environmentSchema.parse(environment);
  const rawDomains = JSON.parse(await readFile(resolve(cwd, parsed.DOMAIN_CONFIG_FILE), "utf8")) as unknown;
  const trustProxy = parseTrustProxy(parsed.TRUST_PROXY);
  const registry = new DomainRegistry(rawDomains);
  const appNamespace = parsed.APP_NAMESPACE.replace(/:+$/, "");
  const datacenterRangesFile = resolve(cwd, parsed.DATACENTER_RANGES_FILE);
  if (appNamespace.length === 0) {
    throw new Error("APP_NAMESPACE must contain a non-separator character.");
  }

  if (parsed.TRUST_CLOUDFLARE_HEADERS
    && (!parsed.ORIGIN_AUTH_ENABLED || !parsed.PROXY_CHAIN_VERIFIED
      || !parsed.CLOUDFLARE_HEADER_SANITIZATION_VERIFIED || trustProxy !== "127.0.0.1")) {
    throw new Error(
      "Cloudflare identity headers require origin authentication, a verified loopback proxy, and proven header sanitation.",
    );
  }

  if (parsed.NODE_ENV === "production") {
    if (parsed.HOST !== "127.0.0.1") {
      throw new Error("Production Node must bind only to 127.0.0.1 behind the verified Cloudways proxy.");
    }
    if (!parsed.ORIGIN_AUTH_ENABLED || !/^[a-f0-9]{64}$/.test(parsed.ORIGIN_AUTH_SHA256)) {
      throw new Error("Production requires origin authentication with an exact SHA-256 value.");
    }
    if (!isProductionSecret(parsed.IP_HASH_SECRET, localIpHashSecret)
      || !isProductionSecret(parsed.COOKIE_SIGNING_SECRET, localCookieSigningSecret)) {
      throw new Error("Production secrets must contain at least 32 characters and must not use defaults or placeholders.");
    }
    if (parsed.STORAGE_DRIVER !== "mysql") {
      throw new Error("Production requires STORAGE_DRIVER=mysql.");
    }
    if (parsed.IMAGE_EXECUTOR !== "bullmq") {
      throw new Error("Production requires IMAGE_EXECUTOR=bullmq so Sharp cannot block a web process.");
    }
    if (!parsed.PROXY_CHAIN_VERIFIED || trustProxy !== "127.0.0.1") {
      throw new Error("Production requires a verified loopback proxy chain.");
    }
    if (parsed.MYSQL_PASSWORD.length === 0) {
      throw new Error("Production requires MYSQL_PASSWORD.");
    }
    if (parsed.MYSQL_HOST !== "127.0.0.1") {
      throw new Error("Production MariaDB plaintext transport is allowed only on exact loopback.");
    }
    const redisUrl = new URL(parsed.REDIS_URL);
    if (redisUrl.protocol !== "redis:" || redisUrl.hostname !== "127.0.0.1") {
      throw new Error("Production Redis plaintext transport is allowed only on exact loopback.");
    }
    if (parsed.DEV_SEED_USERNAME.length > 0 || parsed.DEV_SEED_PASSWORD.length > 0) {
      throw new Error("Development seed credentials are forbidden in production.");
    }
    if (parsed.REDIRECT_ENGINE !== "current") {
      throw new Error("Production requires the exact-current redirect engine.");
    }
    if (!isStrictChild(resolve(cwd, "data"), datacenterRangesFile)) {
      throw new Error("Production DATACENTER_RANGES_FILE must stay under the artifact-bound data directory.");
    }
    for (const domain of registry.all()) {
      for (const baseUrl of [domain.publicBaseUrl, domain.imageBaseUrl]) {
        const url = new URL(baseUrl);
        if (url.protocol !== "https:" || url.port.length > 0) {
          throw new Error("Production domain and image base URLs must use standard HTTPS.");
        }
      }
    }
  }

  if ((parsed.DEV_SEED_USERNAME.length === 0) !== (parsed.DEV_SEED_PASSWORD.length === 0)) {
    throw new Error("DEV_SEED_USERNAME and DEV_SEED_PASSWORD must be supplied together.");
  }
  if (parsed.DEV_SEED_PASSWORD.length > 0 && parsed.DEV_SEED_PASSWORD.length < 8) {
    throw new Error("DEV_SEED_PASSWORD must contain at least 8 characters.");
  }
  if (parsed.PILOT_HEADER_DIAGNOSTICS && !/^[a-f0-9]{64}$/.test(parsed.PILOT_DIAGNOSTIC_TOKEN_SHA256)) {
    throw new Error("Pilot header diagnostics require an exact SHA-256 token value.");
  }
  if ((parsed.ANALYTICS_MEASUREMENT_ID === "") !== (parsed.ANALYTICS_SITE_KEY === "")) {
    throw new Error("ANALYTICS_MEASUREMENT_ID and ANALYTICS_SITE_KEY must be configured together.");
  }
  if (parsed.BROWSER_SCOPED_DEFAULT_USER_IDS !== "") {
    throw new Error("BROWSER_SCOPED_DEFAULT_USER_IDS is unsafe; configure exact BROWSER_SCOPED_DEFAULT_USERS tuples.");
  }
  if (parsed.MAX_READY_UPLOADS_PER_SESSION > parsed.MAX_READY_UPLOADS_TOTAL) {
    throw new Error("MAX_READY_UPLOADS_PER_SESSION cannot exceed MAX_READY_UPLOADS_TOTAL.");
  }
  const deliveredCountryDomainIds = parseDeliveredCountryDomainIds(
    parsed.DELIVERED_COUNTRY_DOMAIN_IDS,
    registry,
  );

  return Object.freeze({
    environment: parsed.NODE_ENV,
    // Current PHP prefixes already commonly end in ':', whereas Node key
    // builders add the separator. Normalize once to preserve exact key parity.
    appNamespace,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    registry,
    trustProxy,
    trustCloudflareHeaders: parsed.TRUST_CLOUDFLARE_HEADERS,
    cloudflareHeaderSanitizationVerified: parsed.CLOUDFLARE_HEADER_SANITIZATION_VERIFIED,
    originAuth: Object.freeze({
      enabled: parsed.ORIGIN_AUTH_ENABLED,
      header: parsed.ORIGIN_AUTH_HEADER,
      expectedSha256: parsed.ORIGIN_AUTH_SHA256,
    }),
    ipHashSecret: parsed.IP_HASH_SECRET,
    cookieSigningSecret: parsed.COOKIE_SIGNING_SECRET,
    proxyChainVerified: parsed.PROXY_CHAIN_VERIFIED,
    storageDriver: parsed.STORAGE_DRIVER,
    mysql: Object.freeze({
      host: parsed.MYSQL_HOST,
      port: parsed.MYSQL_PORT,
      database: parsed.MYSQL_DATABASE,
      user: parsed.MYSQL_USER,
      password: parsed.MYSQL_PASSWORD,
      connectionLimit: parsed.MYSQL_CONNECTION_LIMIT,
      queueLimit: parsed.MYSQL_QUEUE_LIMIT,
    }),
    redis: Object.freeze({
      url: parsed.REDIS_URL,
      keyPrefix: parsed.REDIS_KEY_PREFIX.replace(/:+$/, ""),
      connectTimeoutMs: parsed.REDIS_CONNECT_TIMEOUT_MS,
      commandTimeoutMs: parsed.REDIS_COMMAND_TIMEOUT_MS,
    }),
    sessionTtlSeconds: parsed.SESSION_TTL_SECONDS,
    reporting: Object.freeze({ deliveredCountryDomainIds }),
    operations: Object.freeze({
      pm2ProcessPrefix: parsed.PM2_PROCESS_PREFIX,
      webInstances: parsed.WEB_INSTANCES,
      webMaxMemoryMb: parsed.WEB_MAX_MEMORY_MB,
      imageWorkerMaxMemoryMb: parsed.IMAGE_WORKER_MAX_MEMORY_MB,
      imageRecoveryPreflightTimeoutMs: parsed.IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS,
    }),
    links: Object.freeze({
      codeLength: parsed.CODE_LENGTH,
      maxBulkLinks: parsed.MAX_BULK_LINKS,
      maxBulkImages: parsed.MAX_BULK_IMAGES,
    }),
    browserScopedDefaultUsers: parseBrowserScopedDefaultUsers(parsed.BROWSER_SCOPED_DEFAULT_USERS),
    image: Object.freeze({
      executor: parsed.IMAGE_EXECUTOR,
      privateTempDir: resolve(cwd, parsed.PRIVATE_TEMP_DIR),
      publicUploadDir: resolve(cwd, parsed.PUBLIC_UPLOAD_DIR),
      maxUploadBytes: parsed.MAX_UPLOAD_BYTES,
      maxImagePixels: parsed.MAX_IMAGE_PIXELS,
      readyPerSession: parsed.MAX_READY_UPLOADS_PER_SESSION,
      readyTotal: parsed.MAX_READY_UPLOADS_TOTAL,
      ownershipTtlSeconds: parsed.UPLOAD_OWNERSHIP_TTL_SECONDS,
      jobTimeoutMs: parsed.IMAGE_JOB_TIMEOUT_MS,
      serveStaticUploads: parsed.SERVE_STATIC_UPLOADS,
    }),
    developmentSeed: Object.freeze({
      username: parsed.DEV_SEED_USERNAME,
      password: parsed.DEV_SEED_PASSWORD,
    }),
    redirectEngine: parsed.REDIRECT_ENGINE,
    datacenterRangesFile,
    pilotDiagnostics: Object.freeze({
      enabled: parsed.PILOT_HEADER_DIAGNOSTICS,
      expectedTokenSha256: parsed.PILOT_DIAGNOSTIC_TOKEN_SHA256,
    }),
    analytics: Object.freeze({
      enabled: parsed.ANALYTICS_MEASUREMENT_ID !== "" && parsed.ANALYTICS_SITE_KEY !== "",
      measurementId: parsed.ANALYTICS_MEASUREMENT_ID,
      siteKey: parsed.ANALYTICS_SITE_KEY,
    }),
  });
}

function isProductionSecret(value: string, localDefault: string): boolean {
  return value.length >= 32 && value !== localDefault && !/^__[A-Z0-9_]+__$/.test(value);
}

function parseDeliveredCountryDomainIds(
  value: string,
  registry: DomainRegistry,
): readonly number[] {
  if (value === "") return Object.freeze([]);
  const parsed = value.split(",").map(Number);
  if (new Set(parsed).size !== parsed.length) {
    throw new Error("DELIVERED_COUNTRY_DOMAIN_IDS contains duplicate domain IDs.");
  }
  for (const domainId of parsed) {
    const domain = registry.byId(domainId);
    if (!Number.isSafeInteger(domainId) || domainId < 1 || domainId > 65_535
      || domain === undefined || !domain.active || domain.surface !== "redirect") {
      throw new Error(
        "DELIVERED_COUNTRY_DOMAIN_IDS must name only configured active redirect domains.",
      );
    }
  }
  return Object.freeze([...parsed].sort((left, right) => left - right));
}

export function isBrowserScopedDefaultUser(
  user: Pick<UserRecord, "id" | "username" | "role">,
  configured: readonly BrowserScopedDefaultUserIdentity[],
): boolean {
  return configured.some((candidate) => candidate.id === user.id
    && candidate.username === user.username && candidate.role === user.role);
}

function parseBrowserScopedDefaultUsers(value: string): readonly BrowserScopedDefaultUserIdentity[] {
  if (value === "") return Object.freeze([]);
  const parsed = value.split(",").map((entry) => {
    const [rawId, username] = entry.split(":");
    return Object.freeze({ id: Number(rawId), username: username ?? "", role: "user" as const });
  });
  if (new Set(parsed.map((entry) => entry.id)).size !== parsed.length
    || new Set(parsed.map((entry) => entry.username)).size !== parsed.length) {
    throw new Error("BROWSER_SCOPED_DEFAULT_USERS contains duplicate identities.");
  }
  return Object.freeze(parsed);
}

function parseTrustProxy(value: string): false | "127.0.0.1" {
  if (value === "false" || value === "0" || value === "") {
    return false;
  }
  if (value === "loopback" || value === "127.0.0.1") {
    return "127.0.0.1";
  }
  throw new Error("TRUST_PROXY must stay false or be the verified loopback proxy.");
}

function isStrictChild(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child.length > 0 && !child.startsWith("..") && !isAbsolute(child);
}
