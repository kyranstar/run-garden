/**
 * Backfill status honesty: "queued" until a bridge actually lands a chunk,
 * a watchdog that stops a never-claimed walk from saying "queued" forever,
 * and read-time derivation so legacy "running, 0 chunks, unclaimed" rows
 * (written before the queued/running split) read as what they are.
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import {
  BACKFILL_UNCLAIMED_ERROR_MS,
  deriveBackfillStatus,
  enqueueBackfill,
  recordChunk,
  sweepStaleBackfills,
} from "../src/services/backfill.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { backfillState, corosWriteJobs } = schema;

async function stateOf(db: Db, userId: string) {
  return (await db.select().from(backfillState).where(eq(backfillState.userId, userId)))[0]!;
}

async function newestBackfillJob(db: Db, userId: string) {
  return (
    await db
      .select()
      .from(corosWriteJobs)
      .where(and(eq(corosWriteJobs.userId, userId), eq(corosWriteJobs.kind, "backfill")))
  )[0]!;
}

/** Age the state's progress clock (updatedAt, plus startedAt) for sweep tests. */
async function ageBackfill(db: Db, userId: string, ms: number): Promise<void> {
  const aged = new Date(Date.now() - ms).toISOString();
  await db
    .update(backfillState)
    .set({ startedAt: aged, updatedAt: aged })
    .where(eq(backfillState.userId, userId));
}

describe("backfill status honesty", () => {
  it("enqueue writes 'queued' — nothing is running until the Mac claims", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const result = await enqueueBackfill(db, userId, "2026-08-10");
    expect(result.enqueued).toBe(true);
    expect((await stateOf(db, userId)).status).toBe("queued");
    expect((await newestBackfillJob(db, userId)).status).toBe("queued");
  });

  it("the first landed chunk flips the state to 'running'", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-10");
    await recordChunk(db, userId, {
      chunkStart: "2026-04-28",
      chunkEnd: "2026-07-26",
      activities: [],
      lapsByProviderId: {},
      skippedSportTypes: {},
    });
    const s = await stateOf(db, userId);
    expect(s.status).toBe("running");
    expect(s.chunksCompleted).toBe(1);
  });

  it("a landed chunk revives a watchdog-errored walk (the Mac woke up late)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-10");
    await db
      .update(backfillState)
      .set({ status: "error", lastErrorCategory: "never_started" })
      .where(eq(backfillState.userId, userId));
    await recordChunk(db, userId, {
      chunkStart: "2026-04-28",
      chunkEnd: "2026-07-26",
      activities: [],
      lapsByProviderId: {},
      skippedSportTypes: {},
    });
    const s = await stateOf(db, userId);
    expect(s.status).toBe("running");
    expect(s.lastErrorCategory).toBeNull();
  });
});

describe("deriveBackfillStatus (read-time honesty for legacy rows)", () => {
  it("legacy 'running' with zero chunks and an unclaimed job reads as queued", () => {
    expect(deriveBackfillStatus({ status: "running", chunksCompleted: 0 }, "queued")).toBe("queued");
  });
  it("running with progress, or with a claimed job, stays running", () => {
    expect(deriveBackfillStatus({ status: "running", chunksCompleted: 3 }, "queued")).toBe("running");
    expect(deriveBackfillStatus({ status: "running", chunksCompleted: 0 }, "claimed")).toBe("running");
  });
  it("absent row is idle; done/error pass through", () => {
    expect(deriveBackfillStatus(undefined, null)).toBe("idle");
    expect(deriveBackfillStatus({ status: "done", chunksCompleted: 9 }, "verified")).toBe("done");
    expect(deriveBackfillStatus({ status: "error", chunksCompleted: 0 }, "queued")).toBe("error");
  });
});

describe("sweepStaleBackfills (cron watchdog)", () => {
  it("leaves a freshly queued walk alone", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-10");
    await ageBackfill(db, userId, BACKFILL_UNCLAIMED_ERROR_MS / 2);
    expect(await sweepStaleBackfills(db, new Date())).toBe(0);
    expect((await stateOf(db, userId)).status).toBe("queued");
  });

  it("flips a long-unclaimed walk to error: never_started", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-10");
    await ageBackfill(db, userId, BACKFILL_UNCLAIMED_ERROR_MS + 60_000);
    expect(await sweepStaleBackfills(db, new Date())).toBe(1);
    const s = await stateOf(db, userId);
    expect(s.status).toBe("error");
    expect(s.lastErrorCategory).toBe("never_started");
    // The job stays queued on purpose: a bridge that finally wakes still
    // claims it, and recordChunk revives the state.
    expect((await newestBackfillJob(db, userId)).status).toBe("queued");
  });

  it("never touches a walk whose job a bridge freshly claimed", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-10");
    await ageBackfill(db, userId, BACKFILL_UNCLAIMED_ERROR_MS + 60_000);
    const job = await newestBackfillJob(db, userId);
    await db
      .update(corosWriteJobs)
      .set({ status: "claimed", claimedAt: new Date().toISOString() })
      .where(eq(corosWriteJobs.id, job.id));
    expect(await sweepStaleBackfills(db, new Date())).toBe(0);
    expect((await stateOf(db, userId)).status).toBe("queued");
  });

  it("a stall past the first chunk flips to stalled", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-10");
    await db
      .update(backfillState)
      .set({ status: "running", chunksCompleted: 3, activitiesIngested: 412 })
      .where(eq(backfillState.userId, userId));
    await ageBackfill(db, userId, BACKFILL_UNCLAIMED_ERROR_MS + 60_000);
    expect(await sweepStaleBackfills(db, new Date())).toBe(1);
    const s = await stateOf(db, userId);
    expect(s.status).toBe("error");
    expect(s.lastErrorCategory).toBe("stalled");
    expect(s.chunksCompleted).toBe(3); // progress is never wiped
  });

  it("a claim whose result never arrived is requeued, then the state flips", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-10");
    await ageBackfill(db, userId, BACKFILL_UNCLAIMED_ERROR_MS + 60_000);
    const job = await newestBackfillJob(db, userId);
    await db
      .update(corosWriteJobs)
      .set({
        status: "claimed",
        claimedAt: new Date(Date.now() - BACKFILL_UNCLAIMED_ERROR_MS).toISOString(),
      })
      .where(eq(corosWriteJobs.id, job.id));
    expect(await sweepStaleBackfills(db, new Date())).toBe(1);
    expect((await stateOf(db, userId)).lastErrorCategory).toBe("never_started");
    // The job is claimable again — a woken bridge resumes without a re-tap.
    expect((await newestBackfillJob(db, userId)).status).toBe("queued");
  });
});

describe("Run again after a watchdog error", () => {
  it("re-arms the errored state onto the still-queued job, keeping progress", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-10");
    await db
      .update(backfillState)
      .set({ status: "error", lastErrorCategory: "stalled", chunksCompleted: 3 })
      .where(eq(backfillState.userId, userId));
    const result = await enqueueBackfill(db, userId, "2026-08-10");
    expect(result).toEqual({ enqueued: true, reason: "rearmed" });
    const s = await stateOf(db, userId);
    expect(s.status).toBe("queued");
    expect(s.lastErrorCategory).toBeNull();
    expect(s.chunksCompleted).toBe(3);
  });

  it("still refuses while a walk is genuinely in flight", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await enqueueBackfill(db, userId, "2026-08-10");
    expect(await enqueueBackfill(db, userId, "2026-08-10")).toEqual({
      enqueued: false,
      reason: "already_running",
    });
  });
});

