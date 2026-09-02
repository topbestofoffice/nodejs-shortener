# Architecture

## Domain model

Host routing is configuration, not duplicated code. Each row has an immutable numeric ID, canonical Host, optional aliases, public surface, independent `active`/`allowCreate` switches, an optional unique `creationFallback`, and an `acceptUnprovenDeliveredClaim` reporting rule. Alias redirects are built only under the configured canonical origin; scheme-relative targets are collapsed to an origin-form path and ambiguous backslash targets are rejected.

In the first multi-domain pilot:

| Domain | ID | Surface | Active | Create |
|---|---:|---|---|---|
| URL6X | 1 | dashboard and management | yes | paused |
| VIDX1X | 2 | public redirects only | yes | yes |
| Plays9X | 3 | public redirects only | yes | yes |

Every lookup, cache key, deletion and write includes the domain ID. A code can exist on multiple domains without collision. VIDX1X and Plays9X do not expose login, dashboard, API, Admin, Stats, health or diagnostic paths.

For a single-domain installation, configure one active dashboard row with `allowCreate=true`. No application fork is required.

## Request process

When private origin authentication is enabled, the web process verifies that proxy credential before disclosing whether a Host is configured. It then resolves the exact Host before session, cache or database work. Redirect-only Hosts skip all session/remember restoration. It never accepts `X-Forwarded-Host`. Cloudflare IP/country headers are considered only behind a verified loopback proxy and a privately configured origin-auth header that the proxy overwrites; the pilot must prove the exact chain against duplicate and spoofed headers.

`REDIRECT_ENGINE=current` composes the captured PHP-compatible provider, policy ordering, ranges, country resolution, click claim and signed diversion cookie. The cookie deliberately uses the existing private IP-hash salt during migration so Node and PHP can interpret the same decision. The generic fallback country lookup still uses inherited plaintext `http://ip-api.com`; replacing it or explicitly accepting it is a release gate.

Redirect waits are nonblocking where the drivers support it, but async does not make work free. MariaDB, Redis and disk keep bounded pools/queues. CPU-heavy image decode/resize/encode never runs in the web process in production; one BullMQ worker handles one image at a time and publishes by atomic rename. The current HTTP upload route still waits for the worker result, so it isolates work but is not yet a detached `202 Accepted` flow.

## Resource boundaries

- MariaDB pool defaults to a bounded per-web-process size; total connections equal pool size times PM2 web instances. A finite queue exists, but a measured connection-acquisition deadline and saturation test are still required.
- Redis operations have short connection/command bounds; cache failure falls back and a click-claim ambiguity counts fail-open.
- Link/OG cache keys, the click-dedup key shape, and the privacy hash follow the current PHP contract when `APP_NAMESPACE` and `IP_HASH_SECRET` are set to the existing private values. This supports a controlled rollback without exposing either value.
- Owner deletion commits in MariaDB before best-effort Redis invalidation. If only that invalidation fails, an already-cached positive redirect/OG response can remain usable for the roughly 60-second cache TTL. This is a bounded consistency window; immediate revocation needs a durable versioned invalidation/outbox rather than a database read on every redirect.
- Upload bytes stream to a private temporary file. The worker validates real JPEG/PNG/GIF/WebP data, a 20-megapixel decoded limit, normalizes to progressive JPEG, and only then publishes under `uploads/`.
- BullMQ admission uses a shared Redis sorted-set/Lua reservation ledger across all PM2 web processes. Terminal completion/failure and the worker `finally` path release capacity; real Redis crash/restart reconciliation is still unproven.
- The image worker is created paused. It connects to Redis, acquires the target-scoped singleton lease, starts lease renewal and publishes a short-lived readiness heartbeat before it begins consuming. A proven competing owner crash-stops it immediately. An ambiguous refresh failure is tolerated only inside the last-confirmed TTL safety window; exhaustion signals loss once and immediately exits the process rather than waiting for in-flight Sharp work. The worker can leave only private temporary output. The web-owned ledger controls output-ready/publication CAS, atomic rename and the successful response, so replacement processing cannot make a partial result public. A losing process never consumes or signals ready. Exact Redis/BullMQ stalled-job recovery remains an isolated-pilot proof.
- Web startup performs the bounded read-only ledger preflight and then waits for complete dependency readiness, including the image-worker heartbeat, before binding the loopback socket. After listen, only `NODE_APP_INSTANCE=0` drains durable recovery work, one CAS-protected job per pass. Failures are contained and retried, shutdown clears the timer and awaits the active pass, and a manual-review row is removed from the due queue so it cannot starve later jobs. Backlog completion, Redis restart and crash recovery still require the isolated Cloudways pilot.
- The old PHP lifecycle can retain expired ownership rows forever, eventually exhausting the global image cap and preventing account deletion. Node currently provides deterministic report-only linked/orphan classification and receipts; a separately reviewed one-writer mutating retention/orphan job is still absent. The broken PHP lifecycle is not a parity target.
- Bulk creation is capped and deliberately partial/non-transactional to preserve current behavior.
- PM2 restarts crashed processes and can run multiple web instances on multiple cores. The checked process file defaults to production, and both web and worker currently fail closed under the shared production startup lock. That lock is removed only in a separately reviewed change after local/pilot-candidate gates and exact isolated-target approval; the pilot then exercises full production invariants. PM2 does not make CPU work disappear and it does not replace application backpressure.
- PM2's web `listen_timeout` is derived from the exact read-only recovery-preflight deadline plus startup margin. Its `kill_timeout` covers the longest two-window BullMQ wait, bounded Redis submission/state deadlines and cleanup margin for one background batch; this prevents the previous fixed 15-second restart loop in local configuration, but the effective PM2 behavior remains `NOT VERIFIED` until the real server test.
- Optional GA4/RUM runs only on the authenticated dashboard and exposes fixed event/dimension buckets. The current CSP is intentionally narrow and analytics is disabled in the pilot template. Before enabling it, prove the actually used Google endpoints and property settings (including Enhanced Measurement) without broadening CSP speculatively or emitting raw URLs, referrers or account identifiers.

## Migration boundary

The pilot must use a separate server and database clone or synthetic fixture. PHP production remains the rollback system. During a later cutover, only one runtime may write click accounting, maintenance history or cleanup state. DNS/Cloudflare routing is the rollback switch; database divergence after dual writes is not an acceptable rollback plan.
