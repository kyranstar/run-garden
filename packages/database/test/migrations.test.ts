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

/**
 * The one-workout-system model (Phase 1 spec §6) ships additive: nothing
 * existing changes, so the deploy can go out ahead of any reader and roll
 * back by redeploying the previous Worker. Every statement either creates a
 * new table or index, or adds a column SQLite can add in place — nullable,
 * or NOT NULL with a constant default; never a PRIMARY KEY or UNIQUE column,
 * which would need a table rebuild.
 */
describe("Phase 1 migrations (0024–0027) are expand-only", () => {
  const phase1 = [
    "0024_programs.sql",
    "0025_planned_session_columns.sql",
    "0026_performed_sessions.sql",
    "0027_exercise_settings.sql",
  ];
  const statements = (f: string): string[] =>
    readFileSync(join(dir, f), "utf8")
      .split("--> statement-breakpoint")
      .map((s) =>
        s
          .split("\n")
          .filter((line) => !line.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((s) => s.length > 0);

  it("exist on disk", () => {
    for (const f of phase1) expect(files, f).toContain(f);
  });

  it("only create tables and indexes, or add columns", () => {
    for (const f of phase1) {
      for (const s of statements(f)) {
        expect(s, `${f}: ${s.slice(0, 60)}`).toMatch(
          /^(CREATE TABLE `\w+`|CREATE (UNIQUE )?INDEX `\w+` ON `\w+`|ALTER TABLE `\w+` ADD `\w+`)/,
        );
        expect(s, f).not.toMatch(/\b(DROP|RENAME|DELETE|UPDATE|INSERT)\b/i);
      }
    }
  });

  it("adds only columns SQLite can add without rebuilding the table", () => {
    for (const f of phase1) {
      for (const s of statements(f).filter((x) => x.startsWith("ALTER TABLE"))) {
        expect(s, f).not.toMatch(/PRIMARY KEY|UNIQUE/i);
        if (/NOT NULL/i.test(s)) expect(s, f).toMatch(/DEFAULT\s+('[^']*'|-?\d+)/i);
      }
    }
  });

  it("each statement is one statement (a breakpoint between every pair)", () => {
    for (const f of phase1) {
      for (const s of statements(f)) {
        expect(s.replace(/;\s*$/, ""), `${f}: ${s.slice(0, 60)}`).not.toContain(";");
      }
    }
  });
});
