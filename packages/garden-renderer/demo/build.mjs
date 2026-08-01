/**
 * Bundle the garden demo (packages/garden-renderer/demo/index.tsx) into a single
 * self-contained HTML file with esbuild. React, the garden engine, and the SVG
 * renderer are all inlined — the output opens with a double-click, no server.
 *
 *   node packages/garden-renderer/demo/build.mjs [outfile.html]
 */
import { writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const out =
  process.argv[2] ?? join(process.env.HOME ?? ".", "Downloads", "run-garden-garden-demo.html");

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
  entryPoints: [join(here, "index.tsx")],
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
<title>Run Garden — the living garden</title>
<style>
  :root{
    --bg:#f4f1e6; --panel:#fbfaf3; --ink:#2b3327; --muted:#5d6b57; --faint:#8b9683;
    --green:#5c8a4a; --green-ink:#38612c; --border:#e4e0cf; --shadow:0 1px 3px rgba(40,50,30,.08),0 8px 24px rgba(40,50,30,.06);
  }
  @media (prefers-color-scheme: dark){
    :root{ --bg:#171b16; --panel:#1e231c; --ink:#e7ecdf; --muted:#a7b39c; --faint:#77836c;
      --green:#8fc06e; --green-ink:#b6d99a; --border:#2c3328; --shadow:0 1px 3px rgba(0,0,0,.3),0 10px 30px rgba(0,0,0,.25);}
  }
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1120px;margin:0 auto;padding:28px 20px 64px}
  .hero{text-align:center;padding:24px 8px 8px}
  .hero .leaf{font-size:38px}
  .hero h1{margin:.1em 0 .12em;font-size:2.3rem;letter-spacing:-.02em;color:var(--green-ink)}
  .tagline{max-width:640px;margin:0 auto;color:var(--muted)}
  .motion{display:inline-flex;gap:.5rem;align-items:center;margin-top:14px;color:var(--muted);font-size:.9rem;cursor:pointer}
  .panel{background:var(--panel);border:1px solid var(--border);border-radius:18px;box-shadow:var(--shadow);padding:20px;margin-top:26px}
  .panel-head h2{margin:0 0 .1em;font-size:1.3rem;color:var(--green-ink)}
  .muted{color:var(--muted)} .faint{color:var(--faint);font-size:.82rem}
  .panel-head .muted{margin:0}
  .scene-frame{border-radius:14px;overflow:hidden;background:#cfe0e8;border:1px solid var(--border)}
  .scene-frame.big{margin-top:14px}
  .scene-frame svg{display:block}
  .stats{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0 4px}
  .stat{flex:1 1 120px;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:10px 12px;text-align:center}
  .stat-value{font-weight:680;font-size:1.05rem;color:var(--ink)}
  .stat-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);margin-top:2px}
  .controls{display:flex;align-items:center;gap:14px;margin-top:12px}
  .play{flex:0 0 auto;border:1px solid var(--border);background:var(--green);color:#fff;font-weight:640;padding:10px 18px;border-radius:11px;cursor:pointer;font-size:.95rem}
  .play:hover{filter:brightness(1.05)}
  .scrub{flex:1 1 auto;accent-color:var(--green);height:26px}
  .tod-label{flex:0 0 auto;color:var(--muted);font-size:.9rem;white-space:nowrap}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;margin-top:16px}
  .card{margin:0;background:var(--bg);border:1px solid var(--border);border-radius:14px;overflow:hidden}
  .card figcaption{padding:11px 13px}
  .card-title{font-weight:660;color:var(--ink)}
  .foot{text-align:center;color:var(--faint);font-size:.85rem;margin-top:32px}
  a{color:var(--green-ink)}
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
