import { randomBytes, randomInt } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuntimeConfig } from "../config/runtime.js";
import type { DomainPolicy, UserRecord } from "../core/types.js";
import type { ApplicationStores, ImageJobStore, SessionStore } from "../ports.js";
import type { RedirectDecisionEngine } from "../modules/redirect/classification.js";
import { PassThroughDecisionEngine } from "../modules/redirect/classification.js";
import { CurrentDecisionCore } from "../modules/redirect/current-decision.js";
import { CurrentRedirectDecisionEngine } from "../modules/redirect/current-engine.js";
import { InMemoryApplicationStore, InMemorySessionStore } from "../testing/in-memory-store.js";
import { createPhpCompatiblePasswordHash } from "../modules/auth/passwords.js";
import { BullMqImageExecutor } from "../modules/uploads/bullmq-executor.js";
import { SharpConcurrencyOneExecutor, type ImageExecutor } from "../modules/uploads/image-executor.js";
import { MysqlApplicationStore } from "./mysql-store.js";
import { MysqlControlPlaneStore } from "./mysql-control-plane-store.js";
import { MysqlAdminReportStore } from "./mysql-admin-report-store.js";
import { MysqlImageJobStore } from "./mysql-image-job-store.js";
import {
  MysqlRuntimeReadinessStore,
  runtimeSchemaContractId,
} from "./mysql-runtime-readiness-store.js";
import { RedisSessionStore } from "./redis-session-store.js";
import { RedisCacheClaimStore } from "./redis-store.js";
import { MysqlRedisCurrentDecisionProvider, type DecisionSqlExecutor } from "./current-decision-provider.js";
import { MysqlCachedCountryResolver } from "./country-resolver.js";
import { loadDatacenterRanges } from "./datacenter-ranges.js";
import {
  PrivateFileDeliveredCountryGapSink,
  RedisDeliveredCountryObserver,
} from "../modules/reporting/observer.js";
import {
  CachedRuntimeReadinessProbe,
  createDeterministicReadinessProbe,
  requiredDirectoriesReady,
  type RuntimeReadinessProbe,
} from "./runtime-readiness.js";

export interface RuntimeResources {
  readonly stores: ApplicationStores;
  readonly sessions: SessionStore;
  readonly imageExecutor: ImageExecutor;
  readonly imageJobs: ImageJobStore;
  readonly decisions: RedirectDecisionEngine;
  readonly readiness: RuntimeReadinessProbe;
  close(): Promise<void>;
}

export async function createRuntimeResources(config: RuntimeConfig): Promise<RuntimeResources> {
  await Promise.all([
    mkdir(config.image.privateTempDir, { recursive: true }),
    mkdir(config.image.publicUploadDir, { recursive: true }),
  ]);
  await verifyAtomicPublication(config.image.privateTempDir, config.image.publicUploadDir);

  const closers: Array<() => Promise<void>> = [];
  let stores: ApplicationStores;
  let sessions: SessionStore;
  let imageJobs: ImageJobStore;
  let mysqlStore: MysqlApplicationStore | null = null;
  let mysqlReadinessStore: MysqlRuntimeReadinessStore | null = null;
  let redisStore: RedisCacheClaimStore | null = null;

  if (config.storageDriver === "memory") {
    const memory = new InMemoryApplicationStore(domainPolicies(config));
    await seedDevelopmentUser(memory, config);
    stores = memory;
    sessions = new InMemorySessionStore();
    imageJobs = memory;
  } else {
    const mysql = new MysqlApplicationStore(config.mysql);
    const redis = new RedisCacheClaimStore({
      url: config.redis.url,
      connectTimeoutMs: config.redis.connectTimeoutMs,
      commandTimeoutMs: config.redis.commandTimeoutMs,
    });
    const deliveredCountryObserver = new RedisDeliveredCountryObserver({
      client: redis.client,
      keyPrefix: config.redis.keyPrefix,
      enabledDomainIds: config.reporting.deliveredCountryDomainIds,
      gapSink: new PrivateFileDeliveredCountryGapSink(
        resolve(config.image.privateTempDir, "delivered-country-gaps"),
      ),
    });
    const mysqlImageJobs = new MysqlImageJobStore(mysql.pool);
    stores = {
      domains: mysql,
      links: mysql,
      dashboard: mysql,
      accounting: mysql,
      auth: mysql,
      admin: new MysqlControlPlaneStore(mysql.pool),
      adminReports: new MysqlAdminReportStore(mysql.pool),
      uploads: mysql,
      imageJobs: mysqlImageJobs,
      cache: redis,
      claims: redis,
      deliveredCountryObserver,
      deliveredCountryReports: mysql,
    };
    sessions = new RedisSessionStore(redis.client, config.redis.keyPrefix);
    imageJobs = mysqlImageJobs;
    mysqlStore = mysql;
    mysqlReadinessStore = new MysqlRuntimeReadinessStore(mysql.pool);
    redisStore = redis;
    closers.push(() => redis.close(), () => mysql.close());
  }

  const imageExecutor = config.image.executor === "bullmq"
    ? new BullMqImageExecutor({
        redisUrl: config.redis.url,
        prefix: `${config.redis.keyPrefix}:bull`,
        timeoutMs: config.image.jobTimeoutMs,
        connectTimeoutMs: config.redis.connectTimeoutMs,
        commandTimeoutMs: config.redis.commandTimeoutMs,
        privateTempDir: config.image.privateTempDir,
        publicUploadDir: config.image.publicUploadDir,
        workerHeartbeatIdentity: requiredWorkerHeartbeatIdentity(),
      })
    : new SharpConcurrencyOneExecutor();
  if (imageExecutor instanceof BullMqImageExecutor) {
    closers.unshift(() => imageExecutor.close());
  }

  let decisions: RedirectDecisionEngine = new PassThroughDecisionEngine();
  try {
    if (config.redirectEngine === "current") {
      if (mysqlStore === null || redisStore === null) {
        throw new Error("The exact-current redirect engine requires MariaDB and Redis resources.");
      }
      const ranges = await loadDatacenterRanges(config.datacenterRangesFile);
      const sql = mysqlStore.pool as unknown as DecisionSqlExecutor;
      const countryResolver = new MysqlCachedCountryResolver({
        sql,
        ipHashSecret: config.ipHashSecret,
        clock: { now: () => new Date() },
      });
      const provider = new MysqlRedisCurrentDecisionProvider({
        sql,
        cache: redisStore,
        replayRedis: redisStore.client,
        appNamespace: config.appNamespace,
        ipHashSecret: config.ipHashSecret,
        datacenterIpv4: ranges,
        resolveCountry: (clientIp) => countryResolver.resolve(clientIp),
      });
      decisions = new CurrentRedirectDecisionEngine(new CurrentDecisionCore({
        provider,
        clock: { now: () => new Date() },
        roll: () => randomInt(1, 101),
        // Current PHP uses IP_HASH_SALT for this one-hour decision cookie.
        // Keep the exact same secret so Node cutover and PHP rollback accept
        // each other's existing browser cookies.
        cookieSecret: config.ipHashSecret,
      }), config.registry);
    }
  } catch (error) {
    await closeAll(closers);
    throw error;
  }

  const readiness = config.storageDriver === "memory"
    ? createDeterministicReadinessProbe(true)
    : new CachedRuntimeReadinessProbe({
        database: async () => {
          if (mysqlReadinessStore === null) return false;
          const snapshot = await mysqlReadinessStore.load(1_000);
          return snapshot.schemaContractId === runtimeSchemaContractId
            && configuredDomainPoliciesReady(snapshot.domains, config);
        },
        redis: async () => {
          if (redisStore === null) return false;
          await redisStore.connect();
          return await redisStore.client.ping() === "PONG";
        },
        directories: () => requiredDirectoriesReady([
          config.image.privateTempDir,
          config.image.publicUploadDir,
        ]),
        imageWorker: () => imageExecutor instanceof BullMqImageExecutor
          ? imageExecutor.hasRegisteredWorker()
          : Promise.resolve(false),
      }, {
        timeoutMs: Math.min(
          3_000,
          Math.max(1_500, config.redis.connectTimeoutMs + config.redis.commandTimeoutMs + 500),
        ),
        cacheTtlMs: 1_000,
      });

  return {
    stores,
    sessions,
    imageExecutor,
    imageJobs,
    decisions,
    readiness,
    close: async () => {
      await readiness.close();
      await closeAll(closers);
    },
  };
}

function requiredWorkerHeartbeatIdentity(): string {
  const value = process.env.NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256;
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("BullMQ image readiness requires the exact production activation digest.");
  }
  return value;
}

export async function configuredDomainsReady(
  store: Pick<MysqlApplicationStore, "listManageableDomains">,
  config: RuntimeConfig,
): Promise<boolean> {
  const observed = await store.listManageableDomains();
  return configuredDomainPoliciesReady(observed, config);
}

export function configuredDomainPoliciesReady(
  observed: readonly DomainPolicy[],
  config: RuntimeConfig,
): boolean {
  const expectedDomains = config.registry.all();
  if (observed.length !== expectedDomains.length
    || new Set(observed.map((domain) => domain.id)).size !== observed.length) {
    return false;
  }
  const byId = new Map(observed.map((domain) => [domain.id, domain]));
  return expectedDomains.every((expected) => {
    const actual = byId.get(expected.id);
    return actual !== undefined
      && actual.domainKey === expected.key
      && actual.hostname === expected.canonicalHost
      && actual.label === expected.label
      && actual.surface === expected.surface
      && actual.active === expected.active
      && actual.allowCreate === expected.allowCreate
      && actual.diversionCampaign === expected.diversionCampaign
      && actual.reportTimezone === expected.reportTimezone;
  });
}

async function closeAll(closers: readonly (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(closers.map(async (close) => close()));
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure): unknown => failure.reason),
      "One or more runtime resources failed to close.",
    );
  }
}

async function verifyAtomicPublication(privateTempDir: string, publicUploadDir: string): Promise<void> {
  const nonce = randomBytes(8).toString("hex");
  const source = resolve(privateTempDir, `.atomic-probe-${nonce}.part`);
  const target = resolve(publicUploadDir, `.atomic-probe-${nonce}.tmp`);
  try {
    await writeFile(source, "probe", { flag: "wx", mode: 0o600 });
    await rename(source, target);
  } finally {
    await Promise.allSettled([unlink(source), unlink(target)]);
  }
}

function domainPolicies(config: RuntimeConfig): readonly DomainPolicy[] {
  return config.registry.all().map((definition) => ({
    id: definition.id,
    domainKey: definition.key,
    hostname: definition.canonicalHost,
    label: definition.label,
    surface: definition.surface,
    active: definition.active,
    allowCreate: definition.allowCreate,
    diversionCampaign: definition.diversionCampaign,
    reportTimezone: definition.reportTimezone,
  }));
}

async function seedDevelopmentUser(store: InMemoryApplicationStore, config: RuntimeConfig): Promise<void> {
  if (config.developmentSeed.username.length === 0 || config.developmentSeed.password.length === 0) {
    return;
  }
  const selectable = config.registry.all().find((domain) => domain.active && domain.allowCreate);
  const user: UserRecord = {
    id: 1,
    username: config.developmentSeed.username,
    passwordHash: await createPhpCompatiblePasswordHash(config.developmentSeed.password),
    role: "admin",
    defaultDomainId: selectable?.id ?? null,
    createdAt: new Date(),
  };
  store.seedUser(user);
}
