import type { RawCorosActivityDetail, RawCorosActivityListItem } from "../coros/raw-types.js";

/**
 * COROS reports times in centiseconds at the item level too (like the detail
 * summary), so a plain minute count needs ×100×60 to become totalTime/workoutTime.
 */
function centiseconds(seconds: number): number {
  return seconds * 100;
}

/**
 * A completed threshold session as it appears from BOTH providers — the same
 * physical run recorded by a COROS watch.
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
      // Detail timestamps are centiseconds [verified in prod: seconds here
      // produced activities dated year 7625], like the other summary fields.
      startTimestamp: startUnix * 100,
      endTimestamp: (startUnix + 3312) * 100,
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


/**
 * A completed strength/lifting session (sportType 402, activity namespace):
 * ~45 minutes, HR present, no distance or pace — the tri-discipline garden
 * counts this on the strength clock instead of the run clock.
 * startIso must be a UTC instant (see fixtureCorosCompletedThreshold).
 */
export function fixtureCorosCompletedStrength(
  startIso: string,
  labelId = "coros-act-4712",
): RawCorosActivityListItem {
  const startUnix = Math.floor(Date.parse(startIso) / 1000);
  const durationSeconds = 2700; // 45 min
  return {
    labelId,
    date: Number(startIso.slice(0, 10).replaceAll("-", "")),
    name: "Full Body Strength",
    sportType: 402,
    startTime: startUnix,
    endTime: startUnix + durationSeconds,
    startTimezone: -28, // UTC-7 (PDT) in 15-minute units
    totalTime: centiseconds(durationSeconds),
    workoutTime: centiseconds(durationSeconds),
    avgHr: 118,
    maxHr: 142,
    device: "COROS PACE 3",
    calorie: 380_000, // physical cal -> 380 kcal
  };
}

/**
 * A completed yoga/flexibility session (sportType 904, activity namespace):
 * ~30 minutes, HR present, no distance or pace.
 * startIso must be a UTC instant (see fixtureCorosCompletedThreshold).
 */
export function fixtureCorosCompletedYoga(
  startIso: string,
  labelId = "coros-act-4713",
): RawCorosActivityListItem {
  const startUnix = Math.floor(Date.parse(startIso) / 1000);
  const durationSeconds = 1800; // 30 min
  return {
    labelId,
    date: Number(startIso.slice(0, 10).replaceAll("-", "")),
    name: "Morning Flow",
    sportType: 904,
    startTime: startUnix,
    endTime: startUnix + durationSeconds,
    startTimezone: -28,
    totalTime: centiseconds(durationSeconds),
    workoutTime: centiseconds(durationSeconds),
    avgHr: 96,
    maxHr: 112,
    device: "COROS PACE 3",
    calorie: 210_000, // physical cal -> 210 kcal
  };
}

