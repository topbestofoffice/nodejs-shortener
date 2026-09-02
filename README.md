# Node.js Shortener

Standalone TypeScript migration of the current URL6X/VIDX1X/Plays9X shortener. It lives outside the PHP repository and does not modify production. The current development branch is `latest-setup`; production rollout remains separate and gated. One codebase supports:

- single-domain mode: one dashboard Host creates and redirects links;
- multi-domain mode: one dashboard Host plus one or more redirect-only Hosts;
- strict link identity by `(domain_id, code)` in both modes.

## Current status

This is an active local migration, **not a production-ready replacement**. The local implementation is broad enough for an isolated pilot candidate, but both the web process and image worker deliberately refuse `NODE_ENV=production` without a fresh, exact-target activation backed by the required receipts.

Implemented and locally tested:

- exact Host registry, origin-safe canonical aliases (including slash/backslash edge cases), unknown Host `421`, and redirect-only surface isolation;
- MariaDB store contract, finite connection/queue counts, UTC dates, BIGINT strings and one-hot accounting;
- Redis link/OG caches, PHP-compatible key prefixes, 15-second click claims and shared PM2 sessions;
- current redirect decision core: Meta, exact generated datacenter ranges, replay, blocking, country policy, diversion percentage, PHP-compatible signed cookie and attribution;
- trusted Cloudflare identity only behind an origin-authenticated, verified loopback proxy;
- PHP password verification, signed pre-login CSRF, `login_fail` throttle semantics, browser-session session cookie, 30-day remember rotation and authenticated CSRF; multipart clients must place the valid CSRF field before a file part so rejected requests never stage upload bytes;
- URL6X creation pause plus selectable VIDX1X and Plays9X creation, configuration-selected creation fallback, private browser-only defaults, bounded configurable bulk parsing, owner-scoped delete and PHP endpoint aliases;
- config-driven social-preview parity without hardcoded domain identity: D2 alone uses compact no-image metadata, while D1/D3 keep large-card behavior and D3 managed images emit alt/dimensions;
- streamed private image staging, Sharp 1200x630 normalization, transactional ownership, atomic publication, durable image-job ledger and bounded startup/background reconciliation;
- BullMQ submission deadlines, shared atomic queue admission, and one concurrency-one PM2 image worker that must acquire a target-scoped Redis singleton lease before consuming; one ambiguous refresh error is tolerated only inside the remaining TTL safety window, while a proven competing owner or exhausted window crash-stops the worker process immediately so an in-flight Sharp job cannot overlap a replacement;
- public registration with Admin toggle and throttling, dashboard/history/search/pagination, Single/Bulk result export, retained-image Quick Reuse, default-domain preference and logout;
- Admin users/settings/geo/Quality Control/session reset surfaces, click-triggered Shield reporting, delivered-country observation/read-only reports and report-only maintenance classification;
- optional authenticated-dashboard GA4/RUM with enumerated fields and no raw URL/account payloads; analytics is off unless both private configuration values are supplied;
- PM2 production-default configuration, exact runtime/package inventory, immutable-release activation/renewal tooling and installed Cloudways preflight;
- protected pilot-only proxy/header diagnostics.

Still pilot/release-blocking: exact pilot MariaDB/Redis/BullMQ/schema proof, redirect shadow/audit reconciliation, production publisher/schedule proof, a country-fallback decision, mutating retention/cleanup writers, Cloudways proxy/storage/reboot proof, rollback rehearsal, and same-size PHP-versus-Node A/B performance evidence. See [docs/PARITY_STATUS.md](docs/PARITY_STATUS.md) and [docs/MIGRATION_PLAN.md](docs/MIGRATION_PLAN.md).

## Local verification

Requirements: Node.js 22 or newer. The current run used Node.js 24.15.0; the exact Cloudways Node/Sharp combination is not yet verified.

```powershell
npm ci
npm run verify:evidence
npm run verify:pm2
npm run verify:cloudways-package
npm run verify:local
npm audit --omit=dev
```

Current result on 2026-09-02: 88 test files and 822 tests pass; the 15-check multi-domain and 12-check single-domain server smokes pass; all 17 historical PHP source hashes and the sanitized schema digest/shape match; both production-only and full dependency audits report zero known vulnerabilities. Real local browser checks proved login, Single create, Bulk create/Copy all, persisted history/search, Shield, Admin report reading and logout against the isolated in-memory fixture. A fresh post-fix image create also proved CSRF-first multipart submission, 1200×630 JPEG normalization, direct static `200`, correct redirect `301`, refreshed history/totals and no browser console errors. The global-session-reset mutation was not accepted or claimed by those browser passes.

`npm run test:coverage` currently passes the aggregate 80% gate at 84.11% statements, 80.60% branches, 89.97% functions and 85.77% lines. It includes `src/**/*.ts` except the two executable process entrypoints, `src/server.ts` and `src/workers/image-worker.ts`; importing either would start listeners/clients/signal handlers, so their behavior is exercised through component and process smokes instead. No per-critical-file coverage floors are configured.

`npm run verify:local` is green. `npm run verify:pilot-candidate` remains intentionally red with nine named blockers: deployment binding, exact schema/DB/Redis parity, redirect shadow parity, delivered-country/reporting parity, operator-feature parity, image crash recovery, country fallback policy, runtime/store tests, and Aryan's exact pilot authorization. `npm run verify:release` remains red until the provider, performance, cutover and rollback gates also have fresh parsed receipts bound to the exact target, artifact and configuration.

The historical schema snapshot is also intentionally `NOT VERIFIED`: it reports 23 missing observations/requirements, including target binding, eight table-engine observations, `links.recent_activity_epochs`, `image_job_ledger_v1`, and 12 foreign-key observations. That result does not prove the future pilot database is wrong; it proves that a fresh exact-target MariaDB readback is still required.

To run the safe in-memory server, copy `.env.example` to `.env`, keep `STORAGE_DRIVER=memory`, and optionally set `DEV_SEED_USERNAME` plus an 8-character-or-longer `DEV_SEED_PASSWORD`:

```powershell
npm run dev
```

The login client first calls `GET /auth/csrf`, keeps the returned cookie, and submits the returned token with `POST /auth/login`.

Do not point real domains or production data at this build. Production code is never unlocked globally. After the relevant gates pass, the exact isolated target receives a private, expiring activation bound to its runtime-configuration digest and verified artifact manifest. Other targets and changed artifacts/configurations remain blocked. Do not bypass this gate with the PM2 development override on a server.

## Runtime shape

```text
Apache/NGINX -> 127.0.0.1:<unique per-install port> -> PM2 shortener-web instance(s)
                                      |-- finite MariaDB pool/queue
                                      |-- Redis cache/session/click claim
                                      `-- atomic BullMQ admission -> one Sharp worker

public_html/uploads -> served directly by the Cloudways web stack
private_html/.../tmp -> streamed upload staging, never public
```

On 1 vCPU, start with one web instance and one concurrency-one image worker. On 2 vCPU, test two web instances and still one image worker. The worker starts paused, acquires the distributed singleton lease, publishes a heartbeat and only then consumes; web waits for complete MariaDB/Redis/storage/queue/worker readiness before it listens. After readiness, an ambiguous Redis refresh error is logged and tolerated only while another bounded attempt fits safely inside the confirmed lease TTL. An explicit ownership conflict or exhausted safety window immediately exits the worker instead of waiting for graceful Sharp completion. The worker writes only private temporary output; the web-owned durable ledger performs CAS transitions, atomic publication and the successful HTTP response, so crash recovery may reprocess work without exposing a false ready image. PM2 can use more cores and restart processes; it does not reduce database/image work or make CPU work free. The current upload request waits for image completion, so this is nonblocking isolation—not yet a `202 Accepted` background-upload experience.

One known low-severity consistency window remains: if an owner-scoped database deletion commits but Redis invalidation alone fails, a previously cached positive redirect/OG response may survive for the cache TTL (about 60 seconds). Immediate revocation would require a durable invalidation/version mechanism; querying MariaDB on every redirect would defeat the hot-path performance goal.

## Configuration

- Multi-domain example: [config/domains.local.example.json](config/domains.local.example.json)
- Single-domain example: [config/domains.single.example.json](config/domains.single.example.json)
- Environment contract: [.env.example](.env.example)
- PM2 processes: [ecosystem.config.cjs](ecosystem.config.cjs)
- Production gates: [config/production-readiness.json](config/production-readiness.json)
- Cloudways pilot: [docs/CLOUDWAYS_PILOT.md](docs/CLOUDWAYS_PILOT.md)

Secrets, production hostnames, database credentials, existing Redis prefixes, origin-auth values and exact `BROWSER_SCOPED_DEFAULT_USERS` tuples belong only in the server environment. Domain configuration can independently enable local-image alt text with `emitLocalImageAlt`.
