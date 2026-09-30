import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { EXERCISES, LOCATION_PRESETS } from "../src/index.js";

// Provenance is private (spec §3.1, §6): the public library never carries a link, a creator handle, or a
// sources field, and location presets carry no implement weights.

const here = dirname(fileURLToPath(import.meta.url));
const exercisesDir = join(here, "..", "src", "exercises");
// Assembled from parts so the repository-wide privacy grep doesn't match this guard itself.
const FORBIDDEN = new RegExp(["http", "www\\.", ["insta", "gram"].join(""), "@"].join("|"), "i");

test("no file under src/exercises contains a link, a handle, or a social site name", () => {
  const files = readdirSync(exercisesDir).filter(f => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThanOrEqual(10);
  for (const f of files) {
    const lines = readFileSync(join(exercisesDir, f), "utf8").split("\n");
    lines.forEach((line, i) => expect(FORBIDDEN.test(line), `${f}:${i + 1}: ${line.trim()}`).toBe(false));
  }
});

test("no exported record has a sources field or provenance-looking text", () => {
  for (const ex of EXERCISES) {
    expect("sources" in ex, ex.id).toBe(false);
    expect(FORBIDDEN.test(JSON.stringify(ex)), ex.id).toBe(false);
  }
});

test("location presets list gear only, no implement weights", () => {
  for (const loc of LOCATION_PRESETS) expect(Object.keys(loc).sort()).toEqual(["equipment", "id", "name"]);
});
