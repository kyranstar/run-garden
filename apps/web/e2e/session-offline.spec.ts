import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE SESSION JOURNEYS, ONLINE, OFFLINE, RELOADED AND REOPENED (Phase 2b plan Task 8; spec §2b; Review Focus 2).
 *
 *   (a) build → Start → play every step → review → Save, online: the slot is done, one activity matched to it.
 *   (b) the network off after Start → play → Save → Today says "saved, will sync" → the network on → exactly one
 *       performed session, activity and match.
 *   (c) a reload mid-session, offline → the same step.
 *   (d) the page closed mid-session and opened again → the same step.
 *   (e) Save offline, the page closed, opened again online → the outbox drains once.
 *
 * LOCAL ONLY, like offline-shell.spec.ts: it needs the PRODUCTION build (the service worker, the offline shell) served
 * on one origin by the fixture worker, so it skips itself unless `RG_E2E_BUILT=1`. To run it: `pnpm build:web`; then,
 * from `apps/worker` on Node 22, `wrangler dev --port <port> --persist-to <dir> --var FIXTURE_MODE:1
 * --var APP_URL:http://localhost:<port>` (its `[assets]` serve `apps/web/dist`), after `wrangler d1 migrations apply
 * run-garden-db --local --persist-to <dir>`; then `RG_E2E_BUILT=1 RG_BASE=http://localhost:<port> pnpm --filter
 * @rg/web exec playwright test session-offline --project desktop --workers 1` (one at a time: each journey seeds the
 * fixture again, which holds the worker for seconds). Chromium only (Playwright's WebKit cannot reload
 * offline through a service worker). Each journey seeds the fixture again and moves one of its program slots to
 * today, later than now.
 *
 * For CI it would need: a smoke job that builds the web app and serves `dist` from the fixture worker (one origin,
 * as here) instead of the Vite dev server, and a Chromium project; the iPhone half stays the owner's spike steps.
 */

test.skip(!process.env.RG_E2E_BUILT, "needs the built app with its service worker (RG_E2E_BUILT=1; see the header)");
test.skip(({ browserName }) => browserName !== "chromium", "offline through a service worker needs Chromium in Playwright");
test.setTimeout(180_000);

interface Slot {
  id: string;
}

/** A fresh fixture with a program slot today, later than now; the browser signed in, its service worker in control. */
async function freshSlot(page: Page, context: BrowserContext, baseURL: string): Promise<Slot> {
  const req = context.request;
  expect((await req.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
  expect((await req.post(`${baseURL}/api/dev/seed`, { timeout: 120_000 })).ok()).toBeTruthy();
  const today = (await (await req.get(`${baseURL}/api/plan/today`)).json()) as { today: string };
  const week = JSON.stringify(await (await req.get(`${baseURL}/api/plan/week`)).json());
  const ids = [...new Set([...week.matchAll(/"id":"(slot-[^"]+)"/g)].map((m) => m[1]!))];
  expect(ids.length).toBeGreaterThan(0);
  const id = ids[ids.length - 1]!;
  const moved = await req.post(`${baseURL}/api/plan/workouts/${id}/move`, { data: { toDate: today.today, toTime: "23:45" } });
  expect(moved.ok(), await moved.text()).toBeTruthy();

  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  // Old sessions of earlier journeys are not this one's.
  await page.evaluate(() => indexedDB.deleteDatabase("rg-offline"));
  return { id };
}

/** Open the slot's sheet, answer the pre-check if it asks, Start: the player opens. */
async function start(page: Page, slot: Slot) {
  await page.goto(`/plan?workout=${encodeURIComponent(slot.id)}`);
  const radio = page.locator(".session-precheck [role=radio]").first();
  const startButton = page.getByRole("button", { name: /^Start · \d+ min$/ });
  await expect(radio.or(startButton)).toBeVisible({ timeout: 30_000 });
  if (await radio.isVisible()) {
    await radio.click();
    await page.getByRole("button", { name: "Build", exact: true }).click();
  }
  await startButton.click();
  await expect(page).toHaveURL(new RegExp(`/session/${slot.id}`));
  await expect(page.locator(".player-count")).toContainText("1 of ");
}

const counter = (page: Page) => page.locator(".player-count");

/** "3 of 34" → 3. */
async function stepNumber(page: Page): Promise<number> {
  const t = (await counter(page).innerText()).match(/(\d+) of \d+/);
  return Number(t?.[1] ?? 0);
}

/** From lg the Today card is folded into its row: open it. */
async function openTodayCard(page: Page) {
  const row = page.locator('button.dock-pill[aria-expanded="false"]');
  if (await row.isVisible().catch(() => false)) await row.click();
  await expect(page.locator("#dock-panel")).toBeVisible();
}

/** One step on: Done + Confirm on a set, Skip on a hold or a rest, Next when a timer waits; the new move's how-to closed. */
async function oneStep(page: Page) {
  // The new move's how-to opens a moment after its step arrives.
  await page.waitForTimeout(150);
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  const done = page.getByRole("button", { name: "Done", exact: true });
  if (await done.isVisible()) {
    await done.click();
    await page.getByRole("button", { name: /^Confirm/ }).click();
    return;
  }
  const next = page.getByRole("button", { name: /^(Skip|Next)$/ });
  await next.click();
}

async function playTo(page: Page, step: number) {
  while ((await stepNumber(page)) < step) await oneStep(page);
}

async function playToReview(page: Page) {
  const save = page.getByRole("button", { name: "Save", exact: true });
  for (let i = 0; i < 200 && !(await save.isVisible()); i++) await oneStep(page);
  await expect(save).toBeVisible();
}

/** The session in progress on this device (IndexedDB `live`). */
async function performedId(page: Page, slot: Slot): Promise<string> {
  return page.evaluate(
    (id) =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open("rg-offline");
        open.onsuccess = () => {
          const get = open.result.transaction("live").objectStore("live").get(id);
          get.onsuccess = () => {
            open.result.close();
            resolve((get.result as { performedId: string }).performedId);
          };
          get.onerror = () => reject(get.error);
        };
        open.onerror = () => reject(open.error);
      }),
    slot.id,
  );
}

/** Exactly one activity matched to the slot, the app's own (its id the performed session's), with its sets. */
async function expectOneOfEverything(req: APIRequestContext, baseURL: string, slot: Slot, id: string) {
  const session = (await (await req.get(`${baseURL}/api/sessions/${slot.id}`)).json()) as { contentState: string };
  expect(session.contentState).toBe("done");
  const list = (await (await req.get(`${baseURL}/api/activities?limit=100`)).json()) as {
    activities: Array<{ id: string; matched: { workoutId: string } | null; logged: unknown }>;
  };
  const mine = list.activities.filter((a) => a.matched?.workoutId === slot.id);
  expect(mine.map((a) => a.id)).toEqual([id]);
  expect(list.activities.filter((a) => a.id === id)).toHaveLength(1);
}

test("(a) build, Start, play every step, review, Save — online", async ({ page, context, baseURL }) => {
  const slot = await freshSlot(page, context, baseURL!);
  await start(page, slot);
  const id = await performedId(page, slot);
  await playToReview(page);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expectOneOfEverything(context.request, baseURL!, slot, id);
});

test("(b) the network off after Start: played and saved offline, 'saved, will sync', then once when back online", async ({ page, context, baseURL }) => {
  const slot = await freshSlot(page, context, baseURL!);
  await start(page, slot);
  const id = await performedId(page, slot);
  await context.setOffline(true);
  await playToReview(page);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await openTodayCard(page);
  await expect(page.getByText(/will sync/).first()).toBeVisible({ timeout: 15_000 });
  await context.setOffline(false);
  await expect(page.getByText(/will sync/).first()).toHaveCount(0, { timeout: 30_000 });
  await expectOneOfEverything(context.request, baseURL!, slot, id);
});

test("(c) a reload mid-session, offline, comes back on the same step", async ({ page, context, baseURL }) => {
  const slot = await freshSlot(page, context, baseURL!);
  await start(page, slot);
  await playTo(page, 4);
  const at = await stepNumber(page);
  await context.setOffline(true);
  // The session is written on hide / leave (and 250 ms after each change).
  await page.waitForTimeout(400);
  await page.reload();
  await expect(counter(page)).toContainText(`${at} of `);
  await context.setOffline(false);
});

test("(d) the page closed mid-session and opened again comes back on the same step", async ({ page, context, baseURL }) => {
  const slot = await freshSlot(page, context, baseURL!);
  await start(page, slot);
  await playTo(page, 3);
  const at = await stepNumber(page);
  await page.waitForTimeout(400);
  await page.close();
  const again = await context.newPage();
  await again.goto(`/session/${slot.id}`);
  await expect(again.locator(".player-count")).toContainText(`${at} of `);
});

test("(e) saved offline, the page closed, opened again online: the outbox sends it once", async ({ page, context, baseURL }) => {
  const slot = await freshSlot(page, context, baseURL!);
  await start(page, slot);
  const id = await performedId(page, slot);
  await context.setOffline(true);
  await playToReview(page);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.close();
  await context.setOffline(false);
  const again = await context.newPage();
  await again.goto("/");
  await expect
    .poll(async () => ((await (await context.request.get(`${baseURL}/api/sessions/${slot.id}`)).json()) as { contentState: string }).contentState, {
      // At most a minute: a drain cut off by the closed page holds the outbox's lock until it runs out.
      timeout: 75_000,
    })
    .toBe("done");
  // A second app start drains nothing more.
  await again.reload();
  await again.waitForTimeout(1500);
  await expectOneOfEverything(context.request, baseURL!, slot, id);
});
