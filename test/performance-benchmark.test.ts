import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BenchmarkArgumentError,
  deriveProcessMetrics,
  evaluateExpectation,
  nearestRankPercentile,
  parseCliArgs,
  parseProcStat,
  parseProcStatus,
  runBenchmark,
} from "../tools/http-benchmark-core.mjs";

const cliPath = fileURLToPath(new URL("../tools/http-benchmark.mjs", import.meta.url));
const openServers: Server[] = [];

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  openServers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected an ephemeral TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [cliPath, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout, stderr };
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("HTTP benchmark arguments and calculations", () => {
  it("parses the required exact target and bounded options", () => {
    const config = parseCliArgs([
      "--url=http://127.0.0.1:3000/abc?source=test",
      "--host=go.example.test",
      "--requests=100",
      "--concurrency=10",
      "--warmup=5",
      "--expect-status=302",
      "--expect-location-mode=exact",
      "--expect-location=https://destination.example/final",
      "--timeout-ms=750",
      "--max-response-bytes=4096",
      "--pids=9,3",
      "--sample-ms=50",
    ]);

    expect(config).toMatchObject({
      url: "http://127.0.0.1:3000/abc?source=test",
      host: "go.example.test",
      requests: 100,
      concurrency: 10,
      warmup: 5,
      timeoutMs: 750,
      maxResponseBytes: 4096,
      expectation: {
        status: 302,
        locationMode: "exact",
        location: "https://destination.example/final",
      },
      pids: [3, 9],
      sampleMs: 50,
    });
  });

  it("rejects unsafe or ambiguous inputs before sending traffic", () => {
    expect(() =>
      parseCliArgs([
        "--url=http://127.0.0.1/",
        "--host=example.test",
        "--requests=10",
        "--concurrency=11",
        "--warmup=0",
        "--expect-status=200",
        "--expect-location-mode=ignore",
      ]),
    ).toThrow(BenchmarkArgumentError);

    expect(() =>
      parseCliArgs([
        "--url=http://127.0.0.1/",
        "--host=example.test\r\nX-Forged: yes",
        "--requests=10",
        "--concurrency=1",
        "--warmup=0",
        "--expect-status=200",
        "--expect-location-mode=ignore",
      ]),
    ).toThrow("valid HTTP Host header");

    expect(() =>
      parseCliArgs([
        "--url=http://127.0.0.1/",
        "--host=example.test",
        "--requests=100000",
        "--concurrency=1",
        "--warmup=0",
        "--expect-status=200",
        "--expect-location-mode=ignore",
        "--timeout-ms=60000",
      ]),
    ).toThrow("one hour of worst-case runtime");
  });

  it("uses nearest-rank latency percentiles and exact response expectations", () => {
    expect(nearestRankPercentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(nearestRankPercentile([4, 1, 3, 2], 0.95)).toBe(4);
    expect(nearestRankPercentile([], 0.99)).toBeNull();
    expect(
      evaluateExpectation(302, "/final", { status: 302, locationMode: "exact", location: "/final" }),
    ).toEqual({ ok: true, reasons: [] });
    expect(
      evaluateExpectation(301, null, { status: 302, locationMode: "present", location: null }),
    ).toEqual({ ok: false, reasons: ["STATUS", "LOCATION_PRESENT"] });
  });

  it("parses Linux process counters without being confused by spaces in process names", () => {
    const statFields = ["S", ...Array.from({ length: 24 }, (_, index) => String(index + 1))];
    statFields[11] = "120";
    statFields[12] = "30";
    statFields[19] = "98765";
    expect(parseProcStat(`123 (node web worker) ${statFields.join(" ")}`)).toEqual({
      userTicks: 120,
      systemTicks: 30,
      startTicks: 98765,
    });
    expect(
      parseProcStatus(
        [
          "Name:\tnode",
          "VmRSS:\t2048 kB",
          "voluntary_ctxt_switches:\t17",
          "nonvoluntary_ctxt_switches:\t3",
        ].join("\n"),
      ),
    ).toEqual({
      rssBytes: 2_097_152,
      voluntaryContextSwitches: 17,
      involuntaryContextSwitches: 3,
    });

    expect(
      deriveProcessMetrics({
        cpuTicks: 150,
        clockTicksPerSecond: 100,
        peakRssBytes: 10_000_000,
        voluntaryContextSwitches: 20,
        involuntaryContextSwitches: 5,
        completed: 50,
        durationMs: 2_000,
      }),
    ).toEqual({
      cpuTicks: 150,
      cpuMilliseconds: 1_500,
      cpuCorePercent: 75,
      peakRssBytes: 10_000_000,
      voluntaryContextSwitches: 20,
      involuntaryContextSwitches: 5,
      perCompletedRequest: {
        cpuTicks: 3,
        cpuMilliseconds: 30,
        voluntaryContextSwitches: 0.4,
        involuntaryContextSwitches: 0.1,
      },
    });
  });
});

describe("HTTP benchmark local integration", () => {
  it("keeps redirects manual, preserves Host, and emits bounded response evidence", async () => {
    const seenHosts: Array<string | undefined> = [];
    let destinationHits = 0;
    let activeRequests = 0;
    let peakActiveRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === "/final") {
        destinationHits += 1;
        response.end("followed");
        return;
      }
      seenHosts.push(request.headers.host);
      activeRequests += 1;
      peakActiveRequests = Math.max(peakActiveRequests, activeRequests);
      setTimeout(() => {
        activeRequests -= 1;
        response.statusCode = 302;
        response.setHeader("Location", "/final");
        response.end("go");
      }, 5);
    });
    const baseUrl = await listen(server);
    const config = parseCliArgs([
      `--url=${baseUrl}/redirect`,
      "--host=bench.example.test",
      "--requests=12",
      "--concurrency=3",
      "--warmup=2",
      "--expect-status=302",
      "--expect-location-mode=exact",
      "--expect-location=/final",
      "--timeout-ms=1000",
    ]);

    const report = await runBenchmark(config);

    expect(report.valid).toBe(true);
    expect(report.input.redirectHandling).toBe("manual");
    expect(report.warmup).toMatchObject({ attempted: 2, completed: 2, errors: 0, expectationFailures: 0 });
    expect(report.result).toMatchObject({
      attempted: 12,
      completed: 12,
      errors: 0,
      expectationFailures: 0,
      statusCounts: { "302": 12 },
      bytes: 24,
    });
    expect(report.result.latencyMs.p50).toBeTypeOf("number");
    expect(report.result.latencyMs.p95).toBeTypeOf("number");
    expect(report.result.throughputRequestsPerSecond).toBeGreaterThan(0);
    expect(report.processMetrics.availability).toBe("NOT REQUESTED");
    expect(seenHosts).toHaveLength(14);
    expect(new Set(seenHosts)).toEqual(new Set(["bench.example.test"]));
    expect(destinationHits).toBe(0);
    expect(peakActiveRequests).toBeGreaterThan(1);
    expect(peakActiveRequests).toBeLessThanOrEqual(3);
  });

  it("runs as a CLI and returns machine-readable JSON with a strict exit code", async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 204;
      response.end();
    });
    const baseUrl = await listen(server);
    const commonArgs = [
      `--url=${baseUrl}/health`,
      "--host=cli.example.test",
      "--requests=4",
      "--concurrency=2",
      "--warmup=1",
      "--expect-location-mode=absent",
      "--timeout-ms=1000",
    ];

    const success = await runCli([...commonArgs, "--expect-status=204"]);
    expect(success.code).toBe(0);
    expect(success.stderr).toBe("");
    expect(JSON.parse(success.stdout)).toMatchObject({
      schemaVersion: 1,
      valid: true,
      result: { attempted: 4, completed: 4, statusCounts: { "204": 4 } },
    });

    const mismatch = await runCli([...commonArgs, "--expect-status=200"]);
    expect(mismatch.code).toBe(1);
    expect(JSON.parse(mismatch.stdout)).toMatchObject({
      valid: false,
      result: { completed: 4, errors: 0, expectationFailures: 4 },
    });
  });

  it("applies a wall-clock deadline to slow responses", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.statusCode = 200;
        response.end("late");
      }, 200);
    });
    const baseUrl = await listen(server);
    const config = parseCliArgs([
      `--url=${baseUrl}/slow`,
      "--host=slow.example.test",
      "--requests=2",
      "--concurrency=2",
      "--warmup=0",
      "--expect-status=200",
      "--expect-location-mode=absent",
      "--timeout-ms=100",
    ]);

    const report = await runBenchmark(config);

    expect(report.valid).toBe(false);
    expect(report.result).toMatchObject({
      attempted: 2,
      completed: 0,
      errors: 2,
      errorCounts: { REQUEST_TIMEOUT: 2 },
      expectationFailures: 0,
    });
    expect(report.result.latencyMs).toEqual({ p50: null, p95: null, p99: null, max: null });
  });
});
