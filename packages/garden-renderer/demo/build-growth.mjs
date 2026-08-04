/**
 * Bundle the garden growth sampler (packages/garden-renderer/demo/growth.tsx)
 * into a single self-contained HTML file with esbuild. React, the garden
 * engine, and the SVG renderer are all inlined — the output opens with a
 * double-click, no server. Used by shoot-growth.mjs to step through every
 * simulated day and assemble docs/images/garden-growth.gif.
 *
 *   node packages/garden-renderer/demo/build-growth.mjs [outfile.html]
 */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const out = process.argv[2] ?? "/tmp/garden-growth.html";

// esbuild is a transitive dep (not hoisted to this package); resolve its Node
// API from the pnpm store, newest version.
const esbuildMain = execSync(
  `find "${root}/node_modules/.pnpm" -maxdepth 6 -path "*/esbuild/lib/main.js" | sort -V | tail -1`,
)
  .toString()
  .trim();
if (!esbuildMain) throw new Error("esbuild not found under node_modules/.pnpm");
const esbuild = await import(pathToFileURL(esbuildMain).href);

const result = await esbuild.build({
  entryPoints: [join(here, "growth.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".ts": "ts", ".tsx": "tsx" },
  target: ["es2020"],
  write: false,
});
const js = result.outputFiles[0].text;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Run Garden — day-by-day growth</title>
<style>
  :root{ --border:#e4e0cf; }
  *{box-sizing:border-box}
  html,body{margin:0;background:#f4f1e6}
  #stage{display:inline-block}
  .scene-frame{border-radius:0;overflow:hidden;background:#cfe0e8;border:0;position:relative}
  .scene-frame svg{display:block}
  .day-badge{
    position:absolute;top:12px;right:14px;
    font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;
    letter-spacing:.02em;color:#2b3327;
    background:rgba(251,250,243,.72);backdrop-filter:blur(2px);
    padding:3px 10px;border-radius:999px;border:1px solid rgba(43,51,39,.12);
  }
</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;

writeFileSync(out, html);
const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(`Wrote ${out} (${kb} KB)`);
