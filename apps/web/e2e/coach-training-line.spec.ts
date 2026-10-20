import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { runTag, seededAccount } from "./seeded-accounts.js";

/**
 * A TRAINING LINE, END TO END (training lines, §3): an account whose coach built a running plan in two abutting phases
 * ("Base", then "Build") and put a one-off on the calendar outside both — Plan's "Your plans" holds ONE row, "Running",
 * saying "Phase 1 of 2 · Base" (and no row of one-offs); its sheet lists both phases; "Stop this plan…" asks with the
 * count of sessions that leave the calendar, and once stopped the row is gone, Past plans is as it was, and the
 * focus is on the result line; the one-off's own sheet says "One-off".
 *
 * The plans are written by the coach's own appliers through a fixture-only lever (`POST /api/dev/training-line`,
 * 404 outside fixture mode; a few statements, no seed), in an account seeded before the run (seeded-accounts.ts).
 * Needs the fixture stack, and no model.
 */

interface Seeded {
  phases: string[];
  oneOff: string;
  oneOffTitle: string;
}

async function signIn(request: APIRequestContext, baseURL: string | undefined, account: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      expect((await request.post(`${baseURL}/api/dev/fixture-login?account=${account}`)).ok()).toBeTruthy();
      return;
    } catch (e) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(e))) throw e;
    }
  }
}

test("two abutting run blocks are one Running line: its row, its phases, Stop this plan; a one-off says so", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const request = context.request;
  await signIn(request, baseURL, seededAccount(testInfo, `line-${runTag()}-${testInfo.project.name}`));
  const lever = await request.post(`${baseURL}/api/dev/training-line`);
  expect(lever.ok(), await lever.text()).toBeTruthy();
  const seeded = (await lever.json()) as Seeded;

  // One row for the two blocks, in the line's own words; the one-off has no row.
  await page.goto("/plan");
  const plans = page.locator(".your-plans");
  await expect(plans).toBeVisible({ timeout: 20_000 });
  const live = plans.locator(".plan-rows").first().locator(".plan-row");
  const running = live.filter({ has: page.locator(".plan-row-name", { hasText: /^Running$/ }) });
  await expect(running).toHaveCount(1);
  await expect(running.locator(".plan-row-state").first()).toHaveText(/^Phase 1 of 2 · Base · week \d+/);
  await expect(plans.getByText("Base", { exact: true })).toHaveCount(0);
  await expect(plans.getByText(/one-off/i)).toHaveCount(0);
  const pastBefore = (await plans.locator(".plan-past").count()) ? await plans.locator(".plan-past").innerText() : "";

  // Its sheet lists both phases.
  await running.click();
  const sheet = page.getByRole("dialog", { name: "Running" });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/[?&]line=run(:|%3A)/);
  await expect(sheet.locator(".line-phase-name")).toHaveText(["Phase 1 · Base", "Phase 2 · Build"]);

  // Stop this plan: the confirm says how many sessions leave; the result says it again, and holds the focus.
  await sheet.getByRole("button", { name: "Stop this plan…" }).first().click();
  const confirm = page.getByRole("dialog", { name: "Stop this plan?" });
  await expect(confirm).toBeVisible();
  const asked = /(\d+) sessions leave your calendar\./.exec((await confirm.innerText()).replace(/\s+/g, " "));
  expect(asked, await confirm.innerText()).not.toBeNull();
  const n = Number(asked![1]);
  expect(n).toBeGreaterThanOrEqual(6); // the whole second phase is still ahead
  await confirm.getByRole("button", { name: "Stop the plan" }).click();
  await expect(confirm).toHaveCount(0, { timeout: 30_000 });
  const said = sheet.getByRole("status").filter({ hasText: /^Stopped\./ });
  await expect(said).toHaveText(`Stopped. ${n} sessions left your calendar.`, { timeout: 20_000 });
  await expect(said).toBeFocused();

  // Gone from Your plans, and Past plans as it was.
  await page.goto("/plan");
  await expect(plans).toBeVisible({ timeout: 20_000 });
  await expect(plans.locator(".plan-row-name", { hasText: /^Running$/ })).toHaveCount(0);
  const pastAfter = (await plans.locator(".plan-past").count()) ? await plans.locator(".plan-past").innerText() : "";
  expect(pastAfter).toBe(pastBefore);
  const listed = ((await (await request.get(`${baseURL}/api/coach/plans`)).json()) as { plans: Array<{ id: string; status: string }> }).plans;
  for (const id of seeded.phases) expect(listed.find((p) => p.id === id)?.status ?? "retired").toBe("retired");

  // The one-off, outside every phase: left where it was, and its own sheet says what it is.
  await page.goto(`/plan?workout=${seeded.oneOff}`);
  const oneOff = page.getByRole("dialog").filter({ hasText: seeded.oneOffTitle });
  await expect(oneOff).toBeVisible({ timeout: 20_000 });
  await expect(oneOff.getByText("One-off")).toBeVisible();
});
