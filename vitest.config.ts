import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // On CI, print a test's console output only when that test fails. The worker suite logs thousands of lines on
    // purpose (refused pushes, simulated kills); rendering them all is what starves the reporter on a busy runner and
    // ends a green run with "Timeout calling onTaskUpdate". Locally everything still prints.
    silent: process.env.CI ? "passed-only" : false,
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      "services/*/vitest.config.ts",
    ],
  },
});
