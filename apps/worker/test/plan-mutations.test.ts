import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, todayInZone } from "@rg/domain";
import { applyOps } from "../src/services/coach-apply.js";
import { removeFromPlan } from "../src/services/plan-mutations.js";
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
    const out = await removeFromPlan(db, userId, "w1", { now: nowInstant(), source: "remove_from_plan" });
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
    expect(await removeFromPlan(db, userId, "w2", { now: nowInstant(), source: "remove_from_plan" }))
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

  it("reports resimFrom for a past-dated removal and null for a future one", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);
    const pastDate = addDays(today, -2);
    await seed(db, userId, "past", pastDate);
    await seed(db, userId, "future", addDays(today, 2));
    // Past rows are refused by guardrails upstream, but apply itself must still report honestly.
    const past = await applyOps(db, userId, prefs, "p0", [{ kind: "remove", workoutId: "past" }]);
    expect(past.resimFrom).toBe(pastDate);
    const a = await applyOps(db, userId, prefs, "p1", [{ kind: "remove", workoutId: "future" }]);
    expect(a.resimFrom).toBeNull();
  });
});
