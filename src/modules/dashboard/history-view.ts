import type { DomainRegistry } from "../../config/domain-registry.js";
import { escapeHtml } from "../../web/escape.js";
import { renderLinkCard } from "./link-card.js";
import type { DashboardSnapshot } from "./history-service.js";

export function renderDashboardHistory(snapshot: DashboardSnapshot, registry: DomainRegistry): string {
  const { pagination } = snapshot;
  const cards = snapshot.links.length === 0
    ? `<p id="emptyState" class="empty-state">${pagination.query === ""
      ? "No links yet. Create your first one above."
      : "No links match your search."}</p>`
    : snapshot.links.map((row) => renderLinkCard(row.link, registry, {
      countedClicks: row.countedClicks,
    })).join("");
  const querySummary = pagination.query === ""
    ? ""
    : `<p class="history-query-summary">${formatCounter(BigInt(pagination.matchCount))} result${pagination.matchCount === 1 ? "" : "s"} for “<strong>${escapeHtml(pagination.query)}</strong>”</p>`;

  return `<aside class="session-panel history-panel" aria-labelledby="history-title">
  ${renderDashboardSummary(snapshot)}
  <div class="panel-heading history-heading"><div><p class="eyebrow">Account history</p><h2 id="history-title">All short links</h2></div><span class="count-pill" title="New links created in this browser session"><span id="sessionLinkCount">0</span> new</span></div>
  <p class="panel-note">Showing current database history for your account. Search matches title, destination or short code literally.</p>
  <form method="get" action="/index.php" class="history-search">
    <label class="sr-only" for="historyQuery">Search links</label>
    <input id="historyQuery" name="q" value="${escapeHtml(pagination.query)}" placeholder="Search links" autocomplete="off">
    <label class="sr-only" for="historyPerPage">Links per page</label>
    <select id="historyPerPage" name="per">${[20, 50, 100].map((size) => `<option value="${size}"${size === pagination.perPage ? " selected" : ""}>${size} / page</option>`).join("")}</select>
    <button class="button quiet" type="submit">Search</button>
    ${pagination.query === "" ? "" : '<a class="button quiet" href="/index.php">Clear</a>'}
  </form>
  ${querySummary}
  <div id="linksListContainer" class="links-list">${cards}</div>
  ${renderPagination(snapshot)}
</aside>`;
}

function renderDashboardSummary(snapshot: DashboardSnapshot): string {
  const community = snapshot.community === null
    ? ""
    : `<article><span>Regular-user clicks</span><strong>${formatCounter(snapshot.community.totalClicks)}</strong><small>${formatCounter(snapshot.community.clicksToday)} today</small></article>`;
  return `<section class="dashboard-summary" aria-label="Dashboard totals">
    <article><span>Your links</span><strong>${formatCounter(snapshot.stats.totalLinks)}</strong><small>Current account</small></article>
    <article><span>Your counted clicks</span><strong>${formatCounter(snapshot.stats.totalClicks)}</strong><small>${formatCounter(snapshot.stats.clicksToday)} today</small></article>
    ${community}
  </section>`;
}

function renderPagination(snapshot: DashboardSnapshot): string {
  const { pagination } = snapshot;
  if (pagination.totalPages <= 1) return "";
  const items: string[] = [];
  items.push(pagination.page > 1
    ? pageLink(snapshot, pagination.page - 1, "Previous", "‹")
    : '<span class="page-link disabled" aria-disabled="true"><span aria-hidden="true">‹</span><span class="sr-only">Previous</span></span>');

  let ellipsis = false;
  for (let page = 1; page <= pagination.totalPages; page += 1) {
    const edge = page === 1 || page === pagination.totalPages;
    const near = page >= pagination.page - 2 && page <= pagination.page + 2;
    if (!edge && !near) {
      if (!ellipsis) items.push('<span class="page-gap" aria-hidden="true">…</span>');
      ellipsis = true;
      continue;
    }
    ellipsis = false;
    items.push(page === pagination.page
      ? `<span class="page-link active" aria-current="page">${page}</span>`
      : pageLink(snapshot, page, `Page ${page}`, String(page)));
  }

  items.push(pagination.page < pagination.totalPages
    ? pageLink(snapshot, pagination.page + 1, "Next", "›")
    : '<span class="page-link disabled" aria-disabled="true"><span aria-hidden="true">›</span><span class="sr-only">Next</span></span>');

  return `<nav class="history-pagination" aria-label="Link history pages"><span>Page ${pagination.page} of ${pagination.totalPages} · ${formatCounter(BigInt(pagination.matchCount))} link${pagination.matchCount === 1 ? "" : "s"}</span><div>${items.join("")}</div></nav>`;
}

function pageLink(snapshot: DashboardSnapshot, page: number, label: string, text: string): string {
  const params = new URLSearchParams({ page: String(page), per: String(snapshot.pagination.perPage) });
  if (snapshot.pagination.query !== "") params.set("q", snapshot.pagination.query);
  const visible = /^[0-9]+$/.test(text) ? text : `<span aria-hidden="true">${text}</span><span class="sr-only">${label}</span>`;
  return `<a class="page-link" href="/index.php?${escapeHtml(params.toString())}" aria-label="${escapeHtml(label)}">${visible}</a>`;
}

function formatCounter(value: bigint): string {
  return new Intl.NumberFormat("en-IN").format(value);
}
