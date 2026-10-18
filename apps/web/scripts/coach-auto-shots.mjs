/**
 * The new shape, stream A (the coach conversation, server) — verification shots: a conversation of auto runs on the
 * scripted model (an answer in words, then one workout for right now) and the app's coach sheet opened from the nav over
 * it, on a phone (390×844) and a desktop (1440×900), light and dark. FAILS LOUDLY on any horizontal overflow on the
 * phone. The sheet is stream C's; these shots show what the server's conversation gives it. Needs the fixture stack on
 * the scripted model.
 *
 *   RG_BASE=http://localhost:5281 RG_DESIGN_MODEL_PORT=8901 node apps/web/scripts/coach-auto-shots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "..", "..", "screenshots", "new-shape", "A");
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

/** Ask with no scope, in `conversationId` (null: a new one), and let the run's alarm step it to its end. */
async function ask(request, words, conversationId) {
  const created = await (await request.post(`${BASE}/api/coach/runs`, { data: { request: words, conversationId } })).json();
  const id = created.run.id;
  await request.post(`${BASE}/api/coach/runs/${id}/step?afterSeq=0`);
  for (let i = 0; i < 240; i++) {
    const read = await (await request.get(`${BASE}/api/coach/runs/${id}?afterSeq=0`)).json();
    if (!LIVE.includes(read.run.status)) return read.run;
    if (i % 10 === 9) await request.post(`${BASE}/api/coach/runs/${id}/step?afterSeq=0`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`run ${id} still live`);
}

async function assertNoOverflow(page, label) {
  const { scrollW, innerW } = await page.evaluate(() => ({ scrollW: document.scrollingElement.scrollWidth, innerW: window.innerWidth }));
  if (scrollW > innerW + 1) throw new Error(`HORIZONTAL OVERFLOW at ${label}: scrollWidth ${scrollW} > innerWidth ${innerW}`);
}

async function run() {
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, colorScheme: scheme, deviceScaleFactor: 2 });
        const page = await context.newPage();
        await context.request.post(`${BASE}/api/dev/fixture-login`);
        await clearTheCoach(context.request);
        await fetch(`${MODEL}/use/auto_answer`, { method: "POST" });
        const answered = await ask(context.request, "How are my holds going?", null);
        await fetch(`${MODEL}/use/auto_design`, { method: "POST" });
        await ask(context.request, "Something short for right now.", answered.conversationId);
        await page.goto(`${BASE}/`);
        await page.getByRole("button", { name: "Coach", exact: true }).first().click();
        await page.waitForTimeout(1500);
        if (vp.mobile) await assertNoOverflow(page, `conversation @ ${vp.name} ${scheme}`);
        const path = join(OUT, `conversation__${vp.name}__${scheme}.png`);
        await page.screenshot({ path });
        console.log(path);
        await clearTheCoach(context.request);
        await context.close();
      }
    }
  } finally {
    await fetch(`${MODEL}/use/`, { method: "POST" });
    await browser.close();
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
