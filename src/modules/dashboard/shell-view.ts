import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { escapeHtml } from "../../web/escape.js";
import { indiaBusinessDate, type DashboardSnapshot } from "./history-service.js";
import { renderDashboardHistory } from "./history-view.js";
import type { DomainRegistry } from "../../config/domain-registry.js";

export interface DashboardShellDomain {
  readonly id: number;
  readonly label: string;
  readonly hostname: string;
}

interface PublicShellOptions {
  readonly brand: string;
  readonly registrationState: "open" | "closed" | "unavailable";
}

interface AuthenticatedShellOptions {
  readonly brand: string;
  readonly username: string;
  readonly userRole: string;
  readonly userId: number;
  readonly csrf: string;
  readonly domains: readonly DashboardShellDomain[];
  readonly defaultDomainId: number | null;
  readonly preferenceScope: "account" | "browser";
  readonly maxBulkLinks: number;
  readonly maxBulkImages: number;
  readonly history: DashboardSnapshot;
  readonly registry: DomainRegistry;
  readonly analytics: {
    readonly enabled: boolean;
    readonly measurementId: string;
    readonly siteKey: string;
  };
}

export const dashboardAssetVersion = createHash("sha256")
  .update(readFileSync(new URL("../../../public/assets/dashboard-shell.css", import.meta.url)))
  .update(readFileSync(new URL("../../../public/assets/dashboard-shell.js", import.meta.url)))
  .digest("hex")
  .slice(0, 16);
const stylesheetPath = `/assets/dashboard-shell.css?v=${dashboardAssetVersion}`;
const scriptPath = `/assets/dashboard-shell.js?v=${dashboardAssetVersion}`;

export function renderPublicShell(options: PublicShellOptions): string {
  const brand = escapeHtml(options.brand);
  const registrationOpen = options.registrationState === "open";
  const registrationNotice = options.registrationState === "closed"
    ? "Sign-up is currently closed. Existing users can still sign in."
    : options.registrationState === "unavailable"
      ? "Sign-up status is temporarily unavailable. Existing users can still sign in."
      : "Create a standard user account. Administrative access cannot be requested here.";
  return documentShell({
    title: `${options.brand} | Short links`,
    bodyClass: "public-page",
    body: `<header class="site-header">
  <a class="brand" href="/" aria-label="${brand} home"><span aria-hidden="true">↗</span>${brand}</a>
  <a class="text-link" href="#sign-in">Sign in</a>
</header>
<main class="public-shell">
  <section class="hero" aria-labelledby="hero-title">
    <p class="eyebrow">Single and multi-domain shortener</p>
    <h1 id="hero-title">Create short links without hiding how the system works.</h1>
    <p class="hero-copy">Sign in to create Single or Bulk links, select an available short domain, and add an optional social-preview image. Redirect-only domains never expose this dashboard.</p>
    <a class="button primary" href="#sign-in">Open the creator</a>
  </section>
  <section class="public-features" aria-label="Available tools">
    <article><h2>Single links</h2><p>Create one link with an optional title, description and preview image.</p></article>
    <article><h2>Bulk links</h2><p>Create a bounded batch while keeping partial successes visible and truthful.</p></article>
    <article><h2>Domain-aware</h2><p>The creator shows only domains currently allowed for link creation.</p></article>
  </section>
  <section id="sign-in" class="login-card" aria-labelledby="login-title" data-registration-state="${options.registrationState}">
    <div>
      <p class="eyebrow">Account access</p>
      <h2 id="login-title">Open your dashboard</h2>
      <p>Your session and links remain scoped to your account. Public sign-up creates a standard user account only when the owner has enabled it.</p>
    </div>
    <div class="auth-workspace">
      ${registrationOpen ? `<div class="auth-tabs" role="tablist" aria-label="Account access">
        <button id="loginAuthTab" class="auth-tab active" type="button" role="tab" aria-controls="loginPanel" aria-selected="true">Sign in</button>
        <button id="registerAuthTab" class="auth-tab" type="button" role="tab" aria-controls="registrationPanel" aria-selected="false">Create account</button>
      </div>` : ""}
      <section id="loginPanel"${registrationOpen ? ' role="tabpanel" aria-labelledby="loginAuthTab"' : ""}>
        <form id="loginForm" method="post" action="/auth/login" novalidate>
          <label for="loginUsername">Username<input id="loginUsername" name="username" autocomplete="username" required></label>
          <label for="loginPassword">Password<input id="loginPassword" name="password" type="password" autocomplete="current-password" required></label>
          <button class="button primary" type="submit">Sign in</button>
          <p id="loginStatus" class="form-status" role="status" aria-live="polite"></p>
        </form>
      </section>
      ${registrationOpen ? `<section id="registrationPanel" role="tabpanel" aria-labelledby="registerAuthTab" hidden>
        <form id="registrationForm" method="post" action="/auth/register" novalidate>
          <label for="registrationUsername">Username
            <input id="registrationUsername" name="username" autocomplete="username" required maxlength="64" pattern="[A-Za-z0-9_.\\-]{3,64}" aria-describedby="registrationUsernameHelp">
            <span id="registrationUsernameHelp">3–64 characters: letters, numbers, and _ . - only.</span>
          </label>
          <label for="registrationPassword">Password
            <input id="registrationPassword" name="password" type="password" autocomplete="new-password" required aria-describedby="registrationPasswordHelp">
            <span id="registrationPasswordHelp">Use 8–72 UTF-8 bytes and a unique password.</span>
          </label>
          <label for="registrationPassword2">Re-enter password
            <input id="registrationPassword2" name="password2" type="password" autocomplete="new-password" required>
          </label>
          <button class="button primary" type="submit">Create standard account</button>
          <p id="registrationStatus" class="form-status" role="status" aria-live="polite"></p>
        </form>
      </section>` : ""}
      <p id="registrationAvailability" class="availability-note ${options.registrationState === "unavailable" ? "warning" : ""}">${registrationNotice}</p>
    </div>
  </section>
</main>`,
  });
}

export function renderAuthenticatedShell(options: AuthenticatedShellOptions): string {
  const brand = escapeHtml(options.brand);
  const username = escapeHtml(options.username);
  const defaultDomainId = selectedDomainId(options.domains, options.defaultDomainId, options.registry);
  const data = [
    `data-dashboard-shell`,
    `data-user-id="${options.userId}"`,
    `data-csrf="${escapeHtml(options.csrf)}"`,
    `data-default-domain-id="${defaultDomainId ?? ""}"`,
    `data-preference-scope="${options.preferenceScope}"`,
    `data-max-bulk-links="${options.maxBulkLinks}"`,
    `data-max-bulk-images="${options.maxBulkImages}"`,
    `data-shield-date="${indiaBusinessDate(new Date())}"`,
    `data-analytics-enabled="${options.analytics.enabled ? "1" : "0"}"`,
    `data-analytics-id="${escapeHtml(options.analytics.measurementId)}"`,
    `data-analytics-site-key="${escapeHtml(options.analytics.siteKey)}"`,
  ].join(" ");

  const creator = options.domains.length === 0
    ? `<section class="empty-panel" role="status"><h1>Creator unavailable</h1><p>No active short domain currently allows creation. Nothing has been submitted.</p></section>`
    : renderCreator(
        options.domains,
        defaultDomainId ?? options.domains[0]?.id ?? 0,
        options.maxBulkLinks,
        options.maxBulkImages,
      );

  return documentShell({
    title: `${options.brand} | Dashboard`,
    bodyClass: "dashboard-page",
    body: `<div ${data}>
  <header class="dashboard-header">
    <a class="brand" href="/" aria-label="${brand} dashboard"><span aria-hidden="true">↗</span>${brand}</a>
    <div class="account-summary">
      <span>Signed in as <strong>${username}</strong></span>
      ${options.userRole === "admin" ? '<a class="button quiet" href="/admin.php">Admin panel</a>' : ""}
      <div class="shield-wrap">
        <button id="shieldBell" class="shield-button" type="button"
                aria-label="Open traffic protection report" aria-haspopup="true"
                aria-controls="shieldPanel" aria-expanded="false">
          <span class="shield-icon" aria-hidden="true">◆</span><span class="shield-dot" aria-hidden="true"></span>
        </button>
        <section id="shieldPanel" class="shield-panel hidden" aria-label="Traffic protection report">
          <div class="shield-panel-head">
            <div class="shield-panel-title"><span class="shield-panel-title-icon" aria-hidden="true">◆</span><span><strong>Free Traffic Protection</strong><small>Active on every link</small></span></div>
            <p class="shield-summary"><strong>Yesterday, we kept <span id="shieldYesterday">—</span> automated requests out of your click count.</strong></p>
            <p id="shieldStatus" class="shield-summary-note">Loading compact daily protection history…</p>
          </div>
          <div id="shieldDays" class="shield-days" aria-live="polite"><p class="shield-row"><span>Loading your seven-day history…</span></p></div>
          <div class="shield-footer"><span id="shieldHistoryLabel">Filtered over the last 7 days</span><strong id="shieldHistoryTotal">—</strong></div>
          <p class="shield-lifetime">Current-link filtered total, including migrated history: <strong id="shieldTotal">—</strong></p>
        </section>
      </div>
      <button id="logoutButton" class="button quiet" type="button">Sign out</button>
    </div>
  </header>
  <div id="persistentNotice" class="persistent-notice" role="alert" hidden></div>
  <main class="dashboard-layout">
    ${creator}
    ${renderDashboardHistory(options.history, options.registry)}
  </main>
</div>`,
  });
}

function renderCreator(
  domains: readonly DashboardShellDomain[],
  selectedId: number,
  maxBulkLinks: number,
  maxBulkImages: number,
): string {
  return `<section class="creator-panel" aria-labelledby="creator-title">
  <div class="panel-heading"><div><p class="eyebrow">Link creator</p><h1 id="creator-title">Create short links</h1></div></div>
  <div class="tabs" role="tablist" aria-label="Create mode">
    <button id="singleTab" class="tab active" type="button" role="tab" aria-controls="singlePanel" aria-selected="true">Single</button>
    <button id="bulkTab" class="tab" type="button" role="tab" aria-controls="bulkPanel" aria-selected="false">Bulk</button>
  </div>
  <section id="singlePanel" role="tabpanel" aria-labelledby="singleTab">
    <form id="singleLinkForm" class="creator-form" enctype="multipart/form-data">
      ${domainField(domains, selectedId, "single")}
      <label>Destination URL<input name="destination" type="url" autocomplete="url" required placeholder="https://example.com/article"></label>
      <div class="two-fields"><label>Title <span>(optional)</span><input name="title" maxlength="255"></label><label>Description <span>(optional)</span><textarea name="description" rows="2" maxlength="2000"></textarea></label></div>
      <div class="two-fields"><label>Upload image <span>(optional)</span><input id="singleImagePicker" name="upload_image" type="file" accept="image/jpeg,image/png,image/gif,image/webp"></label><label>Or image URL <span>(optional)</span><input id="singleImageUrl" name="image_url" type="url" placeholder="https://example.com/image.jpg"></label></div>
      <div id="singleImagePreview" class="image-preview" hidden><img alt="Selected preview" decoding="async"><button id="clearSingleImage" class="button quiet" type="button">Remove image</button></div>
      ${rememberField("single")}
      <button id="createSingleButton" class="button primary" type="submit">Create short link</button>
    </form>
  </section>
  <section id="bulkPanel" role="tabpanel" aria-labelledby="bulkTab" hidden>
    <form id="bulkLinkForm" class="creator-form" enctype="multipart/form-data">
      ${domainField(domains, selectedId, "bulk")}
      <label>Destination URLs <span>— up to ${maxBulkLinks}, one per line</span><textarea id="bulkUrls" name="bulk_urls" rows="6" required placeholder="https://example.com/one?utm_source=facebook&amp;utm_medium=post&#10;https://example.com/two?utm_source=instagram&amp;utm_medium=story"></textarea></label>
      <div class="two-fields"><label>Common title <span>(optional)</span><input name="bulk_title" maxlength="255"></label><label>Common description <span>(optional)</span><textarea name="bulk_description" rows="2" maxlength="2000"></textarea></label></div>
      <label class="check-row"><input id="oneLinkPerImage" type="checkbox"><span>Use the one destination once for every uploaded image</span></label>
      <div class="two-fields"><label>Add images <span>— up to ${maxBulkImages}, uploaded one at a time</span><input id="bulkImagePicker" type="file" accept="image/jpeg,image/png,image/gif,image/webp" multiple></label><label>Or common image URL <span>(optional)</span><input name="bulk_image_url" type="url" placeholder="https://example.com/image.jpg"></label></div>
      <div id="bulkImagePool" class="image-pool" aria-live="polite"></div>
      ${rememberField("bulk")}
      <button id="createBulkButton" class="button primary" type="submit">Create bulk links</button>
    </form>
  </section>
  <label class="check-row keep-row"><input id="keepForNext" type="checkbox" checked><span>Keep title, description and image(s) for the next creation</span></label>
  <section id="quickReuse" class="quick-reuse" aria-labelledby="quick-reuse-title" hidden><div class="panel-heading"><div><p class="eyebrow">This device only</p><h2 id="quick-reuse-title">Quick Reuse</h2></div><button id="clearQuickReuse" class="button quiet" type="button">Clear</button></div><div id="quickReuseList"></div></section>
  <section id="resultTray" class="result-tray" aria-live="polite" hidden></section>
  <p id="dashboardStatus" class="form-status" role="status" aria-live="polite"></p>
</section>`;
}

function domainField(domains: readonly DashboardShellDomain[], selectedId: number, prefix: string): string {
  const options = domains.map((domain) => `<option value="${domain.id}"${domain.id === selectedId ? " selected" : ""}>${escapeHtml(domain.label)} — ${escapeHtml(domain.hostname)}</option>`).join("");
  return `<div class="domain-preference-row"><label class="domain-field" for="${prefix}Domain"><span class="field-title">Short domain</span><span class="select-wrap"><select id="${prefix}Domain" name="domain_id" data-domain-select>${options}</select><span class="domain-chevron" aria-hidden="true">⌄</span></span></label><button class="button quiet default-domain-button" type="button" data-set-default-domain data-domain-target="${prefix}Domain">Make my default</button></div>`;
}

function rememberField(prefix: string): string {
  return `<label class="check-row"><input id="${prefix}Remember" type="checkbox" data-remember-domain><span>Remember this domain after a complete successful create</span></label>`;
}

function selectedDomainId(
  domains: readonly DashboardShellDomain[],
  requested: number | null,
  registry: DomainRegistry,
): number | null {
  if (requested !== null && domains.some((domain) => domain.id === requested)) return requested;
  const fallback = registry.all().find((domain) => domain.creationFallback
    && domains.some((candidate) => candidate.id === domain.id));
  return fallback?.id ?? domains[0]?.id ?? null;
}

function documentShell(options: { readonly title: string; readonly bodyClass: string; readonly body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Create and manage single or bulk short links.">
  <title>${escapeHtml(options.title)}</title>
  <link rel="stylesheet" href="${stylesheetPath}">
  <script src="${scriptPath}" defer></script>
</head>
<body class="${options.bodyClass}">${options.body}</body>
</html>`;
}
