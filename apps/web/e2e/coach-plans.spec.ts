import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * WHOLE PLANS IN THE CONVERSATION — END TO END (§8 §5, stream W): the nav's Coach → "Plan my next four weeks toward a
 * 10K" → the coach reads the plans and proposes a block (`whole_plan`) → ONE plan card: its name, its line, its lines,
 * Approve plan and Not now → Approve plan: the plan goes on a part at a time, the card keeps approving while the server
 * says some remains → "Added to your plan" and a link to Plan → Plan's "Your plans" holds the block, its first week's
 * sessions in next week. Then "Extend it by two weeks" in the same conversation → the coach extends that block →
 * Approve plan → added. Everything but the model is the real app and the real worker: read_plans, propose_plan, the
 * guardrails, the chunked approve through the thread coach's appliers.
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-plans --workers=1
 *
 * One project: it writes a plan into the shared fixture account. `RG_COACH_SHOTS=<dir>` writes the screenshots.
 */

test.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");

const MODEL = `http://127.0.0.1:${process.env.RG_DESIGN_MODEL_PORT ?? "8897"}`;
const LIVE = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"];
const SHOTS = process.env.RG_COACH_SHOTS ?? null;
/** The scripted finishes (coach-design-scripts.mjs `PLAN_LINE`, `EXTEND_LINE`). */
const PLAN_LINE = "Four weeks that build to your 10K, easy days kept easy.";
const EXTEND_LINE = "Two more weeks on the end of your 10K build.";

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

async function send(page: Page, words: string) {
  await box(page).fill(words);
  await sheet(page).getByRole("button", { name: "Send" }).click();
  await expect(sheet(page).locator(".coach-msg--athlete", { hasText: words })).toBeVisible();
}

test("a whole plan: asked for → one card → Approve plan → on Plan; then extended in the same conversation", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  await signIn(context.request, baseURL);
  await clearTheCoach(context.request, baseURL);
  await model("/use/whole_plan");
  try {
    await page.goto("/plan");
    await openCoach(page);
    await newConversation(page);
    await send(page, "Plan my next four weeks toward a 10K");
    await expect(sheet(page).locator(".coach-msg--coach", { hasText: PLAN_LINE })).toBeVisible({ timeout: 60_000 });
    // One card: the plan's name, its line, what it holds — Approve plan and Not now.
    const card = sheet(page).locator("section.coach-plan").filter({ hasText: "10K build" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("4 weeks · 4 sessions to start · race");
    await expect(card.locator(".coach-plan-lines li").first()).toContainText("New plan: 10K build");
    await expect(card.locator(".coach-plan-lines li")).toHaveCount(8);
    await expect(card.locator(".coach-plan-lines li").last()).toContainText("Week of");
    await expect(card.getByRole("button", { name: "Not now" })).toBeVisible();
    await noOverflow(page);
    await shot(page, "plan-card", testInfo);
    await card.getByRole("button", { name: "Approve plan" }).click();
    await expect(card.getByText("✓ Added to your plan")).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole("button", { name: "Approve plan" })).toHaveCount(0);
    await noOverflow(page);
    await shot(page, "plan-added", testInfo);
    // The block on Plan: in Your plans, and its first week next week.
    await card.getByRole("link", { name: "See it on Plan" }).click();
    await expect(sheet(page)).toHaveCount(0);
    await expect(page.locator(".your-plans")).toContainText("10K build", { timeout: 20_000 });
    await page.getByRole("button", { name: "Next week" }).click();
    for (const title of ["Tempo run", "Long run"]) await expect(page.getByText(title).first()).toBeVisible({ timeout: 20_000 });
    await shot(page, "plan-on-plan", testInfo);

    // Extended, in the same conversation: the coach names that block.
    await openCoach(page);
    await send(page, "Extend it by two weeks");
    await expect(sheet(page).locator(".coach-msg--coach", { hasText: EXTEND_LINE })).toBeVisible({ timeout: 60_000 });
    const extend = sheet(page).locator("section.coach-plan").filter({ hasText: "Extend 10K build" });
    await expect(extend).toContainText("2 more weeks · to ");
    await extend.getByRole("button", { name: "Approve plan" }).click();
    await expect(extend.getByText("✓ Added to your plan")).toBeVisible({ timeout: 60_000 });
    // The first card, an older turn's and done: one line of what came of it.
    await expect(sheet(page).locator(".coach-card-closed").filter({ hasText: "10K build" })).toContainText("— Added to your plan");
    await noOverflow(page);
    await shot(page, "plan-extended", testInfo);
    const plans = (await (await context.request.get(`${baseURL}/api/coach/plans`)).json()) as { plans: Array<{ name: string; endDate: string; startDate: string }> };
    const block = plans.plans.find((p) => p.name === "10K build");
    expect(block).toBeDefined();
    // Four weeks and two more: its end moved to the sixth week's Sunday.
    const days = (Date.parse(`${block!.endDate}T12:00:00Z`) - Date.parse(`${block!.startDate}T12:00:00Z`)) / 86_400_000;
    expect(days).toBe(41);
  } finally {
    await model("/use/");
  }
});
