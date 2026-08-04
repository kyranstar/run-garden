/**
 * Step the growth sampler (built by build-growth.mjs) through every
 * simulated day, screenshot each one, and assemble the sequence straight
 * into docs/images/garden-growth.gif — a day-by-day timelapse of the SAME
 * real garden engine used by the app, held at a fixed golden-hour/summer
 * look so only the garden itself changes frame to frame.
 *
 *   node packages/garden-renderer/demo/build-growth.mjs
 *   node packages/garden-renderer/demo/shoot-growth.mjs
 *
 * Resolves @playwright/test the same throwaway way shoot-matrix.mjs does,
 * directly off apps/web's node_modules (its cached chromium build), since
 * @playwright/test isn't a dependency of this package.
 *
 * Frames are captured as PNG screenshot buffers in memory — never written to
 * disk — then decoded to raw RGBA with pngjs (a devDependency here) and
 * handed to gifenc (also a devDependency here; there's no system GIF/video
 * encoder on this machine). One shared palette is quantized from a spread of
 * frames across the whole sequence so color stays consistent through the
 * loop and every frame after the first can reuse the same global color
 * table instead of carrying its own.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { PNG } from "pngjs";
// gifenc ships CJS-only (no "exports" map, no ESM named exports) — import the
// default and destructure instead of `import { GIFEncoder } from "gifenc"`.
import gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const OUT = join(root, "docs", "images", "garden-growth.gif");
const HTML = process.argv[2] ?? "/tmp/garden-growth.html";

const DELAY_MS = 175; // target ~150-200ms/frame
const SETTLE_MS = 220; // per-frame wait: layout + growth diff + atmosphere redraw
const PALETTE_SAMPLE_FRAMES = 15; // spread across the whole run, not every frame

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

async function run() {
  if (!existsSync(HTML)) {
    throw new Error(`${HTML} not found — run build-growth.mjs first`);
  }
  mkdirSync(dirname(OUT), { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 780, height: 480 } });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(`file://${HTML}`, { waitUntil: "load" });
  // Let the atmosphere canvas start drawing and settle on day 0 before the
  // first shot.
  await page.waitForTimeout(1200);

  const frameCount = await page.evaluate(() => window.__growth?.frameCount ?? 0);
  if (!frameCount) throw new Error("window.__growth not found — did growth.tsx mount?");

  const locator = page.locator("#growth-frame");
  const shots = [];
  for (let day = 0; day < frameCount; day++) {
    await page.evaluate((d) => window.__growth.setDay(d), day);
    await page.waitForFunction(
      (d) => document.getElementById("growth-frame")?.dataset.day === String(d),
      day,
    );
    await page.waitForTimeout(SETTLE_MS);
    shots.push(await locator.screenshot());
    if ((day + 1) % 10 === 0 || day === frameCount - 1) {
      console.log(`captured ${day + 1}/${frameCount}`);
    }
  }
  await browser.close();

  // Decode every PNG to raw RGBA.
  const decoded = shots.map((buf) => PNG.sync.read(buf));
  const { width, height } = decoded[0];
  for (const d of decoded) {
    if (d.width !== width || d.height !== height) {
      throw new Error(`frame size mismatch: ${d.width}x${d.height} vs ${width}x${height}`);
    }
  }

  // Build one shared global palette from a spread of frames across the whole
  // sequence (not all of them — quantizing every pixel of every frame is
  // unnecessary work for a smoothly-changing scene like this one).
  const stride = Math.max(1, Math.floor(decoded.length / PALETTE_SAMPLE_FRAMES));
  const sampleIdx = new Set();
  for (let i = 0; i < decoded.length; i += stride) sampleIdx.add(i);
  sampleIdx.add(decoded.length - 1);
  const samples = [...sampleIdx].map((i) => decoded[i].data);
  const combined = new Uint8Array(samples.reduce((n, d) => n + d.length, 0));
  let off = 0;
  for (const d of samples) {
    combined.set(d, off);
    off += d.length;
  }
  const palette = quantize(combined, 256);

  const gif = GIFEncoder();
  decoded.forEach((d, i) => {
    const index = applyPalette(d.data, palette);
    gif.writeFrame(index, width, height, {
      palette: i === 0 ? palette : undefined,
      delay: DELAY_MS,
      repeat: 0,
      first: i === 0,
    });
  });
  gif.finish();

  const bytes = gif.bytes();
  writeFileSync(OUT, bytes);
  const kb = Math.round(bytes.length / 1024);
  console.log(`Wrote ${OUT} (${frameCount} frames, ${width}x${height}, ${kb} KB)`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
