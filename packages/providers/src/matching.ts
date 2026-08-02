import type { NormalizedActivity, PlannedWorkout } from "@rg/domain";

/**
 * Planned-to-completed matching. Explicit COROS plan linkage wins outright;
 * otherwise a transparent score over date/time/sport/duration/distance.
 */

export interface MatchCandidate {
  workoutId: string;
  activityId: string;
  confidence: number;
  method: "coros_plan_link" | "scored";
  parts?: Record<string, number>;
}

export interface MatchableWorkout {
  workout: PlannedWorkout;
  /** COROS program id (server id) used for explicit linkage. */
  corosProgramId?: string;
}

export function scoreWorkoutActivity(
  w: PlannedWorkout,
  a: NormalizedActivity,
  activityCorosProgramId?: string,
): MatchCandidate | null {
  if (w.completionState === "completed" || w.completionState === "skipped") return null;
  if (w.category === "rest") return null;

  // Explicit linkage from the COROS activity summary (planId/programId).
  // sourceWorkoutId format is `${planId}:${idInPlan}`.

  const activityDateLocal = (a.startTimeLocal ?? a.startTime).slice(0, 10);
  const parts: Record<string, number> = {};

  parts.date =
    activityDateLocal === w.effectiveDate
      ? 0.3
      : activityDateLocal === w.originalPlanDate
        ? 0.2
        : Math.abs(daysDiff(activityDateLocal, w.effectiveDate)) === 1
          ? 0.1
          : 0;
  if (parts.date === 0) return null; // more than a day off is never a match

  const runSports = new Set(["run"]);
  const workoutIsRun = !["cross_training", "strength", "yoga"].includes(w.category);
  parts.sport = workoutIsRun === runSports.has(a.sport) ? 0.15 : 0;
  if (parts.sport === 0) return null;

  const est = w.sourceEstimatedDurationSeconds ?? w.fallbackEstimatedDurationSeconds;
  if (est && est > 0 && a.durationSeconds > 0) {
    const rel = Math.abs(a.durationSeconds - est) / est;
    parts.duration = rel <= 0.15 ? 0.2 : rel >= 0.5 ? 0 : 0.2 * (1 - (rel - 0.15) / 0.35);
  } else parts.duration = 0.05;

  if (w.expectedDistanceMeters && a.distanceMeters) {
    const rel = Math.abs(a.distanceMeters - w.expectedDistanceMeters) / w.expectedDistanceMeters;
    parts.distance = rel <= 0.1 ? 0.15 : rel >= 0.4 ? 0 : 0.15 * (1 - (rel - 0.1) / 0.3);
  } else parts.distance = 0.05;

  // Start-time proximity to the scheduled time (same-day only).
  if (activityDateLocal === w.effectiveDate && a.startTimeLocal) {
    const actMin = timeToMinutes(a.startTimeLocal.slice(11, 16));
    const schedMin = timeToMinutes(w.effectiveTime);
    const diff = Math.abs(actMin - schedMin);
    parts.startTime = diff <= 90 ? 0.1 : diff >= 300 ? 0 : 0.1 * (1 - (diff - 90) / 210);
  } else parts.startTime = 0;

  const confidence = Math.min(1, Object.values(parts).reduce((x, y) => x + y, 0) + 0.1);
  return { workoutId: w.id, activityId: a.id, confidence, method: "scored", parts };
}

function daysDiff(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export type MatchBand = "high" | "medium" | "low";

export function matchBand(confidence: number): MatchBand {
  if (confidence >= 0.75) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
}

/**
 * Greedy one-to-one matching: one activity completes at most one workout and
 * one workout is completed at most once.
 */
export function matchActivities(
  workouts: MatchableWorkout[],
  activities: Array<{ activity: NormalizedActivity; corosProgramId?: string }>,
): MatchCandidate[] {
  const results: MatchCandidate[] = [];
  const usedWorkouts = new Set<string>();
  const usedActivities = new Set<string>();

  // Pass 1: explicit COROS plan linkage.
  for (const { activity, corosProgramId } of activities) {
    if (!corosProgramId) continue;
    const w = workouts.find(
      (mw) => mw.corosProgramId === corosProgramId && !usedWorkouts.has(mw.workout.id),
    );
    if (w && !usedActivities.has(activity.id) && w.workout.category !== "rest") {
      results.push({
        workoutId: w.workout.id,
        activityId: activity.id,
        confidence: 1,
        method: "coros_plan_link",
      });
      usedWorkouts.add(w.workout.id);
      usedActivities.add(activity.id);
    }
  }

  // Pass 2: scored matching for the rest.
  const scored: MatchCandidate[] = [];
  for (const { activity } of activities) {
    if (usedActivities.has(activity.id)) continue;
    for (const mw of workouts) {
      if (usedWorkouts.has(mw.workout.id)) continue;
      const cand = scoreWorkoutActivity(mw.workout, activity);
      if (cand) scored.push(cand);
    }
  }
  scored.sort((a, b) => b.confidence - a.confidence);
  for (const cand of scored) {
    if (usedWorkouts.has(cand.workoutId) || usedActivities.has(cand.activityId)) continue;
    usedWorkouts.add(cand.workoutId);
    usedActivities.add(cand.activityId);
    results.push(cand);
  }
  return results;
}
