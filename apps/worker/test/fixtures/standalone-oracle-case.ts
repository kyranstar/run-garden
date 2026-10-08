/**
 * ONE ORACLE CASE WHOSE EXPECTED VALUES ARE THE STANDALONE TOOL'S OWN OUTPUTS (Audit 2c-A MINOR-1) — copied, never
 * recomputed by Run Garden's port. SYNTHETIC: every id, date and number is made up.
 *
 * Where each expected value comes from:
 *  - `weekly` (sessions, minutes and whole-kilo volume per week), `pairs` and `latest` are what the tool's own
 *    js/stats.js printed when it was run, unmodified, over exactly these sessions with today = 2026-09-30
 *    (`Stats.weekly(sessions, 8, today)`, `Stats.symptoms(sessions)` with both numbers, and the last point of
 *    `Stats.lifts(sessions)` per core lift). Every weight it summed is in kilograms, which the tool's units module
 *    passes through unchanged (its tests/units.test.js: `toKg({v: 12, u: "kg"}) === 12`), so nothing but the tool's
 *    code shaped those numbers. The settings unit is kg, so the Progress tab shows the same whole kilos.
 *  - `progressRecords`: the four goblet-squat sessions from Aug 31 are the tool's tests/engine-records.test.js case
 *    "a weight record resets the bar for reps at the new weight", whose asserted non-first records are exactly
 *    [weight, reps]. Nothing else in the file earns a record past a first time (each other move is logged once, or
 *    lighter than before), and nothing earns a milestone by the tool's asserted milestone rules: 9 sessions (the first
 *    is at 10), calm-jaw runs of at most 4 (the first is at 5), one week at the goal of 4 (the first streak is 2), no
 *    kettlebell, no block number, and no week with every core family. The Progress tab lists non-first records and
 *    milestones: 2.
 *
 * The file mixes what the tool's Stats must leave out — an entry logged as reps with a weight, a carry logged as load
 * × time, entries with no log and metric at all — with what it counts that a port might not: a set not marked done,
 * per-side work under both spellings, and weeks whose kilos are not whole (276.8 and 472.9).
 */

type W = { v: number; u: "lb" | "kg" };
const lb = (v: number): W => ({ v, u: "lb" });
const kg = (v: number): W => ({ v, u: "kg" });

// The tool's tests/fixtures.js `session(date)` and engine-records.test.js `lift(...)`, as they are.
const toolSession = (date: string, extra: Record<string, unknown> = {}) => ({
  id: `s-${date}-`, date, startedAt: `${date}T18:00:00`, seconds: 1800, pre: 1, post: 1, done: [], entries: [], ...extra,
});
const lift = (id: string, w: W | null, reps: number) => ({ id, clenched: false, sets: [{ w, reps, secs: null }] });

export const ORACLE_CASE_TODAY = "2026-09-30";

export const oracleCaseSessions: unknown[] = [
  toolSession("2026-08-03", { pre: 2, post: 4, entries: [{ id: "chinTuck", log: "time", metric: "time", clenched: false, sets: [{ w: null, reps: null, secs: 30 }] }] }),
  {
    version: 2, id: "v2-2026-08-12", date: "2026-08-12", startedAt: "2026-08-12T18:00:00", seconds: 1500, pre: 2, post: 4, done: [],
    entries: [{ id: "catCow", log: "time", metric: "time", perSide: false, clenched: false, sets: [{ w: null, reps: null, secs: 45 }] }],
  },
  // engine-records.test.js "a weight record resets the bar for reps at the new weight" (MON = 2026-08-31).
  toolSession("2026-08-31", { entries: [lift("gobletSquat", lb(25), 8)] }),
  toolSession("2026-09-01", { entries: [lift("gobletSquat", lb(30), 5)] }),
  toolSession("2026-09-02", { entries: [lift("gobletSquat", lb(25), 10)] }),
  toolSession("2026-09-03", { entries: [lift("gobletSquat", lb(30), 6)] }),
  toolSession("2026-09-22", {
    seconds: 2100, pre: 1, post: 3,
    entries: [{ id: "deadlift", log: "load", metric: "reps", bilateral: true, clenched: false, sets: [{ w: kg(16.4), reps: 6, secs: null }] }],
  }),
  {
    version: 2, id: "v2-2026-09-24", date: "2026-09-24", startedAt: "2026-09-24T18:00:00", seconds: 1200, pre: null, post: null, done: [],
    entries: [{ id: "deadlift", log: "load", metric: "reps", perSide: false, clenched: false, sets: [{ w: kg(16), reps: 5, secs: null }] }],
  },
  {
    version: 2, id: "v2-2026-09-28", date: "2026-09-28", startedAt: "2026-09-28T18:00:00", seconds: 2400, pre: 1, post: 3, done: [],
    entries: [
      { id: "gobletSquat", log: "load", metric: "reps", perSide: false, clenched: false, sets: [{ w: kg(12.5), reps: 7, secs: null }] },
      {
        id: "supportedRow", log: "load", metric: "reps", perSide: true, clenched: false,
        sets: [{ w: kg(10.3), reps: 9, secs: null }, { w: kg(20), reps: 5, secs: null, done: false }],
      },
      { id: "suitcaseCarry", log: "load", metric: "time", perSide: true, clenched: false, sets: [{ w: kg(16), reps: 3, secs: null }] },
      { id: "tempoSquat", log: "reps", metric: "reps", perSide: false, clenched: false, sets: [{ w: kg(5), reps: 10, secs: null }] },
    ],
  },
];

/** The backup around them: the tool set to kilograms, a goal of 4, a block since Sep 21. */
export function oracleCaseBackup() {
  return {
    app: "tmj_tool",
    version: 2,
    settings: { unit: "kg", weeklyGoal: 4, blockWeeks: 4, defaultMinutes: 30 },
    locations: [],
    prefs: {},
    wishlist: [],
    block: {
      number: 1, startedAt: "2026-09-21", weeks: 4,
      core: { squat: "gobletSquat", hinge: "deadlift", row: "supportedRow", press: "floorPress", carry: "suitcaseCarry" },
      rotations: [],
    },
    sessions: oracleCaseSessions,
  };
}

/** The tool's outputs (see above), as printed. */
export const toolOutputs = {
  weekly: [
    { week: "2026-08-10", sessions: 1, minutes: 25, volumeKg: 0 },
    { week: "2026-08-17", sessions: 0, minutes: 0, volumeKg: 0 },
    { week: "2026-08-24", sessions: 0, minutes: 0, volumeKg: 0 },
    { week: "2026-08-31", sessions: 4, minutes: 120, volumeKg: 0 },
    { week: "2026-09-07", sessions: 0, minutes: 0, volumeKg: 0 },
    { week: "2026-09-14", sessions: 0, minutes: 0, volumeKg: 0 },
    { week: "2026-09-21", sessions: 2, minutes: 55, volumeKg: 277 },
    { week: "2026-09-28", sessions: 1, minutes: 40, volumeKg: 473 },
  ],
  pairs: 8,
  latest: {
    gobletSquat: { date: "2026-09-28", top: kg(12.5), reps: 7, secs: null },
    deadlift: { date: "2026-09-24", top: kg(16), reps: 5, secs: null },
    supportedRow: { date: "2026-09-28", top: kg(20), reps: 5, secs: null },
    suitcaseCarry: { date: "2026-09-28", top: kg(16), reps: 3, secs: null },
  } as Record<string, { date: string; top: W | null; reps: number | null; secs: number | null }>,
  progressRecords: 2,
};
