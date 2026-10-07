import { test, expect } from "./fixtures.js";

/**
 * THE APP OPENS OFFLINE WHEN A SESSION IS IN PROGRESS (Phase 2b plan Task 3; spike report
 * docs/reports/2026-10-07-offline-spike.md).
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

test("with a session in progress, a reload with the network off opens the signed-in app", async ({ page, context, baseURL }) => {
  const login = await context.request.post(`${baseURL}/api/dev/fixture-login`);
  expect(login.ok()).toBeTruthy();

  await page.goto("/");
  // First visit installs the service worker; the reload is the first load it controls (and caches from).
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await expect(page.getByRole("link", { name: "Plan" }).first()).toBeVisible();
  await putLiveSession(page);

  await context.setOffline(true);
  await page.reload();

  await expect(page.getByRole("link", { name: "Plan" }).first()).toBeVisible();
  await expect(page.getByText("Couldn't reach Run Garden")).toHaveCount(0);
  await context.setOffline(false);
});
