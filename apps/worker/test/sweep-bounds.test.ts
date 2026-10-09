/**
 * THE HALF-HOURLY COROS SWEEP IS VISIBLE AND BOUNDED (cron reliability, part 3).
 *
 * halfHourly() closed its `calendar_sync` run row before the COROS half — the forced read (full schedule import every
 * six hours, the ingest, the garden's replay, the coach reads), the sleep pull and the backfill chunk — so an
 * invocation killed there left no trace anywhere. Measured on a realistic account (hourly-budget.test.ts) that half
 * cost ~55 ms of node CPU when it ingested new activities: the heaviest invocation in the cron system, and the
 * invisible one. These pin its run row and its bounds.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, startOfIsoWeek, todayInZone } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { halfHourly } from "../src/index.js";
import { closeStrandedSyncRuns } from "../src/services/reconcile-daily.js";
import { makeTestDb } from "./helpers.js";
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
