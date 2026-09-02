import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(projectRoot, "evidence/php-source-hashes.json"), "utf8"));
const sourceRoot = resolve(projectRoot, ".local-evidence/php-current");
const failures = [];
const requiredSourceFiles = [
  ".htaccess", "_link_card.php", "admin.php", "api.php", "assets/app.js",
  "assets/dashboard.736bccfba8acfeee.css", "cleanup_old_clicks.php",
  "cleanup_stale_images.php", "country_report_rollup_lib.php", "country_report_rollup.php",
  "data/aws_ec2_ranges.php", "data/datacenter_ranges.php", "home.php", "index.php",
  "lib.php", "redirect.php", "upload.php",
];

const manifestedFiles = Object.keys(manifest.files ?? {}).sort();
if (JSON.stringify(manifestedFiles) !== JSON.stringify([...requiredSourceFiles].sort())) {
  failures.push("source manifest does not contain the canonical 17-file set");
}

for (const [relativePath, expected] of Object.entries(manifest.files)) {
  try {
    const bytes = await readFile(resolve(sourceRoot, relativePath));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      failures.push(`${relativePath}: expected ${expected}, got ${actual}`);
    }
  } catch (error) {
    failures.push(`${relativePath}: ${error instanceof Error ? error.message : "unreadable"}`);
  }
}

try {
  const schemaPath = resolve(projectRoot, "evidence", manifest.schema?.file ?? "");
  const schemaBytes = await readFile(schemaPath);
  const schemaHash = createHash("sha256").update(schemaBytes).digest("hex");
  if (schemaHash !== manifest.schema?.sha256) {
    failures.push(`sanitized schema: expected ${manifest.schema?.sha256 ?? "missing hash"}, got ${schemaHash}`);
  }
  validateSanitizedSchema(JSON.parse(schemaBytes.toString("utf8")), failures);
} catch (error) {
  failures.push(`sanitized schema: ${error instanceof Error ? error.message : "unreadable"}`);
}

if (failures.length > 0) {
  process.stderr.write(`PHP evidence verification failed:\n${failures.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`PHP evidence verified: ${requiredSourceFiles.length} source files + sanitized schema\n`);
}

function validateSanitizedSchema(schema, errors) {
  if (schema?._meta?.secrets_included !== false || schema?._meta?.private_setting_values_included !== false) {
    errors.push("sanitized schema metadata does not affirm secret/private-value exclusion");
  }
  if (typeof schema?.runtime?.version !== "string" || !schema.runtime.version.startsWith("10.11.")) {
    errors.push("sanitized schema is not the captured MariaDB 10.11 runtime shape");
  }
  const requiredTables = [
    "auth_throttle", "clicks", "country_report_10m", "country_report_daily", "country_report_state",
    "delivered_country_10m_state", "diversion_history_10m", "domain_settings", "domains", "geo_rules",
    "ip_geo_cache", "link_activity_archive", "links", "remember_tokens", "settings", "uploaded_images", "users",
  ];
  const columns = Array.isArray(schema?.columns) ? schema.columns : [];
  const actualTables = [...new Set(columns.map((item) => item.TABLE_NAME))].sort();
  if (JSON.stringify(actualTables) !== JSON.stringify([...requiredTables].sort())) {
    errors.push("sanitized schema table set differs from the canonical captured set");
  }
  const requiredColumns = {
    domains: ["id", "domain_key", "hostname", "active", "allow_create", "role"],
    links: ["id", "domain_id", "code", "user_id", "destination", "image", "clicks", "diverted_clicks", "filtered_meta_clicks", "filtered_bot_clicks", "filtered_other_clicks"],
    users: ["id", "username", "password_hash", "role", "default_domain_id"],
    uploaded_images: ["id", "path", "user_id", "session_scope_hash", "state", "expires_at", "attached_at"],
    domain_settings: ["domain_id", "skey", "svalue"],
    diversion_history_10m: ["domain_id", "bucket_start_utc", "country", "delivered", "diverted", "filtered_meta", "filtered_bots", "filtered_other"],
  };
  for (const [table, names] of Object.entries(requiredColumns)) {
    const actual = new Set(columns.filter((item) => item.TABLE_NAME === table).map((item) => item.COLUMN_NAME));
    for (const name of names) if (!actual.has(name)) errors.push(`sanitized schema is missing ${table}.${name}`);
  }
  const indexes = Array.isArray(schema?.indexes) ? schema.indexes : [];
  for (const [table, name, expectedColumns] of [
    ["links", "uq_links_domain_code", ["domain_id", "code"]],
    ["uploaded_images", "uq_uploaded_images_path", ["path"]],
    ["domains", "uq_domains_hostname", ["hostname"]],
    ["users", "username", ["username"]],
  ]) {
    const rows = indexes.filter((item) => item.TABLE_NAME === table && item.INDEX_NAME === name)
      .sort((left, right) => Number(left.SEQ_IN_INDEX) - Number(right.SEQ_IN_INDEX));
    if (rows.length === 0 || rows.some((item) => Number(item.NON_UNIQUE) !== 0)
      || JSON.stringify(rows.map((item) => item.COLUMN_NAME)) !== JSON.stringify(expectedColumns)) {
      errors.push(`sanitized schema unique index ${table}.${name} differs from the canonical shape`);
    }
  }
  const domains = Array.isArray(schema?.domains) ? schema.domains : [];
  const authority = domains.map((item) => [item.id, item.role, item.active, item.allow_create]);
  if (JSON.stringify(authority) !== JSON.stringify([[1, "dashboard", 1, 0], [2, "redirect", 1, 1]])) {
    errors.push("sanitized domain authority differs from URL6X/VIDX1X baseline");
  }
  const settingKeys = new Set((schema?.domain_setting_shapes ?? []).map((item) => item.skey));
  for (const key of ["skim_enabled", "skim_destination_url", "skim_default_percent", "skim_quality_policy_v1"]) {
    if (!settingKeys.has(key)) errors.push(`sanitized setting shape is missing ${key}`);
  }
}
