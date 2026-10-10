/**
 * THE ATHLETE'S PROFILE, OBJECTIVES AND KEY RESULTS (workout-system principles §5; programme spec §3.6 and its
 * Amendment A). The shapes the profile and objectives routes accept and answer with, and the key-result measures.
 *
 * - The profile holds what no other table owns: goals (a goal id and the athlete's own words), focus areas (a slug,
 *   a label and the region or muscle ids it means), events (races, trips, ski weeks) and a few preferences. Units,
 *   timezone, the race date, places and conditions have their own homes; the profile route returns them read-only.
 * - An objective is something the athlete is working on; its key results are numbers measured from logged data
 *   (`KeyResultMeasure`), never typed in when the data exists. A key result's `target` and `baseline` are in its
 *   `unit` (the athlete's unit); a measure answers in its canonical unit (`canonicalUnitOf`) and also in the key
 *   result's unit (`display`).
 *
 * Every text here is the athlete's own words: data, never instructions.
 */
import { z } from "zod";
import { isLocalDate } from "./time.js";
import { KG_TO_LB } from "./weights.js";
import { GOAL_IDS } from "./workout-doc.js";

const localDate = z.string().refine(isLocalDate, "not a date (YYYY-MM-DD)");
const unique = (xs: readonly unknown[]): boolean => new Set(xs).size === xs.length;
const uniqueIds = (xs: ReadonlyArray<{ id?: string }>): boolean => unique(xs.map((x) => x.id).filter((id) => id !== undefined));

// ── The profile ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const EVENT_KINDS = ["race", "trip", "ski", "travel", "other"] as const;
export const EVENT_PRIORITIES = ["A", "B", "C"] as const;

export const profileGoalSchema = z
  .object({
    id: z.enum(GOAL_IDS),
    /** The goal in the athlete's own words. */
    words: z.string().trim().min(1).max(300),
  })
  .strict();
export type ProfileGoal = z.infer<typeof profileGoalSchema>;

export const focusAreaSchema = z
  .object({
    /** A slug ("left-hip"), the id answers and documents refer to. */
    id: z.string().max(40).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "a lowercase slug (letters, digits and dashes)"),
    label: z.string().trim().min(1).max(60),
    /** Region or muscle ids from the library's vocabularies (the worker checks them): at least one. */
    refs: z.array(z.string().min(1).max(40)).min(1).max(12).refine(unique, "a region or muscle listed twice"),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type FocusArea = z.infer<typeof focusAreaSchema>;

const eventFields = {
  label: z.string().trim().min(1).max(80),
  kind: z.enum(EVENT_KINDS),
  start: localDate,
  end: localDate.optional(),
  priority: z.enum(EVENT_PRIORITIES),
  /** Whether training eases off before it. */
  taper: z.boolean(),
};
const endsAfterStart = (e: { start: string; end?: string }): boolean => e.end === undefined || e.end >= e.start;
const endIssue = { message: "ends before it starts", path: ["end"] };

export const profileEventSchema = z
  .object({ id: z.string().min(1).max(80), ...eventFields })
  .strict()
  .refine(endsAfterStart, endIssue);
export type ProfileEvent = z.infer<typeof profileEventSchema>;

/** An event as `PUT /api/profile` takes it: a new one may come without an id (the server gives it one). */
export const profileEventInputSchema = z
  .object({ id: z.string().min(1).max(80).optional(), ...eventFields })
  .strict()
  .refine(endsAfterStart, endIssue);
export type ProfileEventInput = z.infer<typeof profileEventInputSchema>;

/** Only what no other table owns (units, timezone and the race live in the user's preferences). */
export const profilePreferencesSchema = z
  .object({
    sessionMinutes: z
      .object({ default: z.number().int().min(5).max(240), max: z.number().int().min(5).max(240).optional() })
      .strict()
      .refine((m) => m.max === undefined || m.max >= m.default, { message: "the longest is shorter than the usual", path: ["max"] })
      .optional(),
    /** Days after the ISO week's Monday: 0 = Monday … 6 = Sunday (as a program's preferred days). */
    trainingDays: z.array(z.number().int().min(0).max(6)).max(7).refine(unique, "a day listed twice").optional(),
    /** One of the athlete's places. */
    defaultPlaceId: z.string().min(1).max(80).optional(),
  })
  .strict();
export type ProfilePreferences = z.infer<typeof profilePreferencesSchema>;

/**
 * `PUT /api/profile`: any of the four; each one sent replaces that part whole, the others stay. Nothing else is
 * accepted — units, timezone, the race, places and conditions are changed where they live.
 */
export const profileUpdateSchema = z
  .object({
    goals: z.array(profileGoalSchema).max(10).refine(uniqueIds, "a goal listed twice"),
    focusAreas: z.array(focusAreaSchema).max(20).refine(uniqueIds, "a focus area id listed twice"),
    events: z.array(profileEventInputSchema).max(40).refine(uniqueIds, "an event id listed twice"),
    preferences: profilePreferencesSchema,
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "nothing to change" });
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/** Exact shape of `GET /api/profile` (and of `PUT`'s answer). */
export interface ProfileDto {
  goals: ProfileGoal[];
  focusAreas: FocusArea[];
  events: ProfileEvent[];
  preferences: ProfilePreferences;
  /** Read-only: the user's preferences. */
  units: { distance: "km" | "mi"; weight: "lb" | "kg"; temperature: "F" | "C" };
  /** Read-only: the user's preferences. */
  timezone: string;
  /** Read-only: the race hub's race (the user's preferences); null when none is set. */
  race: { date: string; distanceKm: number | null } | null;
  /** Read-only: the places service — the default first. */
  places: Array<{ id: string; name: string; equipment: string[]; implements: Record<string, string>; isDefault: boolean }>;
  /** Read-only: every condition profile the library knows, labelled by the profile, and whether it is on. */
  conditions: Array<{ profileId: string; label: string; active: boolean; since: string | null }>;
  /** When the profile was last written; null before the first write. */
  updatedAt: string | null;
}

// ── Key-result measures ─────────────────────────────────────────────────────────────────────────────────────────────

/** Days back from today (today included) a measure reads. */
const windowDays = (def: number) => z.number().int().min(7).max(365).default(def);
const libraryIds = z.array(z.string().min(1).max(80)).min(1).max(10).refine(unique, "a move listed twice");
const distanceM = z.number().min(1000).max(200_000);

export const BEST_SET_METRICS = ["e1rm", "load_at_reps", "reps_at_load"] as const;

export const keyResultMeasureSchema = z
  .discriminatedUnion("kind", [
    /** The longest hold of these moves (performed sets: app and watch sessions). */
    z.object({ kind: z.literal("hold_max"), libraryIds, windowDays: windowDays(90) }).strict(),
    /** The best set of these moves: estimated one-rep max (Epley), the heaviest load for `reps`, or the most reps at `loadKg`. */
    z
      .object({
        kind: z.literal("best_set"),
        libraryIds,
        metric: z.enum(BEST_SET_METRICS),
        reps: z.number().int().min(1).max(50).optional(),
        loadKg: z.number().min(0).max(500).optional(),
        windowDays: windowDays(90),
      })
      .strict(),
    /** The fastest run of at least `distanceM` (up to 10 % longer), its time scaled to exactly `distanceM`. */
    z.object({ kind: z.literal("run_best"), distanceM, windowDays: windowDays(180) }).strict(),
    /** Pace (s/km) of runs at least `minDurationSec` long whose average heart rate is in [hrLow, hrHigh]. */
    z
      .object({
        kind: z.literal("pace_at_hr"),
        hrLow: z.number().int().min(40).max(230),
        hrHigh: z.number().int().min(40).max(230),
        minDurationSec: z.number().int().min(60).max(36_000).default(1200),
        windowDays: windowDays(90),
      })
      .strict(),
    /** The watch's threshold pace (s/km), day by day. */
    z.object({ kind: z.literal("threshold_pace"), windowDays: windowDays(90) }).strict(),
    /** The race hub's predicted time for `distanceM` from that day's threshold pace, day by day. */
    z.object({ kind: z.literal("predicted_time"), distanceM, windowDays: windowDays(90) }).strict(),
    /** A check-in answer (Stage 4 adds the questions). */
    z.object({ kind: z.literal("checkin"), questionId: z.string().min(1).max(60) }).strict(),
    /** A periodic test (Stage 4 adds the tests). */
    z.object({ kind: z.literal("test"), testId: z.string().min(1).max(80) }).strict(),
  ])
  .superRefine((m, ctx) => {
    if (m.kind === "best_set" && m.metric === "load_at_reps" && m.reps === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["reps"], message: "the heaviest load needs the reps it is for" });
    }
    if (m.kind === "best_set" && m.metric === "reps_at_load" && m.loadKg === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["loadKg"], message: "the most reps needs the load they are at" });
    }
    if (m.kind === "pace_at_hr" && m.hrLow > m.hrHigh) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["hrHigh"], message: "the heart-rate range is upside down" });
    }
  });
export type KeyResultMeasure = z.output<typeof keyResultMeasureSchema>;
export type KeyResultMeasureInput = z.input<typeof keyResultMeasureSchema>;
export type KeyResultMeasureKind = KeyResultMeasure["kind"];

// ── Units ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const KEY_RESULT_UNITS = ["s", "min", "kg", "lb", "reps", "s/km", "s/mi", "score"] as const;
export type KeyResultUnit = (typeof KEY_RESULT_UNITS)[number];
/** The unit a measure computes in. */
export type CanonicalUnit = "s" | "kg" | "reps" | "s/km" | "score";

export function canonicalUnitOf(m: KeyResultMeasure): CanonicalUnit {
  switch (m.kind) {
    case "hold_max":
    case "run_best":
    case "predicted_time":
      return "s";
    case "best_set":
      return m.metric === "reps_at_load" ? "reps" : "kg";
    case "pace_at_hr":
    case "threshold_pace":
      return "s/km";
    case "checkin":
    case "test":
      return "score";
  }
}

const SAME_DIMENSION: Record<CanonicalUnit, readonly KeyResultUnit[]> = {
  s: ["s", "min"],
  kg: ["kg", "lb"],
  reps: ["reps"],
  "s/km": ["s/km", "s/mi"],
  score: ["score"],
};

/** The units a key result on this measure may be kept in. A test (Stage 4) may be any. */
export function unitsFor(m: KeyResultMeasure): readonly KeyResultUnit[] {
  return m.kind === "test" ? KEY_RESULT_UNITS : SAME_DIMENSION[canonicalUnitOf(m)];
}

/** The athlete's own unit for this measure: weights in their weight unit, paces per km or mile as they read distance. */
export function defaultUnitFor(m: KeyResultMeasure, prefs: { weightUnit: "lb" | "kg"; units: "km" | "mi" }): KeyResultUnit {
  const canonical = canonicalUnitOf(m);
  if (canonical === "kg") return prefs.weightUnit;
  if (canonical === "s/km") return prefs.units === "mi" ? "s/mi" : "s/km";
  return canonical;
}

/** Which way is better: longer holds and heavier sets up, faster times and paces down; null when either can be. */
export function naturalDirection(m: KeyResultMeasure): "up" | "down" | null {
  switch (m.kind) {
    case "hold_max":
    case "best_set":
      return "up";
    case "run_best":
    case "pace_at_hr":
    case "threshold_pace":
    case "predicted_time":
      return "down";
    case "checkin":
    case "test":
      return null;
  }
}

const KM_PER_MI = 1.609344;
const PER_CANONICAL: Record<KeyResultUnit, number> = {
  s: 1,
  min: 1 / 60,
  kg: 1,
  lb: KG_TO_LB,
  reps: 1,
  "s/km": 1,
  "s/mi": KM_PER_MI,
  score: 1,
};
const DECIMALS: Record<KeyResultUnit, number> = { s: 0, min: 2, kg: 1, lb: 1, reps: 0, "s/km": 0, "s/mi": 0, score: 1 };

/** A canonical value in a key result's unit, rounded as that unit reads (seconds whole, weights to 0.1). */
export function displayValue(value: number, canonical: CanonicalUnit, unit: KeyResultUnit): number {
  const same = SAME_DIMENSION[canonical].includes(unit);
  const converted = same ? value * PER_CANONICAL[unit] : value;
  const f = 10 ** (same ? DECIMALS[unit] : 2);
  return Math.round(converted * f) / f;
}

/** A value in a key result's unit, in the measure's canonical unit (the reverse of `displayValue`, unrounded). */
export function canonicalValue(value: number, canonical: CanonicalUnit, unit: KeyResultUnit): number {
  return SAME_DIMENSION[canonical].includes(unit) ? value / PER_CANONICAL[unit] : value;
}

// ── Progress ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How far `current` can be trusted:
 *  - `measured` — three or more points that show capacity;
 *  - `sparse`   — one or two;
 *  - `capped`   — `current` comes from a set a prescription stopped (the player stops a timed hold at its
 *                 prescription; a set done exactly as prescribed is no max): the athlete can do at least this much —
 *                 a test would tell;
 *  - `none`     — nothing to measure (`missing` says what).
 */
export const KEY_RESULT_EVIDENCE = ["measured", "sparse", "capped", "none"] as const;
export type KeyResultEvidence = (typeof KEY_RESULT_EVIDENCE)[number];

export interface KeyResultPoint {
  /** The day (LocalDate). */
  date: string;
  /** In the measure's canonical unit. */
  value: number;
  /** In the key result's unit. */
  display: number;
  /** The day's best came from a set a prescription stopped (hold_max, best_set). */
  capped?: true;
  /** What the run was (run_best). */
  label?: "race" | "test" | "training";
}

export interface KeyResultProgress {
  /** The canonical unit of `current` and every point's `value`. */
  unit: CanonicalUnit;
  current: number | null;
  /** Oldest first: a point per day (strength, threshold, prediction) or per run (run_best, pace_at_hr). */
  series: KeyResultPoint[];
  /** The day of the latest point (LocalDate); null when there is none. */
  lastMeasuredAt: string | null;
  /** Points in the series. */
  sampleSize: number;
  evidence: KeyResultEvidence;
  /** Why there is nothing to measure, in plain words (evidence `none`). */
  missing?: string;
  /** `current` in the key result's unit. */
  display: { unit: KeyResultUnit; current: number | null };
}

// ── Objectives and key results ──────────────────────────────────────────────────────────────────────────────────────

export const OBJECTIVE_STATUSES = ["active", "paused", "done", "dropped"] as const;
export type ObjectiveStatus = (typeof OBJECTIVE_STATUSES)[number];
export const KEY_RESULT_DIRECTIONS = ["up", "down"] as const;
export type KeyResultDirection = (typeof KEY_RESULT_DIRECTIONS)[number];

/** Most key results one objective holds (a progress read measures them all in one request). */
export const MAX_KEY_RESULTS = 10;

const keyResultFields = {
  label: z.string().trim().min(1).max(120),
  measure: keyResultMeasureSchema,
  /** Defaults to the measure's way (longer, heavier up; faster down); a check-in or test needs one. */
  direction: z.enum(KEY_RESULT_DIRECTIONS).optional(),
  /** In `unit`. */
  baseline: z.number().finite().nullable().optional(),
  /** In `unit`. */
  target: z.number().finite().nullable().optional(),
  /** Defaults to the athlete's unit for the measure. */
  unit: z.enum(KEY_RESULT_UNITS).optional(),
  dueDate: localDate.nullable().optional(),
};

function checkKeyResult(kr: { measure: KeyResultMeasure; direction?: KeyResultDirection; unit?: KeyResultUnit }, ctx: z.RefinementCtx): void {
  if (kr.unit !== undefined && !unitsFor(kr.measure).includes(kr.unit)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unit"], message: `not a unit this measure is kept in (${unitsFor(kr.measure).join(", ")})` });
  }
  const natural = naturalDirection(kr.measure);
  if (natural === null && kr.direction === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["direction"], message: "say whether up or down is better" });
  }
  if (natural !== null && kr.direction !== undefined && kr.direction !== natural) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["direction"], message: `better is ${natural} for this measure` });
  }
}

export const keyResultCreateSchema = z.object(keyResultFields).strict().superRefine(checkKeyResult);
/** In a `PUT`: an entry with the id of one of the objective's key results changes it; one without is new. */
export const keyResultUpdateSchema = z
  .object({ id: z.string().min(1).max(80).optional(), ...keyResultFields })
  .strict()
  .superRefine(checkKeyResult);
export type KeyResultInput = z.input<typeof keyResultUpdateSchema>;

const objectiveFields = {
  title: z.string().trim().min(1).max(120),
  why: z.string().trim().max(500).nullable(),
  status: z.enum(OBJECTIVE_STATUSES),
  goalIds: z.array(z.enum(GOAL_IDS)).max(6).refine(unique, "a goal listed twice"),
  /** Board order: lower first. */
  sort: z.number().int().min(0).max(100_000),
};

/** `POST /api/objectives`. */
export const objectiveCreateSchema = z
  .object({
    title: objectiveFields.title,
    why: objectiveFields.why.optional(),
    status: objectiveFields.status.default("active"),
    goalIds: objectiveFields.goalIds.default([]),
    sort: objectiveFields.sort.default(0),
    keyResults: z.array(keyResultCreateSchema).max(MAX_KEY_RESULTS).default([]),
  })
  .strict();
export type ObjectiveCreate = z.input<typeof objectiveCreateSchema>;

/** `PUT /api/objectives/:id`: what is sent changes; `keyResults`, when sent, is the whole list (one left out is deleted). */
export const objectiveUpdateSchema = z
  .object({
    title: objectiveFields.title,
    why: objectiveFields.why,
    status: objectiveFields.status,
    goalIds: objectiveFields.goalIds,
    sort: objectiveFields.sort,
    keyResults: z.array(keyResultUpdateSchema).max(MAX_KEY_RESULTS).refine(uniqueIds, "a key result listed twice"),
  })
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: "nothing to change" });
export type ObjectiveUpdate = z.input<typeof objectiveUpdateSchema>;

export interface KeyResultDto {
  id: string;
  objectiveId: string;
  label: string;
  /** Null when the stored measure can no longer be read. */
  measure: KeyResultMeasure | null;
  direction: KeyResultDirection;
  baseline: number | null;
  target: number | null;
  unit: KeyResultUnit;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectiveDto {
  id: string;
  title: string;
  why: string | null;
  status: ObjectiveStatus;
  goalIds: string[];
  sort: number;
  createdAt: string;
  updatedAt: string;
  /** Oldest first. */
  keyResults: KeyResultDto[];
}

/** Exact shape of `GET /api/objectives/:id/progress`. */
export interface ObjectiveProgressDto {
  objectiveId: string;
  /** The athlete's today the windows end on. */
  today: string;
  keyResults: Array<{ keyResult: KeyResultDto; progress: KeyResultProgress }>;
}
