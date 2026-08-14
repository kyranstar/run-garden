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
  /** Hand-ticked race-hub checklist items (coach items are derived from
   * data, never stored). Seeded with defaults on first read. */
  raceChecklist: z
    .array(z.object({ id: z.string(), label: z.string(), done: z.boolean() }))
    .default([]),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const DEFAULT_USER_PREFERENCES: UserPreferences = userPreferencesSchema.parse({});
