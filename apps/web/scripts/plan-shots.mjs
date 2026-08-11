/**
 * Plan-page rework verification (2026-08-11, spec R1): capture every plan
 * surface at the standard viewports, light + dark, and FAIL LOUDLY on any
 * horizontal body overflow at mobile widths — a bad layout must break the
 * run, not just a PNG nobody re-opens.
 *
 *   RG_BASE=http://localhost:5197 node scripts/plan-shots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "..", "screenshots", "plan-rework");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.RG_BASE ?? "http://localhost:5197";

const VIEWPORTS = [
  { name: "360x800", width: 360, height: 800, mobile: true },
  { name: "390x844", width: 390, height: 844, mobile: true },
  { name: "768x1024", width: 768, height: 1024, mobile: true },
  { name: "1280x800", width: 1280, height: 800, mobile: false },
  { name: "1440x900", width: 1440, height: 900, mobile: false },
];

async function login(context) {
  const res = await context.request.post(`${BASE}/api/dev/fixture-login`);
  if (!res.ok()) throw new Error(`fixture-login failed: ${res.status()}`);
}

async function assertNoOverflow(page, label) {
  const { scrollW, innerW } = await page.evaluate(() => ({
    scrollW: document.scrollingElement.scrollWidth,
    innerW: window.innerWidth,
  }));
  if (scrollW > innerW + 1) {
    throw new Error(`HORIZONTAL OVERFLOW at ${label}: scrollWidth ${scrollW} > innerWidth ${innerW}`);
  }
}

async function shoot(page, vp, scheme, name, { checkOverflow }) {
  await page.waitForTimeout(600);
  if (checkOverflow) await assertNoOverflow(page, `${name} @ ${vp.name} ${scheme}`);
  await page.screenshot({ path: join(OUT, `${name}__${vp.name}__${scheme}.png`), fullPage: true });
}

async function run() {
  const browser = await chromium.launch();
  let captured = 0;

  for (const scheme of ["light", "dark"]) {
    for (const vp of VIEWPORTS) {
      // Dark set kept reviewable: both phones + one desktop.
      if (scheme === "dark" && !["360x800", "390x844", "1440x900"].includes(vp.name)) continue;

      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        colorScheme: scheme,
        deviceScaleFactor: 2,
      });
      await login(context);
      const page = await context.newPage();
      const opts = { checkOverflow: vp.mobile };

      // 1 · The page, current week.
      await page.goto(`${BASE}/plan`, { waitUntil: "networkidle" });
      await shoot(page, vp, scheme, "plan", opts);
      captured++;

      // 2 · Week navigated forward (deep link).
      const nextMonday = await page.evaluate(() => {
        const d = new Date();
        const day = (d.getDay() + 6) % 7;
        d.setDate(d.getDate() - day + 7);
        return d.toISOString().slice(0, 10);
      });
      await page.goto(`${BASE}/plan?week=${nextMonday}`, { waitUntil: "networkidle" });
      await shoot(page, vp, scheme, "plan-nextweek", opts);
      captured++;

      // 3 · Studio modal on the fixture plan (when one exists).
      const plans = await page.evaluate(async () => {
        const r = await fetch("/api/coach/plans");
        return r.ok ? (await r.json()).plans : [];
      });
      if (plans[0]) {
        await page.goto(`${BASE}/plan?plan=${encodeURIComponent(plans[0].id)}`, { waitUntil: "networkidle" });
        await shoot(page, vp, scheme, "plan-modal", opts);
        captured++;
      }

      // 4 · Intake modal.
      await page.goto(`${BASE}/plan?plan=new-run`, { waitUntil: "networkidle" });
      await shoot(page, vp, scheme, "plan-intake", opts);
      captured++;

      // 5 · Coach surface open (window on desktop, sheet on mobile).
      await page.goto(`${BASE}/plan`, { waitUntil: "networkidle" });
      await page.waitForTimeout(400);
      const pill = page.locator(".coach-pill, .coach-pill--desktop").first();
      if (await pill.isVisible().catch(() => false)) {
        await pill.click();
        await shoot(page, vp, scheme, "plan-coach-open", opts);
        captured++;
      } else {
        // Window already open (auto-opened on coach activity) — capture as-is.
        await shoot(page, vp, scheme, "plan-coach-open", opts);
        captured++;
      }

      await context.close();
    }
  }

  await browser.close();
  console.log(`OK — captured ${captured} plan screenshots to ${OUT} (overflow gate passed)`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
