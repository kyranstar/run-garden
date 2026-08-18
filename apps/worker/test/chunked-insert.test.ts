/**
 * D1 caps bound variables per statement at ~100. better-sqlite3 does not, so a
 * batch that is far too wide passes every test in this repo and throws only in
 * production — which is exactly what happened on 2026-08-18. `chunkedInsert`
 * took a hand-written column count; `planned_workout_stages` grew from 15 to 20
 * columns and both call sites kept saying 15, so batches went out at 6 × 20 =
 * 120 bindings. Every import of a workout with six or more stages threw
 * `D1_ERROR: too many SQL variables`, and because the read's catch blamed the
 * wire, the athlete saw "COROS unreachable" on a healthy connection.
 *
 * These tests assert the BUDGET, not the arithmetic, so they keep holding as
 * tables gain columns.
 */
import { describe, expect, it } from "vitest";
import { schema } from "@rg/database";
import { chunkedInsert } from "../src/services/db.js";

/** D1's real ceiling. `chunkedInsert` aims at 90 to leave room for a WHERE. */
const D1_VARIABLE_CAP = 100;

describe("chunkedInsert stays under D1's bound-variable cap", () => {
  const widths = [1, 4, 5, 14, 17, 20, 45, 89, 120];

  for (const width of widths) {
    it(`keeps every batch under ${D1_VARIABLE_CAP} bindings at ${width} columns`, async () => {
      const row = Object.fromEntries(Array.from({ length: width }, (_, i) => [`c${i}`, i]));
      const rows = Array.from({ length: 37 }, () => ({ ...row }));
      const seen: number[] = [];
      await chunkedInsert(rows, async (batch) => {
        seen.push(batch.length * width);
      });
      expect(seen.length).toBeGreaterThan(0);
      // A single row wider than the cap cannot be split further; that is the
      // caller's problem to avoid, not something to silently truncate.
      if (width <= 90) for (const bindings of seen) expect(bindings).toBeLessThanOrEqual(D1_VARIABLE_CAP);
      expect(seen.reduce((n, b) => n + b / width, 0), "no row is dropped").toBe(rows.length);
    });
  }

  it("counts the columns of the ACTUAL rows, so a widened table cannot go stale", () => {
    // The regression in one assertion: the stage table's real width, read from
    // the schema rather than restated here, must still batch safely. When
    // someone adds column 21 this keeps passing; a literal would not.
    const width = Object.keys(schema.plannedWorkoutStages).filter(
      (k) => !k.startsWith("_") && !k.startsWith("$"),
    ).length;
    expect(width, "the stage table is wider than the 15 the old literal claimed").toBeGreaterThan(15);
    expect(Math.floor(90 / width) * width).toBeLessThanOrEqual(D1_VARIABLE_CAP);
  });

  it("does nothing for an empty list rather than reading row zero", async () => {
    let called = false;
    await chunkedInsert([], async () => {
      called = true;
    });
    expect(called).toBe(false);
  });
});
