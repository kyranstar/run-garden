/**
 * TWO YEARS OF AN ATHLETE'S RECORD, for what reads all of it: the objectives board's best ever (the go-live CPU gate,
 * design-cpu-bench.test.ts) and the key results' differential against their implementation before the gate's fixes
 * (key-result-measures-differential.test.ts). Synthetic data only.
 */
import { schema } from "@rg/database";
import { addDays, newId, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { at } from "./design-read-fixture.js";

// ── Words a model writes: plain, varied, near the schema's lengths ──────────────────────────────────────────────────

const SENTENCES = [
  "Wakes the hips before any loading so the first working set feels smooth rather than stiff",
  "Keeps the jaw soft and the breath slow; the trunk braces without clenching or holding the breath",
  "Upper back has gone untrained for six days and the desk hours pull the shoulders forward",
  "A small step up from last week's clean sessions: one more rep each set, the same load",
  "The calves were sore after the hills, so the lower legs stay light and the knees stay quiet today",
  "Pairs a pull with the press so the shoulders stay balanced across the week, not just today",
  "Slow lowering builds control under load without needing heavier dumbbells than the garage has",
  "Ends by opening the hips through the range the squats used, so the low back is left relaxed",
  "Holds the ribs down and the pelvis level; stop the set the moment the low back takes over",
  "Fits the thirty-five minutes the athlete usually has before work, with the warm-up kept short",
];
export const words = (seed: number, max: number): string => {
  let out = "";
  for (let i = 0; out.length < max - 20; i++) out += (out ? ". " : "") + SENTENCES[(seed + i * 3) % SENTENCES.length];
  return `${out.slice(0, max - 1).trimEnd()}.`;
};

/** Two years of an athlete's record up to `today`: a session every other day (11 sets; a third from a coach or Studio
 * document, with its locked build), a run every other day, threshold pace every day, three objectives over every
 * measure family. */
export async function seedLongHistory(db: Db, uid: string, today: string): Promise<void> {
  const daysAgo = (n: number) => addDays(today, -n);
  const T0 = at(today);
  const objectiveIds = [`${uid}-obj-hold`, `${uid}-obj-run`];
  const sessions: Array<typeof schema.performedSessions.$inferInsert> = [];
  const sets: Array<typeof schema.performedSets.$inferInsert> = [];
  const planned: Array<typeof schema.plannedWorkouts.$inferInsert> = [];
  const builds: Array<typeof schema.sessionBuilds.$inferInsert> = [];
  const doc = (n: number): WorkoutDoc =>
    workoutDocSchema.parse({
      version: 1,
      title: `Strength ${n}`,
      intent: { summary: words(n, 150), goals: ["strength"], focus: [], effort: "develop", objectiveIds },
      parts: [
        {
          purpose: "main",
          format: "straight",
          items: [
            { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 3, reps: 8, load: { typed: "35 lb", kg: 15.9 }, restSec: 90 } },
            { kind: "exercise", libraryId: "wallSit", dose: { sets: 3, holdSec: 45 } },
            { kind: "exercise", libraryId: "deadBug", dose: { sets: 2, reps: 10, perSide: true } },
            { kind: "exercise", libraryId: "bandRow", dose: { sets: 3, reps: 12 } },
          ],
        },
      ],
      source: { kind: n % 2 ? "coach" : "studio" },
    });
  for (let n = 1; n <= 730; n += 2) {
    const date = daysAgo(n);
    const id = `long-s${n}`;
    const fromDoc = n % 3 === 1;
    const workoutId = fromDoc ? `long-w${n}` : null;
    const buildId = fromDoc ? `long-b${n}` : null;
    if (fromDoc) {
      const d = doc(n);
      planned.push({
        id: workoutId!, userId: uid, planId: `studio-${uid}`, sourceWorkoutId: workoutId!, title: d.title, category: "strength", sport: "strength",
        originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "07:00", sourceContentFingerprint: "fp",
        calendarBlockDurationSeconds: 2700, completionState: "completed", origin: "studio", workoutDoc: JSON.stringify(d), workoutDocRev: 1, createdAt: T0, updatedAt: T0,
      });
      builds.push({
        id: buildId!, userId: uid, workoutId: workoutId!, version: 1, engineVersion: "bench", inputsHash: "h", workoutDoc: JSON.stringify(d), lockedAt: at(date, "06:55"), createdAt: at(date, "06:50"),
        payload: {
          build: {
            steps: [
              ...[0, 1, 2].map((i) => ({ kind: "set", exerciseId: "gobletSquat", slotKey: "main-0", log: 1, set: i, target: { reps: 8, w: { v: 35, u: "lb" } } })),
              ...[0, 1, 2].map((i) => ({ kind: "timed", exerciseId: "wallSit", slotKey: "main-1", log: 1, set: i, seconds: 45 })),
              ...[0, 1].map((i) => ({ kind: "set", exerciseId: "deadBug", slotKey: "main-2", log: 1, set: i, target: { reps: 10 } })),
              ...[0, 1, 2].map((i) => ({ kind: "set", exerciseId: "bandRow", slotKey: "main-3", log: 1, set: i, target: { reps: 12 } })),
            ],
          },
        },
      });
    }
    sessions.push({
      id, userId: uid, source: "app", localDate: date, startedAt: at(date, "07:00"), seconds: 2400, minutes: 40, mode: "build", theme: "fullBody", completed: true,
      workoutId, buildId,
      movesDone: ["gobletSquat", "wallSit", "deadBug", "bandRow"].map((exerciseId, i) => ({ exerciseId, seconds: 240, slotKey: `main-${i}` })),
      payloadHash: `h-${n}`, createdAt: at(date, "07:45"), updatedAt: at(date, "07:45"),
    });
    const set = (entryIndex: number, exerciseId: string, setIndex: number, o: Partial<typeof schema.performedSets.$inferInsert>) =>
      sets.push({ id: `${id}-${entryIndex}-${setIndex}`, performedSessionId: id, entryIndex, exerciseId, setIndex, done: true, ...o });
    const kg = 13.6 + Math.floor((730 - n) / 60) * 1.1;
    for (let i = 0; i < 3; i++) set(0, "gobletSquat", i, { reps: 8 - (i === 2 ? 1 : 0), loadValue: Math.round(kg * 2.2), loadUnit: "lb", loadKg: kg });
    for (let i = 0; i < 3; i++) set(1, "wallSit", i, { seconds: 35 + ((730 - n) % 40) + i });
    for (let i = 0; i < 2; i++) set(2, "deadBug", i, { reps: 10, perSide: true });
    for (let i = 0; i < 3; i++) set(3, "bandRow", i, { reps: 12 });
  }
  const runs: Array<typeof schema.activities.$inferInsert> = [];
  for (let n = 0; n < 730; n += 2) {
    const date = daysAgo(n);
    const meters = [5000, 6400, 8000, 10_000, 5000, 12_000, 21_100][n % 7]!;
    const seconds = Math.round((meters / 1000) * (300 + (n % 9) * 6));
    runs.push({
      id: `long-r${n}`, userId: uid, source: "coros", startTime: at(date, "18:00"), startTimeLocal: `${date}T18:00:00`, sport: "run", durationSeconds: seconds,
      distanceMeters: meters, avgHeartRate: 138 + (n % 18), avgPaceSecPerKm: seconds / (meters / 1000), trainingLoad: 50 + (n % 40),
      telemetry: { feelRating: 3 + (n % 3), aerobicEffect: 2.8 }, title: "Evening run", createdAt: at(date, "19:00"), updatedAt: at(date, "19:00"),
    });
  }
  const health = Array.from({ length: 730 }, (_, n) => ({
    id: `${uid}:${daysAgo(n)}`, userId: uid, date: daysAgo(n), restingHeartRate: 50 + (n % 4), hrv: 55 + (n % 7), thresholdPaceSecPerKm: 290 + (n % 11), contentFingerprint: "fp", updatedAt: T0,
  }));
  const chunked = async <T>(rows: T[], insert: (part: T[]) => Promise<unknown>) => {
    for (let i = 0; i < rows.length; i += 100) await insert(rows.slice(i, i + 100));
  };
  await chunked(planned, (p) => db.insert(schema.plannedWorkouts).values(p));
  await chunked(builds, (p) => db.insert(schema.sessionBuilds).values(p));
  await chunked(sessions, (p) => db.insert(schema.performedSessions).values(p));
  await chunked(sets, (p) => db.insert(schema.performedSets).values(p));
  await chunked(runs, (p) => db.insert(schema.activities).values(p));
  await chunked(health, (p) => db.insert(schema.dailyHealth).values(p));
  await db.insert(schema.objectives).values([
    { id: objectiveIds[0]!, userId: uid, title: "Hold a strong wall sit", why: "Ski legs", status: "active", goalIds: ["strength"], sort: 0, createdAt: T0, updatedAt: T0 },
    { id: objectiveIds[1]!, userId: uid, title: "A faster half", status: "active", goalIds: ["speed"], sort: 1, createdAt: T0, updatedAt: T0 },
    { id: `${uid}-obj-back`, userId: uid, title: "A stronger back", status: "active", goalIds: ["posture"], sort: 2, createdAt: T0, updatedAt: T0 },
  ]);
  const kr = (objectiveId: string, label: string, measure: Record<string, unknown>, unit: string, position: number, o: { target?: number; direction?: string } = {}) => ({
    id: newId(), userId: uid, objectiveId, label, measure, direction: o.direction ?? "up", baseline: null, target: o.target ?? null, unit, position, createdAt: T0, updatedAt: T0,
  });
  await db.insert(schema.keyResults).values([
    kr(objectiveIds[0]!, "Wall sit hold", { kind: "hold_max", libraryIds: ["wallSit"], windowDays: 90 }, "s", 0, { target: 90 }),
    kr(objectiveIds[0]!, "Goblet squat estimated max", { kind: "best_set", libraryIds: ["gobletSquat"], metric: "e1rm", windowDays: 90 }, "lb", 1, { target: 60 }),
    kr(objectiveIds[1]!, "5K time", { kind: "run_best", distanceM: 5000, windowDays: 180 }, "s", 0, { direction: "down", target: 1500 }),
    kr(objectiveIds[1]!, "10K time", { kind: "run_best", distanceM: 10_000, windowDays: 180 }, "s", 1, { direction: "down", target: 3100 }),
    kr(objectiveIds[1]!, "Pace at easy heart rate", { kind: "pace_at_hr", hrLow: 140, hrHigh: 155, minDurationSec: 1200, windowDays: 90 }, "s/km", 2, { direction: "down" }),
    kr(objectiveIds[1]!, "Threshold pace", { kind: "threshold_pace", windowDays: 90 }, "s/km", 3, { direction: "down" }),
    kr(objectiveIds[1]!, "Predicted half", { kind: "predicted_time", distanceM: 21_097, windowDays: 90 }, "min", 4, { direction: "down" }),
    kr(`${uid}-obj-back`, "Band row reps", { kind: "best_set", libraryIds: ["bandRow", "deadBug"], metric: "reps", windowDays: 60 }, "reps", 0, { target: 15 }),
  ]);
}
