import type {
  CreateLinkInput,
  DeliveredCountryGapEvent,
  DeliveredCountryObservation,
  DeliveredCountryWindowRows,
  DomainPolicy,
  LinkAccountingEvent,
  LinkRecord,
  RememberTokenRecord,
  RegisterUploadInput,
  SessionData,
  UserRecord,
} from "./core/types.js";
import type {
  ImageJobCommand,
  ImageJobCreationDecision,
  ImageJobSnapshot,
  NewImageJob,
} from "./modules/uploads/job-ledger-policy.js";
import type { DashboardHistoryStore } from "./modules/dashboard/history-service.js";
import type { AdminControlPlaneStore } from "./modules/admin/store.js";
import type { AdminReportSourceStore } from "./modules/reporting/admin-report-service.js";

export interface DomainStore {
  getDomain(domainId: number): Promise<DomainPolicy | null>;
  listManageableDomains(): Promise<readonly DomainPolicy[]>;
  listSelectableDomains(): Promise<readonly DomainPolicy[]>;
}

export interface LinkStore {
  findLink(domainId: number, code: string, canonicalHost: string, surface: string): Promise<LinkRecord | null>;
  createLink(input: CreateLinkInput): Promise<LinkRecord>;
  deleteOwnedLink(domainId: number, code: string, userId: number): Promise<boolean>;
}

export interface AccountingStore {
  record(event: LinkAccountingEvent): Promise<void>;
}

export interface DeliveredCountryObserverStore {
  isEnabled(domainId: number): boolean;
  observe(event: DeliveredCountryObservation): Promise<void>;
  markGap(event: DeliveredCountryGapEvent): Promise<void>;
}

export interface DeliveredCountryReportStore {
  loadDeliveredCountryWindow(
    domainId: number,
    start: Date,
    end: Date,
  ): Promise<DeliveredCountryWindowRows>;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(...keys: readonly string[]): Promise<void>;
}

export type ClaimResult = "winner" | "duplicate" | "unavailable";

export interface DuplicateClaimStore {
  claim(key: string, ttlSeconds: number): Promise<ClaimResult>;
}

export interface Clock {
  now(): Date;
}

export interface AuthStore {
  findUserByUsername(username: string): Promise<UserRecord | null>;
  findUserById(userId: number): Promise<UserRecord | null>;
  authFailureCount(ipHash: string, action: string, since: Date): Promise<number>;
  recordAuthFailure(ipHash: string, action: string, at: Date): Promise<void>;
  getAuthEpoch(): Promise<number>;
  createRememberToken(input: {
    userId: number;
    selector: string;
    validatorHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<{ readonly authEpoch: number }>;
  findRememberToken(selector: string): Promise<RememberTokenRecord | null>;
  rotateRememberToken(id: string, validatorHash: string, expiresAt: Date): Promise<void>;
  /**
   * Validate and rotate one remember credential while holding the auth-epoch
   * ordering lock. A concurrent global reset must be entirely before or after
   * this operation; an old credential can never mint a new-epoch session.
   */
  restoreRememberToken(input: {
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
  >;
  /**
   * One transaction: bump auth_epoch, revoke every remember token and create
   * only the initiating Admin's fresh token.
   */
  resetAllAuthCredentials(input: {
    readonly adminUserId: number;
    readonly selector: string;
    readonly validatorHash: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }): Promise<{ readonly authEpoch: number }>;
  deleteRememberToken(selector: string): Promise<void>;
  setDefaultDomain(userId: number, domainId: number): Promise<void>;
}

export interface CreateRegisteredUserInput {
  readonly username: string;
  readonly passwordHash: string;
  readonly role: "user";
  readonly createdAt: Date;
}

export interface RegistrationStore {
  /** Must preserve the current users.username ascii_bin semantics. */
  usernameExists(username: string): Promise<boolean>;
  /** The database UNIQUE(username) key remains the race-safe backstop. */
  createUser(input: CreateRegisteredUserInput): Promise<number>;
}

export interface PublicRegistrationStore extends RegistrationStore {
  /** Missing settings must resolve false; storage failures must reject. */
  isRegistrationEnabled(): Promise<boolean>;
}

export interface SessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(session: SessionData, ttlSeconds: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export interface UploadStore {
  countReadyForScope(userId: number, sessionScopeHash: string): Promise<number>;
  countReadyTotal(): Promise<number>;
  registerReady(input: RegisterUploadInput, capacity?: UploadCapacity): Promise<void>;
  verifyOwnedPaths(
    userId: number,
    sessionScopeHash: string,
    paths: readonly string[],
    now: Date,
  ): Promise<readonly string[]>;
  markAttached(
    userId: number,
    sessionScopeHash: string,
    paths: readonly string[],
    at: Date,
    expiresAt: Date,
  ): Promise<void>;
}

export interface UploadCapacity {
  readonly readyPerSession: number;
  readonly readyTotal: number;
}

export type ImageJobReadyCommand = Extract<ImageJobCommand, { readonly type: "mark_ready" }>;
export type ImageJobCompensatedCommand = Extract<
  ImageJobCommand,
  { readonly type: "mark_compensated" | "recover_compensated" }
>;

export interface ImageJobStore {
  reserveImageJob(input: NewImageJob, atMs: number): Promise<ImageJobCreationDecision>;
  getImageJob(jobId: string): Promise<ImageJobSnapshot | null>;
  transitionImageJob(jobId: string, command: ImageJobCommand): Promise<ImageJobSnapshot>;
  publishImageJobReady(
    jobId: string,
    command: ImageJobReadyCommand,
    upload: RegisterUploadInput,
    capacity: UploadCapacity,
  ): Promise<ImageJobSnapshot>;
  completeImageJobCompensation(
    jobId: string,
    command: ImageJobCompensatedCommand,
  ): Promise<ImageJobSnapshot>;
  assertImageJobCompensationSafe(jobId: string): Promise<void>;
  listImageJobsForRecovery(nowMs: number, limit: number): Promise<readonly ImageJobSnapshot[]>;
  hasReadyImageRegistration(jobId: string): Promise<boolean>;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface ApplicationStores {
  readonly domains: DomainStore;
  readonly links: LinkStore;
  /** Required by the dashboard runtime; optional on narrow test/store aggregates. */
  readonly dashboard?: DashboardHistoryStore;
  readonly accounting: AccountingStore;
  readonly cache: CacheStore;
  readonly claims: DuplicateClaimStore;
  readonly auth: AuthStore & PublicRegistrationStore;
  /** Required by the Admin runtime; optional on narrow store aggregates. */
  readonly admin?: AdminControlPlaneStore;
  /** Compact Admin country outcomes over the same owned MariaDB pool. */
  readonly adminReports?: AdminReportSourceStore;
  readonly uploads: UploadStore;
  /** Required by the image runtime; optional on narrow test/store aggregates. */
  readonly imageJobs?: ImageJobStore;
  /** Optional until a deployment has an explicit D2/D3 observer generation. */
  readonly deliveredCountryObserver?: DeliveredCountryObserverStore;
  readonly deliveredCountryReports?: DeliveredCountryReportStore;
}
