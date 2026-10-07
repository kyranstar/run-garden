import { test, expect } from "./fixtures.js";

/**
 * THE APP OPENS OFFLINE (Phase 2b plan Task 3; spike report docs/reports/2026-10-07-offline-spike.md; ruling 2b-R6).
 *
 * The service worker's `rg-me` route answers an offline launch for every account, a session in progress or not (R6);
 * what keeps that safe is forgetting — after Delete all data, Sign out or a 401 (a session that ended elsewhere, or
 * expired), an offline launch never opens the account (audit 2b-A scenarios B, C, D, E).
 *
 * LOCAL ONLY for now — CI's smoke job runs the Vite dev server, which registers no service worker, so this spec skips
 * itself unless `RG_E2E_BUILT=1`. It needs the PRODUCTION build served on one origin: build the web app
 * (`pnpm build:web`), then run the fixture worker from `apps/worker` (its `[assets]` serve `apps/web/dist`) with
 * `--var FIXTURE_MODE:1 --var APP_URL:http://localhost:<port>` on its own port and `--persist-to` directory, seed it
 * (`POST /api/dev/fixture-login`, `POST /api/dev/seed`), and run
 * `RG_E2E_BUILT=1 RG_BASE=http://localhost:<port> pnpm --filter @rg/web exec playwright test offline-shell`.
 *
 * Until the player route exists (Task 4) the reload lands on Today; Task 8 extends this to `/session/:workoutId`.
 */

test.skip(!process.env.RG_E2E_BUILT, "needs the built app with its service worker (RG_E2E_BUILT=1; see the header)");
// Playwright's WebKit cannot reload offline through a service worker ("WebKit encountered an internal error" on the
// offline reload); the phone is covered by the owner's iPhone steps in the spike report.
test.skip(({ browserName }) => browserName !== "chromium", "offline reload through a service worker needs Chromium in Playwright");

/** What Start leaves in IndexedDB (packages/ui/src/offline: database rg-offline, version 1, store `live`). */
async function putLiveSession(page: import("@playwright/test").Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("rg-offline", 1);
        open.onupgradeneeded = () => {
          for (const store of ["builds", "live", "outbox", "meta"]) open.result.createObjectStore(store);
        };
        open.onsuccess = () => {
          const tx = open.result.transaction("live", "readwrite");
          const now = Date.now();
          tx.objectStore("live").put(
            {
              workoutId: "e2e-slot",
              performedId: crypto.randomUUID(),
              buildId: "e2e-build",
              recorder: {},
              stepIndex: 3,
              timerAnchor: now,
              timerBankedMs: 0,
              paused: false,
              startedAt: now,
              updatedAt: now,
            },
            "e2e-slot",
          );
          tx.oncomplete = () => {
            open.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
      }),
  );
}

/** Signed in, the service worker in control, `me` and the garden cached by one controlled load. */
async function signedInUnderTheWorker(page: import("@playwright/test").Page, context: import("@playwright/test").BrowserContext, baseURL: string | undefined) {
  const login = await context.request.post(`${baseURL}/api/dev/fixture-login`);
  expect(login.ok()).toBeTruthy();
  await page.goto("/");
  // First visit installs the service worker; the reload is the first load it controls (and caches from).
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.getByRole("link", { name: "Plan" }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).sort())).toEqual(expect.arrayContaining(["rg-me", "rg-shell"]));
}

const cacheNames = (page: import("@playwright/test").Page) => page.evaluate(async () => (await caches.keys()).sort());

/** An offline launch: nothing of the account opens (no signed-in nav), whatever the screen says instead. */
async function offlineLaunchShowsNoAccount(page: import("@playwright/test").Page, context: import("@playwright/test").BrowserContext) {
  await context.setOffline(true);
  await page.goto("/");
  await expect(page.getByText(/Couldn't reach Run Garden|Sign in/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Plan" })).toHaveCount(0);
  await context.setOffline(false);
}

test("with a session in progress, a reload with the network off opens the signed-in app", async ({ page, context, baseURL }) => {
  await signedInUnderTheWorker(page, context, baseURL);
  await putLiveSession(page);

  await context.setOffline(true);
  await page.reload();

  await expect(page.getByRole("link", { name: "Plan" }).first()).toBeVisible();
  await expect(page.getByText("Couldn't reach Run Garden")).toHaveCount(0);
  await context.setOffline(false);
});

test("with nothing in progress, an offline reload opens the signed-in app too (ruling 2b-R6; scenario B)", async ({ page, context, baseURL }) => {
  await signedInUnderTheWorker(page, context, baseURL);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("link", { name: "Plan" }).first()).toBeVisible();
  await context.setOffline(false);
});

test("a session ended elsewhere: the online reload goes to sign-in and forgets, so the offline launch opens nothing (scenario C)", async ({ page, context, baseURL }) => {
  await signedInUnderTheWorker(page, context, baseURL);
  await putLiveSession(page);
  // Ended server-side (an expiry is the same): this device still holds the account's cached answers.
  expect((await context.request.post(`${baseURL}/api/auth/logout`)).ok()).toBeTruthy();
  await page.reload();
  await expect(page).toHaveURL(/\/welcome/);
  await expect.poll(() => cacheNames(page)).not.toContain("rg-me");
  expect(await cacheNames(page)).not.toContain("rg-read-cache");
  await offlineLaunchShowsNoAccount(page, context);
});

test("a 401 that reaches the service worker after its 3 s timeout still purges the cached answers (audit 2b-A M-2; scenario F2)", async ({ page, context, baseURL }) => {
  await signedInUnderTheWorker(page, context, baseURL);
  expect((await context.request.post(`${baseURL}/api/auth/logout`)).ok()).toBeTruthy();
  // A slow network: the worker answers the page from its cache at 3 s; the server's 401 lands after that.
  await context.route("**/api/auth/me", async (route) => {
    await new Promise((r) => setTimeout(r, 4500));
    await route.continue();
  });
  await page.reload();
  await expect(page.getByRole("link", { name: "Plan" }).first()).toBeVisible();
  await expect.poll(() => cacheNames(page), { timeout: 15_000 }).not.toContain("rg-me");
  expect(await cacheNames(page)).not.toContain("rg-read-cache");
  await context.unroute("**/api/auth/me");
  await offlineLaunchShowsNoAccount(page, context);
});

test("Delete all data: nothing of the account opens offline afterwards (audit 2b-A I-1; scenario E)", async ({ page, context, baseURL }) => {
  await signedInUnderTheWorker(page, context, baseURL);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Delete all data" }).click();
  await page.getByRole("button", { name: "Really delete everything — cannot be undone" }).click();
  await expect(page).toHaveURL(/\/welcome/);
  expect(await cacheNames(page)).not.toContain("rg-me");
  expect(await cacheNames(page)).not.toContain("rg-read-cache");
  await offlineLaunchShowsNoAccount(page, context);
});
