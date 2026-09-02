import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**/*.ts"],
      // These files are executable process entrypoints: importing either one
      // starts listeners, Redis/BullMQ clients and signal handlers. Their
      // component behavior is covered through modules and process smokes.
      exclude: ["src/server.ts", "src/workers/image-worker.ts"],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80
      }
    },
    environment: "node",
    include: ["test/**/*.test.ts"],
    maxWorkers: 4,
    pool: "forks"
  }
});
