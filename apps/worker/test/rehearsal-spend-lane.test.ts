/**
 * REHEARSALS AND REPLAYS SPEND IN A LANE OF THEIR OWN (audit C1, seen in prod 2026-10-16 → 10-23).
 *
 * Forty rehearsal runs ($10.36) and a voice-workshop replay ($1.43) were written to the athlete's `llm_usage` under the
 * athlete's kinds and counted by the athlete's weekly figure: the rolling week read $18.26 against $6.40 of the
 * athlete's own, the ambient activity reads stopped at their $12 reserve for six and a half days without a word, and a
 * week's plan could not start under the $20 cutoff. Now:
 *
 *  - a rehearsal's calls are recorded as `rehearsal_<kind>`, a replay's as `coach_replay` — still recorded, all of it;
 *  - the athlete's figure (`llmBudgetStatus`: the cutoff, the warning, the auto-read reserve, a run's start and every
 *    step's weekly check) never counts them, nor does a run's start measure a rehearsal's cost as the athlete's;
 *  - rehearsals and replays have their own rolling-week cap, DEV_BUDGET ($15): over it a rehearsal never starts (409
 *    `rehearsal_budget`), a rehearsal's step stops, and a replay is refused;
 *  - the spend report shows them apart, the sweep's run row says why it read nothing, and Settings says, in one line,
 *    while the automatic reads are paused.
 *
 * Synthetic data only; every row is dated against the real clock (an hour ago), never a fixed date.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { coachRoutes } from "../src/routes/coach.js";
import { settingsRoutes } from "../src/routes/misc.js";
import { createRun, newRunState, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { AUTO_READ_RESERVE_MICROS, enqueueCoachReads, processCoachReads } from "../src/services/coach-reads.js";
import { DEV_BUDGET, devBudgetStatus, LLM_BUDGET, llmBudgetStatus, REHEARSAL_USAGE_PREFIX, REPLAY_USAGE_KIND } from "../src/services/llm.js";
import type { MessagesResult } from "../src/services/llm-messages.js";
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
  AI_GATEWAY_API_KEY: "test-key",
} as Env;

let db: Db;
let userId: string;
let prefs: UserPreferences;
let cookie: string;

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString();

/** One usage row of `kind` costing `micros`, an hour ago. */
async function usage(kind: string, micros: number) {
  await db.insert(schema.llmUsage).values({
    id: newId(), userId, kind, model: "m", inputTokens: 1, outputTokens: 1, costMicros: micros, cacheHit: false, requestFingerprint: "f", createdAt: hourAgo(),
  });
}

/** The prod week of 10-23: the athlete's own $6.40, forty rehearsals' $10.36, a replay's $1.43. */
async function prodWeek() {
  await usage("design_main", 3_200_000);
  await usage("weekly_review", 3_200_000);
  await usage(`${REHEARSAL_USAGE_PREFIX}design_main`, 6_000_000);
  await usage(`${REHEARSAL_USAGE_PREFIX}design_workout`, 3_360_000);
  await usage(`${REHEARSAL_USAGE_PREFIX}design_review`, 1_000_000);
  await usage(REPLAY_USAGE_KIND, 1_430_000);
}

describe("the athlete's week and the rehearsal lane are counted apart", () => {
  it("llmBudgetStatus counts only the athlete's calls; devBudgetStatus only rehearsals' and replays'", async () => {
    await prodWeek();
    expect((await llmBudgetStatus(db, userId)).spentMicros).toBe(6_400_000);
    expect(await devBudgetStatus(db, userId)).toEqual({ spentMicros: 11_790_000, capMicros: DEV_BUDGET.capMicros, over: false });
    expect(DEV_BUDGET.capMicros).toBe(15_000_000);
  });

  it("the automatic reads go on under the athlete's own spend, whatever rehearsals cost", async () => {
    const p = prefs;
    await prodWeek();
    await usage(`${REHEARSAL_USAGE_PREFIX}design_main`, AUTO_READ_RESERVE_MICROS); // far past the reserve, on rehearsals alone
    const date = addDays(todayInZone(p.timezone), -1);
    await db.insert(schema.activities).values({
      id: newId(), userId, startTime: `${date}T12:08:02Z`, startTimeLocal: `${date}T05:08:02`, sport: "run", durationSeconds: 1800, elapsedSeconds: 1800,
      distanceMeters: 5000, title: "Easy", sourceMergeConfidence: 1, createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    await enqueueCoachReads(db, userId, todayInZone(p.timezone));
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ glance: "Easy.", body: "Kept it easy.", flags: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
    }) as typeof fetch;
    const out = await processCoachReads(db, ENV, userId, p, { fetchImpl });
    expect(out.skipped).toBeNull();
    expect(calls).toBeGreaterThan(0);
  });
});

// ── Starting a run ──────────────────────────────────────────────────────────────────────────────────────────────────

const noModel = (): RunDeps => ({
  callModel: async () => {
    throw new Error("no model call here");
  },
  buildContext: { statementCost: 0, build: async () => ({ system: [], header: "" }) },
  tools: [],
});

async function create(body: unknown) {
  const app = mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(noModel));
  const res = await app.request("/api/coach/runs", { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, ENV);
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

/** A finished main run of `kind`, a day ago, that cost `usd` — a rehearsal's when `rehearsal`. */
async function finishedRun(kind: "now" | "week", usd: number, rehearsal: boolean) {
  const at = new Date(Date.now() - 86_400_000).toISOString();
  await db.insert(schema.coachRuns).values({
    id: `run-${newId().slice(0, 10)}`, userId, parentId: null, role: "main", scope: { kind }, request: "x", status: "finished", error: null,
    state: JSON.stringify(newRunState("main", { kind }, { rehearsal })), steps: 3, costUsd: usd, createdAt: at, updatedAt: at, finishedAt: at,
  });
}

describe("a run's start weighs its own lane", () => {
  it("the prod week: a week's plan starts — the rehearsals' $11.79 is not the athlete's", async () => {
    await prodWeek();
    const res = await create({ scope: { kind: "week" }, request: "Plan my week" });
    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(false);
  });

  it("a rehearsal's cost is never measured as what the athlete's run costs", async () => {
    // Three rehearsals at $5 each would make the athlete's median $5 — over the $1 the week has left.
    for (let i = 0; i < 3; i++) await finishedRun("now", 5, true);
    await usage("design_main", LLM_BUDGET.cutoffMicros - 1_000_000);
    expect((await create({ scope: { kind: "now" }, request: "hips" })).status).toBe(200);
  });

  it("a rehearsal over its own cap never starts: 409 rehearsal_budget, nothing started — the athlete's cap untouched", async () => {
    await usage(`${REHEARSAL_USAGE_PREFIX}design_main`, DEV_BUDGET.capMicros - 100_000);
    const res = await create({ scope: { kind: "now" }, request: "hips", rehearsal: true });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "rehearsal_budget", spentUsd: (DEV_BUDGET.capMicros - 100_000) / 1_000_000, capUsd: DEV_BUDGET.capMicros / 1_000_000 });
    expect(await db.select().from(schema.coachRuns)).toEqual([]);
    // The athlete's own still starts.
    expect((await create({ scope: { kind: "now" }, request: "hips" })).status).toBe(200);
  });

  it("a rehearsal starts with the athlete's week spent: its lane is its own", async () => {
    await usage("design_main", LLM_BUDGET.cutoffMicros);
    expect((await create({ scope: { kind: "now" }, request: "hips", rehearsal: true })).status).toBe(200);
    expect((await create({ scope: { kind: "now" }, request: "hips" })).status).toBe(409);
  });
});

// ── A run's steps ───────────────────────────────────────────────────────────────────────────────────────────────────

function finishingModel() {
  let calls = 0;
  const callModel = async (): Promise<MessagesResult> => {
    calls += 1;
    return {
      ok: true,
      model: "anthropic/claude-opus-5.5",
      content: [{ type: "text", text: "Done." }],
      stopReason: "end_turn",
      usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 },
      costMicros: 20_000,
    };
  };
  const deps: RunDeps = { callModel, buildContext: { statementCost: 0, build: async () => ({ system: [{ type: "text", text: "S" }], header: "H" }) }, tools: [], clock: () => 0 };
  return { deps, calls: () => calls };
}

/** A run asked and its context built: its next step calls the model. */
async function asked(rehearsal: boolean, deps: RunDeps) {
  const now = new Date();
  const runId = (await createRun(db, userId, { scope: { kind: "now" }, request: "hips", rehearsal }, now)).run.id;
  expect((await runStep(db, ENV, runId, userId, new Date(now.getTime() + 1_000), deps)).kind).toBe("ok");
  return runId;
}
const step = async (runId: string, deps: RunDeps) => {
  const out = await runStep(db, ENV, runId, userId, new Date(Date.now() + 2_000), deps);
  if (out.kind !== "ok") throw new Error(out.kind);
  return out.result.status;
};

describe("a run's steps record and weigh its lane", () => {
  it("a rehearsal's calls are recorded as rehearsal_<kind>; the athlete's under their own kind", async () => {
    const m = finishingModel();
    await step(await asked(true, m.deps), m.deps);
    await step(await asked(false, m.deps), m.deps);
    const kinds = (await db.select().from(schema.llmUsage)).map((u) => u.kind).sort();
    expect(kinds).toEqual(["design_main", `${REHEARSAL_USAGE_PREFIX}design_main`]);
    expect(m.calls()).toBe(2);
    // …and the athlete's week counts one of them.
    expect((await llmBudgetStatus(db, userId)).spentMicros).toBe(20_000);
    expect((await devBudgetStatus(db, userId)).spentMicros).toBe(20_000);
  });

  it("a rehearsal's step stops at the rehearsal cap; the athlete's run goes on past it", async () => {
    const m = finishingModel();
    const rehearsal = await asked(true, m.deps);
    const athlete = await asked(false, m.deps);
    await usage(REPLAY_USAGE_KIND, DEV_BUDGET.capMicros);
    expect(await step(rehearsal, m.deps)).toBe("stopped_cap");
    expect((await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, rehearsal)))[0]).toMatchObject({ error: "weekly_cap" });
    expect(m.calls()).toBe(0);
    expect(await step(athlete, m.deps)).not.toBe("stopped_cap");
    expect(m.calls()).toBe(1);
  });
});

// ── What the athlete sees ───────────────────────────────────────────────────────────────────────────────────────────

describe("the spend report and Settings", () => {
  it("GET /api/coach/spend: the athlete's week as the gate counts it, and rehearsals and replays apart", async () => {
    await prodWeek();
    const res = await mountRoutes(db, "/api/coach", coachRoutes).request("/api/coach/spend", { headers: { Cookie: cookie } }, ENV);
    const body = (await res.json()) as Record<string, any>;
    expect(body.spentMicros).toBe(6_400_000);
    expect(body.spentMicros).toBe((await llmBudgetStatus(db, userId)).spentMicros);
    expect(body.byKind.map((k: { kind: string }) => k.kind).sort()).toEqual(["design_main", "weekly_review"]);
    expect(body.rehearsalAndReplay).toMatchObject({ spentMicros: 11_790_000, spentUsd: 11.79, capMicros: DEV_BUDGET.capMicros });
    expect(body.rehearsalAndReplay.byKind.map((k: { kind: string }) => k.kind).sort()).toEqual([
      REPLAY_USAGE_KIND,
      `${REHEARSAL_USAGE_PREFIX}design_main`,
      `${REHEARSAL_USAGE_PREFIX}design_review`,
      `${REHEARSAL_USAGE_PREFIX}design_workout`,
    ]);
  });

  const settings = async () =>
    (await (await mountRoutes(db, "/api/settings", settingsRoutes).request("/api/settings", { headers: { Cookie: cookie } }, ENV)).json()) as {
      llm: { spentDollars: number; autoReadsPaused: boolean };
    };

  it("GET /api/settings says when the automatic reads are paused — by the athlete's own spend only", async () => {
    await prodWeek();
    expect((await settings()).llm).toMatchObject({ spentDollars: 6.4, autoReadsPaused: false });
    await usage("studio_generate", AUTO_READ_RESERVE_MICROS - 6_400_000);
    expect((await settings()).llm).toMatchObject({ autoReadsPaused: true });
  });
});
