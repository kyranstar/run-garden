/**
 * Migrations are hand-authored (drizzle-kit's journal stops at 0016 by
 * design), so nothing else checks their shape. These are the mistakes that
 * slip through a hand-numbered directory: a gap, two files claiming one
 * number, an empty file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../migrations", import.meta.url));
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

describe("migrations directory", () => {
  it("only holds NNNN_name.sql files", () => {
    for (const f of files) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
  });

  it("has no duplicate numeric prefix", () => {
    const prefixes = files.map((f) => f.slice(0, 4));
    expect(prefixes.filter((p, i) => prefixes.indexOf(p) !== i)).toEqual([]);
  });

  it("is numbered contiguously from 0000", () => {
    const prefixes = files.map((f) => Number(f.slice(0, 4)));
    expect(prefixes).toEqual(prefixes.map((_, i) => i));
  });

  it("has no empty file", () => {
    for (const f of files) {
      expect(readFileSync(join(dir, f), "utf8").trim().length, f).toBeGreaterThan(0);
    }
  });
});
