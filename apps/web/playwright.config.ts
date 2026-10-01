import { defineConfig, devices } from "@playwright/test";

/**
 * E2E smoke tests. Assumes a fixture-seeded worker on :8787 and the web dev
 * server on :5173 (see docs/TESTING.md). Run: `pnpm --filter @rg/web e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  // A stray `test.only` fails CI instead of running one test and passing
  // (Audit 2 E2E M1).
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    baseURL: process.env.RG_BASE ?? "http://localhost:5173",
    // With no retries, "on-first-retry" never recorded anything (M3). Both
    // land in test-results/, which CI uploads on failure; fixture data only.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "iphone", use: { ...devices["iPhone 13"] } },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
  ],
});
