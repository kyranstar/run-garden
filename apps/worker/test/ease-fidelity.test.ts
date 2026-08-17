/**
 * EASE FIDELITY — an approved ease must replace the session, not relabel it.
 *
 * `coach-apply.ts` used to update seven columns on an ease and leave the rest of
 * the row describing the workout it replaced. The tests here are ROUND TRIPS,
 * because that is the property that was missing: store v1, ease to v2, and the
 * row must reconstruct v2 and retain NOTHING of v1. The reference for "what v2
 * looks like on a row" is deliberately not a hand-written expectation — it is a
 * fresh insert of v2 through the same writer, so the two paths cannot drift
 * apart again without failing here.
 *
 * Also covered: the ownership stamp must not become the athlete's title, and the
 * one-shot repair for the rows the bug already damaged.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant, type CoachOp, type CoachSession, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { planRoutes } from "../src/routes/plan.js";
import { applyOps } from "../src/services/coach-apply.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { repairPlannedWorkoutFidelity } from "../src/services/plan-repair.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { auditEvents, corosWriteJobs, plannedWorkoutStages, plannedWorkouts } = schema;

const DATE = "2026-09-14";

/**
 * Every column a `CoachSession` decides. The list is the contract: an ease and
 * an insert of the same session must agree on all of it.
 */
const SESSION_COLUMNS = [
  "title",
  "category",
  "qualitySubtype",
  "sport",
  "sourceContentFingerprint",
  "sourceEstimatedDurationSeconds",
  "fallbackEstimatedDurationSeconds",
  "calendarBlockDurationSeconds",
  "durationEstimate",
  "expectedDistanceMeters",
  "stageSummary",
  "structuredJson",
  "corosSyncState",
] as const;

type Row = typeof plannedWorkouts.$inferSelect;

function sessionFacts(row: Row): Record<string, unknown> {
  return Object.fromEntries(SESSION_COLUMNS.map((c) => [c, row[c]]));
}

async function stagesOf(db: Db, workoutId: string) {
  return (
    await db
      .select()
      .from(plannedWorkoutStages)
      .where(eq(plannedWorkoutStages.workoutId, workoutId))
      .orderBy(asc(plannedWorkoutStages.ord))
  ).map((s) => ({
    ord: s.ord,
    kind: s.kind,
    durationType: s.durationType,
    durationSeconds: s.durationSeconds,
    distanceMeters: s.distanceMeters,
    targetType: s.targetType,
    targetLow: s.targetLow,
    targetHigh: s.targetHigh,
    label: s.label,
  }));
}

let db: Db;
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  db = makeTestDb();
  ({ userId, prefs } = await makeTestUser(db));
});

/**
 * Store v1, age it the way a COROS import ages a row, ease it to v2, and insert
 * v2 fresh for comparison. Returns the eased row and the reference row.
 */
async function roundTrip(v1: CoachSession, v2: CoachSession) {
  await applyOps(db, userId, prefs, "v1", [{ kind: "add", date: DATE, session: v1 } as CoachOp]);
  const stored = (
    await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))
  )[0]!;

  // What the COROS import then puts on the row (rule 7) — the derived numbers
  // that describe v1's body and that the broken ease left in place. These exact
  // values are the live ones off the athlete's 2026-08-17 session.
  await db
    .update(plannedWorkouts)
    .set({
      qualitySubtype: "intervals",
      sourceEstimatedDurationSeconds: 4509,
      durationEstimate: { source: "coros_native", workoutSeconds: 4509, confidence: "high" },
      expectedDistanceMeters: 11104.52,
      corosSyncState: "synced",
    })
    .where(eq(plannedWorkouts.id, stored.id));

  await applyOps(db, userId, prefs, "ease", [
    { kind: "ease", workoutId: stored.id, session: v2 } as CoachOp,
  ]);

  // The reference: v2 inserted by the writer the `add` path uses. Whatever that
  // produces IS the correct row for v2, by definition.
  await applyOps(db, userId, prefs, "v2", [{ kind: "add", date: DATE, session: v2 } as CoachOp]);

  const eased = (
    await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, stored.id))
  )[0]!;
  const reference = (
    await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))
  ).find((r) => r.id !== stored.id)!;

  return {
    eased,
    reference,
    easedStages: await stagesOf(db, eased.id),
    referenceStages: await stagesOf(db, reference.id),
  };
}

const intervals: CoachSession = {
  category: "quality",
  title: "Threshold 6×640",
  durationMinutes: 75,
  run: {
    blocks: [
      { kind: "duration", value: 5, intensity: "easy" },
      { kind: "distance", value: 2414, intensity: "easy" },
      { kind: "distance", value: 644, intensity: "threshold" },
      { kind: "distance", value: 2414, intensity: "easy" },
      { kind: "duration", value: 5, intensity: "easy" },
    ],
  },
};

describe("an ease reconstructs the session and retains nothing of the old one", () => {
  it("run → run", async () => {
    const { eased, reference, easedStages, referenceStages } = await roundTrip(intervals, {
      category: "easy",
      title: "Easy first run back",
      durationMinutes: 35,
      run: { blocks: [{ kind: "duration", value: 35, intensity: "easy" }] },
    });
    expect(sessionFacts(eased)).toEqual(sessionFacts(reference));
    expect(easedStages).toEqual(referenceStages);
    // The three numbers the athlete actually saw, named explicitly so a
    // regression reads as the bug rather than as a diff.
    expect(eased.sourceEstimatedDurationSeconds).toBeNull(); // was 4509 → 75min card, 100min calendar
    expect(eased.expectedDistanceMeters).toBeNull(); // was 11104.52 → completion match failed
    expect(eased.durationEstimate).toBeNull();
    expect(eased.qualitySubtype).toBeNull();
    expect(easedStages).toHaveLength(1);
    expect(eased.stageSummary).toBe("35 min easy");
  });

  it("run → lift: the run's stage rows go, the exercise list arrives", async () => {
    const exercises = [
      { originId: "S1", name: "Goblet squat", sets: 3, reps: 10, restSeconds: 90, weight: { type: "bodyweight" as const } },
    ];
    const { eased, reference, easedStages, referenceStages } = await roundTrip(intervals, {
      category: "strength",
      title: "Legs, easy",
      durationMinutes: 40,
      lift: { exercises },
    });
    expect(sessionFacts(eased)).toEqual(sessionFacts(reference));
    // The whole point: a lift session must not still be prescribing intervals.
    expect(easedStages).toEqual([]);
    expect(referenceStages).toEqual([]);
    expect(eased.sport).toBe("strength");
    expect(eased.structuredJson).toEqual({ exercises });
  });

  it("lift → lift: the pre-ease exercise list does not survive", async () => {
    const before: CoachSession = {
      category: "strength",
      title: "Upper A",
      durationMinutes: 60,
      lift: {
        exercises: [
          { originId: "S1", name: "Bench press", sets: 5, reps: 5, restSeconds: 180, weight: { type: "kg" as const, value: 60 } },
          { originId: "S2", name: "Weighted pull-up", sets: 4, reps: 6, restSeconds: 180, weight: { type: "kg" as const, value: 10 } },
        ],
      },
    };
    const after: CoachSession = {
      category: "strength",
      title: "Upper A, trimmed",
      durationMinutes: 30,
      lift: { exercises: [{ originId: "S1", name: "Bench press", sets: 2, reps: 8, restSeconds: 120, weight: { type: "kg" as const, value: 45 } }] },
    };
    const { eased, reference } = await roundTrip(before, after);
    expect(sessionFacts(eased)).toEqual(sessionFacts(reference));
    // The DTO renders `exercises` in preference to `stageSummary`, so a stale
    // list here IS the session sheet's prescription.
    expect(eased.structuredJson).toEqual({
      exercises: [{ originId: "S1", name: "Bench press", sets: 2, reps: 8, restSeconds: 120, weight: { type: "kg" as const, value: 45 } }],
    });
    expect(JSON.stringify(eased.structuredJson)).not.toContain("pull-up");
  });

  it("a body removed entirely leaves no body behind", async () => {
    const { eased, reference, easedStages } = await roundTrip(intervals, {
      category: "recovery",
      title: "Walk, by feel",
      durationMinutes: 30,
    });
    expect(sessionFacts(eased)).toEqual(sessionFacts(reference));
    expect(easedStages).toEqual([]);
    expect(eased.structuredJson).toBeNull();
    // With no blocks, the title IS the prescription (stageSummary's fallback).
    expect(eased.stageSummary).toBe("Walk, by feel");
  });

  it("a lift eased into a run drops the exercise list AND gains stages", async () => {
    const { eased, reference, easedStages, referenceStages } = await roundTrip(
      {
        category: "strength",
        title: "Upper A",
        durationMinutes: 60,
        lift: {
          exercises: [
            { originId: "S1", name: "Bench press", sets: 5, reps: 5, restSeconds: 180, weight: { type: "kg" as const, value: 60 } },
          ],
        },
      },
      {
        category: "easy",
        title: "Twenty easy instead",
        durationMinutes: 20,
        run: { blocks: [{ kind: "duration", value: 20, intensity: "easy" }] },
      },
    );
    expect(sessionFacts(eased)).toEqual(sessionFacts(reference));
    expect(eased.structuredJson).toBeNull();
    expect(eased.sport).toBe("run");
    expect(easedStages).toEqual(referenceStages);
    expect(easedStages).toHaveLength(1);
  });

  it("a distance-block session carries its own expected distance", async () => {
    await applyOps(db, userId, prefs, "d", [
      {
        kind: "add",
        date: DATE,
        session: {
          category: "long",
          title: "Long run",
          durationMinutes: 100,
          run: { blocks: [{ kind: "distance", value: 16_000, intensity: "easy" }] },
        },
      } as CoachOp,
    ]);
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    expect(row!.expectedDistanceMeters).toBe(16_000);
  });

  it("easing a workout that is gone says so instead of reporting success", async () => {
    const out = await applyOps(db, userId, prefs, "ghost", [
      { kind: "ease", workoutId: "not-a-row", session: intervals } as CoachOp,
    ]);
    expect(out.updated).toEqual([]);
    expect(out.missed).toHaveLength(1);
    // And nothing was deleted on the way past the ownership check.
    expect(await db.select().from(plannedWorkoutStages)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the ownership stamp is not the athlete's title", () => {
  /** COROS serving back the program names it holds. */
  function snapshot(names: Array<{ id: string; title: string }>) {
    return names.map((n, i) => ({
      sourcePlanId: "9001",
      sourceWorkoutId: `9001:${n.id}`,
      sourceIdInPlan: n.id,
      title: n.title,
      sport: "run",
      date: DATE,
      estimatedDurationSeconds: 1500,
      stages: [],
      contentFingerprint: `wire-${i}`,
      isRestDay: false,
    }));
  }

  async function importNames(names: Array<{ id: string; title: string }>) {
    await importPlanSnapshot(
      db,
      {
        userId,
        plan: { sourcePlanId: "9001", name: "COROS plan" },
        workouts: snapshot(names),
        rangeStart: "2026-09-01",
        rangeEnd: "2026-09-30",
        source: "fixture",
      },
      prefs,
    );
    return db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
  }

  it("a title we stamped comes back as the title we meant; a stranger's is untouched", async () => {
    // The create job is the proof of authorship — `payload.name` is the exact
    // stamp we wrote, `payload.session.title` the exact title we meant.
    await db.insert(corosWriteJobs).values({
      id: "job-1",
      userId,
      workoutId: "w-coach",
      kind: "coach_create_workout",
      expectedContentFingerprint: "coach-1",
      originalDate: DATE,
      destinationDate: DATE,
      payload: {
        workoutId: "w-coach",
        happenDay: DATE,
        name: `Legs-back jog — ${DATE}`,
        session: { category: "easy", title: "Legs-back jog", durationMinutes: 25 },
      },
      requestedAt: nowInstant(),
      status: "verified",
      updatedAt: nowInstant(),
    });

    const rows = await importNames([
      { id: "1", title: `Legs-back jog — ${DATE}` },
      // Not ours, and shaped just like a stamp. Renaming it would be the app
      // editing the athlete's own COROS workout.
      { id: "2", title: `Hill repeats — ${DATE}` },
    ]);
    const byId = new Map(rows.map((r) => [r.sourceWorkoutId, r.title]));
    expect(byId.get("9001:1")).toBe("Legs-back jog");
    expect(byId.get("9001:2")).toBe(`Hill repeats — ${DATE}`);
  });

  it("the strip is idempotent — a second import does not re-stamp or re-strip", async () => {
    await db.insert(corosWriteJobs).values({
      id: "job-1",
      userId,
      workoutId: "w-coach",
      kind: "create_scheduled_workout",
      expectedContentFingerprint: "studio-1",
      originalDate: DATE,
      destinationDate: DATE,
      payload: {
        name: "Upper A — wk 3",
        session: { title: "Upper A", weekday: 1, exercises: [] },
      },
      requestedAt: nowInstant(),
      status: "verified",
      updatedAt: nowInstant(),
    });
    await importNames([{ id: "1", title: "Upper A — wk 3" }]);
    const rows = await importNames([{ id: "1", title: "Upper A — wk 3" }]);
    expect(rows.map((r) => r.title)).toEqual(["Upper A"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the one-shot fidelity repair", () => {
  /** A row in exactly the state the broken ease left the live 2026-08-17 one. */
  async function seedDamagedEase(id: string, date: string) {
    await db.insert(plannedWorkouts).values({
      id,
      userId,
      planId: "p",
      sourceWorkoutId: `4738:${id}`,
      title: "Easy first run back",
      category: "easy",
      qualitySubtype: "intervals",
      sport: "run",
      originalPlanDate: date,
      lastVerifiedCorosDate: date,
      effectiveDate: date,
      effectiveTime: "07:00",
      sourceContentFingerprint: "coach-abc",
      sourceEstimatedDurationSeconds: 4509,
      fallbackEstimatedDurationSeconds: 4509,
      calendarBlockDurationSeconds: 2100,
      durationEstimate: { source: "coros_native", workoutSeconds: 4509 },
      expectedDistanceMeters: 11104.52,
      stageSummary: "35min easy",
      corosSyncState: "calendar_only",
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await db.insert(plannedWorkoutStages).values(
      [0, 1, 2, 3, 4, 5, 6].map((ord) => ({
        id: `${id}:${ord}`,
        workoutId: id,
        ord,
        kind: ord === 0 ? "warmup" : "work",
        durationType: ord === 0 ? "time" : "distance",
        durationSeconds: ord === 0 ? 300 : null,
        distanceMeters: ord === 0 ? null : 643.74,
        targetType: "pace",
        targetLow: 289,
        targetHigh: 313,
        label: ord === 0 ? "easy" : "threshold",
      })),
    );
    await db.insert(schema.syncIntents).values({
      id: `intent-${id}`,
      userId,
      targetKind: "workout",
      targetId: id,
      kind: "content",
      payload: { fingerprint: "coach-abc" },
      source: "coach_ease",
      createdAt: nowInstant(),
    });
  }

  it("a dry run reports every change and writes nothing", async () => {
    await seedDamagedEase("w-eased", "2026-08-17");
    const report = await repairPlannedWorkoutFidelity(db, userId, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.backup).toBeNull();
    expect(report.totals.easedRowsRepaired).toBe(1);
    expect(report.totals.stageRowsRemoved).toBe(7);
    const row = report.eased[0]!;
    expect(row.action).toBe("repair");
    expect(row.stagesRemoved).toHaveLength(7);
    const byColumn = new Map(row.changes.map((c) => [c.column, c]));
    expect(byColumn.get("sourceEstimatedDurationSeconds")).toEqual({
      column: "sourceEstimatedDurationSeconds",
      from: 4509,
      to: null,
    });
    expect(byColumn.get("fallbackEstimatedDurationSeconds")).toEqual({
      column: "fallbackEstimatedDurationSeconds",
      from: 4509,
      to: 2100,
    });
    expect(byColumn.get("expectedDistanceMeters")?.from).toBe(11104.52);
    expect(byColumn.get("qualitySubtype")?.from).toBe("intervals");

    // Nothing moved.
    const [after] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, "w-eased"));
    expect(after!.sourceEstimatedDurationSeconds).toBe(4509);
    expect(await db.select().from(plannedWorkoutStages)).toHaveLength(7);
    expect(await db.select().from(auditEvents)).toHaveLength(0);
  });

  it("a live run backs up first, then repairs — and is a no-op the second time", async () => {
    await seedDamagedEase("w-eased", "2026-08-17");
    await seedDamagedEase("w-eased-2", "2026-08-22");
    const report = await repairPlannedWorkoutFidelity(db, userId, { dryRun: false });

    expect(report.totals.easedRowsRepaired).toBe(2);
    expect(report.backup?.kind).toBe("planned_workout_fidelity_repaired");

    // The backup carries the pre-change rows AND their stages, whole.
    const [backup] = await db.select().from(auditEvents);
    const detail = backup!.detail as {
      previousWorkouts: Array<{ id: string; sourceEstimatedDurationSeconds: number }>;
      previousStages: unknown[];
    };
    expect(detail.previousWorkouts.map((w) => w.id).sort()).toEqual(["w-eased", "w-eased-2"]);
    expect(detail.previousWorkouts[0]!.sourceEstimatedDurationSeconds).toBe(4509);
    expect(detail.previousStages).toHaveLength(14);

    const rows = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    for (const r of rows) {
      expect(r.sourceEstimatedDurationSeconds).toBeNull();
      expect(r.fallbackEstimatedDurationSeconds).toBe(2100);
      expect(r.durationEstimate).toBeNull();
      expect(r.expectedDistanceMeters).toBeNull();
      expect(r.qualitySubtype).toBeNull();
      // Untouched: the ease wrote these, and they are the athlete's approval.
      expect(r.title).toBe("Easy first run back");
      expect(r.stageSummary).toBe("35min easy");
      expect(r.calendarBlockDurationSeconds).toBe(2100);
    }
    expect(await db.select().from(plannedWorkoutStages)).toHaveLength(0);

    const second = await repairPlannedWorkoutFidelity(db, userId, { dryRun: false });
    expect(second.totals.easedRowsRepaired).toBe(0);
    expect(second.totals.easedRowsClean).toBe(2);
    expect(second.backup).toBeNull();
    expect(await db.select().from(auditEvents)).toHaveLength(1);
  });

  it("a correctly-eased row is never a candidate", async () => {
    await applyOps(db, userId, prefs, "v1", [
      { kind: "add", date: DATE, session: intervals } as CoachOp,
    ]);
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId));
    await applyOps(db, userId, prefs, "ease", [
      {
        kind: "ease",
        workoutId: row!.id,
        session: {
          category: "easy",
          title: "Easy 35",
          durationMinutes: 35,
          run: { blocks: [{ kind: "duration", value: 35, intensity: "easy" }] },
        },
      } as CoachOp,
    ]);
    const report = await repairPlannedWorkoutFidelity(db, userId, { dryRun: true });
    expect(report.totals.easedRowsRepaired).toBe(0);
    expect(report.eased.map((r) => r.action)).toEqual(["clean"]);
    // Its stage rows are the EASED body and must survive a repair pass.
    expect(await stagesOf(db, row!.id)).toHaveLength(1);
  });

  it("a named row with no approved ease behind it is refused, not repaired", async () => {
    await db.insert(plannedWorkouts).values({
      id: "w-imported",
      userId,
      planId: "p",
      sourceWorkoutId: "4738:1",
      title: "Threshold 5×5",
      category: "quality",
      qualitySubtype: "intervals",
      sport: "run",
      originalPlanDate: DATE,
      lastVerifiedCorosDate: DATE,
      effectiveDate: DATE,
      effectiveTime: "07:00",
      sourceContentFingerprint: "wire",
      sourceEstimatedDurationSeconds: 4509,
      calendarBlockDurationSeconds: 4509,
      expectedDistanceMeters: 11104.52,
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const report = await repairPlannedWorkoutFidelity(db, userId, {
      dryRun: false,
      workoutIds: ["w-imported"],
    });
    expect(report.eased[0]!.action).toBe("skipped");
    expect(report.totals.easedRowsRepaired).toBe(0);
    const [after] = await db
      .select()
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.id, "w-imported"));
    expect(after!.sourceEstimatedDurationSeconds).toBe(4509);
  });

  it("history is not rewritten", async () => {
    await seedDamagedEase("w-done", "2026-08-01");
    await db
      .update(plannedWorkouts)
      .set({ completionState: "completed" })
      .where(eq(plannedWorkouts.id, "w-done"));
    const report = await repairPlannedWorkoutFidelity(db, userId, { dryRun: false });
    expect(report.eased[0]!.action).toBe("skipped");
    expect(report.eased[0]!.reason).toContain("completed");
    expect(await db.select().from(plannedWorkoutStages)).toHaveLength(7);
  });

  it("the route requires dryRun explicitly — a caller that forgot it is not guessed at", async () => {
    const env = {
      DB: {} as unknown as Env["DB"],
      ASSETS: {} as unknown as Env["ASSETS"],
      APP_URL: "https://app.test",
      FIXTURE_MODE: "1",
      AI_DEFAULT_ENABLED: "1",
      SESSION_SECRET: "test-session-secret",
      TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
      ALLOWED_GOOGLE_EMAIL: "runner@example.com",
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: "test-client-secret",
    } as Env;
    await seedDamagedEase("w-eased", "2026-08-17");
    const app = mountRoutes(db, "/api/plan", planRoutes);
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const call = (body: unknown) =>
      app.request(
        "/api/plan/repair-fidelity",
        {
          method: "POST",
          headers: { Cookie: cookie, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        env,
      );

    // No `dryRun`: refused, and the row is untouched. The default direction for a
    // forgotten field must never be "rewrite live sessions".
    const missing = await call({});
    expect(missing.status).toBe(400);
    expect(await db.select().from(plannedWorkoutStages)).toHaveLength(7);

    const dry = await call({ dryRun: true });
    expect(dry.status).toBe(200);
    const report = (await dry.json()) as { dryRun: boolean; totals: { easedRowsRepaired: number } };
    expect(report.dryRun).toBe(true);
    expect(report.totals.easedRowsRepaired).toBe(1);
    expect(await db.select().from(plannedWorkoutStages)).toHaveLength(7);
  });

  it("stamped titles are repaired back to the title we meant", async () => {
    for (const [n, date] of [["1", "2026-10-26"], ["2", "2026-10-28"]].entries()) {
      const [id, day] = date;
      await db.insert(corosWriteJobs).values({
        id: `job-${n}`,
        userId,
        workoutId: `w-${id}`,
        kind: "coach_create_workout",
        expectedContentFingerprint: `coach-${id}`,
        originalDate: day!,
        destinationDate: day!,
        payload: {
          workoutId: `w-${id}`,
          happenDay: day,
          name: `${id === "1" ? "Legs-back jog" : "Easy aerobic"} — ${day}`,
          session: {
            category: "easy",
            title: id === "1" ? "Legs-back jog" : "Easy aerobic",
            durationMinutes: 30,
          },
        },
        requestedAt: nowInstant(),
        status: "verified",
        updatedAt: nowInstant(),
      });
      await db.insert(plannedWorkouts).values({
        id: `w-${id}`,
        userId,
        planId: "p",
        sourceWorkoutId: `9001:${id}`,
        title: `${id === "1" ? "Legs-back jog" : "Easy aerobic"} — ${day}`,
        category: "easy",
        sport: "run",
        originalPlanDate: day!,
        lastVerifiedCorosDate: day!,
        effectiveDate: day!,
        effectiveTime: "07:00",
        sourceContentFingerprint: `wire-${id}`,
        calendarBlockDurationSeconds: 1800,
        completionState: "scheduled",
        createdAt: nowInstant(),
        updatedAt: nowInstant(),
      });
    }

    const dry = await repairPlannedWorkoutFidelity(db, userId, { dryRun: true });
    expect(dry.totals.titlesRepaired).toBe(2);
    expect(dry.stampedTitles.map((s) => [s.from, s.to])).toEqual([
      ["Legs-back jog — 2026-10-26", "Legs-back jog"],
      ["Easy aerobic — 2026-10-28", "Easy aerobic"],
    ]);
    const [stillStamped] = await db
      .select()
      .from(plannedWorkouts)
      .where(eq(plannedWorkouts.id, "w-1"));
    expect(stillStamped!.title).toBe("Legs-back jog — 2026-10-26");

    const live = await repairPlannedWorkoutFidelity(db, userId, { dryRun: false });
    expect(live.totals.titlesRepaired).toBe(2);
    const titles = (
      await db
        .select()
        .from(plannedWorkouts)
        .where(and(eq(plannedWorkouts.userId, userId)))
    )
      .map((r) => r.title)
      .sort();
    expect(titles).toEqual(["Easy aerobic", "Legs-back jog"]);
    expect(
      (await repairPlannedWorkoutFidelity(db, userId, { dryRun: false })).totals.titlesRepaired,
    ).toBe(0);
  });
});
