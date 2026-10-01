/**
 * The garden after a restore (audit 1 data finding 6; ruling B4 AMENDED).
 *
 * A restore TRUSTS the file's garden tables: state, events, day inputs,
 * checkpoints, plants, unlocks, wildlife and visitors land exactly as they
 * were exported, and nothing rebuilds them. The garden then catches up from
 * the file's `lastSimulatedDate` with a FORWARD-ONLY walk, capped per
 * invocation: each step persists `garden_state` where it stopped and deletes
 * nothing, so a step that dies part-way loses nothing and the timeline,
 * journal and arrival never read as lost or replayed progress.
 *
 * The re-review's rest-mode probe is pinned here: the rebuild from genesis
 * this replaced re-derived every past day from TODAY's preferences, so a
 * restore of an unmodified file silently rewrote the athlete's history
 * (consistent weeks 25 → 16, two species they never earned).
 */
import { describe, expect, it } from "vitest";
import { and, asc, eq, gt } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import {
  advanceGarden,
  buildGardenTimeline,
  ensureGarden,
  recentGardenEvents,
  resimulateFrom,
} from "../src/services/garden-sync.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { loadAccountState } from "../src/services/account-state.js";
import { selectArrival } from "../../../packages/ui/src/screens/arrival.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { exportAll, restoreAll } from "./restore-driver.js";

const STAMP = "2026-01-01T00:00:00Z";

/** Statements one garden step may spend: D1 allows 1,000 per invocation and
 * the hourly cron shares its budget with other work. */
const STEP_BUDGET = 800;

/** D1 refuses every statement past this many in one invocation. */
const INVOCATION_LIMIT = 1000;

function countingDb(): {
  db: Db;
  count: () => number;
  /** One Worker invocation: a fresh count, and D1's limit enforced (the
   * call fails the way D1 fails it). Returns the statements it spent. */
  invocation: (fn: () => Promise<unknown>) => Promise<{ n: number; error: string | null }>;
} {
  let n = 0;
  let limit = Number.POSITIVE_INFINITY;
  const db = makeTestDb({
    boundVariableCap: 100,
    onStatement: () => {
      n += 1;
      if (n > limit) throw new Error("Too many API requests by single worker invocation.");
    },
  });
  return {
    db,
    count: () => {
      const out = n;
      n = 0;
      return out;
    },
    invocation: async (fn) => {
      n = 0;
      limit = INVOCATION_LIMIT;
      try {
        await fn();
        return { n, error: null };
      } catch (e) {
        return { n, error: String(e) };
      } finally {
        limit = Number.POSITIVE_INFINITY;
      }
    },
  };
}

/** A completed planned run with a matched activity; ids derive from the date
 * so two databases seeded alike hold identical rows. */
async function run(db: Db, userId: string, date: string, tag = ""): Promise<void> {
  const workoutId = `w-${date}${tag}`;
  const activityId = `a-${date}${tag}`;
  await db.insert(schema.plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId}`,
    title: "Easy",
    category: "easy",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "completed",
    resolutionDate: date,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
  await db.insert(schema.activities).values({
    id: activityId,
    userId,
    startTime: `${date}T14:30:00Z`,
    startTimeLocal: `${date}T07:30:00`,
    sport: "run",
    durationSeconds: 2400,
    distanceMeters: 8000 + (date.charCodeAt(9) % 7) * 1000,
    completionMatchId: `m-${activityId}`,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
  await db.insert(schema.workoutCompletionMatches).values({
    id: `m-${activityId}`,
    workoutId,
    activityId,
    confidence: 1,
    method: "provider_link",
    matchedAt: STAMP,
  });
}

async function missed(db: Db, userId: string, date: string): Promise<void> {
  const workoutId = `x-${date}`;
  await db.insert(schema.plannedWorkouts).values({
    id: workoutId,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${workoutId}`,
    title: "Tempo",
    category: "tempo",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: "missed",
    resolutionDate: date,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
}

async function lift(db: Db, userId: string, date: string): Promise<void> {
  await db.insert(schema.activities).values({
    id: `s-${date}`,
    userId,
    startTime: `${date}T01:00:00Z`,
    startTimeLocal: `${addDays(date, -1)}T18:00:00`,
    sport: "strength",
    durationSeconds: 1800,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
}

/** 230 days: runs every third day, weekly lifts — and a 50-day injury
 * (days 60–110) of missed runs, sheltered at the time by rest mode. */
async function seedHistory(db: Db, userId: string, genesis: string, days = 230): Promise<void> {
  for (let d = 1; d < days - 1; d += 1) {
    const date = addDays(genesis, d);
    const injured = d >= 60 && d <= 110;
    if (!injured && d % 3 === 0) await run(db, userId, date);
    if (injured && d % 2 === 1) await missed(db, userId, date);
    if (!injured && d % 7 === 2) await lift(db, userId, date);
  }
}

/** Every garden table for the account, in a stable order, every column —
 * except `garden_state.updated_at`, which any read's persist restamps. */
async function gardenDump(db: Db, userId: string) {
  const own = <T extends { userId: string }>(rows: T[]) => rows.filter((r) => r.userId === userId);
  const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const [state] = own(await db.select().from(schema.gardenState));
  return {
    state: state ? (({ updatedAt: _u, ...rest }) => rest)(state) : null,
    events: byId(own(await db.select().from(schema.gardenEvents))),
    inputs: byId(own(await db.select().from(schema.gardenDayInputs))),
    snapshots: byId(own(await db.select().from(schema.gardenSnapshots))),
    // Unlock ids are minted per insert; the species is the row's identity.
    unlocks: own(await db.select().from(schema.gardenUnlocks)).sort((a, b) => a.speciesId.localeCompare(b.speciesId)),
    plants: byId(own(await db.select().from(schema.gardenPlants))),
    wildlife: byId(own(await db.select().from(schema.gardenWildlife))),
    visitors: byId(own(await db.select().from(schema.gardenVisitors))),
  };
}

/** Garden reads until the catch-up has landed; statements per read. */
async function catchUp(db: Db, userId: string, prefs: UserPreferences, count?: () => number, now?: Date): Promise<number[]> {
  const perStep: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    count?.();
    const res = await advanceGarden(db, userId, prefs, now);
    perStep.push(count?.() ?? 0);
    if (!res.resimPending && !(await loadAccountState(db, userId))?.gardenCatchUpPending) return perStep;
  }
  throw new Error(`catch-up did not converge: ${perStep.join(", ")}`);
}

/**
 * The re-review's probe: a garden grown the ordinary way while rest mode
 * sheltered an injury, rest mode turned off afterwards.
 */
async function restModeGarden(db: Db, stopAt?: string) {
  const { userId, prefs: plain } = await makeTestUser(db);
  const today = todayInZone(plain.timezone);
  const genesis = addDays(today, -230);
  await seedHistory(db, userId, genesis);
  await ensureGarden(db, userId, plain, genesis);
  await advanceGarden(db, userId, plain, new Date(`${addDays(genesis, 61)}T20:00:00Z`));
  const resting: UserPreferences = { ...plain, gardenRestMode: true, gardenRestModeUntil: addDays(genesis, 118) };
  await savePreferences(db, userId, resting);
  await advanceGarden(db, userId, resting, new Date(`${addDays(genesis, 121)}T20:00:00Z`));
  const prefs: UserPreferences = { ...resting, gardenRestMode: false, gardenRestModeUntil: null };
  await savePreferences(db, userId, prefs);
  await advanceGarden(db, userId, prefs, stopAt ? new Date(`${stopAt}T20:00:00Z`) : undefined);
  return { userId, prefs, genesis, today };
}

describe("a restore trusts the file's garden (B4 amended)", () => {
  it("restoring an unmodified file leaves the garden exactly as exported, a past rest-mode stretch included", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, prefs } = await restModeGarden(db);
    const before = await gardenDump(db, userId);
    const file = await exportAll(db, userId);

    const out = await restoreAll(db, userId, file);
    expect(out.short).toEqual([]);
    await catchUp(db, userId, prefs);

    const after = await gardenDump(db, userId);
    expect(after.state).toEqual(before.state);
    expect(after.events).toEqual(before.events);
    expect(after.inputs).toEqual(before.inputs);
    expect(after.snapshots).toEqual(before.snapshots);
    expect(after.unlocks).toEqual(before.unlocks);
    expect(after.plants).toEqual(before.plants);
    expect(after.wildlife).toEqual(before.wildlife);
    expect(after.visitors).toEqual(before.visitors);
  }, 120_000);

  it("an old file catches up forward only, in capped steps: the file's rows stay untouched and only new days are appended", async () => {
    const { db, count } = countingDb();
    // An export taken 100 days ago.
    const { userId, prefs, today } = await restModeGarden(db, addDays(todayInZone("America/Los_Angeles"), -100));
    const file = await exportAll(db, userId);
    const fileLast = file.tables.garden_state![0]!.lastSimulatedDate as string;
    expect(fileLast < addDays(today, -95)).toBe(true);
    const fileRows = await gardenDump(db, userId);

    // The reference: the same account walked on to today, uncapped.
    await advanceGarden(db, userId, prefs);
    const reference = await gardenDump(db, userId);

    // Restore the old file and let garden reads catch it up.
    await restoreAll(db, userId, file);
    count();
    const perStep = await catchUp(db, userId, prefs, count);
    expect(perStep.length).toBeGreaterThanOrEqual(3); // ~100 days at ≤ 45 a step
    for (const n of perStep) expect(n).toBeLessThanOrEqual(STEP_BUDGET);

    const after = await gardenDump(db, userId);
    const wallClock = <T extends Record<string, unknown>>(rows: T[]) =>
      rows.map(({ createdAt: _c, updatedAt: _u, ...r }) => r);

    // Every row the file held is still there, byte for byte (timestamps too);
    // everything else is a day after the file's last one.
    const upTo = <T extends { date: string }>(rows: T[]) => rows.filter((r) => r.date <= fileLast);
    expect(upTo(after.events)).toEqual(fileRows.events);
    expect(upTo(after.inputs)).toEqual(fileRows.inputs);
    expect(upTo(after.snapshots)).toEqual(fileRows.snapshots);
    expect(after.events.length).toBeGreaterThan(fileRows.events.length);

    // And the result is the garden an uncapped walk from the file reaches.
    expect(after.state).toEqual(reference.state);
    expect(wallClock(after.events)).toEqual(wallClock(reference.events));
    expect(wallClock(after.inputs)).toEqual(wallClock(reference.inputs));
    expect(wallClock(after.snapshots)).toEqual(wallClock(reference.snapshots));
    expect(after.unlocks.map(({ id: _i, ...u }) => u)).toEqual(reference.unlocks.map(({ id: _i, ...u }) => u));
    expect(after.plants).toEqual(reference.plants);
    expect(after.wildlife).toEqual(reference.wildlife);
  }, 180_000);

  it("finish does no garden work, and a catch-up step that dies part-way loses nothing", async () => {
    let armed = false;
    let n = 0;
    const db = makeTestDb({
      boundVariableCap: 100,
      onStatement: () => {
        if (!armed) return;
        n += 1;
        if (n > 150) throw new Error("Too many API requests by single worker invocation.");
      },
    });
    const { userId, prefs, today } = await restModeGarden(db, addDays(todayInZone("America/Los_Angeles"), -100));
    const file = await exportAll(db, userId);
    const fileRows = await gardenDump(db, userId);
    await restoreAll(db, userId, file);
    expect(await loadAccountState(db, userId)).toMatchObject({ gardenCatchUpPending: true });
    // finish ran no simulation: the garden is the file's.
    expect(await gardenDump(db, userId)).toEqual(fileRows);

    armed = true;
    const died = await advanceGarden(db, userId, prefs).then(
      () => null,
      (e: unknown) => String(e),
    );
    armed = false;
    expect(died).toMatch(/Too many/);
    // The dead invocation could not release its garden lock; it goes stale
    // after a couple of minutes, which the test doesn't wait for.
    await db
      .update(schema.coachLocks)
      .set({ claimedAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(schema.coachLocks.userId, userId));
    // Nothing the file held is gone.
    const mid = await gardenDump(db, userId);
    const fileLast = file.tables.garden_state![0]!.lastSimulatedDate as string;
    expect(mid.events.filter((e) => e.date <= fileLast)).toEqual(fileRows.events);
    expect(mid.inputs.filter((e) => e.date <= fileLast)).toEqual(fileRows.inputs);
    expect(mid.state).toEqual(fileRows.state);

    await catchUp(db, userId, prefs);
    const after = await gardenDump(db, userId);
    expect(after.events.filter((e) => e.date <= fileLast)).toEqual(fileRows.events);
    expect(after.state!.lastSimulatedDate > addDays(today, -3)).toBe(true);
  }, 120_000);

  it("finish stays inside a small statement budget: counts and bookkeeping, no simulation (m6)", async () => {
    const { db, count } = countingDb();
    const { userId } = await restModeGarden(db, addDays(todayInZone("America/Los_Angeles"), -100));
    const file = await exportAll(db, userId);
    let finish = -1;
    await restoreAll(db, userId, file, {
      beforeFinish: async () => {
        count();
      },
    }).then(() => {
      finish = count();
    });
    expect(finish).toBeGreaterThan(0);
    expect(finish).toBeLessThanOrEqual(80);
  }, 120_000);

  it("a restore with no garden in the file leaves no catch-up pending", async () => {
    const db = makeTestDb();
    const { userId } = await makeTestUser(db);
    const done = await restoreAll(db, userId, {
      format: "run-garden-export",
      schemaVersion: "0023",
      exportedAt: STAMP,
      tables: { dismissed_insights: [{ id: "d1", userId: "x", cardId: "c", dismissedAt: STAMP }] },
    });
    expect(done.short).toEqual([]);
    expect((await loadAccountState(db, userId))?.gardenCatchUpPending ?? false).toBe(false);
  });
});

describe("what a read shows after a restore (N4)", () => {
  it("the timeline, the journal and the arrival block read exactly as before the restore", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, prefs, today } = await restModeGarden(db);
    // The athlete has seen everything up to now; no species in the ledger —
    // the worst case for stale ceremonies.
    const [tip] = await recentGardenEvents(db, userId, 1);
    const seenAt = new Date().toISOString();
    await db.insert(schema.gardenSeen).values({
      userId,
      lastSeenDate: tip!.date,
      lastSeenSeq: tip!.seq,
      celebratedSpeciesIds: [],
      updatedAt: seenAt,
    });
    const timelineBefore = await buildGardenTimeline(db, userId);
    const journalBefore = await recentGardenEvents(db, userId, 40);
    const file = await exportAll(db, userId);

    await restoreAll(db, userId, file);
    await catchUp(db, userId, prefs);

    const timeline = await buildGardenTimeline(db, userId);
    expect(timeline.length).toBe(timelineBefore.length);
    expect(timeline.at(-1)).toEqual(timelineBefore.at(-1));
    const journal = await recentGardenEvents(db, userId, 40);
    expect(journal).toEqual(journalBefore);
    const [seen] = await db.select().from(schema.gardenSeen).where(eq(schema.gardenSeen.userId, userId));
    const plan = selectArrival(journal as never, seen as never, today);
    expect(plan.ceremonies).toEqual([]);
  }, 120_000);
});

describe("an ingest running at the same time as a catch-up step (N2/N3)", () => {
  for (const offset of [20, 150] as const) {
    it(`a run landing ${offset} days after genesis ends in the same garden as the two done one after the other`, async () => {
      const setUp = async () => {
        const db = makeTestDb({ boundVariableCap: 100 });
        const old = await restModeGarden(db, addDays(todayInZone("America/Los_Angeles"), -100));
        const file = await exportAll(db, old.userId);
        await restoreAll(db, old.userId, file);
        const late = addDays(old.genesis, offset);
        await run(db, old.userId, late, "-late");
        return { db, ...old, late };
      };
      const strip = <T extends Record<string, unknown>>(rows: T[]) => rows.map(({ createdAt: _c, updatedAt: _u, ...r }) => r);
      const settled = async (db: Db, userId: string) => {
        const d = await gardenDump(db, userId);
        const out = {
          state: d.state,
          events: strip(d.events),
          inputs: strip(d.inputs),
          snapshots: strip(d.snapshots),
          unlocks: d.unlocks.map(({ id: _i, ...u }) => u),
          plants: d.plants,
        };
        // Each run is its own account: compare with the id factored out.
        return JSON.parse(JSON.stringify(out).split(userId).join("u")) as typeof out;
      };

      // Sequential: a catch-up step, then the ingest, then the rest.
      const seq = await setUp();
      await advanceGarden(seq.db, seq.userId, seq.prefs);
      await resimulateFrom(seq.db, seq.userId, seq.late, seq.prefs);
      await catchUp(seq.db, seq.userId, seq.prefs);
      const reference = await settled(seq.db, seq.userId);

      for (const order of ["read-first", "ingest-first"] as const) {
        const c = await setUp();
        const read = () => advanceGarden(c.db, c.userId, c.prefs);
        const ingest = () => resimulateFrom(c.db, c.userId, c.late, c.prefs);
        if (order === "read-first") await Promise.all([read(), ingest()]);
        else await Promise.all([ingest(), read()]);
        await catchUp(c.db, c.userId, c.prefs);
        const got = await settled(c.db, c.userId);
        expect(got.state, order).toEqual(reference.state);
        expect(got.events, order).toEqual(reference.events);
        expect(got.inputs, order).toEqual(reference.inputs);
        expect(got.snapshots, order).toEqual(reference.snapshots);
        expect(got.unlocks, order).toEqual(reference.unlocks);
        expect(got.plants, order).toEqual(reference.plants);
      }
    }, 240_000);
  }
});

describe("a change far behind the catch-up's cursor (NEW-A, ruling B12)", () => {
  const TZ = "America/Los_Angeles";
  /** A 400-day garden (a run every third day), exported 200 days ago. */
  const oldFile = async (db: Db) => {
    const { userId, prefs } = await makeTestUser(db, { timezone: TZ });
    const today = todayInZone(TZ);
    const genesis = addDays(today, -400);
    for (let d = 3; d < 398; d += 3) await run(db, userId, addDays(genesis, d));
    await ensureGarden(db, userId, prefs, genesis);
    await advanceGarden(db, userId, prefs, new Date(`${addDays(today, -200)}T20:00:00Z`));
    const [state] = await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId));
    return { userId, prefs, L: state!.lastSimulatedDate };
  };
  /** The garden with wall-clock columns, minted unlock ids and the account
   * id factored out, so two databases compare. */
  const comparable = async (db: Db, userId: string) => {
    const d = await gardenDump(db, userId);
    const strip = <T extends Record<string, unknown>>(rows: T[]) => rows.map(({ createdAt: _c, updatedAt: _u, ...r }) => r);
    const out = {
      ...d,
      events: strip(d.events),
      inputs: strip(d.inputs),
      snapshots: strip(d.snapshots),
      unlocks: d.unlocks.map(({ id: _i, ...u }) => u),
    };
    return JSON.parse(JSON.stringify(out).split(userId).join("U")) as typeof out;
  };

  // The re-review's wedge: 3 reads (cursor L+135) then a run at L+3; and 1
  // read (cursor L+45) then a change at L−60. Both used to replay uncapped
  // through the cursor, die on D1's budget, and retry the same replay forever.
  for (const { reads, offset } of [
    { reads: 3, offset: 3 },
    { reads: 1, offset: -60 },
  ]) {
    it(`${reads} catch-up read(s), then a run dated L${offset > 0 ? "+" : ""}${offset}: capped steps absorb it and converge on the ordinary garden`, async () => {
      // Reference: the account never restored — the run ingested and
      // resimulated the ordinary way, with no budget.
      const refDb = makeTestDb({ boundVariableCap: 100 });
      const ref = await oldFile(refDb);
      await run(refDb, ref.userId, addDays(ref.L, offset), "-late");
      await resimulateFrom(refDb, ref.userId, addDays(ref.L, offset), ref.prefs);
      await advanceGarden(refDb, ref.userId, ref.prefs);

      const { db, invocation } = countingDb();
      const { userId, prefs, L } = await oldFile(db);
      await restoreAll(db, userId, await exportAll(db, userId));
      const spent: Array<{ at: string; n: number; error: string | null }> = [];
      for (let i = 0; i < reads; i += 1) spent.push({ at: `read ${i + 1}`, ...(await invocation(() => advanceGarden(db, userId, prefs))) });
      const [mid] = await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId));
      expect(mid!.lastSimulatedDate).toBe(addDays(L, 45 * reads));

      // The run arrives (COROS reconnect, a backfill chunk, a manual match).
      const late = addDays(L, offset);
      await run(db, userId, late, "-late");
      spent.push({ at: "resim", ...(await invocation(() => resimulateFrom(db, userId, late, prefs))) });
      // Hourly ticks until the catch-up has landed; a dead invocation's lock
      // is stale by the next one.
      for (let h = 1; h <= 12; h += 1) {
        const account = await loadAccountState(db, userId);
        if (!account?.gardenCatchUpPending && account?.gardenChangedFrom == null) break;
        await db
          .update(schema.coachLocks)
          .set({ claimedAt: new Date(Date.now() - 3_600_000).toISOString() })
          .where(eq(schema.coachLocks.userId, userId));
        spent.push({ at: `hour ${h}`, ...(await invocation(() => advanceGarden(db, userId, prefs))) });
      }

      for (const s of spent) {
        expect(s.error, s.at).toBeNull();
        expect(s.n, s.at).toBeLessThan(STEP_BUDGET);
      }
      const account = await loadAccountState(db, userId);
      expect(account?.gardenCatchUpPending).toBe(false);
      expect(account?.gardenChangedFrom ?? null).toBeNull();
      const got = await comparable(db, userId);
      expect(got.events.some((e) => e.date === late && e.kind === "run_completed" && e.workoutId === `w-${late}-late`)).toBe(true);
      const want = await comparable(refDb, ref.userId);
      expect(got.state).toEqual(want.state);
      expect(got.events).toEqual(want.events);
      expect(got.inputs).toEqual(want.inputs);
      expect(got.snapshots).toEqual(want.snapshots);
      expect(got.unlocks).toEqual(want.unlocks);
      expect(got.plants).toEqual(want.plants);
      expect(got.wildlife).toEqual(want.wildlife);
    }, 240_000);
  }
});

describe("a long resimulation outside a restore is the pre-wave walk", () => {
  it("a change 200 days back lands in the same request, and flags nothing", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, prefs, genesis } = await restModeGarden(db);
    await run(db, userId, addDays(genesis, 25), "-late");
    const res = await resimulateFrom(db, userId, addDays(genesis, 25), prefs);
    expect(res.resimPending).toBeUndefined();
    expect((await loadAccountState(db, userId))?.gardenCatchUpPending ?? false).toBe(false);
    const [state] = await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId));
    const events = await db
      .select()
      .from(schema.gardenEvents)
      .where(and(eq(schema.gardenEvents.userId, userId), gt(schema.gardenEvents.date, addDays(genesis, 25))))
      .orderBy(asc(schema.gardenEvents.date));
    expect(state!.lastSimulatedDate > addDays(todayInZone(prefs.timezone), -3)).toBe(true);
    expect(events.length).toBeGreaterThan(0);

  }, 120_000);
});
