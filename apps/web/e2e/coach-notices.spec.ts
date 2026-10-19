import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE COACH NOTICES — END TO END (stream H, 2026-10-19). In an account of its own: last week's review as the Monday cron
 * writes it and a run finished this morning as a watch import lands it (`POST /api/dev/coach-notices`, fixture mode
 * only). The coach's opening screen says the review first — its first sentence, the whole of it one tap down, "Plan
 * this week" first among the chips — and, opened again, the run in figures in the athlete's units ("Today's run is in
 * — 16 km at 5:40 /km, mostly easy."), "Plan tomorrow around it" first. Its tap sends the run in figures as the
 * athlete's words; after that the run is old news, and a new conversation opens on the day's own line. Nothing here
 * calls a model on its own: the line is read free, and the one run is the tap's (fixture mode's canned answer).
 *
 * "Read it all" opens the whole review in a sheet of its own over the coach. A library held 5 s never keeps the line from
 * the athlete: the line and the chips are drawn at once, the quick starts after them, nothing moving.
 *
 * And the opening holds still while it is read (UX System 4): with the chips' and the templates' reads held back 1.5 s,
 * "Build your own" is drawn once, where it stays.
 *
 *   bash apps/web/e2e/fixture-stack.sh
 *   RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-notices --workers=1
 *
 * `RG_COACH_SHOTS=<dir>` writes the screenshots (phone and desktop, light and dark).
 */

const SHOTS = process.env.RG_COACH_SHOTS ?? null;
/** In the voice the weekly prompt asks for now (llm.ts): its first sentence, about last week, whole on its own. */
const REVIEW = "Last week you ran 4 times for 32.1 kilometres, and the two long runs carried it. The long run held steady all week.";
const REVIEW_LINE = "Last week you ran 4 times for 32.1 kilometres, and the two long runs carried it.";
const RUN_LINE = "Today's run is in — 16 km at 5:40 /km, mostly easy.";
const RUN_REQUEST = "Plan tomorrow around today's run — 16 km at 5:40 /km, mostly easy.";

/** An account of its own for this run of the spec, seeded: the review and the run are nobody else's, and nothing in it
 * has asked the coach anything yet. */
async function signIn(request: APIRequestContext, baseURL: string | undefined, project: string): Promise<void> {
  const account = `notices-${Date.now().toString(36)}-${project}`.slice(0, 32);
  for (let attempt = 1; ; attempt++) {
    try {
      expect((await request.post(`${baseURL}/api/dev/fixture-login?account=${account}`)).ok()).toBeTruthy();
      expect((await request.post(`${baseURL}/api/dev/seed`, { timeout: 120_000 })).ok()).toBeTruthy();
      return;
    } catch (e) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(e))) throw e;
    }
  }
}

const coachSheet = (page: Page) => page.getByRole("dialog", { name: "Coach" });
const drawnOpening = (page: Page): Locator => coachSheet(page).locator(".coach-opening:not(.coach-opening--holding)");
const coachLine = (page: Page): Locator => drawnOpening(page).locator(".coach-msg--coach p").first();
const chipLabels = (page: Page) => coachSheet(page).locator(".coach-chips button").allTextContents();

async function openCoach(page: Page): Promise<void> {
  await page.locator("button.nav-coach:visible").first().click();
  await expect(coachSheet(page)).toBeVisible();
  await expect(drawnOpening(page)).toBeVisible({ timeout: 20_000 });
}

async function closeCoach(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(coachSheet(page)).toHaveCount(0);
}

async function shot(page: Page, name: string, project: string): Promise<void> {
  if (!SHOTS) return;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: "reduce" });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${SHOTS}/${project}-${name}-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("the coach notices: last week's review, then this morning's run, each said once, the run's chip sent as the athlete's words", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const project = testInfo.project.name;
  await signIn(context.request, baseURL, project);
  const seeded = await context.request.post(`${baseURL}/api/dev/coach-notices`, {
    data: { review: REVIEW, run: { meters: 16_000, seconds: 5440, zones: [1200, 3500, 600, 100, 40] } },
  });
  expect(seeded.ok()).toBeTruthy();
  if (project === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");

  // On Monday: the review's first sentence, the whole of it one tap down, Plan this week first.
  await openCoach(page);
  await expect(coachLine(page)).toHaveText(REVIEW_LINE);
  // Read from its first line down: on a phone too, the coach's line is in sight, above its chips.
  await expect(coachLine(page)).toBeInViewport();
  // The whole review one tap down, in a sheet of its own over the coach — not the foot of Growth's feed.
  await drawnOpening(page).getByRole("button", { name: "Read it all" }).click();
  const reviewSheet = page.getByRole("dialog", { name: "Last week's review" });
  await expect(reviewSheet).toContainText(REVIEW);
  await expect(reviewSheet.locator(".review-week")).toHaveText(/^Week of /);
  await shot(page, "review-sheet", project);
  await reviewSheet.getByRole("button", { name: "Close" }).click();
  await expect(reviewSheet).toHaveCount(0);
  await expect(coachSheet(page)).toBeVisible();
  const reviewChips = await chipLabels(page);
  expect(reviewChips[0]).toBe("Plan this week");
  expect(reviewChips).not.toContain("Plan my week");
  const first = coachSheet(page).locator(".coach-chips button").first();
  expect((await first.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await shot(page, "review", project);
  await closeCoach(page);

  // Opened again: the review was shown here, so the run — in figures, in the athlete's units.
  await openCoach(page);
  await expect(coachLine(page)).toHaveText(RUN_LINE);
  await expect(coachLine(page)).toBeInViewport();
  expect((await chipLabels(page))[0]).toBe("Plan tomorrow around it");
  await shot(page, "session", project);

  // Its chip: the run in figures, as the athlete's words — the only spend.
  const asked = page.waitForRequest((r) => r.url().endsWith("/api/coach/runs") && r.method() === "POST");
  await coachSheet(page).getByRole("button", { name: "Plan tomorrow around it" }).click();
  expect(((await asked).postDataJSON() as { request: string }).request).toBe(RUN_REQUEST);
  await expect(coachSheet(page).locator(".coach-msg--athlete", { hasText: RUN_REQUEST })).toBeVisible({ timeout: 20_000 });
  // A conversation follows its newest again: the athlete's words in sight.
  await expect(coachSheet(page).locator(".coach-msg--athlete", { hasText: RUN_REQUEST })).toBeInViewport();

  // Asked about: old news. A new conversation opens on the day's own line.
  await expect(coachSheet(page).getByRole("button", { name: "More" })).toBeEnabled({ timeout: 60_000 });
  await expect
    .poll(async () => {
      await coachSheet(page).getByRole("button", { name: "More" }).click();
      const item = coachSheet(page).getByRole("menuitem", { name: "New conversation" });
      if (await item.isEnabled()) {
        await item.click();
        return true;
      }
      await page.keyboard.press("Escape");
      return false;
    }, { timeout: 90_000, intervals: [1_000] })
    .toBe(true);
  await expect(drawnOpening(page)).toBeVisible({ timeout: 20_000 });
  await expect(coachLine(page)).not.toHaveText(RUN_LINE);
  await expect(coachLine(page)).not.toHaveText(REVIEW_LINE);
  expect(await chipLabels(page)).not.toContain("Plan tomorrow around it");
});

test("a slow library never keeps the coach's line from the athlete: held 5 s, the line and the chips are drawn at once, the quick starts after them — nothing moves", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(context.request, baseURL, `${testInfo.project.name}-l`);
  await context.request.post(`${baseURL}/api/dev/coach-notices`, { data: { review: REVIEW } });
  await page.goto("/");
  let released = false;
  await page.route("**/api/library*", async (route) => {
    await new Promise((r) => setTimeout(r, 5_000));
    released = true;
    await route.continue();
  });
  const opened = Date.now();
  await page.locator("button.nav-coach:visible").first().click();
  await expect(coachLine(page)).toHaveText(REVIEW_LINE, { timeout: 4_000 });
  expect(released).toBe(false);
  expect(Date.now() - opened).toBeLessThan(4_500);
  const first = coachSheet(page).locator(".coach-chips button").first();
  const chipY = (await first.boundingBox())!.y;
  // The ways to start yourself wait, last on the screen.
  await expect(coachSheet(page).locator(".coach-start--holding")).toBeVisible();
  await expect(coachSheet(page).getByRole("link", { name: "Build your own" })).toHaveCount(0);
  const build = coachSheet(page).getByRole("link", { name: "Build your own" });
  await expect(build).toBeVisible({ timeout: 15_000 });
  expect(released).toBe(true);
  const buildY = (await build.boundingBox())!.y;
  await page.waitForTimeout(1_500);
  expect((await first.boundingBox())!.y).toBe(chipY);
  expect((await build.boundingBox())!.y).toBe(buildY);
});

test("the coach's opening holds still while it is read: with its reads held back, Build your own is drawn once, where it stays", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(context.request, baseURL, `${testInfo.project.name}-h`);
  await context.request.post(`${baseURL}/api/dev/coach-notices`, { data: { review: REVIEW } });
  await page.goto("/");
  for (const path of ["**/api/coach/nudges*", "**/api/templates*"]) {
    await page.route(path, async (route) => {
      await new Promise((r) => setTimeout(r, 1_500));
      await route.continue();
    });
  }
  await page.locator("button.nav-coach:visible").first().click();
  const build = coachSheet(page).getByRole("link", { name: "Build your own" });
  // The first place it is drawn, as soon as it is.
  let firstY: number | null = null;
  const until = Date.now() + 20_000;
  while (firstY === null && Date.now() < until) {
    const box = (await build.count()) > 0 ? await build.boundingBox() : null;
    if (box) firstY = box.y;
    else await page.waitForTimeout(20);
  }
  expect(firstY).not.toBeNull();
  // Everything it waited for is in: the line is the review's.
  await expect(coachLine(page)).toHaveText(REVIEW_LINE);
  await page.waitForTimeout(2_000);
  expect((await build.boundingBox())!.y).toBe(firstY);
});
