/**
 * THE HALF-HOURLY COROS SWEEP IS VISIBLE AND BOUNDED (cron reliability, part 3).
 *
 * halfHourly() closed its `calendar_sync` run row before the COROS half — the forced read (full schedule import every
 * six hours, the ingest, the garden's replay, the coach reads), the sleep pull and the backfill chunk — so an
 * invocation killed there left no trace anywhere. Measured on a realistic account (hourly-budget.test.ts) that half
 * cost ~55 ms of node CPU when it ingested new activities: the heaviest invocation in the cron system, and the
 * invisible one. These pin its run row and its bounds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, startOfIsoWeek, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";

/**
 * The schedule import runs on the account's first read only. On this fixture the seeded plan and the mock's
 * schedule leave two "Rest" rows on one day, and every later import flips which of them is archived (import-plan's
 * own behaviour, reported, not this suite's subject): the garden's inputs on that day change under the walk from
 * one sweep to the next, and "lands where one uncapped replay lands" needs tables that hold still.
 */
const imports = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../src/services/import-plan.js", async (orig) => {
  const real = await orig<typeof import("../src/services/import-plan.js")>();
  return {
    ...real,
    importPlanSnapshot: async (...args: Parameters<typeof real.importPlanSnapshot>) =>
      imports.calls++ === 0 ? real.importPlanSnapshot(...args) : (undefined as unknown as Awaited<ReturnType<typeof real.importPlanSnapshot>>),
  };
});
beforeEach(() => {
  imports.calls = 0;
});
import { halfHourly, hourly } from "../src/index.js";
import { REQUEST_REPLAY_MAX_DAYS, SWEEP_REPLAY_MAX_DAYS } from "../src/services/cron-limits.js";
import { corosReadNow } from "../src/services/coros-read.js";
import { loadGarden, resimulateFrom } from "../src/services/garden-sync.js";
import { closeStrandedSyncRuns } from "../src/services/reconcile-daily.js";
import { makeTestDb } from "./helpers.js";
import { gardenTimeline, replayMarker } from "./garden-compare.js";
import { seedRealisticAccount } from "./realistic-account.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The mock COROS account's week: its activities (a run with its detail, a ride, a strength session) land on that
 * Tuesday, inside the read's 14-day window and before the garden's last simulated day. */
const lastMonday = (): string => addDays(startOfIsoWeek(todayInZone("America/Los_Angeles")), -7);

type RunRow = typeof schema.syncRuns.$inferSelect;

function corosRunsSync(db: Db, userId: string): RunRow[] {
  return (
    db
      .select()
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.userId, userId), eq(schema.syncRuns.kind, "coros_read"))) as unknown as {
      all: () => RunRow[];
    }
  ).all();
}

describe("the half-hourly COROS half has its own run row", () => {
  it("opens a coros_read run before the read and closes it after the drain, the sleep pull and the backfill, with stats", { timeout: 60_000 }, async () => {
    let userId = "";
    let openWhileIngesting: RunRow[] | null = null;
    let db!: Db;
    db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (sql) => {
        // The first new activity the sweep writes: the run row must already be there, and still running — so an
        // invocation killed from here on leaves it `running` for the stranded-run sweeper.
        if (userId && openWhileIngesting === null && /^insert into "activities"/.test(sql)) {
          openWhileIngesting = corosRunsSync(db, userId);
        }
      },
    });
    const acct = await seedRealisticAccount(db, { newActivities: false, gardenBehindDays: 2, corosBaseMonday: lastMonday() });
    userId = acct.userId;
    vi.stubGlobal("fetch", acct.fetchImpl);

    await halfHourly(db, acct.env);

    expect(openWhileIngesting).not.toBeNull();
    expect(openWhileIngesting!.map((r) => r.status)).toEqual(["running"]);
    const runs = corosRunsSync(db, userId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("ok");
    expect(runs[0]!.finishedAt).not.toBeNull();
    const stats = runs[0]!.stats as Record<string, unknown>;
    expect(stats.read).toBe("ok");
    expect(stats.ingested).toBeGreaterThan(0);
    expect(stats).toHaveProperty("fullSchedule");
    expect(stats).toHaveProperty("coachReads");
    expect(stats).toHaveProperty("garden");
    expect(stats.sleep).toBe(false);
    expect(stats.backfill).toBe(false);
  });

  it("an account with no COROS connection gets no coros_read row", async () => {
    const db = makeTestDb();
    const acct = await seedRealisticAccount(db, { newActivities: false });
    await db.delete(schema.providerConnections).where(eq(schema.providerConnections.userId, acct.userId));
    vi.stubGlobal("fetch", acct.fetchImpl);
    await halfHourly(db, acct.env);
    expect(corosRunsSync(db, acct.userId)).toEqual([]);
  });

  it("a restore that begins while the sweep reads leaves no coros_read row in the account it replaces (m7)", { timeout: 60_000 }, async () => {
    let userId = "";
    let runInserts = 0;
    let db!: Db;
    db = makeTestDb({
      onStatement: (sql) => {
        // halfHourly writes the calendar run first, then the COROS half's: begin fires as the second is written.
        if (userId && /^insert into "sync_runs"/.test(sql) && ++runInserts === 2) {
          (db.insert(schema.accountState).values({
            userId,
            restoreId: newId(),
            restoreStartedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }) as unknown as { run: () => void }).run();
        }
      },
    });
    const acct = await seedRealisticAccount(db, { newActivities: false, corosBaseMonday: lastMonday() });
    userId = acct.userId;
    vi.stubGlobal("fetch", acct.fetchImpl);
    await halfHourly(db, acct.env);
    expect(runInserts).toBe(2);
    expect(corosRunsSync(db, userId)).toEqual([]);
  });

  it("a coros_read run left running (the invocation was killed) is closed by the hourly's stranded-run sweeper", async () => {
    const db = makeTestDb();
    const id = newId();
    await db.insert(schema.syncRuns).values({
      id,
      userId: null,
      kind: "coros_read",
      startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
      status: "running",
    });
    expect(await closeStrandedSyncRuns(db)).toBe(1);
    const [row] = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, id));
    expect(row!.status).toBe("error");
    expect(row!.stats).toEqual({ interrupted: true });
  });
});

describe("the sweep's work is bounded per invocation", () => {
  it("ingesting new activities: the garden replays at most a few days and one coach read runs; the next runs finish it, exactly where one uncapped replay lands", { timeout: 60_000 }, async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const monday = lastMonday();
    const acct = await seedRealisticAccount(db, { newActivities: false, gardenBehindDays: 2, corosBaseMonday: monday });
    vi.stubGlobal("fetch", acct.fetchImpl);
    const shownBefore = (await loadGarden(db, acct.userId))!.state.lastSimulatedDate;
    const tuesday = addDays(monday, 1);
    // One uncapped replay walks from last Monday's checkpoint to the garden's day: more than the cap.
    expect((Date.parse(shownBefore) - Date.parse(monday)) / 86_400_000).toBeGreaterThan(SWEEP_REPLAY_MAX_DAYS);
    const queued = async () =>
      (await db.select().from(schema.coachReads).where(eq(schema.coachReads.userId, acct.userId))).filter((r) => r.status === "queued").length;

    const before = { ...acct.fetches };
    await halfHourly(db, acct.env);
    const [run] = corosRunsSync(db, acct.userId);
    const stats = run!.stats as {
      ingested: number;
      fullSchedule: boolean;
      garden: { simulatedDays: number; resimPending: boolean } | null;
      coachReads: number;
    };
    expect(stats.ingested).toBeGreaterThan(1);
    expect(stats.fullSchedule).toBe(true); // the connection's first read: the six-hourly import ran in it too
    expect(stats.garden).toEqual({ simulatedDays: SWEEP_REPLAY_MAX_DAYS, resimPending: true });
    expect(stats.coachReads).toBe(1);
    expect(acct.fetches.llm - before.llm).toBeLessThanOrEqual(2); // one read: its call, and at most one repair
    expect(await queued()).toBeGreaterThan(0); // the rest wait for the next runs
    // The rendered garden was not rewound, and the replay is on record.
    expect((await loadGarden(db, acct.userId))!.state.lastSimulatedDate).toBe(shownBefore);
    expect(await replayMarker(db, acct.userId)).not.toBeNull();

    // The next runs — the hourly and the next sweeps — finish it, each within the same bounds.
    for (let i = 0; i < 8 && ((await replayMarker(db, acct.userId)) !== null || (await queued()) > 0); i++) {
      await hourly(db, acct.env);
      await halfHourly(db, acct.env);
    }
    for (const r of corosRunsSync(db, acct.userId)) {
      const s = r.stats as { garden: { simulatedDays: number } | null; coachReads: number; ingested: number };
      expect(r.status).toBe("ok");
      expect(s.garden?.simulatedDays ?? 0).toBeLessThanOrEqual(SWEEP_REPLAY_MAX_DAYS);
      if (s.ingested > 0) expect(s.coachReads).toBeLessThanOrEqual(1);
    }
    expect(await replayMarker(db, acct.userId)).toBeNull();
    expect(await queued()).toBe(0);

    // Credited: Tuesday's day input holds the new sessions…
    const landed = await gardenTimeline(db, acct.userId, { mondayCheckpointsOnly: true });
    const ids = (await db.select().from(schema.activities).where(eq(schema.activities.userId, acct.userId)))
      .filter((a) => (a.startTimeLocal ?? a.startTime).slice(0, 10) === tuesday && ["run", "strength", "yoga"].includes(a.sport))
      .map((a) => a.id);
    expect(ids.length).toBeGreaterThan(0);
    const input = landed.inputs.find((x) => x.date === tuesday)!.input as { completedRuns: Array<{ activityId?: string }> };
    expect(input.completedRuns.map((r) => r.activityId)).toEqual(expect.arrayContaining(ids));
    // …and the garden is exactly the one an uncapped replay makes: replaying again from the Tuesday changes nothing.
    await resimulateFrom(db, acct.userId, tuesday, acct.prefs);
    expect(await gardenTimeline(db, acct.userId, { mondayCheckpointsOnly: true })).toEqual(landed);
  });

  it("the next sweeps alone finish a replay the first one left on record, and a re-read the garden already holds claims nothing", { timeout: 60_000 }, async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const monday = lastMonday();
    const acct = await seedRealisticAccount(db, { newActivities: false, gardenBehindDays: 2, corosBaseMonday: monday });
    vi.stubGlobal("fetch", acct.fetchImpl);
    const tuesday = addDays(monday, 1);

    // Every read re-reads the mock's activities (their stored telemetry is list-grade, so the read heals them each
    // time) and the ingest reports their Tuesday again. Before, each such claim replayed the garden from last
    // Monday — every half hour; capped, it would have restarted the replay every sweep and never let it finish.
    const sweeps: Array<{ ingested: number; garden: { simulatedDays: number; resimPending: boolean } | null; coachReads: number }> = [];
    for (let i = 0; i < 8; i++) {
      await halfHourly(db, acct.env);
      const latest = corosRunsSync(db, acct.userId).sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0)).at(-1)!;
      sweeps.push(latest.stats as (typeof sweeps)[number]);
      if ((await replayMarker(db, acct.userId)) === null) break;
    }
    expect(sweeps[0]!.ingested).toBeGreaterThan(1);
    for (const s of sweeps) {
      expect(s.garden?.simulatedDays ?? 0).toBeLessThanOrEqual(SWEEP_REPLAY_MAX_DAYS);
      if ((s.garden?.simulatedDays ?? 0) > 0 || s.ingested > 0) expect(s.coachReads).toBeLessThanOrEqual(1);
    }
    expect(sweeps.length).toBeGreaterThan(1);
    expect(sweeps.length).toBeLessThan(8); // it finished
    expect(await replayMarker(db, acct.userId)).toBeNull();

    // A read now re-reads the same activities and claims nothing: the garden already holds their day.
    const again = await corosReadNow(db, acct.env, acct.userId, acct.prefs, { force: true });
    expect(again.status).toBe("ok");
    expect(again.garden).toBeUndefined();
    expect(await replayMarker(db, acct.userId)).toBeNull();

    // And the garden is the one an uncapped replay makes.
    const landed = await gardenTimeline(db, acct.userId, { mondayCheckpointsOnly: true });
    await resimulateFrom(db, acct.userId, tuesday, acct.prefs);
    expect(await gardenTimeline(db, acct.userId, { mondayCheckpointsOnly: true })).toEqual(landed);
  });

  it("a read that runs the six-hourly full schedule import replays at most the sweep's cap; one that does not, at most a request's (part 4)", { timeout: 60_000 }, async () => {
    for (const fullDue of [true, false]) {
      imports.calls = 0;
      const db = makeTestDb({ boundVariableCap: 100 });
      const acct = await seedRealisticAccount(db, { newActivities: false, gardenBehindDays: 2, corosBaseMonday: lastMonday() });
      vi.stubGlobal("fetch", acct.fetchImpl);
      if (!fullDue) {
        const [conn] = await db.select().from(schema.providerConnections).where(eq(schema.providerConnections.userId, acct.userId));
        await db
          .update(schema.providerConnections)
          .set({ meta: { ...(conn!.meta as Record<string, unknown>), lastFullScheduleAt: new Date().toISOString() } })
          .where(eq(schema.providerConnections.id, conn!.id));
      }
      // A request's read (Read now, opening the app): no cap passed — it takes a request's step, never more.
      const read = await corosReadNow(db, acct.env, acct.userId, acct.prefs, { force: true });
      expect(read.status).toBe("ok");
      expect(read.fullSchedule === true).toBe(fullDue);
      if (fullDue) expect(read.garden).toEqual({ simulatedDays: SWEEP_REPLAY_MAX_DAYS, resimPending: true });
      else {
        expect(read.garden!.simulatedDays).toBeGreaterThan(SWEEP_REPLAY_MAX_DAYS);
        expect(read.garden!.simulatedDays).toBeLessThanOrEqual(REQUEST_REPLAY_MAX_DAYS);
      }
    }
  });
});
