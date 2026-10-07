/**
 * THE ORACLE (Phase 2c plan Task 4): the import's progress numbers are the standalone tool's own `Stats`, so the owner
 * can hold them against the tool's Progress tab. These are the standalone `tests/stats.test.js` expectations, ported
 * over the import's normaliser — a session goes in in the tool's own shape (pass 1 or version 2) and comes out in
 * Run Garden's, and the numbers must not move. Only what the import reports is ported: week starts, day arithmetic,
 * session volume (per side ×2) and the weekly buckets.
 */
import { describe, expect, test } from "vitest";
import { EXERCISES } from "@rg/exercise-library";
import { normalizeStandaloneSession, standaloneContext } from "../src/services/standalone-import.js";
import { Stats } from "../src/services/standalone-stats.js";

const lb = (v: number) => ({ v, u: "lb" });
const kg = (v: number) => ({ v, u: "kg" });

// The standalone suite's own session helper.
function session(date: string, extra: Record<string, unknown> = {}) {
  return { id: `s-${date}`, date, startedAt: `${date}T18:00:00`, seconds: 1800, pre: 2, post: 1, entries: [], ...extra };
}

const ctx = standaloneContext({ exercises: EXERCISES, timezone: "America/New_York", unit: "lb" });
const normal = (raw: unknown) => {
  const out = normalizeStandaloneSession(raw, `p-${(raw as { id: string }).id}`, ctx);
  if (!out.ok) throw new Error(out.reason);
  return out.session;
};

describe("Stats (standalone tests/stats.test.js)", () => {
  test("weekStart snaps to Monday", () => {
    expect(Stats.weekStart("2026-09-29")).toBe("2026-09-28"); // Tuesday → Monday
    expect(Stats.weekStart("2026-09-28")).toBe("2026-09-28"); // Monday
    expect(Stats.weekStart("2026-10-04")).toBe("2026-09-28"); // Sunday → previous Monday
  });

  test("addDays crosses month boundaries", () => {
    expect(Stats.addDays("2026-09-29", 3)).toBe("2026-10-02");
    expect(Stats.addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  test("sessionVolumeKg counts rep-based loaded sets, doubling bilateral lifts", () => {
    const s = session("2026-09-29", {
      entries: [
        { id: "gobletSquat", log: "load", metric: "reps", bilateral: false, sets: [{ w: kg(12), reps: 8 }, { w: kg(12), reps: 6 }] },
        { id: "supportedRow", log: "load", metric: "reps", bilateral: true, sets: [{ w: kg(10), reps: 10 }] },
        { id: "suitcaseCarry", log: "load", metric: "time", bilateral: true, sets: [{ w: kg(16), reps: null }] },
        { id: "tempoSquat", log: "reps", metric: "reps", bilateral: false, sets: [{ w: null, reps: 12 }] },
      ],
    });
    expect(Stats.sessionVolumeKg(normal(s))).toBe(12 * 8 + 12 * 6 + 10 * 10 * 2);
  });

  test("v2 entries count both sides when perSide is set", () => {
    const s = session("2026-09-29", { entries: [{ id: "supportedRow", log: "load", metric: "reps", perSide: true, sets: [{ w: kg(10), reps: 10, secs: null }] }] });
    expect(Stats.sessionVolumeKg(normal(s))).toBe(200);
  });

  test("weekly buckets sessions, minutes, and volume, oldest week first", () => {
    const sessions = [
      session("2026-09-14"),
      session("2026-09-22", { seconds: 900 }),
      session("2026-09-24"),
      session("2026-09-29", { entries: [{ id: "deadlift", log: "load", metric: "reps", bilateral: false, sets: [{ w: kg(10), reps: 10 }] }] }),
    ].map(normal);
    const weeks = Stats.weekly(sessions, 3, "2026-09-29");
    expect(weeks.map((w) => w.week)).toEqual(["2026-09-14", "2026-09-21", "2026-09-28"]);
    expect(weeks.map((w) => w.sessions)).toEqual([1, 2, 1]);
    expect(weeks.map((w) => w.minutes)).toEqual([30, 45, 30]);
    expect(weeks.map((w) => w.volumeKg)).toEqual([0, 0, 100]);
  });

  test("pounds count at the exact definition, and the volume keeps one decimal", () => {
    const s = session("2026-09-29", { entries: [{ id: "gobletSquat", bilateral: false, sets: [{ w: lb(25), reps: 8 }] }] });
    expect(Stats.sessionVolumeKg(normal(s))).toBeCloseTo(25 * 8 * 0.45359237, 9);
    expect(Stats.weekly([normal(s)], 1, "2026-09-29")[0]!.volumeKg).toBe(90.7);
  });
});
