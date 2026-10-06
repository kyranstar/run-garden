/**
 * Storing a watch session (Phase 2a+ Task 2): `upsertWatchSession` writes the
 * derived session and its sets, idempotent by (user, 'watch', COROS activity);
 * a refresh replaces the sets under the same session id; an activity the app
 * already logged gets no watch session (spec §2.3); a restore in progress
 * stops every write; every statement stays under D1's 100-bind cap.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { upsertWatchSession } from "../src/services/watch-sets.js";
import type { Db } from "../src/services/db.js";
import { D1_BIND_LIMIT, isWrite, makeTestDb, makeTestUser } from "./helpers.js";
import { ACTIVITY, detailOf, item, workView } from "./watch-sets-fixture.js";

async function setup(opts: { cap?: boolean } = {}) {
  const statements: string[] = [];
  const db = makeTestDb({
    ...(opts.cap ? { boundVariableCap: D1_BIND_LIMIT } : {}),
    onStatement: (sql) => statements.push(sql),
  });
  const { userId } = await makeTestUser(db);
  await db.insert(schema.activities).values({
    id: ACTIVITY.activityId,
    userId,
    corosActivityId: ACTIVITY.providerActivityId,
    startTime: ACTIVITY.startTime,
    startTimeLocal: ACTIVITY.startTimeLocal,
    sport: "strength",
    durationSeconds: ACTIVITY.durationSeconds,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return { db, userId, statements };
}

const sessionsOf = (db: Db, userId: string) =>
  db.select().from(schema.performedSessions).where(eq(schema.performedSessions.userId, userId));
const setsOf = async (db: Db, sessionId: string) =>
  (
    await db.select().from(schema.performedSets).where(eq(schema.performedSets.performedSessionId, sessionId))
  ).sort((a, b) => a.entryIndex - b.entryIndex || a.setIndex - b.setIndex);

async function appSession(db: Db, userId: string, source = "app") {
  await db.insert(schema.performedSessions).values({
    id: newId(),
    userId,
    activityId: ACTIVITY.activityId,
    source,
    sourceRef: null,
    localDate: "2026-10-01",
    seconds: 1800,
    completed: true,
    payloadHash: "app-hash",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

describe("upsertWatchSession", () => {
  it("stores the session and one row per set, keyed by the COROS activity", async () => {
    const { db, userId } = await setup();
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()), now: "2026-10-02T09:00:00.000Z" });
    expect(res.status).toBe("written");
    const [s] = await sessionsOf(db, userId);
    expect(s).toMatchObject({ source: "watch", sourceRef: ACTIVITY.providerActivityId, activityId: ACTIVITY.activityId, localDate: "2026-10-01" });
    const sets = await setsOf(db, s!.id);
    expect(sets.map((r) => [r.exerciseId, r.reps, r.seconds, r.loadValue, r.loadUnit])).toEqual([
      ["coros:T1041", 8, null, 50, "lb"],
      ["coros:T1041", 8, null, 50, "lb"],
      ["coros:T1055", 10, null, 12, "kg"],
      ["coros:T1055", 9, null, 12, "kg"],
      ["coros:T1010", null, 45, null, null],
      ["coros:T1004", 15, null, null, null],
    ]);
  });

  it("re-ingesting the same activity writes nothing", async () => {
    const { db, userId, statements } = await setup();
    await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) });
    statements.length = 0;
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) });
    expect(res.status).toBe("unchanged");
    expect(statements.filter(isWrite)).toEqual([]);
    expect(await sessionsOf(db, userId)).toHaveLength(1);
  });

  it("an edit on COROS replaces the sets under the same session id (Review Focus 2)", async () => {
    const { db, userId } = await setup();
    await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()), now: "2026-10-02T09:00:00.000Z" });
    const [before] = await sessionsOf(db, userId);

    // The athlete fixed the bench reps and deleted the push-ups on COROS.
    const edited = workView()
      .filter((i) => i.exerciseNameKey !== "T1004")
      .map((i) => (i.reps === 8 ? { ...i, reps: 6 } : i));
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(edited), now: "2026-10-03T09:00:00.000Z" });
    expect(res.status).toBe("written");

    const after = await sessionsOf(db, userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before!.id);
    expect(after[0]!.createdAt).toBe("2026-10-02T09:00:00.000Z");
    expect(after[0]!.updatedAt).toBe("2026-10-03T09:00:00.000Z");
    expect(after[0]!.payloadHash).not.toBe(before!.payloadHash);
    const sets = await setsOf(db, before!.id);
    expect(sets.map((r) => [r.exerciseId, r.reps])).toEqual([
      ["coros:T1041", 6],
      ["coros:T1041", 6],
      ["coros:T1055", 10],
      ["coros:T1055", 9],
      ["coros:T1010", null],
    ]);
    // No orphan rows from the removed exercise.
    expect(await db.select().from(schema.performedSets)).toHaveLength(5);
  });

  it("a refresh that matched a workout only moves the workout id", async () => {
    const { db, userId, statements } = await setup();
    await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) });
    statements.length = 0;
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()), workoutId: "wo-77" });
    expect(res.status).toBe("written");
    const [s] = await sessionsOf(db, userId);
    expect(s!.workoutId).toBe("wo-77");
    expect(statements.filter(isWrite).every((sql) => /^\s*update\s+"performed_sessions"/i.test(sql))).toBe(true);
  });

  it("a refresh with nothing left to log removes the session", async () => {
    const { db, userId } = await setup();
    await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) });
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf([]) });
    expect(res.status).toBe("removed");
    expect(await sessionsOf(db, userId)).toEqual([]);
    expect(await db.select().from(schema.performedSets)).toEqual([]);
  });

  it("nothing to log and nothing stored writes nothing", async () => {
    const { db, userId, statements } = await setup();
    statements.length = 0;
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: {} });
    expect(res.status).toBe("no_sets");
    expect(statements.filter(isWrite)).toEqual([]);
  });
});

describe("upsertWatchSession — the app's session is the authority (spec §2.3, Review Focus 3)", () => {
  it("creates no watch session for an activity the app already logged", async () => {
    const { db, userId } = await setup();
    await appSession(db, userId, "app");
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) });
    expect(res.status).toBe("app_owned");
    const rows = await sessionsOf(db, userId);
    expect(rows.map((r) => r.source)).toEqual(["app"]);
    expect(await db.select().from(schema.performedSets)).toEqual([]);
  });

  it("a watch review of the same activity is an authority too", async () => {
    const { db, userId } = await setup();
    await appSession(db, userId, "watch_review");
    expect((await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) })).status).toBe("app_owned");
    expect((await sessionsOf(db, userId)).map((r) => r.source)).toEqual(["watch_review"]);
  });

  it("an activity adopted from an app row in this ingest gets no watch session", async () => {
    const { db, userId } = await setup();
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()), adoptedFromApp: true });
    expect(res.status).toBe("app_owned");
    expect(await sessionsOf(db, userId)).toEqual([]);
  });

  it("removes a watch session (and its sets) once the app's session for the activity exists", async () => {
    const { db, userId } = await setup();
    await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) });
    await appSession(db, userId, "app");
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) });
    expect(res.status).toBe("app_owned");
    expect((await sessionsOf(db, userId)).map((r) => r.source)).toEqual(["app"]);
    expect(await db.select().from(schema.performedSets)).toEqual([]);
  });
});

describe("upsertWatchSession — guards", () => {
  it("writes nothing while a restore is replacing the account (ruling B2)", async () => {
    const { db, userId, statements } = await setup();
    await db.insert(schema.accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    statements.length = 0;
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) });
    expect(res.status).toBe("restoring");
    expect(statements.filter(isWrite)).toEqual([]);
  });

  it("a write that dies before its sets land is redone by the next refresh (commit marker)", async () => {
    let failSets = true;
    const db = makeTestDb({
      onStatement: (sql) => {
        if (failSets && /^\s*insert into "performed_sets"/i.test(sql)) {
          failSets = false;
          throw new Error("worker died mid-write");
        }
      },
    });
    const { userId } = await makeTestUser(db);
    await expect(upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) })).rejects.toThrow(
      "worker died mid-write",
    );
    const res = await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(workView()) });
    expect(res.status).toBe("written");
    const [s] = await sessionsOf(db, userId);
    expect(await setsOf(db, s!.id)).toHaveLength(6);
  });

  it("keeps every statement under D1's 100-bind cap, writing and replacing a long session", async () => {
    const { db, userId } = await setup({ cap: true });
    // 12 exercises × 6 sets = 72 sets, each a data item and its rest.
    const long = Array.from({ length: 12 }, (_, ex) =>
      Array.from({ length: 6 }, (_, set) => [
        item({ exerciseIndex: ex, setIndex: set, exerciseNameKey: `T10${10 + ex}`, reps: 10, weight: 20_000, time: 3_000 }),
        item({ exerciseIndex: ex, setIndex: set, exerciseNameKey: `T10${10 + ex}`, time: 6_000 }),
      ]).flat(),
    ).flat();
    await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(long) });
    const [s] = await sessionsOf(db, userId);
    expect(await setsOf(db, s!.id)).toHaveLength(72);
    // Half the exercises deleted on COROS: 36 stale rows go in the same refresh.
    const shorter = long.filter((i) => (i.exerciseIndex as number) < 6).map((i) => (i.reps === 10 ? { ...i, reps: 9 } : i));
    await upsertWatchSession(db, { userId, activity: ACTIVITY, detail: detailOf(shorter) });
    const sets = await setsOf(db, s!.id);
    expect(sets).toHaveLength(36);
    expect(sets.every((r) => r.reps === 9)).toBe(true);
  });
});

describe("upsertWatchSession — the library's reverse COROS mapping (Review Focus 4)", () => {
  const record = (id: string, originId: string, confidence: "exact" | "close" | "generic") =>
    ({ id, providers: { coros: { originId, confidence, method: "curated" } } }) as unknown as ExerciseRecord;

  it("maps a key to the library id through the catalog, for an exact mapping only", async () => {
    const { db, userId } = await setup();
    await db.insert(schema.corosExercises).values([
      { id: "41", name: "T1041", updatedAt: nowInstant() },
      { id: "55", name: "T1055", updatedAt: nowInstant() },
    ]);
    await upsertWatchSession(
      db,
      { userId, activity: ACTIVITY, detail: detailOf(workView()) },
      { library: [record("benchPress", "41", "exact"), record("oneArmRow", "55", "close")] },
    );
    const [s] = await sessionsOf(db, userId);
    const ids = [...new Set((await setsOf(db, s!.id)).map((r) => r.exerciseId))];
    expect(ids).toEqual(["benchPress", "coros:T1055", "coros:T1010", "coros:T1004"]);
  });

  it("keeps the COROS key when two library moves claim the same exercise", async () => {
    const { db, userId } = await setup();
    await db.insert(schema.corosExercises).values([{ id: "41", name: "T1041", updatedAt: nowInstant() }]);
    await upsertWatchSession(
      db,
      { userId, activity: ACTIVITY, detail: detailOf(workView()) },
      { library: [record("benchPress", "41", "exact"), record("floorPress", "41", "exact")] },
    );
    const [s] = await sessionsOf(db, userId);
    expect((await setsOf(db, s!.id))[0]!.exerciseId).toBe("coros:T1041");
  });
});

