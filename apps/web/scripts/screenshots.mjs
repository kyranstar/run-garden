/**
 * Visual QA: capture every principal screen at the required viewports, in both
 * light and dark, plus reduced-motion. Requires the web dev server on :5173
 * proxying to a fixture-seeded worker on :8787.
 *
 *   node scripts/screenshots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "..", "screenshots");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.RG_BASE ?? "http://localhost:5173";

const VIEWPORTS = [
  { name: "360x800", width: 360, height: 800 },
  { name: "390x844", width: 390, height: 844 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1440x900", width: 1440, height: 900 },
];

const SCREENS = [
  { name: "today", path: "/" },
  { name: "plan", path: "/plan" },
  { name: "garden", path: "/garden" },
  { name: "insights", path: "/insights" },
  { name: "settings", path: "/settings" },
];

async function login(context) {
  // Fixture login sets the session cookie; the SPA then loads authed.
  const res = await context.request.post(`${BASE}/api/dev/fixture-login`);
  if (!res.ok()) throw new Error(`fixture-login failed: ${res.status()}`);
}

async function run() {
  const browser = await chromium.launch();
  const results = [];

  for (const scheme of ["light", "dark"]) {
    for (const vp of VIEWPORTS) {
      // Only capture dark mode at the two phone sizes + one desktop, to keep
      // the set reviewable; light mode at every viewport.
      if (scheme === "dark" && !["390x844", "1280x800"].includes(vp.name)) continue;

      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      await login(context);
      const page = await context.newPage();

      for (const screen of SCREENS) {
        await page.goto(`${BASE}${screen.path}`, { waitUntil: "networkidle" });
        // Let charts/garden settle.
        await page.waitForTimeout(700);
        const file = `${screen.name}__${vp.name}__${scheme}.png`;
        await page.screenshot({ path: join(OUT, file), fullPage: true });
        results.push(file);
      }
      await context.close();
    }
  }

  // Reduced motion + onboarding + welcome, one phone viewport, light.
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: "light",
    reducedMotion: "reduce",
    deviceScaleFactor: 2,
  });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/welcome`, { waitUntil: "networkidle" });
  await p.waitForTimeout(400);
  await p.screenshot({ path: join(OUT, "welcome__390x844__light.png"), fullPage: true });
  await login(ctx);
  await p.goto(`${BASE}/onboarding`, { waitUntil: "networkidle" });
  await p.waitForTimeout(400);
  await p.screenshot({ path: join(OUT, "onboarding__390x844__light.png"), fullPage: true });
  await p.goto(`${BASE}/garden`, { waitUntil: "networkidle" });
  await p.waitForTimeout(700);
  await p.screenshot({ path: join(OUT, "garden-reducedmotion__390x844__light.png"), fullPage: true });
  await ctx.close();

  await browser.close();
  console.log(`Captured ${results.length + 3} screenshots to ${OUT}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
