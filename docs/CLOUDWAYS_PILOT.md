# Cloudways pilot gate

This is the short decision checklist. The canonical, executable deployment and rollback guide is [../deploy/cloudways/README.md](../deploy/cloudways/README.md); if these two documents differ, follow that package guide.

Cloudways Support reported that a separate Flexible server is the suitable starting shape for MariaDB 10.11, Redis, PM2, persistent uploads, one web process and one persistent image worker. Support also reported that it can execute the root portion of PM2 startup and enable the Apache proxy modules. Those statements establish feasibility, not proof of the exact future server. Node must bind only to a unique per-install `127.0.0.1:<port>` selected for the pilot; port 3000 is only an example and must not be shared by two installations.

No deployment has been performed.

## Proposed filesystem split

- Immutable Node releases: unique direct children of a stable private `APP_PRIVATE_ROOT/releases/`; never use a mutable `current` directory as the release identity.
- Rendered `.env`, durable `PM2_HOME` and temp state: stable private paths under `APP_PRIVATE_ROOT` but outside every release directory.
- Private upload staging: persistent `private_html/nodejs-shortener-data/tmp`.
- Final images: `public_html/uploads` so NGINX/Apache serves them without Node.
- Public proxy rules and genuinely public assets only: `public_html`.

Do not place `.env`, source maps, TypeScript, package metadata or private temp files in a web-accessible path unless the web-server denial rules are proven.

## Support actions on the isolated pilot

1. Provision the exact provider/region and start at 1 vCPU/2 GB.
2. Confirm the Node binary/version and Sharp/libvips installation from the release directory.
3. Enable `mod_proxy`/required proxy modules.
4. Proxy every pilot Host to its selected unique `127.0.0.1:<port>`, preserve the original Host, exclude the exact static upload path, and keep that port non-public.
5. Set/overwrite the private origin-auth request header at the trusted proxy; never forward a client-supplied copy.
6. Confirm effective NGINX body size, ModSecurity body limit, client/request buffering, body/read/connect timeouts and Apache upstream timeout.
7. Confirm `public_html/uploads` and the chosen `private_html` data path survive Git deployments, restore and vertical scaling and are both included in tested backup/restore.
8. After PM2 is installed and the process file is validated, run `pm2 startup`; send the exact root command PM2 prints to Support, then run `pm2 save` as the application user.
9. Exclude `public_html/uploads` and other real public files/directories before the Node proxy, then prove a static image bypasses Node.
10. Ask whether Cloudways, the proxy, or any uptime/load-balancing layer polls `/health/live`, `/health/ready`, or neither, and whether a `503` removes the application from traffic. Capture the exact answer before interpreting worker/Redis recovery results.
10. Install/configure PM2 log rotation and verify application-user ownership, disk limits and retained error evidence.

## Header proof before traffic

Temporarily enable the protected `/__pilot/headers` endpoint with a separate random token hash. Test both apex Hosts and intentionally supplied duplicate/spoof values. Capture what Node actually receives for:

- `Host` and any forwarded Host;
- `X-Real-IP`, every `X-Forwarded-For` position and Fastify `request.ip`;
- `X-Forwarded-Proto` and Fastify protocol;
- Cloudflare/Cloudways country headers.

Only then set `TRUST_PROXY=loopback`, `PROXY_CHAIN_VERIFIED=true`, and decide whether Cloudflare country headers are safe. Disable the diagnostic endpoint before live traffic.

## PM2 sizing

- 1 vCPU/2 GB: `WEB_INSTANCES=1`, one image worker, worker concurrency 1.
- 2 vCPU/4 GB after measurement: begin with `WEB_INSTANCES=2`, one image worker.
- MariaDB connection budget is `WEB_INSTANCES * MYSQL_CONNECTION_LIMIT`; start small and measure queueing.
- Count all Redis connections too: each web process uses application/session/queue connections, and the worker uses BullMQ plus admission-ledger connections. Confirm the measured total against the pilot limit.
- Verify the effective Redis policy with `CONFIG GET maxmemory-policy` (or Support-provided equivalent). BullMQ requires durable queue keys; use/prove `noeviction` rather than allowing queue state to be evicted under pressure.

PM2 lets Node use multiple CPU cores through separate web processes and restarts failed processes. It does not share in-memory state, so sessions, click claims, settings and queues must remain in Redis/MariaDB. It also does not reduce the CPU needed to decode or encode an image; the bounded worker isolates and smooths that CPU work. Ordinary use of the checked process file defaults to `NODE_ENV=production`; the development override is local-only and must never be used to bypass the release lock on Cloudways.

The image worker starts paused, acquires its target-scoped Redis singleton lease, begins renewal and publishes the readiness heartbeat before consuming. A proven different owner still stops it immediately; one ambiguous refresh failure is tolerated only while another bounded attempt fits inside the last-confirmed TTL safety window. Proven/exhausted lease loss is a deliberate crash-stop, not graceful BullMQ close: otherwise an active Sharp job could outlive the TTL and overlap a replacement. The worker writes only private output; web-owned ledger CAS and atomic rename control publication. The web process performs a bounded read-only image-ledger preflight and then waits for complete MariaDB/Redis/storage/queue/worker readiness before it listens or signals PM2 ready. `ecosystem.config.cjs` explicitly assigns ongoing web-side recovery to `NODE_APP_INSTANCE=0`, drains one durable job per pass, and derives listen/kill timeouts from the configured preflight, image-job and Redis deadline bounds. Keep `IMAGE_RECOVERY_PREFLIGHT_TIMEOUT_MS` at its checked default for the first pilot unless the measured MariaDB query requires a reviewed change. If any timeout variable changes, export it in the environment used to start/reload PM2; the ecosystem file passes sanitized values explicitly so a different `.env` value cannot make PM2's kill bound shorter than the running code's bound. Prove that a one-interval Redis pause does not restart the worker, repeated failure crosses the safety boundary exactly once, a backlog larger than 100 continues draining after readiness, instance 1 never becomes a second scanner, a duplicate worker never consumes, the old PID exits before replacement work, stalled work completes once, admission state releases, partial temp files reconcile, no false public file/success appears, and SIGTERM remains graceful; local tests do not prove those provider/runtime outcomes.

Before calling startup proven, use the exact production Node/Sharp/native-module build and demonstrate: web and worker recovery after a forced crash, `pm2 save`, server reboot, a Cloudways maintenance/restart event if Support can provide one, one successful upload, one static fetch, and bounded logs. `verify:local` is green as of 2026-09-02 with 88 files/822 tests; `verify:pilot-candidate` is still red on nine exact-target/evidence gates. Only after those pre-pilot gates pass should the exact pilot receive an artifact-bound, expiring activation under the ignored `private/activation/` directory. Set `NODE_SHORTENER_DEPLOYMENT_STAGE`, `NODE_SHORTENER_DEPLOYMENT_TARGET_ID`, `NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE` and `NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256` to that exact activation. Copied, expired, modified or generic activations fail closed. Do not wait for final Cloudways/performance/cutover gates—that would be circular—and never run the server under the development override.

## Cutover/rollback gate

Do not change production DNS until exact feature parity, security tests, schema-delta comparison and same-size load tests pass. Keep PHP production unchanged during the pilot. At cutover, stop the old writer before enabling the Node writer. Rollback uses the previous DNS/Cloudflare route only while database compatibility, Redis prefixes, signed-cookie compatibility and the one-writer invariant remain intact.
