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
  await expect(page.getByText("Next workout")).toBeVisible();
  await expect(page.getByText(/min/).first()).toBeVisible();
  // The sync status line is always present.
  await expect(page.getByText(/Calendar|COROS/).first()).toBeVisible();
});

test("Plan renders the almanac calendar", async ({ page }) => {
  await page.goto("/plan");
  await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible();
  // The plan is an almanac month grid (the old week-list "Week of" copy is gone).
  await expect(page.locator(".cal-month-title").first()).toBeVisible();
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

test("Insights renders consistency and suppresses thin metrics honestly", async ({ page }) => {
  await page.goto("/insights");
  await expect(page.getByText("Plan consistency · last 12 weeks")).toBeVisible();
  // HR drift is suppressed with a sample-size explanation in the fixture data.
  await expect(page.getByText(/steady runs/).first()).toBeVisible();
});

test("Settings exposes connections, devices, and data controls", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("Connections")).toBeVisible();
  await expect(page.getByText("Desktop companion", { exact: true })).toBeVisible();
  await expect(page.getByText("Export everything (JSON)")).toBeVisible();
});

test("Moving a workout opens candidate recommendations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Move" }).first().click();
  // The move sheet loads candidates or a blocked reason.
  await expect(page.getByRole("dialog")).toBeVisible();
});
