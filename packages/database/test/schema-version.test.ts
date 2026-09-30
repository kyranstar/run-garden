/**
 * SCHEMA_VERSION is what an export file is stamped with and what a restore
 * checks before it touches anything. The Worker cannot read the migrations
 * directory at runtime, so the value is a constant — and this test is what
 * keeps the constant honest: adding migration NNNN without bumping it fails
 * here, not in a restore that silently accepts a file from another schema.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/index.js";

describe("SCHEMA_VERSION", () => {
  it("equals the highest numbered migration on disk", () => {
    const dir = fileURLToPath(new URL("../migrations", import.meta.url));
    const prefixes = readdirSync(dir)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => f.slice(0, 4))
      .sort();
    expect(prefixes.length).toBeGreaterThan(0);
    expect(SCHEMA_VERSION).toBe(prefixes[prefixes.length - 1]);
  });
});
