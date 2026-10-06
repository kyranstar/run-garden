import { addDays, sportIdForCorosCode, todayInZone, type UserPreferences } from "@rg/domain";
import { CorosApiError } from "@rg/coros";
import type { RawCorosActivityDetail } from "@rg/providers";
import { fixtureModeEnabled, type Env } from "../env.js";
import type { Db } from "./db.js";
import { corosClient } from "./coros-connection.js";
import { isRuntimeLimit } from "./runtime-limit.js";

/**
 * THE MASKED STRENGTH-SET SCALE PROBE (Phase 2a+ Task 1). The lap-key probe
 * (coros-lap-probe.ts) proved that a strength activity's lap items carry
 * `reps`, `weight`, `intensityValue`, `exerciseId` and `lapType`, and that
 * the summary carries `totalReps` and `totalWeight`. It could not say what
 * unit `weight` is in: the program wire sends kg × 1000, and the ingest
 * (Task 2) must not convert before that is settled.
 *
 * It runs on real personal data, so it returns COUNTS ONLY: how many items
 * carry each field, order-of-magnitude buckets of the positive values, and
 * how `weight` and `intensityValue` relate in scale where both are set. No
 * value, id, name, date or title leaves the Worker. The one deliberate
 * exception is the `byLapType` key: a lap type that is a small integer
 * (0–99, a COROS enum code) is reported as itself, so Task 2 can tell rest
 * laps from work laps; any other lap type is counted as "other".
 *
 * Read-only: the activity list and each detail come through the same cloud
 * client calls corosReadNow makes. Nothing is stored; the only D1 writes are
 * the shared client factory's own session bookkeeping (a token refresh, or
 * marking a failed login), as for every other COROS read.
 */

/** Window, days back from today (inclusive), when none is asked for. */
export const STRENGTH_SET_DEFAULT_DAYS = 60;
/** Requested windows are clamped to 1..this. */
export const STRENGTH_SET_MAX_DAYS = 120;

/**
 * COROS HTTP calls this probe may make in one invocation. Workers Free allows
 * 50 subrequests; the request's own D1 reads (session, preferences, the
 * connection row, at most one token-cache update) are fixed and few, so 36
 * leaves a margin of about ten.
 */
export const SUBREQUEST_BUDGET = 36;
/**
 * The most one detail read can cost: the call, and on an expired token
 * (result 1019) the client's re-login and one retry.
 */
const DETAIL_WORST_CASE = 3;

export function clampWindowDays(days: number): number {
  return Math.min(STRENGTH_SET_MAX_DAYS, Math.max(1, days));
}

/** Lower bound inclusive: "1-10" is 1 ≤ v < 10. */
export const MAGNITUDE_BUCKETS = ["<1", "1-10", "10-100", "100-1k", "1k-10k", "10k-100k", ">=100k"] as const;
export type MagnitudeBucket = (typeof MAGNITUDE_BUCKETS)[number];
const MAGNITUDE_FLOORS = [1, 10, 100, 1_000, 10_000, 100_000];

export interface FieldStats {
  /** Key absent, or null. */
  missing: number;
  /** An empty (or blank) string — how COROS writes "no value" in some fields. */
  empty: number;
  zero: number;
  positive: number;
  negative: number;
  /** A string that is not a number, a boolean, an object, NaN or Infinity. */
  nonNumeric: number;
  /** Of zero/positive/negative: how many arrived as numeric strings. */
  fromString: number;
  /** The positive values, by order of magnitude. */
  magnitude: Record<MagnitudeBucket, number>;
}

export interface ScaleComparison {
  /** Items where both `weight` and `intensityValue` are > 0. */
  compared: number;
  equal: number;
  /** weight == intensityValue × 1000 */
  weightIsIntensityTimes1000: number;
  /** intensityValue == weight × 1000 */
  intensityIsWeightTimes1000: number;
  other: number;
}

/**
 * Which grid the positive weights sit on, read two ways (a second pass, after the magnitudes alone could not tell
 * kg × 1000 from lb × 1000): as thousandths of a unit (whole, half, quarter) and as kg × 1000 of a weight typed in
 * pounds (within 0.02 lb of a whole pound or of a 2.5 lb step). Counts only.
 */
export interface WeightSteps {
  positive: number;
  /** w is a multiple of 1000 (a whole unit, if the wire is unit × 1000). */
  whole: number;
  /** a multiple of 500, not of 1000 */
  half: number;
  /** a multiple of 250, not of 500 */
  quarter: number;
  /** none of the above */
  offGrid: number;
  /** w / 1000 kg is within 0.02 lb of a whole pound */
  kgThousandthsOfWholePounds: number;
  /** w / 1000 kg is within 0.02 lb of a multiple of 2.5 lb */
  kgThousandthsOfTwoAndAHalfPounds: number;
}

/** weight ÷ intensityValue where both are > 0, bucketed around the ratios a unit mix-up would give (1/2.2046, 2.2046, 1000). */
export const RATIO_BUCKETS = [
  "<0.3",
  "0.3-0.44",
  "about 1/2.2046",
  "0.465-0.9",
  "0.9-0.99",
  "about 1",
  "1.01-1.1",
  "1.1-2.1",
  "about 2.2046",
  "2.3-900",
  "about 1000",
  ">=1100",
] as const;
export type RatioBucket = (typeof RATIO_BUCKETS)[number];
const RATIO_FLOORS = [0.3, 0.44, 0.465, 0.9, 0.99, 1.01, 1.1, 2.1, 2.3, 900, 1100];

/** How an activity's summary totalWeight relates to Σ reps × weight over its lap items (activities with a positive total). */
export interface TotalRelation {
  compared: number;
  equal: number;
  totalIsSumTimes1000: number;
  totalIsSumOver1000: number;
  /** total ≈ Σ × 2.2046 (one side in pounds) */
  totalIsSumInPounds: number;
  /** total ≈ Σ ÷ 2.2046 */
  totalIsSumInKilograms: number;
  other: number;
}

export interface StrengthSetStats {
  activitiesWithLapItems: number;
  /** `lapList` entries holding at least one item (more than one per activity means several lap views). */
  lapListsWithItems: number;
  lapItems: {
    total: number;
    /** Small-integer lap types by code; "missing" and "other" otherwise. */
    byLapType: Record<string, number>;
    /** Per lap type: how many of its items carry positive reps, weight and time (tells a rest lap from a work lap). */
    byLapTypeCarrying: Record<string, { reps: number; weight: number; time: number }>;
    /** How the lap items are laid out, for the ingest (Task 2) — counts and small enum codes only. */
    structure: LapStructure;
    reps: FieldStats;
    weight: FieldStats;
    intensityValue: FieldStats;
    weightVsIntensity: ScaleComparison;
    weightOverIntensity: Record<RatioBucket, number>;
    weightSteps: WeightSteps;
    exerciseId: { present: number; absent: number; distinct: number };
  };
  summary: {
    /** Activities whose detail had a summary object. */
    present: number;
    totalWeight: FieldStats;
    totalReps: FieldStats;
    totalWeightVsSets: TotalRelation;
  };
}

export interface LapStructure {
  /** Activities whose items under each lap type are the same sets (exerciseIndex, setIndex, reps, weight, time). */
  lapTypesSameSets: number;
  /** Activities with more than one lap type whose item lists differ. */
  lapTypesDifferentSets: number;
  /** Activities with a single lap type. */
  singleLapType: number;
  distinctExerciseNameKeys: number;
  /** Σ over activities of the distinct exerciseIndex values in its first lap type. */
  exerciseSlots: number;
  /** Items per (activity, lap type, exerciseIndex, setIndex): "1", "2", ">2". */
  itemsPerSet: Record<"1" | "2" | ">2", number>;
  /** Items whose `sets` is above 1 (an item holding several sets), and at most 1. */
  setsAboveOne: number;
  setsAtMostOne: number;
  /** Items with no reps and no weight: with a positive time; and how many share an exerciseIndex with an item that has reps. */
  noRepsNoWeight: { total: number; withTime: number; shareExerciseWithRepItems: number };
  /**
   * The two items of an (exerciseIndex, setIndex) pair in each activity's first lap type: whether exactly one, both
   * or neither carries reps or weight; whether the data item comes first in the list; per role, the targetType code
   * and how many have a positive pauseTime; for pairs with no data, whether the two times are equal.
   */
  pairs: {
    oneHasData: number;
    bothHaveData: number;
    neitherHasData: number;
    dataItemFirst: number;
    dataItemSecond: number;
    neitherTimesEqual: number;
    neitherTimesDiffer: number;
    targetTypeOfDataItem: Record<string, number>;
    targetTypeOfPartner: Record<string, number>;
    targetTypeOfNeitherFirst: Record<string, number>;
    targetTypeOfNeitherSecond: Record<string, number>;
    pauseTimeOfDataItem: number;
    pauseTimeOfPartner: number;
    /** Pairs where both carry data: the two items have the same reps and weight, or not. */
    bothDataSameRepsAndWeight: number;
    bothDataDifferent: number;
    /** Order-of-magnitude buckets of `time` by role (its unit is not known yet: s, 1/10 s, 1/100 s or ms). */
    timeOfDataItem: Record<MagnitudeBucket, number>;
    timeOfPartner: Record<MagnitudeBucket, number>;
    timeOfNeitherFirst: Record<MagnitudeBucket, number>;
    timeOfNeitherSecond: Record<MagnitudeBucket, number>;
  };
  /** In activities whose lap types differ, per lap type code: items, and items carrying reps or weight. */
  differingLapTypes: Record<string, { items: number; withData: number }>;
  /** In activities whose lap types differ: how many sets (fingerprints) appear in only one of them. */
  setsInOneLapTypeOnly: number;
  /** Small enum codes (0–99) by field, "other"/"missing" otherwise. */
  codes: {
    intensityDisplayUnit: Record<string, number>;
    intensityType: Record<string, number>;
    targetType: Record<string, number>;
    exerciseType: Record<string, number>;
  };
}

const POUND_KG = 0.45359237;

function zeroBuckets(): Record<MagnitudeBucket, number> {
  return Object.fromEntries(MAGNITUDE_BUCKETS.map((b) => [b, 0])) as Record<MagnitudeBucket, number>;
}

function bucketTime(into: Record<MagnitudeBucket, number>, value: unknown): void {
  const n = asNumber(value);
  if (n !== undefined && n > 0) into[magnitudeBucket(n)] += 1;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function setFingerprint(item: Record<string, unknown>): string {
  return JSON.stringify([item.exerciseIndex, item.setIndex, asNumber(item.reps), asNumber(item.weight), asNumber(item.time)]);
}

/** The layout of one activity's lap items, folded into `s`. Nothing but counts and enum codes leaves. */
function foldStructure(s: LapStructure, nameKeys: Set<string>, items: readonly Record<string, unknown>[]): void {
  const byType = new Map<string, Record<string, unknown>[]>();
  for (const item of items) {
    const type = lapTypeKey(item.lapType);
    byType.set(type, [...(byType.get(type) ?? []), item]);
    if (typeof item.exerciseNameKey === "string" && item.exerciseNameKey !== "") nameKeys.add(item.exerciseNameKey);
    const sets = asNumber(item.sets);
    if (sets !== undefined && sets > 1) s.setsAboveOne += 1;
    else s.setsAtMostOne += 1;
    bump(s.codes.intensityDisplayUnit, lapTypeKey(item.intensityDisplayUnit));
    bump(s.codes.intensityType, lapTypeKey(item.intensityType));
    bump(s.codes.targetType, lapTypeKey(item.targetType));
    bump(s.codes.exerciseType, lapTypeKey(item.exerciseType));
  }
  const lists = [...byType.values()];
  if (lists.length <= 1) s.singleLapType += 1;
  else {
    const prints = lists.map((list) => list.map(setFingerprint).sort().join("|"));
    if (prints.every((x) => x === prints[0])) s.lapTypesSameSets += 1;
    else {
      s.lapTypesDifferentSets += 1;
      for (const [code, list] of byType) {
        const row = s.differingLapTypes[code] ?? { items: 0, withData: 0 };
        row.items += list.length;
        row.withData += list.filter((i) => (asNumber(i.reps) ?? 0) > 0 || (asNumber(i.weight) ?? 0) > 0).length;
        s.differingLapTypes[code] = row;
      }
      const sets = lists.map((list) => new Set(list.map(setFingerprint)));
      const all = new Set(sets.flatMap((x) => [...x]));
      for (const f of all) if (!sets.every((x) => x.has(f))) s.setsInOneLapTypeOnly += 1;
    }
  }
  const first = lists[0] ?? [];
  const hasData = (i: Record<string, unknown>) => (asNumber(i.reps) ?? 0) > 0 || (asNumber(i.weight) ?? 0) > 0;
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const i of first) {
    const k = JSON.stringify([i.exerciseIndex, i.setIndex]);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  for (const g of groups.values()) {
    if (g.length !== 2) continue;
    const [a, b] = g as [Record<string, unknown>, Record<string, unknown>];
    const pa = hasData(a);
    const pb = hasData(b);
    if (pa && pb) {
      s.pairs.bothHaveData += 1;
      if (asNumber(a.reps) === asNumber(b.reps) && asNumber(a.weight) === asNumber(b.weight)) s.pairs.bothDataSameRepsAndWeight += 1;
      else s.pairs.bothDataDifferent += 1;
    } else if (pa || pb) {
      s.pairs.oneHasData += 1;
      if (pa) s.pairs.dataItemFirst += 1;
      else s.pairs.dataItemSecond += 1;
      const data = pa ? a : b;
      const partner = pa ? b : a;
      bump(s.pairs.targetTypeOfDataItem, lapTypeKey(data.targetType));
      bump(s.pairs.targetTypeOfPartner, lapTypeKey(partner.targetType));
      if ((asNumber(data.pauseTime) ?? 0) > 0) s.pairs.pauseTimeOfDataItem += 1;
      if ((asNumber(partner.pauseTime) ?? 0) > 0) s.pairs.pauseTimeOfPartner += 1;
      bucketTime(s.pairs.timeOfDataItem, data.time);
      bucketTime(s.pairs.timeOfPartner, partner.time);
    } else {
      s.pairs.neitherHasData += 1;
      if (asNumber(a.time) === asNumber(b.time)) s.pairs.neitherTimesEqual += 1;
      else s.pairs.neitherTimesDiffer += 1;
      bump(s.pairs.targetTypeOfNeitherFirst, lapTypeKey(a.targetType));
      bump(s.pairs.targetTypeOfNeitherSecond, lapTypeKey(b.targetType));
      bucketTime(s.pairs.timeOfNeitherFirst, a.time);
      bucketTime(s.pairs.timeOfNeitherSecond, b.time);
    }
  }
  s.exerciseSlots += new Set(first.map((i) => JSON.stringify(i.exerciseIndex))).size;
  for (const list of lists) {
    const perSet = new Map<string, number>();
    for (const i of list) {
      const k = JSON.stringify([i.exerciseIndex, i.setIndex]);
      perSet.set(k, (perSet.get(k) ?? 0) + 1);
    }
    for (const n of perSet.values()) s.itemsPerSet[n === 1 ? "1" : n === 2 ? "2" : ">2"] += 1;
  }
  const repExercises = new Set(first.filter((i) => (asNumber(i.reps) ?? 0) > 0).map((i) => JSON.stringify(i.exerciseIndex)));
  for (const i of first) {
    if ((asNumber(i.reps) ?? 0) > 0 || (asNumber(i.weight) ?? 0) > 0) continue;
    s.noRepsNoWeight.total += 1;
    if ((asNumber(i.time) ?? 0) > 0) s.noRepsNoWeight.withTime += 1;
    if (repExercises.has(JSON.stringify(i.exerciseIndex))) s.noRepsNoWeight.shareExerciseWithRepItems += 1;
  }
}

/** True when `x` is within `tol` of a multiple of `step`. */
function nearMultiple(x: number, step: number, tol: number): boolean {
  const r = x / step;
  return Math.abs(r - Math.round(r)) * step <= tol;
}

function stepOf(steps: WeightSteps, w: number): void {
  steps.positive += 1;
  const rounded = Math.abs(w - Math.round(w)) < 1e-9 ? Math.round(w) : null;
  if (rounded !== null && rounded % 1000 === 0) steps.whole += 1;
  else if (rounded !== null && rounded % 500 === 0) steps.half += 1;
  else if (rounded !== null && rounded % 250 === 0) steps.quarter += 1;
  else steps.offGrid += 1;
  const pounds = w / 1000 / POUND_KG;
  if (nearMultiple(pounds, 1, 0.02)) steps.kgThousandthsOfWholePounds += 1;
  if (nearMultiple(pounds, 2.5, 0.02)) steps.kgThousandthsOfTwoAndAHalfPounds += 1;
}

function ratioBucket(r: number): RatioBucket {
  let i = 0;
  while (i < RATIO_FLOORS.length && r >= RATIO_FLOORS[i]!) i += 1;
  return RATIO_BUCKETS[i]!;
}

/** Within 0.5% of each other. */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.005 * Math.max(Math.abs(a), Math.abs(b));
}

function emptyFieldStats(): FieldStats {
  return {
    missing: 0,
    empty: 0,
    zero: 0,
    positive: 0,
    negative: 0,
    nonNumeric: 0,
    fromString: 0,
    magnitude: Object.fromEntries(MAGNITUDE_BUCKETS.map((b) => [b, 0])) as Record<MagnitudeBucket, number>,
  };
}

/** The value as a finite number when it is one (numeric strings included). */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function magnitudeBucket(n: number): MagnitudeBucket {
  let i = 0;
  while (i < MAGNITUDE_FLOORS.length && n >= MAGNITUDE_FLOORS[i]!) i += 1;
  return MAGNITUDE_BUCKETS[i]!;
}

function tally(stats: FieldStats, value: unknown): void {
  if (value === undefined || value === null) {
    stats.missing += 1;
    return;
  }
  if (typeof value === "string" && value.trim() === "") {
    stats.empty += 1;
    return;
  }
  const n = asNumber(value);
  if (n === undefined) {
    stats.nonNumeric += 1;
    return;
  }
  if (typeof value === "string") stats.fromString += 1;
  if (n === 0) stats.zero += 1;
  else if (n < 0) stats.negative += 1;
  else {
    stats.positive += 1;
    stats.magnitude[magnitudeBucket(n)] += 1;
  }
}

/** Equal up to floating-point noise (52.5 × 1000 must equal 52500). */
function same(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

function lapTypeKey(value: unknown): string {
  if (value === undefined || value === null) return "missing";
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 99 ? String(value) : "other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Counts over the given activity details — pure, and the only place a lap
 * value is looked at. Everything it returns is a count or a fixed label.
 */
export function strengthSetStats(details: readonly RawCorosActivityDetail[]): StrengthSetStats {
  const reps = emptyFieldStats();
  const weight = emptyFieldStats();
  const intensityValue = emptyFieldStats();
  const totalWeight = emptyFieldStats();
  const totalReps = emptyFieldStats();
  const scale: ScaleComparison = {
    compared: 0,
    equal: 0,
    weightIsIntensityTimes1000: 0,
    intensityIsWeightTimes1000: 0,
    other: 0,
  };
  const ratios = Object.fromEntries(RATIO_BUCKETS.map((b) => [b, 0])) as Record<RatioBucket, number>;
  const steps: WeightSteps = {
    positive: 0,
    whole: 0,
    half: 0,
    quarter: 0,
    offGrid: 0,
    kgThousandthsOfWholePounds: 0,
    kgThousandthsOfTwoAndAHalfPounds: 0,
  };
  const totals: TotalRelation = {
    compared: 0,
    equal: 0,
    totalIsSumTimes1000: 0,
    totalIsSumOver1000: 0,
    totalIsSumInPounds: 0,
    totalIsSumInKilograms: 0,
    other: 0,
  };
  const byLapType = new Map<string, number>();
  const carrying = new Map<string, { reps: number; weight: number; time: number }>();
  const structure: LapStructure = {
    lapTypesSameSets: 0,
    lapTypesDifferentSets: 0,
    singleLapType: 0,
    distinctExerciseNameKeys: 0,
    exerciseSlots: 0,
    itemsPerSet: { "1": 0, "2": 0, ">2": 0 },
    setsAboveOne: 0,
    setsAtMostOne: 0,
    noRepsNoWeight: { total: 0, withTime: 0, shareExerciseWithRepItems: 0 },
    pairs: {
      oneHasData: 0,
      bothHaveData: 0,
      neitherHasData: 0,
      dataItemFirst: 0,
      dataItemSecond: 0,
      neitherTimesEqual: 0,
      neitherTimesDiffer: 0,
      targetTypeOfDataItem: {},
      targetTypeOfPartner: {},
      targetTypeOfNeitherFirst: {},
      targetTypeOfNeitherSecond: {},
      pauseTimeOfDataItem: 0,
      pauseTimeOfPartner: 0,
      bothDataSameRepsAndWeight: 0,
      bothDataDifferent: 0,
      timeOfDataItem: zeroBuckets(),
      timeOfPartner: zeroBuckets(),
      timeOfNeitherFirst: zeroBuckets(),
      timeOfNeitherSecond: zeroBuckets(),
    },
    differingLapTypes: {},
    setsInOneLapTypeOnly: 0,
    codes: { intensityDisplayUnit: {}, intensityType: {}, targetType: {}, exerciseType: {} },
  };
  const nameKeys = new Set<string>();
  const exerciseIds = new Set<string>();
  let exercisePresent = 0;
  let exerciseAbsent = 0;
  let activitiesWithLapItems = 0;
  let lapListsWithItems = 0;
  let total = 0;
  let summaries = 0;

  for (const detail of details) {
    const summary = isRecord(detail.summary) ? detail.summary : undefined;
    if (summary) summaries += 1;
    tally(totalWeight, summary?.totalWeight);
    tally(totalReps, summary?.totalReps);

    let hadItems = false;
    let volume = 0;
    const activityItems: Record<string, unknown>[] = [];
    for (const lap of Array.isArray(detail.lapList) ? detail.lapList : []) {
      const items = isRecord(lap) && Array.isArray(lap.lapItemList) ? (lap.lapItemList as unknown[]) : [];
      if (items.length === 0) continue;
      hadItems = true;
      lapListsWithItems += 1;
      for (const raw of items) {
        const item = isRecord(raw) ? raw : {};
        activityItems.push(item);
        total += 1;
        const type = lapTypeKey(item.lapType);
        byLapType.set(type, (byLapType.get(type) ?? 0) + 1);
        const carried = carrying.get(type) ?? { reps: 0, weight: 0, time: 0 };
        if ((asNumber(item.reps) ?? 0) > 0) carried.reps += 1;
        if ((asNumber(item.weight) ?? 0) > 0) carried.weight += 1;
        if ((asNumber(item.time) ?? 0) > 0) carried.time += 1;
        carrying.set(type, carried);
        tally(reps, item.reps);
        tally(weight, item.weight);
        tally(intensityValue, item.intensityValue);

        const w = asNumber(item.weight);
        const iv = asNumber(item.intensityValue);
        const r = asNumber(item.reps);
        if (w !== undefined && w > 0) {
          stepOf(steps, w);
          if (r !== undefined && r > 0) volume += r * w;
        }
        if (w !== undefined && iv !== undefined && w > 0 && iv > 0) {
          ratios[ratioBucket(w / iv)] += 1;
          scale.compared += 1;
          if (same(w, iv)) scale.equal += 1;
          else if (same(w, iv * 1000)) scale.weightIsIntensityTimes1000 += 1;
          else if (same(iv, w * 1000)) scale.intensityIsWeightTimes1000 += 1;
          else scale.other += 1;
        }

        const id = item.exerciseId;
        if (id === undefined || id === null || (typeof id === "string" && id.trim() === "")) {
          exerciseAbsent += 1;
        } else {
          exercisePresent += 1;
          exerciseIds.add(typeof id === "string" ? id : JSON.stringify(id));
        }
      }
    }
    if (hadItems) {
      activitiesWithLapItems += 1;
      foldStructure(structure, nameKeys, activityItems);
    }
    const reported = asNumber(summary?.totalWeight);
    if (reported !== undefined && reported > 0 && volume > 0) {
      totals.compared += 1;
      if (near(reported, volume)) totals.equal += 1;
      else if (near(reported, volume * 1000)) totals.totalIsSumTimes1000 += 1;
      else if (near(reported, volume / 1000)) totals.totalIsSumOver1000 += 1;
      else if (near(reported, volume / POUND_KG)) totals.totalIsSumInPounds += 1;
      else if (near(reported, volume * POUND_KG)) totals.totalIsSumInKilograms += 1;
      else totals.other += 1;
    }
  }

  return {
    activitiesWithLapItems,
    lapListsWithItems,
    lapItems: {
      total,
      byLapType: Object.fromEntries([...byLapType.entries()].sort(([a], [b]) => a.localeCompare(b))),
      byLapTypeCarrying: Object.fromEntries([...carrying.entries()].sort(([a], [b]) => a.localeCompare(b))),
      structure: { ...structure, distinctExerciseNameKeys: nameKeys.size },
      reps,
      weight,
      intensityValue,
      weightVsIntensity: scale,
      weightOverIntensity: ratios,
      weightSteps: steps,
      exerciseId: { present: exercisePresent, absent: exerciseAbsent, distinct: exerciseIds.size },
    },
    summary: { present: summaries, totalWeight, totalReps, totalWeightVsSets: totals },
  };
}

export interface StrengthSetProbeBody extends StrengthSetStats {
  windowDays: number;
  /** Strength activities in the window. */
  strengthActivities: number;
  /** Of those, details read and counted (newest first). */
  activitiesScanned: number;
  /** Details COROS refused or that failed to arrive; not counted. */
  detailFailures: number;
  /** True when the subrequest budget stopped the scan before the oldest activities. */
  truncated: boolean;
  /** COROS HTTP calls this probe made — logins and expired-token retries included. */
  subrequests: number;
  subrequestBudget: number;
}

export type StrengthSetProbeResult =
  | { status: "fixture_mode" }
  | { status: "not_connected" }
  | { status: "coros_error"; code?: string }
  /** Our own subrequest/CPU ceiling — never COROS's failure (runtime-limit.ts). */
  | { status: "runtime_limit" }
  /** The probe's own code failed on what COROS sent. */
  | { status: "probe_error" }
  | { status: "ok"; body: StrengthSetProbeBody };

export async function probeStrengthSetStats(
  db: Db,
  env: Env,
  userId: string,
  prefs: UserPreferences,
  days: number,
  fetchImpl: typeof fetch = fetch,
): Promise<StrengthSetProbeResult> {
  // Fixture mode never talks to real providers (repo-wide convention).
  if (fixtureModeEnabled(env)) return { status: "fixture_mode" };
  let subrequests = 0;
  const counted: typeof fetch = (input, init) => {
    subrequests += 1;
    return fetchImpl(input, init);
  };
  const client = await corosClient(db, env, userId, counted);
  if (!client) return { status: "not_connected" };

  const today = todayInZone(prefs.timezone);
  try {
    const items = await client.getActivities(addDays(today, -days), today);
    const strength = items
      .filter((item) => sportIdForCorosCode(item.sportType) === "strength")
      .sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0) || b.date - a.date);
    const details: RawCorosActivityDetail[] = [];
    let detailFailures = 0;
    let truncated = false;
    for (const item of strength) {
      if (subrequests + DETAIL_WORST_CASE > SUBREQUEST_BUDGET) {
        truncated = true;
        break;
      }
      try {
        // The same detail call corosReadNow's snapshot makes.
        details.push(await client.getActivityDetail(item.labelId, item.sportType));
      } catch (e) {
        if (isRuntimeLimit(e)) throw e; // the whole run hit our ceiling, not this detail
        detailFailures += 1;
      }
    }
    let stats: StrengthSetStats;
    try {
      stats = strengthSetStats(details);
    } catch {
      return { status: "probe_error" };
    }
    return {
      status: "ok",
      body: {
        windowDays: days,
        strengthActivities: strength.length,
        activitiesScanned: details.length,
        detailFailures,
        truncated,
        subrequests,
        subrequestBudget: SUBREQUEST_BUDGET,
        ...stats,
      },
    };
  } catch (e) {
    if (isRuntimeLimit(e)) return { status: "runtime_limit" };
    // Result code only — a CorosApiError message never carries account data,
    // but nothing but the code is needed.
    return { status: "coros_error", ...(e instanceof CorosApiError && e.resultCode ? { code: e.resultCode } : {}) };
  }
}
