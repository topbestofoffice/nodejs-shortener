import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("dashboard persisted-card client contract", () => {
  it("loads server-rendered lazy images and keeps the session count scoped to newly prepended cards", async () => {
    const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
    expect(source).toContain("observeImages(shell);");
    expect(source).toContain('card.dataset.sessionCreated = "true";');
    expect(source).toContain('card.dataset.sessionCreated === "true"');
    expect(source).toContain("if (createdInSession) updateSessionCount(-1);");
    expect(source).toContain('if (preferenceScope === "browser")');
    expect(source).toContain("localStorage.removeItem(browserDomainKey)");
  });

  it("keeps persisted attribution and per-link counted clicks visible on mobile", async () => {
    const css = await readFile(new URL("../public/assets/dashboard-shell.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.link-clicks\s*\{\s*display:\s*none/);
    expect(css).toMatch(/\.link-meta\s*\{[^}]*grid-column:\s*3 \/ -1;[^}]*display:\s*block/s);
    expect(css).toMatch(/\.link-clicks\s*\{[^}]*grid-column:\s*3 \/ -1;[^}]*display:\s*flex/s);
  });

  it("keeps every successful Bulk short URL in Copy all and text download exports", async () => {
    const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
    expect(source).toContain('copyAll.textContent = "Copy all";');
    expect(source).toContain('download.textContent = "Download .txt";');
    expect(source).toContain('downloadText("short-links.txt", allShorts + "\\n")');
    expect(source).toContain("all are included in Copy all and Download");
  });

  it("uses runtime bulk limits instead of the old hard-coded 50-image picker cap", async () => {
    const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
    expect(source).toContain("dashboardBulkLimit(shell.dataset.maxBulkLinks)");
    expect(source).toContain("dashboardBulkLimit(shell.dataset.maxBulkImages)");
    expect(source).toContain("availableBulkUploadSlots(bulkReadyImageCount(), bulkUploadBusy)");
    expect(source).toContain("if (submittedLinkCount > maxBulkLinks)");
    expect(source).toContain("if (paths.length > maxBulkImages)");
    expect(source).not.toContain("files.slice(0, 50)");
  });

  it("serializes CSRF before every browser-managed image file", async () => {
    const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
    expect(source.match(/var body = csrfFirstFormData\(form\);/g)).toHaveLength(2);
    expect(source).toMatch(/body\.append\("csrf", csrf\);\s+body\.append\("image", file\);/);
    expect(source).toContain("function csrfFirstFormData(form)");
    expect(source).toContain('if (name !== "csrf") body.append(name, value);');
  });

  it("reuses retained uploads without reprocessing and drops only an exact stale managed path", async () => {
    const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
    expect(source).toContain('body.set("image_url", submittedRetainedPath);');
    expect(source).toContain("normalizeRetainedSingleImagePath(data.retained_image_path)");
    expect(source).toContain("applyKeepBulk(form, data.retained_image_paths)");
    expect(source).toContain('result.error === unavailableUploadError');
    expect(source).toContain("submittedRevision === singleImageRevision(form)");
  });

  it("bounds Quick Reuse and defers dashboard images while the tab is hidden", async () => {
    const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
    expect(source).toContain("30 * 24 * 60 * 60 * 1000");
    expect(source).toContain("lastUsed > now + quickReuseFutureSkewMs");
    expect(source).toContain("items.slice(0, 100)");
    expect(source).toContain('document.addEventListener("visibilitychange"');
    expect(source).toContain('if (document.visibilityState === "hidden") return;');
  });

  it("guards post-create Remember with the submitted picker revision", async () => {
    const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
    expect(source).toContain("var submittedPreferenceRevision = domainPreferenceRevision;");
    expect(source).toContain("submittedRevision !== domainPreferenceRevision");
    expect(source).toContain("saveDefaultDomain(domainId, true);");
  });

  it("sends only enumerated GA4 fields and samples bucketed browser performance", async () => {
    const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
    expect(source).toContain("send_page_view: false");
    expect(source).toContain("allow_google_signals: false");
    expect(source).toContain("allow_ad_personalization_signals: false");
    expect(source).toContain("dashboardPerfSampled = analyticsEnabled && Math.random() < 0.10");
    expect(source).toContain('dashboardLongTaskObserver.observe({ type: "longtask", buffered: true })');
    expect(source).toContain('trackDashboardEvent("dashboard_perf"');
    expect(source).toContain("if (count !== null && count !== undefined) params.count_bucket = countBucket(count);");
    expect(source).toContain('recordCreateAnalytics("bulk", domainId, "failure", null');
    expect(source).toContain('link_create_ui_ready: ["mode", "create_attempt_bucket", "image_sequence_bucket", "image_submission_source", "quick_reuse"');
    expect(source).toContain('link_create: ["mode", "domain_id", "result", "count_bucket", "duration_bucket", "failure_type", "failure_reason", "status_group", "quick_reuse", "bulk_pattern", "create_attempt_bucket", "image_sequence_bucket", "image_submission_source"');
    expect(source).toContain('create_attempt_bucket: ["first", "second", "third_plus"]');
    expect(source).toContain('image_sequence_bucket: ["first", "second", "third_plus", "not_applicable"]');
    expect(source).toContain('quick_reuse: ["yes", "no"]');
    expect(source).toContain("beginPostCreatePerformance(");
    expect(source).toContain('context.observer.observe({ type: "longtask" })');
    expect(source).toContain('if (!resources.length) return "unavailable";');
    expect(source).toContain('failure_type: "javascript"');
    expect(source).toContain('failure_type: "promise"');
    expect(source).toContain('trackDashboardEvent("image_upload"');
    expect(source).toContain('trackDashboardEvent("link_delete"');
    expect(source).toContain('trackDashboardEvent("quick_reuse_use"');
    expect(source).toContain('if (onePerImage) existing = [entry.destination];');
    expect(source).toContain("clearQuickReusePending();");
    expect(source).toContain('source: "promise", failure_type: "javascript"');
    expect(source).toContain("crossOrigin && transfer === 0 && encoded === 0");
    expect(source).not.toContain("page_location: window.location.href");
  });

  it("keeps create-mode and autocomplete history browser-local and bounded", async () => {
    const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
    expect(source).toContain('createModeKey = "node-shortener:create-mode:v1:" + userId');
    expect(source).toContain("select(saved, false)");
    expect(source).toContain("raw.length > 100000");
    expect(source).toContain("JSON.stringify(entries.slice(0, 25))");
    expect(source).toContain("option.textContent = match");
  });

  it("releases the browser Blob preview when a managed upload replaces or clears it", async () => {
    const source = await readFile(new URL("../public/assets/dashboard-shell.js", import.meta.url), "utf8");
    expect(source).toContain("form.releaseSingleImageObjectUrl = function ()");
    expect(source).toContain("releaseSingleImageObjectUrl(form);");
    expect(source).toContain("URL.revokeObjectURL(objectUrl)");
  });
});
