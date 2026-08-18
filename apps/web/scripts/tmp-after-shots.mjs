import { chromium, devices } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";

const BASE = "http://localhost:5246";
const OUT = "/private/tmp/claude-501/-Users-kyranadams-src-run-garden--claude-worktrees-garden-ux-audit/1772806f-a9e5-44be-ae13-6cd7ce16001b/scratchpad/after";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "360x800", width: 360, height: 800 },
  { name: "390x844", width: 390, height: 844 },
  { name: "768x1024", width: 768, height: 1024 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1440x900", width: 1440, height: 900 },
];

const browser = await chromium.launch();
const report = { overflow: [], hits: [], metrics: {} };

for (const scheme of ["light", "dark"]) {
  for (const vp of VIEWPORTS) {
    if (scheme === "dark" && !["390x844", "1440x900"].includes(vp.name)) continue;
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      colorScheme: scheme,
      timezoneId: "America/New_York",
      isMobile: vp.width < 800,
      hasTouch: vp.width < 800,
      deviceScaleFactor: 2,
    });
    await context.request.post(`${BASE}/api/dev/fixture-login`);
    const page = await context.newPage();
    await page.clock.install({ time: new Date("2026-08-18T10:30:00-04:00") });
    await page.goto(`${BASE}/`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2000);
    await page.addStyleTag({ content: ".banner-info[role='status'] { display: none !important; }" });
    await page.waitForTimeout(300);
    const { scrollW, innerW, scrollH } = await page.evaluate(() => ({
      scrollW: document.scrollingElement.scrollWidth,
      innerW: window.innerWidth,
      scrollH: document.scrollingElement.scrollHeight,
    }));
    if (scrollW > innerW + 1) report.overflow.push(`${vp.name} ${scheme}: ${scrollW} > ${innerW}`);
    report.metrics[`${vp.name}_${scheme}`] = {
      h: scrollH,
      buttons: await page.evaluate(() => document.querySelectorAll("button, a, [role='button'], input, select").length),
    };
    await page.screenshot({ path: `${OUT}/garden__${vp.name}__${scheme}_fold.png` });
    await page.screenshot({ path: `${OUT}/garden__${vp.name}__${scheme}.png`, fullPage: true });

    if (vp.name === "390x844" && scheme === "light") {
      const chips = await page.locator(".scene-chip").all();
      for (let i = 0; i < chips.length; i++) {
        const box = await chips[i].boundingBox();
        if (!box) continue;
        const pts = [
          [box.x + box.width / 2, box.y + box.height / 2],
          [box.x + 4, box.y + 4],
          [box.x + box.width - 4, box.y + 4],
          [box.x + 4, box.y + box.height - 4],
          [box.x + box.width - 4, box.y + box.height - 4],
        ];
        for (const [x, y] of pts) {
          const hit = await page.evaluate(([px, py]) => {
            const el = document.elementFromPoint(px, py);
            return el ? (el.closest(".scene-chip") ? "chip" : el.className || el.tagName) : "none";
          }, [x, y]);
          if (hit !== "chip") report.hits.push(`chip${i} @${Math.round(x)},${Math.round(y)} -> ${hit}`);
        }
      }
      const chip = page.locator(".ready-chip");
      if (await chip.count()) {
        await chip.click();
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${OUT}/garden__readiness_sheet.png` });
        await page.keyboard.press("Escape");
        await page.waitForTimeout(300);
      }
      const bar = page.locator(".lately .balance-bar").first();
      if (await bar.count()) {
        await bar.click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${OUT}/garden__balance_detail.png`, fullPage: true });
      }
    }
    await context.close();
  }
}
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 1));
await browser.close();
