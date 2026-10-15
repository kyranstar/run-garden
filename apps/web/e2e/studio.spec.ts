import type { BrowserContext, Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures.js";

/**
 * THE STUDIO, END TO END (Stage 2 spec §14; plan Task 9), on both projects:
 *
 *   (a) search → a move's detail → Add → the builder → Schedule → the workout is on the Plan;
 *   (b) a quick start → Start now → the player opens;
 *   (c) a template saved from the builder, then reused: the templates list's Start plays it, and the list then says it
 *       was used today;
 *   (d) offline after one visit: search, a move's detail and a quick start still work with the network off.
 *
 * Needs the fixture stack, whose dev build has the Studio on (`features.studio`): `bash apps/web/e2e/fixture-stack.sh`,
 * then `RG_BASE=http://localhost:5271 pnpm --filter @rg/web e2e studio`. The two projects share the fixture account, so
 * what a journey makes is named for its project and its moment, and a template it saves is deleted again.
 *
 * (e) The cold start offline needs the service worker, so the PRODUCTION build: it skips itself unless
 * `RG_E2E_BUILT=1`, and runs in Chromium only (Playwright's WebKit cannot load offline through a service worker). Build
 * with the Studio on (`VITE_STUDIO=1 pnpm --filter @rg/web build`), serve `apps/web/dist` from the fixture worker on one
 * origin (from `apps/worker` on Node 22: `wrangler d1 migrations apply run-garden-db --local --persist-to <dir>`, then
 * `wrangler dev --port <port> --persist-to <dir> --var FIXTURE_MODE:1 --var APP_URL:http://localhost:<port>`), seed it
 * (`POST /api/dev/fixture-login`, `POST /api/dev/seed`) and run `RG_E2E_BUILT=1 RG_BASE=http://localhost:<port> pnpm
 * --filter @rg/web exec playwright test studio --project desktop`.
 */

/** A name no other run or project has made. */
const unique = (what: string, info: TestInfo) =>
  `${what} ${info.project.name} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** The ISO week's Monday of a day, as the Plan's `?week=` takes it. */
function mondayOf(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Type into the Studio's field; the list follows at once, the address once typing pauses. A journey taps a move at once,
 * inside that pause, as a quick reader does — the move must stay open when the late write lands (fix round 1).
 */
async function search(page: Page, text: string) {
  await page.getByRole("searchbox", { name: "Search moves" }).fill(text);
}

/** A move's detail: a sheet over the list on a phone, the pane beside it from md. */
const detailOf = (page: Page, name: string): Locator =>
  page.getByRole("dialog", { name }).or(page.getByRole("complementary", { name }));

/**
 * Start now (or the templates list's Start) → the player. On the way, the builder may first offer today's before
 * reading (skipped here), show a swap the day's check made, or — when the same quick start or template was already
 * started today (the other project shares the fixture account) — offer to continue that one. Each is accepted, at
 * most three times, then the player opens.
 */
async function intoThePlayer(page: Page) {
  const goOn = page
    .getByRole("button", { name: /^(Start with these changes|Start anyway|Continue it)$/ })
    .or(page.getByRole("dialog").getByRole("button", { name: "Skip", exact: true }));
  for (let i = 0; i < 3 && !/\/session\//.test(page.url()); i++) {
    await Promise.race([page.waitForURL(/\/session\//, { timeout: 30_000 }), goOn.first().waitFor({ timeout: 30_000 })]);
    if (!/\/session\//.test(page.url())) await goOn.first().click();
  }
  await expect(page).toHaveURL(/\/session\/[^/?#]+/);
}

/**
 * Sign the context in (`context.request` sends no Origin header, which the /api/dev/* origin guard allows). Once more on
 * a reset socket: through the dev server's proxy a kept-alive socket can be one the proxy has already closed.
 */
async function signIn(context: BrowserContext, baseURL: string | undefined) {
  for (let attempt = 1; ; attempt++) {
    try {
      expect((await context.request.post(`${baseURL}/api/dev/fixture-login`)).ok()).toBeTruthy();
      return;
    } catch (e) {
      if (attempt >= 3 || !/ECONNRESET|socket hang up/.test(String(e))) throw e;
    }
  }
}

/**
 * The app's own API, asked from the page as the app asks it (its cookie, its origin) — here only to clean up. Not
 * `context.request`: through the dev server's proxy its kept-alive socket can be one the proxy has already closed.
 */
async function fromThePage<T>(page: Page, method: "GET" | "DELETE", path: string): Promise<{ status: number; body: T }> {
  return page.evaluate(
    async ({ method, path }) => {
      const res = await fetch(path, { method, credentials: "include" });
      return { status: res.status, body: (await res.json().catch(() => null)) as T };
    },
    { method, path },
  );
}

test.describe("on the fixture stack", () => {
  // Whole journeys (search → detail → Add → builder → Schedule → Plan) cross half a dozen screens; on a shared CI runner
  // the default 30 s ran out on the last navigation of an otherwise green run. Three times the budget, not a retry.
  test.slow();
  test.beforeEach(async ({ page, context, baseURL }) => {
    await signIn(context, baseURL);
    // Mid-morning: "Later today" and today's check stay off the day's edges.
    const now = new Date();
    now.setHours(10, 0, 0, 0);
    await page.clock.install({ time: now });
  });

  test("search → a move's detail → Add → the builder → Schedule: it is on the Plan", async ({ page }, info) => {
    const title = unique("Squat day", info);
    await page.goto("/studio");
    await search(page, "goblet squat");
    await page.getByRole("link", { name: "Goblet squat", exact: true }).click();
    const detail = detailOf(page, "Goblet squat");
    await expect(detail.getByRole("heading", { name: "How" })).toBeVisible();

    await detail.getByRole("button", { name: "Add", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Add Goblet squat" });
    await sheet.getByRole("radio", { name: "To a new workout" }).check();
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: "Added to Main in “New workout”." })).toBeVisible();
    await page.getByRole("link", { name: "Open", exact: true }).click();

    // The builder, on the workout being built on this device, the move in its main part.
    await expect(page).toHaveURL(/\/studio\/build\/new$/);
    await expect(page.getByRole("region", { name: /^Main/ }).getByRole("button", { name: /^Goblet squat/ })).toBeVisible();
    const name = page.getByRole("textbox", { name: "Title" });
    await name.fill(title);
    await name.press("Tab");
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

    await page.getByRole("button", { name: "Schedule…" }).click();
    const when = page.getByRole("dialog", { name: "Schedule" });
    await when.getByRole("radio", { name: "Another day" }).check();
    const day = await when.getByLabel("Day", { exact: true }).inputValue();
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const made = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/workouts" && r.request().method() === "POST");
    await when.getByRole("button", { name: "Schedule", exact: true }).click();
    expect((await made).status()).toBe(201);
    // Scheduled, the builder is on that planned workout.
    await expect(page).toHaveURL(/\/studio\/build\/workout\/[^/?#]+$/);
    await expect(when).toHaveCount(0);

    // On the Plan, in its week, and it opens as a session of the plan.
    await page.goto(`/plan?week=${mondayOf(day)}`);
    const card = page.getByText(title, { exact: true });
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.getByRole("dialog").filter({ hasText: title })).toBeVisible();
  });

  test("a quick start → Start now → the player opens", async ({ page }) => {
    await page.goto("/studio");
    await page.getByRole("link", { name: /^Desk reset/ }).click();
    await expect(page).toHaveURL(/\/studio\/build\/quick\/desk_reset$/);
    // Built on the device at once, nothing to fill in.
    await expect(page.getByRole("heading", { level: 1, name: "Desk reset" })).toBeVisible();
    await expect(page.getByRole("region", { name: /^Warm-up/ }).getByRole("listitem").first()).toBeVisible();

    await page.getByRole("button", { name: "Start now" }).click();
    await intoThePlayer(page);
    await expect(page.getByRole("banner")).toContainText(/Desk reset · 1 of \d+/);
  });

  test("a template saved from the builder, then reused: Start plays it, and the workout made is the template's", async ({ page }, info) => {
    const name = unique("Hips", info);
    let templateId: string | null = null;
    try {
      await page.goto("/studio/build/quick/hip_opener");
      await expect(page.getByRole("heading", { level: 1, name: "Hip opener" })).toBeVisible();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("menuitem", { name: "Save as template…" }).click();
      const naming = page.getByRole("dialog", { name: "Save as template" });
      await naming.getByRole("textbox", { name: "Name" }).fill(name);
      const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/templates" && r.request().method() === "POST");
      await naming.getByRole("button", { name: "Save", exact: true }).click();
      const answer = await saved;
      expect(answer.status()).toBe(201);
      templateId = ((await answer.json()) as { template: { id: string } }).template.id;
      await expect(naming).toHaveCount(0);

      // Reused: from the Studio's home to the templates, where it is listed, and its Start plays it.
      await page.getByRole("link", { name: "Studio", exact: true }).first().click();
      await page.getByRole("link", { name: /^Templates/ }).click();
      await expect(page).toHaveURL(/\/studio\/templates$/);
      const row = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name }) });
      await expect(row).toContainText("Not used yet");
      await row.getByRole("button", { name: "Start" }).click();
      await intoThePlayer(page);
      await expect(page.getByRole("banner")).toContainText(/Hip opener · 1 of \d+/);

      // Back on the templates, it says what a person would look for: it was used, today.
      await page.goto("/studio/templates");
      await expect(row).toContainText("Used today");
    } finally {
      // The two projects share the account: a template a run saved goes again.
      if (templateId) expect((await fromThePage(page, "DELETE", `/api/templates/${encodeURIComponent(templateId)}`)).status).toBe(200);
    }
  });

  test("offline after one visit: search, a move's detail and a quick start still work", async ({ page, context }) => {
    // One visit with the network on: the athlete's side of the library, today and the places' gear are read.
    const reads = ["/api/library", "/api/plan/today", "/api/places"].map((path) =>
      page.waitForResponse((r) => new URL(r.url()).pathname === path && r.ok()),
    );
    await page.goto("/studio");
    await Promise.all(reads);
    await expect(page.getByRole("link", { name: /^Hip opener/ })).toBeVisible();

    await context.setOffline(true);
    try {
      // The moves are in the bundle: the list and a move's detail need nothing from the network.
      await search(page, "glute bridge");
      await page.getByRole("link", { name: "Glute bridge", exact: true }).click();
      const detail = detailOf(page, "Glute bridge");
      await expect(detail.getByRole("heading", { name: "How" })).toBeVisible();
      await expect(detail.getByRole("link", { name: "Single-leg glute bridge" })).toBeVisible();
      await detail.getByRole("button", { name: "Close" }).click();
      await expect(detail).toHaveCount(0);
      await page.getByRole("button", { name: "Clear search" }).click();

      // A quick start is built on the device, at once, from what the visit read.
      await page.getByRole("link", { name: /^Hip opener/ }).click();
      await expect(page.getByRole("heading", { level: 1, name: "Hip opener" })).toBeVisible({ timeout: 2_000 });
      await expect(page.getByRole("region", { name: /^Warm-up/ }).getByRole("listitem").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Start now" })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});

test.describe("under the service worker (the built app)", () => {
  test.skip(!process.env.RG_E2E_BUILT, "needs the built app with its service worker (RG_E2E_BUILT=1; see the header)");
  test.skip(({ browserName }) => browserName !== "chromium", "offline through a service worker needs Chromium in Playwright");

  /** Signed in, the service worker in control. */
  async function underTheWorker(page: Page, context: BrowserContext, baseURL: string | undefined) {
    await signIn(context, baseURL);
    await page.goto("/");
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
    await page.reload();
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  }

  /** The paths the read cache holds. */
  const cachedPaths = (page: Page) =>
    page.evaluate(async () => {
      const cache = await caches.open("rg-read-cache");
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });

  test("a cold start offline: the Studio's reads come from the cache — search, a move, a quick start at once, the templates", async ({ page, context, baseURL }) => {
    await underTheWorker(page, context, baseURL);
    // One visit online: the Studio's reads land in the read cache.
    await page.goto("/studio");
    await expect(page.getByRole("link", { name: /^Templates \(\d+\)$/ })).toBeVisible();
    await expect.poll(() => cachedPaths(page)).toEqual(expect.arrayContaining(["/api/library", "/api/places", "/api/templates", "/api/plan/today"]));
    const templatesLink = await page.getByRole("link", { name: /^Templates \(\d+\)$/ }).innerText();

    await context.setOffline(true);
    try {
      // A cold start: the page gone, then opened again with no network.
      const fromCache: string[] = [];
      page.on("response", (r) => {
        const path = new URL(r.url()).pathname;
        if (["/api/library", "/api/places", "/api/templates"].includes(path) && r.ok() && r.fromServiceWorker()) fromCache.push(path);
      });
      await page.goto("/studio");
      await expect(page.getByRole("heading", { level: 1, name: "Studio" })).toBeVisible();
      // The templates as the visit knew them (the home's count), read from the cache.
      await expect(page.getByRole("link", { name: /^Templates \(\d+\)$/ })).toHaveText(templatesLink);

      await search(page, "glute bridge");
      await page.getByRole("link", { name: "Glute bridge", exact: true }).click();
      await expect(detailOf(page, "Glute bridge").getByRole("heading", { name: "How" })).toBeVisible();

      // A quick start opened cold, offline: built from the cached reads rather than after they fail through retries.
      await page.goto("/studio/build/quick/hip_opener");
      await expect(page.getByRole("heading", { level: 1, name: "Hip opener" })).toBeVisible({ timeout: 2_500 });
      await expect(page.getByRole("button", { name: "Start now" })).toBeVisible();
      expect([...new Set(fromCache)].sort()).toEqual(["/api/library", "/api/places", "/api/templates"]);
    } finally {
      await context.setOffline(false);
    }
  });
});
