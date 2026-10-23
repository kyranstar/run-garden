/**
 * TASK 13'S FIX WAVE, §2.11: STARTING A RUN WHEN THE WEEK CAN'T PAY (audit 13b M6, 13c R11, 13d D11).
 *
 *  - `POST /api/coach/runs` answers 409 `{ error: "week_budget", spentUsd, cutoffUsd }` when the week's spend plus what a
 *    run of the scope costs — the median of the athlete's measured runs of its kind, else its estimate — is over the
 *    weekly cutoff. A live run still comes back as itself.
 *  - `plan_set` sizes the set to the smaller of what the run and the week have left (the week's less one call's worst
 *    case), and says how many workouts would fit.
 *
 * Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { createRun, DEFAULT_SINGLE_RUN_COST_MICROS, newRunState, ROUTE_OVERHEAD, START_MEDIAN_MIN, type RunDeps } from "../src/services/coach-runs.js";
import { DEFAULT_SET_MAIN_COST_MICROS, DEFAULT_WORKOUT_COST_MICROS } from "../src/services/design-orchestrate.js";
import { allTools } from "../src/services/design-tools/index.js";
import { isToolErr, type SetHooks, type ToolContext, type ToolErr } from "../src/services/design-tools/types.js";
import { DEV_BUDGET, LLM_BUDGET } from "../src/services/llm.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const ENV = {
  DB: {} as unknown as Env["DB"],
  ASSETS: {} as unknown as Env["ASSETS"],
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
  COACH_DESIGNER: "1",
} as Env;

const deps = (): RunDeps => ({
  callModel: async () => {
    throw new Error("no model call here");
  },
  buildContext: { statementCost: 0, build: async () => ({ system: [], header: "" }) },
  tools: [],
});

let db: Db;
let userId: string;
let cookie: string;
let statements = 0;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

async function create(body: unknown) {
  const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(deps));
  statements = 0;
  const res = await app.request("/api/coach/runs", { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, ENV);
  return { status: res.status, body: (await res.json()) as Record<string, any>, cost: statements };
}

/** The week's spend so far: one usage row of `micros`, an hour ago. */
async function spent(micros: number) {
  await db.insert(schema.llmUsage).values({
    id: newId(), userId, kind: "design_main", model: "m", inputTokens: 1, outputTokens: 1, costMicros: micros, cacheHit: false,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  });
}

/** A finished main run of `kind` whose tree cost `own` + its sub-runs' (a designer, and its reviewer under it). */
async function finishedRun(kind: "now" | "week", own: number, sub = 0, subSub = 0, end: { status: string; error: string | null } = { status: "finished", error: null }) {
  const at = new Date(Date.now() - 86_400_000).toISOString();
  const id = `run-${newId().slice(0, 10)}`;
  const row = (rid: string, parentId: string | null, role: string, cost: number) => ({
    id: rid, userId, parentId, role, scope: { kind }, request: "x", status: parentId ? "finished" : end.status, error: parentId ? null : end.error,
    state: JSON.stringify(newRunState("main", { kind })), steps: 3, costUsd: cost, createdAt: at, updatedAt: at, finishedAt: at,
  });
  await db.insert(schema.coachRuns).values(row(id, null, "main", own));
  if (sub || subSub) {
    await db.insert(schema.coachRuns).values(row(`${id}-d`, id, "designer", sub));
    await db.insert(schema.coachRuns).values(row(`${id}-r`, `${id}-d`, "reviewer", subSub));
  }
  return id;
}

const cutoff = LLM_BUDGET.cutoffMicros;

describe("starting a run the week can't pay for (§2.11)", () => {
  it("over the cutoff with a run's estimate: 409 week_budget, nothing started", async () => {
    await spent(cutoff - DEFAULT_SINGLE_RUN_COST_MICROS + 50_000);
    const res = await create({ scope: { kind: "now" }, request: "hips" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "week_budget", spentUsd: (cutoff - DEFAULT_SINGLE_RUN_COST_MICROS + 50_000) / 1_000_000, cutoffUsd: cutoff / 1_000_000 });
    expect(await db.select().from(schema.coachRuns)).toEqual([]);
  });

  it("within it: the run starts — one statement more than before, the week's read", async () => {
    await spent(cutoff - DEFAULT_SINGLE_RUN_COST_MICROS - 50_000);
    const res = await create({ scope: { kind: "now" }, request: "hips" });
    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(false);
    // The route's own (the session, the restore marker), the preferences, the week, the insert.
    expect(res.cost).toBe(ROUTE_OVERHEAD + 3);
  });

  it("the scope's measured median, once there are enough runs — their whole trees", async () => {
    expect(START_MEDIAN_MIN).toBe(3);
    await finishedRun("now", 0.3);
    await finishedRun("now", 0.4, 0.05, 0.05); // 0.5 with its sub-runs
    await finishedRun("now", 1.2);
    // A set's runs are another kind: never in a single run's median.
    await finishedRun("week", 9);
    await spent(cutoff - 550_000);
    expect((await create({ scope: { kind: "now" } })).status).toBe(200);
    await db.delete(schema.coachRuns).where(eq(schema.coachRuns.status, "active"));
    await spent(100_000);
    expect((await create({ scope: { kind: "now" } })).status).toBe(409);
  });

  it("round 2, Minor 7: a run stopped at its own ceiling counts in the median — what such a run really costs; other stops don't", async () => {
    await finishedRun("now", 0.3);
    await finishedRun("now", 0.3);
    for (let i = 0; i < 3; i++) await finishedRun("now", 1.5, 0, 0, { status: "stopped_cap", error: "run_ceiling" });
    for (let i = 0; i < 3; i++) await finishedRun("now", 0.1, 0, 0, { status: "stopped_cap", error: "state_cap" });
    // Measured: 0.3, 0.3, 1.5, 1.5, 1.5 — a median of $1.50, over the $1.00 the week has left.
    await spent(cutoff - 1_000_000);
    expect((await create({ scope: { kind: "now" } })).status).toBe(409);
  });

  it("a set's estimate is the workouts' and the main coach's: the next three at the defaults", async () => {
    const estimate = 3 * DEFAULT_WORKOUT_COST_MICROS + DEFAULT_SET_MAIN_COST_MICROS;
    await spent(cutoff - estimate + 10_000);
    const res = await create({ scope: { kind: "next_n", n: 3 } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("week_budget");
  });

  it("a live run comes back as itself, whatever the week has left", async () => {
    const live = (await createRun(db, userId, { scope: { kind: "now" }, request: "first" }, new Date())).run.id;
    await spent(cutoff);
    const res = await create({ scope: { kind: "now" }, request: "second" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ existing: true, run: { id: live } });
  });
});

describe("plan_set sizes the set to what the week has left (§2.11)", () => {
  const brief = (key: string, i: number) => ({ key, date: addDays(TODAY, i), purpose: "Care.", emphasis: "Mobility.", constraints: "Home.", why: "Spread out.", sameDayWhy: "A short care session only." });

  async function planCtx(week: { spentMicros: number; callWorstMicros: number; cutoffMicros?: number } | null): Promise<ToolContext> {
    const { userId: uid } = await seedRichAthlete(db);
    const id = (await createRun(db, uid, { scope: { kind: "week" }, request: null }, NOW)).run.id;
    const set: SetHooks = {
      rounds: () => [],
      budget: () => ({ ceilingMicros: 6_000_000, spentMicros: 0, mainSpentMicros: 0, perDesignerMicros: null, estimate: null }),
      keyLine: () => undefined,
      started: () => false,
      start: async (d) => d.map((x) => x.runId),
      ...(week ? { week: async () => week } : {}),
    };
    return { db, env: ENV, userId: uid, now: NOW, toolUseId: `toolu_w${newId().slice(0, 6)}`, run: { id, role: "main", scope: { kind: "week" }, parentId: null, rehearsal: false }, set };
  }
  const planSet = allTools().find((t) => t.name === "plan_set")!;

  it("the week the tighter limit: refused, naming the week's dollars and how many workouts fit", async () => {
    // $3.00 left this week, less a $0.40 call: $2.60 — three workouts ($2.10) and the coach's $0.75 don't fit; two do.
    const ctx = await planCtx({ spentMicros: cutoff - 3_000_000, callWorstMicros: 400_000 });
    const err = (await planSet.run(ctx, { briefs: [brief("a", 0), brief("b", 2), brief("c", 4)] })) as ToolErr;
    expect(err.error).toBe("over_budget");
    expect(err.why).toContain("3 workouts are estimated at $2.10, and the coach keeps $0.75 to judge and finish the set");
    expect(err.why).toContain("this week's AI budget has $2.60 left — enough for 2 workouts.");
    expect(err.fix).toBe("Plan 2 or fewer: the sessions the week needs most, around the runs.");
    expect(isToolErr(await planSet.run({ ...ctx, toolUseId: "toolu_w2" }, { briefs: [brief("a", 0), brief("c", 4)] }))).toBe(false);
  });

  it("a rehearsal's week is weighed against its lane's cutoff (audit C1: the rehearsal lane's cap, not the athlete's)", async () => {
    // $3.00 left under the rehearsal lane's $15 — though the athlete's $20 would leave $8.
    const ctx = await planCtx({ spentMicros: DEV_BUDGET.capMicros - 3_000_000, callWorstMicros: 400_000, cutoffMicros: DEV_BUDGET.capMicros });
    const err = (await planSet.run(ctx, { briefs: [brief("a", 0), brief("b", 2), brief("c", 4)] })) as ToolErr;
    expect(err.error).toBe("over_budget");
    expect(err.why).toContain("this week's AI budget has $2.60 left — enough for 2 workouts.");
  });

  it("the run's own ceiling the tighter: as before; no week known (hooks without it): the run's alone", async () => {
    const roomy = await planCtx({ spentMicros: 0, callWorstMicros: 400_000 });
    expect(isToolErr(await planSet.run(roomy, { briefs: [brief("a", 0), brief("b", 2), brief("c", 4)] }))).toBe(false);
    const none = await planCtx(null);
    expect(isToolErr(await planSet.run(none, { briefs: [brief("a", 0), brief("b", 2), brief("c", 4)] }))).toBe(false);
  });
});
