import { chromium } from "@playwright/test";
const S = "/private/tmp/claude-501/-Users-kyranadams-src-run-garden--claude-worktrees-garden-ux-audit/1772806f-a9e5-44be-ae13-6cd7ce16001b/scratchpad";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.goto(`file://${S}/mock_frame1.png`);
await page.evaluate(() => {
  const img = document.querySelector("img");
  img.style.width = "390px"; img.style.height = "auto"; img.style.display = "block";
  document.body.style.margin = "0";
});
await page.waitForTimeout(300);
await page.screenshot({ path: `${S}/cmp_after_fold.png`, clip: { x: 0, y: 0, width: 390, height: 844 } });
await browser.close();
console.log("ok");
