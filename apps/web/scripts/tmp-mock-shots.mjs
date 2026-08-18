import { chromium } from "@playwright/test";

const MOCK = "file:///private/tmp/claude-501/-Users-kyranadams-src-run-garden--claude-worktrees-garden-ux-audit/1772806f-a9e5-44be-ae13-6cd7ce16001b/scratchpad/mock-system1.html";
const OUT = "/private/tmp/claude-501/-Users-kyranadams-src-run-garden--claude-worktrees-garden-ux-audit/1772806f-a9e5-44be-ae13-6cd7ce16001b/scratchpad";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
await page.goto(MOCK);
await page.waitForTimeout(800);
const frames = page.locator(".frame");
const n = await frames.count();
for (let i = 0; i < n; i++) {
  await frames.nth(i).screenshot({ path: `${OUT}/mock_frame${i + 1}.png` });
}
const h = await frames.first().evaluate((el) => el.getBoundingClientRect().height);
console.log("frames:", n, "frame1 height:", h);
await browser.close();
