import { test, expect } from "@playwright/test";

/**
 * Smoke test of the fixture-seeded app across the five screens. Requires the
 * worker (FIXTURE_MODE=1, seeded) and the web dev server to be running — see
 * docs/TESTING.md. These verify the shared UI renders real API data end to end.
 */

test.beforeEach(async ({ context, baseURL }) => {
  const res = await context.request.post(`${baseURL}/api/dev/fixture-login`);
  expect(res.ok()).toBeTruthy();
});

test("Today shows the next workout with a COROS duration estimate", async ({ page }) => {
  await page.goto("/");
  // Mobile Today leads with a "Next workout" card; the desktop garden stage
  // carries the same fact in its HUD ("Next: …").
  await expect(page.getByText(/Next workout|Next:/).first()).toBeVisible();
  await expect(page.getByText(/min/).first()).toBeVisible();
});

test("Plan renders the week calendar and speaks the COROS check outcome", async ({ page }) => {
  await page.goto("/plan");
  await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible();
  // The plan is a single week-pickable calendar (coach/plan rework).
  await expect(page.locator(".plan-week-title").first()).toBeVisible();
  // The app-open COROS check must resolve to a visible outcome — never a
  // pill that flashes and vanishes (live user report, 2026-08-12). Fixture
  // mode has no COROS connection, so the honest state is the Settings link.
  await expect(page.getByText("COROS not connected — connect in Settings")).toBeVisible();
});

test("Garden renders a scene and a species collection", async ({ page }) => {
  await page.goto("/garden");
  await expect(page.locator("svg[role=img]").first()).toBeVisible();
  // Desktop stage keeps the collection in a drawer behind the HUD rail;
  // mobile keeps the inline card.
  const rail = page.getByRole("button", { name: /Collection · / });
  if (await rail.isVisible().catch(() => false)) {
    await rail.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText(/Growing next/i).first()).toBeVisible();
  } else {
    await expect(page.getByText(/Species collection/)).toBeVisible();
  }
});

test("Insights renders the dashboard and suppresses thin metrics honestly", async ({ page }) => {
  await page.goto("/insights");
  // Card order per the dashboard spec: status strip, signals, consistency.
  await expect(page.locator(".status-strip")).toBeVisible();
  await expect(page.getByText("Signals", { exact: true })).toBeVisible();
  await expect(page.getByText("Consistency · last 12 weeks")).toBeVisible();
  // Aerobic decoupling either draws or explains its own sample size; either
  // way the words "steady runs" appear, and never a bare empty card.
  await expect(page.getByText(/steady runs/).first()).toBeVisible();
});

test("Settings exposes connections, devices, and data controls", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("Connections")).toBeVisible();
  await expect(page.getByText("COROS connection", { exact: true })).toBeVisible();
  await expect(page.getByText("Export everything (JSON)")).toBeVisible();
});

test("Moving a workout opens candidate recommendations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Move" }).first().click();
  // The move sheet loads candidates or a blocked reason.
  await expect(page.getByRole("dialog")).toBeVisible();
});
