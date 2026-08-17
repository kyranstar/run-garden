import type { RawCorosSchedule } from "../coros/raw-types.js";

/**
 * Sanitized COROS Training Hub schedule payload, shaped exactly like
 * GET /training/schedule/query (fields verified in
 * docs/COROS_INTEGRATION_FINDINGS.md §2). All ids/names are synthetic.
 *
 * Dates are relative-coded as "D+n" and resolved by fixtureSchedule(baseDate).
 */

const PLAN_ID = "800000000000001234";

interface TemplateWorkout {
  idInPlan: number;
  dayOffset: number;
  program: Record<string, unknown> | null; // null = rest day entity
  name?: string;
}

const pace = (msPerKm: number) => msPerKm; // documented: milliseconds per km

const easyRun = (idInPlan: number, minutes: number): Record<string, unknown> => ({
  id: `90000000000000${idInPlan}`,
  idInPlan,
  planId: PLAN_ID,
  name: `Easy Run ${minutes} min`,
  overview: "",
  sportType: 1,
  subType: 65535,
  duration: minutes * 60,
  estimatedTime: minutes * 60,
  distance: String(minutes * 60 * 0.0002777 * 100000 * 1.0),
  estimatedDistance: Math.round(minutes * 27.77) * 100,
  trainingLoad: Math.round(minutes * 0.7),
  estimatedValue: Math.round(minutes * 0.7),
  version: 1,
  pbVersion: 2,
  exercises: [
    {
      id: 1,
      name: "T3001",
      exerciseType: 2,
      targetType: 2,
      targetValue: minutes * 60,
      intensityType: 2,
      intensityValue: 120,
      intensityValueExtend: 145,
      sets: 1,
      groupId: "0",
      isGroup: false,
      sortNo: 16777216,
    },
  ],
});

const thresholdWorkout = (idInPlan: number): Record<string, unknown> => ({
  id: `90000000000000${idInPlan}`,
  idInPlan,
  planId: PLAN_ID,
  name: "Threshold 5x5",
  overview: "sid_run_training",
  sportType: 1,
  subType: 65535,
  duration: 3240, // native estimate: 54 min
  estimatedTime: 3240,
  distance: "980000.00",
  estimatedDistance: 980000,
  trainingLoad: 78,
  estimatedValue: 78,
  version: 3,
  pbVersion: 2,
  exercises: [
    { id: 1, name: "T1120", exerciseType: 1, targetType: 2, targetValue: 900, intensityType: 5, sets: 1, groupId: "0", isGroup: false, sortNo: 16777216 },
    { id: 2, name: "Group", exerciseType: 0, targetType: 2, targetValue: 420, intensityType: 0, sets: 5, groupId: "0", isGroup: true, sortNo: 33554432 },
    { id: 3, name: "T3001", exerciseType: 2, targetType: 2, targetValue: 300, intensityType: 3, intensityValue: pace(255000), intensityValueExtend: pace(266000), sets: 1, groupId: 2, isGroup: false, sortNo: 33619968 },
    { id: 4, name: "T1123", exerciseType: 4, targetType: 2, targetValue: 120, intensityType: 5, sets: 1, groupId: 2, isGroup: false, sortNo: 33685504 },
    { id: 5, name: "T1122", exerciseType: 3, targetType: 2, targetValue: 600, intensityType: 5, sets: 1, groupId: "0", isGroup: false, sortNo: 50331648 },
  ],
});

/** Distance-based long run with pace zone targets. */
const longRun = (idInPlan: number, km: number): Record<string, unknown> => ({
  id: `90000000000000${idInPlan}`,
  idInPlan,
  planId: PLAN_ID,
  name: "Long Run",
  overview: "sid_run_training",
  sportType: 1,
  subType: 65535,
  duration: Math.round(km * 6.2 * 60), // native estimate at ~6:12/km
  estimatedTime: Math.round(km * 6.2 * 60),
  distance: `${km * 100000}.00`,
  estimatedDistance: km * 100000,
  trainingLoad: Math.round(km * 6),
  estimatedValue: Math.round(km * 6),
  version: 2,
  pbVersion: 2,
  exercises: [
    {
      id: 1,
      name: "T3001",
      exerciseType: 2,
      targetType: 5,
      targetValue: km * 100000,
      intensityType: 3,
      intensityValue: pace(360000),
      intensityValueExtend: pace(390000),
      sets: 1,
      groupId: "0",
      isGroup: false,
      sortNo: 16777216,
    },
  ],
});

const recoveryRun = (idInPlan: number): Record<string, unknown> => ({
  id: `90000000000000${idInPlan}`,
  idInPlan,
  planId: PLAN_ID,
  name: "Recovery Run",
  overview: "",
  sportType: 1,
  subType: 65535,
  duration: 1800,
  estimatedTime: 1800,
  distance: "450000.00",
  estimatedDistance: 450000,
  trainingLoad: 18,
  estimatedValue: 18,
  version: 1,
  pbVersion: 2,
  exercises: [
    {
      id: 1,
      name: "T3001",
      exerciseType: 2,
      targetType: 2,
      targetValue: 1800,
      intensityType: 2,
      intensityValue: 110,
      intensityValueExtend: 132,
      sets: 1,
      groupId: "0",
      isGroup: false,
      sortNo: 16777216,
    },
  ],
});

/** A workout with NO native duration → exercises fallback estimation path. */
const stridesNoEstimate = (idInPlan: number): Record<string, unknown> => ({
  id: `90000000000000${idInPlan}`,
  idInPlan,
  planId: PLAN_ID,
  name: "Easy + Strides",
  overview: "",
  sportType: 1,
  subType: 65535,
  duration: 0,
  estimatedTime: 0,
  distance: "0",
  estimatedDistance: 0,
  trainingLoad: 0,
  estimatedValue: 0,
  version: 1,
  pbVersion: 2,
  exercises: [
    { id: 1, name: "T1120", exerciseType: 1, targetType: 2, targetValue: 1500, intensityType: 5, sets: 1, groupId: "0", isGroup: false, sortNo: 16777216 },
    { id: 2, name: "Group", exerciseType: 0, targetType: 2, targetValue: 50, intensityType: 0, sets: 6, groupId: "0", isGroup: true, sortNo: 33554432 },
    { id: 3, name: "T3001", exerciseType: 2, targetType: 5, targetValue: 10000, intensityType: 3, intensityValue: pace(220000), intensityValueExtend: pace(240000), sets: 1, groupId: 2, isGroup: false, sortNo: 33619968 },
    { id: 4, name: "T1123", exerciseType: 4, targetType: 2, targetValue: 60, intensityType: 5, sets: 1, groupId: 2, isGroup: false, sortNo: 33685504 },
    { id: 5, name: "T1122", exerciseType: 3, targetType: 2, targetValue: 600, intensityType: 5, sets: 1, groupId: "0", isGroup: false, sortNo: 50331648 },
  ],
});

/**
 * PROD'S OWN SHORT-INTERVAL SHAPE, copied field for field from planned workout
 * `9ca6bb02` (2026-08-17): 40 min easy, a 1-minute cool down, then a 4× group
 * of 15 SECONDS on / 45 seconds off. The cool down really does sit before the
 * strides block — COROS authored it that way and the app must render what is
 * there, not what would be tidy.
 *
 * It is here because sub-minute stages were the one shape no fixture had, and
 * every duration in the app was rounded to whole minutes: this session used to
 * render "4 × 0 min / 1 min recovery" — a prescription of nothing, and a 45s
 * recovery spelled identically to the 60s cool down above it.
 */
const shortStrides = (idInPlan: number): Record<string, unknown> => ({
  id: `90000000000000${idInPlan}`,
  idInPlan,
  planId: PLAN_ID,
  name: "Easy Run with 15-Second Strides",
  overview: "",
  sportType: 1,
  subType: 65535,
  duration: 2700,
  estimatedTime: 2700,
  distance: "750000.00",
  estimatedDistance: 750000,
  trainingLoad: 32,
  estimatedValue: 32,
  version: 1,
  pbVersion: 2,
  exercises: [
    { id: 1, name: "T3001", exerciseType: 2, targetType: 2, targetValue: 2400, intensityType: 2, intensityValue: 118, intensityValueExtend: 140, sets: 1, groupId: "0", isGroup: false, sortNo: 16777216 },
    { id: 2, name: "T1122", exerciseType: 3, targetType: 2, targetValue: 60, intensityType: 5, sets: 1, groupId: "0", isGroup: false, sortNo: 33554432 },
    { id: 3, name: "Group", exerciseType: 0, targetType: 2, targetValue: 60, intensityType: 0, sets: 4, groupId: "0", isGroup: true, sortNo: 50331648 },
    { id: 4, name: "T3001", exerciseType: 2, targetType: 2, targetValue: 15, intensityType: 3, intensityValue: pace(210000), intensityValueExtend: pace(225000), sets: 1, groupId: 3, isGroup: false, sortNo: 50397184 },
    { id: 5, name: "T1123", exerciseType: 4, targetType: 2, targetValue: 45, intensityType: 5, sets: 1, groupId: 3, isGroup: false, sortNo: 50462720 },
  ],
});

const TEMPLATE: TemplateWorkout[] = [
  // Week structure: Mon rest, Tue quality, Wed easy, Thu strides, Fri rest, Sat long, Sun recovery
  { idInPlan: 10, dayOffset: 0, program: null, name: "Rest" },
  { idInPlan: 11, dayOffset: 1, program: thresholdWorkout(11) },
  { idInPlan: 12, dayOffset: 2, program: easyRun(12, 45) },
  { idInPlan: 13, dayOffset: 3, program: stridesNoEstimate(13) },
  { idInPlan: 14, dayOffset: 4, program: null, name: "Rest" },
  { idInPlan: 15, dayOffset: 5, program: longRun(15, 18) },
  { idInPlan: 16, dayOffset: 6, program: recoveryRun(16) },
  { idInPlan: 17, dayOffset: 8, program: thresholdWorkout(17) },
  // Week 2's easy day carries prod's short-interval shape rather than a second
  // plain easy run: `idInPlan` slots are a fixed, contiguous range here (the
  // write executors allocate the next one after `maxIdInPlan`), so a 12th
  // workout would move every create's slot and break 22 unrelated tests.
  { idInPlan: 18, dayOffset: 9, program: shortStrides(18) },
  { idInPlan: 19, dayOffset: 12, program: longRun(19, 20) },
  { idInPlan: 20, dayOffset: 13, program: recoveryRun(20) },
];

function toCorosDay(iso: string): number {
  return Number(iso.replaceAll("-", ""));
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Build the raw schedule as COROS would return it, with the plan's week
 * starting at `baseMonday` (a Monday, YYYY-MM-DD).
 */
export function fixtureRawSchedule(baseMonday: string): RawCorosSchedule {
  const entities = TEMPLATE.map((t, i) => ({
    id: `70000000000000${100 + i}`,
    idInPlan: String(t.idInPlan),
    planId: PLAN_ID,
    planProgramId: String(t.idInPlan),
    happenDay: toCorosDay(addDaysIso(baseMonday, t.dayOffset)),
    dayNo: t.dayOffset + 1,
    sortNo: 1,
    sortNoInSchedule: 1,
    completeRate: "-1.00",
    ...(t.program === null ? { name: t.name } : {}),
  }));
  const programs = TEMPLATE.filter((t) => t.program !== null).map((t) => t.program!) as never[];
  return {
    id: PLAN_ID,
    name: "Fall Half Marathon Build",
    startDay: toCorosDay(baseMonday),
    endDay: toCorosDay(addDaysIso(baseMonday, 83)),
    maxIdInPlan: 20,
    pbVersion: 2,
    version: 7,
    entities,
    programs,
  };
}

export const FIXTURE_PLAN_ID = PLAN_ID;
