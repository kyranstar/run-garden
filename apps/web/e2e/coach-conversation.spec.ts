import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE COACH, A CONVERSATION — END TO END (the new shape §5, stream C): the nav's Coach → the coach's sheet → turns on
 * the scripted model. Everything but the model is the real app and the real worker: the conversation's read, the auto
 * run, the opening context with the conversation so far, the step loop, the reviewer, the proposal, `replaces`, the
 * plan change and its approve.
 *
 *  1. the opening screen → a chip → an answer in words (`auto_answer`): the coach's line, no card;
 *  2. a request → a workout card → "make it shorter" → the new card, the old one one line: "— Replaced" (`reply`);
 *  3. a question → one tap on an answer → the run goes on to its card (`ask`);
 *  4. a change to the plan, seeing today's session → "1 change to your week" → Approve all (`plan_change`; one project:
 *     it skips a session of the shared fixture plan).
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-conversation --workers=1
 *
 * `RG_COACH_SHOTS=<dir>` writes the screenshots (light and dark) of each journey's moments.
 */

test.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");

const MODEL = `http://127.0.0.1:${process.env.RG_DESIGN_MODEL_PORT ?? "8897"}`;
const LIVE = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"];
const SHOTS = process.env.RG_COACH_SHOTS ?? null;
/** The scripted answer (coach-design-scripts.mjs `AUTO_ANSWER`). */
const AUTO_ANSWER =
  "Your holds have grown steadily over the last three weeks. Keep them twice a week, and add ten seconds when the last one feels easy.";
const PLAN_CHANGE_LINE = "One session off, so the legs come back for the weekend.";

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

/** The nav's Coach (the phone's bar, or the rail from lg): whichever is on screen. */
async function openCoach(page: Page) {
  await page.locator("button.nav-coach:visible").first().click();
  await expect(sheet(page)).toBeVisible();
}

/** A new conversation: the opening screen, whatever the last journey left. */
async function newConversation(page: Page) {
  await expect(box(page)).toBeVisible();
  // Settled: the opening, or the turns of the conversation it holds.
  await expect(sheet(page).locator(".coach-opening, .coach-turns").first()).toBeVisible();
  if (await sheet(page).locator(".coach-opening").isVisible()) return;
  await sheet(page).getByRole("button", { name: "More" }).click();
  await sheet(page).getByRole("menuitem", { name: "New conversation" }).click();
  await expect(sheet(page).locator(".coach-opening")).toBeVisible();
}

/** A screenshot of this moment, light and dark (RG_COACH_SHOTS). */
async function shot(page: Page, name: string, testInfo: { project: { name: string } }) {
  if (!SHOTS) return;
  // The phone is 390×844 (iPhone 13); the desktop's shots are 1440×900.
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

/** No page wider than the screen (a phone's overflow is a defect). */
async function noOverflow(page: Page) {
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wide).toBeLessThanOrEqual(1);
}

/** The coach's line in the turn of these words, once it is said. */
const coachLine = (page: Page, text: string): Locator => sheet(page).locator(".coach-msg--coach", { hasText: text });

test("1. the opening screen → a chip → an answer in words: the coach's line, no card", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  await signIn(context.request, baseURL);
  await clearTheCoach(context.request, baseURL);
  await model("/use/auto_answer");
  try {
    await page.goto("/");
    await openCoach(page);
    await newConversation(page);
    // The opening: one line from the day, the chips, ways to start yourself, the box focused; no time-frame buttons.
    const opening = sheet(page).locator(".coach-opening");
    await expect(opening.locator(".coach-msg--coach")).toBeVisible();
    await expect(opening.getByRole("group", { name: "Ways to start" }).getByRole("button")).not.toHaveCount(0);
    await expect(opening.getByText("Or start something yourself")).toBeVisible();
    await expect(opening.getByRole("link", { name: "Build your own" })).toBeVisible();
    for (const gone of ["Now", "Later today", "Plan ahead"]) await expect(sheet(page).getByRole("button", { name: gone, exact: true })).toHaveCount(0);
    await expect(box(page)).toHaveAttribute("placeholder", "Ask anything");
    await expect(box(page)).toBeFocused();
    await noOverflow(page);
    await shot(page, "opening", testInfo);
    // A chip is the athlete's words.
    const chip = opening.getByRole("group", { name: "Ways to start" }).getByRole("button").first();
    const words = (await chip.textContent())!.trim();
    await chip.click();
    await expect(sheet(page).locator(".coach-msg--athlete", { hasText: words })).toBeVisible();
    await expect(coachLine(page, AUTO_ANSWER)).toBeVisible({ timeout: 60_000 });
    await expect(sheet(page).locator(".coach-pc")).toHaveCount(0);
    await expect(sheet(page).locator(".coach-changes")).toHaveCount(0);
    await expect(box(page)).toHaveAttribute("placeholder", "Reply");
    await noOverflow(page);
    await shot(page, "answer", testInfo);
    // The conversation is kept: closed and opened again, it is there.
    await sheet(page).getByRole("button", { name: "Close" }).click();
    await openCoach(page);
    await expect(coachLine(page, AUTO_ANSWER)).toBeVisible();
  } finally {
    await model("/use/");
  }
});

test("2. a request → a workout card → 'make it shorter' → the new card in its place, the old one a line", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  await signIn(context.request, baseURL);
  await clearTheCoach(context.request, baseURL);
  await model("/use/reply");
  try {
    await page.goto("/plan");
    await openCoach(page);
    await newConversation(page);
    await box(page).fill("a short, gentle hips session");
    await sheet(page).getByRole("button", { name: "Send" }).click();
    // The run at work, quietly: its heading and Cancel, never the words said twice.
    await expect(sheet(page).getByRole("heading", { name: /^Coach · / })).toBeVisible();
    await expect(sheet(page).locator(".coach-run-request")).toHaveCount(0);
    await shot(page, "working", testInfo);
    const first = sheet(page).locator("section.coach-pc").filter({ hasText: "Hips and back, gently" });
    await expect(first).toBeVisible({ timeout: 60_000 });
    await expect(first).toContainText("Reviewed");
    await noOverflow(page);
    await shot(page, "workout-card", testInfo);
    // The reply changes it: its words, then the new suggestion; the old one closed to one line.
    await box(page).fill("make it shorter");
    if (testInfo.project.name === "iphone") {
      // A touch screen's Return is a new line: the button sends.
      await box(page).press("Enter");
      await expect(box(page)).toHaveValue("make it shorter\n");
      await sheet(page).getByRole("button", { name: "Send" }).click();
    } else {
      // With a keyboard, Return sends.
      await box(page).press("Enter");
    }
    await expect(sheet(page).locator(".coach-msg--athlete", { hasText: "make it shorter" })).toBeVisible();
    const second = sheet(page).locator("section.coach-pc").filter({ hasText: "Hips and back, shorter" });
    await expect(second).toBeVisible({ timeout: 60_000 });
    await expect(sheet(page).locator(".coach-card-closed")).toContainText("— Replaced", { timeout: 20_000 });
    await expect(sheet(page).locator("section.coach-pc").filter({ hasText: "Hips and back, gently" })).toHaveCount(0);
    await noOverflow(page);
    await shot(page, "replaced", testInfo);
    // Approve the new one: on the plan.
    await second.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(second.getByRole("link", { name: /^On your plan for / })).toBeVisible({ timeout: 30_000 });
  } finally {
    await model("/use/");
  }
});

test("3. a question → one tap on an answer → the run goes on to its card", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(150_000);
  await signIn(context.request, baseURL);
  await clearTheCoach(context.request, baseURL);
  await model("/use/ask");
  try {
    await page.goto("/plan");
    await openCoach(page);
    await newConversation(page);
    await box(page).fill("something for my hips");
    await sheet(page).getByRole("button", { name: "Send" }).click();
    const ask = sheet(page).getByRole("group", { name: "The coach asks" });
    await expect(ask.getByText("How do your hips feel today?")).toBeVisible({ timeout: 60_000 });
    await expect(box(page)).toHaveAttribute("placeholder", "Answer in your own words");
    await noOverflow(page);
    await shot(page, "question", testInfo);
    await ask.getByRole("button", { name: "Okay", exact: true }).click();
    await expect(sheet(page).locator("section.coach-pc")).toBeVisible({ timeout: 60_000 });
  } finally {
    await model("/use/");
  }
});

test("4. a change to the plan, seeing today's session → how many → Approve all", async ({ page, context, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "it skips a session of the shared fixture plan: one project");
  test.setTimeout(150_000);
  await signIn(context.request, baseURL);
  await clearTheCoach(context.request, baseURL);
  await model("/use/plan_change");
  try {
    await page.goto("/");
    await openCoach(page);
    await newConversation(page);
    // Today's session is what the coach sees: said, quietly, over the box.
    await expect(sheet(page).locator(".coach-seeing")).toContainText("Seeing: ");
    await noOverflow(page);
    await shot(page, "seeing", testInfo);
    await box(page).fill("my legs are heavy, take something off");
    const created = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/coach/runs");
    await sheet(page).getByRole("button", { name: "Send" }).click();
    // What it sees goes with the words as the run's focus: a workout, by its id (the script changes nothing without it).
    expect((await created).postDataJSON()).toMatchObject({ focus: { kind: "workout", id: expect.any(String) } });
    await expect(coachLine(page, PLAN_CHANGE_LINE)).toBeVisible({ timeout: 60_000 });
    const card = sheet(page).locator(".coach-changes");
    await expect(card).toContainText("1 change", { timeout: 20_000 });
    await shot(page, "plan-changes", testInfo);
    await card.getByRole("button", { name: "Approve all" }).click();
    await expect(card).toContainText("✓ 1 change made", { timeout: 30_000 });
    await shot(page, "plan-changes-done", testInfo);
  } finally {
    await model("/use/");
  }
});
