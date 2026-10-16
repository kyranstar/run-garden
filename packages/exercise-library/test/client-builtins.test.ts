import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

// The library runs in the browser (the Studio searches it on every keystroke, offline too), and the web build does not
// polyfill built-ins: a method newer than the phones the app supports throws there. Object.hasOwn, Array#at and
// structuredClone arrived in Safari 15.4; findLast in 15.4; toSorted and friends in 16. Use the older forms.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const NEWER = /\bObject\.hasOwn\s*\(|\.at\(\s*-?\d|\bstructuredClone\s*\(|\.findLast(Index)?\s*\(|\.to(Sorted|Reversed|Spliced)\s*\(|\.with\(\s*-?\d/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("the library's source uses no built-in newer than the supported phones", () => {
  const found = files(SRC).flatMap((f) =>
    readFileSync(f, "utf8").split("\n").flatMap((line, i) => (NEWER.test(line) ? [`${relative(SRC, f)}:${i + 1}: ${line.trim()}`] : [])),
  );
  expect(found).toEqual([]);
});
