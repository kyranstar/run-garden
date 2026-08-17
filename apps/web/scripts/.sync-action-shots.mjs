/**
 * Live verification for the sync-action layer: four session states, two
 * viewports, both themes, through the real fixture stack.
 *
 *   RG_BASE=http://localhost:5274 node sync-action-shots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = process.env.OUT ?? "/tmp/sync-shots";
mkdirSync(OUT, { recursive: true });
const BASE = process.env.RG_BASE ?? "http://localhost:5274";

const CASES = [
  ["synced", "66817d30-c669-4e00-94b6-0adba08d3405"],
  ["content-stale", "6bb799ac-b1b6-4164-b24b-f31a97be0fa8"],
  ["off-catalog-lift", "ux-lift-1"],
  ["lift-that-crosses", "ux-lift-crossing"],
];

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844, mobile: true },
  { name: "1440x900", width: 1440, height: 900, mobile: false },
];

async function assertNoOverflow(page, label) {
  const { scrollW, innerW } = await page.evaluate(() => ({
    scrollW: document.scrollingElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  if (scrollW > innerW + 1) {
    throw new Error(`HORIZONTAL OVERFLOW at ${label}: ${scrollW} > ${innerW}`);
  }
}

const browser = await chromium.launch();
let n = 0;
for (const scheme of ["light", "dark"]) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      colorScheme: scheme,
      deviceScaleFactor: 2,
    });
    const login = await ctx.request.post(`${BASE}/api/dev/fixture-login`);
    if (!login.ok()) throw new Error(`fixture-login ${login.status()}`);
    const page = await ctx.newPage();
    for (const [label, id] of CASES) {
      await page.goto(`${BASE}/plan?workout=${id}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(900);
      if (vp.mobile) await assertNoOverflow(page, `${label} @ ${vp.name} ${scheme}`);
      const sheet = page.locator(".sheet, [role=dialog]").first();
      const target = (await sheet.count()) > 0 ? sheet : page.locator("body");
      await target.screenshot({ path: `${OUT}/${label}__${vp.name}__${scheme}.png` });
      n++;
      // What the sheet actually says, so the report quotes the screen and not
      // the DTO.
      const text = await (vp ? target : target).innerText().catch(() => "");
      console.log(
        `--- ${label} ${vp.name} ${scheme}\n${text.split("\n").filter(Boolean).slice(0, 24).join("\n")}\n`,
      );
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`captured ${n} → ${OUT}`);
