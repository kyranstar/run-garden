/**
 * THE PLAN SAYS A MIRRORED SESSION IN THE MIRROR'S WORDS (the watch mirrors the plan §3.9): an app-built session the
 * mirror holds (`mirroredKind`) has its row's `syncAction` from the watch job on its way — never from the date state a
 * move leaves (`coros_sync_state` → `calendar_only`), and never the move lane's retry, which is not how its copy goes
 * on. Leave is gone for it (A8): a pre-mirror LEFT mark says nothing on its row. Off the switch, as before.
 * Synthetic data only; the clock pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { planRoutes } from "../src/routes/plan.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { connectTestCoros, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { queueProvisionalPush } from "../src/services/mirror.js";
import { DAY, makeEnv, NOON, rowOf, seedProgram, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, syncIntents } = schema;
const AHEAD = "2026-10-12";

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  programId = await seedProgram(db, userId);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A Studio workout ahead, moved there from two days before (the move left `calendar_only` and the old day's verified date). */
async function seedMoved(id: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}): Promise<string> {
  const doc = calmDoc();
  await db.insert(plannedWorkouts).values({
    id, userId, planId: programId, sourceWorkoutId: id, title: doc.title, category: "strength", sport: "strength",
    originalPlanDate: "2026-10-10", lastVerifiedCorosDate: "2026-10-10", effectiveDate: AHEAD, effectiveTime: "18:00",
    sourceContentFingerprint: "studio", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
    corosSyncState: "calendar_only", completionState: "scheduled", origin: "studio", contentState: "outline",
    workoutDoc: JSON.stringify(doc), workoutDocRev: 1, createdAt: NOON, updatedAt: NOON, ...over,
  });
  return id;
}

const job = (id: string, workoutId: string, kind: string, status: string) => ({
  id, userId, workoutId, kind, expectedContentFingerprint: "", originalDate: AHEAD, destinationDate: AHEAD,
  payload: { workoutId, happenDay: AHEAD, name: "x" }, requestedAt: NOON, status, updatedAt: NOON,
});

async function rowView(id: string, env: Env = switchOn()) {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const res = await mountRoutes(db, "/api/plan", planRoutes).request(`/api/plan/workouts/${id}`, { headers: { Cookie: cookie } }, env);
  expect(res.status).toBe(200);
  return ((await res.json()) as { workout: { corosSyncView?: string; syncAction?: { agent: string; code: string; control?: string }; watchVersionLeft?: true } }).workout;
}

describe("a mirrored session's row (the watch mirrors the plan §3.9)", () => {
  it("moved, nothing on its way yet (the mirror owes the new copy): no retry_write — nothing to do; off the switch, as before", async () => {
    const id = await seedMoved("studio-moved");
    expect((await rowView(id)).syncAction).toBeUndefined();
    // Off the switch the row answers as it did before the mirror (the coverage rule: a document's row holds no stages).
    expect((await rowView(id, makeEnv())).syncAction).toEqual({ agent: "nobody", code: "lives_here" });
  });

  it("the old copy's delete or the new copy's push on its way: watch_updating, by the app — from the job, not the stored state", async () => {
    const id = await seedMoved("studio-updating");
    await db.insert(corosWriteJobs).values(job("unpush:b1", id, "coach_delete_workout", "queued"));
    expect(await rowView(id)).toMatchObject({ corosSyncView: "syncing", syncAction: { agent: "app", code: "watch_updating" } });
    await db.update(corosWriteJobs).set({ status: "verified" }).where(eq(corosWriteJobs.id, "unpush:b1"));
    await db.insert(corosWriteJobs).values(job("push:b2", id, "program_session_push", "claimed"));
    expect((await rowView(id)).syncAction).toEqual({ agent: "app", code: "watch_updating" });
  });

  it("its push failed: watch_retrying (the mirror's backoff; the sheet's Retry) — never the move lane's retry control", async () => {
    const id = await seedMoved("studio-failed");
    await db.insert(corosWriteJobs).values(job("push:b3", id, "program_session_push", "failed"));
    const row = await rowView(id);
    expect(row.syncAction).toEqual({ agent: "app", code: "watch_retrying" });
  });

  it("kept off: kept_off_watch, by nobody", async () => {
    const id = await seedMoved("studio-kept", { watchOff: true });
    expect((await rowView(id)).syncAction).toEqual({ agent: "nobody", code: "kept_off_watch" });
  });

  it("a pre-mirror LEFT mark on an app-built session says nothing on its row (Leave is gone, A8)", async () => {
    const id = await seedMoved("studio-left", { lastVerifiedCorosDate: AHEAD, corosSyncState: "synced" });
    await db.insert(syncIntents).values({
      id: "content-left-1", userId, targetKind: "workout", targetId: id, kind: "content", payload: { left: NOON }, source: "coach", createdAt: NOON,
    });
    const row = await rowView(id);
    expect(row.watchVersionLeft).toBeUndefined();
  });
});

describe("Today's 'On your watch' (A9)", () => {
  it("shows for a provisional copy too: today's Studio workout, its provisional copy's push verified and the row holding the address", async () => {
    const doc = calmDoc();
    const id = "studio-today";
    await db.insert(plannedWorkouts).values({
      id, userId, planId: programId, sourceWorkoutId: id, title: doc.title, category: "strength", sport: "strength",
      originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "18:00", sourceContentFingerprint: "studio",
      calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "studio", contentState: "outline", workoutDoc: JSON.stringify(doc), workoutDocRev: 1,
      createdAt: NOON, updatedAt: NOON,
    });
    expect(await queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), { today: DAY, now: NOON, prefs })).toBe("queued");
    const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id));
    const todayOf = async () => {
      const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
      const res = await mountRoutes(db, "/api/plan", planRoutes).request("/api/plan/today", { headers: { Cookie: cookie } }, switchOn());
      expect(res.status).toBe(200);
      return ((await res.json()) as { todaySessions: Array<{ workout: { id: string }; onWatch?: boolean }> }).todaySessions.find((t) => t.workout.id === id);
    };
    expect((await todayOf())?.onWatch, "on its way: not on the watch yet").toBe(false);
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, push!.id));
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "4738:91", sourceIdInPlan: "91", sourceProgramId: "91", lastVerifiedCorosDate: DAY, corosSyncState: "synced" })
      .where(eq(plannedWorkouts.id, id));
    expect((await todayOf())?.onWatch).toBe(true);
  });
});
