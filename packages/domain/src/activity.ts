import { z } from "zod";

export type ActivityProviderName = "coros";

const zoneBucketSchema = z.object({
  lo: z.number(),
  hi: z.number(),
  seconds: z.number(),
});

const paceZoneBucketSchema = z.object({
  /** Slower bound, sec/km. */
  loSecPerKm: z.number(),
  /** Faster bound, sec/km. */
  hiSecPerKm: z.number(),
  seconds: z.number(),
});

/**
 * Per-activity telemetry extras (effort-analysis spec §1–2). Every field
 * optional; wire zeros that mean "absent" are dropped by the normalizer, so a
 * present field is a real reading. Stored as one JSON column on activities.
 */
export const activityTelemetrySchema = z.object({
  avgCadenceSpm: z.number().optional(),
  maxCadenceSpm: z.number().optional(),
  avgPowerWatts: z.number().optional(),
  maxPowerWatts: z.number().optional(),
  avgStrideLengthCm: z.number().optional(),
  /** COROS training-effect scores, 0–5. */
  aerobicEffect: z.number().optional(),
  anaerobicEffect: z.number().optional(),
  vo2maxEstimate: z.number().optional(),
  staminaLevel7d: z.number().optional(),
  /** Fastest km of the effort, sec/km. */
  bestKmSecPerKm: z.number().optional(),
  pauseSeconds: z.number().optional(),
  pauseCount: z.number().optional(),
  longestPauseSeconds: z.number().optional(),
  /** Watch thermometer, °C — wrist-warmed, reads ~2–3 °C above air. */
  deviceTempC: z.number().optional(),
  /** Meteo record (AccuWeather via COROS), outdoor activities only. */
  weatherTempC: z.number().optional(),
  weatherFeelsLikeC: z.number().optional(),
  humidityPercent: z.number().optional(),
  windKph: z.number().optional(),
  /** Self-reported post-workout feel, 1–5, 5 = strongest. */
  feelRating: z.number().optional(),
  sportNote: z.string().optional(),
  hrZones: z.array(zoneBucketSchema).optional(),
  paceZones: z.array(paceZoneBucketSchema).optional(),
});
export type ActivityTelemetry = z.infer<typeof activityTelemetrySchema>;

/** A raw-ish activity from one provider, minimally normalized for matching. */
export const sourceActivitySchema = z.object({
  provider: z.literal("coros"),
  providerActivityId: z.string(),
  /** UTC instant */
  startTime: z.string(),
  startTimeLocal: z.string().optional(),
  timezone: z.string().optional(),
  sport: z.string(),
  durationSeconds: z.number(),
  elapsedSeconds: z.number().optional(),
  distanceMeters: z.number().optional(),
  avgHeartRate: z.number().optional(),
  maxHeartRate: z.number().optional(),
  avgPaceSecPerKm: z.number().optional(),
  elevationGainMeters: z.number().optional(),
  calories: z.number().optional(),
  trainingLoad: z.number().optional(),
  deviceName: z.string().optional(),
  title: z.string().optional(),
  /** COROS: id of the plan workout this activity completed, when reported. */
  sourcePlannedWorkoutId: z.string().optional(),
  sourceCreatedAt: z.string().optional(),
  sourceUpdatedAt: z.string().optional(),
  telemetry: activityTelemetrySchema.optional(),
  contentFingerprint: z.string(),
});
export type SourceActivity = z.infer<typeof sourceActivitySchema>;

/** One physical run, possibly assembled from multiple provider records. */
export const normalizedActivitySchema = z.object({
  id: z.string(),
  corosActivityId: z.string().optional(),
  startTime: z.string(),
  startTimeLocal: z.string().optional(),
  timezone: z.string().optional(),
  sport: z.string(),
  durationSeconds: z.number(),
  elapsedSeconds: z.number().optional(),
  distanceMeters: z.number().optional(),
  avgHeartRate: z.number().optional(),
  maxHeartRate: z.number().optional(),
  avgPaceSecPerKm: z.number().optional(),
  elevationGainMeters: z.number().optional(),
  trainingLoad: z.number().optional(),
  deviceName: z.string().optional(),
  title: z.string().optional(),
  completionMatchId: z.string().optional(),
  telemetry: activityTelemetrySchema.optional(),
  /** 0..1; 1 = single-source or exact merge */
  sourceMergeConfidence: z.number(),
});
export type NormalizedActivity = z.infer<typeof normalizedActivitySchema>;

export interface ActivityLap {
  id: string;
  activityId: string;
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
  /** COROS exercise catalog key (strength/yoga lap naming). */
  exerciseNameKey?: string;
}

