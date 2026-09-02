# Migration plan and PHP feature inventory

This is a parity-first rewrite, not a line-by-line PHP translation. One configurable Node codebase must preserve current behavior in multi-domain and single-domain deployments while isolating I/O waits and image CPU work. The standalone folder is not a Git repository yet; repository, remote and branch ownership will be established only when the owner requests it.

## Execution plan

| Phase | Status | Exit condition |
|---|---|---|
| 0. Freeze authority | Complete locally | D1/D2/D3 portable oracle, September overlays, historical source hashes and sanitized schema are locally reproducible; mutable live drift remains a fresh-read gate |
| 1. Standalone platform | Complete locally | Separate project, domain registry, Host/origin boundary, stores, sessions, PM2 shape and production lock pass local checks |
| 2. Redirect hot path | Core and observer local; operational parity pending | Same PHP/Node decisions, counters, cookies, audits and delivered-country publisher results on a sanitized corpus and exact clone |
| 3. Create/auth/image | Implemented locally; real-service proof pending | Registration/store/toggle, durable ledger/reconciliation and exact create/upload fixtures pass against real pilot MariaDB/Redis/BullMQ and failure cases |
| 4. User and Admin product | Implemented locally; product/writer decisions pending | Dashboard/history/Admin/Shield/report reader are accepted, marketing-homepage decision is closed, and publisher/maintenance writers are usable and reconciled |
| 5. Pilot candidate | Blocked on nine named gates | `verify:local` plus all exact `verify:pilot-candidate` receipts and Aryan's exact pilot authorization pass |
| 6. Cloudways pilot | Pending | Isolated Flexible server proves production-mode runtime, proxy headers, storage, PM2 restart, backups and failure modes |
| 7. Performance decision | Pending | Same-size A/B evidence shows whether Node delivers a worthwhile CPU/RAM/latency/throughput gain |
| 8. Cutover | Not authorized | All `verify:release` gates, one-writer rollback contract, acceptance checks and Aryan's separate live-cutover authorization pass |

## Redirect inventory

- Preserve web-edge rules: canonical alias 301, unknown Host `421` before PHP/cache/database work, public-file/directory bypass, sensitive-file denial and alphanumeric `/:code`.
- When enabled, authenticate the private proxy before revealing whether a Host is configured; then resolve the exact Host to immutable domain/surface identity and enforce active/role/hostname consistency plus redirect-only isolation from login/API/Admin.
- Preserve 60-second link/OG caching without negative caching. Deletion/cleanup performs best-effort invalidation; the known commit-then-invalidation failure window is documented below.
- Preview crawlers receive exact no-count Open Graph HTML; generic/search/AI/empty-user-agent traffic receives a no-count 301 to the author destination. Preserve title fallback, description, self URL, Twitter tags, local/external image handling and configurable URL6X local `og:image:alt`.
- Revalidate legacy/foreign-written destinations on every read before preview or redirect output. Non-HTTP(S), credentialed or malformed values are unavailable rather than executable HTML or unsafe `Location` responses; poisoned cache state is deleted and repaired only from a safe MariaDB row.
- Preserve human-policy order: Meta CIDR, datacenter, fbclid replay, Admin exemption, skim enabled/debug/destination/default/country percentage, trusted country then bounded fallback, Facebook evidence, one-hour signed decision, inclusive 1–100 roll, low-yield browser veto and selected-country Quality Control.
- Preserve Redis replay bounds, hard-block thresholds, 15-second dedup, five one-hot accounting outcomes, India-today/last-activity updates, compact history and explicitly chosen cache/accounting failure behavior.
- Preserve final 301 when skim is off/Admin and otherwise 302. PHP currently reaches redirect logic for methods beyond GET/HEAD while Node deliberately exposes GET/HEAD only. Accept this for normal short links only after confirming no form/webhook POST uses a short URL; otherwise it is an incompatibility.
- Implement bounded private skim/failure/datacenter audit evidence and D2 delivered-country observation, gaps, publisher and reports. The live publisher/writer was **NOT CAPTURED**.

Evidence baseline: `.local-evidence/php-current/.htaccess`, `lib.php`, `redirect.php`.

## Create and upload inventory

- Dashboard Host, authentication and CSRF are required; reject inactive, non-creatable or stale domains before writing. URL6X creation remains paused and VIDX1X remains selectable.
- Normal accounts persist a default domain; configured shared accounts keep it browser-local. A unique fingerprinted `creationFallback` property chooses the multi-domain fallback without coupling behavior to D2's numeric ID; the shared-account exception remains private deployment policy, not a hardcoded username.
- Single create validates one HTTP(S) destination, trims nullable metadata, gives an upload precedence over the URL field, retries `(domain_id, code)` collisions 12 times and returns exact bounded fields.
- Bulk preserves blank removal, common metadata, partial/nontransactional success, bounded cards, shuffled/deduplicated image pool, round-robin assignment and attachment only for server-observed local paths. Exact deployed PHP limits are private and still need readback: fallback code says 500 URLs/50 images, an example says 100/100, and the captured browser picker says 50 images. Node stays configurable 1..500; its dashboard and API now use the same runtime-owned values. Current pilot defaults remain 100/100 until that exact target decision.
- Upload validates actual JPEG/PNG/GIF/WebP, byte and 20MP limits, EXIF orientation, first GIF frame, 1200×630 contain/no-crop, progressive JPEG quality 87, bounded processing, private staging and atomic publication with cleanup on ownership failure.
- Multipart API compatibility remains a body `csrf` field, but it must precede any file part. The built-in browser orders it first; both upload endpoints reject/drain an early file without writing it to private staging.
- PHP uses a one-pixel average background while Node currently uses Sharp dominant color. Golden portrait/landscape, EXIF, animated-GIF, transparency, CMYK, malformed, oversize and decompression-bomb fixtures must approve the visual variance rather than claim byte/pixel identity.
- Ownership remains user + login-session + state + TTL + caps; accept only exact owned `uploads/<16hex>.<ext>` paths. Arbitrary external HTTP(S) may be stored but is never fetched server-side.
- Delete remains owner-scoped by domain/code/user with link/OG invalidation. If the MariaDB commit succeeds and Redis invalidation alone fails, a cached positive redirect can remain usable for about 60 seconds; accept that bounded window or add durable invalidation before a use case requiring immediate revocation.
- Do not clone the broken lifecycle where expired `READY` rows consume the global cap forever. Design a receipt-backed, bounded, one-writer ownership/orphan retention job.

Evidence baseline: `.local-evidence/php-current/api.php`, `upload.php`, `lib.php`, `assets/app.js`.

## Authentication inventory

- Auth exists only on the dashboard surface; redirect-only requests never restore sessions or remember tokens.
- Preserve a browser-session, HttpOnly/Lax/Secure-on-HTTPS session cookie plus a separate 30-day selector/validator remember cookie with hashed storage and sliding rotation.
- Login uses Host-bound pre-auth CSRF, generic failure text, PHP password verification and a failure-only/fail-open 20-attempt/15-minute salted-IP throttle.
- Public registration is implemented locally with the Admin toggle, CSRF, five genuine attempts/hour/IP, username `3–64 [A-Za-z0-9_.-]`, password 8–72 UTF-8 bytes plus confirmation, duplicate/race-safe creation, forced `user` role and auto-login. Exact MariaDB/race behavior is still pilot proof.
- Preserve auth epoch, POST+CSRF logout, remember cleanup and shared-account browser-default clearing.
- Existing PHP sessions are not portable to `node_shortener_session`; explicitly prove old `fs_remember` restoration compatibility or require a planned re-login.

Evidence baseline: `.local-evidence/php-current/lib.php`, `index.php`, `admin.php`.

## Dashboard inventory

- Implemented locally: authenticated dashboard, security headers and 404 isolation on redirect-only Hosts. The public root is a simplified auth/creator landing page, not an exact port of PHP marketing proof, branding, support and cross-promotion; port or explicitly accept that redesign before cutover.
- Implemented locally: per-user link count, lifetime delivered clicks, India-today totals and regular-user community totals with bounded cache invalidation.
- Implemented locally: domain picker/default, Single/Bulk persistence, different-URL and one-URL-per-image modes, serial upload state/retry/remove, result tray, copy/download and no automatic retry after ambiguous create.
- Implemented locally: account/site/device-scoped Quick Reuse, bounded/aged local stores and separate title/description autocomplete.
- Implemented locally: own-link escaped search, page sizes 20/50/100, newest-first pagination and responsive link cards.
- Implemented locally: truthful seven-day `shield_stats` with collecting states and local-seen state.
- Keep analytics/RUM privacy-bounded with enumerated buckets and sampling; never emit raw URLs/account identifiers.
- Review hardcoded brand, domain-count, support and cross-promotion copy with the owner. Captured “4 domains” copy is not current registry authority.

Evidence baseline: `.local-evidence/php-current/index.php`, `home.php`, `assets/app.js`.

## Admin inventory

- Require dashboard Host + Admin + CSRF + selected manageable domain; redirect-only Admin is 404.
- Implemented locally: user list/add/delete safeguards, roles/link/click/date display and affected-cache invalidation. Admin-created passwords use the 8–72 UTF-8 byte contract instead of the PHP nonempty-only weakness.
- Current Admin controls skim enabled/destination/default percentage, geo percentages and Quality Control. Domain `active`, `allow_create` and `skim_debug` are authoritative elsewhere and are not captured Admin controls.
- Geo/QC save must remain atomic: at most 250 unique ISO rows, integer 0–100, completeness marker, Off/Selected/All, confirmation for All and no selected zero-percent rows.
- Implemented locally: registration toggle and global session reset through auth epoch + remember wipe while retaining the initiating Admin session.
- Implemented locally: on-demand 6-hour/yesterday/seven-complete-day history with timezone/provenance/completeness states. Delivered telemetry is not revenue proof. Publisher freshness and real target reconciliation remain pending.
- Do not assume user deletion cascades links: the sanitized evidence export contains no foreign keys, so cascade behavior is **NOT VERIFIED**. Do not clone raw exception display or GET logout/CSRF weaknesses.

Evidence baseline: `.local-evidence/php-current/admin.php`, `lib.php`.

## Maintenance inventory

- `cleanup_old_clicks.php`: CLI-only/no args, private nonblocking lock, 5,000-row batches, archive-before-delete transaction, seven-day raw-click retention, compact-history retention and auth-token/throttle pruning. Current output is counts, not a durable receipt.
- `cleanup_stale_images.php`: current executable is report-only with shared-file, inactivity, lifetime-click, path/symlink and 200-result protections. Dormant apply code is unreachable and only clears `links.image`; it does not clear ownership rows.
- `country_report_rollup.php`: executable but likely legacy/orphaned because it reads raw clicks while current redirects do not write them and Admin reads `diversion_history_10m`. Cron/consumer use is **NOT VERIFIED**.
- No captured maintenance prunes `uploaded_images`, `ip_geo_cache` or `delivered_country_10m_state`; define explicit retention/privacy contracts. A complete-zero delivered bucket must not be misreported as incomplete.
- Delivered publisher, actual Cloudways schedules/receipts and some asset-generation operations are **NOT CAPTURED**.
- Node currently produces bounded report-only linked-image/orphan/legacy-click classifications and receipts. It has no mutating quarantine/delete writer and PM2 defines only web plus the singleton image worker. Do not call cleanup migrated or run PHP and Node writers together.
- Every future publisher/cleanup uses one writer, bounded resource checks, receipts, recovery, PM2 restart proof, log rotation, backup/restore and an exact rollback.

Evidence baseline: `.local-evidence/php-current/cleanup_old_clicks.php`, `cleanup_stale_images.php`, `country_report_rollup.php`, `country_report_rollup_lib.php`.

## Local acceptance before the isolated pilot

1. `npm run verify:local` reports every check and is green. The current 2026-09-02 cut passes 88 files/822 tests, aggregate coverage, 15-check multi-domain smoke, 12-check single-domain smoke and zero-vulnerability audits.
2. `npm run verify:pilot-candidate` currently blocks on nine named gates and must become green with structured, digest-checked receipts.
3. Disposable MariaDB/Redis/BullMQ tests reconcile exact schema/key/counter deltas and pool/eviction/saturation behavior.
4. A sanitized PHP-versus-Node corpus matches decisions, cookies, filters, accounting, audit and reporting.
5. Web/worker kill, ambiguous submission, Redis loss, disk-full, malformed upload and retry tests leave no false link/image/ownership state.
6. The multi-domain real local browser flow and both multi-domain/single-domain HTTP/API smokes pass. No explicit single-domain browser session was run. The browser proof uses the isolated in-memory fixture, and the single-domain smoke still uses memory/inline/passthrough rather than the production MariaDB/Redis/BullMQ/current-engine stack.
7. After the exact isolated pilot target is authorized, create its private expiring activation bound to the verified artifact manifest and runtime configuration, then run with `NODE_ENV=production`. Never remove the source gate globally or use the development PM2 override on a server.

The Cloudways/performance/cutover/production-authorization gates are intentionally excluded from `verify:pilot-candidate`; they can only be proven during or after the isolated pilot. `npm run verify:release` therefore remains red until all 12 final gates pass. Production DNS, Cloudflare, data and PHP remain unchanged until a separate cutover authorization.
