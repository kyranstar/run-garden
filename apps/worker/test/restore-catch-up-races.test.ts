/**
 * The post-restore garden catch-up under the second re-review (rulings
 * B4 AMENDED-2 and B11).
 *
 * NEW-1: rows dated after `garden_state.lastSimulatedDate` belong to no world
 * the catch-up trusts — a catch-up step that died after writing some days, or
 * a walk of the account being replaced that landed after begin's wipe. They
 * used to survive (events and checkpoints are insert-or-ignore), so the next
 * walk's rows for those keys were dropped and a later resimulation restarted
 * from a stale checkpoint. Each step now deletes them first.
 *
 * NEW-2: a resimulation that finds the garden lock held used to wait up to
 * 75 s — past the client's 30 s timeout and `waitUntil`'s — and a change at
 * or before the cursor could then be lost for good. It now records the
 * earliest changed date and returns; the next step walks from it (B12).
 *
 * NEW-B: a change on record outlived begin, finish and Start fresh, so a
 * second restore's first step re-derived the file's history from it. Begin
 * and Start fresh now clear it, and nothing is recorded under the marker.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, isoWeekday, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import type { Env } from "../src/env.js";
import { advanceGarden, ensureGarden, resimulateFrom } from "../src/services/garden-sync.js";
import { loadAccountState } from "../src/services/account-state.js";
import { claimUserLock } from "../src/services/locks.js";
import { planRoutes } from "../src/routes/plan.js";
import { coachRoutes } from "../src/routes/coach.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { beginRestore, startFresh } from "../src/services/account-restore.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { checkFile, exportAll, restoreAll, TEST_SECRET } from "./restore-driver.js";

const STAMP = "2026-01-01T00:00:00Z";
const TZ = "America/Los_Angeles";
const TODAY = todayInZone(TZ);

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

async function seed(db: Db, userId: string, genesis: string, from: number, to: number): Promise<void> {
  for (let d = from; d < to; d += 1) if (d % 3 === 0) await run(db, userId, addDays(genesis, d));
}

const strip = <T extends Record<string, unknown>>(rows: T[]) => rows.map(({ createdAt: _c, updatedAt: _u, ...r }) => r);

/** The whole garden, wall-clock columns and minted ids out, the account id
 * factored out — so two databases can be compared. */
async function garden(db: Db, userId: string) {
  const own = <T extends { userId: string }>(rows: T[]) => rows.filter((r) => r.userId === userId);
  const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const [state] = own(await db.select().from(schema.gardenState));
  const out = {
    state: state ? (({ updatedAt: _u, ...rest }) => rest)(state) : null,
    events: strip(byId(own(await db.select().from(schema.gardenEvents)))),
    inputs: strip(byId(own(await db.select().from(schema.gardenDayInputs)))),
    snapshots: strip(byId(own(await db.select().from(schema.gardenSnapshots)))),
    unlocks: own(await db.select().from(schema.gardenUnlocks))
      .map(({ id: _i, ...u }) => u)
      .sort((a, b) => a.speciesId.localeCompare(b.speciesId)),
    plants: byId(own(await db.select().from(schema.gardenPlants))),
  };
  return JSON.parse(JSON.stringify(out).split(userId).join("U")) as typeof out;
}

async function catchUp(db: Db, userId: string, prefs: UserPreferences): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    const res = await advanceGarden(db, userId, prefs);
    if (!res.resimPending && !(await loadAccountState(db, userId))?.gardenCatchUpPending) return;
  }
  throw new Error("catch-up did not converge");
}

/** The Tuesday after the first Monday after `date`. */
function dayAfterNextMonday(date: string): string {
  let monday = addDays(date, 1);
  while (isoWeekday(monday) !== 1) monday = addDays(monday, 1);
  return addDays(monday, 1);
}

describe("NEW-1: rows past the catch-up's cursor are no world's (B4 amended-2)", () => {
  it("a step that died part-way, then an input change past the cursor: the same garden as with no death", async () => {
    const build = async (die: boolean) => {
      let armed = false;
      let n = 0;
      const db = makeTestDb({
        boundVariableCap: 100,
        onStatement: () => {
          if (!armed) return;
          n += 1;
          if (n > 400) throw new Error("Too many API requests by single worker invocation.");
        },
      });
      const { userId, prefs } = await makeTestUser(db, { timezone: TZ });
      const genesis = addDays(TODAY, -230);
      await seed(db, userId, genesis, 1, 228);
      await ensureGarden(db, userId, prefs, genesis);
      await advanceGarden(db, userId, prefs, new Date(`${addDays(TODAY, -100)}T20:00:00Z`));
      const file = await exportAll(db, userId);
      const L = file.tables.garden_state![0]!.lastSimulatedDate as string;
      await restoreAll(db, userId, file);
      if (die) {
        armed = true;
        const err = await advanceGarden(db, userId, prefs).then(
          () => null,
          (e: unknown) => String(e),
        );
        armed = false;
        expect(err).toMatch(/Too many/);
        // The dead invocation's lock goes stale; the test does not wait.
        await db
          .update(schema.coachLocks)
          .set({ claimedAt: new Date(Date.now() - 3_600_000).toISOString() })
          .where(eq(schema.coachLocks.userId, userId));
      }
      // A run lands on a day the dead step walked.
      const late = addDays(L, 10);
      await run(db, userId, late, "-late");
      await resimulateFrom(db, userId, late, prefs);
      await catchUp(db, userId, prefs);
      return { db, userId, prefs, late };
    };
    const dead = await build(true);
    const ref = await build(false);
    expect(await garden(dead.db, dead.userId)).toEqual(await garden(ref.db, ref.userId));

    // A later change restarts from a checkpoint the dead step may have written.
    const later = dayAfterNextMonday(dead.late);
    for (const w of [dead, ref]) {
      await run(w.db, w.userId, later, "-later");
      await resimulateFrom(w.db, w.userId, later, w.prefs);
      await catchUp(w.db, w.userId, w.prefs);
    }
    expect(await garden(dead.db, dead.userId)).toEqual(await garden(ref.db, ref.userId));
  }, 300_000);

  for (const walkDays of [1, 7]) {
    it(`begin fired while a ${walkDays}-day walk of the replaced account ran: its rows never become the garden`, async () => {
      const build = async (stale: boolean) => {
        const db = makeTestDb({ boundVariableCap: 100 });
        const { userId, prefs } = await makeTestUser(db, { timezone: TZ });
        const genesis = addDays(TODAY, -230);
        await seed(db, userId, genesis, 1, 130);
        await ensureGarden(db, userId, prefs, genesis);
        await advanceGarden(db, userId, prefs, new Date(`${addDays(TODAY, -100)}T20:00:00Z`));
        const file = await exportAll(db, userId);
        // The replaced account trained on after that export; its last walk
        // covered the days just before begin.
        await seed(db, userId, genesis, 130, 228);
        await advanceGarden(db, userId, prefs);
        const to = addDays(TODAY, -2);
        const from = addDays(to, -(walkDays - 1));
        const inRange = <T extends { date: string }>(rows: T[]) => rows.filter((r) => r.date >= from && r.date <= to);
        const ev = inRange(await db.select().from(schema.gardenEvents).where(eq(schema.gardenEvents.userId, userId)));
        const inp = inRange(await db.select().from(schema.gardenDayInputs).where(eq(schema.gardenDayInputs.userId, userId)));
        const snp = inRange(await db.select().from(schema.gardenSnapshots).where(eq(schema.gardenSnapshots.userId, userId)));
        const unl = (await db.select().from(schema.gardenUnlocks).where(eq(schema.gardenUnlocks.userId, userId))).filter(
          (u) => u.unlockedOn >= from && u.unlockedOn <= to,
        );
        await restoreAll(db, userId, file, {
          // What that walk writes after begin's wipe (a walk under 8 days
          // never reaches its marker check).
          beforeRows: async () => {
            if (!stale) return;
            for (const r of ev) await db.insert(schema.gardenEvents).values(r);
            for (const r of inp) await db.insert(schema.gardenDayInputs).values(r);
            for (const r of snp) await db.insert(schema.gardenSnapshots).values(r);
            for (const r of unl) await db.insert(schema.gardenUnlocks).values(r);
          },
        });
        await catchUp(db, userId, prefs);
        return { db, userId, prefs, landed: ev.length + inp.length };
      };
      const stale = await build(true);
      const ref = await build(false);
      expect(stale.landed).toBeGreaterThan(0);
      expect(await garden(stale.db, stale.userId)).toEqual(await garden(ref.db, ref.userId));

      const later = dayAfterNextMonday(addDays(TODAY, -2 - walkDays));
      for (const w of [stale, ref]) {
        await run(w.db, w.userId, later, "-later");
        await resimulateFrom(w.db, w.userId, later, w.prefs);
        await catchUp(w.db, w.userId, w.prefs);
      }
      expect(await garden(stale.db, stale.userId)).toEqual(await garden(ref.db, ref.userId));
    }, 300_000);
  }
});

// ── NEW-2 ───────────────────────────────────────────────────────────────────

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "0",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: "k",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

async function planned(db: Db, userId: string, id: string, date: string, state = "scheduled"): Promise<void> {
  await db.insert(schema.plannedWorkouts).values({
    id,
    userId,
    planId: "p",
    sourceWorkoutId: `4738:${id}`,
    title: "Tempo",
    category: "tempo",
    sport: "run",
    originalPlanDate: date,
    lastVerifiedCorosDate: date,
    effectiveDate: date,
    effectiveTime: "07:00",
    completionState: state,
    resolutionDate: state === "missed" ? date : null,
    sourceContentFingerprint: "fp",
    calendarBlockDurationSeconds: 3600,
    createdAt: STAMP,
    updatedAt: STAMP,
  });
}

describe("NEW-2: a resimulation never waits on the garden lock (B11)", () => {
  it("approve, skip and match return at once while a step holds the lock; every change lands after the next step", async () => {
    const build = async (held: boolean) => {
      const db = makeTestDb({ boundVariableCap: 100 });
      const { userId, prefs } = await makeTestUser(db, { timezone: TZ });
      const genesis = addDays(TODAY, -160);
      await seed(db, userId, genesis, 1, 158);
      await ensureGarden(db, userId, prefs, genesis);
      await advanceGarden(db, userId, prefs, new Date(`${addDays(TODAY, -100)}T20:00:00Z`));
      const L = (await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId)))[0]!
        .lastSimulatedDate;
      // A session missed before the cursor, whose run turns up now (match);
      // today's sessions for a skip and a coach skip (approve).
      const matchDay = addDays(L, -12);
      await planned(db, userId, "w-match", matchDay, "missed");
      await db.insert(schema.activities).values({
        id: "a-match",
        userId,
        startTime: `${matchDay}T14:30:00Z`,
        startTimeLocal: `${matchDay}T07:30:00`,
        sport: "run",
        durationSeconds: 2400,
        distanceMeters: 9000,
        createdAt: STAMP,
        updatedAt: STAMP,
      });
      await planned(db, userId, "w-skip", TODAY);
      await planned(db, userId, "w-approve", TODAY);
      await db.insert(schema.coachProposals).values({
        id: "p-skip",
        userId,
        title: "Rest today",
        evidence: "e",
        rationale: "r",
        flags: [],
        ops: [{ kind: "skip", workoutId: "w-approve", reason: "tired" }],
        status: "pending",
        createdAt: nowInstant(),
        expiresAt: TODAY,
      });
      const file = await exportAll(db, userId);
      await restoreAll(db, userId, file);
      expect((await loadAccountState(db, userId))?.gardenCatchUpPending).toBe(true);

      // A catch-up step (a garden read, the cron) is walking right now.
      if (held) expect(await claimUserLock(db, userId, "garden", 1)).not.toBeNull();
      const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "t")}`;
      const call = async (routes: typeof planRoutes, base: string, path: string, body?: unknown) => {
        const t0 = Date.now();
        const res = await mountRoutes(db, base, routes).request(
          path,
          {
            method: "POST",
            headers: { Cookie: cookie, "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          },
          makeEnv(),
        );
        return { status: res.status, ms: Date.now() - t0 };
      };
      const calls = [
        await call(planRoutes, "/api/plan", "/api/plan/workouts/w-match/match", { activityId: "a-match" }),
        await call(planRoutes, "/api/plan", "/api/plan/workouts/w-skip/skip"),
        await call(coachRoutes as never, "/api/coach", "/api/coach/proposals/p-skip/approve"),
      ];
      if (held) {
        // The earliest change is recorded for the step that holds the lock.
        expect((await loadAccountState(db, userId))?.gardenChangedFrom).toBe(matchDay);
        // That step finishes and lets go.
        await db.delete(schema.coachLocks).where(eq(schema.coachLocks.userId, userId));
      }
      await catchUp(db, userId, prefs);
      return { db, userId, calls, matchDay, L };
    };
    const contended = await build(true);
    for (const c of contended.calls) {
      expect(c.status).toBe(200);
      expect(c.ms).toBeLessThan(10_000);
    }
    expect(contended.matchDay <= contended.L).toBe(true);
    const ref = await build(false);
    const got = await garden(contended.db, contended.userId);
    expect(got).toEqual(await garden(ref.db, ref.userId));
    // The matched run is in the garden (the change at the cursor's past was not lost).
    expect(got.events.some((e) => e.date === contended.matchDay && e.kind === "run_completed")).toBe(true);
    expect((await loadAccountState(contended.db, contended.userId))?.gardenChangedFrom ?? null).toBeNull();
  }, 300_000);

  it("a change recorded while the lock is held is replayed by the next step, even at or before the cursor", async () => {
    const build = async (held: boolean) => {
      const db = makeTestDb({ boundVariableCap: 100 });
      const { userId, prefs } = await makeTestUser(db, { timezone: TZ });
      const genesis = addDays(TODAY, -160);
      await seed(db, userId, genesis, 1, 158);
      await ensureGarden(db, userId, prefs, genesis);
      await advanceGarden(db, userId, prefs, new Date(`${addDays(TODAY, -100)}T20:00:00Z`));
      const file = await exportAll(db, userId);
      const L = file.tables.garden_state![0]!.lastSimulatedDate as string;
      await restoreAll(db, userId, file);
      await advanceGarden(db, userId, prefs); // one step: the cursor moves past L
      const cursor = (await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId)))[0]!
        .lastSimulatedDate;
      const lock = held ? await claimUserLock(db, userId, "garden", 1) : null;
      const early = addDays(L, -20); // before the file's last day, and the cursor
      await run(db, userId, early, "-late");
      const t0 = Date.now();
      const res = await resimulateFrom(db, userId, early, prefs);
      const ms = Date.now() - t0;
      if (held) {
        expect(ms).toBeLessThan(5_000);
        expect(res.resimPending).toBe(true);
        expect((await loadAccountState(db, userId))?.gardenChangedFrom).toBe(early);
        void lock;
        await db.delete(schema.coachLocks).where(eq(schema.coachLocks.userId, userId));
      }
      await catchUp(db, userId, prefs);
      return { db, userId, early, cursor };
    };
    const a = await build(true);
    const b = await build(false);
    expect(a.early < a.cursor).toBe(true);
    expect(await garden(a.db, a.userId)).toEqual(await garden(b.db, b.userId));
    void newId;
  }, 300_000);

  it("a step that dies part-way leaves its change on record for the next step", async () => {
    const build = async (die: boolean) => {
      let armed = false;
      let n = 0;
      const db = makeTestDb({
        boundVariableCap: 100,
        onStatement: () => {
          if (!armed) return;
          n += 1;
          if (n > 120) throw new Error("Too many API requests by single worker invocation.");
        },
      });
      const { userId, prefs } = await makeTestUser(db, { timezone: TZ });
      const genesis = addDays(TODAY, -160);
      await seed(db, userId, genesis, 1, 158);
      await ensureGarden(db, userId, prefs, genesis);
      await advanceGarden(db, userId, prefs, new Date(`${addDays(TODAY, -100)}T20:00:00Z`));
      const file = await exportAll(db, userId);
      const L = file.tables.garden_state![0]!.lastSimulatedDate as string;
      await restoreAll(db, userId, file);
      const early = addDays(L, -40);
      await run(db, userId, early, "-late");
      armed = die;
      const err = await resimulateFrom(db, userId, early, prefs).then(
        () => null,
        (e: unknown) => String(e),
      );
      armed = false;
      if (die) {
        expect(err).toMatch(/Too many/);
        expect((await loadAccountState(db, userId))?.gardenChangedFrom).toBe(early);
        await db
          .update(schema.coachLocks)
          .set({ claimedAt: new Date(Date.now() - 3_600_000).toISOString() })
          .where(eq(schema.coachLocks.userId, userId));
      }
      await catchUp(db, userId, prefs);
      return { db, userId };
    };
    const dead = await build(true);
    const ref = await build(false);
    expect(await garden(dead.db, dead.userId)).toEqual(await garden(ref.db, ref.userId));
  }, 300_000);
});

// ── NEW-B ───────────────────────────────────────────────────────────────────

describe("NEW-B: a restore starts with no garden change on record (B12)", () => {
  /** A 230-day garden exported 100 days ago, restored once. */
  const restoredOnce = async (db: Db) => {
    const { userId, prefs } = await makeTestUser(db, { timezone: TZ });
    const genesis = addDays(TODAY, -230);
    await seed(db, userId, genesis, 1, 228);
    await ensureGarden(db, userId, prefs, genesis);
    await advanceGarden(db, userId, prefs, new Date(`${addDays(TODAY, -100)}T20:00:00Z`));
    const file = await exportAll(db, userId);
    await restoreAll(db, userId, file);
    return { userId, prefs, genesis, file, L: file.tables.garden_state![0]!.lastSimulatedDate as string };
  };
  /** The garden rows as stored, every column but `garden_state.updated_at`. */
  const rows = async (db: Db, userId: string) => {
    const own = <T extends { userId: string }>(r: T[]) => r.filter((x) => x.userId === userId);
    const byId = <T extends { id: string }>(r: T[]) => [...r].sort((a, b) => (a.id < b.id ? -1 : 1));
    const [state] = own(await db.select().from(schema.gardenState));
    return {
      state: state ? (({ updatedAt: _u, ...rest }) => rest)(state) : null,
      events: byId(own(await db.select().from(schema.gardenEvents))),
      inputs: byId(own(await db.select().from(schema.gardenDayInputs))),
      snapshots: byId(own(await db.select().from(schema.gardenSnapshots))),
      unlocks: own(await db.select().from(schema.gardenUnlocks)).sort((a, b) => a.speciesId.localeCompare(b.speciesId)),
    };
  };
  const sqlite = (db: Db) => (db as unknown as { $client: { exec: (s: string) => void } }).$client;

  it("a change recorded before a second restore never moves the file's history: its first step walks forward from the file", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, prefs, genesis, file, L } = await restoredOnce(db);
    // A step is walking (lock held) when a change to an old day lands: recorded.
    expect(await claimUserLock(db, userId, "garden", 1)).not.toBeNull();
    await run(db, userId, addDays(genesis, 40), "-old");
    await resimulateFrom(db, userId, addDays(genesis, 40), prefs);
    expect((await loadAccountState(db, userId))?.gardenChangedFrom).toBe(addDays(genesis, 40));
    await db.delete(schema.coachLocks).where(eq(schema.coachLocks.userId, userId));

    // The athlete restores the same file again (the garden looked stuck).
    await restoreAll(db, userId, file);
    expect((await loadAccountState(db, userId))?.gardenChangedFrom ?? null).toBeNull();
    const fileRows = await rows(db, userId); // finish simulates nothing
    await advanceGarden(db, userId, prefs);
    const after = await rows(db, userId);
    expect(after.state!.lastSimulatedDate).toBe(addDays(L, 45));
    const upTo = <T extends { date: string }>(r: T[]) => r.filter((x) => x.date <= L);
    expect(upTo(after.events)).toEqual(fileRows.events);
    expect(upTo(after.inputs)).toEqual(fileRows.inputs);
    expect(upTo(after.snapshots)).toEqual(fileRows.snapshots);
  }, 120_000);

  it("begin clears a change on record, and so does Start fresh", async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId, file } = await restoredOnce(db);
    const stale = `UPDATE account_state SET garden_changed_from = '2026-01-05', garden_changed_seq = garden_changed_seq + 1 WHERE user_id = '${userId}'`;
    sqlite(db).exec(stale);
    const checked = await checkFile(db, userId, file);
    const begun = await beginRestore(
      db,
      userId,
      { session: checked.session, replace: true, tokens: [...checked.tokens.values()] },
      { secret: TEST_SECRET },
    );
    if (!begun.ok) throw new Error(begun.error);
    expect((await loadAccountState(db, userId))?.gardenChangedFrom ?? null).toBeNull();
    sqlite(db).exec(stale); // however one got there
    expect(await startFresh(db, userId, { restoreId: begun.restoreId })).toEqual({ ok: true });
    expect((await loadAccountState(db, userId))?.gardenChangedFrom ?? null).toBeNull();
  }, 120_000);

  it("a resimulation that read the catch-up flag just before begin records nothing and walks nothing", async () => {
    let inject: (() => void) | null = null;
    const db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (sql) => {
        if (inject && /^update "account_state" set .*"garden_changed_seq" = "account_state"."garden_changed_seq" \+ 1/i.test(sql)) {
          const fire = inject;
          inject = null;
          fire();
        }
      },
    });
    const { userId, prefs, L } = await restoredOnce(db);
    await advanceGarden(db, userId, prefs); // one step: the cursor is past L
    const before = await rows(db, userId);
    const old = addDays(L, -30);
    await run(db, userId, old, "-old");
    // Begin's bookkeeping lands between the flag read and the record.
    inject = () =>
      sqlite(db).exec(
        `UPDATE account_state SET restore_id = 'r-next', garden_catch_up_pending = 0, garden_changed_from = NULL WHERE user_id = '${userId}'`,
      );
    await resimulateFrom(db, userId, old, prefs);
    expect(inject).toBeNull();
    const account = await loadAccountState(db, userId);
    expect(account?.gardenChangedFrom ?? null).toBeNull();
    expect(account?.gardenCatchUpPending).toBe(false);
    expect(await rows(db, userId)).toEqual(before);
  }, 120_000);
});
