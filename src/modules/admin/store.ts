import type { CountryQualityPolicy } from "../redirect/policy.js";
import type { GeoRuleCandidate } from "./geo-quality-policy.js";
import type { SkimSettingsCandidate } from "./skim-settings-policy.js";

export interface AdminDomainState {
  readonly skim: SkimSettingsCandidate;
  readonly geoRules: readonly GeoRuleCandidate[];
  readonly qualityPolicy: CountryQualityPolicy;
}

export interface AdminUserSummary {
  readonly id: number;
  readonly username: string;
  readonly role: string;
  readonly createdAt: Date;
  readonly linkCount: bigint;
  readonly clickCount: bigint;
}

export interface AdminDeletedLinkIdentity {
  readonly domainId: number;
  readonly code: string;
}

export type AdminDeleteUserResult =
  | {
      readonly status: "deleted";
      readonly userId: number;
      readonly links: readonly AdminDeletedLinkIdentity[];
    }
  | { readonly status: "not_found" }
  | { readonly status: "admin" }
  | { readonly status: "protected_role" }
  | { readonly status: "uploads_present" };

/**
 * Control-plane persistence deliberately shares the application's existing
 * MariaDB pool. Reporting and global-session-reset methods can be added to
 * this adapter later without creating a second connection owner.
 */
export interface AdminControlPlaneStore {
  loadDomainState(domainId: number): Promise<AdminDomainState>;
  saveSkimSettings(domainId: number, candidate: SkimSettingsCandidate): Promise<void>;
  saveGeoQuality(domainId: number, candidate: {
    readonly rules: readonly GeoRuleCandidate[];
    readonly qualityPolicy: CountryQualityPolicy;
  }): Promise<void>;
  listUsers(): Promise<readonly AdminUserSummary[]>;
  setRegistrationEnabled(enabled: boolean): Promise<void>;
  deleteRegularUser(userId: number): Promise<AdminDeleteUserResult>;
}
