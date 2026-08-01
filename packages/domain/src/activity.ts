import { z } from "zod";

export type ActivityProviderName = "coros" | "strava";

/** A raw-ish activity from one provider, minimally normalized for matching. */
export const sourceActivitySchema = z.object({
  provider: z.enum(["coros", "strava"]),
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
  description: z.string().optional(),
  summaryPolyline: z.string().optional(),
  /** COROS: id of the plan workout this activity completed, when reported. */
  sourcePlannedWorkoutId: z.string().optional(),
  externalId: z.string().optional(),
  sourceCreatedAt: z.string().optional(),
  sourceUpdatedAt: z.string().optional(),
  contentFingerprint: z.string(),
});
export type SourceActivity = z.infer<typeof sourceActivitySchema>;

/** One physical run, possibly assembled from multiple provider records. */
export const normalizedActivitySchema = z.object({
  id: z.string(),
  corosActivityId: z.string().optional(),
  stravaActivityId: z.string().optional(),
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
  summaryPolyline: z.string().optional(),
  completionMatchId: z.string().optional(),
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
}

export type MergeConfidenceBand = "high" | "medium" | "low";

export function mergeConfidenceBand(score: number): MergeConfidenceBand {
  if (score >= 0.85) return "high";
  if (score >= 0.6) return "medium";
  return "low";
}
