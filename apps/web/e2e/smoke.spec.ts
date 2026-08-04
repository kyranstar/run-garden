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

test("Plan lists workouts grouped by week", async ({ page }) => {
  await page.goto("/plan");
  await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible();
  await expect(page.getByText(/Week of/).first()).toBeVisible();
});

test("Garden renders a scene and a species collection", async ({ page }) => {
  await page.goto("/garden");
  await expect(page.locator("svg[role=img]").first()).toBeVisible();
  await expect(page.getByText(/Species collection/)).toBeVisible();
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
  await expect(page.getByText("Desktop companion")).toBeVisible();
  await expect(page.getByText("Export everything (JSON)")).toBeVisible();
});

test("Moving a workout opens candidate recommendations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Move" }).first().click();
  // The move sheet loads candidates or a blocked reason.
  await expect(page.getByRole("dialog")).toBeVisible();
});
