import { z } from "zod";

export const schedulingPreferencesSchema = z.object({
  timezone: z.string().default("America/New_York"),
  weekdayMorningTime: z.string().default("07:00"),
  weekdayEveningTime: z.string().default("19:00"),
  weekendMorningTime: z.string().default("08:00"),
  /** Wall-clock time the evening before a morning run ("protect tonight's sleep"). */
  eveningReminderTime: z.string().default("20:30"),
  latestEveningFinish: z.string().default("21:00"),
  defaultWindow: z.enum(["morning", "evening"]).default("morning"),
  bufferBeforeMinutes: z.number().int().min(0).max(120).default(10),
  bufferAfterMinutes: z.number().int().min(0).max(180).default(15),
  /** Same-day reminder before a morning run. */
  preRunReminderMinutes: z.number().int().min(0).max(240).default(30),
  /** Same-day reminder before an evening run. */
  eveningPreRunReminderMinutes: z.number().int().min(0).max(240).default(60),
});
export type SchedulingPreferences = z.infer<typeof schedulingPreferencesSchema>;

export const DEFAULT_SCHEDULING_PREFERENCES: SchedulingPreferences =
  schedulingPreferencesSchema.parse({});

// ── Settings → Coach (Stage 3 Task 10; spec §6) ─────────────────────────────

/**
 * How the coach designer starts when the athlete doesn't say, and how much one run may spend: `coach` in the user's
 * preferences. Every field is optional and an absent one is its default (`coachSettings`), so nothing is written
 * until the athlete sets something, and a default changed later reaches everyone who never set it.
 */
export const COACH_SCOPE_KINDS = ["now", "later_today", "week", "next_n"] as const;
export type CoachScopeKind = (typeof COACH_SCOPE_KINDS)[number];

/** "Next N workouts": how many, at least and at most, and when unset. */
export const COACH_NEXT_N = { min: 1, max: 7, default: 3 } as const;
/** Preferred training times, at most (later today and a set's days are timed around them). */
export const COACH_TRAINING_TIMES_MAX = 3;
/** A run's spending limit until the athlete lowers it — and the most it may be: $1.50 for one workout (now, later
 * today), $6 for a set (this week, the next workouts). The worker's `RUN_CEILING_MICROS` is these. */
export const COACH_CEILING_DEFAULTS_USD = { day: 1.5, set: 6 } as const;
/** The least a limit may be set to. */
export const COACH_CEILING_MIN_USD = 0.25;

export type CoachCeilingKind = keyof typeof COACH_CEILING_DEFAULTS_USD;
/** The limit a scope runs under: one workout's, or a set's. */
export const ceilingKindOf = (scope: CoachScopeKind): CoachCeilingKind =>
  scope === "now" || scope === "later_today" ? "day" : "set";

const wholeCents = (usd: number): boolean => Math.abs(Math.round(usd * 100) - usd * 100) < 1e-6;
const coachCeiling = (kind: CoachCeilingKind) => {
  const max = COACH_CEILING_DEFAULTS_USD[kind];
  return z
    .number()
    .min(COACH_CEILING_MIN_USD, `at least $${COACH_CEILING_MIN_USD.toFixed(2)}`)
    .max(max, `at most $${max.toFixed(2)}: a limit can be lowered, never raised`)
    .refine(wholeCents, "whole cents");
};

export const coachPreferencesSchema = z
  .object({
    defaultScope: z.enum(COACH_SCOPE_KINDS).optional(),
    nextN: z.number().int().min(COACH_NEXT_N.min).max(COACH_NEXT_N.max).optional(),
    /** Clock times, HH:MM in the athlete's timezone. */
    trainingTimes: z
      .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a clock time, HH:MM"))
      .max(COACH_TRAINING_TIMES_MAX)
      .refine((ts) => new Set(ts).size === ts.length, "a time listed twice")
      .optional(),
    ceilingsUsd: z.object({ day: coachCeiling("day").optional(), set: coachCeiling("set").optional() }).strict().optional(),
  })
  .strict();
export type CoachPreferences = z.infer<typeof coachPreferencesSchema>;

/** The settings in force: what the athlete set, else the defaults. */
export interface CoachSettings {
  defaultScope: CoachScopeKind;
  nextN: number;
  trainingTimes: string[];
  ceilingsUsd: { day: number; set: number };
}

export function coachSettings(stored: CoachPreferences | null | undefined): CoachSettings {
  const limit = (kind: CoachCeilingKind): number => Math.min(stored?.ceilingsUsd?.[kind] ?? Infinity, COACH_CEILING_DEFAULTS_USD[kind]);
  return {
    defaultScope: stored?.defaultScope ?? "now",
    nextN: stored?.nextN ?? COACH_NEXT_N.default,
    trainingTimes: [...(stored?.trainingTimes ?? [])].sort(),
    ceilingsUsd: { day: limit("day"), set: limit("set") },
  };
}

export const userPreferencesSchema = schedulingPreferencesSchema.extend({
  calendarId: z.string().nullable().default(null),
  mirrorWeeksAhead: z.number().int().min(1).max(16).default(8),
  mirrorWeeksBehind: z.number().int().min(0).max(8).default(2),
  aiEnabled: z.boolean().default(true),
  // Ships OFF: Run Garden stays in Calendar-only mode until the reversible
  // COROS write spike succeeds on the real account and the user opts in
  // (see docs/COROS_INTEGRATION_FINDINGS.md §4). Never overwrite a COROS plan
  // with an unproven write path by default.
  corosWritesEnabled: z.boolean().default(false),
  gardenRestMode: z.boolean().default(false),
  gardenRestModeUntil: z.string().nullable().default(null),
  /** The next race (ISO date). Drawn as a labeled line on plan charts and
   * feeds the weekly brief's race-week awareness. */
  raceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  /** The race's distance in km (5, 10, 21.0975, 42.195, or anything else).
   * Null = unknown, and the race strip then makes NO time prediction rather
   * than assuming a 10K (audit#3-b #1). */
  raceDistanceKm: z.number().positive().max(200).nullable().default(null),
  /** The race course's total climb in metres, from the race's own page, and
   * a coarse profile as the fallback. Terrain awareness compares these
   * against the athlete's measured climb per km (2026-08-14). */
  raceCourseClimbMetres: z.number().min(0).max(20000).nullable().default(null),
  raceCourseProfile: z.enum(["flat", "rolling", "hilly"]).nullable().default(null),
  reducedMotion: z.boolean().default(false),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  /** Display units for distance and pace, applied everywhere a number
   * renders (2026-08-14). Stored values stay metric; conversion happens at
   * the display edge only. */
  units: z.enum(["km", "mi"]).default("km"),
  /** Display unit for temperatures (weather, watch thermometer) — its own
   * setting, not derived from `units`: metric-distance athletes who read °F
   * exist and asked. Storage stays °C. */
  temperatureUnit: z.enum(["F", "C"]).default("F"),
  /** Hand-ticked race-hub checklist items (coach items are derived from
   * data, never stored). Seeded with defaults on first read. */
  raceChecklist: z
    .array(z.object({ id: z.string(), label: z.string(), done: z.boolean() }))
    .default([]),
  /** Unit for suggested and typed exercise weights. Logged weights keep the
   * unit they were typed in; comparisons happen in kg. */
  weightUnit: z.enum(["lb", "kg"]).default("lb"),
  /** Equipment the athlete plans to get (library ids); shows which moves it
   * would unlock. */
  equipmentWishlist: z.array(z.string()).default([]),
  /** Settings → Coach (absent until the athlete sets one). A stored value that no longer reads is no settings — the
   * defaults — never a failure of every other preference read with it. */
  coach: coachPreferencesSchema.optional().catch(undefined),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const DEFAULT_USER_PREFERENCES: UserPreferences = userPreferencesSchema.parse({});
