export interface ManageableDomainSelection {
  readonly domainId: number;
  readonly usedDefault: boolean;
}

export type ManageableDomainSelectionError =
  | "invalid_manageable_domain_configuration"
  | "no_manageable_domains"
  | "invalid_domain_selection";

export type ManageableDomainSelectionResult =
  | { readonly ok: true; readonly value: ManageableDomainSelection }
  | {
      readonly ok: false;
      readonly code: ManageableDomainSelectionError;
      readonly message: string;
    };

/**
 * Select a domain only from the caller's already-authoritative manageable set.
 * A bad explicit selection never falls back to another domain: that would let
 * an Admin POST mutate the wrong domain.
 */
export function selectManageableDomain(
  manageableDomainIds: readonly number[],
  requestedDomainId: unknown,
): ManageableDomainSelectionResult {
  if (manageableDomainIds.some((id) => !isDomainId(id))
    || new Set(manageableDomainIds).size !== manageableDomainIds.length) {
    return failure(
      "invalid_manageable_domain_configuration",
      "Manageable domain configuration is invalid.",
    );
  }

  if (manageableDomainIds.length === 0) {
    return failure("no_manageable_domains", "No configured short-link domain is available.");
  }

  const sortedIds = [...manageableDomainIds].sort((left, right) => left - right);
  if (requestedDomainId === undefined || requestedDomainId === null) {
    return {
      ok: true,
      value: Object.freeze({ domainId: sortedIds[0] as number, usedDefault: true }),
    };
  }

  const parsed = parseDomainId(requestedDomainId);
  if (parsed === null || !sortedIds.includes(parsed)) {
    return failure("invalid_domain_selection", "Choose a valid short-link domain.");
  }

  return {
    ok: true,
    value: Object.freeze({ domainId: parsed, usedDefault: false }),
  };
}

function parseDomainId(value: unknown): number | null {
  if (typeof value === "number") {
    return isDomainId(value) ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9]\d{0,4}$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return isDomainId(parsed) ? parsed : null;
}

function isDomainId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function failure(
  code: ManageableDomainSelectionError,
  message: string,
): ManageableDomainSelectionResult {
  return { ok: false, code, message };
}
