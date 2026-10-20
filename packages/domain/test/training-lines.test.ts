import { describe, expect, it } from "vitest";
import {
  LINE_GAP_DAYS,
  type LineBlock,
  type TrainingLine,
  type WeekPlan,
  lineSentenceName,
  linesOf,
  planEnded,
  weekNaming,
} from "../src/training-lines.js";

const blk = (id: string, start: string, end: string, o: Partial<LineBlock> = {}): LineBlock => ({
  id,
  discipline: "run",
  status: "active",
  name: id,
  startDate: start,
  endDate: end,
  ...o,
});

describe("linesOf", () => {
  const A = blk("A", "2026-08-03", "2026-08-30");
  const B = blk("B", "2026-08-31", "2026-09-27");
  const C = blk("C", "2026-09-28", "2026-10-25");

  it("chains three abutting blocks into one line; current covers today", () => {
    const [l, ...rest] = linesOf([C, A, B], "2026-10-20");
    expect(rest).toEqual([]);
    expect(l!.phases.map((p) => p.id)).toEqual(["A", "B", "C"]);
    expect(l!.currentPhaseId).toBe("C");
    expect(l!.key).toBe("run:A");
    expect(l!.name).toBe("Running");
    expect(l!.startDate).toBe("2026-08-03");
    expect(l!.endDate).toBe("2026-10-25");
    expect(l!.ended).toBe(false);
  });

  it.each([
    [7, 1],
    [8, 2],
  ])("a gap of %i days gives %i line(s)", (gap, n) => {
    const x = blk("X", "2026-01-01", "2026-01-10");
    const startY = new Date(Date.UTC(2026, 0, 10 + gap)).toISOString().slice(0, 10);
    const y = blk("Y", startY, "2026-03-01");
    expect(linesOf([x, y], "2026-01-05")).toHaveLength(n);
    expect(LINE_GAP_DAYS).toBe(7);
  });

  it("overlapping blocks join, and the running max end is kept", () => {
    const long = blk("L", "2026-01-01", "2026-03-01");
    const inner = blk("I", "2026-01-05", "2026-01-10");
    const late = blk("Z", "2026-03-08", "2026-04-01");
    const lines = linesOf([late, inner, long], "2026-01-06");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.phases.map((p) => p.id)).toEqual(["L", "I", "Z"]);
  });

  it("start date ties sort by id", () => {
    const l = linesOf([blk("b", "2026-01-01", "2026-01-10"), blk("a", "2026-01-01", "2026-01-10")], "2026-01-02");
    expect(l[0]!.phases.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("a retired middle phase: joined when C starts within 7 days of A's end, else two lines", () => {
    const a = blk("A", "2026-01-01", "2026-01-28");
    const mid = blk("M", "2026-01-29", "2026-02-25", { status: "retired" });
    const near = blk("C", "2026-02-04", "2026-03-01");
    const far = blk("C", "2026-02-05", "2026-03-01");
    const joined = linesOf([a, mid, near], "2026-02-10");
    expect(joined).toHaveLength(1);
    expect(joined[0]!.phases.map((p) => p.id)).toEqual(["A", "C"]);
    expect(linesOf([a, mid, far], "2026-02-10")).toHaveLength(2);
  });

  it("different disciplines never join; lines sort by start", () => {
    const lift = blk("L", "2026-01-01", "2026-02-01", { discipline: "lift" });
    const run = blk("R", "2025-12-01", "2026-01-02");
    const mob = blk("M", "2026-01-03", "2026-02-01", { discipline: "mobility" });
    const lines = linesOf([lift, run, mob], "2026-01-05");
    expect(lines.map((l) => l.key)).toEqual(["run:R", "lift:L", "mobility:M"]);
    expect(lines.map((l) => l.name)).toEqual(["Running", "Lifting", "Mobility"]);
  });

  it("today = a phase's start day makes that phase current", () => {
    expect(linesOf([A, B, C], "2026-08-31")[0]!.currentPhaseId).toBe("B");
  });

  it("when overlapping phases both cover today, the later-starting one is current", () => {
    const long = blk("L", "2026-01-01", "2026-03-01");
    const inner = blk("I", "2026-01-05", "2026-01-10");
    expect(linesOf([long, inner], "2026-01-06")[0]!.currentPhaseId).toBe("I");
  });

  it("a one-phase line", () => {
    expect(linesOf([A], "2026-08-10")[0]!.phases).toHaveLength(1);
  });

  it("every phase ended: ended and current is last", () => {
    const [l] = linesOf([A, B, C], "2026-11-01");
    expect(l!.ended).toBe(true);
    expect(l!.currentPhaseId).toBe("C");
  });

  it("before the first starts, current is the first", () => {
    const [l] = linesOf([A, B, C], "2026-07-01");
    expect(l!.currentPhaseId).toBe("A");
    expect(l!.ended).toBe(false);
  });

  it("in a gap between phases, current is the next to start", () => {
    const x = blk("X", "2026-01-01", "2026-01-10");
    const y = blk("Y", "2026-01-15", "2026-02-10");
    expect(linesOf([x, y], "2026-01-12")[0]!.currentPhaseId).toBe("Y");
  });

  it("boundary: today = A.end is A, not ended; the day after is B", () => {
    const a = blk("A", "2026-01-01", "2026-01-10");
    const b = blk("B", "2026-01-11", "2026-01-20");
    const on = linesOf([a, b], "2026-01-10")[0]!;
    expect(on.currentPhaseId).toBe("A");
    expect(on.ended).toBe(false);
    expect(linesOf([a], "2026-01-10")[0]!.ended).toBe(false);
    expect(linesOf([a, b], "2026-01-11")[0]!.currentPhaseId).toBe("B");
    expect(linesOf([a], "2026-01-11")[0]!.ended).toBe(true);
  });

  it("goalRaceDate: the last phase's own race when not past, else null", () => {
    const withRace = blk("B", "2026-08-31", "2026-12-12", { planRaceDate: "2026-12-12" });
    expect(linesOf([A, withRace], "2026-10-20")[0]!.goalRaceDate).toBe("2026-12-12");
    expect(linesOf([A, withRace], "2026-12-12")[0]!.goalRaceDate).toBe("2026-12-12");
    expect(linesOf([A, withRace], "2026-12-13")[0]!.goalRaceDate).toBeNull();
    expect(linesOf([A, { ...B, planRaceDate: null }], "2026-10-20")[0]!.goalRaceDate).toBeNull();
    const earlyRace = blk("E", "2026-10-01", "2026-12-12", { planRaceDate: "2026-11-01" });
    const last = blk("F", "2026-12-13", "2027-01-01");
    expect(linesOf([earlyRace, last], "2026-10-20")[0]!.goalRaceDate).toBeNull();
  });
});

describe("planEnded", () => {
  it("is endDate < today", () => {
    expect(planEnded("2026-10-19", "2026-10-20")).toBe(true);
    expect(planEnded("2026-10-20", "2026-10-20")).toBe(false);
    expect(planEnded("2026-10-21", "2026-10-20")).toBe(false);
  });
});

describe("lineSentenceName", () => {
  it("names each discipline", () => {
    expect(lineSentenceName("run")).toBe("my running plan");
    expect(lineSentenceName("lift")).toBe("my lifting plan");
    expect(lineSentenceName("mobility")).toBe("my mobility plan");
  });
});

describe("weekNaming", () => {
  const wp = (id: string, start: string, end: string, o: Partial<WeekPlan> = {}): WeekPlan => ({
    id,
    discipline: "run",
    startDate: start,
    endDate: end,
    source: "coach",
    ...o,
  });
  const WEEK = "2026-10-12"; // Monday
  const today = "2026-10-12";
  const lineOf = (...b: LineBlock[]): TrainingLine[] => linesOf(b, today);
  const sess = (o: Record<string, number>) => new Map(Object.entries(o));

  const A = blk("A", "2026-09-14", "2026-10-14");
  const B = blk("B", "2026-10-15", "2026-11-14");
  const pa = wp("A", A.startDate, A.endDate);
  const pb = wp("B", B.startDate, B.endDate);

  it("boundary week: names the phase with more sessions; phases are not others", () => {
    const r = weekNaming([pa, pb], lineOf(A, B), WEEK, sess({ A: 2, B: 1 }));
    expect(r).toEqual({ planId: "A", lineKey: "run:A", others: 0 });
  });

  it("session tie inside a line goes to the later start", () => {
    expect(weekNaming([pa, pb], lineOf(A, B), WEEK, sess({ A: 2, B: 2 })).planId).toBe("B");
    expect(weekNaming([pb, pa], lineOf(A, B), WEEK, sess({ A: 2, B: 2 })).planId).toBe("B");
    expect(weekNaming([pa, pb], lineOf(A, B), WEEK, sess({ A: 1, B: 2 })).planId).toBe("B");
  });

  it("a studio plan holding the week counts as one other", () => {
    const studio = wp("S", "2026-10-01", "2026-10-30", { discipline: "lift", source: "studio" });
    const r = weekNaming([pa, pb, studio], lineOf(A, B), WEEK, sess({ A: 2, B: 1, S: 1 }));
    expect(r).toEqual({ planId: "A", lineKey: "run:A", others: 1 });
  });

  it("the group with more sessions wins, summed over its plans", () => {
    const studio = wp("S", "2026-10-01", "2026-10-30", { discipline: "lift", source: "studio" });
    const r = weekNaming([pa, pb, studio], lineOf(A, B), WEEK, sess({ A: 2, B: 2, S: 3 }));
    expect(r).toEqual({ planId: "B", lineKey: "run:A", others: 1 });
    const r2 = weekNaming([pa, pb, studio], lineOf(A, B), WEEK, sess({ A: 2, B: 2, S: 5 }));
    expect(r2.planId).toBe("S");
    const r3 = weekNaming([pa, pb, studio], lineOf(A, B), WEEK, sess({ A: 2, B: 2, S: 4 }));
    expect(r3.lineKey).toBe("run:A");
  });

  it("a plan not holding the week is ignored", () => {
    const next = wp("N", "2026-10-19", "2026-11-01");
    const prev = wp("P", "2026-09-01", "2026-10-11");
    const mid = wp("M", "2026-10-14", "2026-11-01"); // starts Wed of this week: holds
    expect(weekNaming([next, prev], [], WEEK, sess({ N: 5, P: 5 }))).toEqual({ planId: null, lineKey: null, others: 0 });
    expect(weekNaming([mid], [], WEEK, sess({ M: 1 })).planId).toBe("M");
    expect(weekNaming([wp("E", "2026-09-01", "2026-10-12")], [], WEEK, sess({ E: 1 })).planId).toBe("E");
  });

  it("a non-coach plan sharing a phase id is its own group", () => {
    const studio = wp("A", "2026-10-01", "2026-10-30", { discipline: "lift", source: "studio" });
    expect(weekNaming([pa, studio], lineOf(A), WEEK, sess({ A: 1 })).others).toBe(1);
  });

  it("a line's start is the line's, not the first holder's", () => {
    const studio = wp("S", "2026-10-01", "2026-10-30", { discipline: "lift", source: "studio" });
    const r = weekNaming([pb, pa, studio], lineOf(A, B), WEEK, sess({ A: 1, B: 1, S: 2 }));
    expect(r.lineKey).toBe("run:A");
  });

  it("no holder", () => {
    expect(weekNaming([], [], WEEK, sess({}))).toEqual({ planId: null, lineKey: null, others: 0 });
  });

  it("equal sessions: the run line with a goal race wins, then the plan's own race", () => {
    const lift = blk("L", "2026-09-01", "2026-11-01", { discipline: "lift" });
    const run = blk("R", "2026-09-10", "2026-12-12", { planRaceDate: "2026-12-12" });
    const plans = [wp("L", lift.startDate, lift.endDate, { discipline: "lift" }), wp("R", run.startDate, run.endDate)];
    const ls = lineOf(lift, run);
    expect(weekNaming(plans, ls, WEEK, sess({ L: 2, R: 2 })).planId).toBe("R");
    expect(weekNaming([...plans].reverse(), ls, WEEK, sess({ L: 2, R: 2 })).planId).toBe("R");
    // a lift line's race does not count
    const lift2 = blk("L", "2026-09-20", "2026-11-01", { discipline: "lift", planRaceDate: "2026-12-12" });
    const run2 = blk("R", "2026-09-10", "2026-12-12");
    const p2 = [wp("L", lift2.startDate, lift2.endDate, { discipline: "lift" }), wp("R", run2.startDate, run2.endDate)];
    expect(weekNaming(p2, lineOf(lift2, run2), WEEK, sess({ L: 2, R: 2 })).planId).toBe("R");
    // a non-coach run plan with its own raceDate beats a coach lift line that starts earlier
    const studioRun = wp("S", "2026-10-05", "2026-12-01", { source: "studio", raceDate: "2026-12-01" });
    const r = weekNaming([studioRun, plans[0]!], lineOf(lift), WEEK, sess({ L: 2, S: 2 }));
    expect(r.planId).toBe("S");
    // without a race it does not
    const noRace = { ...studioRun, raceDate: null };
    expect(weekNaming([noRace, plans[0]!], lineOf(lift), WEEK, sess({ L: 2, S: 2 })).planId).toBe("L");
    // a race on a non-run plan does not count
    const studioLift = { ...studioRun, discipline: "lift" };
    expect(weekNaming([studioLift, plans[0]!], lineOf(lift), WEEK, sess({ L: 2, S: 2 })).planId).toBe("L");
  });

  it("equal sessions and no race: the earlier start wins", () => {
    const x = blk("X", "2026-09-01", "2026-11-01", { discipline: "lift" });
    const y = blk("Y", "2026-09-10", "2026-11-01", { discipline: "mobility" });
    const plans = [
      wp("Y", y.startDate, y.endDate, { discipline: "mobility" }),
      wp("X", x.startDate, x.endDate, { discipline: "lift" }),
    ];
    const ls = lineOf(x, y);
    expect(weekNaming(plans, ls, WEEK, sess({ X: 1, Y: 1 })).planId).toBe("X");
    expect(weekNaming([...plans].reverse(), ls, WEEK, sess({ X: 1, Y: 1 })).planId).toBe("X");
    expect(weekNaming(plans, ls, WEEK, sess({ X: 1, Y: 1 })).others).toBe(1);
  });

  it("a coach plan outside any line is its own group", () => {
    const r = weekNaming([wp("Z", "2026-10-01", "2026-10-30")], [], WEEK, sess({ Z: 1 }));
    expect(r).toEqual({ planId: "Z", lineKey: null, others: 0 });
  });
});
