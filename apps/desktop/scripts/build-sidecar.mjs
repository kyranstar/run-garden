/**
 * Package the COROS bridge as a Tauri sidecar binary.
 *
 * Tauri resolves external binaries by a platform-target triple suffix, e.g.
 * `coros-bridge-aarch64-apple-darwin`. This script compiles the bridge into a
 * self-contained executable and copies it into src-tauri/binaries with the
 * right suffix. Requires Bun (for `bun build --compile`) or falls back to a
 * Node single-executable note.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const binaries = join(root, "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });

function targetTriple() {
  const raw = execSync("rustc -vV", { encoding: "utf8" });
  const m = raw.match(/host: (\S+)/);
  if (!m) throw new Error("Could not determine host target triple from rustc.");
  return m[1];
}

const triple = targetTriple();
const bridgeDir = join(root, "..", "..", "services", "coros-bridge");
const outName = process.platform === "win32" ? "coros-bridge.exe" : "coros-bridge";
const dest = join(binaries, `coros-bridge-${triple}${process.platform === "win32" ? ".exe" : ""}`);

if (existsSync(join(bridgeDir, "dist", outName))) {
  copyFileSync(join(bridgeDir, "dist", outName), dest);
  console.log(`Copied prebuilt bridge → ${dest}`);
} else {
  try {
    // Preferred: Bun single-file compile (bundles Node deps).
    execSync(`bun build src/main.ts --compile --outfile "${dest}"`, {
      cwd: bridgeDir,
      stdio: "inherit",
    });
    console.log(`Compiled bridge with Bun → ${dest}`);
  } catch {
    console.error(
      "Could not compile the bridge sidecar automatically.\n" +
        "Install Bun (https://bun.sh) and re-run, or build the bridge with your\n" +
        "preferred Node single-executable tool and place it at:\n  " +
        dest,
    );
    process.exit(1);
  }
}
