import { chromium } from "@playwright/test";
import { statSync } from "node:fs";

const S = "/private/tmp/claude-501/-Users-kyranadams-src-run-garden--claude-worktrees-garden-ux-audit/1772806f-a9e5-44be-ae13-6cd7ce16001b/scratchpad";
const browser = await chromium.launch();

// Render a source PNG at a target CSS width inside a page, then screenshot a clip.
async function crop(src, out, { srcCssW, x = 0, y, w, h }) {
  const page = await browser.newPage({ viewport: { width: srcCssW, height: Math.min(h, 4000) }, deviceScaleFactor: 2 });
  await page.goto(`file://${src}`);
  await page.evaluate((cssW) => {
    const img = document.querySelector("img");
    img.style.width = cssW + "px";
    img.style.height = "auto";
    img.style.display = "block";
    document.body.style.margin = "0";
  }, srcCssW);
  await page.waitForTimeout(300);
  await page.screenshot({ path: out, clip: { x, y, width: w, height: h } });
  await page.close();
  console.log(out.split("/").pop(), Math.round(statSync(out).size / 1024) + "KB");
}

// BEFORE garden, prod-like fold: skip the 91px fixture banner, take one 844px viewport
await crop(`${S}/before/garden__full_day.png`, `${S}/cmp_before_fold.png`, { srcCssW: 390, y: 91, w: 390, h: 844 });
// AFTER fold: top 844 CSS px of the mock (frame is 390 CSS wide, shot at 2x -> display at 390)
await crop(`${S}/mock_frame1.png`, `${S}/cmp_after_fold.png`, { srcCssW: 390, y: 0, w: 390, h: 844 });
// Full-page versions at 390 CSS width for side-by-side embedding
await crop(`${S}/before/garden__full_day.png`, `${S}/cmp_before_full.png`, { srcCssW: 390, y: 91, w: 390, h: 2571 });

// Small thumbs of runs + insights (full pages are huge; render at 300 wide, capture full)
async function thumb(src, out, cssW) {
  const page = await browser.newPage({ viewport: { width: cssW, height: 1200 }, deviceScaleFactor: 1.5 });
  await page.goto(`file://${src}`);
  const dims = await page.evaluate((w) => {
    const img = document.querySelector("img");
    img.style.width = w + "px"; img.style.height = "auto"; img.style.display = "block";
    document.body.style.margin = "0";
    return { h: img.getBoundingClientRect().height };
  }, cssW);
  await page.setViewportSize({ width: cssW, height: Math.min(Math.ceil(dims.h), 8000) });
  await page.waitForTimeout(200);
  await page.screenshot({ path: out, fullPage: true });
  console.log(out.split("/").pop(), Math.round(statSync(out).size / 1024) + "KB");
}
await thumb(`${S}/before/runs__full_day.png`, `${S}/cmp_runs_thumb.png`, 260);
await thumb(`${S}/before/insights__full_day.png`, `${S}/cmp_insights_thumb.png`, 260);

await browser.close();
