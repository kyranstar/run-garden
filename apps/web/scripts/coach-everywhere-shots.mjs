/**
 * Coach everywhere (phase A) verification shots: the coach's sheet opened from a planned workout, its chip, the
 * suggestion's "Change something…" line, the follow-up's suggestion in its place, and three entry points' "Ask" (the
 * Today card, a day of the Plan's week, a move's page) — on a phone (390×844) and a desktop (1440×900), light and dark.
 * FAILS LOUDLY on any horizontal overflow on the phone. Needs the fixture stack on the scripted model.
 *
 *   RG_BASE=http://localhost:5271 RG_DESIGN_MODEL_PORT=8897 node apps/web/scripts/coach-everywhere-shots.mjs
 *
 * The stand-in model answers with its `followup` script while it runs (`POST /use/followup`), and goes back after.
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "..", "screenshots", "coach-everywhere");
mkdirSync(OUT, { recursive: true });

const BASE = process.env.RG_BASE ?? "http://localhost:5271";
const MODEL = `http://127.0.0.1:${process.env.RG_DESIGN_MODEL_PORT ?? "8897"}`;
const LIVE = ["active", "stepping", "waiting_athlete", "waiting_review", "waiting_set"];

const VIEWPORTS = [
  { name: "390x844", width: 390, height: 844, mobile: true },
  { name: "1440x900", width: 1440, height: 900, mobile: false },
];

async function clearTheCoach(request) {
  for (let i = 0; i < 6; i++) {
    const current = await (await request.get(`${BASE}/api/coach/runs/current`)).json();
    for (const a of current.alsoOpen ?? []) await request.post(`${BASE}/api/coach/proposals/${a.proposalId}/decline`, { data: {} });
    if (!current.run) return;
    if (LIVE.includes(current.run.status)) await request.post(`${BASE}/api/coach/runs/${current.run.id}/cancel`, { data: {} });
    else if (current.proposal && ["pending", "partially_approved"].includes(current.proposal.status ?? "")) {
      await request.post(`${BASE}/api/coach/proposals/${current.proposal.id}/decline`, { data: {} });
    } else return;
  }
}

async function assertNoOverflow(page, label) {
  const { scrollW, innerW } = await page.evaluate(() => ({ scrollW: document.scrollingElement.scrollWidth, innerW: window.innerWidth }));
  if (scrollW > innerW + 1) throw new Error(`HORIZONTAL OVERFLOW at ${label}: scrollWidth ${scrollW} > innerWidth ${innerW}`);
}

async function shoot(page, vp, scheme, name) {
  await page.waitForTimeout(500);
  if (vp.mobile) await assertNoOverflow(page, `${name} @ ${vp.name} ${scheme}`);
  const path = join(OUT, `${name}__${vp.name}__${scheme}.png`);
  await page.screenshot({ path });
  console.log(path);
}

async function run() {
  await fetch(`${MODEL}/use/followup`, { method: "POST" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, deviceScaleFactor: 2 });
        const login = await context.request.post(`${BASE}/api/dev/fixture-login`);
        if (!login.ok()) throw new Error(`fixture-login failed: ${login.status()}`);
        await clearTheCoach(context.request);
        const today = await (await context.request.get(`${BASE}/api/plan/today`)).json();
        const w = [today.nextWorkout, ...(today.upcoming ?? [])].find((x) => x && x.category !== "rest");
        const page = await context.newPage();

        // Entry point: the Today card.
        await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
        await page.locator("#dock-panel .ask-coach, .today-ask .ask-coach").first().scrollIntoViewIfNeeded().catch(() => undefined);
        await shoot(page, vp, scheme, "1-today-card-ask");

        // Entry point: a day of the Plan's week (on a desktop, the day pointed at shows its Ask).
        await page.goto(`${BASE}/plan`, { waitUntil: "networkidle" });
        const todayCell = page.locator(".plan-week-day.is-today");
        await todayCell.scrollIntoViewIfNeeded();
        if (!vp.mobile) await todayCell.hover();
        await shoot(page, vp, scheme, "2-plan-week-day-ask");

        // A planned workout's sheet, its Ask.
        await page.goto(`${BASE}/plan?workout=${encodeURIComponent(w.id)}`, { waitUntil: "networkidle" });
        await page.getByRole("dialog").first().waitFor();
        await shoot(page, vp, scheme, "3-workout-sheet-ask");

        // The coach's sheet, opened from it: the chip.
        await page.getByRole("dialog").first().getByRole("button", { name: /^Ask the coach about / }).click();
        const sheet = page.getByRole("dialog", { name: "Coach" });
        await sheet.waitFor();
        await sheet.getByPlaceholder("What would help today?").fill("something gentle for the hips instead");
        await shoot(page, vp, scheme, "4-coach-sheet-chip");

        // Now → the suggestion, and its follow-up line.
        await sheet.getByRole("button", { name: "Now", exact: true }).click();
        await sheet.getByRole("button", { name: "Hips and back, gently" }).waitFor({ timeout: 60_000 });
        const follow = sheet.getByPlaceholder("Change something…");
        await follow.scrollIntoViewIfNeeded();
        await follow.fill("Make it shorter");
        await shoot(page, vp, scheme, "5-coach-sheet-follow-up-line");

        // The follow-up's suggestion in the old one's place.
        await sheet.getByRole("button", { name: "Send", exact: true }).click();
        await sheet.getByRole("button", { name: "Hips and back, shorter" }).waitFor({ timeout: 60_000 });
        await shoot(page, vp, scheme, "6-coach-sheet-follow-up-replaced");

        // Entry point: a move's page in the library.
        await page.keyboard.press("Escape");
        await page.goto(`${BASE}/studio/move/gobletSquat`, { waitUntil: "networkidle" });
        await shoot(page, vp, scheme, "7-move-ask");

        await clearTheCoach(context.request);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await fetch(`${MODEL}/use/`, { method: "POST" });
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
