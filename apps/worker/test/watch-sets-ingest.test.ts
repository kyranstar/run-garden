/**
 * The COROS activity ingest derives watch sets (Phase 2a+ Task 2): a
 * strength activity whose detail arrived gets a `watch` performed session;
 * no other sport changes; an unchanged activity whose detail arrives again
 * (the deep backfill, a heal) refreshes its sets without dragging its date
 * into the garden's resimulation; the app+watch merge never gets a watch
 * session; a match made in the same ingest reaches the session.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { nowInstant, type SourceActivity } from "@rg/domain";
import { ingestActivities } from "../src/services/completion.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { detailOf, workView } from "./watch-sets-fixture.js";

const START = "2026-10-01T13:00:00Z";

function corosActivity(extra: Partial<SourceActivity> = {}): SourceActivity {
  return {
    provider: "coros",
    providerActivityId: "lbl-strength-9001",
    startTime: START,
    startTimeLocal: "2026-10-01T06:00:00",
    sport: "strength",
    durationSeconds: 2400,
    elapsedSeconds: 2700,
    contentFingerprint: "fp-1",
    telemetry: { avgCadenceSpm: 1 },
    ...extra,
  };
}

const sessionsOf = (db: Db, userId: string) =>
  db.select().from(schema.performedSessions).where(eq(schema.performedSessions.userId, userId));

/** A database whose first statement matching `pattern` throws `message`. */
function failOnce(pattern: RegExp, message: string): Db {
  let armed = true;
  return makeTestDb({
    onStatement: (sql) => {
      if (armed && pattern.test(sql)) {
        armed = false;
        throw new Error(message);
      }
    },
  });
}

/** The planned lift a COROS program link ("prog-77") completes. */
async function liftWorkout(db: Db, userId: string, date: string) {
  await db.insert(schema.plannedWorkouts).values({
    id: "wo-lift",
    userId,
    planId: "p",
    sourceWorkoutId: "4738:lift",
    sourceProgramId: "prog-77",
    title: "Upper",
    category: "strength",
    sport: "strength",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "06:00",
    sourceContentFingerprint: "fp",
    fallbackEstimatedDurationSeconds: 2400,
    calendarBlockDurationSeconds: 2400,
    completionState: "scheduled",
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
}

async function setsOf(db: Db, sessionId: string) {
  return (
    await db.select().from(schema.performedSets).where(eq(schema.performedSets.performedSessionId, sessionId))
  ).sort((a, b) => a.entryIndex - b.entryIndex || a.setIndex - b.setIndex);
}

describe("ingestActivities → watch sets", () => {
  it("logs a strength activity's sets under a watch session for that activity", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await ingestActivities(db, {
      userId,
      sources: [corosActivity()],
      strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(workView()) },
    });
    const [activity] = await db.select().from(schema.activities);
    const sessions = await sessionsOf(db, userId);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      source: "watch",
      sourceRef: "lbl-strength-9001",
      activityId: activity!.id,
      localDate: "2026-10-01",
      seconds: 2400,
    });
    expect((await setsOf(db, sessions[0]!.id)).map((s) => [s.exerciseId, s.reps, s.loadValue, s.loadUnit])).toEqual([
      ["coros:T1041", 8, 50, "lb"],
      ["coros:T1041", 8, 50, "lb"],
      ["coros:T1055", 10, 12, "kg"],
      ["coros:T1055", 9, 12, "kg"],
      ["coros:T1010", null, null, null],
      ["coros:T1004", 15, null, null],
    ]);
  });

  it("changes nothing for an activity that isn't strength, whatever its laps carry", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await ingestActivities(db, {
      userId,
      sources: [
        corosActivity({ providerActivityId: "lbl-run-1", sport: "run", contentFingerprint: "fp-run" }),
        corosActivity({
          providerActivityId: "lbl-yoga-1",
          sport: "yoga",
          startTime: "2026-10-01T18:00:00Z",
          contentFingerprint: "fp-yoga",
        }),
      ],
      strengthDetailsByProviderId: {
        "lbl-run-1": detailOf(workView()),
        "lbl-yoga-1": detailOf(workView()),
      },
    });
    expect(await db.select().from(schema.activities)).toHaveLength(2);
    expect(await sessionsOf(db, userId)).toEqual([]);
  });

  it("a strength activity with no detail this time keeps what it has", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await ingestActivities(db, {
      userId,
      sources: [corosActivity()],
      strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(workView()) },
    });
    // A list-only refresh: new fingerprint, no detail.
    await ingestActivities(db, { userId, sources: [corosActivity({ contentFingerprint: "fp-2" })] });
    const [s] = await sessionsOf(db, userId);
    expect(await setsOf(db, s!.id)).toHaveLength(6);
  });

  it("an unchanged activity whose detail arrives again refreshes its sets, and resimulates nothing", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await ingestActivities(db, { userId, sources: [corosActivity()] });
    expect(await sessionsOf(db, userId)).toEqual([]);

    // The deep backfill (or a heal) brings the detail of an activity already stored, fingerprint unchanged.
    const stats = await ingestActivities(db, {
      userId,
      sources: [corosActivity()],
      strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(workView()) },
    });
    const sessions = await sessionsOf(db, userId);
    expect(sessions).toHaveLength(1);
    expect(await setsOf(db, sessions[0]!.id)).toHaveLength(6);
    expect(stats.affectedDates).toEqual([]);

    // An edit on COROS: same activity, new numbers — same session, new sets.
    const edited = workView().map((i) => (i.reps === 8 ? { ...i, reps: 5 } : i));
    await ingestActivities(db, {
      userId,
      sources: [corosActivity()],
      strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(edited) },
    });
    const again = await sessionsOf(db, userId);
    expect(again.map((s) => s.id)).toEqual([sessions[0]!.id]);
    expect((await setsOf(db, sessions[0]!.id)).slice(0, 2).map((s) => s.reps)).toEqual([5, 5]);
  });

  it("the app+watch merge gets no watch session (spec §2.3, Review Focus 3)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.activities).values({
      id: "app-row",
      userId,
      startTime: "2026-10-01T13:02:00Z",
      sport: "strength",
      durationSeconds: 2350,
      source: "app",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await ingestActivities(db, {
      userId,
      sources: [corosActivity()],
      strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(workView()) },
    });
    const rows = await db.select().from(schema.activities);
    expect(rows.map((r) => [r.id, r.source])).toEqual([["app-row", "coros"]]);
    expect(await sessionsOf(db, userId)).toEqual([]);
  });

  it("a failure writing the sets is logged and passed: the activity lands and its fingerprint is stamped (audit M-13)", async () => {
    const db = failOnce(/^\s*insert into "performed_sets"/i, "D1_ERROR: something odd");
    const { userId } = await makeTestUser(db);
    const stats = await ingestActivities(db, {
      userId,
      sources: [corosActivity()],
      strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(workView()) },
    });
    expect(stats.newActivities).toBe(1);
    expect(stats.affectedDates).toEqual(["2026-10-01"]);
    const [link] = await db.select().from(schema.activitySourceLinks);
    expect(link!.contentFingerprint).toBe("fp-1");
    // What is left is the half-written marker the heal and the backfill look for — and no reader shows.
    expect((await sessionsOf(db, userId)).map((s) => s.payloadHash)).toEqual(["pending"]);
  });

  it("our own runtime ceiling while writing the sets stops the ingest, the fingerprint unstamped (audit M-13)", async () => {
    const db = failOnce(/^\s*insert into "performed_sets"/i, "Error: Too many subrequests.");
    const { userId } = await makeTestUser(db);
    await expect(
      ingestActivities(db, {
        userId,
        sources: [corosActivity()],
        strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(workView()) },
      }),
    ).rejects.toThrow(/Too many subrequests/);
    const [link] = await db.select().from(schema.activitySourceLinks);
    expect(link!.contentFingerprint).toBe("pending"); // so the next read does the whole activity again
  });

  it("a failure naming the workout on the session costs the session its link, never the match or its replay (audit M-2)", async () => {
    const db = failOnce(/^\s*update "performed_sessions" set "workout_id"/i, "D1_ERROR: transient");
    const { userId } = await makeTestUser(db);
    await liftWorkout(db, userId, "2026-09-30"); // the day before: only the match puts its date in the replay
    const stats = await ingestActivities(db, {
      userId,
      sources: [corosActivity({ sourcePlannedWorkoutId: "prog-77" })],
      strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(workView()) },
    });
    expect(stats.matchesCreated).toBe(1);
    expect(stats.affectedDates).toEqual(["2026-09-30", "2026-10-01"]);
    const [wo] = await db.select().from(schema.plannedWorkouts);
    expect(wo!.completionState).toBe("completed");
    const [s] = await sessionsOf(db, userId);
    expect(s).toMatchObject({ source: "watch", workoutId: null });
  });

  it("our own runtime ceiling there still stops the ingest", async () => {
    const db = failOnce(/^\s*update "performed_sessions" set "workout_id"/i, "Error: Too many subrequests.");
    const { userId } = await makeTestUser(db);
    await liftWorkout(db, userId, "2026-10-01");
    await expect(
      ingestActivities(db, {
        userId,
        sources: [corosActivity({ sourcePlannedWorkoutId: "prog-77" })],
        strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(workView()) },
      }),
    ).rejects.toThrow(/Too many subrequests/);
  });

  it("names the workout a match made in the same ingest completed", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(schema.plannedWorkouts).values({
      id: "wo-lift",
      userId,
      planId: "p",
      sourceWorkoutId: "4738:lift",
      sourceProgramId: "prog-77",
      title: "Upper",
      category: "strength",
      sport: "strength",
      originalPlanDate: "2026-10-01",
      lastVerifiedCorosDate: "2026-10-01",
      effectiveDate: "2026-10-01",
      effectiveTime: "06:00",
      sourceContentFingerprint: "fp",
      fallbackEstimatedDurationSeconds: 2400,
      calendarBlockDurationSeconds: 2400,
      completionState: "scheduled",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await ingestActivities(db, {
      userId,
      sources: [corosActivity({ sourcePlannedWorkoutId: "prog-77" })],
      strengthDetailsByProviderId: { "lbl-strength-9001": detailOf(workView()) },
    });
    const [s] = await sessionsOf(db, userId);
    expect(s!.workoutId).toBe("wo-lift");
  });
});
