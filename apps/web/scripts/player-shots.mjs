/**
 * The sound pass's visual check (2026-10-17): the player in the last 3 s of a timer, paused, and its Settings sheet
 * with the sound controls; app Settings → Sessions → Sounds, closed and open. Phone (390×844, touch, with an audio
 * session so the ring/silent hint shows once) and desktop (1280×800), light and dark. Fails loudly on any horizontal
 * overflow at the phone width.
 *
 *   RG_BASE=http://localhost:5271 RG_SHOTS_OUT=<dir> node scripts/player-shots.mjs
 *
 * Runs against the fixture stack (`e2e/fixture-stack.sh`): fixture data only. Each context starts the Desk reset quick
 * start from the Studio (on wherever Vite says DEV) and drives the player's clock with Playwright's.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.RG_SHOTS_OUT ?? join(here, "..", "..", "..", "screenshots", "player");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.RG_BASE ?? "http://localhost:5271";

const VIEWPORTS = [
  { name: "phone", width: 390, height: 844, mobile: true },
  { name: "desktop", width: 1280, height: 800, mobile: false },
];

async function login(context) {
  for (let i = 0; i < 2; i++) {
    const res = await context.request.post(`${BASE}/api/dev/fixture-login`).catch(() => null);
    if (res?.ok()) return;
  }
  throw new Error("fixture-login failed");
}

async function assertNoOverflow(page, label) {
  const { scrollW, innerW } = await page.evaluate(() => ({ scrollW: document.scrollingElement.scrollWidth, innerW: window.innerWidth }));
  if (scrollW > innerW + 1) throw new Error(`HORIZONTAL OVERFLOW at ${label}: scrollWidth ${scrollW} > innerWidth ${innerW}`);
}

async function shoot(page, vp, scheme, name, target = null) {
  await page.waitForTimeout(400);
  if (vp.mobile) await assertNoOverflow(page, `${name} @ ${vp.name} ${scheme}`);
  const path = join(OUT, `${name}__${vp.name}__${scheme}.png`);
  if (target) await target.screenshot({ path });
  else await page.screenshot({ path });
  return path;
}

/** Start now → the player, accepting what the builder may ask first (the e2e's `intoThePlayer`). */
async function intoThePlayer(page) {
  const goOn = page
    .getByRole("button", { name: /^(Start with these changes|Start anyway|Continue it)$/ })
    .or(page.getByRole("dialog").getByRole("button", { name: "Skip", exact: true }));
  for (let i = 0; i < 4 && !/\/session\//.test(page.url()); i++) {
    await Promise.race([page.waitForURL(/\/session\//, { timeout: 30_000 }), goOn.first().waitFor({ timeout: 30_000 })]).catch(() => undefined);
    if (!/\/session\//.test(page.url()) && (await goOn.first().isVisible().catch(() => false))) await goOn.first().click();
  }
  await page.locator(".player-count").waitFor({ timeout: 30_000 });
}

/** The ring's number, in seconds ("0:43" → 43); null when the step has no ring (a set). */
async function ringSeconds(page) {
  const ring = page.locator(".player-ring .player-big");
  if (!(await ring.isVisible().catch(() => false))) return null;
  const [m, s] = (await ring.innerText()).trim().split(":").map(Number);
  return m * 60 + s;
}

async function run() {
  const browser = await chromium.launch();
  const shots = [];
  for (const scheme of ["light", "dark"]) {
    for (const vp of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: scheme,
        deviceScaleFactor: 2,
        hasTouch: vp.mobile,
        isMobile: vp.mobile,
      });
      // A phone with an audio session (Safari's): the ring/silent switch hint shows on its first session.
      if (vp.mobile) await context.addInitScript(() => Object.defineProperty(navigator, "audioSession", { value: { type: "auto" }, configurable: true }));
      await login(context);
      const page = await context.newPage();
      await page.clock.install();

      // ── The player ──
      await page.goto(`${BASE}/studio/build/quick/desk_reset`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Start now" }).click();
      await intoThePlayer(page);
      const dialog = page.getByRole("dialog");
      if (await dialog.isVisible().catch(() => false)) await page.keyboard.press("Escape");
      // A step with a ring (a hold or its get-ready), then its last 3 s.
      for (let i = 0; i < 12 && (await ringSeconds(page)) === null; i++) await page.getByRole("button", { name: /^(Skip|Next)$/ }).first().click();
      const left = await ringSeconds(page);
      if (left !== null && left > 3) await page.clock.fastForward((left - 3) * 1000 + 200);
      await page.waitForTimeout(300);
      shots.push(await shoot(page, vp, scheme, "player-last3s"));

      // Paused by a tap on the stage (while audio is locked, the first tap is audio's own: then a second).
      await page.locator("h1.player-name").click();
      if (!(await page.locator(".player.is-paused").isVisible().catch(() => false))) await page.locator("h1.player-name").click();
      await page.locator(".player.is-paused").waitFor();
      shots.push(await shoot(page, vp, scheme, "player-paused"));

      // The player's Settings sheet, with the sound.
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("dialog").waitFor();
      shots.push(await shoot(page, vp, scheme, "player-settings"));
      await page.keyboard.press("Escape");

      // ── App Settings → Sessions → Sounds ──
      await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
      const card = page.locator(".card", { has: page.getByRole("heading", { name: "Sessions" }) }).first();
      await card.scrollIntoViewIfNeeded();
      shots.push(await shoot(page, vp, scheme, "settings-sessions-row", card));
      await card.getByRole("button", { name: /Sounds/ }).click();
      await page.getByRole("dialog", { name: "Sounds" }).waitFor();
      shots.push(await shoot(page, vp, scheme, "settings-sounds-open"));

      await context.close();
    }
  }
  await browser.close();
  console.log(`OK — ${shots.length} shots in ${OUT} (overflow gate passed at the phone width)`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
