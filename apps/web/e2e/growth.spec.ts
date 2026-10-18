import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * GROWTH, END TO END (the new shape §7) on the fixture stack, phone and desktop: the place opens on its four sections
 * (the body map, the quests, the records, the activity); Month / Season reads the other period and keeps it in the
 * address; and the quiet area's button opens the app's coach with the words written — the athlete's to send.
 *
 * The quiet area is made certain: for the journey the account's focus areas name the neck, which nothing in the
 * fixture trains, so the neck is quiet all month ("Neck quiet all month.", "15 minutes for my neck"); the profile's
 * focus areas are put back after. No model is called: the words are only written in the box.
 *
 *   bash apps/web/e2e/fixture-stack.sh   (RG_API_PORT, RG_WEB_PORT, RG_E2E_STATE of your own)
 *   RG_BASE=http://localhost:<web> pnpm --filter @rg/web exec playwright test growth --workers=1
 *
 * RG_GROWTH_SHOTS=<dir> also writes the screenshots: Growth at the project's size, light and dark, the month and the
 * season, "By area" open, and the coach opened from the quiet area — failing on any sideways overflow on the phone.
 */

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

type Profile = { focusAreas: unknown[] };

/** The neck as a focus area for the length of `fn`; the athlete's own focus areas back after. */
async function withNeckFocus(request: APIRequestContext, baseURL: string | undefined, fn: () => Promise<void>) {
  const before = (await (await request.get(`${baseURL}/api/profile`)).json()) as Profile;
  const put = await request.put(`${baseURL}/api/profile`, { data: { focusAreas: [{ id: "neck-e2e", label: "Neck", refs: ["neck"] }] } });
  expect(put.ok(), await put.text()).toBeTruthy();
  try {
    await fn();
  } finally {
    await request.put(`${baseURL}/api/profile`, { data: { focusAreas: before.focusAreas ?? [] } });
  }
}

async function noSidewaysScroll(page: Page, what: string) {
  const { scroll, inner } = await page.evaluate(() => ({ scroll: document.scrollingElement!.scrollWidth, inner: window.innerWidth }));
  expect(scroll, `sideways overflow: ${what}`).toBeLessThanOrEqual(inner + 1);
}

const SHOTS = process.env.RG_GROWTH_SHOTS;

async function shot(page: Page, name: string, project: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(400);
  if (project === "iphone") await noSidewaysScroll(page, name);
  await page.screenshot({ path: join(SHOTS, `${name}__${project}.png`), fullPage: true });
  // What the screen shows as it stands, the nav where it sits.
  await page.screenshot({ path: join(SHOTS, `${name}__${project}__screen.png`) });
}

const coachSheet = (page: Page) => page.getByRole("dialog", { name: "Coach" });

test("Growth: the body map, quests, records and activity; Month / Season; the quiet area asks the coach with words", async ({ page, context, baseURL }, info) => {
  test.setTimeout(90_000);
  // The shots' desktop is 1440 × 900.
  if (SHOTS && info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(context.request, baseURL);
  await withNeckFocus(context.request, baseURL, async () => {
    await page.goto("/growth");
    // The first visit to Growth on the fixture stack compiles its module on the dev server: on a CI runner's WebKit that
    // took over the 5 s default (CI, 2026-10-18), so the first page waits as long as a cold first page needs.
    await expect(page.getByRole("heading", { level: 1, name: "Growth" })).toBeVisible({ timeout: 20_000 });
    for (const h of ["Your body", "Quests", "Records", "Activity"]) await expect(page.getByRole("heading", { level: 2, name: h })).toBeVisible({ timeout: 15_000 });

    // The figure: every area, its words beside it.
    const figure = page.getByRole("img", { name: /^Body map\./ });
    await expect(figure).toBeVisible();
    await expect(page.locator(".body-figure [data-area]")).toHaveCount(11);
    await expect(page.getByText("Neck quiet all month.")).toBeVisible();
    await expect(page.getByRole("group", { name: "Period" }).getByRole("button", { name: "Month" })).toHaveAttribute("aria-pressed", "true");
    if (info.project.name === "iphone") await noSidewaysScroll(page, "Growth on a phone");
    await shot(page, "growth-month", info.project.name);

    // By area, one tap down: every area in words.
    await page.getByRole("button", { name: "By area" }).click();
    await expect(page.getByRole("list", { name: "By area" }).getByRole("listitem")).toHaveCount(11);
    await page.getByRole("list", { name: "By area" }).scrollIntoViewIfNeeded();
    await shot(page, "growth-by-area", info.project.name);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByRole("button", { name: "By area" }).click();

    // The season: read, and kept in the address.
    await page.getByRole("button", { name: "Season" }).click();
    await expect(page).toHaveURL(/\/growth\?period=season$/);
    await expect(page.getByText("Neck quiet all season.")).toBeVisible();
    await shot(page, "growth-season", info.project.name);
    await page.reload();
    await expect(page.getByRole("button", { name: "Season" })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Month" }).click();
    await expect(page).toHaveURL(/\/growth$/);

    // The quiet area's button: the coach opens with the words written, nothing sent.
    const ask = page.getByRole("button", { name: "Ask the coach: 15 minutes for my neck" });
    await expect(ask).toBeVisible();
    const box = await ask.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(info.project.name === "iphone" ? 44 : 32);
    const runs: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/coach/runs") runs.push(r.url());
    });
    await ask.click();
    const sheet = coachSheet(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.locator("textarea")).toHaveValue("15 minutes for my neck");
    await shot(page, "growth-quiet-ask", info.project.name);
    expect(runs, "the words are written, never sent for the athlete").toEqual([]);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });
});

test("Growth in the dark: the same page, the dark tokens", async ({ browser, baseURL }, info) => {
  test.skip(!SHOTS, "screenshots only (RG_GROWTH_SHOTS)");
  const u = info.project.use;
  const context = await browser.newContext({
    viewport: info.project.name === "desktop" ? { width: 1440, height: 900 } : u.viewport,
    userAgent: u.userAgent,
    deviceScaleFactor: u.deviceScaleFactor,
    isMobile: u.isMobile,
    hasTouch: u.hasTouch,
    timezoneId: u.timezoneId,
    colorScheme: "dark",
  });
  const page = await context.newPage();
  await signIn(context.request, baseURL);
  await withNeckFocus(context.request, baseURL, async () => {
    await page.goto(`${baseURL}/growth`);
    await expect(page.getByRole("img", { name: /^Body map\./ })).toBeVisible();
    await shot(page, "growth-month-dark", info.project.name);
    await page.getByRole("button", { name: "By area" }).click();
    await shot(page, "growth-by-area-dark", info.project.name);
    await page.getByRole("button", { name: "Season" }).click();
    await expect(page.getByText("Neck quiet all season.")).toBeVisible();
    await shot(page, "growth-season-dark", info.project.name);
  });
  await context.close();
});

test("Growth's quests: a quest's bar and line, its card in a sheet, and the sheet's own Ask seeing the objective", async ({ page, context, baseURL }, info) => {
  if (SHOTS && info.project.name === "desktop") await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(context.request, baseURL);
  const made = await context.request.post(`${baseURL}/api/objectives`, {
    data: {
      title: "Easy running feels easy",
      keyResults: [{ label: "Easy pace", measure: { kind: "pace_at_hr", hrLow: 110, hrHigh: 175 }, unit: "s/km", baseline: 420, target: 330 }],
    },
  });
  expect(made.ok(), await made.text()).toBeTruthy();
  const { objective } = (await made.json()) as { objective: { id: string } };
  try {
    await page.goto("/growth");
    const quests = page.getByRole("region", { name: "Quests" });
    await expect(quests.getByText("Easy running feels easy")).toBeVisible();
    await quests.scrollIntoViewIfNeeded();
    await shot(page, "growth-quests", info.project.name);
    await quests.getByRole("button", { name: "Easy running feels easy" }).click();
    const sheet = page.getByRole("dialog", { name: "Easy running feels easy" });
    await expect(sheet).toBeVisible();
    await shot(page, "growth-quest-card", info.project.name);
    // A modal sheet covers the nav's coach: the sheet's own small Ask opens it seeing the objective.
    await sheet.getByRole("button", { name: "Ask the coach about Easy running feels easy" }).click();
    const coach = coachSheet(page);
    await expect(coach).toBeVisible();
    await expect(coach.getByText("Seeing: Easy running feels easy")).toBeVisible();
    await shot(page, "growth-quest-ask", info.project.name);
  } finally {
    await context.request.put(`${baseURL}/api/objectives/${objective.id}`, { data: { status: "dropped" } });
  }
});

test("the old addresses land on Growth: /runs, /insights and /studio/objectives", async ({ page, context, baseURL }) => {
  await signIn(context.request, baseURL);
  for (const from of ["/runs", "/insights", "/studio/objectives"]) {
    await page.goto(from);
    await expect(page).toHaveURL(/\/growth$/);
    await expect(page.getByRole("heading", { level: 1, name: "Growth" })).toBeVisible();
  }
});
