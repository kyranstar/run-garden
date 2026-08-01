import type { ActivityLap, PlannedStage, PlannedWorkout } from "@rg/domain";
import type { MetricResult } from "./metric.js";
import { insufficient, ok } from "./metric.js";
import { mean, median, populationStdDev, roundTo } from "./stats.js";

/**
 * Structured workout execution. Work laps are identified deterministically as
 * the N fastest-pace laps, where N is the planned work-interval count (repeats
 * expanded). Exceeding pace targets is never rewarded: a lap faster than the
 * prescribed band counts as NOT adherent.
 */

const TARGET_TOLERANCE = 0.03;
const FADE_TOLERANCE = 0.05;

export interface ExecutionInput {
  workout: PlannedWorkout;
  laps: ActivityLap[];
}

export interface ExecutionValue {
  /** Leaf work-stage count with repeats expanded. */
  plannedWorkIntervals: number;
  /** Laps actually treated as work bouts (min of planned count and laps with pace). */
  workLapCount: number;
  /** True when fewer paced laps existed than planned intervals. */
  partial: boolean;
  /** Heuristic: recorded lap count >= planned work-interval count. */
  stagesCompleted: boolean;
  /** Coefficient of variation of work-lap paces, %. */
  intervalConsistencyCvPct: number;
  /** Fraction of work laps inside [targetLow-3%, targetHigh+3%]; null without pace targets. */
  targetAdherence: number | null;
  /** Work laps faster than the prescribed band (not counted as adherent). */
  fasterThanPrescribed: number;
  /** Last work lap no more than 5% slower than the median work lap. */
  controlled: boolean;
}

/** Repeat multiplier for a stage: product of repeatCount over ancestor repeat stages. */
function repeatMultiplier(stage: PlannedStage, byId: Map<string, PlannedStage>): number {
  let multiplier = 1;
  let parentId = stage.parentStageId;
  const seen = new Set<string>();
  while (parentId != null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    if (parent.kind === "repeat") multiplier *= parent.repeatCount ?? 1;
    parentId = parent.parentStageId;
  }
  return multiplier;
}

export function computeExecution(input: ExecutionInput): MetricResult<ExecutionValue> {
  const { workout, laps } = input;
  const byId = new Map(workout.stages.map((s) => [s.id, s]));
  const workStages = workout.stages.filter((s) => s.kind === "work");
  const plannedWorkIntervals = workStages.reduce(
    (sum, s) => sum + repeatMultiplier(s, byId),
    0,
  );

  if (plannedWorkIntervals === 0) {
    return insufficient(1, 0, "This workout has no work stages, so execution cannot be scored.");
  }
  if (laps.length === 0) {
    return insufficient(1, 0, "No laps were recorded for this workout.");
  }

  const pacedLaps = laps.filter((l) => l.avgPaceSecPerKm != null && l.avgPaceSecPerKm > 0);
  if (pacedLaps.length === 0) {
    return insufficient(1, 0, "No laps carry pace data, so work bouts cannot be identified.");
  }

  // The N fastest-pace laps stand in for the planned work bouts.
  const byPace = [...pacedLaps].sort((a, b) => a.avgPaceSecPerKm! - b.avgPaceSecPerKm!);
  const workLaps = byPace.slice(0, Math.min(plannedWorkIntervals, byPace.length));
  const partial = pacedLaps.length < plannedWorkIntervals;
  const paces = workLaps.map((l) => l.avgPaceSecPerKm!);

  const cv = mean(paces) > 0 ? roundTo((populationStdDev(paces) / mean(paces)) * 100, 2) : 0;

  // Pace targets: combined band across pace-targeted work stages (sec/km; low = faster).
  const targeted = workStages.filter(
    (s) => s.targetType === "pace" && s.targetLow != null && s.targetHigh != null,
  );
  let targetAdherence: number | null = null;
  let fasterThanPrescribed = 0;
  if (targeted.length > 0) {
    const low = Math.min(...targeted.map((s) => s.targetLow!)) * (1 - TARGET_TOLERANCE);
    const high = Math.max(...targeted.map((s) => s.targetHigh!)) * (1 + TARGET_TOLERANCE);
    let adherent = 0;
    for (const pace of paces) {
      if (pace < low) fasterThanPrescribed++;
      else if (pace <= high) adherent++;
    }
    targetAdherence = roundTo(adherent / workLaps.length, 2);
  }

  const chronological = [...workLaps].sort((a, b) => a.lapIndex - b.lapIndex);
  const lastPace = chronological[chronological.length - 1]!.avgPaceSecPerKm!;
  const controlled = lastPace <= median(paces) * (1 + FADE_TOLERANCE);

  let note = `The ${workLaps.length} fastest-pace laps stand in for the ${plannedWorkIntervals} planned work bouts.`;
  if (partial) note += " Fewer paced laps than planned intervals were recorded, so this is a partial read.";
  if (fasterThanPrescribed > 0) {
    note += ` ${fasterThanPrescribed} lap(s) were faster than prescribed and are not counted as adherent.`;
  }

  return ok(
    {
      plannedWorkIntervals,
      workLapCount: workLaps.length,
      partial,
      stagesCompleted: laps.length >= plannedWorkIntervals,
      intervalConsistencyCvPct: cv,
      targetAdherence,
      fasterThanPrescribed,
      controlled,
    },
    workLaps.length,
    note,
  );
}
