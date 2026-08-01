import { describe, expect, it } from "vitest";
import type { PlannedWorkout } from "@rg/domain";
import { normalizeCorosActivity } from "../src/coros/normalize.js";
import { normalizeStravaActivity } from "../src/strava/normalize.js";
import {
  fixtureCorosCompletedThreshold,
  fixtureStravaCompletedThreshold,
  fixtureStravaEveningShakeout,
} from "../src/fixtures/activities.js";
import { mergeActivityPair, pairSources, scoreActivityPair, singleSourceActivity } from "../src/merge.js";
import { matchActivities, matchBand, scoreWorkoutActivity } from "../src/matching.js";

const START = "2026-08-04T14:02:05Z";
const corosSrc = () => {
  const { item, detail } = fixtureCorosCompletedThreshold(START);
  return normalizeCorosActivity(item, detail);
};
const stravaSrc = () => normalizeStravaActivity(fixtureStravaCompletedThreshold(START));

describe("COROS/Strava deduplication", () => {
  it("scores the duplicate pair as high confidence", () => {
    const { score } = scoreActivityPair(corosSrc(), stravaSrc());
    expect(score).toBeGreaterThanOrEqual(0.85);
  });

  it("never merges two records from the same provider", () => {
    const { score } = scoreActivityPair(corosSrc(), corosSrc());
    expect(score).toBe(0);
  });

  it("never merges two genuinely distinct runs on the same day", () => {
    const evening = normalizeStravaActivity(fixtureStravaEveningShakeout("2026-08-04"));
    const { score } = scoreActivityPair(corosSrc(), evening);
    expect(score).toBeLessThan(0.5);
    const pairs = pairSources([corosSrc()], [stravaSrc(), evening]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.strava.providerActivityId).toBe("14200000001");
  });

  it("merges with COROS authoritative for metrics and Strava for route/title", () => {
    const { activity, confidenceBand } = mergeActivityPair(corosSrc(), stravaSrc());
    expect(confidenceBand).toBe("high");
    expect(activity.corosActivityId).toBe("coros-act-4711");
    expect(activity.stravaActivityId).toBe("14200000001");
    expect(activity.durationSeconds).toBe(3255); // COROS workoutTime, not Strava moving_time
    expect(activity.trainingLoad).toBe(82); // COROS-only metric
    expect(activity.title).toBe("Morning Threshold"); // Strava title enriches
    expect(activity.summaryPolyline).toBe("abc123polyline"); // Strava route
  });

  it("is idempotent: merging the same pair twice keeps one activity id", () => {
    const first = mergeActivityPair(corosSrc(), stravaSrc());
    const second = mergeActivityPair(corosSrc(), stravaSrc(), first.activity.id);
    expect(second.activity.id).toBe(first.activity.id);
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
    const act = singleSourceActivity(stravaSrc(), "act-2");
    const cand = scoreWorkoutActivity(workout({}), act)!;
    expect(cand.confidence).toBeGreaterThanOrEqual(0.75);
    expect(matchBand(cand.confidence)).toBe("high");
  });

  it("one activity cannot complete two workouts (and vice versa)", () => {
    const act = singleSourceActivity(stravaSrc(), "act-3");
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
    const act = singleSourceActivity(stravaSrc(), "act-4");
    expect(scoreWorkoutActivity(workout({ category: "rest" }), act)).toBeNull();
    expect(scoreWorkoutActivity(workout({ completionState: "completed" }), act)).toBeNull();
  });

  it("rejects activities more than a day away", () => {
    const act = singleSourceActivity(stravaSrc(), "act-5");
    expect(scoreWorkoutActivity(workout({ effectiveDate: "2026-08-10", originalPlanDate: "2026-08-10" }), act)).toBeNull();
  });

  it("a Strava-only activity can provisionally complete a workout before COROS arrives", () => {
    const stravaOnly = singleSourceActivity(stravaSrc(), "act-6");
    const matches = matchActivities([{ workout: workout({}) }], [{ activity: stravaOnly }]);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.method).toBe("scored");
  });
});
