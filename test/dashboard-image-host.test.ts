import { describe, expect, it } from "vitest";
import { DomainRegistry } from "../src/config/domain-registry.js";
import type { LinkRecord } from "../src/core/types.js";
import { renderLinkCard } from "../src/modules/dashboard/link-card.js";

describe("dashboard image host", () => {
  it("uses imageBaseUrl for a managed image while preserving the public short host", () => {
    const registry = new DomainRegistry([{
      id: 1,
      key: "control",
      canonicalHost: "manage.example",
      aliases: [],
      label: "Manage",
      surface: "dashboard",
      active: true,
      allowCreate: true,
      publicBaseUrl: "https://manage.example",
      imageBaseUrl: "https://images.example",
      emitLocalImageAlt: false,
    }]);
    const link: LinkRecord = {
      id: "1",
      domainId: 1,
      code: "Ab12",
      userId: 1,
      destination: "https://destination.example/path",
      title: "Title",
      description: null,
      image: "uploads/0123456789abcdef.jpg",
      authorRole: "user",
      domainHostname: "manage.example",
      domainLabel: "Manage",
      diversionCampaign: "control",
      createdAt: new Date("2026-09-01T00:00:00Z"),
    };

    const html = renderLinkCard(link, registry);
    expect(html).toContain("https://manage.example/Ab12");
    expect(html).toContain("https://images.example/uploads/0123456789abcdef.jpg");
    expect(html).not.toContain("https://manage.example/uploads/0123456789abcdef.jpg");
    expect(html).toContain('data-copy-link');
    expect(html).toContain('aria-label="Copy short link"');
    expect(html).toContain('data-delete-link');
    expect(html).toContain('aria-label="More actions for https://manage.example/Ab12"');
    expect(html).toContain('aria-label="0 counted clicks"');
    expect(html).toContain('class="link-meta" title="https://destination.example/path"');
    expect(html).not.toContain("onclick=");
  });

  it("renders a persisted counted-click total without losing bigint precision", () => {
    const registry = new DomainRegistry([{
      id: 1,
      key: "control",
      canonicalHost: "manage.example",
      aliases: [],
      label: "Manage",
      surface: "dashboard",
      active: true,
      allowCreate: true,
      publicBaseUrl: "https://manage.example",
      imageBaseUrl: "https://images.example",
      emitLocalImageAlt: false,
    }]);
    const link: LinkRecord = {
      id: "1",
      domainId: 1,
      code: "Ab12",
      userId: 1,
      destination: "https://destination.example/path",
      title: null,
      description: null,
      image: null,
      authorRole: "user",
      domainHostname: "manage.example",
      domainLabel: "Manage",
      diversionCampaign: "control",
      createdAt: new Date("2026-09-01T00:00:00Z"),
    };

    const html = renderLinkCard(link, registry, { countedClicks: 9_007_199_254_740_993n });
    expect(html).toContain('aria-label="9,00,71,99,25,47,40,993 counted clicks"');
    expect(html).toContain('<span class="link-clicks-value">9,00,71,99,25,47,40,993</span>');
  });
});
