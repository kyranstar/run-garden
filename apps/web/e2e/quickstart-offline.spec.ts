import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * R11 (J02): A QUICK START PLAYED OFFLINE, SAVED ONCE BACK ONLINE. The athlete opens the Studio with no network (on a
 * plane, in a basement gym), starts the desk reset, answers today's jaw check, plays it, saves it — Today says it will
 * sync — and when the network comes back the outbox records it: exactly one workout (started at once, so booked on no
 * calendar: `app_only_offline`), one performed session, and its before-reading as one `pre` check at its own day. Days
 * into an offline week (the day's reads gone, the Studio's week-long ones kept: R11 fix round 1) the jaw release still
 * starts on the real profiles; with those gone too it needs a connection.
 *
 * LOCAL ONLY, like session-offline.spec.ts: it needs the PRODUCTION build (the service worker, the offline shell) with
 * the Studio on, served on one origin by the fixture worker, so it skips itself unless `RG_E2E_BUILT=1`. To run it:
 * `VITE_STUDIO=1 pnpm --filter @rg/web build`; then, from `apps/worker` on Node 22, `wrangler d1 migrations apply
 * run-garden-db --local --persist-to <dir>` and `wrangler dev --port <port> --persist-to <dir> --var FIXTURE_MODE:1
 * --var APP_URL:http://localhost:<port>` (its `[assets]` serve `apps/web/dist`); then `RG_E2E_BUILT=1
 * RG_BASE=http://localhost:<port> pnpm --filter @rg/web exec playwright test quickstart-offline --project desktop
 * --workers 1`. Chromium only (Playwright's WebKit cannot load offline through a service worker). The journey seeds
 * the fixture again (which removes the account's checks), so today's check is unanswered when it starts.
 */

test.skip(!process.env.RG_E2E_BUILT, "needs the built app with its service worker (RG_E2E_BUILT=1; see the header)");
test.skip(({ browserName }) => browserName !== "chromium", "offline through a service worker needs Chromium in Playwright");
test.setTimeout(240_000);

/** A fresh fixture; the browser signed in, its service worker in control, nothing of an earlier journey on the device. */
async function underTheWorker(page: Page, context: BrowserContext, baseURL: string): Promise<void> {
  const req = context.request;
  expect((await req.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
  expect((await req.post(`${baseURL}/api/dev/seed`, { timeout: 120_000 })).ok()).toBeTruthy();
  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await page.evaluate(() => indexedDB.deleteDatabase("rg-offline"));
}

/** From lg the Today card is folded into its row: open it. */
async function openTodayCard(page: Page) {
  const row = page.locator('button.dock-pill[aria-expanded="false"]');
  if (await row.isVisible().catch(() => false)) await row.click();
  await expect(page.locator("#dock-panel")).toBeVisible();
}

/** One step on: Done + Confirm on a set, Skip on a hold or a rest, Next when a timer waits; the new move's how-to closed. */
async function oneStep(page: Page) {
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
  await page.getByRole("button", { name: /^(Skip|Next)$/ }).click();
}

async function playToReview(page: Page) {
  const save = page.getByRole("button", { name: "Save", exact: true });
  for (let i = 0; i < 200 && !(await save.isVisible()); i++) await oneStep(page);
  await expect(save).toBeVisible();
}

/** Every row of one of the account's tables, as its export pages them (the fixture account: synthetic data only). */
async function tableRows(req: APIRequestContext, baseURL: string, name: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const res = await req.get(`${baseURL}/api/settings/export/table/${name}${after ? `?after=${encodeURIComponent(after)}` : ""}`);
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = (await res.json()) as { rows: Array<Record<string, unknown>>; nextCursor: string | null };
    rows.push(...body.rows);
    if (!body.nextCursor) return rows;
    after = body.nextCursor;
  }
  throw new Error(`${name}: more pages than expected`);
}

/** What the device still holds in one store of its offline database. */
const stored = (page: Page, store: string) =>
  page.evaluate(
    (name) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open("rg-offline");
        open.onsuccess = () => {
          const count = open.result.transaction(name).objectStore(name).count();
          count.onsuccess = () => {
            open.result.close();
            resolve(count.result);
          };
          count.onerror = () => reject(count.error);
        };
        open.onerror = () => reject(open.error);
      }),
    store,
  );

test("a quick start played offline is saved once back online: one workout, one session, its before-reading, no calendar", async ({ page, context, baseURL }) => {
  await underTheWorker(page, context, baseURL!);
  const req = context.request;
  const today = ((await (await req.get(`${baseURL}/api/plan/today`)).json()) as { today: string }).today;

  // One visit with the network on: what the builder reads lands in the read cache.
  await page.goto("/studio/build/quick/desk_reset");
  await expect(page.getByRole("button", { name: "Start now" })).toBeVisible({ timeout: 30_000 });
  const title = await page.locator(".stu-build-title").inputValue();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const paths: string[] = [];
        for (const name of ["rg-read-cache", "rg-studio-cache"]) paths.push(...(await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname));
        return paths;
      }),
    )
    .toEqual(expect.arrayContaining(["/api/library", "/api/profile", "/api/places", "/api/plan/today"]));

  await context.setOffline(true);
  // A cold start with no network: the shell and the reads from the service worker, the quick start built on the device.
  await page.goto("/studio/build/quick/desk_reset");
  await page.getByRole("button", { name: "Start now" }).click();
  // Today's jaw check, offered as online: answered here, it travels inside the session's save.
  const check = page.getByRole("dialog");
  await expect(check.getByRole("radiogroup")).toBeVisible({ timeout: 15_000 });
  await check.getByRole("radio").nth(2).click();
  await check.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/session\/local%3A/, { timeout: 15_000 });
  await expect(page.locator(".player-count")).toContainText("1 of ");

  await playToReview(page);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await openTodayCard(page);
  await expect(page.getByText(/saved, will sync/).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();

  // Back online, the app opened again: an app start drains the outbox. (Not the `online` event: a page Playwright loaded
  // with the network held off reads `navigator.onLine` true throughout, so it never hears the network come back.)
  await context.setOffline(false);
  await page.reload();
  await openTodayCard(page);
  await expect(page.getByText(/saved, will sync/)).toHaveCount(0, { timeout: 30_000 });

  // Exactly one workout for it, done, started at once and played offline — on no calendar.
  const plan = (await (await req.get(`${baseURL}/api/plan/workouts?start=${today}&end=${today}`)).json()) as {
    workouts: Array<{ id: string; title: string; contentState?: string | null; calendarSyncState: string }>;
  };
  const made = plan.workouts.filter((w) => w.title === title);
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ contentState: "done", calendarSyncState: "app_only_offline" });
  // One performed session, matched to it.
  const list = (await (await req.get(`${baseURL}/api/activities?limit=100`)).json()) as { activities: Array<{ id: string; matched: { workoutId: string } | null }> };
  expect(list.activities.filter((a) => a.matched?.workoutId === made[0]!.id)).toHaveLength(1);
  // One reading today — the session's own before-reading, as answered — and no check-in of its own.
  const checks = (await tableRows(req, baseURL!, "condition_checks")).filter((r) => (r.localDate ?? r.local_date) === today);
  expect(checks).toHaveLength(1);
  expect(checks[0]).toMatchObject({ kind: "pre", profileId: "tmj", value: 2 });
  // Nothing left waiting on the device.
  expect(await stored(page, "outbox")).toBe(0);
  expect(await stored(page, "starts")).toBe(0);
});

test("the network cut with the builder open: started, played and saved offline, check skipped — sent when the network comes back", async ({ page, context, baseURL }) => {
  await underTheWorker(page, context, baseURL!);
  const req = context.request;
  const today = ((await (await req.get(`${baseURL}/api/plan/today`)).json()) as { today: string }).today;
  await page.goto("/studio/build/quick/hip_opener");
  await expect(page.getByRole("button", { name: "Start now" })).toBeVisible({ timeout: 30_000 });
  const title = await page.locator(".stu-build-title").inputValue();

  await context.setOffline(true);
  await page.getByRole("button", { name: "Start now" }).click();
  const check = page.getByRole("dialog");
  await expect(check.getByRole("radiogroup")).toBeVisible({ timeout: 15_000 });
  await check.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page).toHaveURL(/\/session\/local%3A/, { timeout: 15_000 });
  await playToReview(page);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await openTodayCard(page);
  await expect(page.getByText(/saved, will sync/).first()).toBeVisible({ timeout: 15_000 });

  // The page heard the network go, so it hears it come back: the outbox sends at once.
  await context.setOffline(false);
  await expect(page.getByText(/saved, will sync/)).toHaveCount(0, { timeout: 30_000 });
  const plan = (await (await req.get(`${baseURL}/api/plan/workouts?start=${today}&end=${today}`)).json()) as {
    workouts: Array<{ id: string; title: string; contentState?: string | null; calendarSyncState: string }>;
  };
  const made = plan.workouts.filter((w) => w.title === title);
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ contentState: "done", calendarSyncState: "app_only_offline" });
  // Skipped: no reading at all.
  expect((await tableRows(req, baseURL!, "condition_checks")).filter((r) => r.localDate === today)).toEqual([]);
});

test("days into the offline week: the jaw release still starts on the real profiles; with those gone too, it needs a connection", async ({ page, context, baseURL }) => {
  await underTheWorker(page, context, baseURL!);
  await page.goto("/studio/build/quick/condition_care");
  await expect(page.getByRole("button", { name: "Start now" })).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => page.evaluate(async () => (await (await caches.open("rg-studio-cache")).keys()).map((r) => new URL(r.url).pathname)))
    .toEqual(expect.arrayContaining(["/api/library", "/api/profile"]));

  // A few days on: the day's reads (Today, the settings) are gone from the device; the Studio's week-long ones are not.
  await page.evaluate(() => caches.delete("rg-read-cache"));
  await context.setOffline(true);
  await page.goto("/studio/build/quick/condition_care");
  await page.getByRole("button", { name: "Start now" }).click();
  // Today unknown: its check is offered (the day judged unanswered until then).
  const check = page.getByRole("dialog");
  await expect(check.getByRole("radiogroup")).toBeVisible({ timeout: 15_000 });
  await check.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page).toHaveURL(/\/session\/local%3A/, { timeout: 15_000 });
  await expect(page.locator(".player-count")).toContainText("1 of ");

  // Past the week, or never kept: the profiles unknown — it needs a connection, never judged by no profile's rules.
  await page.evaluate(() => caches.delete("rg-studio-cache"));
  await page.goto("/studio/build/quick/desk_reset");
  await page.getByRole("button", { name: "Start now" }).click();
  await expect(page.getByText("Starting needs a connection — try again once you're online.")).toBeVisible({ timeout: 15_000 });
  await context.setOffline(false);
});
