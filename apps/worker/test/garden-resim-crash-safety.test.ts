/**
 * C21 (audit slice A): `resimulateFrom` used to delete the garden's durable
 * events/day-inputs/checkpoints for the affected range and then persist a
 * genesis/checkpoint snapshot to `garden_state` BEFORE replaying forward —
 * with no transaction (D1's driver here has none). A mid-replay failure
 * (subrequest budget, request timeout, …) left that genesis/checkpoint stub
 * durably in place, stamped at the CURRENT `simulationVersion`, so the
 * rendered garden regressed to "newborn" and, for the version-upgrade path
 * specifically, the next load could never detect it still needed a resim
 * (the stub already looked "current").
 *
 * The fix reorders the write: the day-by-day walk (`walkForward`, extracted
 * out of `advanceGarden`) never touches `garden_state` itself — only the
 * caller does, once the WHOLE walk has succeeded. So a mid-walk throw leaves
 * `garden_state` exactly as it was before the resim attempt.
 *
 * These tests simulate that failure directly (no transaction wrapper exists
 * to fake): they monkey-patch `db.insert` to throw partway through a
 * multi-day resim (the same shape a Workers subrequest-budget death would
 * produce) and assert the durable snapshot is not left at a genesis/
 * checkpoint stub.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone } from "@rg/domain";
import { advanceGarden, resimulateFrom } from "../src/services/garden-sync.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { gardenDayInputs, gardenSnapshots, gardenState } = schema;

/** Throws on the (N+1)th `db.insert(gardenDayInputs)` call — simulating a
 * crash partway through a multi-day replay. Returns a restore function. */
function crashAfterNDayInputInserts(db: ReturnType<typeof makeTestDb>, n: number): () => void {
  let inserts = 0;
  const originalInsert = db.insert.bind(db);
  (db as unknown as { insert: typeof db.insert }).insert = ((table: unknown) => {
    if (table === gardenDayInputs) {
      inserts += 1;
      if (inserts > n) throw new Error("simulated crash mid-replay");
    }
    return (originalInsert as (t: unknown) => unknown)(table);
  }) as typeof db.insert;
  return () => {
    (db as unknown as { insert: typeof db.insert }).insert = originalInsert as typeof db.insert;
  };
}

describe("resimulateFrom — crash safety with no transaction wrapper (C21)", () => {
  it("a mid-walk throw leaves garden_state untouched, and an uninterrupted retry converges to the same state the original walk would have reached", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);

    // Build a legitimate, non-genesis durable garden several days deep. No
    // planned workouts are needed — dayFullyResolved is vacuously true over
    // zero workouts, so every day simulates as a plain rest day (the same
    // no-workout-data shape garden-timeline.test.ts's own seeding uses).
    const advanceTo = new Date(`${addDays(today, 10)}T12:00:00Z`);
    const seeded = await advanceGarden(db, userId, prefs, advanceTo);
    expect(seeded.simulatedDays).toBeGreaterThan(0);

    const before = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;

    // Force resimulateFrom's no-checkpoint (genesis) branch deterministically,
    // regardless of which weekday "today" happens to be during a test run.
    await db.delete(gardenSnapshots).where(eq(gardenSnapshots.userId, userId));
    const affectedDate = addDays(today, 2);

    const restore = crashAfterNDayInputInserts(db, 2);
    await expect(resimulateFrom(db, userId, affectedDate, prefs, advanceTo)).rejects.toThrow(
      "simulated crash mid-replay",
    );

    // The core assertion: garden_state was never overwritten with the
    // genesis stub the old code persisted up front. The rendered garden
    // still shows exactly what it showed before this resim attempt — stale
    // relative to the just-ingested change, but never a false newborn
    // regression.
    const afterCrash = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    expect(afterCrash).toEqual(before);

    // The deletes are intentionally NOT rolled back (no transaction exists to
    // do that) — the affected range's day-inputs are genuinely gone. That's
    // documented as safe because the next successful resim rebuilds them.
    const remaining = await db.select().from(gardenDayInputs).where(eq(gardenDayInputs.userId, userId));
    expect(remaining.some((r) => r.date >= affectedDate)).toBe(false);

    // Self-heal: an uninterrupted retry from the same affected date converges
    // to exactly the state the original, uncrashed walk would have reached.
    restore();
    const retried = await resimulateFrom(db, userId, affectedDate, prefs, advanceTo);
    expect(retried.simulatedDays).toBeGreaterThan(0);

    const finalRow = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    expect(finalRow.lastSimulatedDate).toBe(before.lastSimulatedDate);
    expect(finalRow.snapshot).toEqual(before.snapshot);
  });

  it("a mid-walk throw during the version-upgrade path (advanceGarden's own resimulateFrom trigger) also leaves garden_state untouched", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const today = todayInZone(prefs.timezone);

    const advanceTo = new Date(`${addDays(today, 10)}T12:00:00Z`);
    await advanceGarden(db, userId, prefs, advanceTo);

    // Simulate "a deploy shipped a simulation upgrade": stamp the durably
    // stored snapshot's embedded `version` (what advanceGarden actually
    // checks — `(snapshot.version ?? 1) < SIMULATION_VERSION`) one behind,
    // the same shape an existing account has after a real SIMULATION_VERSION
    // bump ships.
    const stale = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    const staleSnapshot = { ...(stale.snapshot as Record<string, unknown>) };
    staleSnapshot.version = (staleSnapshot.version as number) - 1;
    await db
      .update(gardenState)
      .set({ snapshot: staleSnapshot, simulationVersion: stale.simulationVersion - 1 })
      .where(eq(gardenState.userId, userId));
    const beforeAttempt = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;

    const restore = crashAfterNDayInputInserts(db, 2);
    await expect(advanceGarden(db, userId, prefs, advanceTo)).rejects.toThrow("simulated crash mid-replay");
    restore();

    const afterCrash = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    // Still exactly the stale (pre-attempt) row — in particular still
    // stamped one version behind, not bumped to current — so the NEXT
    // advanceGarden call sees the same "needs resim" signal and retries
    // cleanly instead of finding a genesis stub already at the current
    // version (the bug: that stub could never be detected as "still needs
    // resim" again).
    expect(afterCrash).toEqual(beforeAttempt);
    expect((afterCrash.snapshot as { version: number }).version).toBe(stale.simulationVersion - 1);
  });
});
