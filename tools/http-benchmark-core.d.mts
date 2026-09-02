export type LocationMode = "ignore" | "absent" | "present" | "exact";

export interface BenchmarkExpectation {
  status: number;
  locationMode: LocationMode;
  location: string | null;
}

export interface BenchmarkConfig {
  url: string;
  host: string;
  requests: number;
  concurrency: number;
  warmup: number;
  timeoutMs: number;
  maxResponseBytes: number;
  expectation: BenchmarkExpectation;
  pids: number[];
  sampleMs: number;
}

export interface PhaseReport {
  attempted: number;
  completed: number;
  errors: number;
  expectationFailures: number;
  statusCounts: Record<string, number>;
  errorCounts: Record<string, number>;
  expectationFailureCounts: Record<string, number>;
  bytes: number;
  durationMs: number | null;
  throughputRequestsPerSecond: number | null;
  latencyMs: { p50: number | null; p95: number | null; p99: number | null; max: number | null };
}

export interface BenchmarkReport {
  schemaVersion: 1;
  input: BenchmarkConfig & { redirectHandling: "manual" };
  warmup: PhaseReport;
  result: PhaseReport;
  processMetrics: Record<string, unknown> & { availability: "AVAILABLE" | "NOT AVAILABLE" | "NOT REQUESTED" };
  valid: boolean;
}

export const SAFE_LIMITS: Readonly<{
  maxRequests: number;
  maxConcurrency: number;
  maxWarmup: number;
  maxPids: number;
  maxTheoreticalRunMs: number;
  minTimeoutMs: number;
  maxTimeoutMs: number;
  minSampleMs: number;
  maxSampleMs: number;
  maxResponseBytes: number;
}>;

export class BenchmarkArgumentError extends Error {}

export function parseCliArgs(argv: string[]): BenchmarkConfig;
export function nearestRankPercentile(values: number[], percentile: number): number | null;
export function evaluateExpectation(
  status: number,
  location: string | null,
  expectation: BenchmarkExpectation,
): { ok: boolean; reasons: string[] };
export function parseProcStat(contents: string): { userTicks: number; systemTicks: number; startTicks: number };
export function parseProcStatus(contents: string): {
  rssBytes: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
};
export function deriveProcessMetrics(input: {
  cpuTicks: number;
  clockTicksPerSecond: number;
  peakRssBytes: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
  completed: number;
  durationMs: number;
}): {
  cpuTicks: number;
  cpuMilliseconds: number | null;
  cpuCorePercent: number | null;
  peakRssBytes: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
  perCompletedRequest: null | {
    cpuTicks: number | null;
    cpuMilliseconds: number | null;
    voluntaryContextSwitches: number | null;
    involuntaryContextSwitches: number | null;
  };
};
export function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkReport>;
export function renderUsage(): string;
