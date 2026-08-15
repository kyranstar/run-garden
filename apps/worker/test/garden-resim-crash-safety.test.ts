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
import { addDays } from "@rg/domain";
import { SIMULATION_VERSION } from "@rg/garden-engine";
import { advanceGarden, ensureGarden, resimulateFrom } from "../src/services/garden-sync.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { gardenDayInputs, gardenSnapshots, gardenState } = schema;

/**
 * Fixed calendar anchor — nothing here may read the real clock. Both fixtures
 * seed genesis explicitly (`ensureGarden`'s genesisDate) and pass `NOW` to
 * every sim call, so the simulated span, the weekday layout inside it, and
 * therefore which days get `garden_snapshots` checkpoints are identical on
 * every run forever.
 *
 * That is load-bearing, not tidiness: these tests used to anchor on the real
 * `todayInZone(...)`, and the version-upgrade test then passed or failed by
 * weekday. `CHECKPOINT_WEEKDAY` is Monday, so a Friday run's 10-day walk put
 * its newest checkpoint on day 4 and the upgrade rebuild had 6 days left to
 * crash in; a Saturday run's put one on day 10 — the last simulated day — so
 * the rebuild had nothing left to replay, resumed to a no-op, and never
 * reached the injected crash (2026-08-14 green, 2026-08-15 red).
 *
 * GENESIS is deliberately a MONDAY: the walk then always lays checkpoints on
 * GENESIS and GENESIS+7, which is what makes the "stamp every checkpoint one
 * version behind" step below load-bearing (drop it and the upgrade rebuild
 * resumes from a checkpoint that claims to be a finished current-version
 * rebuild, exactly the drift this file regressed on).
 */
const GENESIS = "2026-04-06"; // A Monday; its 10-day span crosses no DST switch.
/** Days the fixture simulates: the walk covers GENESIS … GENESIS+9 (today
 * itself is never simulated), so `NOW` sits 10 days past genesis. */
const SPAN_DAYS = 10;
const NOW = new Date(`${addDays(GENESIS, SPAN_DAYS)}T12:00:00Z`);

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

    // Build a legitimate, non-genesis durable garden several days deep. No
    // planned workouts are needed — dayFullyResolved is vacuously true over
    // zero workouts, so every day simulates as a plain rest day (the same
    // no-workout-data shape garden-timeline.test.ts's own seeding uses).
    await ensureGarden(db, userId, prefs, GENESIS);
    const seeded = await advanceGarden(db, userId, prefs, NOW);
    expect(seeded.simulatedDays).toBe(SPAN_DAYS);

    const before = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;

    // Force resimulateFrom's no-checkpoint (genesis) branch: the walk above
    // laid checkpoints on GENESIS and GENESIS+7, so clear them.
    await db.delete(gardenSnapshots).where(eq(gardenSnapshots.userId, userId));
    const affectedDate = addDays(GENESIS, 2);

    const restore = crashAfterNDayInputInserts(db, 2);
    await expect(resimulateFrom(db, userId, affectedDate, prefs, NOW)).rejects.toThrow(
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
    // It replays SPAN_DAYS - 1 days, not all SPAN_DAYS: the crashed walk got
    // one day past GENESIS before dying, so it left a Monday checkpoint on
    // GENESIS itself, and the retry legitimately restarts from there.
    // (Before this fixture was pinned, WHICH of those two paths the retry
    // took depended on the real weekday — the same hidden calendar coupling
    // that made the version-upgrade test below flip from pass to fail.)
    restore();
    const retried = await resimulateFrom(db, userId, affectedDate, prefs, NOW);
    expect(retried.simulatedDays).toBe(SPAN_DAYS - 1);

    const finalRow = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    expect(finalRow.lastSimulatedDate).toBe(before.lastSimulatedDate);
    expect(finalRow.snapshot).toEqual(before.snapshot);
  });

  it("a mid-walk throw during the version-upgrade path (advanceGarden's own resimulateFrom trigger) also leaves garden_state untouched", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);

    await ensureGarden(db, userId, prefs, GENESIS);
    const seeded = await advanceGarden(db, userId, prefs, NOW);
    expect(seeded.simulatedDays).toBe(SPAN_DAYS);
    const fresh = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;

    // Simulate "a deploy shipped a simulation upgrade". A real bump moves
    // SIMULATION_VERSION under EVERY durable row at once, so rolling the
    // fixture back one version has to cover both places the number lives:
    // the stored snapshot's embedded `version` (what advanceGarden checks —
    // `(snapshot.version ?? 1) < SIMULATION_VERSION`) AND every
    // `garden_snapshots` checkpoint, which is stamped with the version that
    // WROTE it. Leaving the checkpoints stamped current would fake a state no
    // deploy can produce: a finished current-version rebuild sitting next to
    // a pre-upgrade garden_state. That is the legitimate mid-upgrade shape
    // P3d's resumable rebuild resumes from (partial rebuilds keep reads on
    // the old snapshot while current-version checkpoints accumulate), so
    // upgradeResimulate would rightly skip the replay this test needs. Same
    // stamping the sibling suite (garden-resumable-resim.test.ts) uses.
    const staleSnapshot = { ...(fresh.snapshot as Record<string, unknown>) };
    staleSnapshot.version = (staleSnapshot.version as number) - 1;
    await db
      .update(gardenState)
      .set({ snapshot: staleSnapshot, simulationVersion: fresh.simulationVersion - 1 })
      .where(eq(gardenState.userId, userId));
    await db
      .update(gardenSnapshots)
      .set({ simulationVersion: SIMULATION_VERSION - 1 })
      .where(eq(gardenSnapshots.userId, userId));
    const checkpoints = await db
      .select()
      .from(gardenSnapshots)
      .where(eq(gardenSnapshots.userId, userId));
    // The deploy shape, asserted: checkpoints exist (so the rebuild really
    // could have resumed) but none of them is current-version.
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.filter((c) => c.simulationVersion === SIMULATION_VERSION)).toEqual([]);

    const beforeAttempt = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;

    const restore = crashAfterNDayInputInserts(db, 2);
    await expect(advanceGarden(db, userId, prefs, NOW)).rejects.toThrow("simulated crash mid-replay");
    restore();

    const afterCrash = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    // Still exactly the stale (pre-attempt) row — in particular still
    // stamped one version behind, not bumped to current — so the NEXT
    // advanceGarden call sees the same "needs resim" signal and retries
    // cleanly instead of finding a genesis stub already at the current
    // version (the bug: that stub could never be detected as "still needs
    // resim" again).
    expect(afterCrash).toEqual(beforeAttempt);
    expect((afterCrash.snapshot as { version: number }).version).toBe(SIMULATION_VERSION - 1);

    // …and the retry converges. The crashed attempt got one day past GENESIS
    // before dying, so it left a single legitimate current-version cursor
    // (the Monday checkpoint on GENESIS itself); the rebuild resumes from
    // there — SPAN_DAYS - 1 days — and only on reaching today does
    // garden_state move, landing byte-identical to the pre-upgrade fold.
    const retried = await advanceGarden(db, userId, prefs, NOW);
    expect(retried.resimPending).toBeUndefined();
    expect(retried.simulatedDays).toBe(SPAN_DAYS - 1);

    const healed = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    expect(healed.simulationVersion).toBe(SIMULATION_VERSION);
    expect((healed.snapshot as { version: number }).version).toBe(SIMULATION_VERSION);
    expect(healed.lastSimulatedDate).toBe(fresh.lastSimulatedDate);
    expect(healed.snapshot).toEqual(fresh.snapshot);
  });
});
