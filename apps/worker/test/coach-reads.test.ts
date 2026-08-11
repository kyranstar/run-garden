import { describe, expect, it } from "vitest";
import { coachReads, coachLocks } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { makeTestDb, makeTestUser } from "./helpers.js";

describe("coach_reads schema", () => {
  it("enforces one read per (user, activity)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const row = {
      id: newId(),
      userId,
      activityId: "act-1",
      status: "queued",
      attempt: 0,
      nextAttemptAt: nowInstant(),
      claimToken: null,
      claimedAt: null,
      glance: null,
      body: null,
      flags: [] as string[],
      model: null,
      createdAt: nowInstant(),
      completedAt: null,
    };
    await db.insert(coachReads).values(row);
    await expect(db.insert(coachReads).values({ ...row, id: newId() })).rejects.toThrow();
  });

  it("coach_locks is one row per (user, kind)", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    await db.insert(coachLocks).values({ userId, kind: "wake", token: "t1", claimedAt: nowInstant() });
    await expect(
      db.insert(coachLocks).values({ userId, kind: "wake", token: "t2", claimedAt: nowInstant() }),
    ).rejects.toThrow();
  });
});
