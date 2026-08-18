import { chromium, devices } from "@playwright/test";
import { writeFileSync } from "node:fs";

const BASE = "http://localhost:5246";
const OUT = "/private/tmp/claude-501/-Users-kyranadams-src-run-garden--claude-worktrees-garden-ux-audit/1772806f-a9e5-44be-ae13-6cd7ce16001b/scratchpad/before";

const PAGES = [
  { path: "/", name: "garden" },
  { path: "/plan", name: "plan" },
  { path: "/runs", name: "runs" },
  { path: "/insights", name: "insights" },
  { path: "/settings", name: "settings" },
];

async function metrics(page) {
  return page.evaluate(() => {
    const se = document.scrollingElement;
    const interactive = document.querySelectorAll("button, a, [role='button'], input, select, textarea");
    const heads = [...document.querySelectorAll("h1,h2,h3,h4,.card-title,.hud-condition")].map((h) => {
      const r = h.getBoundingClientRect();
      return { tag: h.tagName, cls: h.className.split(" ")[0], y: Math.round(r.top + se.scrollTop), text: (h.textContent || "").trim().slice(0, 80) };
    });
    const cards = document.querySelectorAll(".card, section, .banner").length;
    const textLen = (document.querySelector("main")?.innerText || "").length;
    return {
      scrollHeight: se.scrollHeight,
      viewportH: window.innerHeight,
      screens: +(se.scrollHeight / window.innerHeight).toFixed(1),
      interactiveCount: interactive.length,
      cardsAndSections: cards,
      mainTextChars: textLen,
      headings: heads,
    };
  });
}

const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["iPhone 13"], colorScheme: "light" });
let res = await context.request.post(`${BASE}/api/dev/fixture-login`);
if (!res.ok()) throw new Error(`fixture-login ${res.status()}`);
res = await context.request.post(`${BASE}/api/dev/seed`);
if (!res.ok()) throw new Error(`seed ${res.status()}: ${await res.text()}`);

const page = await context.newPage();
const all = {};
for (const p of PAGES) {
  await page.goto(`${BASE}${p.path}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/${p.name}__fold.png` });
  await page.screenshot({ path: `${OUT}/${p.name}__full.png`, fullPage: true });
  all[p.name] = await metrics(page);
}

// Garden open states: balance detail + collection drawer
await page.goto(`${BASE}/`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1800);
const runBar = page.locator(".balance-strip button").first();
if (await runBar.count()) {
  await runBar.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/garden__balance-detail.png`, fullPage: true });
}
const coll = page.getByRole("button", { name: /Collection/ });
if (await coll.count()) {
  await coll.first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/garden__collection-drawer.png`, fullPage: true });
}

writeFileSync(`${OUT}/metrics.json`, JSON.stringify(all, null, 2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { h: v.scrollHeight, screens: v.screens, buttons: v.interactiveCount, cards: v.cardsAndSections, chars: v.mainTextChars }])), null, 2));
await browser.close();
