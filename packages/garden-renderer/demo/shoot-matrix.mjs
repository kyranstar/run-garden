/**
 * Screenshot every section of the state-matrix sampler (built by
 * build-matrix.mjs) into docs/images/matrix/<id>.png — one PNG per signature
 * weather/season/time-of-day state, for the visual checkpoint review.
 *
 *   node packages/garden-renderer/demo/build-matrix.mjs
 *   node packages/garden-renderer/demo/shoot-matrix.mjs
 *
 * Resolves @playwright/test the same throwaway way prior screenshot tooling
 * did: directly off apps/web's node_modules (its cached chromium build),
 * since @playwright/test isn't a dependency of this package.
 */
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const OUT = join(root, "docs", "images", "matrix");
const HTML = process.argv[2] ?? "/tmp/garden-matrix.html";

let chromium;
try {
  ({ chromium } = await import(
    join(root, "apps", "web", "node_modules", "@playwright", "test", "index.mjs")
  ));
} catch {
  // Fallback: resolve via createRequire rooted at the apps/web package, in
  // case the ESM re-export path above ever moves.
  const require = createRequire(join(root, "apps", "web", "package.json"));
  ({ chromium } = require("@playwright/test"));
}

// The exact 18-shot list, kept in lockstep with demo/matrix.tsx's SHOTS.
const IDS = [
  "fresh_rain--summer--13",
  "recovery_rain--summer--18.9",
  "clear_sun--summer--10",
  "soft_sun--summer--6.2",
  "soft_sun--summer--9",
  "soft_sun--summer--13",
  "soft_sun--summer--18.9",
  "soft_sun--summer--20.5",
  "soft_sun--summer--23.5",
  "light_clouds--summer--13",
  "seasonal_breeze--summer--15",
  "dry_spell--summer--13",
  "mild_drought--summer--13",
  "soft_sun--spring--13",
  "soft_sun--summer--13-restmode",
  "soft_sun--autumn--13",
  "soft_sun--winter--13",
  "clear_sun--summer--23.5-fireflies",
];

async function run() {
  if (!existsSync(HTML)) {
    throw new Error(`${HTML} not found — run build-matrix.mjs first`);
  }
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
  await page.goto(`file://${HTML}`, { waitUntil: "load" });
  // Let canvases (atmosphere layer) start drawing and settle.
  await page.waitForTimeout(1500);

  const shot = [];
  for (const id of IDS) {
    // Attribute selector, not `#id` — several ids contain a literal "." (e.g.
    // "soft_sun--summer--18.9"), which a bare CSS id selector can't express.
    const locator = page.locator(`[id="${id}"]`);
    const count = await locator.count();
    if (count === 0) {
      throw new Error(`no section found for id "${id}"`);
    }
    const path = join(OUT, `${id}.png`);
    await locator.screenshot({ path });
    shot.push(path);
  }

  await browser.close();
  console.log(`Captured ${shot.length} shots to ${OUT}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
