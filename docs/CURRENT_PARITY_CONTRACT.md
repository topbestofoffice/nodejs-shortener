# Current PHP-to-Node parity contract

Status: implementation contract, not a deployment receipt. PHP remains the live
authority until every pilot and release gate passes.

## Authority layers

The original August 23 D1/D2 snapshot remains historical evidence. New work must
use these separate authority layers:

1. Portable source oracle: `optimized-multi-domain-shortener` commit
   `bde65c03e01a373de5c7ce44828432057668ab63`, a 28-file D1/D2/D3 capture dated
   August 30 plus the documented two-file control-plane overlay.
2. D3 R4 overlay: the September 1 token/readback click-claim and post-accounting
   Delivered-observer behavior.
3. Mutable operations: report maturity, writers, cron, hashes, resources and
   provider state must be refreshed from the exact live target before pilot or
   release. At the dated September 1 evidence cut D3 R4 was collecting at 2/36;
   that number is not a permanent application constant.

The sanitized local descriptor is
`evidence/parity-authority-2026-09-01.json`. It deliberately contains no secret
or deploy identity and must never be treated as a live drift receipt.

## Domain and routing contract

| ID | Host | Surface | Active | Create | Notes |
|---:|---|---|---|---|---|
| 1 | `url6x.com` | dashboard/control plane plus redirects | yes | paused | physical upload, reporting and maintenance owner |
| 2 | `vidx1x.com` | redirect only | yes | yes | default/fallback creatable domain |
| 3 | `plays9x.com` | redirect only | yes | yes | selectable; apex only; no `www` alias |

The same Node artifact must support both configurations:

- multi-domain: D1/D2/D3 with `(domain_id, code)` isolation;
- single-domain: one dashboard host performing the complete login, upload,
  create, redirect, delete and logout flow.

Every redirect-only host hides dashboard, authentication, API, Admin, Stats and
diagnostic routes. Plays9X `/`, `/index.php` and cache-busted root requests return
an empty-body 404 with `no-store` and `noindex`. When private origin
authentication is enabled it is verified first so an unauthenticated caller
cannot use status differences as a configured-Host oracle. Exact Host validation
then happens before session, Redis or MariaDB work.

## Creation and client contract

- D2 and D3 are selectable while D2 remains the fallback through the
  fingerprinted `creationFallback` domain property, not a numeric-ID branch.
  At most one active creatable domain may set it. A configuration with no
  explicit fallback safely selects the first returned creatable domain. D1
  creation stays paused without disabling its existing redirects or dashboard.
- Bulk URL/image limits are runtime configuration, not fleet constants. The
  server and dashboard must expose/enforce the same exact values. Before the
  pilot, read the exact deployed PHP private constants and deliberately bind
  the pilot values; the PHP fallback, example config and browser are not a
  reliable substitute for that readback.
- Destination validation may parse the URL to enforce HTTP(S), no credentials,
  length and syntax, but the stored/exported/redirected value preserves the
  user's trimmed original spelling rather than WHATWG serialization.
- Legacy/foreign-written destinations are validated again before redirect or
  preview output. Unsafe schemes and malformed values are never emitted as a
  `Location`, navigation script or live link. Dashboard formatting degrades a
  malformed destination or date without taking down the owner's history page.
- The body `csrf` field remains the multipart API contract. Browser clients put
  it first; `/api.php` and `/upload.php` reject and drain any file part received
  before a valid token without staging the bytes to private disk.
- A link is successful only when its database row and exact local-image
  attachment state are coherently committed. The API must never return a false
  failure after a committed link or success after a missing attachment.
- Preserve ready-on-create image behavior for the first parity release. A
  durable job ledger may support recovery, but unpublished/pending links are not
  exposed without a separately versioned product contract.
- Only the proven pre-commit busy response is safely retryable:
  `failure_code=image_processor_busy`, `link_committed=false`,
  `retryable=true`. Unknown 429, 408, network and 5xx outcomes remain uncertain
  and are never automatically retried.
- Quick Reuse and Remember mutate only when `created > 0 && failed == 0`.
  Partial, empty and failed Bulk operations mutate neither. Browser-scoped
  shared-author preference and account-scoped ordinary-user preference stay
  distinct.
- Emit exactly one Bulk `link_create` classification for each parsed response:
  complete `success`, mixed `partial`, and zero-created `failure` with
  `count_bucket=0`. Invalid numeric values fail closed. Transport/commit-uncertain
  failures remain a separate class.

## Redirect and reporting contract

- Core accounting stays one-hot: delivered, diverted, filtered Meta, filtered
  bot or filtered other.
- Normal short-link routing is GET/HEAD-only in Node. PHP's rewrite can send
  POST/OPTIONS into its redirect path. This hardening is accepted only for
  ordinary links; any form/webhook use of short URLs is incompatible until an
  explicit method contract and tests are added.
- Social-preview no-image behavior is domain configuration, not a hardcoded
  Host/ID branch: D2 sets `compactNoImagePreview=true`; D1 and D3 set it false.
  D3 separately enables managed-image alt/dimensions. Every property is part of
  the production runtime fingerprint so a configuration drift needs a new
  activation.
- Routing geography and report geography are different. Reporting uses only the
  trusted provider country after admission; missing country is Unknown/NULL and
  does not trigger an external lookup.
- Redis click claims use a random ownership token and readback proof. A lost SET
  reply is not automatically classified as a duplicate. Confirmed duplicates do
  not enter Delivered observation.
- After MariaDB accounting succeeds, every admitted Delivered winner enters the
  domain-scoped observer. A fingerprinted per-domain
  `acceptUnprovenDeliveredClaim` property controls the unproved fail-open case:
  D3 accepts it, while D2 latches a `claim` gap and does not add it. Accounting
  failure never enters the observer.
- D2/D3 reporting requires observer, gap/provenance state, singleton publisher,
  history and six-card Admin output. Completeness is NULL-safe and requires 36
  contiguous positive reconciled ten-minute buckets plus source/state/history
  equality. Missing history is incomplete, never zero or backfilled.
- The observer, reconciliation and report reader are implemented locally; the
  singleton publisher/schedule remains a required private operational writer.
  Single-domain dashboard+redirect mode also needs an explicit Delivered-
  reporting identity design because the current configuration permits these
  IDs only on redirect-only surfaces.
- D2 publisher schedule contract is minutes `1,11,21,31,41,51`. D3 maturity is
  mutable operational state and must be read live.

## Image and maintenance contract

- One physical upload owns each local image. Other domains may expose a
  same-domain read-only facade but never become additional physical writers.
- Preserve exact per-domain image URL, MIME, dimensions/metadata, GET/HEAD,
  length, ETag, Range, cache and origin-auth behavior. Cloudways static bypass
  must not expose source, configuration, private temporary files or backups.
- One singleton linked-image cleaner evaluates the newest shared reference,
  seven-day age, combined latest-24-hour activity below 100, grouped references,
  final locks/rechecks and bounded batches. It clears image references only;
  links, codes, destinations and counters remain.
- One singleton orphan cleaner runs serially with a daily 13:17 UTC contract,
  maximum 2,000 items, age over 24 hours, zero references, final identity and
  reference recheck, exact-path ownership and durable receipts. Missing
  ownership is report-only.
- PM2 clustering may multiply stateless web processes only. Image processing,
  publishers and cleaners remain separately locked singleton writers.
- The image worker acquires its lease before consuming. A Lua result proving a
  different owner crash-stops the process immediately. An ambiguous Redis refresh error is
  tolerated only while one more bounded attempt fits inside the last confirmed
  TTL safety window; exhaustion signals lease loss once and also crash-stops.
  This path must never await graceful Sharp completion because the old lease can
  expire while a replacement starts. Worker output remains private; web-owned
  ledger CAS and atomic rename control publication. The initial acquire remains
  fail-closed, while real Redis/BullMQ crash recovery remains pilot proof.
- Owner-scoped deletion is committed in MariaDB before best-effort cache
  invalidation. If that invalidation alone fails, an existing positive
  redirect/OG cache entry can survive for roughly 60 seconds. Treat this as a
  known low-severity consistency window unless immediate-revocation machinery
  is explicitly added.

## Product surface contract

Parity includes the public homepage, login, registration, dashboard, domain
selector label/chevron, Single and Bulk creation, retained upload reuse, Quick
Reuse metadata behavior, mobile full destination plus Source/Medium, visible-
first images and privacy-safe RUM, created-at IST display, Copy/Open/export,
Community lifetime/Today, Admin, history and click-triggered Shield reporting.
Stats remains retired/404. Shield never loads or prefetches on page load/idle.

The current Node public root is a smaller auth/creator landing page, not an
exact port of the PHP marketing/proof/cross-promotion homepage. That is a named
product decision before cutover: either port the current owner-approved copy
and proof, or accept the simpler Node page as a redesign. Do not silently call
the current page exact parity.

## Proof required before Cloudways

Local verification requires a clean reproducible install, repeated stable test
runs, the aggregate coverage gate, process smokes for executable entrypoints,
both multi-domain/single-domain HTTP flows and a real browser product flow. The
2026-09-02 local cut passes 88 files/822 tests, the aggregate 80% coverage gate,
both HTTP smokes and the multi-domain real local browser flow against the
isolated in-memory fixture. A single-domain browser session was not run.

Pilot-candidate proof additionally requires exact MariaDB 10.11/Redis/BullMQ
tests and failure evidence for DB/Redis/worker restarts, queue ambiguity,
saturation, disk full and late jobs. `src/server.ts` and
`src/workers/image-worker.ts` are executable entrypoints excluded from direct
coverage import, and no per-critical-file floors are configured; do not describe
the aggregate percentage as full runtime/provider proof.

The isolated Cloudways Flexible pilot then proves loopback proxying, exact Host
and forwarded-header trust, static bypass, upload/body/timeout/ModSecurity limits,
Sharp/Argon2 compatibility, PM2 reboot and drain, log rotation, backup/restore and
direct-origin denial. Production cutover additionally requires one writer,
immutable artifact identity, queue drain, session/cache decision, rehearsed DNS
and data rollback, and same-size PHP-versus-Node performance evidence.
