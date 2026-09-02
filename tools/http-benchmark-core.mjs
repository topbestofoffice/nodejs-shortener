import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

export const SAFE_LIMITS = Object.freeze({
  maxRequests: 100_000,
  maxConcurrency: 256,
  maxWarmup: 10_000,
  maxPids: 64,
  maxTheoreticalRunMs: 60 * 60 * 1_000,
  minTimeoutMs: 100,
  maxTimeoutMs: 60_000,
  minSampleMs: 25,
  maxSampleMs: 1_000,
  maxResponseBytes: 64 * 1024 * 1024,
});

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_SAMPLE_MS = 100;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const LOCATION_MODES = new Set(["ignore", "absent", "present", "exact"]);
const ALLOWED_FLAGS = new Set([
  "url",
  "host",
  "requests",
  "concurrency",
  "warmup",
  "expect-status",
  "expect-location-mode",
  "expect-location",
  "timeout-ms",
  "max-response-bytes",
  "pids",
  "sample-ms",
]);

export class BenchmarkArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "BenchmarkArgumentError";
  }
}

class BenchmarkRequestError extends Error {
  constructor(code) {
    super(code);
    this.name = "BenchmarkRequestError";
    this.code = code;
  }
}

function parseFlagTokens(argv) {
  const values = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--") || token === "--") {
      throw new BenchmarkArgumentError(`Unexpected positional argument: ${token ?? ""}`);
    }

    const separator = token.indexOf("=");
    const name = token.slice(2, separator === -1 ? undefined : separator);
    let value;
    if (separator !== -1) {
      value = token.slice(separator + 1);
    } else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new BenchmarkArgumentError(`Missing value for --${name}`);
      }
      index += 1;
    }

    if (!ALLOWED_FLAGS.has(name)) {
      throw new BenchmarkArgumentError(`Unknown option: --${name}`);
    }
    if (values.has(name)) {
      throw new BenchmarkArgumentError(`Duplicate option: --${name}`);
    }
    if (value.length === 0) {
      throw new BenchmarkArgumentError(`Empty value for --${name}`);
    }
    values.set(name, value);
  }

  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (value === undefined) throw new BenchmarkArgumentError(`Missing required option: --${name}`);
  return value;
}

function boundedInteger(raw, name, minimum, maximum) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new BenchmarkArgumentError(`--${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BenchmarkArgumentError(`--${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function validateUrl(raw) {
  if (raw.length > 2_048) throw new BenchmarkArgumentError("--url is longer than 2048 characters");
  if (raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new BenchmarkArgumentError("--url must not contain leading, trailing, or control whitespace");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new BenchmarkArgumentError("--url must be an absolute HTTP or HTTPS URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BenchmarkArgumentError("--url must use http: or https:");
  }
  if (parsed.username || parsed.password) {
    throw new BenchmarkArgumentError("--url must not contain credentials");
  }
  if (parsed.hash) {
    throw new BenchmarkArgumentError("--url must not contain a fragment because fragments are not sent to servers");
  }
  return raw;
}

function validateHost(raw) {
  if (raw.length > 253 || /[\u0000-\u0020\u007f/@]/.test(raw)) {
    throw new BenchmarkArgumentError("--host is not a valid HTTP Host header");
  }

  const ipv6 = raw.match(/^\[([0-9a-fA-F:.]+)](?::([0-9]+))?$/);
  const hostname = raw.match(/^([A-Za-z0-9.-]+)(?::([0-9]+))?$/);
  const match = ipv6 ?? hostname;
  if (!match || !match[1]) throw new BenchmarkArgumentError("--host is not a valid HTTP Host header");
  if (ipv6 && isIP(match[1]) !== 6) throw new BenchmarkArgumentError("--host is not a valid IPv6 Host header");
  if (!ipv6 && (match[1].startsWith(".") || match[1].endsWith(".") || match[1].includes(".."))) {
    throw new BenchmarkArgumentError("--host is not a valid HTTP Host header");
  }
  if (match[2] !== undefined) boundedInteger(match[2], "host port", 1, 65_535);
  return raw;
}

function hostNameWithoutPort(host) {
  if (host.startsWith("[")) return host.slice(1, host.indexOf("]"));
  const separator = host.lastIndexOf(":");
  return separator === -1 ? host : host.slice(0, separator);
}

function validateExpectedLocation(raw) {
  if (raw.length > 2_048 || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new BenchmarkArgumentError("--expect-location is invalid or longer than 2048 characters");
  }
  return raw;
}

function parsePids(raw) {
  const tokens = raw.split(",");
  if (tokens.length > SAFE_LIMITS.maxPids) {
    throw new BenchmarkArgumentError(`--pids accepts at most ${SAFE_LIMITS.maxPids} process IDs`);
  }
  const pids = tokens.map((token) => boundedInteger(token, "pids", 1, 4_194_304));
  if (new Set(pids).size !== pids.length) {
    throw new BenchmarkArgumentError("--pids must not contain duplicates");
  }
  return pids.sort((left, right) => left - right);
}

export function parseCliArgs(argv) {
  const values = parseFlagTokens(argv);
  const requests = boundedInteger(required(values, "requests"), "requests", 1, SAFE_LIMITS.maxRequests);
  const concurrency = boundedInteger(
    required(values, "concurrency"),
    "concurrency",
    1,
    SAFE_LIMITS.maxConcurrency,
  );
  if (concurrency > requests) {
    throw new BenchmarkArgumentError("--concurrency must not exceed --requests");
  }

  const locationMode = required(values, "expect-location-mode");
  if (!LOCATION_MODES.has(locationMode)) {
    throw new BenchmarkArgumentError("--expect-location-mode must be ignore, absent, present, or exact");
  }
  const expectedLocation = values.get("expect-location");
  if (locationMode === "exact" && expectedLocation === undefined) {
    throw new BenchmarkArgumentError("--expect-location is required when location mode is exact");
  }
  if (locationMode !== "exact" && expectedLocation !== undefined) {
    throw new BenchmarkArgumentError("--expect-location is only valid when location mode is exact");
  }

  const pids = values.has("pids") ? parsePids(required(values, "pids")) : [];
  if (pids.length === 0 && values.has("sample-ms")) {
    throw new BenchmarkArgumentError("--sample-ms requires --pids");
  }

  const warmup = boundedInteger(required(values, "warmup"), "warmup", 0, SAFE_LIMITS.maxWarmup);
  const timeoutMs = values.has("timeout-ms")
    ? boundedInteger(required(values, "timeout-ms"), "timeout-ms", SAFE_LIMITS.minTimeoutMs, SAFE_LIMITS.maxTimeoutMs)
    : DEFAULT_TIMEOUT_MS;
  const requestBatches = Math.ceil(requests / concurrency) + Math.ceil(warmup / concurrency);
  if (requestBatches * timeoutMs > SAFE_LIMITS.maxTheoreticalRunMs) {
    throw new BenchmarkArgumentError(
      "request count, warmup, concurrency, and timeout permit more than one hour of worst-case runtime",
    );
  }

  return {
    url: validateUrl(required(values, "url")),
    host: validateHost(required(values, "host")),
    requests,
    concurrency,
    warmup,
    timeoutMs,
    maxResponseBytes: values.has("max-response-bytes")
      ? boundedInteger(required(values, "max-response-bytes"), "max-response-bytes", 1, SAFE_LIMITS.maxResponseBytes)
      : DEFAULT_MAX_RESPONSE_BYTES,
    expectation: {
      status: boundedInteger(required(values, "expect-status"), "expect-status", 100, 599),
      locationMode,
      location: expectedLocation === undefined ? null : validateExpectedLocation(expectedLocation),
    },
    pids,
    sampleMs: values.has("sample-ms")
      ? boundedInteger(required(values, "sample-ms"), "sample-ms", SAFE_LIMITS.minSampleMs, SAFE_LIMITS.maxSampleMs)
      : DEFAULT_SAMPLE_MS,
  };
}

export function nearestRankPercentile(values, percentile) {
  if (values.length === 0) return null;
  if (!(percentile > 0 && percentile <= 1)) throw new RangeError("percentile must be greater than 0 and at most 1");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * percentile) - 1] ?? null;
}

export function evaluateExpectation(status, location, expectation) {
  const reasons = [];
  if (status !== expectation.status) reasons.push("STATUS");

  if (expectation.locationMode === "present" && (location === null || location.trim().length === 0)) {
    reasons.push("LOCATION_PRESENT");
  } else if (expectation.locationMode === "absent" && location !== null) {
    reasons.push("LOCATION_ABSENT");
  } else if (expectation.locationMode === "exact" && location !== expectation.location) {
    reasons.push("LOCATION_EXACT");
  }

  return { ok: reasons.length === 0, reasons };
}

function rounded(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sortedCountObject(counts, numeric = false) {
  const entries = [...counts.entries()].sort(([left], [right]) =>
    numeric ? Number(left) - Number(right) : left.localeCompare(right),
  );
  return Object.fromEntries(entries);
}

function normalizeRequestError(error) {
  if (error instanceof BenchmarkRequestError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code);
    if (/^[A-Z0-9_]{1,64}$/.test(code)) return code;
  }
  return "REQUEST_ERROR";
}

function requestOnce(config, agent) {
  const target = new URL(config.url);
  const transport = target.protocol === "https:" ? https : http;
  const started = process.hrtime.bigint();

  return new Promise((resolve) => {
    let settled = false;
    let responseBytes = 0;
    let forcedErrorCode = null;
    let deadlineTimer;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      resolve(outcome);
    };

    const requestOptions = {
      method: "GET",
      agent,
      headers: {
        Host: config.host,
        Accept: "*/*",
        "User-Agent": "nodejs-shortener-benchmark/1",
      },
    };
    const serverName = hostNameWithoutPort(config.host);
    if (target.protocol === "https:" && isIP(serverName) === 0) requestOptions.servername = serverName;

    const request = transport.request(target, requestOptions, (response) => {
      const status = response.statusCode ?? 0;
      const locationHeader = response.headers.location;
      const location = typeof locationHeader === "string" ? locationHeader : null;

      response.on("data", (chunk) => {
        responseBytes += Buffer.byteLength(chunk);
        if (responseBytes > config.maxResponseBytes) {
          forcedErrorCode = "RESPONSE_TOO_LARGE";
          response.destroy(new BenchmarkRequestError("RESPONSE_TOO_LARGE"));
        }
      });
      response.once("aborted", () =>
        finish({ kind: "error", code: forcedErrorCode ?? "RESPONSE_ABORTED" }),
      );
      response.once("error", (error) =>
        finish({ kind: "error", code: forcedErrorCode ?? normalizeRequestError(error) }),
      );
      response.once("end", () => {
        const latencyMs = Number(process.hrtime.bigint() - started) / 1_000_000;
        finish({
          kind: "response",
          status,
          location,
          bytes: responseBytes,
          latencyMs,
          expectation: evaluateExpectation(status, location, config.expectation),
        });
      });
    });

    deadlineTimer = setTimeout(() => {
      forcedErrorCode = "REQUEST_TIMEOUT";
      request.destroy(new BenchmarkRequestError("REQUEST_TIMEOUT"));
    }, config.timeoutMs);
    deadlineTimer.unref();
    request.once("error", (error) =>
      finish({ kind: "error", code: forcedErrorCode ?? normalizeRequestError(error) }),
    );
    request.end();
  });
}

async function runPhase(config, agent, requestCount) {
  const statusCounts = new Map();
  const errorCounts = new Map();
  const expectationFailureCounts = new Map();
  const latencies = [];
  let nextRequest = 0;
  let completed = 0;
  let errors = 0;
  let expectationFailures = 0;
  let bytes = 0;
  const started = process.hrtime.bigint();

  const worker = async () => {
    for (;;) {
      const requestIndex = nextRequest;
      nextRequest += 1;
      if (requestIndex >= requestCount) return;

      const outcome = await requestOnce(config, agent);
      if (outcome.kind === "error") {
        errors += 1;
        errorCounts.set(outcome.code, (errorCounts.get(outcome.code) ?? 0) + 1);
        continue;
      }

      completed += 1;
      bytes += outcome.bytes;
      latencies.push(outcome.latencyMs);
      const statusKey = String(outcome.status);
      statusCounts.set(statusKey, (statusCounts.get(statusKey) ?? 0) + 1);
      if (!outcome.expectation.ok) {
        expectationFailures += 1;
        const failureKey = outcome.expectation.reasons.join("|");
        expectationFailureCounts.set(failureKey, (expectationFailureCounts.get(failureKey) ?? 0) + 1);
      }
    }
  };

  const workers = Array.from({ length: Math.min(config.concurrency, requestCount) }, () => worker());
  await Promise.all(workers);
  const rawDurationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const sortedLatencies = [...latencies].sort((left, right) => left - right);
  const phasePercentile = (percentile) =>
    sortedLatencies.length === 0 ? null : sortedLatencies[Math.ceil(sortedLatencies.length * percentile) - 1] ?? null;
  const maxLatency = sortedLatencies.at(-1) ?? null;

  return {
    report: {
      attempted: requestCount,
      completed,
      errors,
      expectationFailures,
      statusCounts: sortedCountObject(statusCounts, true),
      errorCounts: sortedCountObject(errorCounts),
      expectationFailureCounts: sortedCountObject(expectationFailureCounts),
      bytes,
      durationMs: rounded(rawDurationMs),
      throughputRequestsPerSecond: rawDurationMs === 0 ? null : rounded((completed * 1_000) / rawDurationMs),
      latencyMs: {
        p50: rounded(phasePercentile(0.5)),
        p95: rounded(phasePercentile(0.95)),
        p99: rounded(phasePercentile(0.99)),
        max: rounded(maxLatency),
      },
    },
    rawDurationMs,
  };
}

export function parseProcStat(contents) {
  const closingParenthesis = contents.lastIndexOf(")");
  if (closingParenthesis < 0) throw new Error("invalid /proc stat record");
  const fields = contents.slice(closingParenthesis + 1).trim().split(/\s+/);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const startTicks = Number(fields[19]);
  if (![userTicks, systemTicks, startTicks].every(Number.isSafeInteger)) {
    throw new Error("invalid /proc stat counters");
  }
  return { userTicks, systemTicks, startTicks };
}

export function parseProcStatus(contents) {
  const readCounter = (name) => {
    const match = contents.match(new RegExp(`^${name}:\\s+([0-9]+)`, "m"));
    if (!match?.[1]) throw new Error(`missing ${name} in /proc status`);
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value)) throw new Error(`invalid ${name} in /proc status`);
    return value;
  };

  return {
    rssBytes: readCounter("VmRSS") * 1_024,
    voluntaryContextSwitches: readCounter("voluntary_ctxt_switches"),
    involuntaryContextSwitches: readCounter("nonvoluntary_ctxt_switches"),
  };
}

async function readPidSnapshot(pid) {
  try {
    const [statContents, statusContents] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/status`, "utf8"),
    ]);
    return { pid, ...parseProcStat(statContents), ...parseProcStatus(statusContents) };
  } catch {
    throw new Error(`PID ${pid} could not be sampled from /proc`);
  }
}

async function readSnapshots(pids) {
  return Promise.all(pids.map((pid) => readPidSnapshot(pid)));
}

function total(snapshot, field) {
  return snapshot.reduce((sum, processSnapshot) => sum + processSnapshot[field], 0);
}

function unavailableProcessMetrics(pids, reason) {
  return {
    availability: "NOT AVAILABLE",
    requestedPids: pids,
    reason,
  };
}

export function deriveProcessMetrics({
  cpuTicks,
  clockTicksPerSecond,
  peakRssBytes,
  voluntaryContextSwitches,
  involuntaryContextSwitches,
  completed,
  durationMs,
}) {
  if (
    ![cpuTicks, clockTicksPerSecond, peakRssBytes, voluntaryContextSwitches, involuntaryContextSwitches, completed].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    clockTicksPerSecond === 0 ||
    !Number.isFinite(durationMs) ||
    durationMs < 0
  ) {
    throw new RangeError("invalid process metric inputs");
  }

  const cpuMilliseconds = (cpuTicks * 1_000) / clockTicksPerSecond;
  const perCompletedRequest =
    completed === 0
      ? null
      : {
          cpuTicks: rounded(cpuTicks / completed, 6),
          cpuMilliseconds: rounded(cpuMilliseconds / completed, 6),
          voluntaryContextSwitches: rounded(voluntaryContextSwitches / completed, 6),
          involuntaryContextSwitches: rounded(involuntaryContextSwitches / completed, 6),
        };

  return {
    cpuTicks,
    cpuMilliseconds: rounded(cpuMilliseconds, 6),
    cpuCorePercent: durationMs > 0 ? rounded((cpuMilliseconds / durationMs) * 100, 3) : null,
    peakRssBytes,
    voluntaryContextSwitches,
    involuntaryContextSwitches,
    perCompletedRequest,
  };
}

async function createProcessSampler(pids, sampleMs) {
  if (pids.length === 0) {
    return {
      stop: async () => ({ availability: "NOT REQUESTED", requestedPids: [] }),
    };
  }
  if (process.platform !== "linux") {
    return {
      stop: async () =>
        unavailableProcessMetrics(pids, `Linux /proc is required; current platform is ${process.platform}`),
    };
  }

  let clockTicksPerSecond;
  try {
    const raw = execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 1_000 }).trim();
    clockTicksPerSecond = Number(raw);
    if (!Number.isSafeInteger(clockTicksPerSecond) || clockTicksPerSecond <= 0) throw new Error("invalid CLK_TCK");
  } catch {
    return {
      stop: async () => unavailableProcessMetrics(pids, "getconf CLK_TCK is unavailable or invalid"),
    };
  }

  let initial;
  try {
    initial = await readSnapshots(pids);
  } catch (error) {
    return {
      stop: async () => unavailableProcessMetrics(pids, error instanceof Error ? error.message : "initial /proc sample failed"),
    };
  }

  let peakRssBytes = total(initial, "rssBytes");
  let sampleCount = 1;
  let samplingFailure = null;
  let inFlight = Promise.resolve();
  let sampleRunning = false;

  const timer = setInterval(() => {
    if (sampleRunning || samplingFailure !== null) return;
    sampleRunning = true;
    inFlight = readSnapshots(pids)
      .then((snapshot) => {
        peakRssBytes = Math.max(peakRssBytes, total(snapshot, "rssBytes"));
        sampleCount += 1;
      })
      .catch((error) => {
        samplingFailure = error instanceof Error ? error.message : "periodic /proc sample failed";
      })
      .finally(() => {
        sampleRunning = false;
      });
  }, sampleMs);
  timer.unref();

  return {
    stop: async (completed, durationMs) => {
      clearInterval(timer);
      await inFlight;
      if (samplingFailure !== null) return unavailableProcessMetrics(pids, samplingFailure);

      let finalSnapshot;
      try {
        finalSnapshot = await readSnapshots(pids);
      } catch (error) {
        return unavailableProcessMetrics(pids, error instanceof Error ? error.message : "final /proc sample failed");
      }
      peakRssBytes = Math.max(peakRssBytes, total(finalSnapshot, "rssBytes"));
      sampleCount += 1;

      for (let index = 0; index < initial.length; index += 1) {
        if (initial[index]?.startTicks !== finalSnapshot[index]?.startTicks) {
          return unavailableProcessMetrics(pids, `PID ${pids[index]} changed during the benchmark`);
        }
      }

      const cpuTicks =
        total(finalSnapshot, "userTicks") +
        total(finalSnapshot, "systemTicks") -
        total(initial, "userTicks") -
        total(initial, "systemTicks");
      const voluntaryContextSwitches =
        total(finalSnapshot, "voluntaryContextSwitches") - total(initial, "voluntaryContextSwitches");
      const involuntaryContextSwitches =
        total(finalSnapshot, "involuntaryContextSwitches") - total(initial, "involuntaryContextSwitches");
      if (cpuTicks < 0 || voluntaryContextSwitches < 0 || involuntaryContextSwitches < 0) {
        return unavailableProcessMetrics(pids, "one or more /proc counters moved backwards");
      }

      return {
        availability: "AVAILABLE",
        requestedPids: pids,
        clockTicksPerSecond,
        sampleIntervalMs: sampleMs,
        sampleCount,
        ...deriveProcessMetrics({
          cpuTicks,
          clockTicksPerSecond,
          peakRssBytes,
          voluntaryContextSwitches,
          involuntaryContextSwitches,
          completed,
          durationMs,
        }),
      };
    },
  };
}

export async function runBenchmark(config) {
  const target = new URL(config.url);
  const Agent = target.protocol === "https:" ? https.Agent : http.Agent;
  const agent = new Agent({
    keepAlive: true,
    maxSockets: config.concurrency,
    maxFreeSockets: config.concurrency,
  });

  try {
    const warmup = await runPhase(config, agent, config.warmup);
    const sampler = await createProcessSampler(config.pids, config.sampleMs);
    const measured = await runPhase(config, agent, config.requests);
    const processMetrics = await sampler.stop(measured.report.completed, measured.rawDurationMs);
    const valid =
      warmup.report.errors === 0 &&
      warmup.report.expectationFailures === 0 &&
      measured.report.errors === 0 &&
      measured.report.expectationFailures === 0;

    return {
      schemaVersion: 1,
      input: {
        url: config.url,
        host: config.host,
        requests: config.requests,
        concurrency: config.concurrency,
        warmup: config.warmup,
        timeoutMs: config.timeoutMs,
        maxResponseBytes: config.maxResponseBytes,
        expectation: config.expectation,
        pids: config.pids,
        sampleMs: config.sampleMs,
        redirectHandling: "manual",
      },
      warmup: warmup.report,
      result: measured.report,
      processMetrics,
      valid,
    };
  } finally {
    agent.destroy();
  }
}

export function renderUsage() {
  return [
    "Usage:",
    "  node tools/http-benchmark.mjs --url URL --host HOST --requests N --concurrency N --warmup N \\",
    "    --expect-status STATUS --expect-location-mode ignore|absent|present|exact [--expect-location VALUE]",
    "    [--timeout-ms N] [--max-response-bytes N] [--pids PID[,PID...]] [--sample-ms N]",
    "",
    "Redirects are never followed. A valid run exits 0; request or expectation failures exit 1; invalid input exits 2.",
  ].join("\n");
}
