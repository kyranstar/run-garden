/**
 * Bundle the garden state-matrix sampler (packages/garden-renderer/demo/matrix.tsx)
 * into a single self-contained HTML file with esbuild. React, the garden engine,
 * and the SVG renderer are all inlined — the output opens with a double-click,
 * no server. Used by shoot-matrix.mjs to screenshot each of the 18 signature
 * states into docs/images/matrix/*.png.
 *
 *   node packages/garden-renderer/demo/build-matrix.mjs [outfile.html]
 */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const out = process.argv[2] ?? "/tmp/garden-matrix.html";

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
  entryPoints: [join(here, "matrix.tsx")],
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
<title>Run Garden — state matrix</title>
<style>
  :root{
    --bg:#f4f1e6; --panel:#fbfaf3; --ink:#2b3327; --muted:#5d6b57; --faint:#8b9683;
    --green-ink:#38612c; --border:#e4e0cf;
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#171b16; --panel:#1e231c; --ink:#e7ecdf; --muted:#a7b39c; --faint:#77836c;
      --green-ink:#b6d99a; --border:#2c3328;}
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1000px;margin:0 auto;padding:28px 20px 64px}
  .hero{text-align:center;padding:8px 8px 20px}
  .hero h1{margin:.1em 0 .12em;font-size:1.8rem;letter-spacing:-.02em;color:var(--green-ink)}
  .tagline{max-width:640px;margin:0 auto;color:var(--muted)}
  .grid{display:flex;flex-direction:column;gap:28px;align-items:center}
  .cell{margin:0}
  .scene-frame{border-radius:10px;overflow:hidden;background:#cfe0e8;border:1px solid var(--border);position:relative}
  .scene-frame svg{display:block}
  figcaption{margin-top:8px;text-align:center;font-size:.82rem;color:var(--faint);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
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
