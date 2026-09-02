import type {
  AccountingStore,
  ApplicationStores,
  AuthStore,
  CacheStore,
  ClaimResult,
  DeliveredCountryReportStore,
  DomainStore,
  DuplicateClaimStore,
  LinkStore,
  ImageJobCompensatedCommand,
  ImageJobReadyCommand,
  ImageJobStore,
  PublicRegistrationStore,
  SessionStore,
  UploadCapacity,
  UploadStore,
} from "../ports.js";
import { isManagedImagePath } from "../modules/uploads/managed-image-path.js";
import type { CreateRegisteredUserInput } from "../ports.js";
import { AppError } from "../core/errors.js";
import type {
  CreateLinkInput,
  DeliveredCountryWindowRows,
  DomainPolicy,
  LinkAccountingEvent,
  LinkRecord,
  RememberTokenRecord,
  RegisterUploadInput,
  SessionData,
  UserRecord,
} from "../core/types.js";
import {
  decideImageJobCreation,
  isImageJobAttachable,
  transitionImageJob as applyImageJobTransition,
  type ImageJobCommand,
  type ImageJobCreationDecision,
  type ImageJobSnapshot,
  type NewImageJob,
} from "../modules/uploads/job-ledger-policy.js";
import {
  indiaBusinessDate,
  type DashboardCommunityStats,
  type DashboardHistoryLink,
  type DashboardHistoryStore,
  type DashboardOwnStats,
} from "../modules/dashboard/history-service.js";
import {
  trafficShieldSlot,
  trafficShieldSlotForDate,
  type TrafficShieldAggregate,
  type TrafficShieldDateSlot,
} from "../modules/dashboard/shield-service.js";
import type {
  AdminControlPlaneStore,
  AdminDeleteUserResult,
  AdminDomainState,
  AdminUserSummary,
} from "../modules/admin/store.js";
import type { GeoQualityCandidate } from "../modules/admin/geo-quality-policy.js";
import type { SkimSettingsCandidate } from "../modules/admin/skim-settings-policy.js";
import type {
  AdminReportActivationValues,
  AdminReportSourceStore,
} from "../modules/reporting/admin-report-service.js";
import type { AdminCountryAggregate } from "../modules/reporting/admin-report-policy.js";

interface CacheEntry {
  readonly value: string;
  readonly expiresAt: number;
}

type UploadRecord = RegisterUploadInput & { state: 1 | 2; attachedAt: Date | null };

interface InMemoryLinkMetrics {
  countedClicks: bigint;
  divertedClicks: bigint;
  filteredMetaClicks: bigint;
  filteredBotClicks: bigint;
  filteredOtherClicks: bigint;
  todayClicks: bigint;
  todayClickDate: string | null;
  lastActivityAt: Date | null;
  recentActivityEpochs: number[] | null;
  filteredHistory: Array<{ date: string | null; count: bigint }>;
}

export class InMemoryApplicationStore
implements ApplicationStores, DomainStore, LinkStore, DashboardHistoryStore, AccountingStore, CacheStore, DuplicateClaimStore, AuthStore, PublicRegistrationStore, UploadStore, ImageJobStore, AdminControlPlaneStore, AdminReportSourceStore, DeliveredCountryReportStore {
  public readonly domains = this;
  public readonly links = this;
  public readonly dashboard = this;
  public readonly accounting = this;
  public readonly cache = this;
  public readonly claims = this;
  public readonly auth = this;
  public readonly admin = this;
  public readonly adminReports = this;
  public readonly deliveredCountryReports = this;
  public readonly uploads = this;
  public readonly imageJobs = this;
  public readonly accountingEvents: LinkAccountingEvent[] = [];
  public failAccounting = false;
  public failClaims = false;
  public failAuthFailureCount = false;
  public failRecordAuthFailure = false;
  public failRegistrationSetting = false;
  public failUsernameLookup = false;
  public failCreateUser = false;
  public failTrafficShieldRead = false;
  public registrationEnabled = false;
  public trafficShieldActivationStartedAtUtc: string | null = null;
  public lookupCount = 0;

  readonly #domainRows = new Map<number, DomainPolicy>();
  readonly #linkRows = new Map<string, LinkRecord>();
  readonly #linkMetrics = new Map<string, InMemoryLinkMetrics>();
  readonly #cacheRows = new Map<string, CacheEntry>();
  readonly #claimRows = new Map<string, number>();
  readonly #usersById = new Map<number, UserRecord>();
  readonly #usersByName = new Map<string, UserRecord>();
  readonly #authFailures: Array<{ ipHash: string; action: string; at: Date }> = [];
  readonly #rememberTokens = new Map<string, RememberTokenRecord>();
  readonly #adminDomainState = new Map<number, AdminDomainState>();
  readonly #uploads = new Map<string, UploadRecord>();
  readonly #imageJobsById = new Map<string, ImageJobSnapshot>();
  readonly #imageJobIdByRequest = new Map<string, string>();
  readonly #imageJobIdByOutput = new Map<string, string>();
  public authEpoch = 0;
  #nextUserId = 1;
  #nextId = 1n;

  public constructor(domains: readonly DomainPolicy[] = []) {
    for (const domain of domains) {
      this.#domainRows.set(domain.id, structuredClone(domain));
    }
  }

  public seedLink(link: LinkRecord, metrics: Partial<InMemoryLinkMetrics> = {}): void {
    const key = this.#linkKey(link.domainId, link.code);
    this.#linkRows.set(key, structuredClone(link));
    this.#linkMetrics.set(key, { ...emptyLinkMetrics(), ...structuredClone(metrics) });
    const numericId = BigInt(link.id);
    if (numericId >= this.#nextId) {
      this.#nextId = numericId + 1n;
    }
  }

  public seedUser(user: UserRecord): void {
    const copy = structuredClone(user);
    this.#usersById.set(user.id, copy);
    this.#usersByName.set(user.username, copy);
    this.#nextUserId = Math.max(this.#nextUserId, user.id + 1);
  }

  public async getDomain(domainId: number): Promise<DomainPolicy | null> {
    return structuredClone(this.#domainRows.get(domainId) ?? null);
  }

  public async listManageableDomains(): Promise<readonly DomainPolicy[]> {
    return [...this.#domainRows.values()].sort((left, right) => left.id - right.id);
  }

  public async listSelectableDomains(): Promise<readonly DomainPolicy[]> {
    return [...this.#domainRows.values()].filter((domain) => domain.active && domain.allowCreate);
  }

  public async loadReportActivation(_domainId: number): Promise<AdminReportActivationValues> {
    return {
      diversionCompleteFrom: null,
      filtersCompleteFrom: null,
      deliveredCompleteFrom: null,
      deliveredSealLagSeconds: null,
    };
  }

  public async loadCountryOutcomeAggregates(
    _domainId: number,
    _start: Date,
    _end: Date,
  ): Promise<readonly AdminCountryAggregate[]> {
    return [];
  }

  public async loadDeliveredCountryWindow(
    _domainId: number,
    _start: Date,
    _end: Date,
  ): Promise<DeliveredCountryWindowRows> {
    return { states: [], history: [] };
  }

  public async findLink(domainId: number, code: string, canonicalHost: string, surface: string): Promise<LinkRecord | null> {
    this.lookupCount += 1;
    const row = this.#linkRows.get(this.#linkKey(domainId, code));
    if (row === undefined || row.domainHostname !== canonicalHost) {
      return null;
    }
    const domain = this.#domainRows.get(domainId);
    if (domain === undefined || !domain.active || domain.surface !== surface) {
      return null;
    }
    const metrics = this.#linkMetrics.get(this.#linkKey(domainId, code));
    return {
      ...structuredClone(row),
      compactActivityTracked: row.compactActivityTracked === true
        || (metrics?.recentActivityEpochs !== null && metrics?.recentActivityEpochs !== undefined),
    };
  }

  public async createLink(input: CreateLinkInput): Promise<LinkRecord> {
    const key = this.#linkKey(input.domainId, input.code);
    if (this.#linkRows.has(key)) {
      const error = new Error("Duplicate code") as Error & { code: string };
      error.code = "DUPLICATE_CODE";
      throw error;
    }
    const domain = this.#domainRows.get(input.domainId);
    if (domain === undefined || !domain.active || !domain.allowCreate) {
      throw new Error("Domain is not creatable");
    }
    const uploadPath = managedUploadPath(input.image);
    let upload: UploadRecord | null = null;
    if (uploadPath !== null) {
      const candidate = this.#uploads.get(uploadPath);
      if (candidate === undefined || candidate.userId !== input.userId
        || input.imageSessionScopeHash === null || candidate.sessionScopeHash !== input.imageSessionScopeHash
        || (candidate.state !== 1 && candidate.state !== 2) || candidate.expiresAt <= input.createdAt
        || !this.#isLedgerReadyForOutput(uploadPath, input.userId)) {
        throw new AppError(
          "One or more uploaded images are unavailable. Re-upload them.",
          422,
          "UPLOAD_UNAVAILABLE",
        );
      }
      upload = candidate;
      if (input.imageOwnershipExpiresAt === null || input.imageOwnershipExpiresAt <= input.createdAt) {
        throw new AppError(
          "One or more uploaded images are unavailable. Re-upload them.",
          422,
          "UPLOAD_UNAVAILABLE",
        );
      }
    }
    const row: LinkRecord = {
      id: String(this.#nextId++),
      domainId: input.domainId,
      code: input.code,
      userId: input.userId,
      destination: input.destination,
      title: input.title,
      description: input.description,
      image: input.image,
      compactActivityTracked: uploadPath !== null,
      authorRole: this.#usersById.get(input.userId)?.role ?? "user",
      domainHostname: domain.hostname,
      domainLabel: domain.label,
      diversionCampaign: domain.diversionCampaign,
      createdAt: input.createdAt,
    };
    this.#linkRows.set(key, row);
    this.#linkMetrics.set(key, {
      ...emptyLinkMetrics(),
      recentActivityEpochs: uploadPath === null ? null : [],
    });
    if (uploadPath !== null && upload !== null && input.imageOwnershipExpiresAt !== null) {
      this.#uploads.set(uploadPath, {
        ...upload,
        state: 2,
        attachedAt: upload.attachedAt ?? input.createdAt,
        expiresAt: input.imageOwnershipExpiresAt,
      });
    }
    return structuredClone(row);
  }

  public async deleteOwnedLink(domainId: number, code: string, userId: number): Promise<boolean> {
    const key = this.#linkKey(domainId, code);
    const link = this.#linkRows.get(key);
    if (link === undefined || link.userId !== userId) {
      return false;
    }
    this.#linkMetrics.delete(key);
    return this.#linkRows.delete(key);
  }

  public async record(event: LinkAccountingEvent): Promise<void> {
    if (this.failAccounting) {
      throw new Error("Injected accounting failure");
    }
    this.accountingEvents.push(structuredClone(event));
    const entry = [...this.#linkRows.entries()].find(([, link]) => link.id === event.linkId
      && link.domainId === event.domainId);
    if (entry === undefined) return;
    const [key] = entry;
    const current = this.#linkMetrics.get(key) ?? emptyLinkMetrics();
    const eventDate = indiaBusinessDate(event.occurredAt);
    let todayClickDate = current.todayClickDate;
    let todayClicks = current.todayClicks;
    if (todayClickDate === null || todayClickDate < eventDate) {
      todayClickDate = eventDate;
      todayClicks = event.outcome === "delivered" ? 1n : 0n;
    } else if (todayClickDate === eventDate && event.outcome === "delivered") {
      todayClicks += 1n;
    }
    const recentActivityEpochs = event.trackRecentActivity
      ? [...(current.recentActivityEpochs ?? []), Math.floor(event.occurredAt.getTime() / 1000)].slice(-100)
      : null;
    const filteredHistory = current.filteredHistory.map((cell) => ({ ...cell }));
    if (event.outcome.startsWith("filtered_")) {
      const currentSlot = trafficShieldSlot(event.occurredAt);
      const cell = filteredHistory[currentSlot.slot];
      if (cell === undefined) throw new Error("In-memory Traffic Shield ring is incomplete.");
      if (cell.date === currentSlot.date) {
        cell.count += 1n;
      } else if (cell.date === null || cell.date < currentSlot.date) {
        cell.date = currentSlot.date;
        cell.count = 1n;
      }
    }
    this.#linkMetrics.set(key, {
      countedClicks: current.countedClicks + (event.outcome === "delivered" ? 1n : 0n),
      divertedClicks: current.divertedClicks + (event.outcome === "diverted" ? 1n : 0n),
      filteredMetaClicks: current.filteredMetaClicks + (event.outcome === "filtered_meta" ? 1n : 0n),
      filteredBotClicks: current.filteredBotClicks + (event.outcome === "filtered_bot" ? 1n : 0n),
      filteredOtherClicks: current.filteredOtherClicks + (event.outcome === "filtered_other" ? 1n : 0n),
      todayClicks,
      todayClickDate,
      lastActivityAt: current.lastActivityAt === null || current.lastActivityAt < event.occurredAt
        ? new Date(event.occurredAt)
        : current.lastActivityAt,
      recentActivityEpochs,
      filteredHistory,
    });
  }

  /** Test-only observation of the compact per-link activity ring. */
  public recentActivityEpochsForTest(domainId: number, code: string): readonly number[] | null {
    const epochs = this.#linkMetrics.get(this.#linkKey(domainId, code))?.recentActivityEpochs ?? null;
    return epochs === null ? null : [...epochs];
  }

  public async loadDashboardOwnStats(userId: number, businessDate: string): Promise<DashboardOwnStats> {
    const rows = this.#ownedLinkEntries(userId);
    return {
      totalLinks: BigInt(rows.length),
      totalClicks: this.#sumCounters(rows, (metrics) => metrics.countedClicks),
      clicksToday: this.#sumCounters(rows, (metrics) => metrics.todayClickDate === businessDate ? metrics.todayClicks : 0n),
    };
  }

  public async loadDashboardCommunityStats(businessDate: string): Promise<DashboardCommunityStats> {
    const rows = [...this.#linkRows.entries()].filter(([, link]) => {
      return this.#usersById.get(link.userId)?.role !== "admin";
    });
    return {
      totalClicks: this.#sumCounters(rows, (metrics) => metrics.countedClicks),
      clicksToday: this.#sumCounters(rows, (metrics) => metrics.todayClickDate === businessDate ? metrics.todayClicks : 0n),
    };
  }

  public async loadTrafficShieldAggregate(
    userId: number,
    slots: readonly TrafficShieldDateSlot[],
  ): Promise<TrafficShieldAggregate> {
    if (this.failTrafficShieldRead) throw new Error("Injected Traffic Shield read failure");
    if (!Number.isSafeInteger(userId) || userId < 1 || slots.length !== 7) {
      throw new RangeError("Invalid Traffic Shield aggregate request.");
    }
    const rows = this.#ownedLinkEntries(userId);
    const dates = new Set<string>();
    for (const entry of slots) {
      if (!Number.isInteger(entry.slot) || entry.slot < 0 || entry.slot > 6
        || dates.has(entry.date) || trafficShieldSlotForDate(entry.date) !== entry.slot) {
        throw new RangeError("Invalid Traffic Shield aggregate request.");
      }
      dates.add(entry.date);
    }
    return {
      activationStartedAtUtc: this.trafficShieldActivationStartedAtUtc,
      lifetimeTotal: this.#sumCounters(rows, (metrics) => (
        metrics.filteredMetaClicks + metrics.filteredBotClicks + metrics.filteredOtherClicks
      )),
      dailyTotals: slots.map((entry) => this.#sumCounters(rows, (metrics) => {
        const cell = metrics.filteredHistory[entry.slot];
        return cell?.date === entry.date ? cell.count : 0n;
      })),
    };
  }

  public async countDashboardLinks(userId: number, literalQuery: string): Promise<number> {
    return this.#ownedLinkEntries(userId).filter(([, link]) => matchesDashboardQuery(link, literalQuery)).length;
  }

  public async listDashboardLinks(input: {
    readonly userId: number;
    readonly literalQuery: string;
    readonly limit: number;
    readonly offset: number;
  }): Promise<readonly DashboardHistoryLink[]> {
    if (![20, 50, 100].includes(input.limit) || !Number.isSafeInteger(input.offset) || input.offset < 0) {
      throw new RangeError("Invalid dashboard history window.");
    }
    return this.#ownedLinkEntries(input.userId)
      .filter(([, link]) => matchesDashboardQuery(link, input.literalQuery))
      .sort(([, left], [, right]) => compareLinkIdsDescending(left.id, right.id))
      .slice(input.offset, input.offset + input.limit)
      .map(([key, link]) => {
        const metrics = this.#linkMetrics.get(key) ?? emptyLinkMetrics();
        return structuredClone({ link, ...metrics });
      });
  }

  public async get(key: string): Promise<string | null> {
    const entry = this.#cacheRows.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= Date.now()) {
      this.#cacheRows.delete(key);
      return null;
    }
    return entry.value;
  }

  public async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.#cacheRows.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  public async delete(...keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.#cacheRows.delete(key);
    }
  }

  public async claim(key: string, ttlSeconds: number): Promise<ClaimResult> {
    if (this.failClaims) {
      return "unavailable";
    }
    const now = Date.now();
    const expiresAt = this.#claimRows.get(key);
    if (expiresAt !== undefined && expiresAt > now) {
      return "duplicate";
    }
    this.#claimRows.set(key, now + ttlSeconds * 1000);
    return "winner";
  }

  public async findUserByUsername(username: string): Promise<UserRecord | null> {
    return structuredClone(this.#usersByName.get(username) ?? null);
  }

  public async findUserById(userId: number): Promise<UserRecord | null> {
    return structuredClone(this.#usersById.get(userId) ?? null);
  }

  public async isRegistrationEnabled(): Promise<boolean> {
    if (this.failRegistrationSetting) {
      throw new Error("Injected registration setting failure");
    }
    return this.registrationEnabled;
  }

  public async loadDomainState(domainId: number): Promise<AdminDomainState> {
    if (!this.#domainRows.has(domainId)) throw new Error("Domain not found.");
    return structuredClone(this.#adminDomainState.get(domainId) ?? emptyAdminDomainState());
  }

  public async saveSkimSettings(domainId: number, candidate: SkimSettingsCandidate): Promise<void> {
    if (!this.#domainRows.has(domainId)) throw new Error("Domain not found.");
    const current = this.#adminDomainState.get(domainId) ?? emptyAdminDomainState();
    this.#adminDomainState.set(domainId, {
      ...current,
      skim: structuredClone(candidate),
    });
  }

  public async saveGeoQuality(domainId: number, candidate: GeoQualityCandidate): Promise<void> {
    if (!this.#domainRows.has(domainId)) throw new Error("Domain not found.");
    const current = this.#adminDomainState.get(domainId) ?? emptyAdminDomainState();
    this.#adminDomainState.set(domainId, {
      ...current,
      geoRules: structuredClone(candidate.rules),
      qualityPolicy: structuredClone(candidate.qualityPolicy),
    });
  }

  public async listUsers(): Promise<readonly AdminUserSummary[]> {
    return [...this.#usersById.values()]
      .sort((left, right) => compareAdminUsers(left, right))
      .map((user) => {
        const links = this.#ownedLinkEntries(user.id);
        return {
          id: user.id,
          username: user.username,
          role: user.role,
          createdAt: new Date(user.createdAt),
          linkCount: BigInt(links.length),
          clickCount: this.#sumCounters(links, (metrics) => metrics.countedClicks),
        };
      });
  }

  public async setRegistrationEnabled(enabled: boolean): Promise<void> {
    this.registrationEnabled = enabled;
  }

  public async deleteRegularUser(userId: number): Promise<AdminDeleteUserResult> {
    const user = this.#usersById.get(userId);
    if (user === undefined) return { status: "not_found" };
    if (user.role === "admin") return { status: "admin" };
    if (user.role !== "user") return { status: "protected_role" };
    if ([...this.#uploads.values()].some((upload) => upload.userId === userId)) {
      return { status: "uploads_present" };
    }
    const links = this.#ownedLinkEntries(userId).map(([key, link]) => {
      this.#linkRows.delete(key);
      this.#linkMetrics.delete(key);
      return { domainId: link.domainId, code: link.code };
    });
    this.#usersById.delete(userId);
    this.#usersByName.delete(user.username);
    for (const [selector, token] of this.#rememberTokens) {
      if (token.userId === userId) this.#rememberTokens.delete(selector);
    }
    return { status: "deleted", userId, links };
  }

  public async usernameExists(username: string): Promise<boolean> {
    if (this.failUsernameLookup) {
      throw new Error("Injected username lookup failure");
    }
    return this.#usersByName.has(username);
  }

  public async createUser(input: CreateRegisteredUserInput): Promise<number> {
    if (this.failCreateUser) {
      throw new Error("Injected registered-user insert failure");
    }
    if (this.#usersByName.has(input.username)) {
      const error = new Error("Duplicate username") as Error & { code: string };
      error.code = "ER_DUP_ENTRY";
      throw error;
    }
    const id = this.#nextUserId;
    this.#nextUserId += 1;
    const user: UserRecord = {
      id,
      username: input.username,
      passwordHash: input.passwordHash,
      role: input.role,
      defaultDomainId: null,
      createdAt: new Date(input.createdAt),
    };
    this.#usersById.set(id, user);
    this.#usersByName.set(user.username, user);
    return id;
  }

  public async authFailureCount(ipHash: string, action: string, since: Date): Promise<number> {
    if (this.failAuthFailureCount) {
      throw new Error("Injected auth throttle read failure");
    }
    return this.#authFailures.filter((row) => row.ipHash === ipHash && row.action === action && row.at >= since).length;
  }

  public async recordAuthFailure(ipHash: string, action: string, at: Date): Promise<void> {
    if (this.failRecordAuthFailure) {
      throw new Error("Injected auth throttle write failure");
    }
    this.#authFailures.push({ ipHash, action, at });
  }

  public async getAuthEpoch(): Promise<number> {
    return this.authEpoch;
  }

  public async createRememberToken(input: {
    userId: number;
    selector: string;
    validatorHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<{ readonly authEpoch: number }> {
    const id = String(this.#rememberTokens.size + 1);
    this.#rememberTokens.set(input.selector, { id, ...structuredClone(input) });
    return { authEpoch: this.authEpoch };
  }

  public async findRememberToken(selector: string): Promise<RememberTokenRecord | null> {
    return structuredClone(this.#rememberTokens.get(selector) ?? null);
  }

  public async rotateRememberToken(id: string, validatorHash: string, expiresAt: Date): Promise<void> {
    for (const [selector, token] of this.#rememberTokens) {
      if (token.id === id) {
        this.#rememberTokens.set(selector, { ...token, validatorHash, expiresAt });
        return;
      }
    }
    throw new Error("Remember token not found.");
  }

  public async restoreRememberToken(input: {
    readonly selector: string;
    readonly validatorHash: string;
    readonly rotatedValidatorHash: string;
    readonly now: Date;
    readonly expiresAt: Date;
  }): Promise<
    | {
        readonly status: "rotated";
        readonly userId: number;
        readonly selector: string;
        readonly authEpoch: number;
      }
    | { readonly status: "invalid" }
  > {
    const token = this.#rememberTokens.get(input.selector);
    if (token === undefined) return { status: "invalid" };
    if (token.validatorHash !== input.validatorHash || token.expiresAt <= input.now) {
      this.#rememberTokens.delete(input.selector);
      return { status: "invalid" };
    }
    this.#rememberTokens.set(input.selector, {
      ...token,
      validatorHash: input.rotatedValidatorHash,
      expiresAt: new Date(input.expiresAt),
    });
    return {
      status: "rotated",
      userId: token.userId,
      selector: token.selector,
      authEpoch: this.authEpoch,
    };
  }

  public async resetAllAuthCredentials(input: {
    readonly adminUserId: number;
    readonly selector: string;
    readonly validatorHash: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }): Promise<{ readonly authEpoch: number }> {
    if (this.authEpoch >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Authentication epoch cannot be incremented safely.");
    }
    this.authEpoch += 1;
    this.#rememberTokens.clear();
    this.#rememberTokens.set(input.selector, {
      id: "1",
      userId: input.adminUserId,
      selector: input.selector,
      validatorHash: input.validatorHash,
      expiresAt: new Date(input.expiresAt),
    });
    return { authEpoch: this.authEpoch };
  }

  public async deleteRememberToken(selector: string): Promise<void> {
    this.#rememberTokens.delete(selector);
  }

  public async setDefaultDomain(userId: number, domainId: number): Promise<void> {
    const user = this.#usersById.get(userId);
    if (user === undefined) {
      throw new Error("User not found.");
    }
    const updated = { ...user, defaultDomainId: domainId };
    this.#usersById.set(userId, updated);
    this.#usersByName.set(updated.username, updated);
  }

  public async countReadyForScope(userId: number, sessionScopeHash: string): Promise<number> {
    return [...this.#uploads.values()].filter(
      (row) => row.userId === userId && row.sessionScopeHash === sessionScopeHash && row.state === 1,
    ).length;
  }

  public async countReadyTotal(): Promise<number> {
    return [...this.#uploads.values()].filter((row) => row.state === 1).length;
  }

  public async registerReady(input: RegisterUploadInput, capacity?: UploadCapacity): Promise<void> {
    if (this.#uploads.has(input.path)) {
      throw new Error("Duplicate upload path.");
    }
    if (capacity !== undefined) {
      const ready = [...this.#uploads.values()].filter((row) => row.state === 1);
      if (ready.filter((row) => row.userId === input.userId
        && row.sessionScopeHash === input.sessionScopeHash).length >= capacity.readyPerSession) {
        throw codedError("Session upload capacity reached.", "SESSION_UPLOAD_LIMIT");
      }
      if (ready.length >= capacity.readyTotal) {
        throw codedError("Global upload capacity reached.", "GLOBAL_UPLOAD_LIMIT");
      }
    }
    this.#uploads.set(input.path, { ...structuredClone(input), state: 1, attachedAt: null });
  }

  public async reserveImageJob(input: NewImageJob, atMs: number): Promise<ImageJobCreationDecision> {
    const requestJobId = this.#imageJobIdByRequest.get(input.requestKey);
    const decision = decideImageJobCreation(input, {
      byRequestKey: requestJobId === undefined ? null : this.#imageJobsById.get(requestJobId) ?? null,
      byJobId: this.#imageJobsById.get(input.jobId) ?? null,
    }, atMs);
    if (decision.kind === "create") {
      const stored = structuredClone(decision.job);
      this.#imageJobsById.set(stored.jobId, stored);
      this.#imageJobIdByRequest.set(stored.requestKey, stored.jobId);
      this.#imageJobIdByOutput.set(stored.outputStorageKey, stored.jobId);
    }
    return structuredClone(decision);
  }

  public async getImageJob(jobId: string): Promise<ImageJobSnapshot | null> {
    return structuredClone(this.#imageJobsById.get(jobId) ?? null);
  }

  public async transitionImageJob(jobId: string, command: ImageJobCommand): Promise<ImageJobSnapshot> {
    const current = this.#requiredImageJob(jobId);
    const next = applyImageJobTransition(current, command);
    this.#imageJobsById.set(jobId, structuredClone(next));
    return structuredClone(next);
  }

  public async publishImageJobReady(
    jobId: string,
    command: ImageJobReadyCommand,
    upload: RegisterUploadInput,
    capacity: UploadCapacity,
  ): Promise<ImageJobSnapshot> {
    const current = this.#requiredImageJob(jobId);
    if (current.state === "ready") {
      const registered = this.#uploads.get(current.outputStorageKey);
      if (registered !== undefined && registered.userId === current.userId
        && registered.sessionScopeHash === current.sessionScopeHash && isImageJobAttachable(current)) {
        return structuredClone(current);
      }
      throw new Error("Ready image job registration is missing.");
    }
    this.#assertRegistrationMatchesJob(current, upload);
    if (this.#uploads.has(upload.path)) {
      throw new Error("Duplicate upload path.");
    }
    const ready = [...this.#uploads.values()].filter((row) => row.state === 1);
    if (ready.filter((row) => row.userId === upload.userId
      && row.sessionScopeHash === upload.sessionScopeHash).length >= capacity.readyPerSession) {
      throw codedError("Session upload capacity reached.", "SESSION_UPLOAD_LIMIT");
    }
    if (ready.length >= capacity.readyTotal) {
      throw codedError("Global upload capacity reached.", "GLOBAL_UPLOAD_LIMIT");
    }
    const next = applyImageJobTransition(current, command);
    this.#uploads.set(upload.path, { ...structuredClone(upload), state: 1, attachedAt: null });
    this.#imageJobsById.set(jobId, structuredClone(next));
    return structuredClone(next);
  }

  public async completeImageJobCompensation(
    jobId: string,
    command: ImageJobCompensatedCommand,
  ): Promise<ImageJobSnapshot> {
    const current = this.#requiredImageJob(jobId);
    await this.assertImageJobCompensationSafe(jobId);
    const upload = this.#uploads.get(current.outputStorageKey);
    const next = applyImageJobTransition(current, command);
    if (upload?.state === 1) {
      this.#uploads.delete(current.outputStorageKey);
    }
    this.#imageJobsById.set(jobId, structuredClone(next));
    return structuredClone(next);
  }

  public async assertImageJobCompensationSafe(jobId: string): Promise<void> {
    const current = this.#requiredImageJob(jobId);
    const upload = this.#uploads.get(current.outputStorageKey);
    if (upload?.state === 2) {
      throw codedError("Attached image cannot be compensated automatically.", "IMAGE_JOB_ATTACHED");
    }
    if ([...this.#linkRows.values()].some((link) => link.image === current.outputStorageKey)) {
      throw codedError("Referenced image cannot be compensated automatically.", "IMAGE_JOB_REFERENCED");
    }
  }

  public async listImageJobsForRecovery(nowMs: number, limit: number): Promise<readonly ImageJobSnapshot[]> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("Invalid image-job recovery window.");
    }
    return [...this.#imageJobsById.values()]
      .filter((job) => needsImageJobRecovery(job, nowMs))
      .sort((left, right) => left.updatedAtMs - right.updatedAtMs || left.jobId.localeCompare(right.jobId))
      .slice(0, limit)
      .map((job) => structuredClone(job));
  }

  public async hasReadyImageRegistration(jobId: string): Promise<boolean> {
    const job = this.#imageJobsById.get(jobId);
    if (job === undefined || !isImageJobAttachable(job)) {
      return false;
    }
    const upload = this.#uploads.get(job.outputStorageKey);
    return upload !== undefined && upload.userId === job.userId
      && upload.sessionScopeHash === job.sessionScopeHash && (upload.state === 1 || upload.state === 2);
  }

  public async verifyOwnedPaths(
    userId: number,
    sessionScopeHash: string,
    paths: readonly string[],
    now: Date,
  ): Promise<readonly string[]> {
    const verified: string[] = [];
    for (const path of [...new Set(paths)]) {
      const row = this.#uploads.get(path);
      if (row === undefined || row.userId !== userId || row.sessionScopeHash !== sessionScopeHash
        || row.expiresAt <= now || (row.state !== 1 && row.state !== 2)
        || !this.#isLedgerReadyForOutput(path, userId)) {
        throw new Error("One or more uploaded images are unavailable. Re-upload them.");
      }
      verified.push(path);
    }
    return verified;
  }

  public async markAttached(
    userId: number,
    sessionScopeHash: string,
    paths: readonly string[],
    at: Date,
    expiresAt: Date,
  ): Promise<void> {
    const unique = [...new Set(paths)];
    for (const path of unique) {
      const row = this.#uploads.get(path);
      if (row === undefined || row.userId !== userId || row.sessionScopeHash !== sessionScopeHash
        || row.expiresAt <= at || (row.state !== 1 && row.state !== 2)
        || !this.#isLedgerReadyForOutput(path, userId)) {
        throw new AppError(
          "One or more uploaded images are unavailable. Re-upload them.",
          422,
          "UPLOAD_UNAVAILABLE",
        );
      }
    }
    for (const path of unique) {
      const row = this.#uploads.get(path);
      if (row === undefined) {
        throw new Error("Upload attachment precondition changed unexpectedly.");
      }
      this.#uploads.set(path, { ...row, state: 2, attachedAt: row.attachedAt ?? at, expiresAt });
    }
  }

  #linkKey(domainId: number, code: string): string {
    return `${domainId}:${code}`;
  }

  #ownedLinkEntries(userId: number): Array<[string, LinkRecord]> {
    return [...this.#linkRows.entries()].filter(([, link]) => link.userId === userId);
  }

  #sumCounters(
    rows: readonly [string, LinkRecord][],
    select: (metrics: InMemoryLinkMetrics) => bigint,
  ): bigint {
    return rows.reduce((total, [key]) => total + select(this.#linkMetrics.get(key) ?? emptyLinkMetrics()), 0n);
  }

  #requiredImageJob(jobId: string): ImageJobSnapshot {
    const job = this.#imageJobsById.get(jobId);
    if (job === undefined) {
      throw codedError("Image job not found.", "IMAGE_JOB_NOT_FOUND");
    }
    return job;
  }

  #isLedgerReadyForOutput(path: string, userId: number): boolean {
    const jobId = this.#imageJobIdByOutput.get(path);
    if (jobId === undefined) {
      return true;
    }
    const job = this.#imageJobsById.get(jobId);
    return job !== undefined && job.userId === userId && isImageJobAttachable(job);
  }

  #assertRegistrationMatchesJob(job: ImageJobSnapshot, upload: RegisterUploadInput): void {
    if (upload.path !== job.outputStorageKey || upload.userId !== job.userId
      || upload.sessionScopeHash !== job.sessionScopeHash
      || upload.expiresAt.getTime() !== job.ownershipExpiresAtMs) {
      throw codedError("Ready registration does not match its image job.", "IMAGE_JOB_REGISTRATION_MISMATCH");
    }
  }
}

function emptyLinkMetrics(): InMemoryLinkMetrics {
  return {
    countedClicks: 0n,
    divertedClicks: 0n,
    filteredMetaClicks: 0n,
    filteredBotClicks: 0n,
    filteredOtherClicks: 0n,
    todayClicks: 0n,
    todayClickDate: null,
    lastActivityAt: null,
    recentActivityEpochs: null,
    filteredHistory: Array.from({ length: 7 }, () => ({ date: null, count: 0n })),
  };
}

function emptyAdminDomainState(): AdminDomainState {
  return {
    skim: { enabled: false, destinationUrl: "", defaultPercent: 0 },
    geoRules: [],
    qualityPolicy: { active: false, scope: "selected", countries: [] },
  };
}

function compareAdminUsers(left: UserRecord, right: UserRecord): number {
  if (left.role !== right.role) return left.role > right.role ? -1 : 1;
  return left.id - right.id;
}

function matchesDashboardQuery(link: LinkRecord, literalQuery: string): boolean {
  if (literalQuery === "") return true;
  const folded = literalQuery.toLocaleLowerCase("en-US");
  return (link.title?.toLocaleLowerCase("en-US").includes(folded) ?? false)
    || link.destination.toLocaleLowerCase("en-US").includes(folded)
    || link.code.includes(literalQuery);
}

function compareLinkIdsDescending(left: string, right: string): number {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId > rightId ? -1 : leftId < rightId ? 1 : 0;
}

function needsImageJobRecovery(job: ImageJobSnapshot, nowMs: number): boolean {
  if (job.state === "ready" || job.state === "failed" || job.state === "compensated" || job.state === "manual_review") {
    return false;
  }
  if (job.state === "queued" || job.state === "compensation_required") {
    return job.nextAttemptAtMs === null || job.nextAttemptAtMs <= nowMs;
  }
  if (job.lease !== null) {
    return job.lease.expiresAtMs <= nowMs;
  }
  return true;
}

function managedUploadPath(image: string | null): string | null {
  return image !== null && isManagedImagePath(image) ? image : null;
}

function codedError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, { session: SessionData; expiresAt: number }>();

  public async get(sessionId: string): Promise<SessionData | null> {
    const row = this.#sessions.get(sessionId);
    if (row === undefined || row.expiresAt <= Date.now()) {
      this.#sessions.delete(sessionId);
      return null;
    }
    return structuredClone(row.session);
  }

  public async set(session: SessionData, ttlSeconds: number): Promise<void> {
    this.#sessions.set(session.id, {
      session: structuredClone(session),
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  public async delete(sessionId: string): Promise<void> {
    this.#sessions.delete(sessionId);
  }
}
