import { describe, expect, it } from "vitest";
import type { NormalizedActivity, PlannedWorkout } from "@rg/domain";
import { normalizeCorosActivity } from "../src/coros/normalize.js";
import { fixtureCorosCompletedThreshold } from "../src/fixtures/activities.js";
import {
  ORPHAN_ADOPTION_FLOOR,
  scoreAgainstStoredRow,
  singleSourceActivity,
} from "../src/merge.js";
import { matchActivities, matchBand, scoreWorkoutActivity } from "../src/matching.js";

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
});
