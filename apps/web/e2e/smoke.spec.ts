import type { Page } from "@playwright/test";
import { pinAccountMorning, test, expect } from "./fixtures.js";

/**
 * Smoke test of the fixture-seeded app across its main screens, on both
 * Playwright projects. Needs the fixture stack (worker with FIXTURE_MODE on
 * :8971, web dev server on :5271): `bash apps/web/e2e/fixture-stack.sh`, then
 * `RG_BASE=http://localhost:5271 pnpm --filter @rg/web e2e`. These verify the
 * shared UI renders real API data end to end.
 *
 * The fixture plan is dated relative to today, so a few assertions depend on
 * what "now" is; the browser clock is pinned to mid-morning to keep them off
 * the day boundary.
 */

// The stack script seeds the fixture user once; each browser context only
// needs its own session.
test.beforeEach(async ({ page, context, baseURL }) => {
  // context.request sends no Origin header, which the /api/dev/* origin guard
  // allows; a browser fetch from the page would be refused.
  const login = await context.request.post(`${baseURL}/api/dev/fixture-login`);
  expect(login.ok()).toBeTruthy();
  await pinAccountMorning(page, context, baseURL);
});

/** The Today card: one card, open at every width since the new shape (no pill, no Minimize). */
async function openTodayCard(page: Page) {
  await expect(page.locator("#dock-panel")).toBeVisible({ timeout: 15_000 });
}

test("Today leads with the one card and its workout", async ({ page }) => {
  await page.goto("/");
  await openTodayCard(page);
  await expect(page.locator(".dock-panel").getByRole("heading").first()).toBeVisible();
  // The day's lead and its action: a run's View workout, or — on a day the fixture holds only its program session (the
  // fixture places one on today; on a weekday with no fixture run it leads the card) — Start or Open.
  await expect(
    page.locator(".dock-panel").getByRole("link", { name: /^(View workout|Start|Open|Continue)$/ }).first(),
  ).toBeVisible();
});

test("Plan renders the week calendar with no COROS warning", async ({ page }) => {
  const readNow = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/coros/read-now" && r.request().method() === "POST",
  );
  await page.goto("/plan");
  // The Plan reads a dozen things before it shows; on a busy runner each took 1–2.7 s.
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".plan-week-title").first()).toBeVisible();
  // The app-open COROS check resolves silently when connected (the fixture
  // user is). Proven only once it has settled (Audit 2 E2E I2): the read
  // answered, "Checking COROS…" is gone, and no COROS note of any kind —
  // including the plain ones, unreachable and still syncing — is showing.
  expect((await readNow).status()).toBe(200);
  await expect(page.locator(".coros-checking")).toHaveCount(0);
  await expect(page.getByText(/COROS (not connected|rejected|unreachable)|Still syncing/)).toHaveCount(0);
});

test("Today renders a scene, and the garden drawer opens the species collection", async ({ page }) => {
  await page.goto("/");
  // The scene is drawn after the garden's reads land; a cold start on a shared CI runner has taken longer than the
  // default 5 s (a green re-run of the same commit confirmed the flake).
  await expect(page.locator("svg[role=img]").first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Your garden" }).click();
  await page.getByRole("dialog", { name: "Your garden" }).getByRole("button", { name: /^Collection · \d+ of \d+$/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByText(/Growing next/i).first()).toBeVisible();
});

test("the old addresses land on Growth (/insights, /runs) and /garden on Today", async ({ page }) => {
  await page.goto("/insights");
  await expect(page).toHaveURL(/\/growth$/);
  await page.goto("/garden");
  await expect(page).toHaveURL(/\/$/);
});

test("Settings exposes the COROS connection and data controls", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "COROS", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Export everything/ })).toBeVisible();
  await expect(page.getByText(/Restore from file/)).toBeVisible();
});

test("Moving a workout opens the move sheet", async ({ page }) => {
  // A run still ahead in the fixture plan, opened by its own link — the Today card leads with the program session on
  // a weekday with no fixture run, so it is not always a run's card.
  await page.goto("/plan");
  // The page settles first: WebKit reports a read the next navigation cuts off as a page error ("… due to access
  // control checks"), which says nothing about the app — and the read below would race it.
  await expect(page.getByRole("heading", { name: "Plan", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  const runId = await page.evaluate(async () => {
    const res = await fetch("/api/plan/workouts", { credentials: "include" });
    const body = (await res.json()) as { workouts?: Array<{ id: string; sport: string; origin?: string | null; completionState: string; effectiveDate: string }> } | Array<{ id: string; sport: string; origin?: string | null; completionState: string; effectiveDate: string }>;
    const list = Array.isArray(body) ? body : (body.workouts ?? []);
    // The account's today, as the server keeps it — never the page's own date.
    const today = ((await (await fetch("/api/plan/today", { credentials: "include" })).json()) as { today: string }).today;
    return list.find((w) => w.sport === "run" && !w.origin && w.completionState === "scheduled" && w.effectiveDate >= today)?.id ?? null;
  });
  expect(runId).not.toBeNull();
  await page.goto(`/plan?workout=${encodeURIComponent(runId!)}`);
  await page.getByRole("dialog").getByRole("button", { name: "Move" }).first().click();
  await expect(page.getByRole("dialog").last()).toBeVisible();
});
