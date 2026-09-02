# PHP versus Node.js performance benchmark

This harness collects bounded HTTP evidence. It does not prove that Node.js will
use less CPU, and it does not change PHP, Node.js, MariaDB, Redis, PM2, Cloudways,
or production state.

Current status (2026-09-01): the harness and its local tests pass, but no
feature-equivalent same-provider/same-size PHP-versus-Node A/B run exists. Every
CPU, RAM, context-switch, throughput, latency and image-queue benefit therefore
remains `NOT VERIFIED`; no percentage improvement is promised.

## Run the harness

The required inputs are deliberately explicit:

```powershell
npm run benchmark:http -- `
  --url=http://127.0.0.1:3000/test-link `
  --host=go.example.net `
  --requests=20000 `
  --concurrency=64 `
  --warmup=1000 `
  --expect-status=302 `
  --expect-location-mode=exact `
  --expect-location=https://destination.example/final `
  --timeout-ms=5000
```

Redirects are always handled manually: the harness records the response but does
not request the `Location` destination. Location modes are:

- `exact`: the raw `Location` header must equal `--expect-location`.
- `present`: a non-empty `Location` header must exist.
- `absent`: no `Location` header may exist.
- `ignore`: location is not part of the assertion.

Use `exact` for a deterministic parity link. `present` is weaker evidence and is
appropriate only when the feature intentionally chooses among multiple valid
destinations. The expected HTTP status is always exact.

The URL and Host value are copied into the JSON evidence. Do not place passwords,
API keys, session tokens, or other secrets in benchmark arguments.

Output is one JSON document. It contains warm-up and measured completion/error
counts, sorted status/error counts, response bytes, duration, completed requests
per second, and nearest-rank p50/p95/p99/max latency. A request is `completed`
only after its response body is fully consumed. Transport failures are `errors`;
a completed response with the wrong status or location is an
`expectationFailure`. Any warm-up or measured error/mismatch makes `valid` false
and the CLI exits 1. Invalid arguments exit 2.

The harness is intentionally bounded: at most 100,000 measured requests, 10,000
warm-up requests, 256 concurrent requests, 64 PIDs, a 60-second per-request
timeout, and 64 MiB per response. It creates only `concurrency` workers rather
than enqueuing one promise per request. The default response cap is 16 MiB and
the default timeout is 5 seconds. Inputs whose request batches and per-request
deadline allow more than one hour of worst-case runtime are rejected. The
deadline covers the whole request, including connection setup and a slow body;
it is not merely a socket-idle timeout.

## Optional Linux process evidence

On the Linux test server, pass the exact application PIDs:

```bash
npm run benchmark:http -- \
  --url=http://127.0.0.1:3000/test-link \
  --host=go.example.net \
  --requests=20000 \
  --concurrency=64 \
  --warmup=1000 \
  --expect-status=302 \
  --expect-location-mode=exact \
  --expect-location=https://destination.example/final \
  --pids=1234,1235 \
  --sample-ms=100 > node-redirect-run-01.json
```

When Linux `/proc` and `getconf CLK_TCK` are available, the result includes:

- combined user plus system CPU ticks and CPU milliseconds;
- sampled aggregate peak RSS across the requested PIDs;
- voluntary and involuntary context-switch deltas;
- CPU and context-switch values per completed request; and
- approximate CPU-core percentage during the measured interval.

Peak RSS is the highest periodic sample, not a byte-allocation counter. PID
sampling begins after warm-up. If a PID disappears, is reused, cannot be read, or
any counter moves backwards, the complete process section becomes
`NOT AVAILABLE`; partial numbers are not published. On Windows and macOS it is
also `NOT AVAILABLE`. With no `--pids`, it is `NOT REQUESTED`.

For PM2 cluster mode, list every Node web-worker PID but not the PM2 daemon. For
PHP, choose and record an equivalent scope, normally the FPM master and all
children serving the test pool. Do not compare one Node worker with the entire
PHP/web-server stack. The `/proc` section does not include NGINX, Apache,
MariaDB, Redis, kernel-wide disk work, or another unlisted process; measure those
separately with the same scope in both runs.

## Feature-equivalent A/B method

1. Use the same provider, region, server size, vCPU count, RAM, OS generation,
   NGINX/Apache path, TLS mode, MariaDB 10.11 data and indexes, Redis policy, and
   upload/storage layout. Do not compare local Node with live PHP.
2. Use a dedicated test link and a resettable database snapshot. The PHP and
   Node request must execute the same routing, filtering, click accounting,
   country handling, Redis claim, and reporting behavior. If one side skips a
   write or observer, it is a different benchmark.
3. Verify the exact status and `Location` before load. Confirm database counters,
   Redis state, and reporting results after each small correctness run. Reset the
   mutable test data before the other implementation runs.
4. Keep the `Host` header, URL path/query, request count, concurrency, warm-up,
   timeout, and response expectation identical. Bypass Cloudflare for both or
   include the same Cloudflare path for both; never mix the two.
5. Start from an idle server. Stop unrelated cron/image jobs or record them as a
   contaminated run. Keep MariaDB/Redis cache warmth equivalent. Warm up both
   implementations before collecting process counters.
6. Run at least five measured rounds in an alternating order such as
   PHP/Node/Node/PHP, then reverse it. Retain every JSON file. Compare medians and
   spread rather than selecting the best run.
7. Compare CPU milliseconds per completed request, context switches per
   completed request, peak application RSS, throughput, error rate, and p95/p99
   latency. Also collect MariaDB CPU/query counts, Redis operations, and disk I/O
   because the harness cannot attribute that work.
8. Repeat at the expected normal concurrency and at a controlled overload point.
   Define the latency/error/resource stop limits before the run. Stop a round if
   it threatens the isolated pilot; never run this against production traffic.

Keep the measured request count fixed when comparing total CPU ticks. If Node.js
finishes the same 20,000 requests faster, CPU per completed request tells whether
it removed work. In a fixed time window, higher throughput can increase total CPU
because the server completes more database, Redis, logging, and accounting work.
Async I/O mainly prevents waiting requests from occupying one FPM worker; it does
not make the underlying work free. Therefore `higher throughput` and `lower total
CPU` are separate claims and must be evaluated separately.

Predefine the decision threshold before seeing results. For example, the research
hypothesis of roughly 20% lower application CPU per completed request is useful as
a gate, not a promised outcome. Accept the migration performance claim only if
feature correctness remains exact, errors do not rise, p95/p99 stay within the
chosen limit, and MariaDB/Redis/disk work is not merely shifted outside the listed
application PIDs.
