import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { seededAccount } from "./seeded-accounts.js";

/**
 * A PLAN THE COACH BUILT, RETIRED FROM PLAN — END TO END (§8 §4, stream P): in an account of its own, the coach builds
 * a block from the conversation (`whole_plan`, applied through `applyStructuralChunk` on the real worker), then Plan's
 * Your plans → the block → Retire… → "Retire the plan": the app asks `POST /api/coach/plans/:id/retire` until it no
 * longer answers `remaining`, each request a slice of the plan's sessions archived on D1, and the block is retired —
 * gone from next week, its sessions off the plan.
 *
 * Needs the fixture stack on the scripted model, and skips itself otherwise:
 *
 *   RG_E2E_DESIGN_MODEL=scripted:now bash apps/web/e2e/fixture-stack.sh
 *   RG_E2E_DESIGN_MODEL=scripted:now RG_BASE=http://localhost:5271 pnpm --filter @rg/web exec playwright test coach-plan-retire --workers=1
 *
 * `RG_COACH_SHOTS=<dir>` writes the screenshots.
 */

test.skip(process.env.RG_E2E_DESIGN_MODEL !== "scripted:now", "needs the fixture stack on the scripted model (RG_E2E_DESIGN_MODEL=scripted:now)");

const MODEL = `http://127.0.0.1:${process.env.RG_DESIGN_MODEL_PORT ?? "8897"}`;
const SHOTS = process.env.RG_COACH_SHOTS ?? null;
/** The scripted finish (coach-design-scripts.mjs `PLAN_LINE`). */
const PLAN_LINE = "Four weeks that build to your 10K, easy days kept easy.";

async function model(path: string): Promise<void> {
  await fetch(`${MODEL}${path}`, { method: "POST" });
}

/** An account of the project's own, seeded before the run (the global setup, seeded-accounts.ts): the plan it builds and
 * retires is nobody else's. */
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

const sheet = (page: Page) => page.getByRole("dialog", { name: "Coach" });
const box = (page: Page) => sheet(page).locator(".coach-box textarea");

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

type PlanDto = { id: string; name: string; status: string; startDate: string };

test("a block the coach built, retired from Plan a slice a request: off the plan, and retired", async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  await signIn(context.request, baseURL, seededAccount(testInfo, `retire-${testInfo.project.name}`));
  await model("/use/whole_plan");
  try {
    // The block, from the conversation: one card, Approve plan.
    await page.goto("/plan");
    await page.locator("button.nav-coach:visible").first().click();
    await expect(sheet(page)).toBeVisible();
    await expect(box(page)).toBeVisible();
    // The conversation as it stands first (an account a run before left one open), then a new one if it isn't.
    await expect(sheet(page).locator(".coach-opening, .coach-turns").first()).toBeVisible();
    if (!(await sheet(page).locator(".coach-opening").isVisible())) {
      await sheet(page).getByRole("button", { name: "More" }).click();
      await sheet(page).getByRole("menuitem", { name: "New conversation" }).click();
    }
    await box(page).fill("Plan my next four weeks toward a 10K");
    await sheet(page).getByRole("button", { name: "Send" }).click();
    await expect(sheet(page).locator(".coach-msg--coach", { hasText: PLAN_LINE })).toBeVisible({ timeout: 60_000 });
    const card = sheet(page).locator("section.coach-plan").filter({ hasText: "10K build" }).last();
    await card.getByRole("button", { name: "Approve plan" }).click();
    await expect(card.getByText("✓ Added to your plan")).toBeVisible({ timeout: 60_000 });
    const before = ((await (await context.request.get(`${baseURL}/api/coach/plans`)).json()) as { plans: PlanDto[] }).plans;
    const block = before.find((p) => p.name === "10K build" && p.status === "active");
    expect(block, JSON.stringify(before)).toBeDefined();
    await card.getByRole("link", { name: "See it on Plan" }).click();
    await expect(sheet(page)).toHaveCount(0);

    // Retire it from Your plans: the app asks until nothing remains.
    const retires: { status: number; body: unknown }[] = [];
    page.on("response", async (r) => {
      if (r.url().endsWith(`/api/coach/plans/${block!.id}/retire`)) retires.push({ status: r.status(), body: await r.json().catch(() => null) });
    });
    await page.locator(".your-plans .plan-row", { hasText: "10K build" }).first().click();
    await page.getByRole("button", { name: "Retire…" }).first().click();
    const confirm = page.getByRole("dialog", { name: "Retire this plan?" });
    await expect(confirm).toBeVisible();
    await shot(page, "retire-confirm", testInfo);
    await confirm.getByRole("button", { name: "Retire the plan" }).click();
    await expect(confirm).toHaveCount(0, { timeout: 30_000 });
    // The last answer is the one that retired it; any before it said `remaining`.
    await expect.poll(() => retires.at(-1)?.body ?? null, { timeout: 20_000 }).toEqual({ ok: true });
    expect(retires.slice(0, -1).every((r) => (r.body as { remaining?: boolean }).remaining === true), JSON.stringify(retires)).toBe(true);
    expect(retires.every((r) => r.status === 200), JSON.stringify(retires)).toBe(true);

    // Retired: the plan says so, and its first week holds none of its sessions (ids `cw-<proposal>-<op>-<n>`).
    const after = ((await (await context.request.get(`${baseURL}/api/coach/plans`)).json()) as { plans: PlanDto[] }).plans;
    expect(after.find((p) => p.id === block!.id)?.status ?? "retired").toBe("retired");
    const own = `${block!.id.replace(/^cp-/, "cw-")}-`;
    const week = (await (await context.request.get(`${baseURL}/api/plan/week?start=${block!.startDate}`)).json()) as { days: Array<{ workouts: Array<{ id: string }> }> };
    expect(week.days.flatMap((d) => d.workouts).filter((w) => w.id.startsWith(own))).toEqual([]);
    await page.goto("/plan");
    await expect(page.locator(".your-plans")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Next week" }).click();
    await shot(page, "retired", testInfo);
  } finally {
    await model("/use/");
  }
});
