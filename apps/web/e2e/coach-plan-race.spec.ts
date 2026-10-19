import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * A COACH PLAN'S RACE, CLEARED FROM ITS SHEET — END TO END (stream G, 2026-10-19: a race was cancelled, and the coach
 * plan still named it). In an account of its own, the coach builds a block from the conversation whose Sunday is its
 * race day and holds the race (`race_plan`): the coach's opening screen offers "Get me ready for race day", the week
 * holds the race, and the plan's sheet says "Race · Sun …". Then Plan's Your plans → the block → Change → No race:
 * `POST /api/coach/plans/:id/race { raceDate: null }` on the real worker, and the sheet, the week and the opening chips
 * no longer name it — the race session is a quality session now (its title as it was), Settings' race day untouched.
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-plan-race --workers=1
 *
 * `RG_COACH_SHOTS=<dir>` writes the screenshots.
 */

test.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");

const MODEL = `http://127.0.0.1:${process.env.RG_DESIGN_MODEL_PORT ?? "8897"}`;
const SHOTS = process.env.RG_COACH_SHOTS ?? null;
/** The scripted finish (coach-design-scripts.mjs `RACE_PLAN_LINE`). */
const RACE_PLAN_LINE = "One week to sharpen for the 10K on Sunday.";
const RACE_CHIP = "Get me ready for race day";

async function model(path: string): Promise<void> {
  await fetch(`${MODEL}${path}`, { method: "POST" });
}

/** An account of the project's own, seeded: the plan it builds is nobody else's. */
async function signIn(request: APIRequestContext, baseURL: string | undefined, account: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      expect((await request.post(`${baseURL}/api/dev/fixture-login?account=${account}`)).ok()).toBeTruthy();
      expect((await request.post(`${baseURL}/api/dev/seed`)).ok()).toBeTruthy();
      return;
    } catch (e) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(e))) throw e;
    }
  }
}

/** A block an earlier run of this spec left in the account is retired first: the plan this run builds is the only one. */
async function retireLeftovers(request: APIRequestContext, baseURL: string | undefined): Promise<Set<string>> {
  const plans = ((await (await request.get(`${baseURL}/api/coach/plans`)).json()) as { plans: PlanDto[] }).plans;
  for (const p of plans.filter((x) => x.name === "Autumn 10K" && x.status === "active")) {
    for (let slice = 0; slice < 20; slice++) {
      const res = (await (await request.post(`${baseURL}/api/coach/plans/${p.id}/retire`)).json()) as { remaining?: boolean };
      if (!res.remaining) break;
    }
  }
  return new Set(plans.map((p) => p.id));
}

const coachSheet = (page: Page) => page.getByRole("dialog", { name: "Coach" });
const box = (page: Page) => coachSheet(page).locator(".coach-box textarea");

/** The coach, on its opening screen: the conversation as it stands, then a new one if it isn't the opening. */
async function openCoach(page: Page): Promise<void> {
  await page.locator("button.nav-coach:visible").first().click();
  await expect(coachSheet(page)).toBeVisible();
  await expect(box(page)).toBeVisible({ timeout: 20_000 });
  await expect(coachSheet(page).locator(".coach-opening, .coach-turns").first()).toBeVisible({ timeout: 20_000 });
  if (!(await coachSheet(page).locator(".coach-opening").isVisible())) {
    await coachSheet(page).getByRole("button", { name: "More" }).click();
    await coachSheet(page).getByRole("menuitem", { name: "New conversation" }).click();
    await expect(coachSheet(page).locator(".coach-opening")).toBeVisible();
  }
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

type PlanDto = { id: string; name: string; status: string; startDate: string; endDate: string; raceDate: string | null; planRaceDate?: string | null };
type WeekDto = { days: Array<{ workouts: Array<{ id: string; planId: string | null; category: string; title: string }> }> };

/** "Sun 1 Nov", as the sheet says a race day. */
const dayWords = (date: string) => {
  const d = new Date(`${date}T12:00:00Z`);
  const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  const mo = d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  return `${wd} ${d.getUTCDate()} ${mo}`;
};

test("a coach block's race, cleared from its sheet: the sheet, the week and the opening chips no longer name it", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  await signIn(context.request, baseURL, `race-${testInfo.project.name}`);
  const settingsRace = ((await (await context.request.get(`${baseURL}/api/settings`)).json()) as { prefs: { raceDate: string | null } }).prefs.raceDate;
  const earlier = await retireLeftovers(context.request, baseURL);
  await model("/use/race_plan");
  try {
    // The block and its race, from the conversation: one card, Approve plan.
    await page.goto("/plan");
    await openCoach(page);
    await box(page).fill("Plan my week to the 10K on Sunday");
    await coachSheet(page).getByRole("button", { name: "Send" }).click();
    await expect(coachSheet(page).locator(".coach-msg--coach", { hasText: RACE_PLAN_LINE })).toBeVisible({ timeout: 60_000 });
    const card = coachSheet(page).locator("section.coach-plan").filter({ hasText: "Autumn 10K" }).last();
    await card.getByRole("button", { name: "Approve plan" }).click();
    await expect(card.getByText("✓ Added to your plan")).toBeVisible({ timeout: 60_000 });
    const plans = ((await (await context.request.get(`${baseURL}/api/coach/plans`)).json()) as { plans: PlanDto[] }).plans;
    const block = plans.find((p) => p.name === "Autumn 10K" && p.status === "active" && !earlier.has(p.id));
    expect(block, JSON.stringify(plans)).toBeDefined();
    const raceDay = block!.endDate;
    expect(block).toMatchObject({ raceDate: raceDay, planRaceDate: raceDay });
    const week = async () =>
      ((await (await context.request.get(`${baseURL}/api/plan/week?start=${block!.startDate}`)).json()) as WeekDto).days
        .flatMap((d) => d.workouts)
        .filter((w) => w.planId === block!.id);
    const race = (await week()).find((w) => w.category === "race");
    expect(race, JSON.stringify(await week())).toBeDefined();

    // Before: the opening screen offers to get ready for it.
    await coachSheet(page).getByRole("button", { name: "More" }).click();
    await coachSheet(page).getByRole("menuitem", { name: "New conversation" }).click();
    await expect(coachSheet(page).locator(".coach-chips .coach-chip--needs", { hasText: RACE_CHIP })).toHaveCount(1, { timeout: 15_000 });
    await page.keyboard.press("Escape");
    await expect(coachSheet(page)).toHaveCount(0);

    // Before: the week holds the race.
    await page.goto(`/plan?week=${block!.startDate}`);
    const raceCard = page.locator(`.cal-card[data-workout="${race!.id}"]`).first();
    await expect(raceCard.locator(".cal-card-edge")).toHaveClass(/cat-race/, { timeout: 20_000 });
    await shot(page, "week-before", testInfo);

    // The sheet: the plan's race, and Change → No race.
    await page.locator(".your-plans .plan-row", { hasText: "Autumn 10K" }).first().click();
    const sheet = page.getByRole("dialog", { name: "Autumn 10K" });
    await expect(sheet.getByText(`Race · ${dayWords(raceDay)}`)).toBeVisible({ timeout: 20_000 });
    await shot(page, "race-line", testInfo);
    await sheet.getByRole("button", { name: "Change" }).click();
    await expect(sheet.getByLabel("Race day")).toHaveValue(raceDay);
    await shot(page, "race-change", testInfo);
    const asked = page.waitForResponse((r) => r.url().endsWith(`/api/coach/plans/${block!.id}/race`) && r.request().method() === "POST");
    await sheet.getByRole("button", { name: "No race" }).click();
    const answer = await asked;
    expect(answer.status()).toBe(200);
    expect(await answer.json()).toEqual({ ok: true, raceDate: null, demoted: 1 });

    // After: the sheet names no race.
    await expect(sheet.getByText(/Race ·/)).toHaveCount(0, { timeout: 20_000 });
    await expect(sheet.getByRole("button", { name: "Change" })).toHaveCount(0);
    await expect(sheet).not.toContainText(/race ·/i);
    await shot(page, "no-race", testInfo);
    const after = ((await (await context.request.get(`${baseURL}/api/coach/plans`)).json()) as { plans: PlanDto[] }).plans.find((p) => p.id === block!.id);
    expect(after).toMatchObject({ planRaceDate: null, raceDate: settingsRace });

    // After: the week's race session is a quality session (its title as it was).
    expect((await week()).find((w) => w.id === race!.id)).toMatchObject({ category: "quality", title: race!.title });
    await page.keyboard.press("Escape");
    await expect(raceCard.locator(".cal-card-edge")).toHaveClass(/cat-quality/, { timeout: 20_000 });
    await shot(page, "week-after", testInfo);

    // After: the opening chips no longer offer it, and Settings' race day is as it was.
    const nudges = (await (await context.request.get(`${baseURL}/api/coach/nudges`)).json()) as { nudges: Array<{ id: string }> };
    expect(nudges.nudges.filter((n) => n.id.startsWith("race:"))).toEqual([]);
    await openCoach(page);
    await expect(coachSheet(page).locator(".coach-chips button").first()).toBeVisible({ timeout: 15_000 });
    await expect(coachSheet(page).locator(".coach-chips .coach-chip--needs", { hasText: RACE_CHIP })).toHaveCount(0);
    await shot(page, "chips-after", testInfo);
    expect(((await (await context.request.get(`${baseURL}/api/settings`)).json()) as { prefs: { raceDate: string | null } }).prefs.raceDate).toBe(settingsRace);
  } finally {
    await model("/use/");
  }
});
