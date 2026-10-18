import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * A DESIGNED RUN — END TO END (§8 §3, stream R): the nav's Coach → "A tempo run tomorrow" → the coach designs a run
 * (`designed_run`: efforts named, no pace written) → it is reviewed on the run rubric → the run card: its steps with
 * their paces from the athlete's threshold, a distance's time on the watch, the totals, "Goes to your watch when you
 * approve" → Approve → "Added to your plan" → the row in the coach lane with its stages, and its watch create queued as a
 * `run_watch` session whose program — built by the lane's own builder, never sent (the fixture's COROS holds no
 * credentials) — carries each step's role, time and pace bytes. Everything but the model is the real app and worker.
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-runs --workers=1
 *
 * One project at a time: it writes a run into the shared fixture account. `RG_COACH_SHOTS=<dir>` writes the screenshots.
 */

test.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");

const MODEL = `http://127.0.0.1:${process.env.RG_DESIGN_MODEL_PORT ?? "8897"}`;
const LIVE = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"];
const SHOTS = process.env.RG_COACH_SHOTS ?? null;
/** The scripted finish (coach-design-scripts.mjs `RUN_LINE`). */
const RUN_LINE = "Three tempo blocks tomorrow, easy either side.";
/** A threshold of 4:49 /km: tempo 4:59–5:14, easy 5:49–6:49, recovery 6:19–7:19 (`paceBandFor`). */
const THRESHOLD = 289;

async function model(path: string): Promise<void> {
  await fetch(`${MODEL}${path}`, { method: "POST" });
}

async function signIn(request: APIRequestContext, baseURL: string | undefined) {
  for (let attempt = 1; ; attempt++) {
    try {
      expect((await request.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
      return;
    } catch (e) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(e))) throw e;
    }
  }
}

/** Nothing of an earlier journey's left: no live run, no open suggestion. */
async function clearTheCoach(request: APIRequestContext, baseURL: string | undefined) {
  for (let i = 0; i < 6; i++) {
    const current = (await (await request.get(`${baseURL}/api/coach/runs/current`)).json()) as {
      run: { id: string; status: string } | null;
      proposal?: { id: string; status?: string } | null;
      alsoOpen?: Array<{ proposalId: string }>;
    };
    for (const a of current.alsoOpen ?? []) await request.post(`${baseURL}/api/coach/proposals/${a.proposalId}/decline`, { data: {} });
    if (!current.run) return;
    if (LIVE.includes(current.run.status)) {
      await request.post(`${baseURL}/api/coach/runs/${current.run.id}/cancel`, { data: {} });
    } else if (current.proposal && ["pending", "partially_approved"].includes(current.proposal.status ?? "")) {
      await request.post(`${baseURL}/api/coach/proposals/${current.proposal.id}/decline`, { data: {} });
    } else return;
  }
}

const sheet = (page: Page) => page.getByRole("dialog", { name: "Coach" });
const box = (page: Page) => sheet(page).locator(".coach-box textarea");

async function openCoach(page: Page) {
  await page.locator("button.nav-coach:visible").first().click();
  await expect(sheet(page)).toBeVisible();
}

async function newConversation(page: Page) {
  await expect(box(page)).toBeVisible();
  await expect(sheet(page).locator(".coach-opening, .coach-turns").first()).toBeVisible();
  if (await sheet(page).locator(".coach-opening").isVisible()) return;
  await sheet(page).getByRole("button", { name: "More" }).click();
  await sheet(page).getByRole("menuitem", { name: "New conversation" }).click();
  await expect(sheet(page).locator(".coach-opening")).toBeVisible();
}

async function send(page: Page, words: string) {
  await box(page).fill(words);
  await sheet(page).getByRole("button", { name: "Send" }).click();
  await expect(sheet(page).locator(".coach-msg--athlete", { hasText: words })).toBeVisible();
}

async function shot(page: Page, name: string, testInfo: { project: { name: string } }) {
  if (!SHOTS) return;
  const was = page.viewportSize();
  if (testInfo.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${testInfo.project.name}-${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
  if (was && testInfo.project.name === "desktop") await page.setViewportSize(was);
}

async function noOverflow(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wide).toBeLessThanOrEqual(1);
}

test("a designed run: asked for → its card with its steps and paces → Approve → in the coach lane, its watch create queued with the pace bytes", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  await signIn(context.request, baseURL);
  await clearTheCoach(context.request, baseURL);
  expect((await context.request.post(`${baseURL}/api/dev/threshold`, { data: { secPerKm: THRESHOLD } })).ok()).toBeTruthy();
  await model("/use/designed_run");
  try {
    await page.goto("/plan");
    await openCoach(page);
    await newConversation(page);
    await send(page, "A tempo run tomorrow");
    await expect(sheet(page).locator(".coach-msg--coach", { hasText: RUN_LINE })).toBeVisible({ timeout: 60_000 });

    // The run card: each part's steps with their paces, the distance's time on the watch, the totals, the watch line.
    const card = sheet(page).locator(".coach-pc-item").filter({ hasText: "Tempo blocks" });
    await expect(card).toBeVisible();
    const steps = card.locator(".coach-pc-run-step");
    await expect(steps).toHaveCount(4);
    const units = (await steps.first().textContent())?.includes("/mi") ? "mi" : "km";
    const pace = (km: string, mi: string) => (units === "km" ? `${km} /km` : `${mi} /mi`);
    await expect(steps.nth(0)).toHaveText(`10 min · Easy · ${pace("5:49–6:49", "9:22–10:58")}`);
    await expect(steps.nth(1)).toHaveText(`8 min · Tempo · ${pace("4:59–5:14", "8:01–8:25")}`);
    await expect(steps.nth(2)).toHaveText(`2 min · Recovery · ${pace("6:19–7:19", "10:10–11:47")}`);
    await expect(steps.nth(3)).toContainText("on your watch as 13 min");
    await expect(card.locator(".coach-pc-run-label").nth(1)).toHaveText("3 ×");
    await expect(card.locator(".coach-pc-run-watch")).toHaveText("Goes to your watch when you approve");
    // No Edit: the builder plays no runs.
    await expect(card.getByRole("link", { name: "Edit" })).toHaveCount(0);
    await noOverflow(page);
    // The card's head on screen (a phone's sheet scrolls to the newest turn, the card's foot), then its foot.
    await card.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await shot(page, "run-card", testInfo);
    await sheet(page).getByRole("button", { name: "Approve", exact: true }).scrollIntoViewIfNeeded();
    await shot(page, "run-card-foot", testInfo);

    // The review, one tap down, on the run's own rubric.
    await card.getByRole("button", { name: "See the review" }).click();
    await expect(card.locator(".coach-pc-review")).toContainText("Structure");
    await expect(card.locator(".coach-pc-review")).toContainText("Pace");
    await expect(card.locator(".coach-pc-review")).not.toContainText("Sequencing");
    await card.getByRole("button", { name: "Hide" }).click();

    await sheet(page).getByRole("button", { name: "Approve", exact: true }).click();
    await expect(sheet(page).getByText("Added to your plan")).toBeVisible({ timeout: 60_000 });
    await expect(card.locator(".coach-pc-run-watch")).toHaveCount(0);
    await noOverflow(page);
    await shot(page, "run-added", testInfo);

    // The row, and its watch create: the conversation names the suggestion, its line the workout.
    const conversation = (await (await context.request.get(`${baseURL}/api/coach/conversation`)).json()) as { turns: Array<{ cards: Array<{ proposalId: string; sport?: string }> }> };
    const runCard = conversation.turns.flatMap((t) => t.cards).find((c) => c.sport === "run");
    expect(runCard).toBeDefined();
    const proposal = (await (await context.request.get(`${baseURL}/api/coach/proposals/${runCard!.proposalId}`)).json()) as { lines: Array<{ outcome: { status: string; workoutId?: string } | null }> };
    const workoutId = proposal.lines[0]!.outcome!.workoutId!;
    const row = (await (await context.request.get(`${baseURL}/api/plan/workouts/${workoutId}`)).json()) as { workout: Record<string, unknown> };
    expect(row.workout).toMatchObject({ title: "Tempo blocks", sport: "run", category: "quality" });
    expect(String(row.workout.stageSummary)).toBe("10 min easy · 3 × 8 min tempo / 2 min recovery · 2 km easy");
    const job = (await (await context.request.get(`${baseURL}/api/dev/coach-job?workoutId=${encodeURIComponent(workoutId)}`)).json()) as {
      kind: string;
      sessionKind: string;
      steps: Array<{ exerciseType: number; targetValue: number; intensityType: number; intensityValue: number; intensityValueExtend?: number; intensityMultiplier?: number }>;
    };
    expect(job.kind).toBe("coach_create_workout");
    expect(job.sessionKind).toBe("run_watch");
    expect(job.steps.map((s) => s.exerciseType)).toEqual([1, 2, 4, 2, 4, 2, 4, 3]);
    expect(job.steps.map((s) => s.targetValue)).toEqual([600, 480, 120, 480, 120, 480, 120, 758]);
    expect(job.steps[1]).toMatchObject({ intensityType: 3, intensityValue: 299_000, intensityValueExtend: 314_000, intensityMultiplier: 1000 });

    // On Plan, tomorrow: the run as a plan run shows.
    await sheet(page).getByRole("button", { name: "Close" }).first().click().catch(() => undefined);
    await page.goto(`/plan?workout=${encodeURIComponent(workoutId)}`);
    await expect(page.getByText("Tempo blocks").first()).toBeVisible({ timeout: 20_000 });
    await shot(page, "run-on-plan", testInfo);
  } finally {
    await model("/use/");
  }
});
