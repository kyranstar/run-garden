/**
 * THE ORACLE (Phase 2c plan Task 4; Audit 2c-A MINOR-1): the import's progress numbers are the standalone tool's own
 * `Stats` (its js/stats.js), run over the sessions in the tool's own shape — so the owner can hold them against the
 * tool's Progress tab. These are the standalone `tests/stats.test.js` expectations, ported as they are, plus the parts
 * of the tool's rules that the first port missed: volume counts only entries the tool logs as load × reps, every
 * logged set with a weight and reps counts (the tool has no "done" rule), and the weekly volume is whole kilos.
 */
import { describe, expect, test } from "vitest";
import { Stats, type ToolSession } from "../src/services/standalone-stats.js";

const lb = (v: number) => ({ v, u: "lb" as const });
const kg = (v: number) => ({ v, u: "kg" as const });

// The standalone suite's own session helper.
function session(date: string, extra: Partial<ToolSession> & Record<string, unknown> = {}): ToolSession {
  return { id: `s-${date}`, date, startedAt: `${date}T18:00:00`, seconds: 1800, pre: 2, post: 1, entries: [], ...extra } as ToolSession;
}

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
    expect(Stats.sessionVolumeKg(s, "lb")).toBe(12 * 8 + 12 * 6 + 10 * 10 * 2);
  });

  test("v2 entries count both sides when perSide is set", () => {
    const s = session("2026-09-29", { entries: [{ id: "supportedRow", log: "load", metric: "reps", perSide: true, sets: [{ w: kg(10), reps: 10, secs: null }] }] });
    expect(Stats.sessionVolumeKg(s, "lb")).toBe(200);
  });

  test("weekly buckets sessions, minutes, and volume, oldest week first", () => {
    const sessions = [
      session("2026-09-14"),
      session("2026-09-22", { seconds: 900 }),
      session("2026-09-24"),
      session("2026-09-29", { entries: [{ id: "deadlift", log: "load", metric: "reps", bilateral: false, sets: [{ w: kg(10), reps: 10 }] }] }),
    ];
    const weeks = Stats.weekly(sessions, 3, "2026-09-29", "lb");
    expect(weeks.map((w) => w.week)).toEqual(["2026-09-14", "2026-09-21", "2026-09-28"]);
    expect(weeks.map((w) => w.sessions)).toEqual([1, 2, 1]);
    expect(weeks.map((w) => w.minutes)).toEqual([30, 45, 30]);
    expect(weeks.map((w) => w.volumeKg)).toEqual([0, 0, 100]);
  });

  test("lifts builds a per-exercise series of the top set per session", () => {
    const sessions = [
      session("2026-09-01", { entries: [{ id: "gobletSquat", log: "load", metric: "reps", sets: [{ w: lb(20), reps: 8 }, { w: lb(25), reps: 5 }] }] }),
      session("2026-09-08", { entries: [{ id: "gobletSquat", log: "load", metric: "reps", sets: [{ w: lb(25), reps: 7 }] }, { id: "tempoSquat", log: "reps", metric: "reps", sets: [{ w: null, reps: 12 }] }] }),
    ];
    const lifts = Stats.lifts(sessions, "lb");
    const goblet = lifts.find((l) => l.id === "gobletSquat")!;
    expect(goblet.points).toHaveLength(2);
    expect(goblet.points[0]!.top).toEqual(lb(25));
    expect(goblet.points[0]!.reps).toBe(5);
    expect(goblet.points[1]!.reps).toBe(7);
    const tempo = lifts.find((l) => l.id === "tempoSquat")!;
    expect(tempo.points[0]!.top).toBeNull();
    expect(tempo.points[0]!.reps).toBe(12);
  });

  test("lifts tracks hold times, and skips ladders and null sets", () => {
    const sessions = [
      session("2026-09-01", { entries: [{ id: "sidePlankKnees", log: "time", metric: "time", sets: [{ w: null, reps: null, secs: 25 }, null] }] }),
      session("2026-09-08", { entries: [{ id: "sidePlankKnees", log: "time", metric: "time", sets: [{ w: null, reps: null, secs: 30 }] }, { id: "gobletSquat", format: "ladder", log: "load", metric: "reps", sets: [{ w: lb(25), reps: 2 }] }] }),
    ];
    const lifts = Stats.lifts(sessions, "lb");
    expect(lifts.find((l) => l.id === "sidePlankKnees")!.points.map((p) => p.secs)).toEqual([25, 30]);
    expect(lifts.find((l) => l.id === "gobletSquat")).toBeUndefined();
  });
});

describe("the tool's rules the first port missed (Audit 2c-A MINOR-1)", () => {
  test("weekly volume is whole kilos — 25 lb × 8 is 91 kg in the tool, never 90.7", () => {
    const s = session("2026-09-29", { entries: [{ id: "gobletSquat", log: "load", metric: "reps", bilateral: false, sets: [{ w: lb(25), reps: 8 }] }] });
    expect(Stats.sessionVolumeKg(s, "lb")).toBeCloseTo(25 * 8 * 0.45359237, 9);
    expect(Stats.weekly([s], 1, "2026-09-29", "lb")[0]!.volumeKg).toBe(91);
  });

  test("only entries logged as load × reps count: no log and metric, or another pair, counts nothing", () => {
    const s = session("2026-09-29", {
      entries: [
        { id: "gobletSquat", sets: [{ w: kg(20), reps: 8 }] },
        { id: "tempoSquat", log: "reps", metric: "reps", sets: [{ w: kg(5), reps: 10 }] },
        { id: "suitcaseCarry", log: "load", metric: "time", sets: [{ w: kg(16), reps: 3 }] },
      ],
    });
    expect(Stats.sessionVolumeKg(s, "lb")).toBe(0);
  });

  test("a set the tool kept with a weight and reps counts whether or not it was marked done", () => {
    const s = session("2026-09-29", { entries: [{ id: "deadlift", log: "load", metric: "reps", sets: [{ w: kg(20), reps: 5, done: false }, { w: kg(10), reps: 5 }] }] });
    expect(Stats.sessionVolumeKg(s, "lb")).toBe(150);
  });

  test("perSide wins over bilateral when both are written, as the tool reads them", () => {
    const s = session("2026-09-29", { entries: [{ id: "supportedRow", log: "load", metric: "reps", perSide: false, bilateral: true, sets: [{ w: kg(10), reps: 10 }] }] });
    expect(Stats.sessionVolumeKg(s, "lb")).toBe(100);
  });

  test("a bare number is a weight in the tool's unit", () => {
    const s = session("2026-09-29", { entries: [{ id: "deadlift", log: "load", metric: "reps", sets: [{ w: 10, reps: 10 }] }] });
    expect(Stats.sessionVolumeKg(s, "kg")).toBe(100);
    expect(Stats.sessionVolumeKg(s, "lb")).toBeCloseTo(100 * 0.45359237, 9);
  });

  test("volume as the Progress tab shows it: whole, in the tool's unit, from the whole kilos", () => {
    expect(Stats.volumeInUnit(100, "kg")).toBe(100);
    expect(Stats.volumeInUnit(100, "lb")).toBe(220);
    expect(Stats.volumeInUnit(0, "lb")).toBe(0);
  });
});
