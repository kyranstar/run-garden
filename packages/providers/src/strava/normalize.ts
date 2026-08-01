import type { SourceActivity } from "@rg/domain";
import { fingerprint } from "@rg/domain";

/** Subset of the Strava DetailedActivity / SummaryActivity we consume. */
export interface RawStravaActivity {
  id: number;
  name?: string;
  description?: string;
  sport_type?: string;
  type?: string;
  start_date: string; // UTC ISO
  start_date_local?: string;
  timezone?: string; // "(GMT-08:00) America/Los_Angeles"
  elapsed_time?: number;
  moving_time?: number;
  distance?: number; // meters
  average_heartrate?: number;
  max_heartrate?: number;
  total_elevation_gain?: number;
  calories?: number;
  device_name?: string;
  external_id?: string;
  upload_id?: number;
  map?: { summary_polyline?: string };
  [key: string]: unknown;
}

const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);

function stravaSport(a: RawStravaActivity): string {
  const t = a.sport_type ?? a.type ?? "";
  if (RUN_TYPES.has(t)) return "run";
  if (t.includes("Ride") || t === "VirtualRide") return "bike";
  if (t.includes("Swim")) return "swim";
  if (t === "Walk" || t === "Hike") return "walk";
  if (t === "WeightTraining" || t === "Workout") return "strength";
  return t.toLowerCase() || "unknown";
}

export function parseStravaTimezone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  const parts = tz.split(" ");
  return parts[parts.length - 1];
}

export function normalizeStravaActivity(a: RawStravaActivity): SourceActivity {
  return {
    provider: "strava",
    providerActivityId: String(a.id),
    startTime: a.start_date.replace(".000Z", "Z"),
    startTimeLocal: a.start_date_local?.replace(".000Z", "").replace("Z", ""),
    timezone: parseStravaTimezone(a.timezone),
    sport: stravaSport(a),
    durationSeconds: a.moving_time ?? a.elapsed_time ?? 0,
    elapsedSeconds: a.elapsed_time,
    distanceMeters: a.distance,
    avgHeartRate: a.average_heartrate,
    maxHeartRate: a.max_heartrate,
    elevationGainMeters: a.total_elevation_gain,
    calories: a.calories,
    deviceName: a.device_name,
    title: a.name,
    description: a.description,
    summaryPolyline: a.map?.summary_polyline,
    externalId: a.external_id,
    contentFingerprint: fingerprint({
      id: a.id,
      start: a.start_date,
      moving: a.moving_time,
      distance: a.distance,
      name: a.name,
    }),
  };
}
