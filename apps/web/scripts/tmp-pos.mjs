import { chromium, devices } from "@playwright/test";
const BASE = "http://localhost:5246";
const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["iPhone 13"], colorScheme: "light", timezoneId: "America/New_York" });
await context.request.post(`${BASE}/api/dev/fixture-login`);
const page = await context.newPage();
await page.clock.install({ time: new Date("2026-08-18T10:30:00-04:00") });
await page.goto(`${BASE}/`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1800);
const out = await page.evaluate(() => {
  const se = document.scrollingElement;
  const y = (el) => el ? Math.round(el.getBoundingClientRect().top + se.scrollTop) : null;
  const q = (sel) => document.querySelector(sel);
  const cards = [...document.querySelectorAll(".garden-below .card, .garden-below section, .garden-below .banner")].map((el) => ({
    cls: el.className.split(" ").slice(0, 2).join("."), y: y(el), text: (el.textContent || "").trim().slice(0, 40),
  }));
  return {
    total: se.scrollHeight,
    beat: y(q(".hud-beat")),
    pill: y(q(".dock-pill")),
    panel: y(q(".dock-panel")),
    attentionLink: y(q(".dock-attention")),
    balance: y(q(".hud-topright")),
    nudges: y(q(".hud-corner")),
    below: y(q(".garden-below")),
    cards,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
