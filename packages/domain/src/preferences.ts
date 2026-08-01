import { z } from "zod";

export const schedulingPreferencesSchema = z.object({
  timezone: z.string().default("America/Los_Angeles"),
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
  corosWritesEnabled: z.boolean().default(true),
  gardenRestMode: z.boolean().default(false),
  gardenRestModeUntil: z.string().nullable().default(null),
  reducedMotion: z.boolean().default(false),
  theme: z.enum(["system", "light", "dark"]).default("system"),
});
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export const DEFAULT_USER_PREFERENCES: UserPreferences = userPreferencesSchema.parse({});
