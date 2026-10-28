/**
 * `/api/coach/runs` — the coach designer's routes (Stage 3 Task 2): inert in production until the owner turns them
 * on, and every request within the Workers Free budget (≤ 45 D1 statements + fetches, the model call one fetch).
 *
 * The model is scripted; no key, no network. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import {
  CONTEXT_STATEMENT_BUDGET,
  MAX_TOOL_CALLS_PER_STEP,
  EVENTS_PER_INSERT,
  MODEL_STEP_FIXED,
  PENDING_STEP_FIXED,
  ROUTE_OVERHEAD,
  STEP_BUDGET,
  type ContextBuilder,
  type RunDeps,
} from "../src/services/coach-runs.js";
import type { DesignTool, ToolContext } from "../src/services/design-tools/types.js";
import { designContextBuilder } from "../src/services/design-context.js";
import type { ContentBlock, MessagesOk, MessagesRequest, MessagesResult } from "../src/services/llm-messages.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { savedMoveDraft, seedSavedBatch } from "./saves-batch-fixture.js";

const BUDGET = 45;

function makeEnv(extra: Partial<Env> = {}): Env {
  return {
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
    ...extra,
  } as Env;
}
const ON = makeEnv({ COACH_DESIGNER: "1" });

let seq = 0;
const use = (name: string, input: unknown = {}): ContentBlock => ({ type: "tool_use", id: `toolu_r${++seq}`, name, input });
const answer = (content: ContentBlock[], stopReason: MessagesOk["stopReason"] = "tool_use"): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [{ type: "thinking", thinking: "", signature: `sig-${++seq}` }, ...content],
  stopReason,
  usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 50, outputTokens: 40 },
  costMicros: 1_000,
});

function costly(name: string, cost: number, extra: Partial<DesignTool> = {}): DesignTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    statementCost: cost,
    cpuWeight: 0,
    roles: ["main"],
    async run(ctx) {
      for (let i = 0; i < cost; i++) await ctx.db.all(sql`select 1`);
      return { data: { ok: true }, summary: `Used ${name}` };
    },
    ...extra,
  };
}

let db: Db;
let userId: string;
let cookie: string;
let statements = 0;
let fetches = 0;
let turns: Array<MessagesResult | (() => Promise<MessagesResult>)> = [];
let tools: DesignTool[] = [];
let context: ContextBuilder;

const deps = (): RunDeps => ({
  callModel: async (_env: Env, _req: MessagesRequest) => {
    fetches += 1;
    const next = turns.shift();
    if (!next) throw new Error("the scripted model ran out of turns");
    return typeof next === "function" ? next() : next;
  },
  buildContext: context,
  tools,
});

const app = () => mountRoutes(db, "/api/coach/runs", makeCoachRunRoutes(deps));

async function call(method: string, path: string, body?: unknown, env: Env = ON, withCookie = true) {
  const res = await app().request(
    `/api/coach/runs${path}`,
    {
      method,
      headers: { ...(withCookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

/** The request's cost: every statement (requireUser's included) and every model fetch. */
async function measured(method: string, path: string, body?: unknown) {
  statements = 0;
  fetches = 0;
  const res = await call(method, path, body);
  return { ...res, cost: statements + fetches };
}

/** A proposal whose first promote loses its `ops IS` guard to a late verdict (another request's write, uncounted): the
 * promote reads again and writes again (fix wave 3A round 2, A-M3) — a stop's whole reserve spent. */
let raceFirstPromoteOf: string | null = null;
let injecting = false;

beforeEach(async () => {
  raceFirstPromoteOf = null;
  db = makeTestDb({
    boundVariableCap: 100,
    onStatement: (text) => {
      if (injecting) return;
      statements += 1;
      if (raceFirstPromoteOf && text.includes("SET status = 'pending', ops =")) {
        injecting = true;
        (db as unknown as { $client: { prepare: (s: string) => { run: (...a: unknown[]) => unknown } } }).$client
          .prepare("UPDATE coach_proposals SET ops = json_set(ops, '$[0].review.note', 'late') WHERE id = ?")
          .run(raceFirstPromoteOf);
        injecting = false;
        raceFirstPromoteOf = null;
      }
    },
  });
  ({ userId } = await makeTestUser(db));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  turns = [];
  tools = [];
  context = {
    statementCost: 1,
    async build() {
      await db.all(sql`select 1`);
      return { system: [{ type: "text", text: "SYSTEM" }], header: "HEADER" };
    },
  };
});

describe("inert in production", () => {
  it("every route answers 404 unless COACH_DESIGNER is 1 or this is staging — signed in or not", async () => {
    const off = makeEnv();
    for (const [method, path] of [
      ["POST", ""],
      ["POST", "/r1/step"],
      ["GET", "/r1"],
      ["POST", "/r1/answer"],
      ["POST", "/r1/cancel"],
    ] as const) {
      expect((await call(method, path, method === "POST" ? {} : undefined, off)).status).toBe(404);
      expect((await call(method, path, method === "POST" ? {} : undefined, off, false)).status).toBe(404);
      expect((await call(method, path, method === "POST" ? {} : undefined, makeEnv({ COACH_DESIGNER: "0" }))).status).toBe(404);
    }
    expect(await db.select().from(schema.coachRuns)).toHaveLength(0);
  });

  it("on (the flag, or staging), it signs in first", async () => {
    expect((await call("POST", "", { scope: { kind: "now" } }, ON, false)).status).toBe(401);
    expect((await call("POST", "", { scope: { kind: "now" } }, makeEnv({ STAGING: "1" }))).status).toBe(200);
  });

  it("through the Worker's own entry: /api/coach/runs is a 404 before the coach's sign-in can answer 401", async () => {
    const entry = (await import("../src/index.js")).default;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const off = await entry.fetch(new Request("https://app.test/api/coach/runs", { method: "POST", body: "{}" }), makeEnv(), ctx);
    expect(off.status).toBe(404);
    const offGet = await entry.fetch(new Request("https://app.test/api/coach/runs/r1"), makeEnv(), ctx);
    expect(offGet.status).toBe(404);
    // The coach's own routes are untouched.
    expect((await entry.fetch(new Request("https://app.test/api/coach/state"), makeEnv(), ctx)).status).toBe(401);
    // On, the runs' own sign-in answers.
    expect((await entry.fetch(new Request("https://app.test/api/coach/runs/r1"), ON, ctx)).status).toBe(401);
  });

  it("production's config turns it on (the owner's go-live, 2026-10-16), staging leaves it to its own switch; local dev and the fixture stack do", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    const [production, staging] = toml.split(/^\[env\.staging\]$/m) as [string, string];
    expect(production.match(/^\s*COACH_DESIGNER\s*=.*$/gm)).toEqual(['COACH_DESIGNER = "1"']);
    expect(staging).not.toMatch(/COACH_DESIGNER/);
    expect(readFileSync(new URL("../wrangler.dev.toml", import.meta.url), "utf8")).toMatch(/^COACH_DESIGNER = "1"$/m);
    expect(readFileSync(new URL("../.dev.vars.example", import.meta.url), "utf8")).toMatch(/^COACH_DESIGNER=1$/m);
    expect(readFileSync(new URL("../../web/e2e/fixture-stack.sh", import.meta.url), "utf8")).toContain("--var COACH_DESIGNER:1");
  });
});

describe("the routes", () => {
  it("create → step → read → answer → step to finish → cancel is idempotent", async () => {
    tools = [
      costly("read_day", 1),
      {
        ...costly("ask_athlete", 0),
        control: "ask",
        async run(_ctx, input: { questions: Array<{ text: string }> }) {
          return { data: input, summary: input.questions[0]!.text };
        },
      },
      {
        ...costly("finish", 0),
        control: "finish",
        async run() {
          return { data: {}, summary: "Designed it." };
        },
      },
    ];
    turns = [
      answer([use("read_day"), use("ask_athlete", { questions: [{ text: "Home or gym?", chips: ["Home", "Gym"] }] })]),
      answer([use("finish", { summary: "Designed it." })]),
    ];
    const created = await call("POST", "", { scope: { kind: "now" }, request: "hips" });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ existing: false, run: { status: "active", request: "hips", scope: { kind: "now" } } });
    const id = created.body.run.id as string;
    expect((await call("POST", "", { scope: { kind: "week" }, request: "my week" })).body).toEqual({
      run: expect.objectContaining({ id, request: "hips", scope: { kind: "now" } }),
      existing: true,
      conversationId: id,
      offer: "continue_or_cancel",
      ignoredRequest: { scope: { kind: "week" }, request: "my week" },
    });

    expect((await call("POST", `/${id}/step`)).body).toMatchObject({ status: "active", nextDue: { runId: id, role: "main" } });
    const asked = await call("POST", `/${id}/step`);
    expect(asked.body).toMatchObject({ status: "waiting_athlete", nextDue: null });
    expect(asked.body.events.at(-1)).toMatchObject({ kind: "question", summary: "Home or gym?" });

    const read = await call("GET", `/${id}?afterSeq=1`);
    expect(read.status).toBe(200);
    expect(read.body.run).toMatchObject({ id, status: "waiting_athlete" });
    expect(read.body.events[0].seq).toBe(2);

    expect((await call("POST", `/${id}/answer`, { answers: ["Home"] })).body.run.status).toBe("active");
    expect((await call("POST", `/${id}/answer`, { answers: ["Home"] })).status).toBe(409);
    expect((await call("POST", `/${id}/step`)).body.status).toBe("finished");

    const cancelled = await call("POST", `/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.run.status).toBe("finished");
  });

  it("refuses a malformed request with 400", async () => {
    // No scope is the athlete's default (Settings → Coach, Task 10: coach-preferences.test.ts); a body that isn't one,
    // or a scope that isn't one, is refused.
    expect((await call("POST", "", [])).status).toBe(400);
    expect((await call("POST", "", { scope: null })).status).toBe(400);
    expect((await call("POST", "", { scope: { kind: "forever" } })).status).toBe(400);
    expect((await call("POST", "", { scope: { kind: "next_n", n: 0 } })).status).toBe(400);
    expect((await call("POST", "", { scope: { kind: "now" }, request: 42 })).status).toBe(400);
    expect((await call("POST", "", { scope: { kind: "now" }, request: "x".repeat(2_001) })).status).toBe(400);
    expect((await call("POST", "", { scope: { kind: "now" }, rehearsal: "yes" })).status).toBe(400);
    const id = (await call("POST", "", { scope: { kind: "now" } })).body.run.id as string;
    expect((await call("POST", `/${id}/answer`, {})).status).toBe(400);
    expect((await call("POST", `/${id}/answer`, { answers: [] })).status).toBe(400);
    expect((await call("POST", `/${id}/answer`, { answers: ["a", "b", "c"] })).status).toBe(400);
    expect((await call("POST", `/${id}/answer`, { answers: ["x".repeat(501)] })).status).toBe(400);
    expect((await call("GET", `/${id}?afterSeq=-1`)).status).toBe(400);
  });

  it("404s a run that is not the athlete's, or not a main run", async () => {
    const other = await makeTestUser(db);
    const theirs = (await call("POST", "", { scope: { kind: "now" } })).body.run.id as string;
    cookie = `${SESSION_COOKIE}=${await createSession(db, other.userId)}`;
    for (const [method, path] of [
      ["POST", `/${theirs}/step`],
      ["GET", `/${theirs}`],
      ["POST", `/${theirs}/cancel`],
    ] as const) {
      expect((await call(method, path)).status).toBe(404);
    }
    expect((await call("POST", `/${theirs}/answer`, { answers: ["x"] })).status).toBe(404);
  });

  it("a second step while one is in flight answers 409", async () => {
    let release!: (r: MessagesResult) => void;
    turns = [() => new Promise<MessagesResult>((r) => (release = r))];
    tools = [{ ...costly("finish", 0), control: "finish", async run() { return { data: {}, summary: "Done." }; } }];
    const id = (await call("POST", "", { scope: { kind: "now" } })).body.run.id as string;
    await call("POST", `/${id}/step`);
    const first = call("POST", `/${id}/step`);
    await new Promise((r) => setTimeout(r, 5));
    const second = await call("POST", `/${id}/step`);
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "busy" });
    release(answer([use("finish", { summary: "Done." })]));
    expect((await first).body.status).toBe("finished");
  });
});

describe("every request within the budget", () => {
  it("the budget arithmetic leaves the tools their room", () => {
    expect(STEP_BUDGET).toBe(BUDGET);
    expect(ROUTE_OVERHEAD + MODEL_STEP_FIXED).toBeLessThan(BUDGET);
    expect(ROUTE_OVERHEAD + PENDING_STEP_FIXED).toBeLessThan(BUDGET);
  });

  it("create, new and existing", async () => {
    const created = await measured("POST", "", { scope: { kind: "now" }, request: "x" });
    expect(created.status).toBe(200);
    expect(created.cost).toBeLessThanOrEqual(BUDGET);
    const again = await measured("POST", "", { scope: { kind: "now" } });
    expect(again.body.existing).toBe(true);
    expect(again.cost).toBeLessThanOrEqual(BUDGET);
  });

  it("create over a live run whose window closed: the run expired with its lines and its unreviewed proposal closed, the new one started — about ten", async () => {
    const id = (await call("POST", "", { scope: { kind: "now" } })).body.run.id as string;
    const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
    const state = JSON.parse(row!.state!) as { settings: Record<string, unknown> };
    state.settings.window = { kind: "day", date: "2000-01-01" };
    await db.update(schema.coachRuns).set({ state: JSON.stringify(state) }).where(eq(schema.coachRuns.id, id));
    const created = await measured("POST", "", { scope: { kind: "now" }, request: "today" });
    expect(created.body).toMatchObject({ existing: false, run: { request: "today" } });
    // One more since fix wave 3A (A2): the expiry reads its proposal first, to propose what was reviewed; one more since
    // Task 13's fix wave (§2.11): the week's spend is read before a run starts.
    expect(created.cost).toBeLessThanOrEqual(11);
    const [old] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
    expect(old!.status).toBe("expired");
  });

  it("the context step, with a context that spends its whole allowance", async () => {
    context = {
      statementCost: CONTEXT_STATEMENT_BUDGET,
      async build(cdb) {
        for (let i = 0; i < CONTEXT_STATEMENT_BUDGET; i++) await cdb.all(sql`select 1`);
        return { system: [{ type: "text", text: "S" }], header: "H" };
      },
    };
    const id = (await call("POST", "", { scope: { kind: "now" } })).body.run.id as string;
    const step = await measured("POST", `/${id}/step`);
    expect(step.status).toBe(200);
    expect(step.cost).toBeLessThanOrEqual(BUDGET);
    expect(step.cost).toBeGreaterThanOrEqual(BUDGET - 2);
  });

  it("a model step whose tools fill the room, and a rehearsal's finish on top", async () => {
    const room = BUDGET - ROUTE_OVERHEAD - MODEL_STEP_FIXED;
    const n = MAX_TOOL_CALLS_PER_STEP - 1;
    const costs = Array.from({ length: n }, (_, i) => Math.floor(room / n) + (i < room % n ? 1 : 0));
    expect(costs.reduce((a, b) => a + b, 0)).toBe(room);
    const proposalId = newId();
    await db.insert(schema.coachProposals).values({
      id: proposalId,
      userId,
      title: "t",
      evidence: "",
      rationale: "",
      flags: [],
      ops: [],
      status: "pending",
      expiresAt: "2999-01-01",
      createdAt: new Date().toISOString(),
    });
    tools = [
      ...costs.map((c, i) => costly(`t${i}`, c)),
      { ...costly("finish", 0), control: "finish", async run() { return { data: { proposalId }, summary: "Done." }; } },
    ];
    turns = [answer([...costs.map((_, i) => use(`t${i}`)), use("finish")])];
    const id = (await call("POST", "", { scope: { kind: "now" }, rehearsal: true })).body.run.id as string;
    await call("POST", `/${id}/step`); // context
    const step = await measured("POST", `/${id}/step`);
    expect(step.body.status).toBe("finished");
    expect(step.cost).toBeLessThanOrEqual(BUDGET);
    // The step's end reserve is a stop's proposal (five, since round 2's read-again; six since the saves flow redesigned
    // §12.1, its supersede's fit release; seven since workout editability §7, a fit's own batch handed back): a finish's
    // write uses one of it.
    expect(step.cost).toBe(BUDGET - 6);
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, proposalId));
    expect(p!.status).toBe("rehearsal");
  });

  it("a finish's worst case: tools fill the room, a rehearsal's finish, and a cancel that lands while the tools run (the claim lost)", async () => {
    const room = BUDGET - ROUTE_OVERHEAD - MODEL_STEP_FIXED;
    const n = MAX_TOOL_CALLS_PER_STEP - 1;
    const costs = Array.from({ length: n }, (_, i) => Math.floor(room / n) + (i < room % n ? 1 : 0));
    const proposalId = newId();
    await db.insert(schema.coachProposals).values({
      id: proposalId,
      userId,
      title: "t",
      evidence: "",
      rationale: "",
      flags: [],
      ops: [],
      status: "pending",
      expiresAt: "2999-01-01",
      createdAt: new Date().toISOString(),
    });
    let runId = "";
    tools = [
      // The first tool's last declared statement is the cancel landing (another request's, in life).
      {
        ...costly("t0", costs[0]!),
        async run(ctx) {
          for (let i = 0; i < costs[0]! - 1; i++) await ctx.db.all(sql`select 1`);
          await ctx.db.update(schema.coachRuns).set({ status: "cancelled" }).where(eq(schema.coachRuns.id, runId));
          return { data: {}, summary: "t0" };
        },
      },
      ...costs.slice(1).map((c, i) => costly(`t${i + 1}`, c)),
      { ...costly("finish", 0), control: "finish", async run() { return { data: { proposalId }, summary: "Done." }; } },
    ];
    turns = [answer([...costs.map((_, i) => use(`t${i}`)), use("finish")])];
    runId = (await call("POST", "", { scope: { kind: "now" }, rehearsal: true })).body.run.id as string;
    await call("POST", `/${runId}/step`); // context
    const step = await measured("POST", `/${runId}/step`);
    expect(step.status).toBe(200);
    expect(step.body.status).toBe("cancelled");
    expect(step.cost).toBeLessThanOrEqual(BUDGET);
    // A finish's write and a lost claim's spend use two of the end reserve (seven since workout editability §7); a stop's
    // proposal, the larger, the whole of it (the stop's worst case below).
    expect(step.cost).toBe(BUDGET - 5);
    expect(step.body.events.length).toBeLessThanOrEqual(EVENTS_PER_INSERT);
  });

  /**
   * The stop's whole reserve (the saves flow redesigned §12.1): an older card of the moves in rotation, pending, naming a
   * saved batch whose fit began before the card was made — and the `move_pins` op the stopping proposal holds beside its
   * reviewed workout, naming the same move, so its supersede releases that fit (one statement more). Synthetic ids.
   */
  async function fittingPinsCard(runId: string) {
    const batchId = `batch-${runId}`;
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const pins = (id: string) => ({
      kind: "move_pins", id, pin: ["zorbexHipCircle"], unpin: [], batchId, why: "w", title: "t", summary: "s", lines: [],
      date: "2999-01-01", toolUseId: `u-${id}`, at: ago(0),
    });
    await db.insert(schema.saveBatches).values({ id: batchId, userId, status: "saved", createdAt: ago(300_000), savedAt: ago(120_000), fitStartedAt: ago(120_000) });
    await db.insert(schema.coachProposals).values({
      id: `older-${runId}`, userId, title: "t", evidence: "", rationale: "", flags: [], ops: [pins(`pins-older-${runId}`)],
      status: "pending", expiresAt: "2999-01-01", createdAt: ago(60_000),
    });
    const fitOf = async () => (await db.select().from(schema.saveBatches).where(eq(schema.saveBatches.id, batchId)))[0]!.fitStartedAt;
    return { op: pins(`pins-${runId}`), fitOf };
  }

  /**
   * The stop's last statement (workout editability §7): the run a fit's — a saved batch of its own, its fit begun before
   * the run was made — so its stop hands that batch back (its card names another batch). Synthetic ids.
   */
  let fits = 0;
  async function fitRunCreate() {
    const batchId = `fit-batch-${++fits}`;
    const ago = new Date(Date.now() - 60_000).toISOString();
    await db.insert(schema.saveBatches).values({ id: batchId, userId, status: "saved", createdAt: ago, savedAt: ago, fitStartedAt: ago });
    const id = (await call("POST", "", { scope: { kind: "now" }, savesBatchId: batchId })).body.run.id as string;
    const fitOf = async () => (await db.select().from(schema.saveBatches).where(eq(schema.saveBatches.id, batchId)))[0]!.fitStartedAt;
    return { id, fitOf };
  }

  it("the stop's worst case (fix wave 3A, A2): tools fill the room, their results take the state past its cap, and the run stops proposing its reviewed draft — exactly the budget", async () => {
    const room = BUDGET - ROUTE_OVERHEAD - MODEL_STEP_FIXED;
    const n = MAX_TOOL_CALLS_PER_STEP - 1;
    const costs = Array.from({ length: n }, (_, i) => Math.floor(room / n) + (i < room % n ? 1 : 0));
    // Each answers near the loop's cut (8 KB), so their results take a near-full state past STATE_MAX_BYTES.
    tools = costs.map((c, i) => ({
      ...costly(`t${i}`, c),
      async run(ctx) {
        for (let k = 0; k < c; k++) await ctx.db.all(sql`select 1`);
        return { data: { rows: "r".repeat(7_800) }, summary: `t${i}` };
      },
    }));
    turns = [answer(costs.map((_, i) => use(`t${i}`)))];
    const fit = await fitRunCreate();
    const id = fit.id;
    await call("POST", `/${id}/step`); // context
    const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
    const state = JSON.parse(row!.state!) as { messages: Array<{ content: Array<{ text: string }> }> };
    state.messages[0]!.content[0]!.text += "p".repeat(185_000);
    await db.update(schema.coachRuns).set({ state: JSON.stringify(state) }).where(eq(schema.coachRuns.id, id));
    const today = new Date().toISOString().slice(0, 10);
    const op = {
      kind: "doc_workout",
      target: { kind: "new", date: "2999-01-01" },
      date: "2999-01-01",
      doc: { title: "Calm hips", intent: { summary: "Calm the hips." }, parts: [] },
      review: { scores: { intent: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] },
      issues: [],
      derived: { minutes: 20 },
      by: { runId: id, role: "main" },
      toolUseId: "u",
      at: today,
    };
    const card = await fittingPinsCard(id);
    await db.insert(schema.coachProposals).values({
      id: `dp-${id}`,
      userId,
      title: "Calm hips",
      evidence: "",
      rationale: "",
      flags: [],
      ops: [op, card.op],
      status: "unreviewed",
      expiresAt: "2999-01-01",
      createdAt: new Date().toISOString(),
    });
    raceFirstPromoteOf = `dp-${id}`;
    const step = await measured("POST", `/${id}/step`);
    expect(step.body.status).toBe("stopped_cap");
    expect(raceFirstPromoteOf).toBeNull();
    expect(step.body.events.map((e: { summary: string }) => e.summary).slice(-2)).toEqual([
      "This design grew too long to continue — the coach stopped.",
      "Suggested what had been reviewed before the stop.",
    ]);
    // Every tool ran (the room), then the run's write, the proposal read, its write (which lost to a late verdict), the
    // read again, the write again, the older plans superseded, the superseded saves card's fit released (the saves flow
    // redesigned §12.1), the fit's own batch handed back (workout editability §7), the lines: the step's end reserve
    // spent whole.
    expect(step.cost).toBe(BUDGET);
    expect(await card.fitOf()).toBeNull();
    expect(await fit.fitOf()).toBeNull();
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, `dp-${id}`));
    expect(p!.status).toBe("pending");
  });

  it("the queued calls' stop (round 2, A-M8): queued calls fill a step's room, their results take the state past its cap, and the run stops proposing — the late verdict read again — exactly the budget", async () => {
    const room = BUDGET - ROUTE_OVERHEAD - PENDING_STEP_FIXED;
    const n = MAX_TOOL_CALLS_PER_STEP;
    const costs = Array.from({ length: n }, (_, i) => Math.floor(room / n) + (i < room % n ? 1 : 0));
    expect(costs.reduce((x, y) => x + y, 0)).toBe(room);
    tools = costs.map((c, i) => ({
      ...costly(`q${i}`, c),
      async run(ctx) {
        for (let k = 0; k < c; k++) await ctx.db.all(sql`select 1`);
        return { data: { rows: "r".repeat(7_800) }, summary: `q${i}` };
      },
    }));
    const fit = await fitRunCreate();
    const id = fit.id;
    await call("POST", `/${id}/step`); // context
    // The model asked for the calls in a step that was left; they wait, queued, in a state near its cap.
    const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
    const state = JSON.parse(row!.state!) as { messages: unknown[]; pending: unknown[]; calls: number };
    const uses = costs.map((_, i) => ({ type: "tool_use", id: `toolu_q${i}`, name: `q${i}`, input: {} }));
    // Near enough the cap that the step's results (MAX_TOOL_CALLS_PER_STEP of them, ~7.8 KB each) take it past: 165 KB
    // since a step runs five (it was 150 KB when a step ran eight).
    (state.messages[0] as { content: Array<{ text: string }> }).content[0]!.text += "p".repeat(165_000);
    state.messages.push({ role: "assistant", content: uses });
    state.pending = uses.map((u) => ({ id: u.id, name: u.name, input: {} }));
    state.calls = 1;
    await db.update(schema.coachRuns).set({ state: JSON.stringify(state) }).where(eq(schema.coachRuns.id, id));
    const op = {
      kind: "doc_workout",
      target: { kind: "new", date: "2999-01-01" },
      date: "2999-01-01",
      doc: { title: "Calm hips", intent: { summary: "Calm the hips." }, parts: [] },
      review: { scores: { intent: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] },
      issues: [],
      derived: { minutes: 20 },
      by: { runId: id, role: "main" },
      toolUseId: "u",
      at: new Date().toISOString(),
    };
    const card = await fittingPinsCard(id);
    await db.insert(schema.coachProposals).values({
      id: `dp-${id}`,
      userId,
      title: "Calm hips",
      evidence: "",
      rationale: "",
      flags: [],
      ops: [op, card.op],
      status: "unreviewed",
      expiresAt: "2999-01-01",
      createdAt: new Date().toISOString(),
    });
    raceFirstPromoteOf = `dp-${id}`;
    const step = await measured("POST", `/${id}/step`);
    expect(step.body.status).toBe("stopped_cap");
    expect(fetches).toBe(0);
    expect(raceFirstPromoteOf).toBeNull();
    expect(step.body.events.map((e: { summary: string }) => e.summary).slice(-2)).toEqual([
      "This design grew too long to continue — the coach stopped.",
      "Suggested what had been reviewed before the stop.",
    ]);
    // The route's two, the tree, the claim, the standing read, every queued call (the room), the run's write, the
    // proposal read, its write (lost), the read again, the write again, the older plans superseded, the superseded saves
    // card's fit released (the saves flow redesigned §12.1), the fit's own batch handed back (workout editability §7),
    // the lines.
    expect(step.cost).toBe(BUDGET);
    expect(await card.fitOf()).toBeNull();
    expect(await fit.fitOf()).toBeNull();
    const [p] = await db.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, `dp-${id}`));
    expect(p!.status).toBe("pending");
  });

  it("the context step with Task 3's own context", async () => {
    context = designContextBuilder;
    const id = (await call("POST", "", { scope: { kind: "next_n", n: 3 }, request: "my next three" })).body.run.id as string;
    const step = await measured("POST", `/${id}/step`);
    expect(step.status).toBe(200);
    expect(step.cost).toBeLessThanOrEqual(BUDGET);
  });

  it("a step of queued calls that fill its room", async () => {
    const room = BUDGET - ROUTE_OVERHEAD - PENDING_STEP_FIXED;
    tools = [costly("big", Math.ceil(room / 2)), costly("rest", Math.floor(room / 2))];
    // The model step runs what fits of the first and queues the rest; the next step runs exactly `room`.
    turns = [answer([use("big"), use("big"), use("rest")])];
    const id = (await call("POST", "", { scope: { kind: "now" } })).body.run.id as string;
    await call("POST", `/${id}/step`); // context
    await call("POST", `/${id}/step`); // model + what fits
    const state = JSON.parse((await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id)))[0]!.state!) as { pending: unknown[] };
    expect(state.pending.length).toBeGreaterThan(0);
    const pending = await measured("POST", `/${id}/step`);
    expect(pending.status).toBe(200);
    expect(fetches).toBe(0);
    expect(pending.cost).toBeLessThanOrEqual(BUDGET);
  });

  it("read, answer and cancel", async () => {
    tools = [
      {
        ...costly("ask_athlete", 0),
        control: "ask",
        async run(_ctx, input: unknown) {
          return { data: input, summary: "Q?" };
        },
      },
    ];
    turns = [answer([use("ask_athlete", { questions: [{ text: "Q?" }] })])];
    const id = (await call("POST", "", { scope: { kind: "now" } })).body.run.id as string;
    await call("POST", `/${id}/step`);
    await call("POST", `/${id}/step`);
    const read = await measured("GET", `/${id}`);
    expect(read.status).toBe(200);
    expect(read.cost).toBeLessThanOrEqual(BUDGET);
    const answered = await measured("POST", `/${id}/answer`, { answers: ["A"] });
    expect(answered.status).toBe(200);
    expect(answered.cost).toBeLessThanOrEqual(BUDGET);
    const cancelled = await measured("POST", `/${id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.cost).toBeLessThanOrEqual(BUDGET);
  });
});

describe("the fit-in run is told its batch (saves flow redesign, §12.1)", () => {
  const SAVED = "2026-09-20T18:00:00.000Z";
  const stateOf = async (id: string) =>
    JSON.parse((await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, id)))[0]!.state!) as { settings: Record<string, unknown> };
  /** A saved batch: one new move included, one skipped, one on the coach's call, and a library move it named. */
  const fitBatch = (user = userId, status: "saved" | "released" = "saved") =>
    seedSavedBatch(db, user, {
      savedAt: SAVED,
      status,
      posts: [
        {
          moves: [
            { draft: savedMoveDraft("Zorbex hip circle"), choice: "include" },
            { draft: savedMoveDraft("Zorbex neck nod"), choice: "skip" },
            { draft: savedMoveDraft("Zorbex calf rock") },
            { library: "gobletSquat" },
          ],
        },
      ],
    });

  it("a fit-in create carries its batch and skip set into the run's settings — one more statement", async () => {
    const { batchId, moveIds } = await fitBatch();
    const skipped = { id: moveIds[0]![1]!, name: "Zorbex neck nod" };
    const base = await measured("POST", "", { scope: { kind: "now" }, request: "Fit them in." });
    expect(base.status).toBe(200);
    expect((await stateOf(base.body.run.id as string)).settings).not.toHaveProperty("savesBatchId");
    await call("POST", `/${base.body.run.id}/cancel`);

    const fit = await measured("POST", "", { scope: { kind: "now" }, request: "Fit them in.", savesBatchId: batchId });
    expect(fit.status).toBe(200);
    expect(fit.body.existing).toBe(false);
    // The batch and its skip set, read in one statement (saves-batches.ts skipSetOf).
    expect(fit.cost).toBe(base.cost + 1);
    expect(fit.cost).toBeLessThanOrEqual(BUDGET);
    const id = fit.body.run.id as string;
    expect((await stateOf(id)).settings).toMatchObject({ savesBatchId: batchId, savesSkip: [skipped] });

    // Its tools are told — and so are a designer's it starts, which inherits both; never more than the main run's.
    const seen: ToolContext["run"][] = [];
    tools = [
      {
        ...costly("peek", 0),
        roles: ["main", "designer"],
        async run(ctx) {
          seen.push(ctx.run);
          if (ctx.run.role === "main") await ctx.set!.start([{ runId: `${ctx.run.id}-d1`, key: "a", brief: "Calm hips.", date: "2026-09-22" }]);
          return { data: {}, summary: "Peeked." };
        },
      },
    ];
    turns = [answer([use("peek")]), answer([use("peek")])];
    await call("POST", `/${id}/step`); // the main run's context
    await call("POST", `/${id}/step`); // its model step: peek starts a designer
    expect((await stateOf(`${id}-d1`)).settings).toMatchObject({ savesBatchId: batchId, savesSkip: [skipped] });
    await call("POST", `/${id}/step`); // the designer's context
    await call("POST", `/${id}/step`); // its model step: peek
    expect(seen.map((r) => [r.role, r.savesBatchId, r.savesSkip])).toEqual([
      ["main", batchId, [skipped]],
      ["designer", batchId, [skipped]],
    ]);
  });

  it("another account's or an unsaved batch is 404 saves_batch_not_found, and nothing starts; a non-string is 400 bad_saves_batch", async () => {
    const other = await makeTestUser(db);
    const theirs = await fitBatch(other.userId);
    const released = await fitBatch(userId, "released");
    for (const savesBatchId of [theirs.batchId, released.batchId, "batch-nobody-has"]) {
      const res = await call("POST", "", { scope: { kind: "now" }, request: "Fit them in.", savesBatchId });
      expect(res.status, savesBatchId).toBe(404);
      expect(res.body, savesBatchId).toEqual({ error: "saves_batch_not_found" });
    }
    for (const savesBatchId of [42, null, true, { id: released.batchId }, [released.batchId], "", "has space", "x".repeat(101)]) {
      const res = await call("POST", "", { scope: { kind: "now" }, savesBatchId });
      expect(res.status, JSON.stringify(savesBatchId)).toBe(400);
      expect(res.body, JSON.stringify(savesBatchId)).toEqual({ error: "bad_saves_batch" });
    }
    expect(await db.select().from(schema.coachRuns)).toHaveLength(0);
    // The account's own saved batch starts one.
    const mine = await fitBatch();
    expect((await call("POST", "", { scope: { kind: "now" }, savesBatchId: mine.batchId })).status).toBe(200);
  });
});
