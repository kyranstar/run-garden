import { chromium, devices } from "@playwright/test";
const BASE = "http://localhost:5246";
const browser = await chromium.launch();
const context = await browser.newContext({ ...devices["iPhone 13"], timezoneId: "America/New_York" });
await context.request.post(`${BASE}/api/dev/fixture-login`);
const page = await context.newPage();
await page.goto(`${BASE}/`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1500);
console.log(await page.evaluate(() => {
  const b = document.querySelector(".dock-grows");
  const n = document.querySelector(".dock-grows-name");
  return {
    btn: b ? getComputedStyle(b).textDecorationLine : "none-found",
    name: n ? getComputedStyle(n).textDecorationLine : "none-found",
  };
}));
await browser.close();
