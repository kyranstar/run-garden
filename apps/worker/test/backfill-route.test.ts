import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { advanceBackfill, enqueueBackfill, recordChunk } from "../src/services/backfill.js";

describe("backfill orchestration", () => {
  it("enqueues a backfill job whose first chunk sits behind the rolling window", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);

    const result = await enqueueBackfill(db, userId, "2026-08-04");

    expect(result.enqueued).toBe(true);
    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.userId, userId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe("backfill");
    expect(jobs[0]!.destinationDate).toBe("2026-07-21");
    expect(jobs[0]!.originalDate).toBe("2026-04-23");
    // workoutId self-references the job row, per the read_now/studio precedent.
    expect(jobs[0]!.workoutId).toBe(jobs[0]!.id);
  });

  it("refuses a second backfill while one is in flight", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);

    await enqueueBackfill(db, userId, "2026-08-04");
    const second = await enqueueBackfill(db, userId, "2026-08-04");

    expect(second.enqueued).toBe(false);
    expect(second.reason).toBe("already_running");
  });

  it("ingests a chunk's activities and advances the checkpoint", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-04");

    await recordChunk(db, userId, {
      chunkStart: "2026-04-23",
      chunkEnd: "2026-07-21",
      activities: [
        {
          provider: "coros",
          providerActivityId: "yoga-1",
          startTime: "2026-05-01T07:00:00Z",
          startTimeLocal: "2026-05-01T07:00:00",
          sport: "yoga",
          durationSeconds: 2700,
          contentFingerprint: "fp-yoga-1",
        },
      ],
      lapsByProviderId: {},
      skippedSportTypes: { "200": 3 },
    });

    const rows = await db
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sport).toBe("yoga");

    const state = (
      await db.select().from(schema.backfillState).where(eq(schema.backfillState.userId, userId))
    )[0]!;
    expect(state.earliestDateReached).toBe("2026-04-23");
    expect(state.activitiesIngested).toBe(1);
    expect(state.chunksCompleted).toBe(1);
    expect(state.skippedSportTypes).toEqual({ "200": 3 });
  });

  it("queues the next older chunk after a productive one", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-04");
    const job = (
      await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, userId))
    )[0]!;

    await recordChunk(db, userId, {
      chunkStart: "2026-04-23",
      chunkEnd: "2026-07-21",
      activities: [],
      lapsByProviderId: {},
      skippedSportTypes: {},
    });
    await advanceBackfill(db, userId, job.id, { activitiesFound: 4 }, "2026-08-04");

    const jobs = await db
      .select()
      .from(schema.corosWriteJobs)
      .where(eq(schema.corosWriteJobs.userId, userId));
    const queued = jobs.filter((j) => j.status === "queued" && j.id !== job.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.destinationDate).toBe("2026-04-22");
  });

  it("marks the backfill done after two consecutive empty chunks", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-04");
    const job = (
      await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, userId))
    )[0]!;

    await recordChunk(db, userId, {
      chunkStart: "2026-04-23",
      chunkEnd: "2026-07-21",
      activities: [],
      lapsByProviderId: {},
      skippedSportTypes: {},
    });
    await advanceBackfill(db, userId, job.id, { activitiesFound: 0 }, "2026-08-04");

    const next = (
      await db
        .select()
        .from(schema.corosWriteJobs)
        .where(eq(schema.corosWriteJobs.status, "queued"))
    ).filter((j) => j.id !== job.id)[0]!;
    await recordChunk(db, userId, {
      chunkStart: next.originalDate,
      chunkEnd: next.destinationDate,
      activities: [],
      lapsByProviderId: {},
      skippedSportTypes: {},
    });
    await advanceBackfill(db, userId, next.id, { activitiesFound: 0 }, "2026-08-04");

    const state = (
      await db.select().from(schema.backfillState).where(eq(schema.backfillState.userId, userId))
    )[0]!;
    expect(state.status).toBe("done");
  });
});
