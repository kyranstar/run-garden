import { chromium, devices } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:5246";
const OUT = "/private/tmp/claude-501/-Users-kyranadams-src-run-garden--claude-worktrees-garden-ux-audit/1772806f-a9e5-44be-ae13-6cd7ce16001b/scratchpad/before";

const PAGES = [
  { path: "/", name: "garden" },
  { path: "/plan", name: "plan" },
  { path: "/runs", name: "runs" },
  { path: "/insights", name: "insights" },
];

const browser = await chromium.launch();
const context = await browser.newContext({
  ...devices["iPhone 13"],
  colorScheme: "light",
  timezoneId: "America/New_York",
});
let res = await context.request.post(`${BASE}/api/dev/fixture-login`);
if (!res.ok()) throw new Error(`fixture-login ${res.status()}`);

const page = await context.newPage();
await page.clock.install({ time: new Date("2026-08-18T10:30:00-04:00") });
const all = {};
for (const p of PAGES) {
  await page.goto(`${BASE}${p.path}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/${p.name}__fold_day.png` });
  await page.screenshot({ path: `${OUT}/${p.name}__full_day.png`, fullPage: true });
  if (p.name === "garden") {
    const scene = page.locator(".garden-scene");
    await scene.screenshot({ path: `${OUT}/scene_day.png` });
    all.gardenHeights = await page.evaluate(() => {
      const se = document.scrollingElement;
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { y: Math.round(r.top + se.scrollTop), h: Math.round(r.height) };
      };
      return {
        total: se.scrollHeight,
        scene: pick(".garden-scene"),
        condition: pick(".hud-topleft"),
        dock: pick(".hud-dock"),
        balance: pick(".hud-topright"),
        corner: pick(".hud-corner"),
        below: pick(".garden-below"),
      };
    });
  }
}
writeFileSync(`${OUT}/metrics_day.json`, JSON.stringify(all, null, 2));
console.log(JSON.stringify(all));
await browser.close();
