import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../../core/errors.js";
import type { SessionData, UserRecord } from "../../core/types.js";
import type { AuthStore, Clock, PublicRegistrationStore, SessionStore } from "../../ports.js";
import { invalidLoginPasswordHash, verifyPhpPassword } from "./passwords.js";
import {
  RegistrationError,
  RegistrationService,
  type PublicRegistrationRequest,
  type RegisteredAccount,
} from "./registration.js";

const thirtyDaysSeconds = 30 * 24 * 60 * 60;

export interface AuthServiceOptions {
  readonly authStore: AuthStore & Partial<PublicRegistrationStore>;
  readonly sessions: SessionStore;
  readonly clock: Clock;
  readonly ipHashSecret: string;
  readonly sessionTtlSeconds?: number;
  readonly verifyPassword?: (password: string, hash: string) => Promise<boolean>;
}

export interface AuthenticatedSession {
  readonly session: SessionData;
  readonly user: UserRecord;
  readonly rememberCookie: string | null;
}

export type PublicRegistrationResult =
  | {
      readonly status: "authenticated";
      readonly authenticated: AuthenticatedSession;
    }
  | {
      readonly status: "account_created";
      readonly loginRequired: true;
      readonly account: RegisteredAccount;
    };

/** Signals the HTTP boundary to clear both browser credentials. */
export class GlobalSessionResetError extends AppError {
  public constructor(message: string, code: string) {
    super(message, 503, code);
    this.name = "GlobalSessionResetError";
  }
}

export class AuthService {
  readonly #sessionTtl: number;
  readonly #verifyPassword: (password: string, hash: string) => Promise<boolean>;

  public constructor(private readonly options: AuthServiceOptions) {
    this.#sessionTtl = options.sessionTtlSeconds ?? thirtyDaysSeconds;
    this.#verifyPassword = options.verifyPassword ?? verifyPhpPassword;
  }

  public async login(username: string, password: string, ip: string): Promise<AuthenticatedSession> {
    const now = this.options.clock.now();
    const ipHash = this.#ipHash(ip);
    const since = new Date(now.getTime() - 15 * 60 * 1000);
    let recentFailures = 0;
    try {
      recentFailures = await this.options.authStore.authFailureCount(ipHash, "login_fail", since);
    } catch {
      // Exact current PHP contract: throttle storage is best-effort/fail-open.
    }
    if (recentFailures >= 20) {
      throw new AppError("Too many attempts. Please wait a few minutes and try again.", 429, "LOGIN_THROTTLED");
    }

    const user = await this.options.authStore.findUserByUsername(username.trim());
    const passwordValid = await this.#verifyPassword(
      password,
      user?.passwordHash ?? invalidLoginPasswordHash,
    );
    if (user === null || !passwordValid) {
      try {
        await this.options.authStore.recordAuthFailure(ipHash, "login_fail", now);
      } catch {
        // Password failure still remains a failure even if abuse bookkeeping is unavailable.
      }
      throw new AppError("Invalid username or password.", 401, "INVALID_LOGIN");
    }
    return this.#establishWithRemember(user, now);
  }

  public async registerPublic(
    request: PublicRegistrationRequest,
    ip: string,
  ): Promise<PublicRegistrationResult> {
    const store = registrationStore(this.options.authStore);
    if (store === null) {
      throw registrationUnavailable();
    }

    let enabled: boolean;
    try {
      enabled = await store.isRegistrationEnabled();
    } catch {
      // The enable switch is authorization to create a public account. Unlike
      // throttle bookkeeping, an unreadable switch must never fail open.
      throw registrationUnavailable();
    }
    if (!enabled) {
      throw new AppError("Sign-up is currently closed.", 403, "REGISTRATION_CLOSED");
    }

    const now = this.options.clock.now();
    const ipHash = this.#ipHash(ip);
    const since = new Date(now.getTime() - 60 * 60 * 1000);
    let recentAttempts = 0;
    try {
      recentAttempts = await this.options.authStore.authFailureCount(ipHash, "register", since);
    } catch {
      // Exact current PHP contract: throttle storage is best-effort/fail-open.
    }
    if (recentAttempts >= 5) {
      throw new AppError(
        "Too many sign-up attempts. Please try again later.",
        429,
        "REGISTRATION_THROTTLED",
      );
    }

    // This deliberately precedes validation. PHP counts every genuine attempt
    // that passed enablement, CSRF and the pre-existing throttle threshold.
    try {
      await this.options.authStore.recordAuthFailure(ipHash, "register", now);
    } catch {
      // Registration remains available when only abuse bookkeeping is down.
    }

    let account: RegisteredAccount;
    try {
      account = await new RegistrationService({
        store,
        clock: this.options.clock,
      }).register(request);
    } catch (error) {
      if (error instanceof RegistrationError) {
        throw registrationAppError(error);
      }
      throw registrationUnavailable();
    }

    try {
      const user = await this.options.authStore.findUserById(account.id);
      if (user === null) {
        throw new Error("Committed registration could not be read back.");
      }
      return {
        status: "authenticated",
        authenticated: await this.#establishWithRemember(user, account.createdAt),
      };
    } catch {
      // The INSERT is already committed. Never turn a later session/readback
      // failure into a generic retry that could encourage a duplicate account.
      return { status: "account_created", loginRequired: true, account };
    }
  }

  async #establishWithRemember(user: UserRecord, now: Date): Promise<AuthenticatedSession> {
    const established = await this.#establish(user, null);
    let credentialEpoch: number | null = null;
    try {
      const selector = randomBytes(12).toString("hex");
      const validator = randomBytes(32).toString("hex");
      const rememberExpires = new Date(now.getTime() + thirtyDaysSeconds * 1000);
      const created = await this.options.authStore.createRememberToken({
        userId: user.id,
        selector,
        validatorHash: sha256(validator),
        expiresAt: rememberExpires,
        createdAt: now,
      });
      credentialEpoch = created.authEpoch;
      // A reset can linearize between the original session write and token
      // creation. Use the epoch captured under the token's shared ordering
      // lock, rather than letting a new token point at a stale session.
      const session = created.authEpoch === established.session.authEpoch
        ? { ...established.session, rememberSelector: selector }
        : this.#newSession(user, selector, created.authEpoch, this.options.clock.now());
      try {
        await this.options.sessions.set(session, this.#sessionTtl);
        if (session.id !== established.session.id) {
          await this.#bestEffortDeleteSession(established.session.id);
        }
      } catch (error) {
        await this.#bestEffortDeleteRemember(selector);
        throw error;
      }
      return { session, user, rememberCookie: `${selector}:${validator}` };
    } catch {
      if (credentialEpoch !== null && credentialEpoch !== established.session.authEpoch) {
        // The prior session is known stale because a reset linearized before
        // token creation. Keep password login available, but never return that
        // stale session as though it were durable.
        await this.#bestEffortDeleteSession(established.session.id);
        return this.#establish(user, null);
      }
      // Persistent login is best-effort; a valid password session still wins.
      return established;
    }
  }

  public async getSession(sessionId: string): Promise<AuthenticatedSession | null> {
    const session = await this.options.sessions.get(sessionId);
    if (session === null || new Date(session.expiresAt) <= this.options.clock.now()) {
      return null;
    }
    if (session.authEpoch !== await this.options.authStore.getAuthEpoch()) {
      await this.options.sessions.delete(session.id);
      return null;
    }
    const user = await this.options.authStore.findUserById(session.userId);
    if (user === null) {
      await this.options.sessions.delete(session.id);
      return null;
    }
    return { session, user, rememberCookie: null };
  }

  public async restoreRemember(cookieValue: string): Promise<AuthenticatedSession | null> {
    const parsed = parseRememberCookie(cookieValue);
    if (parsed === null) {
      return null;
    }
    const now = this.options.clock.now();
    const validator = randomBytes(32).toString("hex");
    const rotated = await this.options.authStore.restoreRememberToken({
      selector: parsed.selector,
      validatorHash: sha256(parsed.validator),
      rotatedValidatorHash: sha256(validator),
      now,
      expiresAt: new Date(now.getTime() + thirtyDaysSeconds * 1000),
    });
    if (rotated.status === "invalid") return null;

    const user = await this.options.authStore.findUserById(rotated.userId);
    if (user === null) {
      await this.#bestEffortDeleteRemember(parsed.selector);
      return null;
    }
    try {
      const established = await this.#establishAtEpoch(
        user,
        rotated.selector,
        rotated.authEpoch,
        now,
      );
      return { ...established, rememberCookie: `${rotated.selector}:${validator}` };
    } catch (error) {
      // Rotation committed, but the browser never received the new validator.
      // Remove the now-unusable token so repeated requests cannot loop on an
      // unacknowledged credential transition.
      await this.#bestEffortDeleteRemember(rotated.selector);
      throw error;
    }
  }

  public async resetAllSessions(
    session: SessionData,
    user: UserRecord,
  ): Promise<AuthenticatedSession> {
    if (session.userId !== user.id || user.role !== "admin") {
      throw new AppError("Administrator access is required.", 403, "ADMIN_REQUIRED");
    }
    const now = this.options.clock.now();
    const selector = randomBytes(12).toString("hex");
    const validator = randomBytes(32).toString("hex");
    const expiresAt = new Date(now.getTime() + thirtyDaysSeconds * 1000);
    let reset: { readonly authEpoch: number };
    try {
      reset = await this.options.authStore.resetAllAuthCredentials({
        adminUserId: user.id,
        selector,
        validatorHash: sha256(validator),
        expiresAt,
        createdAt: now,
      });
    } catch {
      await this.#bestEffortDeleteSession(session.id);
      throw new GlobalSessionResetError(
        "Global session reset could not be confirmed. For safety, sign in again and check before retrying.",
        "GLOBAL_SESSION_RESET_OUTCOME_UNKNOWN",
      );
    }

    const refreshed = this.#newSession(user, selector, reset.authEpoch, now);
    try {
      await this.options.sessions.set(refreshed, this.#sessionTtl);
    } catch {
      await Promise.all([
        this.#bestEffortDeleteRemember(selector),
        this.#bestEffortDeleteSession(session.id),
      ]);
      throw new GlobalSessionResetError(
        "Global session reset completed, but this browser could not be refreshed. Sign in again; do not repeat the reset.",
        "GLOBAL_SESSION_RESET_REFRESH_FAILED",
      );
    }
    await this.#bestEffortDeleteSession(session.id);
    return {
      session: refreshed,
      user,
      rememberCookie: `${selector}:${validator}`,
    };
  }

  public async logout(session: SessionData): Promise<void> {
    const rememberSelector = session.rememberSelector;
    const revocations = [
      Promise.resolve().then(async () => this.options.sessions.delete(session.id)),
      ...(rememberSelector === null
        ? []
        : [Promise.resolve().then(async () => this.options.authStore.deleteRememberToken(
            rememberSelector,
          ))]),
    ];
    const results = await Promise.allSettled(revocations);
    if (results.some((result) => result.status === "rejected")) {
      // The HTTP boundary still clears both browser cookies in a finally block.
      // Report the incomplete server-side revocation honestly, after every
      // independent backend has had its chance to revoke the credential.
      throw new AppError(
        "Server-side sign-out cleanup is temporarily incomplete.",
        503,
        "LOGOUT_REVOCATION_INCOMPLETE",
      );
    }
  }

  public signSessionId(sessionId: string, secret: string): string {
    const signature = createHmac("sha256", secret).update(sessionId).digest("hex");
    return `${sessionId}.${signature}`;
  }

  public verifySignedSessionId(value: string, secret: string): string | null {
    const match = /^([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(value);
    if (match === null) {
      return null;
    }
    const sessionId = match[1] ?? "";
    const supplied = Buffer.from(match[2] ?? "", "ascii");
    const expected = Buffer.from(createHmac("sha256", secret).update(sessionId).digest("hex"), "ascii");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected) ? sessionId : null;
  }

  async #establish(user: UserRecord, rememberSelector: string | null): Promise<AuthenticatedSession> {
    const now = this.options.clock.now();
    return this.#establishAtEpoch(
      user,
      rememberSelector,
      await this.options.authStore.getAuthEpoch(),
      now,
    );
  }

  async #establishAtEpoch(
    user: UserRecord,
    rememberSelector: string | null,
    authEpoch: number,
    now: Date,
  ): Promise<AuthenticatedSession> {
    const session = this.#newSession(user, rememberSelector, authEpoch, now);
    await this.options.sessions.set(session, this.#sessionTtl);
    return { session, user, rememberCookie: null };
  }

  #newSession(
    user: UserRecord,
    rememberSelector: string | null,
    authEpoch: number,
    now: Date,
  ): SessionData {
    const expiresAt = new Date(now.getTime() + this.#sessionTtl * 1000);
    return {
      id: randomBytes(32).toString("hex"),
      userId: user.id,
      csrfToken: randomBytes(32).toString("hex"),
      uploadScope: randomBytes(32).toString("hex"),
      authEpoch,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      rememberSelector,
    };
  }

  #ipHash(ip: string): string {
    return sha256(`${ip}|${this.options.ipHashSecret}`);
  }

  async #bestEffortDeleteRemember(selector: string): Promise<void> {
    try {
      await this.options.authStore.deleteRememberToken(selector);
    } catch {
      // Authentication/logout correctness does not depend on cleanup succeeding.
    }
  }

  async #bestEffortDeleteSession(sessionId: string): Promise<void> {
    try {
      await this.options.sessions.delete(sessionId);
    } catch {
      // auth_epoch is authoritative; stale Redis rows cannot authenticate.
    }
  }
}

function parseRememberCookie(value: string): { selector: string; validator: string } | null {
  const match = /^([a-f0-9]{24}):([a-f0-9]{64})$/.exec(value);
  return match === null ? null : { selector: match[1] ?? "", validator: match[2] ?? "" };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function registrationStore(
  store: AuthStore & Partial<PublicRegistrationStore>,
): PublicRegistrationStore | null {
  return typeof store.isRegistrationEnabled === "function"
    && typeof store.usernameExists === "function"
    && typeof store.createUser === "function"
    ? store as PublicRegistrationStore
    : null;
}

function registrationUnavailable(): AppError {
  return new AppError(
    "Sign-up is temporarily unavailable. Please try again later.",
    503,
    "REGISTRATION_UNAVAILABLE",
  );
}

function registrationAppError(error: RegistrationError): AppError {
  switch (error.code) {
    case "INVALID_USERNAME":
    case "INVALID_PASSWORD":
    case "PASSWORD_MISMATCH":
      return new AppError(error.message, 422, error.code);
    case "USERNAME_TAKEN":
      return new AppError(error.message, 409, error.code);
    case "REGISTRATION_FAILED":
      return new AppError(error.message, 503, error.code);
  }
}
