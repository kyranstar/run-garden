import type { Page } from "@playwright/test";
import { pinAccountMorning, test, expect } from "./fixtures.js";

/**
 * THE NEW SHAPE, end to end on the fixture stack (stream B): the nav on a phone and from lg, Today's one card (its
 * action, the garden drawer, Ask opening the coach), Plan's week and a plan's sheet whose action opens the coach with
 * its words written, and Settings in its five groups. Both Playwright projects: the phone (iPhone 13) and the desktop
 * (1280 × 800, the rail). Fixture data only.
 */

test.beforeEach(async ({ page, context, baseURL }) => {
  const login = await context.request.post(`${baseURL}/api/dev/fixture-login`);
  expect(login.ok()).toBeTruthy();
  await pinAccountMorning(page, context, baseURL);
});

/** The nav the page's width shows: the phone's bar, or the rail from lg. */
async function mainNav(page: Page) {
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  return page.locator(wide ? "nav.side-nav" : "nav.bottom-nav");
}

/** The coach's sheet: a dialog named Coach. */
const coachSheet = (page: Page) => page.getByRole("dialog", { name: "Coach" });

test("the nav: Today · Plan · Coach · Growth, the coach a button that opens its sheet", async ({ page }) => {
  await page.goto("/");
  const nav = await mainNav(page);
  await expect(nav).toBeVisible();
  const names = await nav.locator(":scope > a, :scope > button").allInnerTexts();
  expect(names.map((n) => n.trim())).toEqual(["Today", "Plan", "Coach", "Growth"]);
  await nav.getByRole("link", { name: "Plan" }).click();
  await expect(page).toHaveURL(/\/plan$/);
  await nav.getByRole("link", { name: "Growth" }).click();
  await expect(page).toHaveURL(/\/growth$/);
  await nav.getByRole("button", { name: "Coach" }).click();
  await expect(coachSheet(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(coachSheet(page)).toHaveCount(0);
});

test("Settings: the athlete's mark on a phone, the rail's foot from lg", async ({ page }) => {
  await page.goto("/plan");
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible({ timeout: 30_000 });
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  if (wide) {
    await expect(page.locator(".athlete-mark")).toBeHidden();
    await page.locator("nav.side-nav .nav-footer").getByRole("link", { name: "Settings" }).click();
  } else {
    await page.getByRole("link", { name: "Settings" }).click();
  }
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
});

test("Today: the one card's action, the garden drawer, and Ask opening the coach", async ({ page }) => {
  await page.goto("/");
  const card = page.locator("#dock-panel");
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".today-eyebrow")).toHaveText(/^[A-Z][\w ]* · \w{3} \d{1,2} \w{3}$/);
  // Gone from the home: the week ribbon, Minimize, the Lately strip.
  await expect(page.locator(".week-ribbon, .dock-collapse, .lately")).toHaveCount(0);

  // The drawer, from the handle at the card's foot.
  await page.getByRole("button", { name: "Your garden" }).click();
  const drawer = page.getByRole("dialog", { name: "Your garden" });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("heading", { name: "Next to bloom" })).toBeVisible();
  await expect(drawer.getByRole("link", { name: /All of your growth/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);

  // Ask: the coach's sheet, seeing today's session.
  await card.getByRole("button", { name: /^Ask the coach about/ }).first().click();
  await expect(coachSheet(page)).toBeVisible();
  await page.keyboard.press("Escape");

  // The card's action: a programme session's Start, or a run's View workout — both open its sheet on Plan.
  const action = card.locator(".today-actions").getByRole("link", { name: /^(Start|View workout|Open)$/ }).first();
  await action.click();
  await expect(page).toHaveURL(/\/plan\?workout=/);
  const workoutSheet = page.getByRole("dialog").first();
  await expect(workoutSheet).toBeVisible();
  // Modal, the nav out of reach: the sheet keeps its own Ask, seeing its workout (the integrated review, I3).
  await workoutSheet.getByRole("button", { name: /^Ask the coach about/ }).click();
  await expect(coachSheet(page)).toBeVisible();
  await expect(coachSheet(page).locator(".coach-seeing")).toContainText("Seeing: ");
  await page.keyboard.press("Escape");
  await expect(coachSheet(page)).toHaveCount(0);
  await expect(workoutSheet).toBeVisible();
});

test("Plan: the week first, then a plan's sheet whose action opens the coach with its words written", async ({ page }) => {
  await page.goto("/plan");
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 2, name: "This week" })).toBeVisible();
  const line = page.locator("button.plan-week-line");
  await expect(line).toHaveText(/ · .* done/);
  // The line opens the week's brief.
  await line.click();
  await expect(page.getByRole("dialog").first()).toBeVisible();
  await page.keyboard.press("Escape");

  // Your plans: one list; a plan opens its sheet.
  await expect(page.getByRole("heading", { name: "Your plans" })).toBeVisible();
  const planRow = page.locator("button.plan-row").filter({ hasText: /plan ·/ }).first();
  const name = (await planRow.locator(".plan-row-name").innerText()).trim();
  await planRow.click();
  const sheet = page.getByRole("dialog", { name });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Ask about this plan" }).click();
  await expect(coachSheet(page)).toBeVisible();
  await expect(coachSheet(page).locator("textarea")).toHaveValue(/^How is my .+ going\?$/);

  // Escape over another sheet: the coach's sheet goes, and the plan's sheet it was opened over is still there.
  await page.keyboard.press("Escape");
  await expect(coachSheet(page)).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Ask about this plan" })).toBeVisible();
});

test("Settings: five groups", async ({ page }) => {
  await page.goto("/settings");
  const groups = page.locator(".settings-group > h2");
  await expect(groups).toHaveText(["Connections", "Training", "Coach & AI", "Garden", "Data & account"], { timeout: 15_000 });
  await expect(page.getByRole("heading", { level: 3, name: "COROS" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Write date changes back to COROS" })).toBeVisible();
});
