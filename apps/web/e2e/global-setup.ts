import { readdirSync } from "node:fs";
import path from "node:path";
import { request, type FullConfig } from "@playwright/test";
import { accountsToSeed, repeatEachOf, seedAccount, selectedSpecs } from "./seeded-accounts.js";

/**
 * Before any test starts: every account the run's specs sign into (SEEDED, seeded-accounts.ts), seeded one after
 * another while nothing else runs — a seed holds the fixture worker, and one held under another test's requests is what
 * broke CI 39366660097. What the specs read of it goes in the environment their workers start with: this run's tag
 * (`RG_E2E_RUN`) and the accounts seeded (`RG_E2E_SEEDED`).
 */
export default async function globalSetup(config: FullConfig): Promise<void> {
  const first = config.projects[0];
  const baseURL = first?.use.baseURL ?? process.env.RG_BASE ?? "http://localhost:5173";
  const testDir = first?.testDir ?? path.join(config.rootDir, "e2e");
  const specPaths = readdirSync(testDir)
    .filter((f) => f.endsWith(".spec.ts"))
    .map((f) => path.join(testDir, f));
  // Six characters of the clock: new each run, and short enough that every account name stays within 32.
  const run = Date.now().toString(36).slice(-6);
  const plan = accountsToSeed({
    projects: config.projects.map((p) => p.name),
    run,
    env: process.env,
    selected: selectedSpecs(process.argv, specPaths),
    repeatEach: repeatEachOf(process.argv, Math.max(1, ...config.projects.map((p) => p.repeatEach))),
    retries: Math.max(0, ...config.projects.map((p) => p.retries)),
  });
  process.env.RG_E2E_RUN = run;
  process.env.RG_E2E_SEEDED = plan.map((p) => p.account).join(",");
  if (plan.length === 0) return;

  const started = Date.now();
  const req = await request.newContext({ baseURL });
  try {
    if (!(await req.get("/api/health").then((r) => r.ok(), () => false))) {
      throw new Error(`The fixture stack is not answering at ${baseURL} (/api/health): start it first (bash apps/web/e2e/fixture-stack.sh).`);
    }
    // One sign-in after another on one request context: each fixture-login's cookie replaces the last.
    for (const { account } of plan) await seedAccount(req, account);
  } finally {
    await req.dispose();
  }
  const bySpec = new Map<string, number>();
  for (const { file } of plan) bySpec.set(file, (bySpec.get(file) ?? 0) + 1);
  const what = [...bySpec].map(([file, n]) => `${file.replace(/\.spec\.ts$/, "")} ${n}`).join(", ");
  console.log(`Seeded ${plan.length} accounts before the run (${what}) in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
