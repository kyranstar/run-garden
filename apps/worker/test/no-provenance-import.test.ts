/**
 * PROVENANCE STAYS PRIVATE (Phase 2c plan, Global Constraints): the public repository never carries a saved post's
 * link, a creator's handle or a social site's name. The library package and the standalone import's synthetic
 * fixtures and tests are grepped for them line by line. (The library's own validation already refuses provenance in
 * a record; this covers every file, including the import's.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
// Assembled from parts so this guard does not match itself.
const LINK = new RegExp(["h" + "ttps?:", "w" + "ww\\.", ["insta", "gram"].join(""), ["tik", "tok"].join(""), ["you", "tube"].join("")].join("|"), "i");
// A handle: "@" and a name, not a package scope ("@rg/…") and not a decorator-free TS construct.
const HANDLE = /(^|[^\w])@(?!rg\/|tanstack\/|types\/)[A-Za-z0-9_.]{2,}/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

const GUARDED = [
  ...files(join(ROOT, "packages", "exercise-library", "src")),
  join(ROOT, "apps", "worker", "test", "fixtures", "standalone-backup.ts"),
  join(ROOT, "apps", "worker", "test", "fixtures", "standalone-oracle-case.ts"),
  join(ROOT, "apps", "worker", "test", "standalone-import.test.ts"),
  join(ROOT, "apps", "worker", "test", "standalone-stats.test.ts"),
  // The saved-post links: the builder reads private files from paths it is given and names none; its tests and the
  // import's are synthetic.
  join(ROOT, "apps", "worker", "scripts", "build-provenance.mjs"),
  join(ROOT, "apps", "worker", "test", "build-provenance.test.ts"),
  join(ROOT, "apps", "worker", "test", "provenance-import.test.ts"),
];

test("the library package and the import's fixtures hold no links, handles or social site names", () => {
  expect(GUARDED.length).toBeGreaterThan(10);
  const hits: string[] = [];
  for (const file of GUARDED) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        // The library's own guard spells the words out in parts; a line that assembles them is not provenance.
        if (/\.join\(""\)/.test(line)) return;
        if (LINK.test(line) || HANDLE.test(line)) hits.push(`${file.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
      });
  }
  expect(hits).toEqual([]);
});

test("the guard catches what it is for", () => {
  for (const bad of ["see h" + "ttps://example.test/p/1", "w" + "ww.example.test", "by @some_creator", ["insta", "gram"].join("") + " post"]) {
    expect(LINK.test(bad) || HANDLE.test(bad), bad).toBe(true);
  }
  for (const fine of ['import { z } from "zod";', 'import { x } from "@rg/domain";', "a@b"]) {
    expect(LINK.test(fine) || HANDLE.test(fine), fine).toBe(false);
  }
});
