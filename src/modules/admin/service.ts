import { AppError } from "../../core/errors.js";
import type { DomainPolicy } from "../../core/types.js";
import type { DomainRegistry } from "../../config/domain-registry.js";
import type {
  CacheStore,
  Clock,
  DomainStore,
  PublicRegistrationStore,
} from "../../ports.js";
import {
  RegistrationError,
  RegistrationService,
  type RegisteredAccount,
} from "../auth/registration.js";
import {
  dashboardCommunityStatsCacheKey,
  dashboardOwnStatsCacheKey,
} from "../dashboard/history-service.js";
import {
  type AdminReportService,
  type AdminReportSnapshot,
} from "../reporting/admin-report-service.js";
import type { AdminReportRange } from "../reporting/report-window.js";
import { selectManageableDomain } from "./domain-selection-policy.js";
import { validateGeoQualitySave } from "./geo-quality-policy.js";
import { validateSkimSettings } from "./skim-settings-policy.js";
import type {
  AdminControlPlaneStore,
  AdminDomainState,
  AdminUserSummary,
} from "./store.js";

export interface AdminSnapshot {
  readonly domains: readonly DomainPolicy[];
  readonly selectedDomainId: number;
  readonly domainState: AdminDomainState;
  readonly registrationEnabled: boolean;
  readonly users: readonly AdminUserSummary[];
  readonly report: AdminReportSnapshot | null;
}

export interface AdminServiceOptions {
  readonly domains: DomainStore;
  readonly controlPlane: AdminControlPlaneStore;
  readonly registration: PublicRegistrationStore;
  readonly cache: CacheStore;
  readonly registry: DomainRegistry;
  readonly clock: Clock;
  readonly appNamespace: string;
  readonly reporting?: AdminReportService | undefined;
}

export class AdminService {
  readonly #namespace: string;

  public constructor(private readonly options: AdminServiceOptions) {
    this.#namespace = options.appNamespace.replace(/:+$/, "");
    if (!/^[A-Za-z0-9:_-]{1,128}$/.test(this.#namespace)) {
      throw new Error("Admin service requires an explicit cache-key prefix.");
    }
  }

  public async load(
    requestedDomainId: unknown,
    reportRange: AdminReportRange | null = null,
  ): Promise<AdminSnapshot> {
    const selected = await this.#selectDomain(requestedDomainId);
    const selectedDomain = selected.domains.find((domain) => domain.id === selected.domainId);
    if (selectedDomain === undefined) {
      throw new AppError(
        "Admin domain configuration is temporarily unavailable.",
        503,
        "ADMIN_DOMAIN_IDENTITY_MISMATCH",
      );
    }
    if (reportRange !== null && this.options.reporting === undefined) {
      throw new AppError(
        "Admin traffic history is temporarily unavailable. No false zero is shown.",
        503,
        "ADMIN_REPORT_UNAVAILABLE",
      );
    }
    const [domainState, registrationEnabled, users, report] = await Promise.all([
      this.options.controlPlane.loadDomainState(selected.domainId),
      this.options.registration.isRegistrationEnabled(),
      this.options.controlPlane.listUsers(),
      reportRange === null
        ? Promise.resolve(null)
        : this.options.reporting!.load(selectedDomain, reportRange),
    ]);
    return {
      domains: selected.domains,
      selectedDomainId: selected.domainId,
      domainState,
      registrationEnabled,
      users,
      report,
    };
  }

  public async requireManageableDomain(requestedDomainId: unknown): Promise<number> {
    return (await this.#selectDomain(requestedDomainId)).domainId;
  }

  public async saveSkim(requestedDomainId: unknown, input: unknown): Promise<number> {
    const selected = await this.#selectDomain(requestedDomainId);
    const candidate = validateSkimSettings(input);
    if (!candidate.ok) {
      throw new AppError(candidate.message, 422, candidate.code.toUpperCase());
    }
    await this.options.controlPlane.saveSkimSettings(selected.domainId, candidate.value);
    await this.#bestEffortDelete([
      "skim_enabled",
      "skim_destination_url",
      "skim_default_percent",
    ].map((key) => this.#key(`domain:${selected.domainId}:set:${key}`)));
    return selected.domainId;
  }

  public async saveGeo(requestedDomainId: unknown, input: unknown): Promise<number> {
    const selected = await this.#selectDomain(requestedDomainId);
    const candidate = validateGeoQualitySave(input);
    if (!candidate.ok) {
      throw new AppError(candidate.message, 422, candidate.code.toUpperCase());
    }
    await this.options.controlPlane.saveGeoQuality(selected.domainId, candidate.value);
    await this.#bestEffortDelete([
      this.#key(`domain:${selected.domainId}:georules`),
      this.#key(`domain:${selected.domainId}:set:skim_quality_policy_v1`),
    ]);
    return selected.domainId;
  }

  public async addUser(
    requestedDomainId: unknown,
    request: { readonly username: string; readonly password: string; readonly password2: string },
  ): Promise<{ readonly domainId: number; readonly account: RegisteredAccount }> {
    const selected = await this.#selectDomain(requestedDomainId);
    try {
      const account = await new RegistrationService({
        store: this.options.registration,
        clock: this.options.clock,
      }).register({
        username: request.username,
        password: request.password,
        passwordConfirmation: request.password2,
      });
      return { domainId: selected.domainId, account };
    } catch (error) {
      if (!(error instanceof RegistrationError)) throw error;
      switch (error.code) {
        case "INVALID_USERNAME":
        case "INVALID_PASSWORD":
        case "PASSWORD_MISMATCH":
          throw new AppError(error.message, 422, error.code);
        case "USERNAME_TAKEN":
          throw new AppError(error.message, 409, error.code);
        case "REGISTRATION_FAILED":
          throw new AppError(error.message, 503, error.code);
      }
    }
  }

  public async deleteUser(
    requestedDomainId: unknown,
    userId: number,
  ): Promise<number> {
    const selected = await this.#selectDomain(requestedDomainId);
    const result = await this.options.controlPlane.deleteRegularUser(userId);
    switch (result.status) {
      case "not_found":
        throw new AppError("User not found.", 404, "USER_NOT_FOUND");
      case "admin":
        throw new AppError("Admins cannot be deleted from here.", 422, "ADMIN_DELETE_FORBIDDEN");
      case "protected_role":
        throw new AppError("Only standard user accounts can be deleted here.", 422, "ROLE_DELETE_FORBIDDEN");
      case "uploads_present":
        throw new AppError(
          "This user still has uploaded images. Cleanup must be reviewed before deleting the account.",
          409,
          "USER_UPLOADS_PRESENT",
        );
      case "deleted": {
        const keys = [
          dashboardOwnStatsCacheKey(this.#namespace, result.userId),
          dashboardCommunityStatsCacheKey(this.#namespace),
          ...result.links.flatMap((link) => [
            this.#key(`domain:${link.domainId}:link:${link.code}`),
            this.#key(`domain:${link.domainId}:og:${link.code}`),
          ]),
        ];
        await this.#bestEffortDelete(keys);
        return selected.domainId;
      }
    }
  }

  public async saveRegistration(
    requestedDomainId: unknown,
    enabled: boolean,
  ): Promise<number> {
    const selected = await this.#selectDomain(requestedDomainId);
    await this.options.controlPlane.setRegistrationEnabled(enabled);
    await this.#bestEffortDelete([this.#key("set:registration_enabled")]);
    return selected.domainId;
  }

  async #selectDomain(requestedDomainId: unknown): Promise<{
    readonly domainId: number;
    readonly domains: readonly DomainPolicy[];
  }> {
    const observed = await this.options.domains.listManageableDomains();
    const domains = verifyManageableDomains(observed, this.options.registry);
    const result = selectManageableDomain(domains.map((domain) => domain.id), requestedDomainId);
    if (!result.ok) {
      const statusCode = result.code === "invalid_domain_selection" ? 400 : 503;
      throw new AppError(result.message, statusCode, result.code.toUpperCase());
    }
    return { domainId: result.value.domainId, domains };
  }

  #key(suffix: string): string {
    return `${this.#namespace}:${suffix}`;
  }

  async #bestEffortDelete(keys: readonly string[]): Promise<void> {
    const unique = [...new Set(keys)];
    for (let offset = 0; offset < unique.length; offset += 100) {
      try {
        await this.options.cache.delete(...unique.slice(offset, offset + 100));
      } catch {
        // MariaDB is authoritative. A cache error must not turn a committed
        // Admin mutation into an unsafe retry instruction.
      }
    }
  }
}

/**
 * MariaDB and the artifact registry must describe the same complete set. This
 * includes inactive configured domains so Admin never silently edits another
 * domain after an identity drift.
 */
export function verifyManageableDomains(
  observed: readonly DomainPolicy[],
  registry: DomainRegistry,
): readonly DomainPolicy[] {
  const expected = registry.all();
  if (observed.length !== expected.length
    || new Set(observed.map((domain) => domain.id)).size !== observed.length) {
    throw new AppError(
      "Admin domain configuration is temporarily unavailable.",
      503,
      "ADMIN_DOMAIN_IDENTITY_MISMATCH",
    );
  }
  const byId = new Map(observed.map((domain) => [domain.id, domain]));
  for (const definition of expected) {
    const policy = byId.get(definition.id);
    if (policy === undefined
      || policy.domainKey !== definition.key
      || policy.hostname !== definition.canonicalHost
      || policy.label !== definition.label
      || policy.surface !== definition.surface
      || policy.active !== definition.active
      || policy.allowCreate !== definition.allowCreate
      || policy.diversionCampaign !== definition.diversionCampaign
      || policy.reportTimezone !== definition.reportTimezone) {
      throw new AppError(
        "Admin domain configuration is temporarily unavailable.",
        503,
        "ADMIN_DOMAIN_IDENTITY_MISMATCH",
      );
    }
  }
  return Object.freeze([...observed].sort((left, right) => left.id - right.id));
}
