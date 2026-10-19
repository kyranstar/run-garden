import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * A PROGRAMME'S SETTINGS, CHANGED IN THE CONVERSATION — END TO END (§8 §5, stream W): the nav's Coach → "Move my
 * mobility programme to Tuesdays and Thursdays" → the coach reads the plans and changes the programme's days
 * (`programme_change`: read_plans, then change_programme) → ONE card: the programme's name, its new pattern, "Days Mon ·
 * Wed → Tue · Thu" and where its next sessions go, Approve and Not now → Approve: its settings written, its sessions
 * moved a request at a time ("Moving your sessions…"), the card asking again while some remains → "Programme updated"
 * → the programme's settings say Tuesday and Thursday, and next week's sessions of it sit on those days. Everything
 * but the model is the real app and the real worker.
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-programme --workers=1
 *
 * It changes the shared fixture account's programme: its days go to Monday and Wednesday before the journey (so Tuesday
 * and Thursday are always a change), and its settings back as they were after it, whatever happened.
 * `RG_COACH_SHOTS=<dir>` writes the screenshots.
 */

test.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");

const MODEL = `http://127.0.0.1:${process.env.RG_DESIGN_MODEL_PORT ?? "8897"}`;
const LIVE = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"];
const SHOTS = process.env.RG_COACH_SHOTS ?? null;
/** The scripted finish (coach-design-scripts.mjs `PROGRAMME_LINE`). */
const PROGRAMME_LINE = "Tuesdays and Thursdays from next week; this week stays as it is.";

interface Programme {
  id: string;
  name: string;
  status: string;
  config: { preferredDays: number[]; weeklyGoal: number } & Record<string, unknown>;
}

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

/** The account's running programme (the fixture's one). */
async function theProgramme(request: APIRequestContext, baseURL: string | undefined): Promise<Programme> {
  const { programs } = (await (await request.get(`${baseURL}/api/programs`)).json()) as { programs: Programme[] };
  const p = programs.find((x) => x.status === "active");
  if (!p) throw new Error("the fixture account has no running programme");
  return p;
}

/** Save a programme's settings as the settings sheet does: asked again (an empty patch) while its sessions are placed. */
async function saveSettings(request: APIRequestContext, baseURL: string | undefined, id: string, config: Record<string, unknown>) {
  let body: Record<string, unknown> = { config };
  for (let i = 0; ; i++) {
    if (i >= 20) throw new Error("the save never finished placing");
    const res = await request.patch(`${baseURL}/api/programs/${id}`, { data: body });
    expect(res.ok()).toBeTruthy();
    if (!((await res.json()) as { placing?: boolean }).placing) return;
    body = {};
  }
}

/** The Monday after `today` (never today). */
function nextMonday(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7));
  return d.toISOString().slice(0, 10);
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

test("a programme's days: asked for → one card → Approve → its settings and its next sessions on those days", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  await signIn(context.request, baseURL);
  await clearTheCoach(context.request, baseURL);
  const before = await theProgramme(context.request, baseURL);
  // Monday and Wednesday, twice a week: Tuesday and Thursday are a change whatever day this runs.
  await saveSettings(context.request, baseURL, before.id, { preferredDays: [0, 2], weeklyGoal: 2 });
  await model("/use/programme_change");
  try {
    await page.goto("/plan");
    await openCoach(page);
    await newConversation(page);
    await send(page, "Move my mobility programme to Tuesdays and Thursdays");
    await expect(sheet(page).locator(".coach-msg--coach", { hasText: PROGRAMME_LINE })).toBeVisible({ timeout: 60_000 });
    // One card: the programme's name and what changes, its new pattern, where its next sessions go.
    const card = sheet(page).locator("section.coach-plan").filter({ hasText: `${before.name}: new days` });
    await expect(card).toBeVisible();
    await expect(card).toContainText("Tue · Thu · 2 a week");
    await expect(card.locator(".coach-plan-lines li").first()).toHaveText("Days Mon · Wed → Tue · Thu");
    await expect(card.locator(".coach-plan-lines li").last()).toContainText("Next sessions");
    await expect(card.getByRole("button", { name: "Not now" })).toBeVisible();
    await noOverflow(page);
    await shot(page, "programme-card", testInfo);
    await card.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(card.getByText("✓ Programme updated")).toBeVisible({ timeout: 60_000 });
    await expect(card.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
    await noOverflow(page);
    await shot(page, "programme-updated", testInfo);

    // Its settings, and next week's sessions of it: Tuesday and Thursday.
    const after = await theProgramme(context.request, baseURL);
    expect(after.config.preferredDays).toEqual([1, 3]);
    expect(after.config.weeklyGoal).toBe(2);
    const today = await page.evaluate(() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    });
    const monday = nextMonday(today);
    const week = (await (await context.request.get(`${baseURL}/api/plan/week?start=${monday}`)).json()) as {
      days: Array<{ date: string; workouts: Array<{ planId?: string; completionState?: string }> }>;
    };
    const days = week.days.filter((d) => d.workouts.some((w) => w.planId === before.id)).map((d) => new Date(`${d.date}T12:00:00Z`).getUTCDay());
    // Tuesday is 2 and Thursday 4 to getUTCDay.
    expect(days).toEqual([2, 4]);
    await card.getByRole("link", { name: "See it on Plan" }).click();
    await expect(sheet(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Next week" }).click();
    await expect(page.getByText(before.name).first()).toBeVisible({ timeout: 20_000 });
    await shot(page, "programme-on-plan", testInfo);
  } finally {
    await model("/use/");
    // The shared account's programme as it was, whatever happened.
    await saveSettings(context.request, baseURL, before.id, { preferredDays: before.config.preferredDays, weeklyGoal: before.config.weeklyGoal });
  }
});
