/**
 * The new shape (stream B) verification shots: the nav, Today's one card and its garden drawer, the coach opened from
 * the nav, Plan's week and "Your plans", a plan's sheet and its action's coach with the words written, Settings in its
 * five groups — on a phone (390×844) and a desktop (1440×900), light and dark. FAILS LOUDLY on any horizontal overflow
 * on the phone, and when Today's card title or its first action is not on the phone's first screen (no banners: the
 * account's own zone, the fixture's "Fixture mode" line hidden).
 * The integrated review's fix round adds: Today on a phone WITH its banners (a device clock in another zone, the
 * calendar paused), a workout sheet's own Ask, a plan's Extend sent to the thread coach (its POST answered here, never
 * a model), and the coach's ● on the nav (a run started on the scripted model, last). Needs the fixture stack (the
 * coach on).
 *
 *   RG_BASE=http://localhost:5282 node apps/web/scripts/shape-shots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.RG_SHOTS_OUT ?? join(here, "..", "..", "..", "screenshots", "new-shape", "B");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.RG_BASE ?? "http://localhost:5282";

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844, mobile: true },
  { name: "1440x900", width: 1440, height: 900, mobile: false },
];

async function assertNoOverflow(page, label) {
  const { scrollW, innerW } = await page.evaluate(() => ({ scrollW: document.scrollingElement.scrollWidth, innerW: window.innerWidth }));
  if (scrollW > innerW + 1) throw new Error(`HORIZONTAL OVERFLOW at ${label}: scrollWidth ${scrollW} > innerWidth ${innerW}`);
}

/** Today's card title and its first action sit above the phone's bar, on the first screen. */
async function aboveFold(page) {
  return page.evaluate(() => {
    const bar = document.querySelector("nav.bottom-nav")?.getBoundingClientRect().top ?? window.innerHeight;
    const title = document.querySelector("#dock-panel .today-title")?.getBoundingClientRect() ?? null;
    const action = document.querySelector("#dock-panel .today-actions a, #dock-panel .today-actions button")?.getBoundingClientRect() ?? null;
    return { bar, title: title?.bottom ?? null, action: action?.bottom ?? null };
  });
}

async function assertAboveFold(page, label) {
  const m = await aboveFold(page);
  console.log(`above the fold @ ${label}: ${JSON.stringify(m)}`);
  if (m.title === null || m.title > m.bar) throw new Error(`CARD TITLE BELOW THE FOLD at ${label}: ${JSON.stringify(m)}`);
  if (m.action === null || m.action > m.bar) throw new Error(`CARD ACTION BELOW THE FOLD at ${label}: ${JSON.stringify(m)}`);
}

async function shoot(page, vp, scheme, name, fullPage = false) {
  await page.waitForTimeout(600);
  if (vp.mobile) await assertNoOverflow(page, `${name} @ ${vp.name} ${scheme}`);
  const path = join(OUT, `${name}__${vp.name}__${scheme}.png`);
  await page.screenshot({ path, fullPage });
  console.log(path);
}

async function run() {
  const browser = await chromium.launch();
  try {
    // The account's zone: every context's clock is in it (no time zone prompt) unless a shot asks for the prompt.
    const probe = await browser.newContext();
    await probe.request.post(`${BASE}/api/dev/fixture-login`);
    const zone = (await (await probe.request.get(`${BASE}/api/settings`)).json()).prefs.timezone;
    await probe.close();

    // Today on a phone with NO banners, then with ONE (the calendar line — production usually shows one: it or the
    // watch-version line): the card's title and its first action on the first screen, above the bar — or it fails. The
    // fixture's own "Fixture mode" line is hidden (production has none), and its sync is read as in order (the fixture
    // keeps failed writes from the e2e runs: their line is a banner of its own).
    for (const [name, calendarConnected] of [["1a-today-no-banners", true], ["1d-today-one-banner", false]]) {
      for (const scheme of ["light", "dark"]) {
        const vp = VIEWPORTS[0];
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, deviceScaleFactor: 2, timezoneId: zone });
        await context.request.post(`${BASE}/api/dev/fixture-login`);
        const page = await context.newPage();
        await page.route((url) => url.pathname === "/api/plan/today", async (r) => {
          const res = await r.fetch();
          const body = await res.json();
          body.sync = { ...body.sync, calendarConnected };
          await r.fulfill({ response: res, json: body });
        });
        await page.route((url) => url.pathname === "/api/sync/status", async (r) => {
          const res = await r.fetch();
          const body = await res.json();
          const cloud = body.cloud ? { ...body.cloud, error: null } : body.cloud;
          await r.fulfill({ response: res, json: { ...body, state: "in_sync", pendingCount: 0, issueCount: 0, contentStaleCount: 0, cloud } });
        });
        await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
        await page.locator("#dock-panel").waitFor();
        await page.addStyleTag({ content: ".shell-main > .banner { display: none !important; }" });
        const banners = await page.locator(".garden-plumbing .banner, .garden-plumbing [role='status']").count();
        console.log(`${name} @ ${vp.name} ${scheme}: ${banners} plumbing line(s)`);
        await shoot(page, vp, scheme, name);
        await assertAboveFold(page, `${name} @ ${vp.name} ${scheme}`);
        await context.close();
      }
    }

    for (const scheme of ["light", "dark"]) {
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, deviceScaleFactor: 2, timezoneId: zone });
        const login = await context.request.post(`${BASE}/api/dev/fixture-login`);
        if (!login.ok()) throw new Error(`fixture-login failed: ${login.status()}`);
        const page = await context.newPage();

        // Today: the scene, the one card, the handle — the whole page.
        await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
        await page.locator("#dock-panel").waitFor();
        if (vp.mobile) console.log(`above the fold with the fixture's line @ ${vp.name} ${scheme}: ${JSON.stringify(await aboveFold(page))}`);
        await shoot(page, vp, scheme, "1-today");
        await shoot(page, vp, scheme, "1b-today-full", true);

        // The garden drawer.
        await page.getByRole("button", { name: "Your garden" }).click();
        await page.getByRole("dialog", { name: "Your garden" }).waitFor();
        await shoot(page, vp, scheme, "2-garden-drawer");
        await page.keyboard.press("Escape");

        // The coach, from the nav's button.
        const nav = page.locator(vp.mobile ? "nav.bottom-nav" : "nav.side-nav");
        await nav.getByRole("button", { name: "Coach" }).click();
        await page.getByRole("dialog", { name: "Coach" }).waitFor();
        await shoot(page, vp, scheme, "3-coach-from-nav");
        await page.keyboard.press("Escape");

        // The card's action opens its workout's sheet, which keeps its own Ask (the nav is out of reach).
        await page.locator("#dock-panel .today-actions").getByRole("link", { name: /^(Start|View workout|Open)$/ }).first().click();
        await page.getByRole("dialog").first().waitFor();
        await page.getByRole("dialog").first().getByRole("button", { name: /^Ask the coach about/ }).waitFor();
        await shoot(page, vp, scheme, "3b-workout-sheet-ask");
        await page.keyboard.press("Escape");

        // Plan: the week first, then the list.
        await page.goto(`${BASE}/plan`, { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "This week" }).waitFor({ timeout: 30_000 });
        await shoot(page, vp, scheme, "4-plan");
        await shoot(page, vp, scheme, "4b-plan-full", true);

        // The week's brief, from its line.
        await page.locator("button.plan-week-line").click();
        await page.getByRole("dialog").first().waitFor();
        await shoot(page, vp, scheme, "5-week-brief");
        await page.keyboard.press("Escape");

        // A plan's sheet, and its Ask with the words written.
        const row = page.locator("button.plan-row").filter({ hasText: /plan ·/ }).first();
        if (await row.count()) {
          await row.scrollIntoViewIfNeeded();
          await row.click();
          await page.getByRole("dialog").first().waitFor();
          await shoot(page, vp, scheme, "6-plan-sheet");
          await page.getByRole("button", { name: "Ask about this plan" }).click();
          await page.getByRole("dialog", { name: "Coach" }).waitFor();
          await shoot(page, vp, scheme, "7-plan-sheet-asks-the-coach");
          await page.keyboard.press("Escape");
          await page.keyboard.press("Escape");
        }

        // Settings: the five groups.
        await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
        await page.locator(".settings-group").first().waitFor();
        await shoot(page, vp, scheme, "8-settings");
        await shoot(page, vp, scheme, "8b-settings-full", true);

        // Growth, as the nav marks it.
        await page.goto(`${BASE}/growth`, { waitUntil: "networkidle" });
        await shoot(page, vp, scheme, "9-growth-nav");

        await context.close();
      }
    }

    // Today on a phone WITH its banners: a device clock in another zone (the one-line time zone prompt) and the
    // calendar paused (its one line). The first screen is measured and logged; it fails only without banners.
    for (const scheme of ["light", "dark"]) {
      const vp = VIEWPORTS[0];
      const device = zone === "Asia/Tokyo" ? "Europe/London" : "Asia/Tokyo";
      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, deviceScaleFactor: 2, timezoneId: device });
      await context.request.post(`${BASE}/api/dev/fixture-login`);
      const page = await context.newPage();
      await page.route((url) => url.pathname === "/api/plan/today", async (r) => {
        const res = await r.fetch();
        const body = await res.json();
        body.sync = { ...body.sync, calendarConnected: false };
        await r.fulfill({ response: res, json: body });
      });
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await page.locator("#dock-panel").waitFor();
      await page.locator(".tz-nudge").waitFor();
      console.log(`above the fold WITH banners @ ${vp.name} ${scheme}: ${JSON.stringify(await aboveFold(page))}`);
      await shoot(page, vp, scheme, "1c-today-with-banners");
      await context.close();
    }

    // Extend and "Plan with the coach" ask the thread coach, and say so in one quiet line. The fixture has no plan the
    // coach made (Extend is a coach plan's), so its run plan is shown here as one; the thread coach's POST is answered
    // here (no model, nothing sent).
    for (const scheme of ["light", "dark"]) {
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, deviceScaleFactor: 2, timezoneId: zone });
        await context.request.post(`${BASE}/api/dev/fixture-login`);
        const page = await context.newPage();
        const asCoach = async (r, pick) => {
          const res = await r.fetch();
          const body = await res.json();
          await r.fulfill({ response: res, json: pick(body) });
        };
        await page.route((url) => url.pathname === "/api/coach/plans", (r) =>
          asCoach(r, (b) => ({ ...b, plans: b.plans.map((x) => (x.discipline === "run" ? { ...x, source: "coach" } : x)) })),
        );
        await page.route((url) => /^\/api\/coach\/plans\/[^/]+\/detail$/.test(url.pathname), (r) =>
          asCoach(r, (b) => (b.plan?.discipline === "run" ? { ...b, plan: { ...b.plan, source: "coach" } } : b)),
        );
        await page.route((url) => url.pathname === "/api/coach/message", (r) => r.fulfill({ json: { status: "skipped" } }));
        await page.goto(`${BASE}/plan`, { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "Your plans" }).waitFor({ timeout: 30_000 });
        const runPlan = (await (await context.request.get(`${BASE}/api/coach/plans`)).json()).plans.find((x) => x.discipline === "run");
        const row = page.locator("button.plan-row").filter({ hasText: runPlan.name }).first();
        await row.scrollIntoViewIfNeeded();
        await row.click();
        const sheet = page.getByRole("dialog").first();
        await sheet.getByRole("button", { name: "Extend" }).click();
        await sheet.locator(".plan-asked").waitFor();
        await shoot(page, vp, scheme, "7b-plan-sheet-asked-the-thread-coach");
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "Plan with the coach" }).click();
        await page.locator(".plan-asked").waitFor();
        await page.locator(".plan-asked").scrollIntoViewIfNeeded();
        await shoot(page, vp, scheme, "7c-your-plans-asked-the-thread-coach");
        await context.close();
      }
    }

    // The coach's ● on the nav: a run started on the scripted model in one page (the run keeper is the page's own), then
    // that page at each width and in each theme.
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light", deviceScaleFactor: 2, timezoneId: zone });
      await context.request.post(`${BASE}/api/dev/fixture-login`);
      const page = await context.newPage();
      await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
      await page.locator("#dock-panel").waitFor();
      await page.locator("nav.bottom-nav").getByRole("button", { name: "Coach" }).click();
      const sheet = page.getByRole("dialog", { name: "Coach" });
      await sheet.locator(".coach-box textarea").waitFor({ timeout: 20_000 });
      await sheet.locator(".coach-opening, .coach-turns").first().waitFor({ timeout: 20_000 });
      if (!(await sheet.locator(".coach-opening").isVisible())) {
        // An earlier run's conversation: start a new one, so the words start a run of their own.
        await sheet.getByRole("button", { name: "More" }).click();
        await sheet.getByRole("menuitem", { name: "New conversation" }).click();
        await sheet.locator(".coach-opening").waitFor();
      }
      // The stand-in model asks a question first, so the run waits for the athlete — and the ● stays for the shots.
      const model = process.env.RG_DESIGN_MODEL_PORT;
      if (model) await fetch(`http://localhost:${model}/use/ask`);
      await sheet.locator(".coach-box textarea").fill("A 30 minute easy run tomorrow.");
      const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/coach/runs");
      await sheet.getByRole("button", { name: "Send" }).click();
      await created;
      await page.keyboard.press("Escape");
      for (const scheme of ["light", "dark"]) {
        for (const vp of VIEWPORTS) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await page.emulateMedia({ colorScheme: scheme });
          const nav = page.locator(vp.mobile ? "nav.bottom-nav" : "nav.side-nav");
          await nav.locator(".nav-coach-mark").waitFor({ timeout: 60_000 });
          await shoot(page, vp, scheme, "11-coach-dot-on-the-nav");
          const box = await nav.locator("button.nav-coach").boundingBox();
          if (box) {
            const pad = 24;
            const path = join(OUT, `11b-coach-dot-close__${vp.name}__${scheme}.png`);
            const x = Math.max(0, box.x - pad);
            const y = Math.max(0, box.y - pad);
            await page.screenshot({ path, clip: { x, y, width: Math.min(box.width + 2 * pad, vp.width - x), height: Math.min(box.height + 2 * pad, vp.height - y) } });
            console.log(path);
          }
        }
      }
      if (model) await fetch(`http://localhost:${model}/use/`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
