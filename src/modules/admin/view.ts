import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { escapeHtml } from "../../web/escape.js";
import type { AdminSnapshot } from "./service.js";

export const adminAssetVersion = createHash("sha256")
  .update(readFileSync(new URL("../../../public/assets/admin.css", import.meta.url)))
  .update(readFileSync(new URL("../../../public/assets/admin.js", import.meta.url)))
  .digest("hex")
  .slice(0, 16);

const notices: Readonly<Record<string, string>> = Object.freeze({
  settings_saved: "Diversion settings saved.",
  geo_saved: "Country rules and Quality Control saved.",
  user_added: "Standard user account created.",
  user_deleted: "User deleted. Their links were removed too.",
  registration_on: "Public sign-up is now on.",
  registration_off: "Public sign-up is now off.",
  sessions_reset: "Every older session was revoked. This Admin browser received fresh credentials.",
});

export function renderAdminPage(options: {
  readonly brand: string;
  readonly username: string;
  readonly csrf: string;
  readonly snapshot: AdminSnapshot;
  readonly noticeCode: string | null;
}): string {
  const selected = options.snapshot.domains.find(
    (domain) => domain.id === options.snapshot.selectedDomainId,
  );
  if (selected === undefined) throw new Error("Selected Admin domain is unavailable.");
  const notice = options.noticeCode === null ? undefined : notices[options.noticeCode];
  const hidden = hiddenFields(options.csrf, selected.id);
  const qualityMode = options.snapshot.domainState.qualityPolicy.active
    ? options.snapshot.domainState.qualityPolicy.scope
    : "off";
  const geoRows = options.snapshot.domainState.geoRules.length === 0
    ? [geoRow(0, "", 0, false)]
    : options.snapshot.domainState.geoRules.map((rule, index) => geoRow(
        index,
        rule.countryCode,
        rule.percent,
        options.snapshot.domainState.qualityPolicy.countries.includes(rule.countryCode),
      ));
  const domainOptions = options.snapshot.domains.map((domain) => (
    `<option value="${domain.id}"${domain.id === selected.id ? " selected" : ""}>${escapeHtml(domain.label)} — ${escapeHtml(domain.hostname)}${domain.active ? "" : " (inactive)"}</option>`
  )).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Shortener administration">
  <title>${escapeHtml(options.brand)} | Admin</title>
  <link rel="stylesheet" href="/assets/dashboard-shell.css">
  <link rel="stylesheet" href="/assets/admin.css?v=${adminAssetVersion}">
  <script src="/assets/admin.js?v=${adminAssetVersion}" defer></script>
</head>
<body class="dashboard-page">
<div class="admin-shell" data-admin-shell>
  <header class="dashboard-header">
    <a class="brand" href="/" aria-label="${escapeHtml(options.brand)} dashboard"><span aria-hidden="true">↗</span>${escapeHtml(options.brand)}</a>
    <div class="account-summary"><span>Admin <strong>${escapeHtml(options.username)}</strong></span><a class="button quiet" href="/index.php">Dashboard</a></div>
  </header>
  <main class="admin-main">
    <div class="admin-title"><div><p class="eyebrow">Control plane</p><h1>Admin panel</h1></div>
      <form method="get" action="/admin.php" class="domain-picker">
        <label for="adminDomain">Manage domain</label>
        <select id="adminDomain" name="domain_id">${domainOptions}</select>
        <button class="button quiet" type="submit">Open</button>
      </form>
    </div>
    ${notice === undefined ? "" : `<p class="admin-notice" role="status">${escapeHtml(notice)}</p>`}
    <p class="admin-scope">Editing <strong>${escapeHtml(selected.label)}</strong> (${escapeHtml(selected.hostname)}). Inactive configured domains stay selectable for safe inspection and cleanup.</p>

    <div class="admin-grid">
      <section class="admin-card" aria-labelledby="skim-title">
        <h2 id="skim-title">Diversion settings</h2>
        <form method="post" action="/admin.php">
          ${hidden}<input type="hidden" name="action" value="save_settings">
          <label class="check-row"><input type="checkbox" name="skim_enabled" value="1"${options.snapshot.domainState.skim.enabled ? " checked" : ""}><span>Enable diversion for this domain</span></label>
          <label>Destination URL<input type="url" name="skim_destination_url" value="${escapeHtml(options.snapshot.domainState.skim.destinationUrl)}" placeholder="https://example.com/landing"></label>
          <label>Default percentage<input type="number" name="skim_default_percent" min="0" max="100" step="1" value="${options.snapshot.domainState.skim.defaultPercent}"></label>
          <button class="button primary" type="submit">Save diversion settings</button>
        </form>
      </section>

      <section class="admin-card admin-wide" aria-labelledby="geo-title">
        <div class="admin-card-heading"><div><h2 id="geo-title">Country and Quality Control</h2><p>Country rows and the Quality policy commit together or not at all.</p></div><button id="addGeoRow" class="button quiet" type="button">Add country</button></div>
        <form id="geoForm" method="post" action="/admin.php">
          ${hidden}<input type="hidden" name="action" value="save_geo">
          <fieldset class="quality-options"><legend>Quality traffic</legend>
            ${qualityRadio("off", "Off", qualityMode)}
            ${qualityRadio("selected", "Selected countries", qualityMode)}
            ${qualityRadio("all", "All diverting countries", qualityMode)}
          </fieldset>
          <label id="qualityConfirmRow" class="check-row"><input type="checkbox" name="quality_all_confirm" value="1"><span>I understand and want to save all diverting countries.</span></label>
          <div class="geo-table-head" aria-hidden="true"><span>Country</span><span>Percent</span><span>Selected</span><span></span></div>
          <div id="geoRows">${geoRows.join("")}</div>
          <input type="hidden" name="geo_rows_complete" value="1">
          <button class="button primary" type="submit">Save country and Quality rules</button>
        </form>
      </section>

      <section class="admin-card" aria-labelledby="registration-title">
        <h2 id="registration-title">Public sign-up</h2>
        <form method="post" action="/admin.php">
          ${hidden}<input type="hidden" name="action" value="save_registration">
          <label class="check-row"><input type="checkbox" name="registration_enabled" value="1"${options.snapshot.registrationEnabled ? " checked" : ""}><span>Allow public standard-user registration</span></label>
          <button class="button primary" type="submit">Save sign-up setting</button>
        </form>
      </section>

      <section class="admin-card" aria-labelledby="add-user-title">
        <h2 id="add-user-title">Add standard user</h2>
        <form method="post" action="/admin.php" autocomplete="off">
          ${hidden}<input type="hidden" name="action" value="add_user">
          <label>Username<input name="new_username" required maxlength="64" pattern="[A-Za-z0-9_.-]{3,64}" autocomplete="off"></label>
          <label>Password<input name="new_password" type="password" required autocomplete="new-password" aria-describedby="adminPasswordHelp"></label>
          <span id="adminPasswordHelp" class="field-help">Use 8–72 UTF-8 bytes. Role is always user.</span>
          <label>Re-enter password<input name="new_password2" type="password" required autocomplete="new-password"></label>
          <button class="button primary" type="submit">Create standard user</button>
        </form>
      </section>

      <section class="admin-card admin-wide" aria-labelledby="users-title">
        <h2 id="users-title">Accounts</h2>
        <div class="users-table" role="table" aria-label="Accounts">
          <div class="users-row users-head" role="row"><span>Account</span><span>Role</span><span>Links</span><span>Clicks</span><span>Created</span><span></span></div>
          ${options.snapshot.users.map((user) => userRow(user, hidden)).join("")}
        </div>
      </section>

      <section class="admin-card admin-wide" aria-labelledby="sessions-title">
        <h2 id="sessions-title">Global session reset</h2>
        <p>Sign out every browser and revoke every persistent-login token. This Admin browser stays signed in with a new session; everyone else must sign in again.</p>
        <form method="post" action="/admin.php" data-reset-session-form>
          ${hidden}<input type="hidden" name="action" value="reset_sessions">
          <button class="button danger" type="submit">Reset all sessions</button>
        </form>
      </section>

      <section class="admin-card admin-wide" aria-labelledby="history-title">
        <div class="admin-card-heading"><div><h2 id="history-title">Admin-only diversion and filter history</h2><p>Choose one completed period. The bounded report is read only after you click.</p></div></div>
        <form method="post" action="/admin.php" class="history-range-form" aria-label="Admin traffic history period">
          ${hidden}<input type="hidden" name="action" value="load_diversion_history">
          ${historyRangeButton("6h", "Last 6 hours", options.snapshot.report?.range ?? null)}
          ${historyRangeButton("yesterday", "Yesterday", options.snapshot.report?.range ?? null)}
          ${historyRangeButton("7d", "Previous 7 days", options.snapshot.report?.range ?? null)}
        </form>
        ${renderAdminReport(options.snapshot.report)}
      </section>
    </div>
  </main>
</div>
</body>
</html>`;
}

function hiddenFields(csrf: string, domainId: number): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><input type="hidden" name="domain_id" value="${domainId}">`;
}

function qualityRadio(value: string, label: string, selected: string): string {
  return `<label><input type="radio" name="quality_mode" value="${value}"${value === selected ? " checked" : ""}><span>${label}</span></label>`;
}

function geoRow(index: number, country: string, percent: number, quality: boolean): string {
  return `<div class="geo-row" data-geo-row>
    <input type="text" name="geo_rows[${index}][country]" value="${escapeHtml(country)}" maxlength="2" pattern="[A-Za-z]{2}" autocomplete="off" placeholder="CC" aria-label="Country code">
    <input type="number" name="geo_rows[${index}][percent]" value="${percent}" min="0" max="100" step="1" aria-label="Diversion percentage">
    <label class="quality-check"><input type="checkbox" name="geo_rows[${index}][quality]" value="1"${quality ? " checked" : ""}><span>Yes</span></label>
    <button class="button quiet" type="button" data-remove-geo>Remove</button>
  </div>`;
}

function userRow(user: AdminSnapshot["users"][number], hidden: string): string {
  const canDelete = user.role === "user";
  return `<div class="users-row" role="row">
    <span><strong>${escapeHtml(user.username)}</strong><small>#${user.id}</small></span>
    <span>${escapeHtml(user.role)}</span><span>${user.linkCount.toString()}</span><span>${user.clickCount.toString()}</span>
    <span>${escapeHtml(user.createdAt.toISOString().slice(0, 10))}</span>
    <span>${canDelete ? `<form method="post" action="/admin.php" data-delete-user-form data-username="${escapeHtml(user.username)}">${hidden}<input type="hidden" name="action" value="delete_user"><input type="hidden" name="user_id" value="${user.id}"><button class="button danger" type="submit">Delete</button></form>` : "Protected"}</span>
  </div>`;
}

function historyRangeButton(
  value: "6h" | "yesterday" | "7d",
  label: string,
  selected: "6h" | "yesterday" | "7d" | null,
): string {
  const active = selected === value;
  return `<button class="button ${active ? "primary" : "quiet"}" type="submit" name="history_range" value="${value}" aria-pressed="${active ? "true" : "false"}">${label}</button>`;
}

function renderAdminReport(report: AdminSnapshot["report"]): string {
  if (report === null) {
    return `<p class="history-empty">No report loaded. Choose a period above to read it.</p>`;
  }
  const details = report.report;
  const deliveredApplicable = details.deliveredState !== "not_applicable";
  const warning = details.available
    ? details.deliveredState === "collecting_incomplete"
      ? `<p class="history-warning" role="status"><strong>Delivered is Collecting / Incomplete.</strong> Its count and diversion percentage stay hidden until every expected completion state is verified.</p>`
      : ""
    : `<p class="history-warning" role="status"><strong>This period is still Collecting / Incomplete.</strong> No missing metric is shown as zero.</p>`;
  const percentage = diversionPercentageLabel(
    details.diversionPercentageState,
    details.diversionPercentage,
  );
  const rows = details.rows.length === 0
    ? `<p class="history-empty">No complete country totals are available for this period yet.</p>`
    : `<div class="history-table-wrap"><table class="history-table">
        <thead><tr><th>Country</th><th>Delivered</th><th>Diverted</th><th>Meta</th><th>Known bots</th><th>Other filters</th></tr></thead>
        <tbody>${details.rows.map((row) => `<tr>
          <th scope="row">${row.country === "??" ? "Unknown" : escapeHtml(row.country)}</th>
          <td>${metricLabel(row.delivered, deliveredApplicable ? "Collecting / Incomplete" : "N/A")}</td>
          <td>${metricLabel(row.diverted, "Collecting")}</td>
          <td>${metricLabel(row.filteredMeta, "Collecting")}</td>
          <td>${metricLabel(row.filteredBots, "Collecting")}</td>
          <td>${metricLabel(row.filteredOther, "Collecting")}</td>
        </tr>`).join("")}</tbody>
      </table></div>`;

  return `<div class="history-report" aria-live="polite">
    <div class="history-heading"><div><h3>${escapeHtml(report.label)}</h3><p>Through ${escapeHtml(report.through)} · ${escapeHtml(report.window.timezone)}</p></div></div>
    ${warning}
    <div class="history-metrics">
      <div class="history-metric"><span>Delivered</span><strong>${metricLabel(details.totals.delivered, deliveredApplicable ? "Collecting / Incomplete" : "N/A")}</strong></div>
      <div class="history-metric"><span>Diversion %</span><strong>${escapeHtml(percentage)}</strong></div>
      <div class="history-metric"><span>Diverted</span><strong>${metricLabel(details.totals.diverted, "Collecting")}</strong></div>
      <div class="history-metric"><span>Meta prefetch</span><strong>${metricLabel(details.totals.filteredMeta, "Collecting")}</strong></div>
      <div class="history-metric"><span>Known bots</span><strong>${metricLabel(details.totals.filteredBots, "Collecting")}</strong></div>
      <div class="history-metric"><span>Other filters</span><strong>${metricLabel(details.totals.filteredOther, "Collecting")}</strong></div>
    </div>
    <p class="field-help">Diversion means the application selected that route; downstream arrival or revenue is not measured. Delivered telemetry is not billing or revenue proof.</p>
    ${rows}
  </div>`;
}

function metricLabel(value: string | null, unavailableLabel: string): string {
  if (value === null) return escapeHtml(unavailableLabel);
  if (!/^\d{1,19}$/.test(value)) throw new Error("Admin report contains an invalid counter.");
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function diversionPercentageLabel(
  state: NonNullable<AdminSnapshot["report"]>["report"]["diversionPercentageState"],
  value: string | null,
): string {
  switch (state) {
    case "complete":
      if (value === null || !/^\d{1,3}\.\d{2}$/.test(value)) {
        throw new Error("Admin report contains an invalid diversion percentage.");
      }
      return `${value}%`;
    case "no_eligible_clicks": return "No eligible clicks";
    case "collecting_incomplete": return "Collecting / Incomplete";
    case "not_applicable": return "N/A";
  }
}
