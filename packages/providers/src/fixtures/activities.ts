import type { RawCorosActivityDetail, RawCorosActivityListItem } from "../coros/raw-types.js";
import type { RawStravaActivity } from "../strava/normalize.js";

/**
 * A completed threshold session as it appears from BOTH providers — the same
 * physical run recorded by a COROS watch and auto-synced to Strava.
 * startIso must be a UTC instant like "2026-08-04T14:02:05Z" (07:02 PDT).
 */
export function fixtureCorosCompletedThreshold(
  startIso: string,
  labelId = "coros-act-4711",
): { item: RawCorosActivityListItem; detail: RawCorosActivityDetail } {
  const startUnix = Math.floor(Date.parse(startIso) / 1000);
  const item: RawCorosActivityListItem = {
    labelId,
    date: Number(startIso.slice(0, 10).replaceAll("-", "")),
    name: "Threshold 5x5",
    sportType: 100,
    startTime: startUnix,
    endTime: startUnix + 3312,
    startTimezone: -28, // UTC-7 (PDT) in 15-minute units
    distance: 9860,
    totalTime: 331200,
    workoutTime: 325500,
    trainingLoad: 82,
    avgHr: 158,
    maxHr: 176,
    device: "COROS PACE 3",
    calorie: 612_000,
    totalAscent: 64,
  };
  const detail: RawCorosActivityDetail = {
    summary: {
      distance: 986000, // centimetres
      totalTime: 331200, // centiseconds
      workoutTime: 325500, // centiseconds
      avgHr: 158,
      maxHr: 176,
      avgPace: 330,
      adjustedPace: 326,
      trainingLoad: 82,
      elevGain: 64,
      startTimestamp: startUnix,
      endTimestamp: startUnix + 3312,
      timezone: -28,
      sportType: 100,
      name: "Threshold 5x5",
      planId: "800000000000001234",
      programId: "9000000000000011",
      hasProgram: 1,
    },
    lapList: [
      {
        type: 1,
        lapDistance: 0,
        lapItemList: [
          { lapIndex: 1, distance: 250000, time: 90000, avgPace: 360, avgHr: 128, lapType: 1 },
          { lapIndex: 2, distance: 152000, time: 30000, avgPace: 197, avgHr: 162, lapType: 2 },
          { lapIndex: 3, distance: 30000, time: 12000, avgPace: 400, avgHr: 148, lapType: 4 },
          { lapIndex: 4, distance: 151000, time: 30000, avgPace: 199, avgHr: 165, lapType: 2 },
          { lapIndex: 5, distance: 30000, time: 12000, avgPace: 400, avgHr: 150, lapType: 4 },
          { lapIndex: 6, distance: 150000, time: 30000, avgPace: 200, avgHr: 167, lapType: 2 },
          { lapIndex: 7, distance: 30000, time: 12000, avgPace: 400, avgHr: 151, lapType: 4 },
          { lapIndex: 8, distance: 152000, time: 30000, avgPace: 197, avgHr: 168, lapType: 2 },
          { lapIndex: 9, distance: 30000, time: 12000, avgPace: 400, avgHr: 152, lapType: 4 },
          { lapIndex: 10, distance: 151000, time: 30000, avgPace: 199, avgHr: 170, lapType: 2 },
          { lapIndex: 11, distance: 160000, time: 61200, avgPace: 383, avgHr: 141, lapType: 3 },
        ],
      },
    ],
  };
  return { item, detail };
}

/** The Strava copy of the same run (auto-synced by COROS). */
export function fixtureStravaCompletedThreshold(
  startIso: string,
  id = 14_200_000_001,
): RawStravaActivity {
  return {
    id,
    name: "Morning Threshold",
    sport_type: "Run",
    start_date: startIso,
    start_date_local: new Date(Date.parse(startIso) - 7 * 3600 * 1000)
      .toISOString()
      .replace(".000Z", ""),
    timezone: "(GMT-08:00) America/Los_Angeles",
    elapsed_time: 3315,
    moving_time: 3250,
    distance: 9855.4,
    average_heartrate: 157.8,
    max_heartrate: 176,
    total_elevation_gain: 63.5,
    device_name: "COROS PACE 3",
    external_id: "coros_4711.fit",
    upload_id: 987654321,
    map: { summary_polyline: "abc123polyline" },
  };
}

/** A genuinely different run on the same day (must never merge). */
export function fixtureStravaEveningShakeout(dateIso: string, id = 14_200_000_002): RawStravaActivity {
  return {
    id,
    name: "Evening Shakeout",
    sport_type: "Run",
    start_date: `${dateIso}T02:15:00Z`, // ~19:15 local the prior evening in PDT
    start_date_local: `${dateIso}T19:15:00`,
    timezone: "(GMT-08:00) America/Los_Angeles",
    elapsed_time: 1500,
    moving_time: 1460,
    distance: 4200,
    average_heartrate: 128,
    device_name: "COROS PACE 3",
    external_id: "coros_4720.fit",
    map: { summary_polyline: "xyz789" },
  };
}
