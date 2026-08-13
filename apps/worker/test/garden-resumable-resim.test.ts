/**
 * P3d (2026-08-12 production deep audit): a SIMULATION_VERSION bump replays
 * the whole garden history inside ONE request. At ~10-16 D1 subrequests per
 * simulated day that hits Cloudflare's 1,000-subrequest budget once a garden
 * is ~90-100 days old — the rebuild then fails forever.
 *
 * The fix makes the version-upgrade rebuild resumable: each invocation walks
 * at most `maxResimDays` days (UPGRADE_RESIM_MAX_DAYS in prod; a test seam
 * here), writes a durable checkpoint cursor at the exact stop date stamped at
 * the CURRENT SIMULATION_VERSION, and leaves `garden_state` untouched. Reads
 * keep serving the pre-upgrade snapshot; the still-stale stored version
 * re-fires the rebuild on the next advanceGarden call (hourly cron, or any
 * garden read), which resumes from the cursor. Only the final, uncapped walk
 * persists `garden_state`.
 *
 * SIMULATION_VERSION itself cannot be bumped in a test, so the deploy shape
 * is simulated the way garden-resim-crash-safety.test.ts does: stamp the
 * stored snapshot's embedded `version` (what advanceGarden checks) and every
 * durable checkpoint's `simulationVersion` one behind.
 */
import { describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import { SIMULATION_VERSION } from "@rg/garden-engine";
import type { Db } from "../src/services/db.js";
import { advanceGarden, ensureGarden } from "../src/services/garden-sync.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const { gardenDayInputs, gardenEvents, gardenSnapshots, gardenState } = schema;

// Copied from garden-day-input.test.ts's shared literals (repo pattern —
// suites keep their seeding local).
async function insertWorkout(
  db: Db,
  userId: string,
  opts: { date: string; time?: string; state?: string },
): Promise<string> {
  const id = newId();
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id.slice(0, 6)}`,
    title: "Session",
    category: "quality",
    sport: "run",
    originalPlanDate: opts.date,
    lastVerifiedCorosDate: opts.date,
    effectiveDate: opts.date,
    effectiveTime: opts.time ?? "07:00",
    completionState: opts.state ?? "scheduled",
    resolutionDate: opts.state && opts.state !== "scheduled" ? opts.date : null,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  return id;
}

async function matchActivity(
  db: Db,
  userId: string,
  workoutId: string,
  date: string,
  localTime: string,
): Promise<void> {
  const activityId = newId();
  await db.insert(schema.activities).values({
    id: activityId,
    userId,
    startTime: `${date}T${localTime}:00Z`,
    startTimeLocal: `${date}T${localTime}:00`,
    sport: "run",
    durationSeconds: 2400,
    distanceMeters: 8000,
    sourceMergeConfidence: 1,
    completionMatchId: `m-${activityId}`,
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(schema.workoutCompletionMatches).values({
    id: `m-${activityId}`,
    workoutId,
    activityId,
    confidence: 1,
    method: "provider_link",
    matchedAt: nowInstant(),
  });
}

/** Seed a 12-day-old garden with a non-trivial history and build its durable
 * state with a single uncapped walk; return the frozen `now` and baseline. */
async function seedAndBaseline(db: Db) {
  const { userId, prefs } = await makeTestUser(db);
  const genesis = todayInZone(prefs.timezone);
  // Freeze "now" 12 days past genesis so every call sees the same today.
  const now = new Date(`${addDays(genesis, 12)}T12:00:00Z`);
  await ensureGarden(db, userId, prefs, genesis);

  const w1 = await insertWorkout(db, userId, { date: addDays(genesis, 2), state: "completed" });
  await matchActivity(db, userId, w1, addDays(genesis, 2), "07:30");
  const w2 = await insertWorkout(db, userId, { date: addDays(genesis, 5), state: "completed" });
  await matchActivity(db, userId, w2, addDays(genesis, 5), "18:12");

  const seeded = await advanceGarden(db, userId, prefs, now);
  expect(seeded.simulatedDays).toBe(12);
  expect(seeded.resimPending).toBeUndefined();

  const baseline = {
    state: (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!,
    inputs: await db
      .select()
      .from(gardenDayInputs)
      .where(eq(gardenDayInputs.userId, userId))
      .orderBy(asc(gardenDayInputs.date)),
    events: await db
      .select()
      .from(gardenEvents)
      .where(eq(gardenEvents.userId, userId))
      .orderBy(asc(gardenEvents.date), asc(gardenEvents.seq)),
  };
  expect(baseline.inputs.length).toBe(12);
  expect(baseline.events.length).toBeGreaterThan(0);
  return { userId, prefs, genesis, now, baseline };
}

/** The deploy shape: every durable row still carries the previous version. */
async function stampVersionBehind(db: Db, userId: string) {
  const stale = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
  const staleSnapshot = { ...(stale.snapshot as Record<string, unknown>) };
  staleSnapshot.version = (staleSnapshot.version as number) - 1;
  await db
    .update(gardenState)
    .set({ snapshot: staleSnapshot, simulationVersion: stale.simulationVersion - 1 })
    .where(eq(gardenState.userId, userId));
  await db
    .update(gardenSnapshots)
    .set({ simulationVersion: SIMULATION_VERSION - 1 })
    .where(eq(gardenSnapshots.userId, userId));
  return (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
}

describe("resumable version-upgrade resim (P3d)", () => {
  it("a garden older than the cap rebuilds across successive advanceGarden calls and lands byte-identical to a single uncapped run", async () => {
    const db = makeTestDb();
    const { userId, prefs, genesis, now, baseline } = await seedAndBaseline(db);
    const staleRow = await stampVersionBehind(db, userId);

    // Tick 1: capped at 6 of 12 days — partial, resumable.
    const r1 = await advanceGarden(db, userId, prefs, now, { maxResimDays: 6 });
    expect(r1.resimPending).toBe(true);
    expect(r1.simulatedDays).toBe(6);
    expect(r1.lastSimulatedDate).toBe(addDays(genesis, 5));

    // Trust rule: garden_state — what every read renders — is EXACTLY the
    // pre-upgrade row. A half-rebuilt garden is never served as fresh.
    const midRow = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    expect(midRow).toEqual(staleRow);

    // The durable cursor: a checkpoint at the exact stop date, stamped at the
    // current SIMULATION_VERSION (the resume signal the next call reads).
    const cursor = (
      await db
        .select()
        .from(gardenSnapshots)
        .where(eq(gardenSnapshots.userId, userId))
        .then((rows) => rows.filter((r) => r.simulationVersion === SIMULATION_VERSION))
    ).sort((a, b) => a.date.localeCompare(b.date));
    expect(cursor[cursor.length - 1]!.date).toBe(addDays(genesis, 5));

    // Tick 2 (the hourly cron's next advanceGarden): resumes from the cursor,
    // finishes the remaining 6 days, and only now moves garden_state.
    const r2 = await advanceGarden(db, userId, prefs, now, { maxResimDays: 6 });
    expect(r2.resimPending).toBeUndefined();
    expect(r2.simulatedDays).toBe(6);
    expect(r2.lastSimulatedDate).toBe(baseline.state.lastSimulatedDate);

    const finalState = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    expect(finalState.simulationVersion).toBe(SIMULATION_VERSION);
    expect(finalState.snapshot).toEqual(baseline.state.snapshot);
    expect(finalState.lastSimulatedDate).toBe(baseline.state.lastSimulatedDate);

    // Byte-for-byte: the two-tick capped rebuild reproduces the uncapped
    // walk's entire durable output — every day input and every event.
    const finalInputs = await db
      .select()
      .from(gardenDayInputs)
      .where(eq(gardenDayInputs.userId, userId))
      .orderBy(asc(gardenDayInputs.date));
    expect(finalInputs).toEqual(baseline.inputs);
    const finalEvents = await db
      .select()
      .from(gardenEvents)
      .where(eq(gardenEvents.userId, userId))
      .orderBy(asc(gardenEvents.date), asc(gardenEvents.seq));
    expect(finalEvents).toEqual(baseline.events);
  });

  it("a garden under the cap upgrades in a single call, exactly as before", async () => {
    const db = makeTestDb();
    const { userId, prefs, now, baseline } = await seedAndBaseline(db);
    await stampVersionBehind(db, userId);

    // Default cap (45) far exceeds the 12-day history: one call completes.
    const r = await advanceGarden(db, userId, prefs, now);
    expect(r.resimPending).toBeUndefined();
    expect(r.simulatedDays).toBe(12);

    const finalState = (await db.select().from(gardenState).where(eq(gardenState.userId, userId)))[0]!;
    expect(finalState.simulationVersion).toBe(SIMULATION_VERSION);
    expect(finalState.snapshot).toEqual(baseline.state.snapshot);
  });
});
