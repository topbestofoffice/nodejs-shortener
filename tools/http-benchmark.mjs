#!/usr/bin/env node

import {
  BenchmarkArgumentError,
  parseCliArgs,
  renderUsage,
  runBenchmark,
} from "./http-benchmark-core.mjs";

if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
  process.stdout.write(`${renderUsage()}\n`);
} else {
  try {
    const config = parseCliArgs(process.argv.slice(2));
    const report = await runBenchmark(config);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.valid) process.exitCode = 1;
  } catch (error) {
    const invalidArguments = error instanceof BenchmarkArgumentError;
    const failure = {
      schemaVersion: 1,
      valid: false,
      error: {
        code: invalidArguments ? "INVALID_ARGUMENT" : "BENCHMARK_FAILED",
        message: error instanceof Error ? error.message : "Unknown benchmark failure",
      },
    };
    process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = invalidArguments ? 2 : 1;
  }
}
