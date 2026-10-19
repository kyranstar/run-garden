import type { Page } from "@playwright/test";
import { pinAccountMorning, test, expect } from "./fixtures.js";

/**
 * THE THREAD COACH STEPS BACK, end to end on the fixture stack (§8 §6, stream T). The stack runs as production does,
 * the switch off:
 *
 *  - the Plan wakes no coach when it opens, and a cached old client's calls (`/state`, `/wake`, `/message`) start
 *    nothing and show no "thinking";
 *  - a plan's Extend and Wind down, and "Plan with the coach", open the coach with the request written — nothing sent;
 *  - a race close is a "needs you" chip first on the coach's opening screen, and the race strip says where it stands.
 *
 * Both Playwright projects. Fixture data only; the race day it sets is put back.
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

const coachSheet = (page: Page) => page.getByRole("dialog", { name: "Coach" });

/** Every request the page makes to a path, by method. */
function watch(page: Page, paths: string[]): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const path = new URL(r.url()).pathname;
    if (paths.includes(path)) seen.push(`${r.method()} ${path}`);
  });
  return seen;
}

test("the Plan wakes no coach, and a cached old client's calls start nothing and show no thinking", async ({ page, context, baseURL }) => {
  const sent = watch(page, ["/api/coach/wake", "/api/coach/message"]);
  const stateRead = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/coach/state");
  await page.goto("/plan");
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible({ timeout: 30_000 });
  const state = await (await stateRead).json();
  expect(state.wakeAdvised).toBe(false);
  await page.waitForTimeout(1_000);
  expect(sent).toEqual([]);

  // An old client's Plan visit, its Check in, and its Extend: skipped, and the words kept with a receipt.
  for (const force of [false, true]) {
    expect(await (await context.request.post(`${baseURL}/api/coach/wake`, { data: { force } })).json()).toEqual({ status: "skipped" });
  }
  const words = "Extend my plan — draft the next weeks in the same shape.";
  expect(await (await context.request.post(`${baseURL}/api/coach/message`, { data: { body: words } })).json()).toEqual({ status: "skipped" });
  const after = await (await context.request.get(`${baseURL}/api/coach/state`)).json();
  expect(after.coachThinking).toBe(false);
  expect(after.wakeAdvised).toBe(false);
  expect(after.messages.slice(-2).map((m: { role: string; body: string }) => [m.role, m.body])).toEqual([
    ["user", words],
    ["receipt", "Your coach is now behind the Coach button."],
  ]);
});

test("a plan's Extend and Wind down, and Plan with the coach, open the coach with the words written — nothing sent", async ({ page }) => {
  // The fixture has no plan the coach made (Extend is a coach plan's): its run plan is shown as one.
  const asCoach = async (route: import("@playwright/test").Route, pick: (b: any) => unknown) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: pick(await res.json()) });
  };
  await page.route((url) => url.pathname === "/api/coach/plans", (r) =>
    asCoach(r, (b) => ({ ...b, plans: b.plans.map((x: { discipline: string }) => (x.discipline === "run" ? { ...x, source: "coach" } : x)) })),
  );
  await page.route((url) => /^\/api\/coach\/plans\/[^/]+\/detail$/.test(url.pathname), (r) =>
    asCoach(r, (b) => (b.plan?.discipline === "run" ? { ...b, plan: { ...b.plan, source: "coach" } } : b)),
  );
  const sent = watch(page, ["/api/coach/runs", "/api/coach/message", "/api/coach/wake"]);

  await page.goto("/plan");
  await expect(page.getByRole("heading", { name: "Your plans" })).toBeVisible({ timeout: 30_000 });
  const row = page.locator("button.plan-row").filter({ hasText: /Running plan/ }).first();
  const name = (await row.locator(".plan-row-name").innerText()).trim();
  await row.click();
  const sheet = page.getByRole("dialog", { name });
  await expect(sheet).toBeVisible();

  await sheet.getByRole("button", { name: "Extend" }).click();
  await expect(coachSheet(page).locator("textarea")).toHaveValue(/^Extend my .+ by two weeks$/);
  await page.keyboard.press("Escape");
  await expect(coachSheet(page)).toHaveCount(0);

  await sheet.getByRole("button", { name: "Wind down" }).click();
  await expect(coachSheet(page).locator("textarea")).toHaveValue(/^Wind down my .+$/);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);

  await page.getByRole("button", { name: "Plan with the coach" }).click();
  await expect(coachSheet(page).locator("textarea")).toHaveValue("Help me plan my next few weeks");
  expect(sent.filter((s) => s.startsWith("POST"))).toEqual([]);
});

test("a race close: a needs-you chip first on the coach's opening screen, and the race strip says where it stands", async ({ page, context, baseURL }, testInfo) => {
  // It sets the one fixture account's race day and puts it back: on one project only, so the other's run of it can't
  // put it back in the middle of this one.
  test.skip(testInfo.project.name !== "desktop", "sets the shared fixture account's race day: one project runs it");
  const before = ((await (await context.request.get(`${baseURL}/api/settings`)).json()) as { prefs: { raceDate: string | null } }).prefs.raceDate;
  const today = ((await (await context.request.get(`${baseURL}/api/plan/today`)).json()) as { today: string }).today;
  const raceDate = new Date(Date.parse(`${today}T12:00:00Z`) + 10 * 86_400_000).toISOString().slice(0, 10);
  expect((await context.request.put(`${baseURL}/api/settings`, { data: { raceDate } })).ok()).toBeTruthy();
  try {
    const nudges = (await (await context.request.get(`${baseURL}/api/coach/nudges`)).json()) as { nudges: Array<{ id: string; label: string; request: string }> };
    expect(nudges.nudges.length).toBeLessThanOrEqual(2);
    const race = nudges.nudges.find((n) => n.id === `race:${raceDate}`);
    // A missed session or a return can come before it; the fixture has neither twice over, so the race is among the two.
    expect(race).toEqual({ id: `race:${raceDate}`, label: "Get me ready for race day", request: "My race is in 10 days. Get me ready for race day." });

    await page.goto("/");
    // What the coach noticed (stream H: a session the fixture finished today or yesterday) would come first among the
    // chips, two at most: marked as already shown on this device, so the chips are the needs-you ones alone.
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const query = seen.length ? `?seen=${encodeURIComponent(seen.join(","))}` : "";
      const read = (await (await context.request.get(`${baseURL}/api/coach/nudges${query}`)).json()) as { opening?: { id: string } };
      if (!read.opening) break;
      seen.push(read.opening.id);
    }
    await page.evaluate((ids) => localStorage.setItem("rg.coach.openingSeen", JSON.stringify(ids)), seen);
    await (await mainNav(page)).getByRole("button", { name: "Coach" }).click();
    const sheet = coachSheet(page);
    await expect(sheet.locator(".coach-box textarea")).toBeVisible({ timeout: 20_000 });
    // The conversation as it stands first (a spec before may have left one open), then a new one if it isn't.
    await expect(sheet.locator(".coach-opening, .coach-turns").first()).toBeVisible({ timeout: 20_000 });
    if (!(await sheet.locator(".coach-opening").isVisible())) {
      await sheet.getByRole("button", { name: "More" }).click();
      await sheet.getByRole("menuitem", { name: "New conversation" }).click();
      await expect(sheet.locator(".coach-opening")).toBeVisible();
    }
    const needs = sheet.locator(".coach-chips .coach-chip--needs");
    await expect(needs.filter({ hasText: "Get me ready for race day" })).toHaveCount(1, { timeout: 15_000 });
    // The needs-you chips come first in the row.
    const all = await sheet.locator(".coach-chips button").evaluateAll((els) => els.map((e) => e.classList.contains("coach-chip--needs")));
    expect(all.indexOf(false)).toBe(nudges.nudges.length);

    const strip = (await (await context.request.get(`${baseURL}/api/plan/race`)).json()) as {
      race: { raceLine: { text: string } | null; raceLineSource?: string };
    };
    expect(strip.race.raceLine?.text).toBe("10 days to go — the taper: a little less running, more rest.");
    // The app's own words, never signed "Coach".
    expect(strip.race.raceLineSource).toBe("app");
  } finally {
    await context.request.put(`${baseURL}/api/settings`, { data: { raceDate: before } });
  }
});
