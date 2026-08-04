/**
 * Raw COROS Training Hub API shapes, as verified against community client
 * source code and captured payloads (docs/COROS_INTEGRATION_FINDINGS.md §2).
 * Fields we do not consume are typed loosely and passed through untouched —
 * schedule writes must resend raw objects byte-for-byte.
 */

export interface CorosEnvelope<T> {
  apiCode: string;
  message: string;
  result: string; // "0000" = success
  data: T;
}

/** entities[] element of /training/schedule/query. */
export interface RawCorosEntity {
  id?: string;
  idInPlan: string | number;
  planId?: string;
  planProgramId?: string | number;
  happenDay: string | number; // YYYYMMDD
  dayNo?: number;
  sortNo?: number;
  sortNoInSchedule?: number;
  completeRate?: string;
  sportData?: { name?: string; distance?: number; duration?: number; happenDay?: number };
  [key: string]: unknown;
}

/** exercises[] element inside a program. */
export interface RawCorosExercise {
  id: number | string;
  name?: string;
  exerciseType: number; // 0=repeat group, 1=warmup, 2=work, 3=cooldown, 4=rest/recovery
  targetType?: number; // 2=time(s), 3=reps, 5=distance(m*100)
  targetValue?: number;
  intensityType?: number; // 1=weight 2=hr 3=pace 4=speed 5=none 6=power 7=cadence
  intensityValue?: number; // pace: ms/km fast bound; hr: bpm low
  intensityValueExtend?: number; // pace: ms/km slow bound; hr: bpm high
  isIntensityPercent?: boolean;
  intensityPercent?: number;
  intensityPercentExtend?: number;
  sets?: number; // repeat count on group containers
  groupId?: string | number;
  isGroup?: boolean;
  sortNo?: number;
  overview?: string;
  [key: string]: unknown;
}

/** programs[] element of /training/schedule/query. */
export interface RawCorosProgram {
  id?: string;
  idInPlan: string | number;
  planId?: string;
  name?: string;
  overview?: string;
  sportType?: number; // workout namespace: 1=Run 2=Bike 3=Swim 4=Strength
  subType?: number; // 65535 = structured
  duration?: number; // seconds — the COROS-native estimate
  estimatedTime?: number; // mirrors duration
  distance?: string | number; // centimetres, 2dp string
  estimatedDistance?: number; // centimetres
  trainingLoad?: number;
  estimatedValue?: number;
  version?: number | string;
  pbVersion?: number | string;
  exercises?: RawCorosExercise[];
  [key: string]: unknown;
}

/** data of /training/schedule/query — the active plan object. */
export interface RawCorosSchedule {
  id?: string; // planId
  name?: string;
  startDay?: number;
  endDay?: number;
  maxIdInPlan?: number | string;
  pbVersion?: number | string;
  version?: number | string;
  entities?: RawCorosEntity[];
  programs?: RawCorosProgram[];
  [key: string]: unknown;
}

/** dataList[] element of /activity/query. */
export interface RawCorosActivityListItem {
  labelId: string;
  date: number; // YYYYMMDD
  name?: string;
  sportType: number; // activity namespace: 100/101/102/103 = run family
  startTime?: number; // unix seconds
  endTime?: number;
  startTimezone?: number; // 15-minute units
  distance?: number;
  totalTime?: number;
  workoutTime?: number;
  trainingLoad?: number;
  avgHr?: number;
  maxHr?: number;
  device?: string;
  calorie?: number; // physical cal (divide by 1000 for kcal)
  ascent?: number;
  totalAscent?: number;
  elevationGain?: number;
  [key: string]: unknown;
}

/** summary of /activity/detail/query. */
export interface RawCorosActivitySummary {
  distance?: number; // centimetres
  totalTime?: number;
  workoutTime?: number;
  avgHr?: number;
  maxHr?: number;
  avgPace?: number; // sec/km
  adjustedPace?: number;
  trainingLoad?: number;
  elevGain?: number;
  startTimestamp?: number;
  endTimestamp?: number;
  timezone?: number;
  sportType?: number;
  name?: string;
  planId?: string | number;
  programId?: string | number;
  hasProgram?: number;
  [key: string]: unknown;
}

export interface RawCorosLapItem {
  lapIndex?: number;
  distance?: number; // centimetres
  time?: number; // centiseconds
  avgPace?: number; // sec/km
  avgHr?: number;
  lapType?: number;
  [key: string]: unknown;
}

export interface RawCorosActivityDetail {
  summary?: RawCorosActivitySummary;
  lapList?: Array<{
    type?: number;
    lapDistance?: number;
    lapItemList?: RawCorosLapItem[];
  }>;
  [key: string]: unknown;
}

/** Run-family activity sportType codes (activity namespace). */
export const COROS_RUN_SPORT_TYPES = new Set([100, 101, 102, 103]);

/**
 * Activity sportType codes the bridge admits into the import (activity
 * namespace). Anything not in this map is skipped by `buildSnapshot` /
 * `buildActivityBackfill` and tallied into `skippedSportTypes` instead.
 *
 * `"other"` means: ingest it, count it as training load, show it in activity
 * history — but it is not one of the garden's three disciplines and gets no
 * balance axis, unlock species, or insight view of its own. Ski earns that
 * because the load signals (loadRatio, ramp, monotony, hardStack) explicitly
 * span every sport, and a ski day the app never stored made those numbers
 * understate a winter block by a third.
 */
export const COROS_ADMITTED_SPORT_TYPES: ReadonlyMap<
  number,
  "run" | "strength" | "yoga" | "other"
> = new Map([
  [100, "run"],
  [101, "run"],
  [102, "run"],
  [103, "run"],
  [402, "strength"],
  [403, "yoga"],
  [904, "yoga"],
  [500, "other"], // ski — load only
]);

export function corosSportName(sportType: number): string {
  if (COROS_RUN_SPORT_TYPES.has(sportType)) return "run";
  if (sportType >= 200 && sportType < 300) return "bike";
  if (sportType >= 300 && sportType < 400) return "swim";
  if (sportType === 402) return "strength";
  if (sportType === 403 || sportType === 904) return "yoga";
  if (sportType === 500) return "ski";
  if (sportType === 400 || sportType === 401) return "cardio";
  if (sportType === 900) return "walk";
  return `coros_${sportType}`;
}
