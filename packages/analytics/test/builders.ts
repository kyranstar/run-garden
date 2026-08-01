import type {
  ActivityLap,
  NormalizedActivity,
  PlannedStage,
  PlannedWorkout,
} from "@rg/domain";

/** Synthetic builders for deterministic analytics tests. */

export function mkWorkout(overrides: Partial<PlannedWorkout> & { id: string }): PlannedWorkout {
  const date = overrides.effectiveDate ?? overrides.originalPlanDate ?? "2026-03-02";
  return {
    sourceProvider: "coros",
    sourcePlanId: "plan-1",
    sourceWorkoutId: `sw-${overrides.id}`,
    title: "Run",
    category: "easy",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    stages: [],
    calendarSyncState: "synced",
    corosSyncState: "synced",
    completionState: "completed",
    ...overrides,
  };
}

export function mkActivity(overrides: Partial<NormalizedActivity> & { id: string }): NormalizedActivity {
  return {
    startTime: "2026-03-02T07:00:00Z",
    sport: "run",
    durationSeconds: 3600,
    distanceMeters: 10_000,
    sourceMergeConfidence: 1,
    ...overrides,
  };
}

export function mkLap(
  activityId: string,
  lapIndex: number,
  overrides: Partial<ActivityLap> = {},
): ActivityLap {
  return {
    id: `${activityId}-lap-${lapIndex}`,
    activityId,
    lapIndex,
    durationSeconds: 300,
    ...overrides,
  };
}

export function mkStage(overrides: Partial<PlannedStage> & { id: string; order: number }): PlannedStage {
  return {
    kind: "work",
    durationType: "time",
    ...overrides,
  };
}
