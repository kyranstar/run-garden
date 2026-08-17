import type { ActivityTelemetry, PlannedStage, SourceActivity } from "@rg/domain";
import { fingerprint, sportIdForCorosCode } from "@rg/domain";
import { NORMALIZER_VERSION, type SourcePlannedWorkout } from "../types.js";
import {
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

/**
 * A stage as COROS actually reports it — `PlannedStage` plus the strength
 * numbers it has no field for.
 *
 * THE BUG THIS TYPE CLOSES (audit 2026-08-17): `buildStrengthProgram` writes a
 * strength step's four numbers — sets (the repeat container), reps
 * (`targetType: 3` + `targetValue`), load (`intensityType: 1`, kg × 1000) and
 * rest (`restType: 1` + `restValue`) — and this normalizer threw three of them
 * away. `targetType: 3` mapped to `durationType: "none"` and kept no value; the
 * intensity switch handled pace, HR and power and FELL THROUGH on load; and
 * nothing anywhere read `restType`. So every COROS strength session the app
 * imported arrived as a bare list of exercise names, which is why the athlete's
 * Goblet Squat showed no sets, no reps and no weight — a round trip through the
 * watch silently erased the prescription the app itself had written.
 *
 * The fields are additive and optional, so a `NormalizedPlannedStage` is a
 * `PlannedStage` everywhere one is expected. Persisting them needs four columns
 * on `planned_workout_stages` (`reps`, `load_kg`, `load_bodyweight`,
 * `rest_seconds`) and the matching optional fields on
 * `domain/workout.ts`'s `plannedStageSchema` — both outside this package.
 * Until those land the numbers reach every reader of `normalizeCorosSchedule`
 * and stop at the DB, which is strictly more than the nothing they reached
 * before.
 */
export interface NormalizedPlannedStage extends PlannedStage {
  /**
   * Reps per set (`targetType: 3`). NOT a duration: a rep step's
   * `durationType` stays `"none"` because the wire states no time for it.
   */
  reps?: number;
  /** External load in kilograms (`intensityType: 1`, grams on the wire). */
  loadKg?: number;
  /**
   * The step is explicitly BODYWEIGHT. A distinct fact from `loadKg: 0`:
   * COROS encodes bodyweight as `intensityCustom: 1` (with `intensityValue`
   * empty or absent), while a real `0` renders "0.00 kg" in its own app.
   *
   * Named to match `plannedStageSchema.loadBodyweight` and the `load_bodyweight`
   * column, NOT the wire's vocabulary. This field spent an hour as `bodyweight`
   * while the schema said `loadBodyweight`: reading only the schema's spelling
   * compiled cleanly and dropped every bodyweight step on the floor — the exact
   * silent loss this whole normalizer exists to stop, one rename away.
   */
  loadBodyweight?: boolean;
  /** Rest after this step in seconds (`restType: 1`); absent = skip rests. */
  restSeconds?: number;
  /**
   * The step's free text (`overview`) — the slot the push path uses to disclose
   * what the wire has no field for ("4s down", "each side", the coach's cue).
   */
  note?: string;
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

/** §5.4 `restType`: 1 = an explicit rest in seconds; 3 = "skip rests". */
const REST_TYPE_EXPLICIT = 1;

/**
 * The load a strength step prescribes, read back off the wire. The write
 * table (§(d)) in reverse, and every row of it is live-verified:
 *
 *   | on the wire                                  | means            |
 *   |----------------------------------------------|------------------|
 *   | `intensityCustom: 1` (value empty OR ABSENT) | bodyweight       |
 *   | a finite `intensityValue`, custom 0          | kg = value/1000  |
 *   | neither                                      | nothing is known |
 *
 * The absent-value case is not hypothetical: the account's own captured
 * strength program (docs/reports/coros-inspect-2026-08-02.json) carries
 * `intensityType: 1, intensityCustom: 1, intensityDisplayUnit: 6` and NO
 * `intensityValue` key at all — the server dropped the empty string the write
 * path sent. A reader that only understood `""` would have called that "no
 * load" instead of "bodyweight".
 *
 * `0` is deliberately NOT folded into bodyweight: the push path emits numeric
 * zero for an explicit 0 kg and the empty string for bodyweight precisely
 * because COROS renders them differently.
 */
function readLoad(ex: RawCorosExercise): { loadKg?: number; loadBodyweight?: boolean } {
  const wire = ex as unknown as Record<string, unknown>;
  if (Number(wire["intensityCustom"] ?? 0) === 1) return { loadBodyweight: true };
  const raw = wire["intensityValue"];
  if (raw === "" || raw == null) return {};
  const grams = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(grams) || grams < 0) return {};
  return { loadKg: grams / 1000 };
}

function normalizeExercise(ex: RawCorosExercise, resolve?: NameResolver): NormalizedPlannedStage {
  const kind = stageKind(ex.exerciseType);
  const stage: NormalizedPlannedStage = {
    id: String(ex.id),
    parentStageId: ex.groupId && String(ex.groupId) !== "0" ? String(ex.groupId) : null,
    order: ex.sortNo ?? Number(ex.id) ?? 0,
    kind,
    durationType: "none",
    label: resolveLabel(ex.name, resolve),
  };
  // The step's own prose, wherever it came from: the push path writes tempo and
  // per-side disclosure here, and a COROS-authored program can carry a cue.
  if (typeof ex.overview === "string" && ex.overview !== "" && !isI18nKey(ex.overview)) {
    stage.note = ex.overview;
  }
  if (kind === "repeat") {
    // A repeat container carries the SET COUNT — the one strength number that
    // always survived — and nothing else worth reading.
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
      // REPS. Still not a duration — the wire states no time for a rep step —
      // but the COUNT is the prescription, and it used to be dropped on the
      // floor here, one line after being read.
      stage.durationType = "none";
      if (ex.targetValue != null && ex.targetValue > 0) stage.reps = ex.targetValue;
      break;
    default:
      stage.durationType = "open";
  }
  // Rest between sets: an explicit `restType: 1` carries seconds; `3` is COROS's
  // own "skip rests" and means the athlete moves straight on.
  if (Number(ex["restType"] ?? 0) === REST_TYPE_EXPLICIT) {
    const rest = Number(ex["restValue"] ?? 0);
    if (Number.isFinite(rest) && rest > 0) stage.restSeconds = rest;
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
    case 1: {
      // LOAD — the one intensity that is not a rate, and the one this switch
      // used to fall through on, turning every weight COROS held into
      // `targetType: "none"` and nothing else.
      //
      // It does not go in `targetLow`/`targetHigh`: those are a range in the
      // units of `targetType`, whose enum (pace | heart_rate | effort | power |
      // none) has no member for kilograms. A number in the wrong unit under
      // the wrong name is how "40 kg" becomes "40 s/km", so the load gets its
      // own fields and `targetType` stays honest at "none".
      Object.assign(stage, readLoad(ex));
      stage.targetType = "none";
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

/**
 * One workout as COROS reports it — a `SourcePlannedWorkout` whose stages carry
 * the strength numbers as well (`NormalizedPlannedStage`). Assignable to
 * `SourcePlannedWorkout` anywhere one is expected; the extra fields are simply
 * visible to callers that want them.
 */
export interface NormalizedCorosWorkout extends Omit<SourcePlannedWorkout, "stages"> {
  stages: NormalizedPlannedStage[];
}

export interface NormalizedCorosSchedule {
  planId: string;
  planName: string;
  planStart?: string;
  planEnd?: string;
  maxIdInPlan: number;
  pbVersion?: string;
  workouts: NormalizedCorosWorkout[];
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

  const workouts: NormalizedCorosWorkout[] = [];
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

/** COROS reports timezone as 15-minute units. When BOTH sources omit it,
 * return undefined rather than fabricating offset 0 — a UTC wall time
 * dressed up as "local" mis-dates every evening activity downstream, and
 * nothing can tell it apart from a real local time (audit#3 T4). */
function tzOffsetMinutes(units: number | undefined): number | undefined {
  return units == null ? undefined : units * 15;
}

function isoFromUnix(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function localIsoFromUnix(seconds: number, offsetMinutes: number): string {
  const d = new Date((seconds + offsetMinutes * 60) * 1000);
  return d.toISOString().replace(".000Z", "").replace("Z", "");
}

/** Wire 0 is a sentinel for "absent" on these fields; only positives count. */
function positive(v: number | undefined): number | undefined {
  return typeof v === "number" && v > 0 ? v : undefined;
}

/**
 * Telemetry extras from the detail payload (effort-analysis spec §1). Every
 * unit conversion here is probe-verified against live payloads (2026-08-06):
 * temperatures ×10 (weather) / ×100 (device), pause centiseconds, pace-zone
 * bounds ms/km. Returns undefined when nothing survives the sentinels so bare
 * activities carry no empty object.
 */
function buildTelemetry(
  item: RawCorosActivityListItem,
  detail?: RawCorosActivityDetail,
): ActivityTelemetry | undefined {
  const summary = detail?.summary;
  const weather = detail?.weather;
  const feel = detail?.sportFeelInfo;
  const t: ActivityTelemetry = {};

  t.avgCadenceSpm = positive(summary?.avgCadence);
  t.maxCadenceSpm = positive(summary?.maxCadence);
  t.avgPowerWatts = positive(summary?.avgPower);
  t.maxPowerWatts = positive(summary?.maxPower);
  t.avgStrideLengthCm = positive(summary?.avgStepLen);
  t.aerobicEffect = positive(summary?.aerobicEffect);
  t.anaerobicEffect = positive(summary?.anaerobicEffect);
  t.vo2maxEstimate = positive(summary?.currentVo2Max);
  t.staminaLevel7d = positive(summary?.staminaLevel7d);
  t.bestKmSecPerKm = positive(summary?.bestKm);
  if (summary?.pauseTime != null) t.pauseSeconds = Math.round(summary.pauseTime / 100);

  const deviceTemp = positive(item.waterTemperature);
  if (deviceTemp != null) t.deviceTempC = deviceTemp / 100;

  if (weather && positive(weather.temperature) != null) {
    t.weatherTempC = weather.temperature! / 10;
    if (positive(weather.bodyFeelTemp) != null) t.weatherFeelsLikeC = weather.bodyFeelTemp! / 10;
    if (positive(weather.humidity) != null) t.humidityPercent = weather.humidity! / 10;
    if (weather.windSpeed != null) t.windKph = weather.windSpeed / 10;
  }

  t.feelRating = positive(feel?.feelType);
  if (feel?.sportNote) t.sportNote = feel.sportNote;

  const pauses = (detail?.pauseList ?? []).map((p) => p.duration ?? 0).filter((d) => d > 0);
  if (pauses.length > 0) {
    t.pauseCount = pauses.length;
    t.longestPauseSeconds = Math.round(Math.max(...pauses) / 100);
  }

  for (const zone of detail?.zoneList ?? []) {
    const buckets = zone.zoneItemList ?? [];
    if (buckets.length === 0) continue;
    if (zone.zoneType === 3) {
      t.hrZones = buckets.map((b) => ({
        lo: b.leftScope ?? 0,
        hi: b.rightScope ?? 0,
        seconds: b.second ?? 0,
      }));
    } else if (zone.zoneType === 0) {
      t.paceZones = buckets.map((b) => ({
        loSecPerKm: (b.leftScope ?? 0) / 1000,
        hiSecPerKm: (b.rightScope ?? 0) / 1000,
        seconds: b.second ?? 0,
      }));
    }
  }

  const cleaned = Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined));
  return Object.keys(cleaned).length > 0 ? (cleaned as ActivityTelemetry) : undefined;
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
  // Time units are PER SOURCE: the detail summary reports centiseconds
  // (matching its distance/lap fields, probe-verified 2026-08-06), but the
  // LIST endpoint reports plain seconds (prod-verified 2026-08-12: a 67-min
  // activity rides the list as 4038). Dividing both was the production
  // duration corruption — every seen-row list refresh shrank durations 100×.
  const durationSeconds =
    summary?.workoutTime != null
      ? summary.workoutTime / 100
      : (item.workoutTime ?? item.totalTime ?? 0);
  const elapsedSeconds =
    summary?.totalTime != null
      ? summary.totalTime / 100
      : (item.totalTime ?? undefined);

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

  // summary.avgPace is 0 on current payloads (pace actually rides in
  // avgSpeed); derive moving pace from duration/distance — unit-safe across
  // sports and both wire generations.
  const avgPaceSecPerKm =
    positive(summary?.avgPace) ??
    (durationSeconds > 0 && distanceMeters != null && distanceMeters >= 100
      ? durationSeconds / (distanceMeters / 1000)
      : undefined);

  return {
    provider: "coros",
    providerActivityId: item.labelId,
    startTime: isoFromUnix(start),
    startTimeLocal: start && offsetMin != null ? localIsoFromUnix(start, offsetMin) : undefined,
    sport: sportIdForCorosCode(item.sportType),
    durationSeconds,
    elapsedSeconds,
    distanceMeters,
    avgHeartRate: summary?.avgHr ?? item.avgHr,
    maxHeartRate: summary?.maxHr ?? item.maxHr,
    avgPaceSecPerKm,
    elevationGainMeters: elevationGain,
    calories: item.calorie != null ? Math.round(item.calorie / 1000) : undefined,
    trainingLoad: summary?.trainingLoad ?? item.trainingLoad,
    deviceName: item.device,
    title: summary?.name ?? item.name,
    sourcePlannedWorkoutId:
      summary?.hasProgram && summary.programId ? String(summary.programId) : undefined,
    telemetry: buildTelemetry(item, detail),
    contentFingerprint: fingerprint({
      // v2: telemetry generation (effort-analysis spec §2). The salt makes
      // every fingerprint differ from v1 exactly once, so the next sync /
      // backfill refreshes stored rows and laps with the new fields.
      v: 2,
      id: item.labelId,
      start,
      durationSeconds,
      distanceMeters,
      hr: summary?.avgHr ?? item.avgHr,
    }),
  };
}

export function normalizeCorosLaps(detail: RawCorosActivityDetail): Array<{
  lapIndex: number;
  durationSeconds: number;
  distanceMeters?: number;
  avgHeartRate?: number;
  avgPaceSecPerKm?: number;
  splitType?: string;
  avgCadenceSpm?: number;
  minHeartRate?: number;
  maxHeartRate?: number;
  elevGainMeters?: number;
  avgGradePercent?: number;
  avgPowerWatts?: number;
  exerciseNameKey?: string;
}> {
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
    avgCadenceSpm: positive(lap.avgCadence),
    minHeartRate: positive(lap.minHr),
    maxHeartRate: positive(lap.maxHr),
    // 0 is legitimate for grade/elevation (flat lap) — keep as reported.
    elevGainMeters: lap.elevGain,
    avgGradePercent: lap.avgGrade,
    avgPowerWatts: positive(lap.avgPower),
    exerciseNameKey: lap.exerciseNameKey || undefined,
  }));
}
