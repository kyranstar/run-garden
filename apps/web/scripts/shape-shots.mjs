/**
 * The new shape (stream B) verification shots: the nav, Today's one card and its garden drawer, the coach opened from
 * the nav, Plan's week and "Your plans", a plan's sheet and its action's coach with the words written, Settings in its
 * five groups — on a phone (390×844) and a desktop (1440×900), light and dark. FAILS LOUDLY on any horizontal overflow
 * on the phone. Needs the fixture stack (the coach on).
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
    for (const scheme of ["light", "dark"]) {
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, deviceScaleFactor: 2 });
        const login = await context.request.post(`${BASE}/api/dev/fixture-login`);
        if (!login.ok()) throw new Error(`fixture-login failed: ${login.status()}`);
        const page = await context.newPage();

        // Today: the scene, the one card, the handle — the whole page.
        await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
        await page.locator("#dock-panel").waitFor();
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
  } finally {
    await browser.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
