import { defineConfig, devices } from "@playwright/test";

/**
 * E2E smoke tests. Assumes a fixture-seeded worker on :8787 and the web dev
 * server on :5173 (see docs/TESTING.md). Run: `pnpm --filter @rg/web e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    baseURL: process.env.RG_BASE ?? "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    { name: "iphone", use: { ...devices["iPhone 13"] } },
    { name: "desktop", use: { viewport: { width: 1280, height: 800 } } },
  ],
});
