# PHP to Node parity status

Status date: 2026-09-02. Scope: standalone local Node project, clean portable PHP oracle and historical sanitized schema. No Cloudways deployment, production data write, DNS/Cloudflare change, activation, commit or push was performed.

## Authority and verification

- Portable source oracle: `optimized-multi-domain-shortener` commit `bde65c03e01a373de5c7ce44828432057668ab63`, plus the documented D3 reporting overlay.
- `npm run verify:evidence`: pass for 17 historical PHP/runtime files plus the sanitized schema shape.
- `npm run verify:authority`: pass for the local D1/D2/D3 descriptor; current live drift and mutable D3 report maturity remain `NOT VERIFIED`.
- `npm run verify:local`: pass, including typecheck, lint, 23 script-syntax checks, production build, both HTTP smokes, coverage and dependency audit.
- Current post-review result on 2026-09-02: 88 test files and 822 tests pass. Coverage passes the aggregate gate at 84.11% statements, 80.60% branches, 89.97% functions and 85.77% lines.
- Coverage excludes the two executable process entrypoints, `src/server.ts` and `src/workers/image-worker.ts`; their component/process behavior is covered by tests and smokes. No per-critical-file floor is configured.
- Multi-domain smoke: 15 checks pass. Single-domain smoke: 12 checks pass.
- Real local browser fixture: login, Single create, Bulk create and Copy all, persisted history/search, Shield, Admin report reading, redirect-only 301/404 behavior and logout pass. A fresh post-fix image create also proved CSRF-first multipart submission, 1200×630 JPEG normalization, direct static `200`, correct redirect `301`, refreshed history/totals and no browser console errors. Global session reset was not accepted or claimed in those passes.
- Both production-only and full `npm audit` report zero known dependency vulnerabilities.

## Implemented locally

- D1/D2/D3 Host registry, canonical/alias guards, unknown Host `421`, inactive-domain handling and redirect-only isolation before session/cache/database work.
- Current redirect decision core, trusted identity boundary, PHP-aligned image/no-image social-preview tags, preview/bot behavior, country/diversion/blocking policy, PHP-compatible decision cookie, click claim, one-hot accounting and delivered-country observation.
- MariaDB/Redis contracts with bounded pools/deadlines, shared session/cache/click keys and exact domain identity.
- Registration/login/remember/logout/CSRF/throttling, password timing hardening and 8–72 UTF-8 byte bcrypt input boundary.
- Single/Bulk creation with trimmed-original destination preservation after shared safety validation, exact HTTP(S)/length/control/credential legacy read guards, non-fatal malformed destination/date/unconfigured-domain display, owner delete, runtime-owned Bulk UI/API limits, dashboard/history/search/pagination, configuration-selected default fallback, retained-image Quick Reuse, Copy/Open/export and privacy-bounded analytics/RUM.
- Admin users/settings/geo/Quality Control/registration toggle/session reset, Shield and read-only bounded traffic history.
- Streamed private image staging only after a valid preceding multipart CSRF field, Sharp normalization, atomic publication, durable image ledger, CAS reconciliation and a leased singleton BullMQ worker with TTL-aware ambiguous-refresh tolerance. Proven ownership conflict or safety-window exhaustion immediately crash-stops the process; it never waits for an active Sharp job while a replacement can acquire the lease.
- PM2/static package verification, unique-install Cloudways package, immutable activation/renewal tools, safe PM2 inventory and installed preflight.
- Report-only maintenance classification and receipts; no destructive maintenance writer exists.

## Known local decisions and low findings

- The Node public root is a smaller auth/creator landing page, not exact PHP marketing/proof/branding/support/cross-promotion parity. Port that owner-approved content or explicitly accept the redesign before cutover.
- Node short links intentionally accept GET/HEAD only. PHP can route other methods; POST/webhook use is incompatible unless explicitly implemented.
- PHP's exact deployed Bulk limits are unknown because private configuration is absent. Node remains configurable from 1 to 500 and the dashboard/API now share the exact runtime values; the pilot defaults are 100 links/100 images until the exact target decision.
- PHP uses an average letterbox colour while Node Sharp uses a dominant colour. Golden-image acceptance is required; byte/pixel identity is not claimed.
- If an owner deletion commits but Redis invalidation alone fails, an existing positive redirect/OG cache entry can survive for about 60 seconds. This is a bounded low-severity consistency/security window, not an npm advisory.
- Analytics is disabled unless both private values are set. The current CSP is intentionally narrow and may block optional GA endpoints. Before enabling it, prove actual CSP reports/Tag Assistant behavior and disable or explicitly accept GA Enhanced Measurement/property-level URL/referrer collection.

## Pilot and release blockers

`npm run verify:pilot-candidate` correctly returns red with nine blockers:

1. exact pilot deployment binding;
2. exact schema/MariaDB/Redis parity;
3. redirect shadow/audit parity;
4. delivered-country/reporting parity;
5. operator-feature parity;
6. image crash recovery;
7. country fallback policy;
8. all-source runtime/store evidence; and
9. Aryan's exact isolated-pilot authorization.

Additional exact boundaries:

- The historical schema snapshot is `NOT VERIFIED` with 23 blockers: missing target binding, eight missing table-engine observations, `links.recent_activity_epochs`, `image_job_ledger_v1`, and 12 foreign-key observations. This means evidence is absent; it does not prove the future pilot schema is wrong.
- The delivered-country observer/reconciliation/report reader exists, but the private singleton publisher and live schedule do not. Single-domain dashboard+redirect mode also needs an explicit Delivered-reporting identity design.
- Maintenance is report-only. There is no Node quarantine/delete writer. Keep exactly one writer; never overlap an old PHP/private writer with a future Node writer.
- The current single-domain smoke uses memory/inline/passthrough, not the production MariaDB/Redis/BullMQ/current-engine stack.
- The inherited fallback `http://ip-api.com` remains a privacy/integrity/availability decision gate.
- Cloudways vhost/header sanitation, origin-auth overwrite, body limits, ModSecurity, static no-execute behavior, persistent paths, same-filesystem rename, backup/restore/scaling, exact Node/Sharp build, PM2 startup/reboot/drain/log rotation and rollback rehearsal remain provider-only `NOT VERIFIED`.
- Real Redis/BullMQ slow-job crash recovery remains `NOT VERIFIED`: the pilot must prove the old worker exits before replacement work, stalled work completes once, admission state releases, private partials reconcile and no false public image/success is emitted.
- No feature-equivalent, same-size PHP-versus-Node A/B result exists. CPU, RAM, context-switch, latency, throughput and image-queue improvements remain hypotheses, not promised percentages.

The first guarded Claude checkpoint remains historical evidence with `ORCHESTRATION_PERMISSION_DENIAL` and verdict `null`. After Aryan explicitly re-enabled Claude, a new exact-snapshot Claude Opus static review completed without permission denial and returned `revise`. It independently accepted the core Host/auth/cache/worker/activation/PM2/performance boundaries and identified six source findings: malformed legacy dashboard rows, over-aggressive ambiguous heartbeat failure, two numeric domain-rule couplings, unsafe legacy destination rendering, file-before-CSRF staging and the pre-auth Host oracle. All six were addressed. A separate Codex post-fix challenge then found the graceful-close singleton overlap plus unconfigured legacy-domain and read-validator edge cases; those are also addressed in the current source and the full 822-test gate is green. Claude has not re-reviewed the post-fix snapshot, so its result is challenge evidence, not approval or production authorization.

## Performance acceptance

Use the same dataset, database/cache state, traffic mix and server size for PHP and Node. Record CPU milliseconds/completed request, voluntary/involuntary context switches/request, throughput, p95/p99 latency, RSS, event-loop delay, DB queries/pool waits, Redis failures, disk bytes/upload, queue depth, image completion time and exact counter reconciliation. Async I/O can reduce occupied-worker and scheduling overhead; it does not remove MariaDB, disk or Sharp CPU work.

Bottom line: local core implementation and package evidence are green enough to prepare an isolated pilot, but fail-closed readiness correctly prevents Cloudways activation or live traffic until the exact data, publisher/maintenance, provider, rollback and performance gates are proven.
