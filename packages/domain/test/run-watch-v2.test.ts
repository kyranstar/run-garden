/**
 * A DESIGNED RUN ON THE v2 WIRE (§8 phase 2, `RUN_WIRE_V2`): a distance goes to the watch as a distance (`targetType 5`)
 * and a part's rounds as one repeat group. The session is the same whichever wire is on; what differs is how its steps
 * count (a group is its children and one, not rounds × children), what a distance needs (no pace to time it), and so
 * what the watch will show. v1 stays the default everywhere it is not asked for.
 */
import { describe, expect, it } from "vitest";
import {
  RUN_WATCH_MAX_ROUNDS,
  RUN_WATCH_MAX_STEPS,
  runSegmentGroups,
  runWatchSessionOf,
  runWatchSessionSchema,
  runWatchStepCount,
  runWatchSteps,
  sessionWatchCoverage,
  type RunWatchSession,
  type WorkoutDoc,
} from "../src/index.js";

const doc = (rounds: number, cooldown: Record<string, unknown> = { distanceM: 2000 }, extra: Record<string, unknown> = {}): WorkoutDoc => ({
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Tempo.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    {
      purpose: "run",
      format: "intervals",
      rounds,
      ...extra,
      items: [
        { kind: "run", effort: "tempo", target: { distanceM: 800 } },
        { kind: "run", effort: "recovery", target: { durationSec: 90 } },
      ],
    },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: cooldown }] },
  ],
  source: { kind: "coach" },
});
const sessionOf = (d: WorkoutDoc, wire?: "v1" | "v2"): RunWatchSession => {
  const made = runWatchSessionOf(d, wire);
  if (!("session" in made)) throw new Error(made.refused);
  return made.session;
};

describe("the step count, as each wire writes it", () => {
  it("v1 writes every round out; v2 writes a part of rounds as one group — its children and one", () => {
    const s = sessionOf(doc(3));
    expect(runWatchStepCount(s.segments)).toBe(1 + 6 + 1);
    expect(runWatchStepCount(s.segments, "v1")).toBe(8);
    expect(runWatchStepCount(s.segments, "v2")).toBe(1 + 3 + 1);
    expect(runSegmentGroups(s.segments[1]!, "v2")).toBe(true);
    expect(runSegmentGroups(s.segments[1]!, "v1")).toBe(false);
    expect(runSegmentGroups(s.segments[0]!, "v2")).toBe(false);
  });

  it("a part with a rest between its rounds is written out on v2 too: in a group that rest would follow the last round", () => {
    const s = sessionOf(doc(3, { durationSec: 600 }, { restBetweenRoundsSec: 60 }));
    expect(runSegmentGroups(s.segments[1]!, "v2")).toBe(false);
    expect(runWatchStepCount(s.segments, "v2")).toBe(1 + 6 + 2 + 1);
  });

  it("v2 takes what v1 cannot (30 rounds of two: 62 steps written out, 5 on v2); neither takes more than 30 rounds", () => {
    expect(RUN_WATCH_MAX_ROUNDS).toBe(30);
    expect(runWatchSessionOf(doc(30), "v1")).toEqual({ refused: "too_many_steps" });
    expect(runWatchStepCount(sessionOf(doc(30), "v2").segments, "v2")).toBe(5);
    expect(runWatchSessionOf(doc(31), "v2")).toEqual({ refused: "too_many_rounds" });
    expect(runWatchSessionOf(doc(31), "v1")).toEqual({ refused: "too_many_rounds" });
    // The job's schema takes a session either wire can hold — the builder of the wire in use refuses what it can't.
    expect(runWatchSessionSchema.safeParse(sessionOf(doc(30), "v2")).success).toBe(true);
    expect(RUN_WATCH_MAX_STEPS).toBe(60);
  });
});

describe("the steps on the v2 watch", () => {
  it("a distance goes as a distance: never 'as its time', never unresolved — no pace is needed to run it", () => {
    const s = sessionOf(doc(3));
    const none = runWatchSteps(s, null, "v2");
    expect(none.unresolved).toBe(0);
    expect(none.distanceAsTime).toBe(0);
    expect(none.steps.filter((st) => st.meters !== undefined).every((st) => st.asDistance === true && st.seconds === null)).toBe(true);
    // Its time is still estimated when a pace is known — the totals — and it still goes as a distance.
    const known = runWatchSteps(s, 289, "v2");
    expect(known.steps[1]).toMatchObject({ meters: 800, asDistance: true, seconds: Math.round(0.8 * 306.5) });
    // v1, as it was: a distance as its time.
    expect(runWatchSteps(s, 289).steps[1]).toMatchObject({ meters: 800, seconds: Math.round(0.8 * 306.5) });
    expect(runWatchSteps(s, 289).steps[1]!.asDistance).toBeUndefined();
    expect(runWatchSteps(s, null).unresolved).toBe(4);
  });

  it("what the watch will show: whole with a threshold; without one, every step but its paces", () => {
    const s = sessionOf(doc(3));
    expect(sessionWatchCoverage(s, 289, "v2")).toEqual({ discipline: "run", coverage: "full", gaps: [] });
    expect(sessionWatchCoverage(s, null, "v2")).toEqual({ discipline: "run", coverage: "partial", gaps: [{ code: "pace_targets_owed", count: 5 }] });
    // v1 unchanged: a distance as its time, and none without a threshold.
    expect(sessionWatchCoverage(s, 289)).toEqual({ discipline: "run", coverage: "partial", gaps: [{ code: "distance_as_time", count: 4 }] });
    expect(sessionWatchCoverage(s, null).coverage).toBe("none");
  });
});
