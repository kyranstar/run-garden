import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone } from "@rg/domain";
import { applyOps } from "../src/services/coach-apply.js";
import { removeFromPlan, skipWorkout, unskipWorkout } from "../src/services/plan-mutations.js";
import { openIntentFor, recordIntent } from "../src/services/sync-intents.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

async function seed(db: ReturnType<typeof makeTestDb>, userId: string, id: string, date: string) {
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId: "p", sourceWorkoutId: `4738:${id}`, title: "Easy 40", category: "easy", sport: "run",
    originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "07:00",
    completionState: "scheduled", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 2400,
    createdAt: nowInstant(), updatedAt: nowInstant(),
  });
}

describe("removeFromPlan", () => {
  it("archives, suppresses as user_removed, records remove_local and closes an open move intent", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const date = addDays(todayInZone(prefs.timezone), 2);
    await seed(db, userId, "w1", date);
    await recordIntent(db, { userId, targetKind: "workout", targetId: "w1", kind: "move", source: "user_move" });
    const out = await removeFromPlan(db, userId, "w1", { now: nowInstant(), source: "remove_from_plan", prefs });
    expect(out).toEqual({ removed: true, effectiveDate: date });
    const [w] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w1"));
    expect(w!.archiveReason).toBe("user_removed");
    const sup = await db.select().from(schema.calendarEventSuppressions)
      .where(eq(schema.calendarEventSuppressions.workoutId, "w1"));
    expect(sup.map((s) => s.reason)).toEqual(["user_removed"]);
    expect(await openIntentFor(db, userId, "w1", "remove_local")).toBeTruthy();
    expect(await openIntentFor(db, userId, "w1", "move")).toBeFalsy();
  });

  it("is a no-op for an archived or foreign row", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await seed(db, other, "w2", addDays(todayInZone(prefs.timezone), 1));
    expect(await removeFromPlan(db, userId, "w2", { now: nowInstant(), source: "remove_from_plan", prefs }))
      .toEqual({ removed: false, effectiveDate: null });
  });
});

describe("coach remove ≡ manual remove", () => {
  it("a coach remove writes the same suppression and intent the route writes", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const date = addDays(todayInZone(prefs.timezone), 3);
    await seed(db, userId, "w1", date);
    const out = await applyOps(db, userId, prefs, "prop1", [{ kind: "remove", workoutId: "w1" }]);
    expect(out.archived).toEqual(["w1"]);
    const sup = await db.select().from(schema.calendarEventSuppressions)
      .where(eq(schema.calendarEventSuppressions.workoutId, "w1"));
    expect(sup).toHaveLength(1);
    expect(sup[0]!.reason).toBe("user_removed");
    expect(await openIntentFor(db, userId, "w1", "remove_local")).toBeTruthy();
  });

  it("both removes unpush a session the app pushed, and neither touches an imported one", async () => {
    // Ruling A1 option (b): the watch follows the plan for sessions the app put
    // there (verified stamp + address) whichever side removes them.
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const date = addDays(todayInZone(prefs.timezone), 3);
    for (const id of ["coach-pushed", "hand-pushed", "coach-imported", "hand-imported"]) {
      await seed(db, userId, id, date);
      await db
        .update(schema.plannedWorkouts)
        .set({ sourceWorkoutId: `4738:${id.length}${id.charCodeAt(0)}`, sourceIdInPlan: "12", sourceProgramId: "99" })
        .where(eq(schema.plannedWorkouts.id, id));
      if (id.endsWith("-pushed")) {
        await db.insert(schema.corosWriteJobs).values({
          id: `${id}-push`,
          userId,
          workoutId: id,
          kind: "coach_create_workout",
          expectedContentFingerprint: "fp",
          originalDate: date,
          destinationDate: date,
          payload: { workoutId: id, happenDay: date, name: `Easy 40 — ${date}` },
          requestedAt: nowInstant(),
          status: "verified",
          updatedAt: nowInstant(),
        });
      }
    }
    await applyOps(db, userId, prefs, "p-rm", [
      { kind: "remove", workoutId: "coach-pushed" },
      { kind: "remove", workoutId: "coach-imported" },
    ]);
    for (const id of ["hand-pushed", "hand-imported"]) {
      await removeFromPlan(db, userId, id, { now: nowInstant(), source: "remove_from_plan", prefs });
    }
    const unpushes = await db.select().from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.kind, "coach_delete_workout"));
    expect(unpushes.map((j) => j.workoutId).sort()).toEqual(["coach-pushed", "hand-pushed"]);
  });

  it("re-applying the same remove adds no second suppression", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await seed(db, userId, "w1", addDays(todayInZone(prefs.timezone), 3));
    await applyOps(db, userId, prefs, "prop1", [{ kind: "remove", workoutId: "w1" }]);
    await applyOps(db, userId, prefs, "prop1", [{ kind: "remove", workoutId: "w1" }]);
    const sup = await db.select().from(schema.calendarEventSuppressions)
      .where(eq(schema.calendarEventSuppressions.workoutId, "w1"));
    expect(sup).toHaveLength(1);
  });

  it("reports resimFrom for a removal today, null for a future one, and refuses a past-dated one", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seed(db, userId, "today", today);
    await seed(db, userId, "past", addDays(today, -2));
    await seed(db, userId, "future", addDays(today, 2));
    const now = await applyOps(db, userId, prefs, "p0", [{ kind: "remove", workoutId: "today" }]);
    expect(now.resimFrom).toBe(today);
    // A past row is refused by the guardrails at wake AND, since audit 1
    // (coach finding 2), by apply itself at the tap: its day has gone, so it is
    // reported as a shortfall and nothing reaches back into the garden.
    const past = await applyOps(db, userId, prefs, "p1", [{ kind: "remove", workoutId: "past" }]);
    expect(past.archived).toEqual([]);
    expect(past.missed).toEqual(["a session it takes off the plan has already had its day, so nothing was removed"]);
    expect(past.resimFrom).toBeNull();
    const a = await applyOps(db, userId, prefs, "p2", [{ kind: "remove", workoutId: "future" }]);
    expect(a.resimFrom).toBeNull();
  });
});

describe("unskipWorkout", () => {
  it("clears the skip, writes a restore override, and reports the resolved date", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    await seed(db, userId, "w1", today);
    await db.update(schema.plannedWorkouts)
      .set({ completionState: "skipped", resolutionDate: today, sanctionedBy: "coach" })
      .where(eq(schema.plannedWorkouts.id, "w1"));
    const out = await unskipWorkout(db, userId, "w1", { now: nowInstant(), today, source: "coach" });
    expect(out).toEqual({ restored: true, resolvedOn: today });
    const [w] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "w1"));
    expect([w!.completionState, w!.resolutionDate, w!.sanctionedBy]).toEqual(["scheduled", null, null]);
    const ov = await db.select().from(schema.scheduleOverrides).where(eq(schema.scheduleOverrides.workoutId, "w1"));
    expect(ov.map((o) => [o.kind, o.source])).toEqual([["restore", "coach"]]);
  });
  it("refuses a row that is not skipped", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    await seed(db, userId, "w1", todayInZone(prefs.timezone));
    expect(await unskipWorkout(db, userId, "w1", { now: nowInstant(), today: todayInZone(prefs.timezone), source: "app" }))
      .toEqual({ restored: false, resolvedOn: null, reason: "not_skipped" });
  });
  /**
   * THE DAY THE SKIP COUNTED ON (audit 1, coach finding 8). A skip lands in the
   * garden on the LATER of the session's date and its resolution date
   * (`resolutionLandedOn`, garden-sync.ts), so that is the day a restore has to
   * replay from. Resimulating from the resolution date alone reached back weeks
   * for a session skipped early — a replay run inline in the request for days
   * no skip ever touched.
   */
  it("restore resims from the day the skip counted on: the later of its date and its resolution", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    // Skipped three days ago, for a session two days ahead: the skip will
    // count on its own day, which has not come yet — nothing to replay.
    await seed(db, userId, "ahead", addDays(today, 2));
    await db.update(schema.plannedWorkouts)
      .set({ completionState: "skipped", resolutionDate: addDays(today, -3) })
      .where(eq(schema.plannedWorkouts.id, "ahead"));
    const out = await applyOps(db, userId, prefs, "p", [{ kind: "restore", workoutId: "ahead" }]);
    expect(out.updated).toEqual(["ahead"]);
    expect(out.resimFrom).toBeNull();

    // An overdue session skipped today counted TODAY, not on its own day.
    await seed(db, userId, "overdue", addDays(today, -2));
    await db.update(schema.plannedWorkouts)
      .set({ completionState: "skipped", resolutionDate: today })
      .where(eq(schema.plannedWorkouts.id, "overdue"));
    expect(await unskipWorkout(db, userId, "overdue", { now: nowInstant(), today, source: "app" }))
      .toEqual({ restored: true, resolvedOn: today });

    // No resolution date: it counted on its own day.
    await seed(db, userId, "bare", today);
    await db.update(schema.plannedWorkouts)
      .set({ completionState: "skipped", resolutionDate: null })
      .where(eq(schema.plannedWorkouts.id, "bare"));
    expect(await unskipWorkout(db, userId, "bare", { now: nowInstant(), today, source: "app" }))
      .toEqual({ restored: true, resolvedOn: today });
  });
});

/**
 * THE ONE WRITER OF A SKIP (the watch mirrors the plan §3.4; owner §10.2): the Plan's and the coach's skip alike. A session
 * the app built has its copy taken off the watch (mirror-hooks.test.ts drives it through the lane); one the app did not
 * build keeps its lane. Only a session still to resolve is skipped.
 */
describe("skipWorkout", () => {
  it("skips a scheduled or an unresolved session on today — sanctioned when the coach says so — never one done or gone", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const now = nowInstant();
    await seed(db, userId, "s1", addDays(today, 2));
    await seed(db, userId, "s2", addDays(today, -1));
    await db.update(schema.plannedWorkouts).set({ completionState: "unresolved" }).where(eq(schema.plannedWorkouts.id, "s2"));
    await seed(db, userId, "s3", addDays(today, -2));
    await db.update(schema.plannedWorkouts).set({ completionState: "completed" }).where(eq(schema.plannedWorkouts.id, "s3"));
    await seed(db, userId, "s4", addDays(today, 3));
    await db.update(schema.plannedWorkouts).set({ archivedAt: now }).where(eq(schema.plannedWorkouts.id, "s4"));

    expect(await skipWorkout(db, userId, "s1", { now, today, source: "coach", sanctionedBy: "coach", prefs })).toEqual({ skipped: true });
    expect(await skipWorkout(db, userId, "s2", { now, today, source: "app", prefs })).toEqual({ skipped: true });
    expect(await skipWorkout(db, userId, "s3", { now, today, source: "app", prefs })).toEqual({ skipped: false });
    expect(await skipWorkout(db, userId, "s4", { now, today, source: "app", prefs })).toEqual({ skipped: false });
    const rows = new Map((await db.select().from(schema.plannedWorkouts)).map((w) => [w.id, w]));
    expect(rows.get("s1")).toMatchObject({ completionState: "skipped", resolutionDate: today, sanctionedBy: "coach" });
    expect(rows.get("s2")).toMatchObject({ completionState: "skipped", resolutionDate: today, sanctionedBy: null });
    expect(rows.get("s3")).toMatchObject({ completionState: "completed", resolutionDate: null });
    expect(rows.get("s4")!.completionState).toBe("scheduled");
  });

  it("a session the app did not build keeps its copy (its own lane): no watch job, writes on or off", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const today = todayInZone(prefs.timezone);
    await seed(db, userId, "coach-1", addDays(today, 2));
    await db.insert(schema.corosWriteJobs).values({
      id: "coach-1-push", userId, workoutId: "coach-1", kind: "coach_create_workout", expectedContentFingerprint: "fp",
      originalDate: addDays(today, 2), destinationDate: addDays(today, 2),
      payload: { workoutId: "coach-1", happenDay: addDays(today, 2), name: "Easy 40 — invented", session: {} },
      requestedAt: nowInstant(), status: "verified", verifiedAt: nowInstant(), updatedAt: nowInstant(),
    });
    expect(await skipWorkout(db, userId, "coach-1", { now: nowInstant(), today, source: "coach", sanctionedBy: "coach", prefs })).toEqual({ skipped: true });
    expect((await db.select().from(schema.corosWriteJobs)).map((j) => j.id)).toEqual(["coach-1-push"]);
  });
});

describe("unskipWorkout and the watch", () => {
  it("a document workout of today or ahead is marked owed for the watch; one whose day is gone is not", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    for (const [id, date] of [["d-today", today], ["d-ahead", addDays(today, 3)], ["d-gone", addDays(today, -1)]] as const) {
      await seed(db, userId, id, date);
      await db.update(schema.plannedWorkouts).set({ origin: "studio", completionState: "skipped", resolutionDate: today }).where(eq(schema.plannedWorkouts.id, id));
      expect((await unskipWorkout(db, userId, id, { now: nowInstant(), today, source: "app" })).restored).toBe(true);
    }
    const marks = await db.select().from(schema.syncIntents).where(eq(schema.syncIntents.kind, "mirror"));
    expect(marks.map((m) => m.targetId).sort()).toEqual(["d-ahead", "d-today"]);
    expect(marks.every((m) => m.resolvedAt === null)).toBe(true);
  });
});
