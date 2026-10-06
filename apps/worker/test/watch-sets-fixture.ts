/**
 * Synthetic strength-activity lap items in the real skeleton (the masked probe's own fixture shape): every key the
 * wire carries, values invented. Shared by the watch-sets derivation, store and ingest suites.
 */
import type { RawCorosActivityDetail, RawCorosLapItem } from "@rg/providers";
import type { WatchActivityFacts } from "../src/services/watch-sets.js";
import type { Env } from "../src/env.js";

export const NOW = "2026-10-02T09:00:00.000Z";
export const USER = "user-7f3a";

export const ACTIVITY: WatchActivityFacts = {
  activityId: "act-5512",
  providerActivityId: "lbl-strength-9001",
  startTime: "2026-10-01T13:00:00.000Z",
  startTimeLocal: "2026-10-01T06:00:00",
  durationSeconds: 2400.4,
  elapsedSeconds: 2700,
};

/** One lap item with every key of the real skeleton; the fields a test cares about are passed in. */
export function item(fields: Partial<RawCorosLapItem>): RawCorosLapItem {
  return {
    lapIndex: 0,
    time: 0,
    avgHr: 104,
    exerciseIndex: 0,
    exerciseNameKey: "T1041",
    exerciseType: 2,
    setIndex: 0,
    sets: 1,
    targetSets: 3,
    targetType: 3,
    targetValue: 8,
    intensityType: 1,
    intensityValue: 0,
    intensityValueExtend: 0,
    intensityMultiplier: 0,
    intensityCustom: 0,
    intensityDisplayUnit: 6,
    lapTrainIndex: 0,
    programExerciseIndex: 0,
    indexInOriginLap: 0,
    pauseTime: 0,
    reps: 0,
    weight: 0,
    exerciseId: "8100",
    lapType: 0,
    ...fields,
  };
}

/**
 * The session the layout tests read, as lap type 0:
 *   slot 0 Bench Press (T1041): two sets, each a data item then its rest
 *   slot 1 Dumbbell Row (T1055): a both-data pair — two real sets (one per side)
 *   slot 2 Planks (T1010): a hold — set 0 is two no-data items (one timed set,
 *          from the first); set 1's first item has no time (nothing to log)
 *   slot 3 Push-ups (T1004): bodyweight — reps, weight 0, then its rest
 */
export function workView(lapType = 0): RawCorosLapItem[] {
  return [
    item({ lapType, exerciseIndex: 0, setIndex: 0, exerciseNameKey: "T1041", reps: 8, weight: 22_680, time: 4_500 }),
    item({ lapType, exerciseIndex: 0, setIndex: 0, exerciseNameKey: "T1041", time: 9_000, targetType: 3 }),
    item({ lapType, exerciseIndex: 0, setIndex: 1, exerciseNameKey: "T1041", reps: 8, weight: 22_680, time: 4_200 }),
    item({ lapType, exerciseIndex: 0, setIndex: 1, exerciseNameKey: "T1041", time: 9_000 }),
    item({ lapType, exerciseIndex: 1, setIndex: 0, exerciseNameKey: "T1055", reps: 10, weight: 12_000, time: 3_000 }),
    item({ lapType, exerciseIndex: 1, setIndex: 0, exerciseNameKey: "T1055", reps: 9, weight: 12_000, time: 3_100 }),
    item({ lapType, exerciseIndex: 2, setIndex: 0, exerciseNameKey: "T1010", time: 4_500, targetType: 2 }),
    item({ lapType, exerciseIndex: 2, setIndex: 0, exerciseNameKey: "T1010", time: 6_000, targetType: 2 }),
    item({ lapType, exerciseIndex: 2, setIndex: 1, exerciseNameKey: "T1010", time: 0, targetType: 2 }),
    item({ lapType, exerciseIndex: 2, setIndex: 1, exerciseNameKey: "T1010", time: 6_000, targetType: 2 }),
    item({ lapType, exerciseIndex: 3, setIndex: 0, exerciseNameKey: "T1004", reps: 15, weight: 0, time: 3_000 }),
    item({ lapType, exerciseIndex: 3, setIndex: 0, exerciseNameKey: "T1004", time: 6_000 }),
  ].map((i, n) => ({ ...i, lapIndex: lapType * 100 + n + 1 })); // a lap's index is unique within its list
}

/** The duplicate lap type: same layout, different numbers — anything read from it shows up as 99 reps. */
export function duplicateView(lapType = 1): RawCorosLapItem[] {
  return workView(lapType).map((i) => ({ ...i, reps: Number(i.reps ?? 0) > 0 ? 99 : 0 }));
}

export const detailOf = (...lists: RawCorosLapItem[][]): RawCorosActivityDetail => ({
  summary: { name: "Synthetic Upper", sportType: 402 },
  lapList: lists.map((lapItemList, i) => ({ type: 7300 + i, lapItemList })),
});

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/** A Worker env for the mock COROS server (no fixture mode). */
export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    ...overrides,
  } as Env;
}
