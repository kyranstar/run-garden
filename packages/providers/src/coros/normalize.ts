import type { PlannedStage, SourceActivity } from "@rg/domain";
import { fingerprint } from "@rg/domain";
import { NORMALIZER_VERSION, type SourcePlannedWorkout } from "../types.js";
import {
  corosSportName,
  COROS_RUN_SPORT_TYPES,
  type RawCorosActivityDetail,
  type RawCorosActivityListItem,
  type RawCorosEntity,
  type RawCorosExercise,
  type RawCorosProgram,
  type RawCorosSchedule,
} from "./raw-types.js";

/** "20260804" | 20260804 → "2026-08-04" */
export function corosDayToLocalDate(day: string | number): string {
  const s = String(day).padStart(8, "0");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** "2026-08-04" → 20260804 */
export function localDateToCorosDay(date: string): number {
  return Number(date.replaceAll("-", ""));
}

const WORKOUT_SPORT: Record<number, string> = { 1: "run", 2: "bike", 3: "swim", 4: "strength" };

/** Optional i18n resolver: COROS names are often T-codes / sid_ keys. */
export type NameResolver = (key: string) => string | undefined;

/** COROS i18n placeholder keys that must never reach a user unresolved. */
function isI18nKey(raw: string): boolean {
  return /^T\d+$/.test(raw) || /^sid_/.test(raw) || /^H\d+$/.test(raw);
}

function resolveName(raw: string | undefined, resolve?: NameResolver): string {
  if (!raw) return "Workout";
  const resolved = resolve?.(raw);
  if (resolved) return resolved;
  if (/^sid_/.test(raw)) {
    return raw
      .replace(/^sid_(run_|strength_)?/, "")
      .replaceAll("_", " ")
      .replace(/^\w/, (c) => c.toUpperCase());
  }
  return raw;
}

/** Like resolveName, but for optional labels: an unresolved i18n key → none. */
function resolveLabel(raw: string | undefined, resolve?: NameResolver): string | undefined {
  if (!raw) return undefined;
  const resolved = resolve?.(raw);
  if (resolved) return resolved;
  if (isI18nKey(raw)) return undefined;
  return raw;
}

function stageKind(exerciseType: number): PlannedStage["kind"] {
  switch (exerciseType) {
    case 0:
      return "repeat";
    case 1:
      return "warmup";
    case 3:
      return "cooldown";
    case 4:
      return "recovery";
    default:
      return "work";
  }
}

function normalizeExercise(ex: RawCorosExercise, resolve?: NameResolver): PlannedStage {
  const kind = stageKind(ex.exerciseType);
  const stage: PlannedStage = {
    id: String(ex.id),
    parentStageId: ex.groupId && String(ex.groupId) !== "0" ? String(ex.groupId) : null,
    order: ex.sortNo ?? Number(ex.id) ?? 0,
    kind,
    durationType: "none",
    label: resolveLabel(ex.name, resolve),
  };
  if (kind === "repeat") {
    stage.repeatCount = ex.sets ?? 1;
    return stage;
  }
  switch (ex.targetType) {
    case 2:
      stage.durationType = "time";
      stage.durationSeconds = ex.targetValue ?? 0;
      break;
    case 5:
      stage.durationType = "distance";
      stage.distanceMeters = (ex.targetValue ?? 0) / 100; // metres × 100 on the wire
      break;
    case 3:
      stage.durationType = "none";
      break;
    default:
      stage.durationType = "open";
  }
  switch (ex.intensityType) {
    case 3:
    case 8: {
      stage.targetType = "pace";
      // ms/km on the wire; low = faster bound.
      if (ex.intensityValue) stage.targetLow = ex.intensityValue / 1000;
      if (ex.intensityValueExtend) stage.targetHigh = ex.intensityValueExtend / 1000;
      break;
    }
    case 2: {
      stage.targetType = "heart_rate";
      if (ex.intensityValue) stage.targetLow = ex.intensityValue;
      if (ex.intensityValueExtend) stage.targetHigh = ex.intensityValueExtend;
      break;
    }
    case 6: {
      stage.targetType = "power";
      if (ex.intensityValue) stage.targetLow = ex.intensityValue;
      if (ex.intensityValueExtend) stage.targetHigh = ex.intensityValueExtend;
      break;
    }
    default:
      stage.targetType = "none";
  }
  return stage;
}

/**
 * Content fingerprint intentionally EXCLUDES the calendar date so a date move
 * is not misread as a content change. Includes structure, targets, durations.
 */
export function corosProgramFingerprint(program: RawCorosProgram): string {
  return fingerprint({
    name: program.name,
    sportType: program.sportType,
    duration: program.duration,
    estimatedTime: program.estimatedTime,
    distance: program.estimatedDistance ?? program.distance,
    exercises: (program.exercises ?? []).map((e) => ({
      t: e.exerciseType,
      tt: e.targetType,
      tv: e.targetValue,
      it: e.intensityType,
      iv: e.intensityValue,
      ive: e.intensityValueExtend,
      sets: e.sets,
      g: e.isGroup,
      gid: e.groupId,
    })),
  });
}

export interface NormalizedCorosSchedule {
  planId: string;
  planName: string;
  planStart?: string;
  planEnd?: string;
  maxIdInPlan: number;
  pbVersion?: string;
  workouts: SourcePlannedWorkout[];
}

export function normalizeCorosSchedule(
  raw: RawCorosSchedule,
  resolve?: NameResolver,
): NormalizedCorosSchedule {
  const planId = String(raw.id ?? "");
  // THE key wire fact (docs/research/plan-write-capability.md §3, live-verified):
  // schedule/query MERGES every plan on the account into one response, and
  // idInPlan is only unique within its own plan. Entities and programs carry
  // their own planId; keying by bare idInPlan aliases workouts across plans —
  // live-observed as run workouts "moving" onto lifting-session dates, wrong
  // programs attached, and wrongly archived rows. All identity below is
  // (planId, idInPlan)-scoped, falling back to the top-level id for
  // single-plan responses (and fixtures) that omit per-row planId.
  const programsByKey = new Map<string, RawCorosProgram>();
  for (const p of raw.programs ?? []) {
    programsByKey.set(`${String(p.planId ?? planId)}:${String(p.idInPlan)}`, p);
  }

  const workouts: SourcePlannedWorkout[] = [];
  for (const entity of raw.entities ?? []) {
    const entityPlanId = String(entity.planId ?? planId);
    const idInPlan = String(entity.idInPlan);
    const program = programsByKey.get(`${entityPlanId}:${idInPlan}`);
    const date = corosDayToLocalDate(entity.happenDay);
    const sportType = program?.sportType ?? 1;
    const exercises = program?.exercises ?? [];
    const isRestDay =
      exercises.length === 0 &&
      !program?.duration &&
      /rest/i.test(String(program?.name ?? entity["name"] ?? ""));

    const stages = exercises.map((e) => normalizeExercise(e, resolve));
    const durationSeconds = program?.duration ?? program?.estimatedTime;
    const distanceCm =
      program?.estimatedDistance ??
      (typeof program?.distance === "string" ? parseFloat(program.distance) : program?.distance);

    workouts.push({
      sourcePlanId: entityPlanId,
      sourceWorkoutId: `${entityPlanId}:${idInPlan}`,
      sourceProgramId: program?.id ? String(program.id) : undefined,
      sourceIdInPlan: idInPlan,
      title: resolveName(program?.name ?? String(entity["name"] ?? ""), resolve),
      sport: WORKOUT_SPORT[sportType] ?? "run",
      date,
      estimatedDurationSeconds:
        durationSeconds && durationSeconds > 0 ? durationSeconds : undefined,
      estimatedDistanceMeters: distanceCm ? distanceCm / 100 : undefined,
      trainingLoad: program?.trainingLoad ?? program?.estimatedValue,
      stages,
      sourceVersion: program?.version != null ? String(program.version) : undefined,
      contentFingerprint: program ? corosProgramFingerprint(program) : fingerprint({ rest: date }),
      isRestDay,
      raw: { entity, program },
    });
  }
  return {
    planId,
    planName: resolveName(raw.name, resolve),
    planStart: raw.startDay ? corosDayToLocalDate(raw.startDay) : undefined,
    planEnd: raw.endDay ? corosDayToLocalDate(raw.endDay) : undefined,
    maxIdInPlan: Number(raw.maxIdInPlan ?? 0),
    pbVersion: raw.pbVersion != null ? String(raw.pbVersion) : undefined,
    workouts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Activities

function tzOffsetMinutes(units: number | undefined): number {
  return (units ?? 0) * 15;
}

function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function localIsoFromUnix(seconds: number, offsetMinutes: number): string {
  const d = new Date((seconds + offsetMinutes * 60) * 1000);
  return d.toISOString().replace(".000Z", "").replace("Z", "");
}

export function normalizeCorosActivity(
  item: RawCorosActivityListItem,
  detail?: RawCorosActivityDetail,
): SourceActivity {
  const summary = detail?.summary;
  // Detail summary timestamps are centiseconds (like its distance/time fields);
  // list startTime is plain unix seconds. Guard by plausibility rather than by
  // field so a unit change on either side can never fling activities millennia
  // into the future again (50e9 s ≈ year 3554).
  const rawStart = summary?.startTimestamp ?? item.startTime ?? 0;
  const start = rawStart > 50_000_000_000 ? rawStart / 100 : rawStart;
  const offsetMin = tzOffsetMinutes(summary?.timezone ?? item.startTimezone);
  // COROS reports times in centiseconds (matching its distance/lap fields), so
  // divide by 100 to get seconds.
  const durationSeconds = (summary?.workoutTime ?? item.workoutTime ?? item.totalTime ?? 0) / 100;
  const rawElapsed = summary?.totalTime ?? item.totalTime;
  const elapsedSeconds = rawElapsed != null ? rawElapsed / 100 : undefined;

  // Detail distances are centimetres [verified]; list distances are ambiguous —
  // treat implausibly large run distances as centimetres.
  let distanceMeters: number | undefined;
  if (summary?.distance != null) distanceMeters = summary.distance / 100;
  else if (item.distance != null) {
    distanceMeters =
      COROS_RUN_SPORT_TYPES.has(item.sportType) && item.distance > 150_000
        ? item.distance / 100
        : item.distance;
  }

  const elevationGain =
    summary?.elevGain ?? item.elevationGain ?? item.totalAscent ?? item.ascent;

  return {
    provider: "coros",
    providerActivityId: item.labelId,
    startTime: isoFromUnix(start),
    startTimeLocal: start ? localIsoFromUnix(start, offsetMin) : undefined,
    sport: corosSportName(item.sportType),
    durationSeconds,
    elapsedSeconds,
    distanceMeters,
    avgHeartRate: summary?.avgHr ?? item.avgHr,
    maxHeartRate: summary?.maxHr ?? item.maxHr,
    avgPaceSecPerKm: summary?.avgPace,
    elevationGainMeters: elevationGain,
    calories: item.calorie != null ? Math.round(item.calorie / 1000) : undefined,
    trainingLoad: summary?.trainingLoad ?? item.trainingLoad,
    deviceName: item.device,
    title: summary?.name ?? item.name,
    sourcePlannedWorkoutId:
      summary?.hasProgram && summary.programId ? String(summary.programId) : undefined,
    contentFingerprint: fingerprint({
      id: item.labelId,
      start,
      durationSeconds,
      distanceMeters,
      hr: summary?.avgHr ?? item.avgHr,
    }),
  };
}

export function normalizeCorosLaps(
  detail: RawCorosActivityDetail,
): Array<{ lapIndex: number; durationSeconds: number; distanceMeters?: number; avgHeartRate?: number; avgPaceSecPerKm?: number; splitType?: string }> {
  // Prefer the structured-workout lap view when present; else the 1 km auto-laps.
  const lists = detail.lapList ?? [];
  const chosen =
    lists.find((l) => (l.lapItemList?.length ?? 0) > 0 && l.lapDistance !== 100000) ??
    lists.find((l) => (l.lapItemList?.length ?? 0) > 0);
  if (!chosen?.lapItemList) return [];
  return chosen.lapItemList.map((lap, i) => ({
    lapIndex: lap.lapIndex ?? i,
    durationSeconds: (lap.time ?? 0) / 100, // centiseconds
    distanceMeters: lap.distance != null ? lap.distance / 100 : undefined,
    avgHeartRate: lap.avgHr,
    avgPaceSecPerKm: lap.avgPace,
    splitType: chosen.lapDistance === 100000 ? "auto_km" : "workout",
  }));
}
