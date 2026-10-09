import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE WATCH JOURNEYS (Phase 3 Task 11; spec §4–§6; approved mocks §1–3).
 *
 *   (a) The switch off (the default stack): nothing about the watch on the session sheet or Today.
 *   (b) The switch on: answer the pre-check → Send to watch → the preview lists the build's moves → Send (Enter) →
 *       "Sending…" (the fixture's COROS connection holds no credentials, so the push stays queued) → Take off watch,
 *       confirmed → nothing about the watch remains but Send to watch.
 *   (c) The switch on: Send → `POST /api/dev/watch-session` (today's sent session done on the watch) → Today offers
 *       "Log your session" → the sheet opens prefilled → Save → Today shows the session done; through the API: one
 *       activity for the slot, its one performed session the review, no watch copy.
 *
 * (b) follows the owner's decision of 2026-10-09: "Sending…" offers Take off watch (it asks first), which supersedes
 * the queued push.
 *
 * Run: `RG_E2E_WATCH=1 RG_API_PORT=… RG_WEB_PORT=… bash apps/web/e2e/fixture-stack.sh`, then
 * `RG_E2E_WATCH=1 RG_BASE=http://localhost:<web> pnpm --filter @rg/web exec playwright test watch` (both projects:
 * WebKit as the iPhone, Chromium at 1280). (a) runs against a stack started WITHOUT `RG_E2E_WATCH`. Each run of (c)
 * moves one of the fixture's future program slots to today and finishes it: start a fresh stack to run again.
 */

const WATCH = process.env.RG_E2E_WATCH === "1";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ context, baseURL }) => {
  // context.request sends no Origin header, which the /api/dev/* origin guard allows.
  expect((await context.request.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
});

interface Slot {
  id: string;
  today: string;
}

/** A program slot of today that is still to do: today's own, else a future one moved here. */
async function slotToDo(req: APIRequestContext, baseURL: string): Promise<Slot> {
  const today = (await (await req.get(`${baseURL}/api/plan/today`)).json()) as {
    today: string;
    todaySessions: Array<{ workout: { id: string; origin: string | null; contentState: string | null; completionState: string } }>;
  };
  const own = today.todaySessions.find(
    (s) => s.workout.origin === "program" && s.workout.contentState !== "done" && s.workout.completionState === "scheduled",
  );
  if (own) return { id: own.workout.id, today: today.today };
  const all = (await (await req.get(`${baseURL}/api/plan/workouts`)).json()) as {
    workouts: Array<{ id: string; origin: string | null; effectiveDate: string; completionState: string }>;
  };
  const next = all.workouts.find((w) => w.origin === "program" && w.effectiveDate > today.today && w.completionState === "scheduled");
  expect(next, "a future program slot to move to today").toBeTruthy();
  const moved = await req.post(`${baseURL}/api/plan/workouts/${next!.id}/move`, { data: { toDate: today.today, toTime: "23:30" } });
  expect(moved.ok(), await moved.text()).toBeTruthy();
  return { id: next!.id, today: today.today };
}

/** Open the slot's sheet; answer the pre-check when it asks; the build is shown. */
async function openSheet(page: Page, slot: Slot) {
  await page.goto(`/plan?workout=${encodeURIComponent(slot.id)}`);
  const radio = page.locator(".session-precheck [role=radio]").first();
  const built = page.locator(".session-blocks");
  await expect(radio.or(built)).toBeVisible({ timeout: 30_000 });
  if (await radio.isVisible()) {
    for (const scale of await page.locator(".session-precheck [role=radiogroup]").all()) await scale.locator("[role=radio]").nth(2).click();
    await page.getByRole("button", { name: "Build", exact: true }).click();
  }
  await expect(built).toBeVisible({ timeout: 30_000 });
}

/** Today, its card open: always open on a phone; on a wide screen it can start collapsed behind its pill. */
async function openToday(page: Page) {
  await page.goto("/");
  const pill = page.locator("button.dock-pill:visible");
  await pill.or(page.locator(".dock-panel:visible")).first().waitFor();
  if ((await pill.count()) > 0 && (await pill.getAttribute("aria-expanded")) === "false") await pill.click();
  await expect(page.locator(".dock-panel")).toBeVisible();
}

/** Send from the sheet: Send to watch → the preview → Send, by the keyboard (Send holds the focus). */
async function send(page: Page) {
  await page.getByRole("button", { name: "Send to watch" }).click();
  const steps = page.locator(".wstep");
  await expect(steps.first()).toBeVisible();
  expect(await steps.count()).toBeGreaterThan(0);
  const sendButton = page.getByRole("button", { name: "Send", exact: true });
  await expect(sendButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Sending…")).toBeVisible();
}

test("(a) the switch off: nothing about the watch on the sheet or Today", async ({ page, context, baseURL }) => {
  test.skip(WATCH, "needs the default stack (switch off)");
  const slot = await slotToDo(context.request, baseURL!);
  await openSheet(page, slot);
  await expect(page.getByRole("button", { name: "Send to watch" })).toHaveCount(0);
  await expect(page.locator(".watch-state")).toHaveCount(0);
  await openToday(page);
  await expect(page.locator(".today-on-watch")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Log your session" })).toHaveCount(0);
  // The watch routes are not there.
  expect((await context.request.get(`${baseURL}/api/sessions/${slot.id}/watch-preview`)).status()).toBe(404);
});

/**
 * Reload once no /api request is in flight: Send and Take off drain and then read the session, Today and Plan, and
 * WebKit reports a fetch a reload cuts off as a page error (the page-error guard then fails the test).
 */
function quietReload(page: Page): () => Promise<void> {
  let inflight = 0;
  const api = (r: { url(): string }) => new URL(r.url()).pathname.startsWith("/api/");
  page.on("request", (r) => void (api(r) && (inflight += 1)));
  for (const done of ["requestfinished", "requestfailed"] as const) page.on(done, (r) => void (api(r) && (inflight -= 1)));
  return async () => {
    await expect.poll(() => inflight, { timeout: 15_000 }).toBe(0);
    await page.reload();
  };
}

test("(b) Send to watch: the preview, Send, Sending… — and taken off, nothing about the watch remains", async ({ page, context, baseURL }) => {
  test.skip(!WATCH, "needs RG_E2E_WATCH=1 (the switch on)");
  const reload = quietReload(page);
  const slot = await slotToDo(context.request, baseURL!);
  await openSheet(page, slot);
  await send(page);
  // Still queued: the fixture's COROS connection holds no credentials, so the drain runs nothing.
  await reload();
  await expect(page.getByText("Sending…")).toBeVisible({ timeout: 30_000 });
  // Take off watch, from Sending… (owner, 2026-10-09): it asks first, then the queued push is superseded.
  await page.getByRole("button", { name: "Take off watch" }).click();
  const confirm = page.getByRole("dialog", { name: "Take this session off your watch?" });
  await confirm.getByRole("button", { name: "Take off watch" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send to watch" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Sending…")).toHaveCount(0);
  // Read again from the server: the same.
  await reload();
  await expect(page.getByRole("button", { name: "Send to watch" })).toBeVisible({ timeout: 30_000 });
  // Nothing about the watch shows — its status region waits, empty and visually hidden (audit 3-B UI-10).
  await expect(page.locator(".watch-state:not(.visually-hidden)")).toHaveCount(0);
});

test("(c) done on the watch: Log your session, prefilled, saved once — one activity, the review its session", async ({ page, context, baseURL }) => {
  test.skip(!WATCH, "needs RG_E2E_WATCH=1 (the switch on)");
  const req = context.request;
  const slot = await slotToDo(req, baseURL!);
  await openSheet(page, slot);
  await send(page);

  const done = await req.post(`${baseURL}/api/dev/watch-session`);
  expect(done.ok(), await done.text()).toBeTruthy();
  const { activityId } = (await done.json()) as { activityId: string };

  await openToday(page);
  const log = page.getByRole("button", { name: "Log your session" });
  await expect(log).toHaveCount(1);
  await log.click();
  const sheet = page.getByRole("dialog", { name: "Log your session" });
  await expect(sheet.locator(".review-move").first()).toBeVisible();
  // Prefilled from the watch's sets: the first move's line holds what the watch logged (8 reps at 25 lb).
  await expect(sheet.locator(".review-move-name small").first()).toContainText("25 lb × 8");
  await sheet.getByRole("button", { name: "Save" }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Log your session" })).toHaveCount(0, { timeout: 30_000 });

  // Through the API: one activity for the slot — the watch's — and its one performed session the review.
  const feed = (await (await req.get(`${baseURL}/api/activities?limit=60`)).json()) as {
    activities: Array<{ id: string; matched: { workoutId: string } | null; performed?: { source: string } | null }>;
  };
  const forSlot = feed.activities.filter((a) => a.matched?.workoutId === slot.id);
  expect(forSlot.map((a) => a.id)).toEqual([activityId]);
  expect(forSlot[0]!.performed?.source).toBe("watch_review");
  const today = (await (await req.get(`${baseURL}/api/plan/today`)).json()) as {
    watchReviews: unknown[];
    todaySessions: Array<{ workout: { id: string; contentState: string | null; completionState: string } }>;
  };
  expect(today.watchReviews).toEqual([]);
  expect(today.todaySessions.find((s) => s.workout.id === slot.id)?.workout).toMatchObject({ contentState: "done", completionState: "completed" });
});
