import { describe, expect, it } from "vitest";
import type { NormalizedActivity, PlannedWorkout } from "@rg/domain";
import { normalizeCorosActivity } from "../src/coros/normalize.js";
import { fixtureCorosCompletedThreshold } from "../src/fixtures/activities.js";
import {
  ORPHAN_ADOPTION_FLOOR,
  scoreAgainstStoredRow,
  singleSourceActivity,
} from "../src/merge.js";
import { activityDayOf, matchActivities, matchBand, scoreWorkoutActivity } from "../src/matching.js";

const START = "2026-08-04T14:02:05Z";
const corosSrc = () => {
  const { item, detail } = fixtureCorosCompletedThreshold(START);
  return normalizeCorosActivity(item, detail);
};

/** A stored row for the same physical session, as ingested before COROS-only. */
const storedTwin = () => ({
  startTime: "2026-08-04T14:02:11Z", // 6s apart — the same run, two clocks
  sport: "run",
  durationSeconds: 3260,
  distanceMeters: 9805,
});

describe("adopting a stored row rather than duplicating it", () => {
  it("recognises a stored copy of the same session with high confidence", () => {
    const { score } = scoreAgainstStoredRow(corosSrc(), storedTwin());
    expect(score).toBeGreaterThanOrEqual(0.85);
  });

  it("clears the adoption floor, so the backfill adopts instead of inserting", () => {
    const { score } = scoreAgainstStoredRow(corosSrc(), storedTwin());
    expect(score).toBeGreaterThanOrEqual(ORPHAN_ADOPTION_FLOOR);
  });

  it("refuses a genuinely different session later the same day", () => {
    const evening = {
      startTime: "2026-08-04T23:58:00Z",
      sport: "run",
      durationSeconds: 1500,
      distanceMeters: 4000,
    };
    const { score } = scoreAgainstStoredRow(corosSrc(), evening);
    expect(score).toBeLessThan(ORPHAN_ADOPTION_FLOOR);
  });

  it("refuses a different sport at the same moment", () => {
    const { score } = scoreAgainstStoredRow(corosSrc(), { ...storedTwin(), sport: "yoga" });
    expect(score).toBeLessThan(ORPHAN_ADOPTION_FLOOR);
  });

  it("keeps COROS metrics and identity on the normalized activity", () => {
    const activity = singleSourceActivity(corosSrc());
    expect(activity.corosActivityId).toBe("coros-act-4711");
    expect(activity.durationSeconds).toBe(3255);
    expect(activity.trainingLoad).toBe(82);
    expect(activity.sourceMergeConfidence).toBe(1);
  });

  it("reuses the row id when adopting, so completion matches survive", () => {
    const first = singleSourceActivity(corosSrc());
    const adopted = singleSourceActivity(corosSrc(), first.id);
    expect(adopted.id).toBe(first.id);
  });
});

const workout = (over: Partial<PlannedWorkout>): PlannedWorkout =>
  ({
    id: "w1",
    sourceProvider: "coros",
    sourcePlanId: "p",
    sourceWorkoutId: "p:11",
    sourceIdInPlan: "11",
    title: "Threshold 5x5",
    category: "quality",
    sport: "run",
    originalPlanDate: "2026-08-04",
    lastVerifiedCorosDate: "2026-08-04",
    effectiveDate: "2026-08-04",
    effectiveTime: "07:00",
    sourceContentFingerprint: "f",
    sourceEstimatedDurationSeconds: 3240,
    calendarBlockDurationSeconds: 4740,
    expectedDistanceMeters: 9800,
    stages: [],
    calendarSyncState: "synced",
    corosSyncState: "synced",
    completionState: "scheduled",
    ...over,
  }) as PlannedWorkout;

describe("planned-to-completed matching", () => {
  it("prefers explicit COROS plan linkage at confidence 1", () => {
    const act = singleSourceActivity(corosSrc(), "act-1");
    const matches = matchActivities(
      [{ workout: workout({}), corosProgramId: "9000000000000011" }],
      [{ activity: act, corosProgramId: "9000000000000011" }],
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ method: "coros_plan_link", confidence: 1 });
  });

  it("scores same-day same-duration matches high", () => {
    const act = singleSourceActivity(corosSrc(), "act-2");
    const cand = scoreWorkoutActivity(workout({}), act)!;
    expect(cand.confidence).toBeGreaterThanOrEqual(0.75);
    expect(matchBand(cand.confidence)).toBe("high");
  });

  it("one activity cannot complete two workouts (and vice versa)", () => {
    const act = singleSourceActivity(corosSrc(), "act-3");
    const matches = matchActivities(
      [
        { workout: workout({ id: "w1" }) },
        { workout: workout({ id: "w2", effectiveDate: "2026-08-04" }) },
      ],
      [{ activity: act }],
    );
    expect(matches).toHaveLength(1);
  });

  it("never matches rest days or already-completed workouts", () => {
    const act = singleSourceActivity(corosSrc(), "act-4");
    expect(scoreWorkoutActivity(workout({ category: "rest" }), act)).toBeNull();
    expect(scoreWorkoutActivity(workout({ completionState: "completed" }), act)).toBeNull();
  });

  it("rejects activities more than a day away", () => {
    const act = singleSourceActivity(corosSrc(), "act-5");
    expect(scoreWorkoutActivity(workout({ effectiveDate: "2026-08-10", originalPlanDate: "2026-08-10" }), act)).toBeNull();
  });

  it("scores a match when the activity carries no COROS plan link", () => {
    // No sourcePlannedWorkoutId: pass 1 cannot fire, so this exercises the
    // transparent scorer rather than coros_plan_link.
    const unlinked = singleSourceActivity(corosSrc(), "act-6");
    const matches = matchActivities([{ workout: workout({}) }], [{ activity: unlinked }]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.method).toBe("scored");
  });

  // An app programme's session (owner, 2026-11-05): its own copy completes it; a scored guess never does — and the
  // activity it would have taken stays free for another workout it fits.
  it("a link-only workout takes its own linked copy, never a scored guess", () => {
    const act = singleSourceActivity(corosSrc(), "act-link-only");
    expect(matchActivities([{ workout: workout({ id: "slot" }), linkOnly: true }], [{ activity: act }])).toEqual([]);
    const both = matchActivities(
      [{ workout: workout({ id: "slot" }), linkOnly: true }, { workout: workout({ id: "planned" }) }],
      [{ activity: act }],
    );
    expect(both).toHaveLength(1);
    expect(both[0]).toMatchObject({ workoutId: "planned" });
    const linked = matchActivities(
      [{ workout: workout({ id: "slot" }), corosProgramId: "9000000000000011", linkOnly: true }],
      [{ activity: act, corosProgramId: "9000000000000011" }],
    );
    expect(linked[0]).toMatchObject({ workoutId: "slot", method: "coros_plan_link" });
  });

  it("scores the sport point for a yoga workout against a yoga activity", () => {
    const act: NormalizedActivity = {
      id: "act-7",
      startTime: "2026-08-04T15:00:00Z",
      startTimeLocal: "2026-08-04T08:00:00",
      sport: "yoga",
      durationSeconds: 1800,
      sourceMergeConfidence: 1,
    };
    const cand = scoreWorkoutActivity(workout({ category: "yoga", sport: "yoga" }), act);
    expect(cand).not.toBeNull();
    expect(cand!.parts!.sport).toBeGreaterThan(0);
  });
  const sportActivity = (sport: string): NormalizedActivity => ({
    id: "act-s",
    startTime: "2026-08-04T15:00:00Z",
    startTimeLocal: "2026-08-04T08:00:00",
    sport,
    durationSeconds: 1800,
    sourceMergeConfidence: 1,
  });

  it("a yoga activity never completes a strength workout", () => {
    expect(scoreWorkoutActivity(workout({ category: "strength", sport: "strength" }), sportActivity("yoga"))).toBeNull();
  });

  it("a strength activity can complete a yoga (mobility) workout", () => {
    expect(scoreWorkoutActivity(workout({ category: "yoga", sport: "run" }), sportActivity("strength"))).not.toBeNull();
  });

  it("a bike ride never completes a strength workout", () => {
    expect(scoreWorkoutActivity(workout({ category: "strength", sport: "strength" }), sportActivity("bike"))).toBeNull();
  });

  it("a strength activity completes a strength workout, a bike ride a cross-training one", () => {
    expect(scoreWorkoutActivity(workout({ category: "strength", sport: "strength" }), sportActivity("strength"))).not.toBeNull();
    expect(scoreWorkoutActivity(workout({ category: "cross_training", sport: "run" }), sportActivity("bike"))).not.toBeNull();
  });

  it("a run never completes a yoga workout and a yoga activity never completes a run", () => {
    expect(scoreWorkoutActivity(workout({ category: "yoga", sport: "run" }), sportActivity("run"))).toBeNull();
    expect(scoreWorkoutActivity(workout({}), sportActivity("yoga"))).toBeNull();
  });

  it("the discipline is read from the CATEGORY first: a yoga session filed as strength is still yoga", () => {
    // Audit 1, ingest IMPORTANT (Ruling A2). COROS has no mobility program
    // type, so a pushed mobility session can carry sport "strength" while its
    // category says yoga. The athlete does it in Yoga mode; that must count.
    expect(scoreWorkoutActivity(workout({ category: "yoga", sport: "strength" }), sportActivity("yoga"))).not.toBeNull();
    // …while a real lift still refuses a yoga activity, whatever its sport.
    expect(scoreWorkoutActivity(workout({ category: "strength", sport: "yoga" }), sportActivity("yoga"))).toBeNull();
    expect(scoreWorkoutActivity(workout({ category: "strength", sport: "strength" }), sportActivity("yoga"))).toBeNull();
  });
});

/**
 * WHO A GUESS MAY PAIR (R1.3; the lead's v0.22 ruling: "Fix matching from occurrence time, not import time. Apply the
 * creation/day restrictions before scoring"). Seen on production: a 2:03 PM yoga on Nov 20, synced at 22:29:55Z, was paired
 * (0.507) with a one-off session placed at 22:30:18Z for Nov 21. A scored match now needs the session on the activity's
 * own training day (`activityDayOf`: run-garden's one rule, garden-sync.ts `activityDate`) and the session to have existed
 * before the activity ended. The COROS plan link is no guess: it still pairs across days.
 */
describe("who a guess may pair (R1.3): occurrence time, not import time", () => {
  /** An activity of `sport` starting at a local wall time, `minutes` long, with its UTC start. */
  const activityAt = (id: string, local: string, utc: string, minutes: number, sport = "yoga"): NormalizedActivity => ({
    id, startTime: utc, startTimeLocal: local, sport, durationSeconds: minutes * 60, sourceMergeConfidence: 1,
  });
  const yogaSession = (over: Partial<PlannedWorkout>) =>
    workout({ category: "yoga", sport: "yoga", sourceEstimatedDurationSeconds: 1500, expectedDistanceMeters: undefined, effectiveTime: "18:00", ...over });

  it("the incident: a yoga on Nov 20 never pairs with a session placed after it, for Nov 21", () => {
    const yoga = activityAt("yoga-nov20", "2026-11-20T14:03:00", "2026-11-20T22:03:00Z", 25);
    const tre = yogaSession({ id: "tre-floor", effectiveDate: "2026-11-21", originalPlanDate: "2026-11-21" });
    // The scorer alone gives it a medium score (the medium band auto-matches): the day and creation rules must stop it.
    expect(matchBand(scoreWorkoutActivity(tre, yoga)!.confidence)).toBe("medium");
    expect(matchActivities([{ workout: tre, createdAt: "2026-11-20T22:30:18Z" }], [{ activity: yoga }])).toEqual([]);
    // Either rule alone refuses it: another day, created before; the same day, created after.
    expect(matchActivities([{ workout: tre, createdAt: "2026-11-01T00:00:00Z" }], [{ activity: yoga }])).toEqual([]);
    const sameDay = yogaSession({ id: "tre-same-day", effectiveDate: "2026-11-20", originalPlanDate: "2026-11-20" });
    expect(matchActivities([{ workout: sameDay, createdAt: "2026-11-20T22:30:18Z" }], [{ activity: yoga }])).toEqual([]);
    // A session there before the yoga, on its day, is its guess.
    expect(matchActivities([{ workout: sameDay, createdAt: "2026-11-20T08:00:00Z" }], [{ activity: yoga }])).toEqual([
      expect.objectContaining({ workoutId: "tre-same-day", activityId: "yoga-nov20", method: "scored" }),
    ]);
  });

  it("the session must exist before the activity ENDED: created during it still counts, after it never", () => {
    const yoga = activityAt("yoga", "2026-11-20T14:03:00", "2026-11-20T22:03:00Z", 25); // ends 22:28:00Z
    const s = yogaSession({ id: "s", effectiveDate: "2026-11-20", originalPlanDate: "2026-11-20" });
    expect(matchActivities([{ workout: s, createdAt: "2026-11-20T22:28:00Z" }], [{ activity: yoga }])).toHaveLength(1);
    expect(matchActivities([{ workout: s, createdAt: "2026-11-20T22:28:01Z" }], [{ activity: yoga }])).toEqual([]);
    // Its elapsed time, when it says one, is how long it lasted.
    const paused = { ...yoga, elapsedSeconds: 40 * 60 }; // ends 22:43:00Z
    expect(matchActivities([{ workout: s, createdAt: "2026-11-20T22:40:00Z" }], [{ activity: paused }])).toHaveLength(1);
  });

  it("another day is never a guess: a day either side, a moved session's old day, either side of midnight", () => {
    const run = activityAt("run", "2026-08-04T23:50:00", "2026-08-05T06:50:00Z", 54, "run");
    const at = (date: string, original = date) => workout({ id: `w-${date}-${original}`, effectiveDate: date, originalPlanDate: original });
    // 23:50 local is its day, whatever its UTC date says.
    expect(matchActivities([{ workout: at("2026-08-04") }], [{ activity: run }])).toHaveLength(1);
    expect(matchActivities([{ workout: at("2026-08-05") }], [{ activity: run }])).toEqual([]);
    expect(matchActivities([{ workout: at("2026-08-03") }], [{ activity: run }])).toEqual([]);
    // Moved off this day: its old day is not its day now.
    expect(matchActivities([{ workout: at("2026-08-05", "2026-08-04") }], [{ activity: run }])).toEqual([]);
    // 00:10 local is the next day's.
    const early = activityAt("early", "2026-08-05T00:10:00", "2026-08-05T07:10:00Z", 54, "run");
    expect(matchActivities([{ workout: at("2026-08-05") }], [{ activity: early }])).toHaveLength(1);
    expect(matchActivities([{ workout: at("2026-08-04") }], [{ activity: early }])).toEqual([]);
    // With no local start, its day is its UTC start's (the one rule's fallback).
    const utcOnly: NormalizedActivity = { ...early, id: "utc-only", startTimeLocal: undefined, startTime: "2026-08-05T06:50:00Z" };
    expect(activityDayOf(utcOnly)).toBe("2026-08-05");
    expect(matchActivities([{ workout: at("2026-08-05") }], [{ activity: utcOnly }])).toHaveLength(1);
  });

  it("the COROS plan link is no guess: it still pairs its own copy across days, and a session written after", () => {
    const act = singleSourceActivity(corosSrc(), "linked");
    const tomorrow = workout({ id: "linked-w", effectiveDate: "2026-08-05", originalPlanDate: "2026-08-05" });
    expect(matchActivities([{ workout: tomorrow, corosProgramId: "p-1", createdAt: "2026-08-06T00:00:00Z" }], [{ activity: act, corosProgramId: "p-1" }])).toEqual([
      expect.objectContaining({ workoutId: "linked-w", method: "coros_plan_link" }),
    ]);
  });
});
