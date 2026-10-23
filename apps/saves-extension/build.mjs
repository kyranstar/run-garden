// Builds the unpacked extension into dist/: esbuild bundles the scripts, the manifest is copied with the app origin
// (APP_ORIGIN, default the production API) filled into its host permissions, and the html pages are copied beside them.
// Load dist/ at chrome://extensions ("Load unpacked").
import { build } from "esbuild";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");
const DEFAULT_APP_ORIGIN = "https://run-garden-api.kyranadams.workers.dev";
const PLACEHOLDER = "__APP_ORIGIN__/*";

const appOrigin = new URL(process.env.APP_ORIGIN || DEFAULT_APP_ORIGIN).origin;

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: {
    background: join(src, "background.ts"),
    options: join(src, "options.ts"),
    popup: join(src, "popup.ts"),
  },
  outdir: dist,
  bundle: true,
  // A classic (non-module) service worker and page scripts. No minify and no keepNames: `pageFetch` is sent to the
  // page as source text and must stay self-contained.
  format: "iife",
  platform: "browser",
  target: "chrome120",
  legalComments: "none",
  define: { __APP_ORIGIN__: JSON.stringify(appOrigin) },
  logLevel: "warning",
});

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
if (!manifest.host_permissions.includes(PLACEHOLDER)) throw new Error(`manifest.json lost its ${PLACEHOLDER} host permission`);
manifest.host_permissions = manifest.host_permissions.map((p) => (p === PLACEHOLDER ? `${appOrigin}/*` : p));
await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

for (const file of await readdir(src)) {
  if (file.endsWith(".html") || file.endsWith(".css")) await copyFile(join(src, file), join(dist, file));
}

console.log(`saves-extension: dist/ built for ${appOrigin}`);
