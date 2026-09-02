import { describe, expect, it } from "vitest";
import { DomainRegistry } from "../src/config/domain-registry.js";
import type { LinkRecord } from "../src/core/types.js";
import type { DashboardSnapshot } from "../src/modules/dashboard/history-service.js";
import { renderDashboardHistory } from "../src/modules/dashboard/history-view.js";
import { destinationPreview } from "../src/modules/dashboard/link-card.js";

const registry = new DomainRegistry([{
  id: 1,
  key: "short",
  canonicalHost: "short.example",
  aliases: [],
  label: "Short",
  surface: "dashboard",
  active: true,
  allowCreate: true,
  publicBaseUrl: "https://short.example",
  imageBaseUrl: "https://short.example",
  emitLocalImageAlt: false,
  compactNoImagePreview: false,
}]);

describe("dashboard history view", () => {
  it("renders persisted owner-scoped cards, truthful counters and safe GET controls", () => {
    const html = renderDashboardHistory(snapshot({
      query: '<script>&_%',
      matchCount: 41,
      page: 2,
      totalPages: 3,
      offset: 20,
    }, [historyLink(12_345n)]), registry);

    expect(html).toContain("All short links");
    expect(html).toContain("1,234");
    expect(html).toContain("1,111");
    expect(html).toContain('id="historyQuery"');
    expect(html).toContain('value="&lt;script&gt;&amp;_%"');
    expect(html).not.toContain('value="<script>');
    expect(html).toContain('aria-label="12,345 counted clicks"');
    expect(html).toContain('Page 2 of 3 · 41 links');
    expect(html).toContain('href="/index.php?page=3&amp;per=20&amp;q=%3Cscript%3E%26_%25"');
    expect(html).not.toContain("onclick=");
  });

  it("shows an honest search-empty state and omits optional community totals", () => {
    const input = snapshot({ query: "missing", matchCount: 0, page: 1, totalPages: 1, offset: 0 }, []);
    const html = renderDashboardHistory({ ...input, community: null }, registry);
    expect(html).toContain("No links match your search.");
    expect(html).not.toContain("Regular-user clicks");
    expect(html).not.toContain("history-pagination");
  });

  it("degrades malformed legacy destinations and dates without failing the history page", () => {
    for (const malformed of ["", "http://%", "https://[::1", "https://999.999.999.999/"]) {
      expect(() => destinationPreview(malformed)).not.toThrow();
    }
    const legacy = historyLink(1n);
    const html = renderDashboardHistory(snapshot(
      { query: "", matchCount: 1, page: 1, totalPages: 1, offset: 0 },
      [{
        ...legacy,
        link: {
          ...legacy.link,
          destination: "http://%",
          createdAt: new Date(Number.NaN),
        },
      }],
    ), registry);

    expect(html).toContain("http://%");
    expect(html).toContain("Date unavailable");
  });

  it("keeps good rows visible when one legacy row references an unconfigured domain", () => {
    const good = historyLink(7n);
    const missingDomain = historyLink(9n);
    const html = renderDashboardHistory(snapshot(
      { query: "", matchCount: 2, page: 1, totalPages: 1, offset: 0 },
      [good, {
        ...missingDomain,
        link: {
          ...missingDomain.link,
          id: "10",
          domainId: 999,
          code: "Legacy9",
          title: "Legacy domain row",
          domainHostname: "retired.example",
          domainLabel: "Retired",
        },
      }],
    ), registry);

    expect(html).toContain("https://short.example/Ab9");
    expect(html).toContain("Legacy domain row");
    expect(html).toContain("Unavailable domain · Legacy9");
    expect(html).toContain('data-domain-unavailable="true"');
    expect(html).not.toContain("https://retired.example/Legacy9");
    expect(html).not.toContain('data-code="Legacy9"');
  });
});

function snapshot(
  pagination: { query: string; matchCount: number; page: number; totalPages: number; offset: number },
  links: DashboardSnapshot["links"],
): DashboardSnapshot {
  return {
    stats: { totalLinks: 1_234n, totalClicks: 9_999n, clicksToday: 88n },
    community: { totalClicks: 1_111n, clicksToday: 22n },
    pagination: {
      ...pagination,
      perPage: 20,
      requestedPage: pagination.page,
    },
    links,
  };
}

function historyLink(countedClicks: bigint): DashboardSnapshot["links"][number] {
  const link: LinkRecord = {
    id: "9",
    domainId: 1,
    code: "Ab9",
    userId: 4,
    destination: "https://destination.example/article",
    title: "Article",
    description: "Description",
    image: null,
    authorRole: "user",
    domainHostname: "short.example",
    domainLabel: "Short",
    diversionCampaign: "short",
    createdAt: new Date("2026-09-01T00:00:00Z"),
  };
  return {
    link,
    countedClicks,
    divertedClicks: 0n,
    filteredMetaClicks: 0n,
    filteredBotClicks: 0n,
    filteredOtherClicks: 0n,
    todayClicks: 0n,
    todayClickDate: null,
    lastActivityAt: null,
  };
}
