import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The engine never names a condition profile: every condition word comes from a profile in the library
// (Phase 1 spec §4.1). This reads every source file, comments included.

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

test("no engine source file mentions a condition by name", () => {
  const all = files(src);
  expect(all.length).toBeGreaterThan(0);
  const hits: string[] = [];
  for (const file of all) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/tmj|jaw|clench/i.test(line)) hits.push(`${relative(src, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  expect(hits).toEqual([]);
});
