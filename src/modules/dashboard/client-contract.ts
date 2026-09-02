export type CreateResponseKind = "ok" | "retryable_precommit" | "uncertain" | "application_failure";
export type BulkAnalyticsResult = "success" | "partial" | "failure";

export interface BulkMutationCounts {
  readonly created?: unknown;
  readonly failed?: unknown;
}

export function classifyCreateResponse(status: number, payload: unknown): CreateResponseKind {
  if (status >= 200 && status < 300 && isRecord(payload) && payload.ok === true) {
    return "ok";
  }
  if (status === 429 && isExactImageBusyPrecommit(payload)) {
    return "retryable_precommit";
  }
  if (status === 408 || status === 429 || status >= 500) {
    return "uncertain";
  }
  return "application_failure";
}

export function bulkCreateCompleted(value: BulkMutationCounts): boolean {
  const counts = normalizedBulkCounts(value);
  return counts.created > 0 && counts.failed === 0;
}

export function bulkCreateAnalyticsResult(value: BulkMutationCounts): BulkAnalyticsResult {
  const counts = normalizedBulkCounts(value);
  if (counts.created <= 0) return "failure";
  return counts.failed === 0 ? "success" : "partial";
}

export function countBucket(rawValue: unknown): "0" | "1" | "2_5" | "6_20" | "21_100" | "101_plus" {
  const value = normalizedCount(rawValue);
  if (value === 0) return "0";
  if (value === 1) return "1";
  if (value <= 5) return "2_5";
  if (value <= 20) return "6_20";
  if (value <= 100) return "21_100";
  return "101_plus";
}

function isExactImageBusyPrecommit(value: unknown): boolean {
  return isRecord(value)
    && value.ok === false
    && value.failure_code === "image_processor_busy"
    && value.link_committed === false
    && value.retryable === true;
}

function normalizedBulkCounts(value: BulkMutationCounts): { readonly created: number; readonly failed: number } {
  return {
    created: normalizedCount(value.created),
    failed: normalizedCount(value.failed),
  };
}

function normalizedCount(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return 0;
  if (typeof value === "string" && !/^\d+$/.test(value.trim())) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
