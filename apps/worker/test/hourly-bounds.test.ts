/**
 * EVERY HOURLY INVOCATION'S WORK IS BOUNDED AND RESUMABLE (cron reliability, part 2).
 *
 * On the Workers free plan 26 of 177 hourly `reconcile` runs were killed part-way, in clusters that follow new
 * activities. Measured on a realistic account (hourly-budget.test.ts), the invocation right after new activities
 * cost three to seven times a steady one — the coach reads, a COROS write and the garden's walk all landing in the
 * same invocation — and a garden weeks behind cost eight times (480 statements). These pin the bounds: the garden
 * walks a few days a run and the next run walks on, landing exactly where one long walk lands.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { CRON_GARDEN_MAX_DAYS, hourly } from "../src/index.js";
import { loadGarden, resimulateFrom } from "../src/services/garden-sync.js";
import { makeTestDb } from "./helpers.js";
import { seedRealisticAccount } from "./realistic-account.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function lastReconcile(db: Db, userId: string) {
  const [run] = await db
    .select()
    .from(schema.syncRuns)
    .where(and(eq(schema.syncRuns.userId, userId), eq(schema.syncRuns.kind, "reconcile")))
    .orderBy(desc(schema.syncRuns.startedAt), desc(schema.syncRuns.id))
    .limit(1);
  return run!;
}

describe("the hourly garden step", () => {
  it("walks at most a few days a run, persists where it stopped, and lands where one uncapped walk lands", { timeout: 60_000 }, async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    const acct = await seedRealisticAccount(db, { gardenBehindDays: 12, newActivities: false });
    vi.stubGlobal("fetch", acct.fetchImpl);
    const start = (await loadGarden(db, acct.userId))!.state.lastSimulatedDate;

    const walked: number[] = [];
    let lastSimulated = start;
    for (let i = 0; i < 8; i++) {
      await hourly(db, acct.env);
      const run = await lastReconcile(db, acct.userId);
      expect(run.status).toBe("ok");
      const stats = run.stats as { simulatedDays: number; lastSimulatedDate: string };
      walked.push(stats.simulatedDays);
      // Persisted where it stopped: the next run starts from there.
      expect((await loadGarden(db, acct.userId))!.state.lastSimulatedDate).toBe(stats.lastSimulatedDate);
      expect(stats.lastSimulatedDate >= lastSimulated).toBe(true);
      lastSimulated = stats.lastSimulatedDate;
    }
    expect(Math.max(...walked)).toBe(CRON_GARDEN_MAX_DAYS);
    expect(walked.every((d) => d <= CRON_GARDEN_MAX_DAYS)).toBe(true);
    expect(walked.filter((d) => d > 0).length).toBeGreaterThanOrEqual(3); // it took several runs
    // Every day between where it started and where it ended was walked once, by one run or another.
    const daysBetween = (Date.parse(lastSimulated) - Date.parse(start)) / 86_400_000;
    expect(walked.reduce((a, b) => a + b, 0)).toBe(daysBetween);
    expect(walked.at(-1)).toBe(0); // caught up

    // The same days walked in one go from the same start: the same garden, byte for byte.
    const capped = JSON.stringify(await loadGarden(db, acct.userId));
    await resimulateFrom(db, acct.userId, addDays(start, 1), acct.prefs);
    expect(JSON.stringify(await loadGarden(db, acct.userId))).toBe(capped);
  });
});

describe("one heavy step per account per invocation", () => {
  it("right after new activities: the garden's walk, a coach read, a COROS write — never two in one run, and all of it lands", { timeout: 60_000 }, async () => {
    const db = makeTestDb({ boundVariableCap: 100 });
    // Two queued reads, the fixture's queued COROS create, and a garden six days behind (two runs of walking).
    const acct = await seedRealisticAccount(db, { gardenBehindDays: 6 });
    vi.stubGlobal("fetch", acct.fetchImpl);
    const queuedJobs = async () =>
      (await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, acct.userId))).filter(
        (j) => j.status === "queued",
      ).length;
    expect(await queuedJobs()).toBe(1);

    const runs: Array<{ heavyStep: string | null; days: number; llm: number; coros: number }> = [];
    for (let i = 0; i < 7; i++) {
      const before = { ...acct.fetches };
      await hourly(db, acct.env);
      const run = await lastReconcile(db, acct.userId);
      expect(run.status).toBe("ok");
      const stats = run.stats as { simulatedDays: number; heavyStep: string | null };
      runs.push({
        heavyStep: stats.heavyStep,
        days: stats.simulatedDays,
        llm: acct.fetches.llm - before.llm,
        coros: acct.fetches.coros - before.coros,
      });
    }

    for (const r of runs) {
      // A walk of one day is the daily case and light; more is the run's heavy step.
      expect([r.days > 1, r.llm > 0, r.coros > 0].filter(Boolean).length).toBeLessThanOrEqual(1);
      expect(r.llm).toBeLessThanOrEqual(2); // one read: its call, and at most one repair
    }
    expect(runs[0]!.heavyStep).toBe("garden");
    for (const r of runs) if (r.days > 1) expect(r.heavyStep).toBe("garden");
    expect(runs.filter((r) => r.heavyStep === "coach_read")).toHaveLength(2);
    expect(runs.filter((r) => r.heavyStep === "coros_write")).toHaveLength(1);
    expect(runs.at(-1)!.heavyStep).toBeNull();

    // Deferred, never dropped: both reads done, the write made, the garden caught up.
    const reads = await db.select().from(schema.coachReads).where(eq(schema.coachReads.userId, acct.userId));
    expect(reads.filter((r) => acct.newActivityIds.includes(r.activityId)).map((r) => r.status)).toEqual(["done", "done"]);
    expect(await queuedJobs()).toBe(0);
  });
});
