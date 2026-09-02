export const dashboardPageSizes = [20, 50, 100] as const;

export type DashboardPageSize = (typeof dashboardPageSizes)[number];

export interface DashboardHistoryRequest {
  readonly query: string;
  readonly perPage: DashboardPageSize;
  readonly requestedPage: number;
}

export interface DashboardPagination extends DashboardHistoryRequest {
  readonly matchCount: number;
  readonly page: number;
  readonly totalPages: number;
  readonly offset: number;
}

/**
 * Normalize the dashboard's GET-only search controls. Invalid page-size and
 * page values fall back to the same safe defaults as the PHP control plane.
 */
export function parseDashboardHistoryRequest(input: unknown): DashboardHistoryRequest {
  const query = scalarString(field(input, "q")).trim();
  const requestedPerPage = strictPositiveInteger(field(input, "per"));
  const perPage = dashboardPageSizes.includes(requestedPerPage as DashboardPageSize)
    ? requestedPerPage as DashboardPageSize
    : 20;
  const requestedPage = strictPositiveInteger(field(input, "page"));

  return {
    query,
    perPage,
    requestedPage: requestedPage === 0 ? 1 : requestedPage,
  };
}

/** Escape MariaDB/SQLite LIKE wildcards using the PHP contract's `!` escape. */
export function escapeDashboardLikeLiteral(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

/**
 * Clamp a requested page to current database truth. The link-count query must
 * run before this function; a cached dashboard summary is not a pagination
 * source because another browser session may have created/deleted a link.
 */
export function resolveDashboardPagination(
  request: DashboardHistoryRequest,
  rawMatchCount: number,
): DashboardPagination {
  const matchCount = Number.isSafeInteger(rawMatchCount) && rawMatchCount >= 0
    ? rawMatchCount
    : 0;
  const totalPages = Math.max(1, Math.ceil(matchCount / request.perPage));
  const page = Math.min(request.requestedPage, totalPages);

  return {
    ...request,
    matchCount,
    page,
    totalPages,
    offset: (page - 1) * request.perPage,
  };
}

function field(input: unknown, key: string): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  return (input as Record<string, unknown>)[key];
}

function scalarString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strictPositiveInteger(value: unknown): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return 0;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : 0;
}
