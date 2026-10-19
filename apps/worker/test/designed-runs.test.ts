/**
 * DESIGNED RUNS (§8 §3): what the worker reads of the athlete's running — the opening context's line (its size
 * pinned) and the validator's `RunCtx` — read in SQL inside statements their callers already run. A made-up athlete.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, type WorkoutDoc } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { RUNNING_LINE_MAX, runCtxOf, runCtxSql, runningFactsOf, runningLine, runWeeksSql, thresholdSql, weekOf, type RunningFacts } from "../src/services/designed-runs.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const WEEKS: RunningFacts["weeks"] = [
  { seconds: 10800, meters: 30200 },
  { seconds: 0, meters: 0 },
  { seconds: 10200, meters: 28500 },
  { seconds: 9800, meters: 31000 },
];

describe("runningLine — the opening context's running", () => {
  it("the threshold and when it was read, every banded effort's pace from it, and four weeks of running", () => {
    expect(runningLine({ threshold: { secPerKm: 289, date: "2026-03-08" }, weeks: WEEKS }, "km")).toBe(
      "Running: threshold 4:49 /km (8 Mar). Effort paces /km — recovery 6:19–7:19, easy 5:49–6:49, long 5:34–6:34, steady 5:14–5:34, " +
        "tempo 4:59–5:14, threshold 4:49–5:13, interval 4:29–4:44. Last 4 weeks, newest first: 30.2, 0.0, 28.5, 31.0 km; 2 h 8 min a week on average.",
    );
  });

  it("in the athlete's units", () => {
    expect(runningLine({ threshold: { secPerKm: 289, date: "2026-03-08" }, weeks: WEEKS }, "mi")).toBe(
      "Running: threshold 7:45 /mi (8 Mar). Effort paces /mi — recovery 10:10–11:47, easy 9:22–10:58, long 8:58–10:34, steady 8:25–8:58, " +
        "tempo 8:01–8:25, threshold 7:45–8:24, interval 7:13–7:37. Last 4 weeks, newest first: 18.8, 0.0, 17.7, 19.3 mi; 2 h 8 min a week on average.",
    );
  });

  it("a week whose runs have no distance is said in minutes, never as 0 km", () => {
    const weeks = [{ seconds: 1800, meters: 0 }, ...WEEKS.slice(1)];
    expect(runningLine({ threshold: null, weeks }, "km")).toMatch(/Last 4 weeks, newest first: 30, 0, 170, 163 min; 1 h 31 min a week on average\.$/);
  });

  it("says what it lacks: no threshold, no running", () => {
    expect(runningLine({ threshold: null, weeks: WEEKS.map(() => ({ seconds: 0, meters: 0 })) }, "km")).toBe(
      "Running: no threshold pace known yet, so a run's steps carry no pace targets. No running logged in the last four weeks.",
    );
  });

  it(`is never past ${RUNNING_LINE_MAX} characters — the slowest threshold, in miles, a heavy month — so every run carries it`, () => {
    const heavy = Array.from({ length: 4 }, () => ({ seconds: 99 * 3600, meters: 999_000 }));
    for (const units of ["km", "mi"] as const) {
      for (const secPerKm of [120, 289, 720]) {
        expect(runningLine({ threshold: { secPerKm, date: "2026-12-28" }, weeks: heavy }, units).length).toBeLessThanOrEqual(RUNNING_LINE_MAX);
      }
      expect(runningLine({ threshold: null, weeks: heavy }, units).length).toBeLessThanOrEqual(RUNNING_LINE_MAX);
    }
  });
});

describe("weekOf", () => {
  it("is Monday to Sunday", () => {
    expect(weekOf("2026-03-10")).toEqual({ start: "2026-03-09", end: "2026-03-15" });
    expect(weekOf("2026-03-09")).toEqual({ start: "2026-03-09", end: "2026-03-15" });
    expect(weekOf("2026-03-15")).toEqual({ start: "2026-03-09", end: "2026-03-15" });
  });
});

// ── In SQL ──────────────────────────────────────────────────────────────────────────────────────────────────────────

let db: Db;
let userId: string;
const DAY = "2026-03-11"; // a Wednesday

async function plan(o: { date: string; category: string; sport?: string; minutes?: number; title?: string; doc?: WorkoutDoc; state?: string; archived?: boolean; user?: string }) {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id, userId: o.user ?? userId, planId: "p", sourceWorkoutId: id, title: o.title ?? "Session", category: o.category, sport: o.sport ?? "run",
    originalPlanDate: o.date, lastVerifiedCorosDate: o.date, effectiveDate: o.date, effectiveTime: "07:00", sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: (o.minutes ?? 45) * 60, completionState: o.state ?? "scheduled",
    archivedAt: o.archived ? "2026-03-01T00:00:00.000Z" : null,
    ...(o.doc ? { workoutDoc: JSON.stringify(o.doc), workoutDocRev: 1 } : {}),
    createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z",
  });
}
async function ran(date: string, minutes: number, meters: number, user = userId) {
  await db.insert(schema.activities).values({
    id: newId(), userId: user, source: "coros", startTime: `${date}T15:00:00.000Z`, startTimeLocal: `${date}T08:00:00`, sport: "run",
    durationSeconds: minutes * 60, distanceMeters: meters, createdAt: `${date}T16:00:00.000Z`, updatedAt: `${date}T16:00:00.000Z`,
  });
}
const legs = (effort: WorkoutDoc["intent"]["effort"]): WorkoutDoc => ({
  version: 1, title: "Legs", intent: { summary: "Legs.", goals: [], focus: [], effort },
  parts: [{ purpose: "main", format: "straight", items: [
    { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 4, reps: 8 } },
    { kind: "exercise", libraryId: "bridge", dose: { sets: 3, reps: 10 } },
  ] }],
  source: { kind: "studio" },
});

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId } = await makeTestUser(db));
});

describe("runCtxSql → runCtxOf — the validator's running, in one column", () => {
  it("the threshold, the hard sessions either side, the week's planned running and the four weeks before it", async () => {
    await db.insert(schema.dailyHealth).values([
      { id: `${userId}:a`, userId, date: "2026-03-01", thresholdPaceSecPerKm: 300, contentFingerprint: "f", updatedAt: "2026-03-01T00:00:00.000Z" },
      { id: `${userId}:b`, userId, date: "2026-03-08", thresholdPaceSecPerKm: 289, contentFingerprint: "f", updatedAt: "2026-03-08T00:00:00.000Z" },
      { id: `${userId}:c`, userId, date: "2026-03-10", hrv: 60, contentFingerprint: "f", updatedAt: "2026-03-10T00:00:00.000Z" },
    ]);
    // The week (Mon 9 – Sun 15 Mar): 40 + 60 + 50 planned, a skipped one and an archived one not counted, strength not running.
    await plan({ date: "2026-03-09", category: "easy", minutes: 40 });
    await plan({ date: "2026-03-12", category: "quality", minutes: 60, title: "Intervals" });
    await plan({ date: "2026-03-13", category: "easy", minutes: 30, state: "skipped" });
    await plan({ date: "2026-03-14", category: "long", minutes: 90, archived: true });
    await plan({ date: "2026-03-10", category: "strength", sport: "strength", title: "Heavy legs", doc: legs("develop") });
    await plan({ date: "2026-03-11", category: "strength", sport: "strength", title: "Easy legs", doc: legs("maintain") });
    // Two days off: not near (but in the week).
    await plan({ date: "2026-03-13", category: "quality", minutes: 50, title: "Tempo" });
    // The four weeks before the week (9 Feb – 8 Mar): 480 minutes; one inside the week is not counted, another athlete's never.
    await ran("2026-02-09", 200, 30000);
    await ran("2026-03-08", 280, 40000);
    await ran("2026-03-09", 999, 1);
    const other = await makeTestUser(db);
    await ran("2026-03-01", 999, 1, other.userId);
    await plan({ date: DAY, category: "quality", user: other.userId, title: "Not mine" });

    const [row] = (await db.all(sql`select ${runCtxSql(userId, DAY)} as r`)) as Array<{ r: string }>;
    expect(runCtxOf(row!.r)).toEqual({
      thresholdSecPerKm: 289,
      nearby: [
        { date: "2026-03-10", kind: "hard_legs", title: "Heavy legs" },
        { date: "2026-03-12", kind: "quality_run", title: "Intervals" },
      ],
      weekMinutes: 150,
      fourWeekAvgMinutes: 120,
    });
  });

  it("nothing known: no threshold, nothing near, no week, no average", async () => {
    const [row] = (await db.all(sql`select ${runCtxSql(userId, DAY)} as r`)) as Array<{ r: string }>;
    expect(runCtxOf(row!.r)).toEqual({ thresholdSecPerKm: null, nearby: [], weekMinutes: 0, fourWeekAvgMinutes: null });
  });
});

describe("thresholdSql and runWeeksSql → runningFactsOf", () => {
  it("the latest threshold with its day, and each of the last four weeks back from today", async () => {
    await db.insert(schema.dailyHealth).values({ id: `${userId}:b`, userId, date: "2026-03-08", thresholdPaceSecPerKm: 289, contentFingerprint: "f", updatedAt: "2026-03-08T00:00:00.000Z" });
    await ran("2026-03-11", 30, 5000); // today: week 0
    await ran("2026-03-05", 40, 7000); // 6 days back: week 0
    await ran("2026-03-04", 50, 9000); // 7 days back: week 1
    await ran("2026-02-12", 60, 11000); // 27 days back: week 3
    await ran("2026-02-11", 70, 1); // 28 days back: out
    const [row] = (await db.all(sql`select ${thresholdSql(userId)} as t, ${runWeeksSql(userId, DAY)} as w`)) as Array<{ t: string; w: string }>;
    expect(runningFactsOf(row!.t, row!.w)).toEqual({
      threshold: { secPerKm: 289, date: "2026-03-08" },
      weeks: [
        { seconds: 4200, meters: 12000 },
        { seconds: 3000, meters: 9000 },
        { seconds: 0, meters: 0 },
        { seconds: 3600, meters: 11000 },
      ],
    });
  });
});
