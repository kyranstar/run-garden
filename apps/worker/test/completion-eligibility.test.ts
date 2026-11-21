/**
 * AUTO-MATCH ELIGIBILITY FROM OCCURRENCE TIME, NOT IMPORT TIME (R1.3; the lead's v0.22 ruling).
 *
 * Seen on production (R1.3 backlog 1): the owner's 2:03 PM yoga on Nov 20 (25 min, COROS, synced 22:29:55Z) was
 * auto-matched (`scored_auto`, 0.507) at 22:30:33Z to a one-off session placed at 22:30:18Z for Nov 21. A guess now pairs
 * an activity only with a session on its own training day (garden-sync.ts `activityDate`, run-garden's one rule) that
 * existed before the activity ended — applied before scoring — and re-checks at the write what may have changed since
 * scoring: the session archived, moved, matched or manually corrected. A match the owner undid is never redone, and a
 * manual match is never overridden. Late imports (an activity synced hours after it happened) and day boundaries (near
 * midnight, the account's zone) are covered. Synthetic data only, on an isolated test account.
 */
import { describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, type SourceActivity } from "@rg/domain";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { planRoutes } from "../src/routes/plan.js";
import { commitMatch, ingestActivities } from "../src/services/completion.js";
import type { Db } from "../src/services/db.js";
import { activityDate } from "../src/services/garden-sync.js";
import type { Env } from "../src/env.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { activities, plannedWorkouts, workoutCompletionMatches } = schema;

/** A one-off session on `date`, written at `createdAt` (a yoga, 25 minutes, unless told). */
async function session(db: Db, userId: string, date: string, createdAt: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}): Promise<string> {
  const id = newId();
  await db.insert(plannedWorkouts).values({
    id, userId, planId: `studio-${userId}`, origin: "studio", sourceWorkoutId: `studio:${id.slice(0, 6)}`, title: "TRE · floor", category: "yoga", sport: "yoga",
    originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "18:00", sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 1500, sourceEstimatedDurationSeconds: 1500, completionState: "scheduled", createdAt, updatedAt: createdAt,
    ...over,
  } as typeof plannedWorkouts.$inferInsert);
  return id;
}

/** A COROS activity: its local start, its UTC start, its length. */
const coros = (id: string, local: string, utc: string, minutes: number, sport = "yoga"): SourceActivity => ({
  provider: "coros", providerActivityId: id, startTime: utc, startTimeLocal: local, sport, durationSeconds: minutes * 60, contentFingerprint: `fp-${id}`,
});
const NOV20_YOGA = coros("yoga-1403", "2026-11-20T14:03:00", "2026-11-20T22:03:00Z", 25);

const activityRow = async (db: Db, providerId: string) => (await db.select().from(activities).where(eq(activities.corosActivityId, providerId)))[0];
const liveMatches = (db: Db) => db.select().from(workoutCompletionMatches).where(isNull(workoutCompletionMatches.undoneAt));
const rowOf = async (db: Db, id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;

const ENV = {
  DB: {}, ASSETS: {}, APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1", SESSION_SECRET: "test-session-secret",
  TOKEN_ENCRYPTION_KEY: "test-token-encryption-key", ALLOWED_GOOGLE_EMAIL: "runner@example.com", GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
} as unknown as Env;

/** The laptop's plan routes, signed in as `userId`. */
async function laptop(db: Db, userId: string) {
  const app = mountRoutes(db, "/api/plan", planRoutes);
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  return (path: string, body: unknown) =>
    app.request(path, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) }, ENV);
}

describe("auto-match eligibility from occurrence time (R1.3)", () => {
  it("the incident: a yoga never pairs with a session placed after it for the next day — at its sync, or the next one", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db); // Los Angeles
    // Synced at 22:29:55Z with nothing to answer.
    expect((await ingestActivities(db, { userId, sources: [NOV20_YOGA] })).matchesCreated).toBe(0);
    // Placed for Nov 21 at 22:30:18Z.
    const tre = await session(db, userId, "2026-11-21", "2026-11-20T22:30:18Z");
    // The next sync brings another activity of the window: the yoga is a candidate again, and still never the session's.
    const stats = await ingestActivities(db, { userId, sources: [coros("walk-nov21", "2026-11-21T08:00:00", "2026-11-21T16:00:00Z", 30, "walk")] });
    expect(stats.matchesCreated).toBe(0);
    expect([(await rowOf(db, tre)).completionState, (await activityRow(db, "yoga-1403"))!.completionMatchId]).toEqual(["scheduled", null]);
    expect(await liveMatches(db)).toEqual([]);
  });

  it("a late import is judged by when it happened: synced hours later, it answers the session that was there first", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const before = await session(db, userId, "2026-11-20", "2026-11-19T18:00:00Z");
    // A session written after the yoga ended, the same day, is no guess's: placed at 23:00Z, before the import.
    const after = await session(db, userId, "2026-11-20", "2026-11-20T23:00:00Z", { title: "Later", effectiveTime: "14:00" });
    // The yoga syncs at 05:00Z the next day (a late import).
    const stats = await ingestActivities(db, { userId, sources: [NOV20_YOGA] });
    expect(stats.matchesCreated).toBe(1);
    const [m] = await liveMatches(db);
    expect([m!.workoutId, m!.method]).toEqual([before, "scored_auto"]);
    expect((await rowOf(db, after)).completionState).toBe("scheduled");
  });

  it("near midnight, the activity's own day decides (the training-day contract), whatever its UTC date", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db); // Los Angeles: 23:50 on Nov 20 is 07:50Z on Nov 21
    const late = coros("late-yoga", "2026-11-20T23:50:00", "2026-11-21T07:50:00Z", 25);
    // With only the next day's session (its UTC date's), it answers nothing.
    const alone = makeTestDb();
    const a = await makeTestUser(alone);
    const next = await session(alone, a.userId, "2026-11-21", "2026-11-19T18:00:00Z", { effectiveTime: "07:00" });
    expect((await ingestActivities(alone, { userId: a.userId, sources: [late] })).matchesCreated).toBe(0);
    expect((await rowOf(alone, next)).completionState).toBe("scheduled");
    // With its own day's there too, its own day's.
    const nov21 = await session(db, userId, "2026-11-21", "2026-11-19T18:00:00Z");
    const nov20 = await session(db, userId, "2026-11-20", "2026-11-19T18:00:00Z", { effectiveTime: "23:30" });
    const stats = await ingestActivities(db, { userId, sources: [late] });
    expect(stats.matchesCreated).toBe(1);
    expect((await liveMatches(db))[0]!.workoutId).toBe(nov20);
    expect((await rowOf(db, nov21)).completionState).toBe("scheduled");
    // The matcher's day is the garden's: the same activity, dated by garden-sync.ts `activityDate`.
    expect(activityDate((await activityRow(db, "late-yoga"))!)).toBe("2026-11-20");
  });

  it("a match the owner undid is never redone; the session can still take another activity", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const s = await session(db, userId, "2026-11-20", "2026-11-19T18:00:00Z");
    expect((await ingestActivities(db, { userId, sources: [NOV20_YOGA] })).matchesCreated).toBe(1);
    const post = await laptop(db, userId);
    expect((await post(`/api/plan/workouts/${s}/unmatch`, {})).status).toBe(200);
    // The next sync brings a walk of the same day, which no session here takes: the yoga is a candidate again, and the
    // session it was taken off is open. It is never paired again.
    const walk = await ingestActivities(db, { userId, sources: [coros("walk-1700", "2026-11-20T17:00:00", "2026-11-21T01:00:00Z", 30, "walk")] });
    expect(walk.matchesCreated).toBe(0);
    expect((await activityRow(db, "yoga-1403"))!.completionMatchId).toBeNull();
    expect(await liveMatches(db)).toEqual([]);
    // Another activity of the day can still answer the session.
    await ingestActivities(db, { userId, sources: [coros("stretch-1900", "2026-11-20T19:00:00", "2026-11-21T03:00:00Z", 25)] });
    const live = await liveMatches(db);
    expect(live.map((m) => [m.workoutId, m.activityId])).toEqual([[s, (await activityRow(db, "stretch-1900"))!.id]]);
    expect((await activityRow(db, "yoga-1403"))!.completionMatchId).toBeNull();
  });

  it("a manual match is never overridden by a later sync's guess", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const s = await session(db, userId, "2026-11-20", "2026-11-19T18:00:00Z");
    // The owner matched a walk to it by hand (no guess would: another sport).
    await ingestActivities(db, { userId, sources: [coros("walk", "2026-11-20T09:00:00", "2026-11-20T17:00:00Z", 25, "walk")] });
    const post = await laptop(db, userId);
    expect((await post(`/api/plan/workouts/${s}/match`, { activityId: (await activityRow(db, "walk"))!.id })).status).toBe(200);
    await ingestActivities(db, { userId, sources: [NOV20_YOGA] });
    const live = await liveMatches(db);
    expect(live.map((m) => [m.workoutId, m.method])).toEqual([[s, "manual"]]);
    expect((await activityRow(db, "yoga-1403"))!.completionMatchId).toBeNull();
  });

  it("the write re-checks what may have changed since scoring: archived, moved, skipped, matched or undone since, it writes nothing", async () => {
    /** The yoga synced, a session of its day there before it, read as scoring read it; `change` lands; then the write. */
    const scene = async (change: (db: Db, workoutId: string, activityId: string, now: string) => Promise<unknown>) => {
      const db = makeTestDb();
      const { userId } = await makeTestUser(db);
      await ingestActivities(db, { userId, sources: [NOV20_YOGA] });
      const yoga = (await activityRow(db, "yoga-1403"))!;
      const id = await session(db, userId, "2026-11-20", "2026-11-19T18:00:00Z");
      const scored = await rowOf(db, id);
      const now = nowInstant();
      await change(db, id, yoga.id, now);
      const before = { workout: await rowOf(db, id), matches: await db.select().from(workoutCompletionMatches) };
      const wrote = await commitMatch(db, userId, { workoutId: id, activityId: yoga.id, confidence: 0.8, method: "scored" }, scored, now);
      return { wrote, db, id, yoga, before };
    };
    const refusals: Record<string, Parameters<typeof scene>[0]> = {
      archived: (db, w, _a, now) => db.update(plannedWorkouts).set({ archivedAt: now }).where(eq(plannedWorkouts.id, w)),
      moved: (db, w) => db.update(plannedWorkouts).set({ effectiveDate: "2026-11-21" }).where(eq(plannedWorkouts.id, w)),
      skipped: (db, w) => db.update(plannedWorkouts).set({ completionState: "skipped" }).where(eq(plannedWorkouts.id, w)),
      "matched by hand": async (db, w, _a, now) => {
        await db.insert(workoutCompletionMatches).values({ id: "by-hand", workoutId: w, activityId: "walk", confidence: 1, method: "manual", matchedAt: now });
        await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, w));
      },
      "a match row live on it": (db, w, _a, now) =>
        db.insert(workoutCompletionMatches).values({ id: "live", workoutId: w, activityId: "other", confidence: 1, method: "manual", matchedAt: now }),
      "the activity matched elsewhere": async (db, _w, a, now) => {
        await db.insert(workoutCompletionMatches).values({ id: "elsewhere", workoutId: "elsewhere", activityId: a, confidence: 0.6, method: "scored_auto", matchedAt: now });
        await db.update(activities).set({ completionMatchId: "elsewhere" }).where(eq(activities.id, a));
      },
      "the activity's match undone": (db, _w, a, now) =>
        db.insert(workoutCompletionMatches).values({ id: "undone", workoutId: "elsewhere", activityId: a, confidence: 0.6, method: "scored_auto", matchedAt: now, undoneAt: now }),
    };
    for (const [why, change] of Object.entries(refusals)) {
      const { wrote, db, id, before } = await scene(change);
      expect([why, wrote]).toEqual([why, false]);
      // Nothing was written: the session, the matches and the activity as the change left them.
      expect([why, await rowOf(db, id)]).toEqual([why, before.workout]);
      expect([why, await db.select().from(workoutCompletionMatches)]).toEqual([why, before.matches]);
      expect([why, (await activityRow(db, "yoga-1403"))!.completionMatchId]).toEqual([why, why === "the activity matched elsewhere" ? "elsewhere" : null]);
    }
    // Unchanged (a write elsewhere on the row aside), the same write lands.
    const { wrote, db, id, yoga } = await scene((db, w) => db.update(plannedWorkouts).set({ calendarSyncState: "pending" }).where(eq(plannedWorkouts.id, w)));
    expect(wrote).toBe(true);
    expect((await rowOf(db, id)).completionState).toBe("completed");
    const [m] = await liveMatches(db);
    expect([m!.workoutId, m!.activityId, m!.method]).toEqual([id, yoga.id, "scored_auto"]);
    expect((await activityRow(db, "yoga-1403"))!.completionMatchId).toBe(m!.id);
  });
});
