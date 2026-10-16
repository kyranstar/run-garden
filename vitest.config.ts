import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // On CI, tests' console output is not collected at all. The worker suite logs thousands of lines on purpose
    // (refused pushes, simulated kills); "passed-only" still buffered every line on its task and shipped it over the
    // worker's RPC, which on a busy runner ended green runs with "Timeout calling onTaskUpdate". A failure still reports
    // its assertion and stack; re-run it locally, where everything prints.
    silent: !!process.env.CI,
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      "services/*/vitest.config.ts",
    ],
  },
});
