/**
 * THE HOURLY'S SMALL DOCUMENT BACKFILL (Stage 2 batch end; cron-limits.ts): a row that lost its document since the
 * last manual backfill — reopened (`reopenedDocColumns`), repaired — gets it again from the hourly cron, a few a run
 * (CRON_DOC_BACKFILL_MAX), through the admin backfill's own converters and writes, in the per-account slot no other
 * heavy step took. Never a frozen row (completed, skipped, missed), never a Studio or template row (its document is its
 * content), never a programme's own slot, a rest day or an archived row. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { parseStoredWorkoutDoc } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { hourly } from "../src/index.js";
import { CRON_DOC_BACKFILL_MAX, CRON_DOC_BACKFILL_SKIP_MAX } from "../src/services/cron-limits.js";
import { backfillLiveDocs } from "../src/services/workout-doc-backfill.js";
import { reopenedDocColumns } from "../src/services/workout-doc-store.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { seedRealisticAccount } from "./realistic-account.js";

const { plannedWorkouts, syncRuns, workoutDocRevisions } = schema;

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "1",
    AI_DEFAULT_ENABLED: "0",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    ...extra,
  } as Env;
}

let db: Db;
let statements: string[];
/**
 * The clock, pinned a week before the rows' day: the hourly's own reconcile marks a row unresolved from its day and
 * missed a week after, so on the real calendar these rows would stop being live (a time bomb). Date only: the
 * database's timers keep running.
 */
const NOW = "2026-10-13T19:00:00.000Z";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  statements = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: (q) => statements.push(q) });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const DAY = "2026-10-20";

/** An imported easy run with no document: its stand-in converts from the row's own length. */
async function row(userId: string, id: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}): Promise<void> {
  await db.insert(plannedWorkouts).values({
    id, userId, planId: "coros-plan", sourceWorkoutId: `9001:${id}`, title: `Easy ${id}`, category: "easy", sport: "run",
    originalPlanDate: DAY, lastVerifiedCorosDate: DAY, effectiveDate: DAY, effectiveTime: "07:00", completionState: "scheduled",
    corosSyncState: "synced", sourceContentFingerprint: `wire-${id}`, calendarBlockDurationSeconds: 1800,
    createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over,
  });
}

const docOf = async (id: string) =>
  (await db.select({ doc: sql<string | null>`${plannedWorkouts.workoutDoc}` }).from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!.doc;

async function heavyStepOf(userId: string) {
  const [run] = await db
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.userId, userId), eq(syncRuns.kind, "reconcile")))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return (run?.stats as { heavyStep?: string | null } | null)?.heavyStep ?? null;
}

describe("the hourly gives a reopened row its document again", () => {
  it("a few a run, the most recently changed first, until none is left — the heavy step of the run that did it", async () => {
    expect(CRON_DOC_BACKFILL_MAX).toBeGreaterThan(0);
    expect(CRON_DOC_BACKFILL_MAX).toBeLessThanOrEqual(10);
    const { userId } = await makeTestUser(db);
    // Ids in one order, changes in the other: the last id was changed last.
    const live = Array.from({ length: CRON_DOC_BACKFILL_MAX + 2 }, (_, i) => `live-${i}`);
    for (const [i, id] of live.entries()) await row(userId, id, { updatedAt: `2026-10-12T00:00:${String(10 + i).padStart(2, "0")}.000Z` });

    await hourly(db, makeEnv());
    const done: string[] = [];
    for (const id of live) if ((await docOf(id)) !== null) done.push(id);
    // The most recently changed first.
    expect(done).toEqual(live.slice(live.length - CRON_DOC_BACKFILL_MAX));
    expect(await heavyStepOf(userId)).toBe("doc_backfill");

    await hourly(db, makeEnv());
    for (const id of live) expect(parseStoredWorkoutDoc(await docOf(id)), id).not.toBeNull();
    // Each document is recorded as a revision, as the manual backfill records it.
    const revisions = await db.select().from(workoutDocRevisions).where(eq(workoutDocRevisions.userId, userId));
    expect(revisions.map((r) => r.workoutId).sort()).toEqual([...live].sort());

    // Nothing left: the step does no work and takes no slot.
    await hourly(db, makeEnv());
    expect(await heavyStepOf(userId)).toBeNull();
  });

  it("a row reopened from completed loses its document and gets it back on the next run", async () => {
    const { userId } = await makeTestUser(db);
    await row(userId, "reopened", { completionState: "completed" });
    await backfillLiveDocs(db, userId, {});
    expect(await docOf("reopened")).toBeNull(); // frozen: never this step's
    await db.update(plannedWorkouts).set({ workoutDoc: '{"version":1}' }).where(eq(plannedWorkouts.id, "reopened"));
    await db
      .update(plannedWorkouts)
      .set({ completionState: "scheduled", ...reopenedDocColumns(), updatedAt: "2026-10-12T00:00:00.000Z" })
      .where(eq(plannedWorkouts.id, "reopened"));
    expect(await docOf("reopened")).toBeNull();
    await hourly(db, makeEnv());
    expect(parseStoredWorkoutDoc(await docOf("reopened"))).not.toBeNull();
  });

  it("never a frozen row, a Studio or template row, a programme's slot, a rest day, an archived row or another account's", async () => {
    const { userId } = await makeTestUser(db);
    const { userId: other } = await makeTestUser(db);
    await row(userId, "completed", { completionState: "completed" });
    await row(userId, "skipped", { completionState: "skipped" });
    await row(userId, "missed", { completionState: "missed" });
    await row(userId, "studio", { origin: "studio" });
    await row(userId, "template", { origin: "template" });
    await row(userId, "slot", { origin: "program", contentState: "built" });
    await row(userId, "rest", { category: "rest", sport: "rest" });
    await row(userId, "archived", { archivedAt: "2026-10-02T00:00:00.000Z" });
    await row(other, "theirs");
    statements = [];
    const report = await backfillLiveDocs(db, userId, {});
    // Nothing to do costs two reads: the rows set aside, and the rows.
    expect(statements).toHaveLength(2);
    expect(report).toMatchObject({ scanned: 0, converted: 0 });
    for (const id of ["completed", "skipped", "missed", "studio", "template", "slot", "rest", "archived", "theirs"]) {
      expect(await docOf(id), id).toBeNull();
    }
  });

  it("one run's step stays well inside the request budget", async () => {
    const { userId } = await makeTestUser(db);
    for (let i = 0; i < 12; i++) await row(userId, `r-${String(i).padStart(2, "0")}`);
    statements = [];
    const report = await backfillLiveDocs(db, userId, {});
    expect(report.converted).toBe(CRON_DOC_BACKFILL_MAX);
    expect(statements.length).toBeLessThanOrEqual(CRON_DOC_BACKFILL_MAX + 6);
  });

  it("a row that keeps failing is set aside, so the rows behind it get theirs; tried again once it changes; the list is bounded", async () => {
    const { userId } = await makeTestUser(db);
    const sqlite = (db as unknown as { $client: { prepare(q: string): { run(...a: unknown[]): unknown } } }).$client;
    // The newest rows: as many as a run reads, each with a coach structure no converter can read.
    const broken = Array.from({ length: CRON_DOC_BACKFILL_MAX }, (_, i) => `broken-${i}`);
    for (const [i, id] of broken.entries()) {
      await row(userId, id, { category: "strength", sport: "strength", updatedAt: `2026-10-12T00:00:${String(30 + i).padStart(2, "0")}.000Z` });
      sqlite.prepare(`update planned_workouts set structured_json = '{not json' where id = ?`).run(id);
    }
    // Older rows behind them, which convert.
    await row(userId, "behind-0", { updatedAt: "2026-10-12T00:00:01.000Z" });
    await row(userId, "behind-1", { updatedAt: "2026-10-12T00:00:02.000Z" });

    const first = await backfillLiveDocs(db, userId, {});
    expect(first.failed.map((f) => f.id).sort()).toEqual([...broken].sort());
    expect(await docOf("behind-0")).toBeNull();
    // Set aside: the next run reads past them.
    const second = await backfillLiveDocs(db, userId, {});
    expect(second.failed).toEqual([]);
    expect(parseStoredWorkoutDoc(await docOf("behind-0"))).not.toBeNull();
    expect(parseStoredWorkoutDoc(await docOf("behind-1"))).not.toBeNull();
    // Nothing else to do: one read of the list, one of the rows.
    statements = [];
    expect(await backfillLiveDocs(db, userId, {})).toMatchObject({ scanned: 0, converted: 0 });
    expect(statements).toHaveLength(2);

    // One changes (its structure readable again): it is tried again, and converts.
    sqlite.prepare(`update planned_workouts set structured_json = null, updated_at = '2026-10-12T01:00:00.000Z' where id = 'broken-0'`).run();
    await backfillLiveDocs(db, userId, {});
    expect(parseStoredWorkoutDoc(await docOf("broken-0"))).not.toBeNull();

    // The list keeps the newest CRON_DOC_BACKFILL_SKIP_MAX.
    for (let i = 0; i < CRON_DOC_BACKFILL_SKIP_MAX + 3; i++) {
      const id = `more-${String(i).padStart(3, "0")}`;
      await row(userId, id, { category: "strength", sport: "strength", updatedAt: `2026-10-13T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z` });
      sqlite.prepare(`update planned_workouts set structured_json = '{not json' where id = ?`).run(id);
    }
    for (let k = 0; k < 20; k++) await backfillLiveDocs(db, userId, {});
    const [kept] = await db.select().from(schema.providerCursorState).where(eq(schema.providerCursorState.userId, userId));
    expect((JSON.parse(kept!.value) as unknown[]).length).toBeLessThanOrEqual(CRON_DOC_BACKFILL_SKIP_MAX);
  });

  it("waits while another heavy step has the run", { timeout: 60_000 }, async () => {
    const acct = await seedRealisticAccount(db, { gardenBehindDays: 6, newActivities: false });
    vi.stubGlobal("fetch", acct.fetchImpl);
    await row(acct.userId, "waits", { updatedAt: "2026-10-12T00:00:00.000Z" });
    await hourly(db, acct.env);
    expect(await heavyStepOf(acct.userId)).toBe("garden");
    expect(await docOf("waits")).toBeNull();
  });
});
