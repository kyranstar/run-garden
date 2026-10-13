/**
 * The hourly cron's care of the coach designer's runs (Stage 3 Task 2; cron-limits.ts). It never spends a model call
 * on a run nobody is watching: it gives back dead claims, runs a left run's queued tool calls (at most
 * COACH_RUN_SWEEP_MAX in an invocation, across every account, in the slot no other heavy step took), and expires a run
 * past its window. While the designer is off it does nothing at all.
 *
 * No model is reachable here: the default dependencies would call the real client, and every run is checked to have
 * recorded no model call. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { hourly } from "../src/index.js";
import { createRun, readRunState } from "../src/services/coach-runs.js";
import { COACH_RUN_SET_WINDOW_HOURS, COACH_RUN_SWEEP_MAX } from "../src/services/cron-limits.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { seedRealisticAccount } from "./realistic-account.js";

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
beforeEach(() => {
  db = makeTestDb({ boundVariableCap: 100 });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

/**
 * A main run whose screen closed `idle` minutes ago, its context built and — unless `queued` is false — one tool call
 * from its last model turn still waiting to run.
 */
async function leftRun(db: Db, userId: string, idle: number, opts: { queued?: boolean; scope?: "now" | "week" } = {}) {
  const { run } = await createRun(db, userId, { scope: { kind: opts.scope ?? "week" }, request: "a short session" }, minutesAgo(idle));
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, run.id));
  const state = readRunState(row!.state)!;
  state.system = [{ type: "text", text: "SYSTEM" }];
  state.messages = [
    { role: "user", content: [{ type: "text", text: "HEADER" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_left", name: "read_day", input: {} }] },
  ];
  state.calls = 1;
  state.pending = opts.queued === false ? [] : [{ id: "toolu_left", name: "read_day", input: {} }];
  await db
    .update(schema.coachRuns)
    .set({ state: JSON.stringify(state), updatedAt: minutesAgo(idle).toISOString() })
    .where(eq(schema.coachRuns.id, run.id));
  return run.id;
}

async function runRow(id: string) {
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return row!;
}

async function heavyStepOf(userId: string) {
  const [run] = await db
    .select()
    .from(schema.syncRuns)
    .where(and(eq(schema.syncRuns.userId, userId), eq(schema.syncRuns.kind, "reconcile")))
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1);
  return (run?.stats as { heavyStep?: string | null } | null)?.heavyStep ?? null;
}

const pendingOf = async (id: string) => readRunState((await runRow(id)).state)!.pending.length;

describe("the hourly sweep of coach runs", () => {
  it("runs a left run's queued calls, at most COACH_RUN_SWEEP_MAX across accounts, names it the heavy step, and never calls a model", async () => {
    expect(COACH_RUN_SWEEP_MAX).toBe(1);
    const a = (await makeTestUser(db)).userId;
    const b = (await makeTestUser(db)).userId;
    const ra = await leftRun(db, a, 5);
    const rb = await leftRun(db, b, 5);
    await hourly(db, makeEnv({ COACH_DESIGNER: "1" }));
    const left = [await pendingOf(ra), await pendingOf(rb)].sort();
    expect(left).toEqual([0, 1]); // one run's queue ran
    const advanced = (await pendingOf(ra)) === 0 ? { run: ra, user: a } : { run: rb, user: b };
    expect(await runRow(advanced.run)).toMatchObject({ status: "active", steps: 1 });
    expect(await heavyStepOf(advanced.user)).toBe("coach_run");
    // The next invocation runs the other's.
    await hourly(db, makeEnv({ COACH_DESIGNER: "1" }));
    expect([await pendingOf(ra), await pendingOf(rb)]).toEqual([0, 0]);
    // …and nothing more: with the queues empty, the next step would be a model call, which the cron never makes.
    await hourly(db, makeEnv({ COACH_DESIGNER: "1" }));
    expect((await runRow(ra)).steps).toBe(1);
    expect((await runRow(rb)).steps).toBe(1);
    expect(await db.select().from(schema.llmUsage)).toHaveLength(0);
  });

  it("never steps a run in an account's invocation that another heavy step already took", { timeout: 60_000 }, async () => {
    const acct = await seedRealisticAccount(db, { gardenBehindDays: 6, newActivities: false });
    vi.stubGlobal("fetch", acct.fetchImpl);
    const runId = await leftRun(db, acct.userId, 5);
    await hourly(db, { ...acct.env, COACH_DESIGNER: "1" });
    expect(await heavyStepOf(acct.userId)).toBe("garden");
    expect(await pendingOf(runId)).toBe(1);
    expect(acct.fetches.llm).toBe(0);
  });

  it("expires a run past its window", async () => {
    const { userId } = await makeTestUser(db);
    const runId = await leftRun(db, userId, COACH_RUN_SET_WINDOW_HOURS * 60 + 5);
    await hourly(db, makeEnv({ COACH_DESIGNER: "1" }));
    expect(await runRow(runId)).toMatchObject({ status: "expired", error: "expired" });
  });

  it("does nothing while the designer is off", async () => {
    const { userId } = await makeTestUser(db);
    const a = await leftRun(db, userId, 5);
    const other = (await makeTestUser(db)).userId;
    const b = await leftRun(db, other, COACH_RUN_SET_WINDOW_HOURS * 60 + 5);
    await hourly(db, makeEnv());
    expect(await runRow(a)).toMatchObject({ status: "active", steps: 0 });
    expect(await runRow(b)).toMatchObject({ status: "active", steps: 0 });
    expect(await pendingOf(a)).toBe(1);
    expect(await heavyStepOf(userId)).toBeNull();
  });
});
