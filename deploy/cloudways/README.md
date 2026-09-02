# Cloudways Flexible isolated pilot package

This package prepares an isolated Cloudways Flexible pilot. It does not deploy,
create activation evidence, change DNS, or claim that a provider setting has
been verified. Keep the PHP production application and its database untouched.

The expected request path is:

```text
Cloudflare (if enabled) -> Cloudways NGINX -> Apache -> 127.0.0.1:<unique port> -> Node
                                                     \
                                                      -> public_html/uploads and existing public files
```

Cloudways Support has confirmed that Apache can proxy to a loopback Node
process, but `mod_proxy` is disabled by default. The exact vhost, forwarded
headers, NGINX limits, ModSecurity limits, persistence, reboot recovery, and
backup behavior remain provider-only checks until captured on the real pilot.

## 1. Isolate every installation

Give each installation one stable `APP_PRIVATE_ROOT` outside `public_html`.
Create immutable releases only as direct children of
`APP_PRIVATE_ROOT/releases/`, and set `APP_RELEASE_ROOT` to the one exact child
being activated. Keep the rendered env, durable `PM2_HOME`, and temp directory
under the stable base but outside `releases/`; a new release must not create a
second PM2 daemon. Render `pilot.env.example` into a private, ignored file under
that stable base. Never edit the example with real values.

A single-domain and a multi-domain pilot may use the same server only when each
has a different stable base and every per-install value below is different.

| Boundary | Required per-install value |
| --- | --- |
| Node listener | loopback-only `PORT` |
| PM2 | `PM2_PROCESS_PREFIX` |
| application/cache | `APP_NAMESPACE` |
| Redis | `REDIS_KEY_PREFIX` and, where possible, a dedicated credential/database |
| MariaDB | dedicated `MYSQL_DATABASE` and least-privilege `MYSQL_USER` |
| files | stable `APP_PRIVATE_ROOT`, exact `APP_RELEASE_ROOT`, `PRIVATE_TEMP_DIR`, and `PUBLIC_UPLOAD_DIR` |
| runtime | exact `NODE_BINARY`, `PM2_CLI_SCRIPT`, `PM2_VERSION`, and durable `PM2_HOME` |
| activation | exact deployment target, activation file, and activation digest |
| domains | exact `DOMAIN_CONFIG_FILE` and attached hostnames/certificates |

Do not share a Redis prefix, upload directory, PM2 prefix, database, or port
between the single-domain and multi-domain installs. Account for both installs
when setting MariaDB/Redis connection limits.

## 2. Ask Cloudways Support for the private vhost work

Give Support the selected loopback port, never a secret. Ask them to:

1. enable `mod_proxy`, `mod_proxy_http`, and the required rewrite support;
2. keep the original Host with `ProxyPreserveHost On` in the Support-managed
   vhost (this directive does not belong in `.htaccess`);
3. strip client-supplied duplicates and set the required forwarding headers in
   the trusted proxy layer;
4. enable the private vhost mechanism needed to overwrite the configured origin
   authentication header on every proxied request (normally `mod_headers`); and
5. set an exact `/uploads` vhost policy that disables directory listing/autoindex,
   PHP and every other executable/script/CGI handler,
   disallows per-directory `.htaccess`/`.user.ini` overrides, rejects executable
   extensions, and serves uploaded bytes only as inert static content; mirror
   the nested-dotfile and sensitive config/backup extension denies in both the
   front NGINX layer and Apache vhost before any uploads static bypass; and
6. confirm that the public port is not exposed and only `127.0.0.1:<unique
   port>` can reach Node; and
7. state whether Cloudways, Apache/NGINX, or any uptime/load-balancing service
   polls `/health/live`, `/health/ready`, or neither, plus whether a `503`
   withdraws the application from traffic.

The origin-auth value must live in Support-managed private configuration. Never
put it in `public_html`, `.htaccess`, Git, a support ticket, or this package. If
Cloudways cannot privately overwrite that header, the current production
runtime must remain blocked; do not weaken the application gate.

Ask Support to use 90 seconds as the initial Apache/NGINX upstream and read
timeout, subject to measurement on the pilot. The effective request-body limit
must be at least `MAX_UPLOAD_BYTES + 4 MiB`; with the template's 8 MiB image
limit, that is a 12 MiB request envelope. NGINX body/read/client timeouts,
request buffering, Apache proxy timeout, and ModSecurity request-body limits can
each reject the request independently. Capture the effective values rather than
assuming dashboard values control Node traffic.

## 3. Install and build one immutable release

Use a new direct child of `APP_PRIVATE_ROOT/releases/`. Do not build inside
`public_html`, do not reuse another shortener's directory, and do not place
durable PM2/config/temp state inside a versioned release. Resolve the absolute
Node binary and npm CLI script first; record their paths, versions and SHA-256.
Every build command below pins that Node directory as the only Node entry on
`PATH`, so an nvm/provider default cannot silently change the runtime mid-build.
Resolve the PM2 CLI file, then capture its exact semantic version before
rendering `PM2_VERSION`; do not copy a version from package documentation:

```sh
PM2_HOME=__PRIVATE_PM2_HOME_ABSOLUTE_PATH__ __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_PM2_CLI_SCRIPT__ --version
```

Accept one bounded `X.Y.Z` (or explicit prerelease) value only. The safe
inventory reruns this command internally and rejects a different installed
version.

```sh
cd __APP_PRIVATE_ROOT_ABSOLUTE_PATH__/releases/__UNIQUE_RELEASE_ID__
PATH=__ABSOLUTE_NODE_BINARY_DIRECTORY__:/usr/bin:/bin __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_NPM_CLI_SCRIPT__ ci
PATH=__ABSOLUTE_NODE_BINARY_DIRECTORY__:/usr/bin:/bin __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_NPM_CLI_SCRIPT__ run verify:cloudways-package
PATH=__ABSOLUTE_NODE_BINARY_DIRECTORY__:/usr/bin:/bin __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_NPM_CLI_SCRIPT__ run check
PATH=__ABSOLUTE_NODE_BINARY_DIRECTORY__:/usr/bin:/bin __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_NPM_CLI_SCRIPT__ run build
PATH=__ABSOLUTE_NODE_BINARY_DIRECTORY__:/usr/bin:/bin __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_NPM_CLI_SCRIPT__ run verify:pm2
PATH=__ABSOLUTE_NODE_BINARY_DIRECTORY__:/usr/bin:/bin __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_NPM_CLI_SCRIPT__ prune --omit=dev
```

Capture the exact MariaDB contract with an explicit target and a new private,
non-overwriting output path; the npm command intentionally has no default
target or evidence filename:

```sh
PATH=__ABSOLUTE_NODE_BINARY_DIRECTORY__:/usr/bin:/bin __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_NPM_CLI_SCRIPT__ run verify:schema:database -- --target-id=__EXACT_CLOUDWAYS_DEPLOYMENT_TARGET_ID__ --snapshot-output=private/schema-evidence/__UNIQUE_SCHEMA_SNAPSHOT__.json
```

Do not copy UI assets from the release into `public_html`: `/assets` must stay
proxied to Node so the exact files served are the manifest-bound release files.
Keep only this application's `.htaccess` and `uploads` directory in its public
webroot; keep the Node release, rendered environment, activation material,
logs, and temporary image files private. Install
`public_html.htaccess.example` as `.htaccess` only after replacing
`__UNIQUE_LOOPBACK_PORT__` and saving the prior file as a private rollback copy.

The example bypasses Node for `/uploads` before checking whether the requested
file exists. Therefore a missing upload is a web-stack 404, not a Node request.
It does not bypass Node for other existing files/directories. If every hostname
attached to the webroot must not expose the same uploaded files, Support
must add host-scoped vhost rules and the pilot must test that host matrix before
activation.

## 4. Activate without manufacturing evidence

The production process is intentionally fail-closed. Render every non-activation
value into an owner-only private environment file. For the first activation,
omit only `NODE_SHORTENER_PRODUCTION_ACTIVATION_FILE` and
`NODE_SHORTENER_PRODUCTION_ACTIVATION_SHA256`; unresolved placeholders are not
accepted. Existing exact activation values may remain during a renewal.

1. After the exact build above, calculate the manifest/runtime bindings without
   writing a file:

   ```sh
   __ABSOLUTE_NODE_BINARY__ tools/generate-production-activation.mjs --plan --env-file=__ABSOLUTE_PRIVATE_RENDERED_ENV_FILE__
   ```

2. Bind `config/production-readiness.json` and every receipt to that exact
   target, artifact digest, runtime digest, stage, and (for release) pilot
   configuration. Receipts belong only under ignored `evidence/readiness/`.
   Never put a credential, token, cookie, connection URI, or private path/value
   in a receipt observation.
3. Complete the exact pilot-candidate gates and run the package script with the
   pinned binary (`npm run verify:pilot-candidate` is only its shorthand); a
   failure is a stop, not a prompt to invent receipts:

   ```sh
   PATH=__ABSOLUTE_NODE_BINARY_DIRECTORY__:/usr/bin:/bin __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_NPM_CLI_SCRIPT__ run verify:pilot-candidate
   ```
4. Create the activation. The tool reruns the same readiness verifier at the
   current system UTC, rejects stale/unbound/tracked/public/secret-looking
   evidence, uses the startup manifest contract from the built `dist`, and
   publishes owner-only private files atomically without overwrite:

   ```sh
   __ABSOLUTE_NODE_BINARY__ tools/generate-production-activation.mjs --activate --env-file=__ABSOLUTE_PRIVATE_RENDERED_ENV_FILE__
   ```

   `issuedAt` is generated only from the current system UTC clock; there is no
   operator-supplied/backdated timestamp option. The default pilot lifetime is
   seven days. A different bounded lifetime requires the explicit
   `--lifetime-hours=N` argument. Expiry is checked at process startup/restart;
   it does not hard-kill an already-running process. If traffic must stop at the
   deadline, use a separately approved scheduled traffic-removal/PM2-stop
   contract.
5. Copy only the printed relative activation path and SHA-256 into the two
   activation environment keys. The activation separately binds the complete
   runtime configuration, stable/private and exact release roots, exact Node and
   PM2 CLI file/path digests, PM2 topology/resource/restart policy, immutable
   readiness-document copy/receipt digests, and artifact manifest (including
   `ecosystem.config.cjs`). Each receipt path must be unique and immutable; never
   overwrite or delete evidence referenced by an unexpired activation. Set the
   final environment file to owner-read/write only. Do not `source` or `eval`
   it; passwords can contain shell characters.
6. Verify the installed private environment and installed public `.htaccess`
   together. This prints only safe digests/status, rejects unexpected proxy or
   static rules, proves the loopback port match, and runs the actual production
   startup gate:

   ```sh
   __ABSOLUTE_NODE_BINARY__ tools/verify-cloudways-installed.mjs --env-file=__ABSOLUTE_PRIVATE_RENDERED_ENV_FILE__ --htaccess=__ABSOLUTE_PUBLIC_HTML_HTACCESS__
   ```

### Renew before startup authorization expires

Record the printed `expires-at` in monitoring and alert at least 72 hours before
it (immediately when less than 72 hours remain). Reboot/recovery proof is valid
only until that recorded expiry. An already-running process may continue after
expiry, but a crash, maintenance restart, or reboot will fail closed.

For renewal, refresh every required receipt against the unchanged exact
target/artifact/configuration, rerun the green readiness gate, and create a new
non-overwriting activation at current UTC. Write a new owner-only rendered env
file containing the new activation path/digest; never edit the env currently
used by the running processes. Run installed preflight against that new file,
then perform a no-overlap same-release restart: remove traffic, stop web, prove
the queue and active-job count are zero, restart the singleton worker with the
new env, then restart web and assert the exact current state:

```sh
__ABSOLUTE_NODE_BINARY__ tools/verify-cloudways-installed.mjs --env-file=__NEW_RENEWAL_PRIVATE_ENV_FILE__ --htaccess=__ABSOLUTE_PUBLIC_HTML_HTACCESS__
__ABSOLUTE_NODE_BINARY__ tools/safe-pm2-inventory.mjs --env-file=__CURRENT_PRIVATE_ENV_FILE__ --pm2-cli=__ABSOLUTE_PM2_CLI_SCRIPT__ --expect=current-online
__ABSOLUTE_NODE_BINARY__ --env-file=__CURRENT_PRIVATE_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ stop __EXACT_PM2_PROCESS_PREFIX__-web
__ABSOLUTE_NODE_BINARY__ --env-file=__NEW_RENEWAL_PRIVATE_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ restart __EXACT_PM2_PROCESS_PREFIX__-image-worker --update-env
__ABSOLUTE_NODE_BINARY__ --env-file=__NEW_RENEWAL_PRIVATE_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ restart __EXACT_PM2_PROCESS_PREFIX__-web --update-env
__ABSOLUTE_NODE_BINARY__ tools/safe-pm2-inventory.mjs --env-file=__NEW_RENEWAL_PRIVATE_ENV_FILE__ --pm2-cli=__ABSOLUTE_PM2_CLI_SCRIPT__ --expect=current-online
curl --fail --silent --show-error https://__PILOT_DASHBOARD_HOST__/health/ready
__ABSOLUTE_NODE_BINARY__ --env-file=__NEW_RENEWAL_PRIVATE_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ save
```

Retain the prior env and activation for diagnosis/rollback, and update the alert
to the new printed expiry only after inventory, readiness, and saved-dump proof
pass. If empty-queue proof is unavailable, use the traffic-off stop/delete/start
protocol in Section 5 instead of renewing in place.

Keep `PILOT_HEADER_DIAGNOSTICS=false` except for the short, token-protected
header capture. Any accepted runtime change requires the matching exact
activation; do not carry an old digest across configuration drift.

## 5. Start PM2 and prove reboot recovery

Use one application user and the one durable `PM2_HOME` under
`APP_PRIVATE_ROOT`; do not use `sudo` for application PM2 commands. First
capture the daemon inventory through the bundled redacting helper. It reads the
raw PM2 process JSON internally but never prints `pm2_env`, paths, or secrets:

```sh
__ABSOLUTE_NODE_BINARY__ tools/safe-pm2-inventory.mjs --env-file=__ABSOLUTE_PRIVATE_RENDERED_ENV_FILE__ --pm2-cli=__ABSOLUTE_PM2_CLI_SCRIPT__ --expect=absent
```

The helper requires the exact activation-bound Node and PM2 CLI files, stable
PM2 home, exact PM2 `--version`, one expected image worker, and exactly
`WEB_INSTANCES` web processes. A wrapper hash alone is not accepted as proof of
the global PM2 package runtime.
It classifies an existing expected name as `current-release` or
`same-lineage-old-release` only when its cwd is an exact direct child of this
stable base's `releases/` directory and its script is the expected file below
that cwd. Any foreign lineage or duplicate count is fatal.

For the first isolated start, the expected names must be absent. Start the exact
manifest-bound ecosystem with the exact binary/env/PM2 CLI, then save and
inventory the same daemon:

```sh
__ABSOLUTE_NODE_BINARY__ --env-file=__ABSOLUTE_PRIVATE_RENDERED_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ start __APP_RELEASE_ROOT_ABSOLUTE_PATH__/ecosystem.config.cjs --env production --update-env
__ABSOLUTE_NODE_BINARY__ --env-file=__ABSOLUTE_PRIVATE_RENDERED_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ status
__ABSOLUTE_NODE_BINARY__ --env-file=__ABSOLUTE_PRIVATE_RENDERED_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ save
__ABSOLUTE_NODE_BINARY__ tools/safe-pm2-inventory.mjs --env-file=__ABSOLUTE_PRIVATE_RENDERED_ENV_FILE__ --pm2-cli=__ABSOLUTE_PM2_CLI_SCRIPT__ --expect=current-online
```

Never use `startOrReload` for an unproven worker cutover: it can overlap old and
new queue consumers. For release A -> B, first remove pilot traffic, stop the A
web process so it cannot admit new image work, prove the queue and active-job
count are zero, then stop and delete only the two exact prefixed names. Start B
only after the sanitized inventory reports both absent:

```sh
__ABSOLUTE_NODE_BINARY__ tools/safe-pm2-inventory.mjs --env-file=__NEW_RELEASE_PRIVATE_ENV_FILE__ --pm2-cli=__ABSOLUTE_PM2_CLI_SCRIPT__ --expect=same-lineage-old-online
__ABSOLUTE_NODE_BINARY__ --env-file=__OLD_RELEASE_PRIVATE_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ stop __EXACT_PM2_PROCESS_PREFIX__-web
__ABSOLUTE_NODE_BINARY__ --env-file=__OLD_RELEASE_PRIVATE_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ stop __EXACT_PM2_PROCESS_PREFIX__-image-worker
__ABSOLUTE_NODE_BINARY__ --env-file=__OLD_RELEASE_PRIVATE_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ delete __EXACT_PM2_PROCESS_PREFIX__-web __EXACT_PM2_PROCESS_PREFIX__-image-worker
__ABSOLUTE_NODE_BINARY__ tools/safe-pm2-inventory.mjs --env-file=__NEW_RELEASE_PRIVATE_ENV_FILE__ --pm2-cli=__ABSOLUTE_PM2_CLI_SCRIPT__ --expect=absent
__ABSOLUTE_NODE_BINARY__ --env-file=__NEW_RELEASE_PRIVATE_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ start __NEW_APP_RELEASE_ROOT_ABSOLUTE_PATH__/ecosystem.config.cjs --env production --update-env
__ABSOLUTE_NODE_BINARY__ --env-file=__NEW_RELEASE_PRIVATE_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ save
__ABSOLUTE_NODE_BINARY__ tools/safe-pm2-inventory.mjs --env-file=__NEW_RELEASE_PRIVATE_ENV_FILE__ --pm2-cli=__ABSOLUTE_PM2_CLI_SCRIPT__ --expect=current-online
```

If traffic isolation or empty-queue proof is unavailable, do not perform an
in-place worker cutover; use the isolated pilot or the PHP/DNS fallback. An
expected name owned by another application is a hard collision: choose a new
prefix and never update, delete, or restart that process. The ecosystem fails
hard for a malformed explicit prefix instead of falling back to a shared name.

Node 22's `node --env-file=` parser avoids executing environment values as shell
code. Resolve and verify the PM2 CLI script once for the application user; do
not guess its path. PM2's saved dump contains the inherited process environment,
so confirm that the stable PM2 home and dump are owner-only and never paste
`pm2 env` output into tickets or evidence. Any provider Node or PM2 patch changes
the bound path/content digest: rebuild native modules, rerun readiness/preflight,
issue a new activation, restart with the exact new pair, and save again.

On a 1-vCPU pilot use one web instance and one singleton image worker. On a
measured 2-vCPU pilot, `WEB_INSTANCES=2` may use both cores; the image worker
must remain one bounded process. More workers can increase CPU, RAM, database
connections, and disk contention, so process count is not itself a performance
gain.

The ecosystem declares the image worker first. It sends PM2 `ready` only after
publishing its expiring Redis heartbeat; web then waits up to 12 seconds for the
complete dependency probe before opening its loopback listener. A Lua result
proving another lease owner stops the worker immediately. An ambiguous refresh
error is logged and tolerated only while another bounded attempt fits inside the
last-confirmed TTL safety window; exhausting that window signals loss once and
crash-stops the process. This is intentionally not graceful `Worker.close()`:
an active in-process Sharp job must not outlive the lease TTL and overlap a
replacement. The worker writes only private temporary output; web-owned ledger
CAS and atomic rename control publication. When a process
exits before 30 seconds, PM2 retries every 30 seconds for at most 240 unstable
starts (roughly two hours) so a delayed MariaDB/Redis boot does not exhaust ten
quick retries. After that bound it remains failed for operator investigation.
On the isolated pilot, keep a dependency unavailable for more than ten restart
cycles, restore it before the bound, and prove both processes become online
without a manual restart. Actual provider dependency timing remains unverified.

Ask Cloudways Support to run a root startup command that contains the exact
application user, stable PM2 home, absolute Node binary, and absolute PM2 CLI;
do not accept a generated command that resolves a different bare `pm2` from
root's `PATH`. The exact shape to have Support validate for its init system is:

```sh
sudo env PM2_HOME=__PRIVATE_PM2_HOME_ABSOLUTE_PATH__ __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_PM2_CLI_SCRIPT__ startup systemd -u __EXACT_APPLICATION_USER__ --hp __EXACT_APPLICATION_USER_HOME__
```

After Support installs it, save as the application user with the exact runtime:

```sh
__ABSOLUTE_NODE_BINARY__ --env-file=__ABSOLUTE_PRIVATE_RENDERED_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ save
```

Inspect the installed service with Support and record its application user,
`PM2_HOME`, ExecStart Node/CLI paths and hashes, PM2/Node versions, and dump path.
A maintenance/reboot test must show that exact service resurrecting both
uniquely prefixed processes with expected cwd, listener, web count, and one
image worker; rerun the safe inventory with `--expect=current-online` after
every reboot. The phrases `pm2 startup` and `pm2 save` are not permission to use
a PATH-selected binary.

PM2 logs need rotation. First inventory other PM2 applications because the
`pm2-logrotate` module is user-global. If approved for that server, configure a
bounded size, retention, compression, and rotation schedule, then force one
test rotation and verify that web/worker logs remain readable without a restart.
If Cloudways supplies log rotation instead, capture that exact policy. Do not
claim rotation from `merge_logs` alone.

## 6. Verify the exact pilot

Run these checks without production traffic:

```sh
PATH=__ABSOLUTE_NODE_BINARY_DIRECTORY__:/usr/bin:/bin __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_NPM_CLI_SCRIPT__ run verify:cloudways-package
PATH=__ABSOLUTE_NODE_BINARY_DIRECTORY__:/usr/bin:/bin __ABSOLUTE_NODE_BINARY__ __ABSOLUTE_NPM_CLI_SCRIPT__ run verify:pm2
__ABSOLUTE_NODE_BINARY__ --env-file=__ABSOLUTE_PRIVATE_RENDERED_ENV_FILE__ __ABSOLUTE_PM2_CLI_SCRIPT__ status
curl --fail --silent --show-error https://__PILOT_DASHBOARD_HOST__/health/live
curl --fail --silent --show-error https://__PILOT_DASHBOARD_HOST__/health/ready
```

`/health/live` only proves the process is alive. `/health/ready` must be 200
before traffic and must turn 503 when its required MariaDB, Redis, upload/temp
directory, or BullMQ-worker dependency is unavailable. Never expose the Node
port publicly to perform these checks. The application does not itself remove
web routes from service after a readiness failure; the provider/monitor action
is a separate Cloudways fact that must be captured from item 7 above. During the
Redis recovery test, prove one ambiguous refresh failure does not restart the
worker, repeated failure crosses the TTL safety boundary once, and an explicit
different-owner result still stops immediately. With a deliberately slow real
job, also prove the old PID exits before replacement work, only one image PID is
active, the stalled job completes once, admission state releases, private
partials reconcile, and no public file or successful HTTP result appears early.

### Header and spoof proof

Temporarily enable the protected `/__pilot/headers` route with a separately
generated diagnostic token digest. Through the public HTTPS hostname, record:

- original `Host` for apex, `www`, dashboard, and redirect-only hosts;
- immediate peer, `X-Forwarded-For`, `X-Forwarded-Proto`, and any forwarded Host;
- `CF-Connecting-IP`, `CF-IPCountry`, and the behavior without Cloudflare; and
- repeated/duplicate forms of every identity header.

Repeat the calls while deliberately supplying false `X-Forwarded-For`,
`X-Forwarded-Proto`, `X-Forwarded-Host`, `CF-Connecting-IP`, `CF-IPCountry`, and
the configured origin-auth header. The trusted proxy must strip or overwrite
client values; Node must never accept a client-chosen identity. Confirm that a
direct external connection to the unique Node port fails. Disable diagnostics
and remove its token immediately after the capture.

Only after this proof may `TRUST_CLOUDFLARE_HEADERS` be enabled in a newly bound
configuration. A Cloudflare header observed once is not enough to prove spoof
resistance.

### Upload, disk, and timeout proof

Test a valid image near `MAX_UPLOAD_BYTES`, an over-limit image, a slow upload,
concurrent uploads, a rejected decoder/pixel bomb, and a missing
`/uploads/...` path. Verify the status/body at every layer and watch Node, PM2,
NGINX/Apache, MariaDB, Redis, RAM, CPU, disk I/O, and queue depth.

The runtime performs a cross-directory atomic rename probe. `PRIVATE_TEMP_DIR`
and `PUBLIC_UPLOAD_DIR` must be on the same filesystem. Capture a successful
probe and verify no probe residue. If it fails with `EXDEV`, do not add a copy
fallback: stop the pilot and ask Cloudways for same-filesystem paths so final
publication remains atomic.

Verify that `public_html/uploads` survives a Git deployment, PM2 restart,
vertical scaling, backup, and restore, while private temp files remain private.
Check both existing and missing upload paths. Persistence described by Support
is not proof until the exact pilot restore has been exercised.

Upload an inert file named `.htaccess`, `.user.ini`, `test.php`, `test.phtml`,
and `test.phar` during the provider check. Every request must be rejected and no
handler may execute. Request bare `/uploads/` and a nested bare directory and
prove neither can enumerate filenames. Also verify the effective vhost has
disabled directory listing/autoindex, PHP and every script/CGI handler, and that
`.htaccess`/`.user.ini` cannot override those restrictions for the exact uploads
path; extension blocking in the public template is defense in depth, not the
execution boundary.

## 7. Roll back

Before changing `.htaccess` or PM2, retain the previous private file, previous
release directory, sanitized exact process inventory, and exact
environment/activation hashes. Before cutover, revisit the retained old release
with its own env (`APP_RELEASE_ROOT` pointing to that old direct child), the same
stable `PM2_HOME`, and the exact current Node/PM2 CLI. Re-run its build/native,
readiness, activation and installed-preflight checks as applicable, issue a new
non-overwriting current-UTC rollback activation, and record its `expires-at`.
The rollback activation must remain unexpired beyond the change window; issuing
it adds only new private activation/readiness material and must not mutate the
old manifest-bound artifacts.

If the old release cannot pass under the current Node/native dependency or its
activation has expired, it is not an executable rollback. Restore the separate
PHP/DNS route first if needed, then re-verify and reissue an old-release
activation; never backdate or copy a digest. Rollback is:

1. remove pilot traffic or restore the previous Cloudflare/DNS route if it was
   changed;
2. restore the prior `.htaccess`/vhost route;
3. stop and delete only the uniquely prefixed pilot PM2 processes using the
   exact Node/PM2 CLI/stable PM2 home sequence from Section 5;
4. inventory for absence, then start the previously verified release with its
   own environment and fresh unexpired rollback activation;
5. run the exact `pm2 save` command from Section 5, then verify HTTP, redirects, login/create, uploads, worker,
   MariaDB/Redis invariants, and process counts; and
6. retain the failed release, logs, receipts, and uploaded files for diagnosis.

Never roll back MariaDB by dropping or overwriting a shared database. The
isolated pilot should use its own database, Redis prefix, port, upload path, and
temporary hostname, so the PHP production application remains the safe path.

## Provider-only checks still NOT VERIFIED

- exact Flexible provider, region, server size, absolute Node/npm/PM2 CLI paths,
  versions, hashes, and Node 22 plus Sharp/libvips build;
- Support-enabled vhost modules, private origin-header overwrite, preserved
  Host, sanitized forwarding chain, and loopback-only listener;
- Cloudflare and non-Cloudflare header/duplicate/spoof behavior;
- effective NGINX/Apache/ModSecurity body, buffering, and 90-second timeout
  starting point under real uploads;
- private/public directory ownership, permissions, same-filesystem rename,
  inode/disk limits, backup/restore, Git deployment, and vertical scaling;
- same-server `127.0.0.1` MariaDB/Redis routing, schema/permissions/pool limits,
  Redis ACL/database/prefix/pool limits, and provider transport ownership; this
  pilot intentionally blocks arbitrary remote plaintext endpoints until a
  separately implemented and verified TLS contract exists;
- PM2 startup after Support runs the root command, reboot/maintenance recovery,
  exact service runtime/home/dump, delayed-dependency recovery inside the
  two-hour retry bound, no-overlap release cutover, one worker, and real log rotation;
- exact static exposure for every single- and multi-domain Host and SSL variant;
- optional analytics CSP endpoints, Tag Assistant/CSP-report behavior and GA4
  property settings (especially Enhanced Measurement); keep both analytics
  values blank/off until this privacy and delivery proof is accepted;
- feature-equivalent CPU, RAM, context-switch, throughput, latency, and image
  queue results on the selected server size; and
- immutable receipt retention, fresh old-release rollback activation, cutover,
  one-writer enforcement, rollback rehearsal, and separate live-release authorization.
