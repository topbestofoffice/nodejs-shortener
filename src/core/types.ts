export type DomainSurface = "dashboard" | "redirect";

export interface DomainDefinition {
  readonly id: number;
  readonly key: string;
  readonly diversionCampaign: string;
  readonly reportTimezone: "UTC" | "Asia/Kolkata";
  readonly canonicalHost: string;
  readonly aliases: readonly string[];
  readonly label: string;
  readonly surface: DomainSurface;
  readonly active: boolean;
  readonly allowCreate: boolean;
  readonly publicBaseUrl: string;
  readonly imageBaseUrl: string;
  readonly emitLocalImageAlt: boolean;
  readonly compactNoImagePreview: boolean;
  readonly creationFallback: boolean;
  readonly acceptUnprovenDeliveredClaim: boolean;
}

export interface DomainContext {
  readonly definition: DomainDefinition;
  readonly requestHost: string;
  readonly isCanonical: boolean;
}

export interface DomainPolicy {
  readonly id: number;
  readonly domainKey: string;
  readonly hostname: string;
  readonly label: string;
  readonly surface: DomainSurface;
  readonly active: boolean;
  readonly allowCreate: boolean;
  readonly diversionCampaign: string;
  readonly reportTimezone: "UTC" | "Asia/Kolkata";
}

export interface LinkRecord {
  readonly id: string;
  readonly domainId: number;
  readonly code: string;
  readonly userId: number;
  readonly destination: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly image: string | null;
  /** True when the persisted recent_activity_epochs column is non-null. */
  readonly compactActivityTracked?: boolean;
  readonly authorRole: string;
  readonly domainHostname: string;
  readonly domainLabel: string;
  readonly diversionCampaign: string;
  readonly createdAt: Date;
}

export type FilterReason = "meta" | "aws_dc" | "fbclid_replay" | "other";
export type AccountingOutcome = "delivered" | "diverted" | "filtered_meta" | "filtered_bot" | "filtered_other";

export interface LinkAccountingEvent {
  readonly linkId: string;
  readonly domainId: number;
  readonly outcome: AccountingOutcome;
  readonly country: string | null;
  readonly occurredAt: Date;
  /** Exact PHP condition: persisted compact ring or case-sensitive uploads/ image prefix. */
  readonly trackRecentActivity: boolean;
}

export type DeliveredCountryGapReason = "claim" | "accounting" | "observer" | "config";

export interface DeliveredCountryObservation {
  readonly domainId: number;
  readonly country: string | null;
  readonly occurredAt: Date;
}

export interface DeliveredCountryGapEvent {
  readonly domainId: number;
  readonly reason: DeliveredCountryGapReason;
  readonly occurredAt: Date;
}

export type DeliveredCountryBucketStatus = "complete" | "complete_zero" | "incomplete";
export type DeliveredCountryProvenance = "redis_nonempty" | "verified_zero" | "health_incomplete";

export interface DeliveredCountryStateRow {
  readonly domainId: number;
  readonly bucketStart: Date;
  readonly status: DeliveredCountryBucketStatus;
  readonly deliveredTotal: bigint | null;
  readonly provenance: DeliveredCountryProvenance;
  readonly sourceSha256: string;
  readonly redisRunIdSha256: string | null;
  readonly reasonCode: string | null;
  readonly recordedAt: Date;
}

export interface DeliveredCountryHistoryRow {
  readonly domainId: number;
  readonly bucketStart: Date;
  readonly country: string;
  /** NULL is valid for a diversion/filter-only country row. */
  readonly delivered: bigint | null;
}

export interface DeliveredCountryWindowRows {
  readonly states: readonly DeliveredCountryStateRow[];
  readonly history: readonly DeliveredCountryHistoryRow[];
}

export interface CreateLinkInput {
  readonly domainId: number;
  readonly userId: number;
  readonly destination: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly image: string | null;
  readonly imageSessionScopeHash: string | null;
  /** Required for a managed upload; null for no image or an external URL. */
  readonly imageOwnershipExpiresAt: Date | null;
  readonly code: string;
  readonly createdAt: Date;
}

export interface UserRecord {
  readonly id: number;
  readonly username: string;
  readonly passwordHash: string;
  readonly role: string;
  readonly defaultDomainId: number | null;
  readonly createdAt: Date;
}

export interface RememberTokenRecord {
  readonly id: string;
  readonly userId: number;
  readonly selector: string;
  readonly validatorHash: string;
  readonly expiresAt: Date;
}

export interface SessionData {
  readonly id: string;
  readonly userId: number;
  readonly csrfToken: string;
  readonly uploadScope: string;
  readonly authEpoch: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly rememberSelector: string | null;
}

export interface RegisterUploadInput {
  readonly path: string;
  readonly userId: number;
  readonly sessionScopeHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}
