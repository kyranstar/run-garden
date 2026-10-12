/**
 * The hourly cron's care of the coach designer's runs (Stage 3 Task 2; cron-limits.ts): one run step — a model call —
 * per invocation across every account, in the slot no other heavy step took; runs left for half an hour expire; and
 * nothing at all while the designer is off.
 *
 * The model is fixture mode's canned answer (no key, no network). Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { hourly } from "../src/index.js";
import { createRun, defaultRunDeps, runStep } from "../src/services/coach-runs.js";
import { COACH_RUN_ORPHAN_MINUTES, COACH_RUN_SWEEP_MAX } from "../src/services/cron-limits.js";
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

/** An account with a main run whose screen closed `idle` minutes ago, its context built. */
async function leftRun(idle: number) {
  const { userId } = await makeTestUser(db);
  const env = makeEnv();
  const { run } = await createRun(db, userId, { scope: { kind: "now" }, request: "a short session" }, minutesAgo(idle));
  const first = await runStep(db, env, run.id, userId, minutesAgo(idle), defaultRunDeps());
  expect(first.kind).toBe("ok");
  return { userId, runId: run.id };
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

describe("the hourly sweep of coach runs", () => {
  it("steps at most COACH_RUN_SWEEP_MAX left runs per invocation, across accounts, and names it the heavy step", async () => {
    expect(COACH_RUN_SWEEP_MAX).toBe(1);
    const a = await leftRun(5);
    const b = await leftRun(5);
    await hourly(db, makeEnv({ COACH_DESIGNER: "1" }));
    const steps = await Promise.all([a, b].map(async (x) => (await runRow(x.runId)).steps));
    expect(steps.sort()).toEqual([1, 2]); // the context step each, and one sweep step between them
    const advanced = (await runRow(a.runId)).steps === 2 ? a : b;
    // Fixture mode's canned answer has no tool call: the run is finished.
    expect((await runRow(advanced.runId)).status).toBe("finished");
    expect(await heavyStepOf(advanced.userId)).toBe("coach_run");
    // The next invocation steps the other.
    await hourly(db, makeEnv({ COACH_DESIGNER: "1" }));
    expect((await runRow(a.runId)).status).toBe("finished");
    expect((await runRow(b.runId)).status).toBe("finished");
  });

  it("never steps a run in an account's invocation that another heavy step already took", { timeout: 60_000 }, async () => {
    const acct = await seedRealisticAccount(db, { gardenBehindDays: 6, newActivities: false });
    vi.stubGlobal("fetch", acct.fetchImpl);
    const { run } = await createRun(db, acct.userId, { scope: { kind: "now" } }, minutesAgo(5));
    expect((await runStep(db, acct.env, run.id, acct.userId, minutesAgo(5), defaultRunDeps())).kind).toBe("ok");
    await hourly(db, { ...acct.env, COACH_DESIGNER: "1" });
    expect(await heavyStepOf(acct.userId)).toBe("garden");
    expect(await runRow(run.id)).toMatchObject({ status: "active", steps: 1 });
    expect(acct.fetches.llm).toBe(0);
  });

  it("expires a run left for half an hour", async () => {
    const a = await leftRun(COACH_RUN_ORPHAN_MINUTES + 1);
    await hourly(db, makeEnv({ COACH_DESIGNER: "1" }));
    expect(await runRow(a.runId)).toMatchObject({ status: "expired", steps: 1 });
  });

  it("does nothing while the designer is off", async () => {
    const a = await leftRun(5);
    const b = await leftRun(COACH_RUN_ORPHAN_MINUTES + 1);
    await hourly(db, makeEnv());
    expect(await runRow(a.runId)).toMatchObject({ status: "active", steps: 1 });
    expect(await runRow(b.runId)).toMatchObject({ status: "active", steps: 1 });
    expect(await heavyStepOf(a.userId)).toBeNull();
  });
});
