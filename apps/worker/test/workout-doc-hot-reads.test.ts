/**
 * THE HOT READS NEVER CARRY THE WORKOUT DOCUMENT, AND A BAD ONE BREAKS NOTHING (Stage 1 Task 11; controller ruling
 * 2026-10-10).
 *
 * `workout_doc` is plain JSON text (Drizzle's json mode parsed it on every full-row read and threw on a malformed
 * value). The reads that never need it — the Plan page's today, the hourly import's planned rows, the coach's dossier
 * — leave it out of their SQL, and a row whose document is malformed JSON breaks none of them. Synthetic fixtures
 * only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, parseStoredWorkoutDoc, todayInZone, type UserPreferences } from "@rg/domain";
import type { SourcePlannedWorkout } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { buildDossier } from "../src/services/coach-context.js";
import { planRoutes } from "../src/routes/plan.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { plannedWorkouts } = schema;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let statements: string[];

/** A select that reads the document column (a write that names it — the import's own revisions — is not a read). */
const readsDoc = (q: string) => /^\s*select\b/i.test(q) && /"workout_doc"/.test(q);

beforeEach(async () => {
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (q) => statements.push(q) });
  ({ userId, prefs } = await makeTestUser(db));
  today = todayInZone(prefs.timezone);
  // Three rows: today's and tomorrow's with a document that is not JSON at all, yesterday's done with a valid one.
  const row = (id: string, date: string, workoutDoc: string, completionState = "scheduled") => ({
    id, userId, planId: "plan-1", sourceWorkoutId: `plan-1:${id}`, sourceIdInPlan: id, title: "Easy 30", category: "easy",
    sport: "run", originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "07:00",
    completionState, sourceContentFingerprint: `fp-${id}`, calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
    workoutDoc, workoutDocRev: 1, createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  const valid = JSON.stringify({ version: 1, title: "Easy 30", intent: { summary: "Easy", goals: [], focus: [], effort: "maintain" }, parts: [{ purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: 1800 }, effort: "easy" }] }], source: { kind: "coros_import" } });
  await db.insert(plannedWorkouts).values([row("1", today, ""), row("2", addDays(today, 1), ""), row("3", addDays(today, -1), valid, "completed")]);
  // The malformed text written by plain SQL, past any column mapping: what a bad write or a hand edit would leave.
  await db.run(sql`update planned_workouts set workout_doc = '{not json' where id = '1'`);
  await db.run(sql`update planned_workouts set workout_doc = '[1, 2' where id = '2'`);
  statements.length = 0;
});

describe("the hot reads", () => {
  it("the Plan page's today answers with a malformed document on the page, and reads no document", async () => {
    const app = mountRoutes(db, "/api/plan", planRoutes);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    statements.length = 0;
    const res = await app.request("/api/plan/today", { headers: { Cookie: cookie } }, { FIXTURE_MODE: "1" } as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { todaySessions: Array<{ workout: { id: string } }>; upcoming: Array<{ id: string }> };
    expect(body.todaySessions.map((s) => s.workout.id)).toEqual(["1"]);
    expect(body.upcoming.map((w) => w.id)).toEqual(["1", "2"]);
    expect(statements.filter((q) => /from "planned_workouts"/.test(q)).length).toBeGreaterThan(0);
    expect(statements.filter(readsDoc)).toEqual([]);
  });

  it("the hourly import reads every row without its document, and a malformed one stops nothing", async () => {
    const src = (id: string, date: string, fp: string): SourcePlannedWorkout => ({
      sourcePlanId: "plan-1", sourceWorkoutId: `plan-1:${id}`, sourceIdInPlan: id, title: "Easy 30", sport: "run", date,
      stages: [{ id: "s1", order: 0, kind: "work", durationType: "time", durationSeconds: 1800 }], contentFingerprint: fp, isRestDay: false,
    });
    // The first read creates the plan row and claims the seeded rows by address; the second changes row 2 upstream.
    await importPlanSnapshot(db, { userId, plan: { sourcePlanId: "plan-1", name: "Plan" }, workouts: [src("1", today, "fp-1"), src("2", addDays(today, 1), "fp-2")], rangeStart: today, rangeEnd: addDays(today, 13), source: "fixture" }, prefs);
    statements.length = 0;
    const stats = await importPlanSnapshot(
      db,
      { userId, plan: { sourcePlanId: "plan-1", name: "Plan" }, workouts: [src("1", today, "fp-1"), src("2", addDays(today, 1), "fp-2b")], rangeStart: today, rangeEnd: addDays(today, 13), source: "fixture" },
      prefs,
    );
    expect(stats.updatedContent).toBe(1);
    expect(statements.filter(readsDoc)).toEqual([]);
    // Row 1 kept its (malformed) column untouched; row 2's content change wrote it a real document at the next revision.
    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get("1")!.workoutDoc).toBe("{not json");
    expect(parseStoredWorkoutDoc(byId.get("2")!.workoutDoc)?.source.kind).toBe("coros_import");
    expect(byId.get("2")!.workoutDocRev).toBe(2);
  });

  it("the coach's dossier reads no document, malformed or not", async () => {
    statements.length = 0;
    const dossier = await buildDossier(db, userId, prefs, today);
    expect(dossier).toBeTruthy();
    expect(statements.filter(readsDoc)).toEqual([]);
  });

  it("any full-row read still works on a malformed document: the column is text, parsed only by parseStoredWorkoutDoc", async () => {
    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    expect(rows.find((r) => r.id === "1")!.workoutDoc).toBe("{not json");
    expect(parseStoredWorkoutDoc(rows.find((r) => r.id === "1")!.workoutDoc)).toBeNull();
    expect(parseStoredWorkoutDoc(rows.find((r) => r.id === "3")!.workoutDoc)?.title).toBe("Easy 30");
  });
});
