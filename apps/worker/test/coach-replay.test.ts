/**
 * THE VOICE WORKSHOP'S REPLAY (`POST /api/coach/replay`, `GET /api/coach/replay/runs`; coach-replay.ts, coach-voice.ts):
 * a finished main run's athlete-facing step — its finish, its question, or its workout's words — called again on the
 * run's own stored context, once per voice variant, and only the coach's words answered.
 *
 * Pinned here: a variant with no variable set sends the production request byte for byte (a run driven to its finish
 * through the real client, then replayed through the same transport); each variable's words land in one block after
 * the cached prefix, which is unchanged; the gate (the switch, the owner, the exact confirm, enums only); ownership;
 * the weekly cap and the request's own cap; the first call alone, then the rest (the prefix cached once); nothing
 * written but `llm_usage`; the listing's shape; and every request's statements and fetches (≤ 45).
 *
 * The model is a stub: no key, no network. Synthetic data only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeCoachReplayRoutes } from "../src/routes/coach-replay.js";
import { coachRoutes } from "../src/routes/coach.js";
import { answerRun, createRun, endedLine, runStep, type RunDeps } from "../src/services/coach-runs.js";
import { readConversation } from "../src/services/coach-conversation.js";
import {
  REPLAY_CONFIRM,
  REPLAY_PROSE_VARIANTS_MAX,
  REPLAY_REQUEST_CAP_MICROS,
  REPLAY_USAGE_KIND,
  REPLAY_WORDS,
  type ReplayDeps,
} from "../src/services/coach-replay.js";
import { VOICE_HEAD, VOICE_INCLUDES, VOICE_LENGTHS, VOICE_LINES, VOICE_PERSONS, VOICE_TONES, voiceBlock } from "../src/services/coach-voice.js";
import { buildDesignContext, designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId } from "../src/services/design-tools/propose.js";
import { LLM_BUDGET, llmBudgetStatus, REPLAY_RESERVATION_STALE_MINUTES } from "../src/services/llm.js";
import { callMessages, DESIGN_MODEL_TIMEOUT_MS, messagesCostMicros, sendMessagesBody, type ContentBlock, type MessagesOk, type MessagesResult } from "../src/services/llm-messages.js";
import { NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, makeTestUser, mountRoutes, untilDone } from "./helpers.js";

const BUDGET = 45;

function makeEnv(owner: string, extra: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ALLOWED_GOOGLE_EMAIL: owner,
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
    COACH_DESIGNER: "1",
    AI_GATEWAY_API_KEY: "test-key",
    ...extra,
  } as Env;
}

// ── The model, at the wire: a fetch that answers scripted messages and keeps every body ──

let seq = 0;
const use = (name: string, input: unknown): ContentBlock => ({ type: "tool_use", id: `toolu_rp${++seq}`, name, input });
const thinking = (): ContentBlock => ({ type: "thinking", thinking: "", signature: `sig-${++seq}-${"x".repeat(30)}` });

interface WireAnswer {
  content: ContentBlock[];
  stop_reason: string;
  usage?: Record<string, number>;
}

function wire(answers: WireAnswer[]) {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(String(init?.body));
    const a = answers.shift();
    if (!a) throw new Error("the scripted wire ran out of answers");
    return new Response(
      JSON.stringify({ content: a.content, stop_reason: a.stop_reason, usage: a.usage ?? { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, bodies };
}
const said = (...uses: ContentBlock[]): WireAnswer => ({ content: [thinking(), { type: "text", text: "Working on it." }, ...uses], stop_reason: "tool_use" });

const DIMS = REVIEW_DIMENSIONS.map((d) => d.id);
const verdict = (score: number) => ({
  scores: Object.fromEntries(DIMS.map((d) => [d, score])) as Record<string, number>,
  notes: Object.fromEntries(DIMS.map((d) => [d, `${d}: as it should be.`])) as Record<string, string>,
  mustFix: [],
  improvements: [],
});

const SHIPPED_LINE = "A calm session for your hips: the glutes first, then the hinge.";
const QUESTION = { text: "How long do you have?", chips: ["20 minutes", "40 minutes"], why: "To size the session." };

/**
 * A "now" run driven to its finish through the REAL client (callMessages over a scripted fetch): it asks how long the
 * athlete has, is answered, proposes a workout, has it reviewed, and finishes. Every request body production sent is
 * kept, in order: [0] the ask, [1] the proposal, [2] the reviewer's, [3] the finish.
 */
async function drivenRun(db: Db, userId: string, env: Env) {
  const { fetchImpl, bodies } = wire([
    said(use("ask_athlete", { questions: [QUESTION] })),
    said(use("propose_workout", { doc: calmDoc({ title: "Calm hips" }), target: { kind: "new", date: TODAY } })),
    said(use("submit_review", verdict(5))),
    said(use("finish", { summary: SHIPPED_LINE })),
  ]);
  const deps: RunDeps = {
    callModel: (e, req) => callMessages(e, req, fetchImpl),
    buildContext: designContextBuilder,
    tools: allTools(),
    review: true,
    clock: () => 0,
  };
  const runId = (await createRun(db, userId, { scope: { kind: "now" }, request: "Something calm for the hips." }, NOW)).run.id;
  let at = NOW.getTime();
  const drive = () =>
    untilDone(
      async () => {
        at += 1000;
        const out = await runStep(db, env, runId, userId, new Date(at), deps);
        if (out.kind !== "ok") throw new Error(`step answered ${out.kind}`);
        return out.result.status !== "active";
      },
      { max: 30, what: "drive" },
    );
  await drive();
  at += 1000;
  expect((await answerRun(db, userId, runId, { answers: ["20 minutes"] }, new Date(at))).kind).toBe("ok");
  await drive();
  const [row] = await db.select().from(schema.coachRuns).where(eq(schema.coachRuns.id, runId));
  expect(row!.status).toBe("finished");
  expect(bodies).toHaveLength(4);
  return { runId, bodies };
}

// ── The replay's model: a stub at the transport, keeping every call ──

let statements = 0;
let fetches = 0;
let calls: Array<{ model: string; body: string; maxTokens: number }> = [];
let replies: Array<MessagesResult | ((body: string) => MessagesResult | Promise<MessagesResult>)> = [];
let order: string[] = [];

const ok = (content: ContentBlock[], o: { costMicros?: number; output?: number; cacheRead?: number; cacheWrite?: number } = {}): MessagesOk => ({
  ok: true,
  model: "anthropic/claude-opus-5.5",
  content: [thinking(), ...content],
  stopReason: "tool_use",
  usage: { inputTokens: 20, cacheReadTokens: o.cacheRead ?? 0, cacheWriteTokens: o.cacheWrite ?? 0, outputTokens: o.output ?? 300 },
  costMicros: o.costMicros ?? 20_000,
});
const finishing = (summary: string, o?: Parameters<typeof ok>[1]) => ok([use("finish", { summary })], o);

const stub = (): ReplayDeps => ({
  send: async (_env, call) => {
    fetches += 1;
    calls.push(call);
    const i = calls.length;
    order.push(`start ${i}`);
    const next = replies.shift() ?? finishing(`Line ${i}.`);
    const out = typeof next === "function" ? await next(call.body) : next;
    order.push(`end ${i}`);
    return out;
  },
  tools: allTools(),
});

let db: Db;
let userId: string;
let email: string;
let cookie: string;
let env: Env;

beforeEach(async () => {
  statements = 0;
  fetches = 0;
  calls = [];
  replies = [];
  order = [];
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await seedRichAthlete(db));
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  email = u!.email;
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  env = makeEnv(email);
});

const app = (deps: () => ReplayDeps = stub, now?: () => Date) => mountRoutes(db, "/api/coach/replay", makeCoachReplayRoutes(deps, now ? { now } : {}));

async function call(method: string, path: string, body?: unknown, o: { env?: Env; cookie?: string | null; deps?: () => ReplayDeps; now?: () => Date } = {}) {
  const c = o.cookie === undefined ? cookie : o.cookie;
  const res = await app(o.deps, o.now).request(
    `/api/coach/replay${path}`,
    {
      method,
      headers: { ...(c ? { Cookie: c } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    o.env ?? env,
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> };
}

async function measured(method: string, path: string, body?: unknown, o: Parameters<typeof call>[3] = {}) {
  statements = 0;
  fetches = 0;
  const res = await call(method, path, body, o);
  return { ...res, cost: statements + fetches };
}

const replay = (runId: string, variants: unknown[], extra: Record<string, unknown> = {}) => ({ confirm: REPLAY_CONFIRM, runId, variants, ...extra });

/** A finished main run written straight in (no drive): its stored state, its last line, and its proposal. */
async function storedRun(
  o: {
    user?: string;
    status?: string;
    parentId?: string | null;
    role?: string;
    rehearsal?: boolean;
    request?: string | null;
    createdAt?: string;
    scope?: Record<string, unknown>;
    line?: string;
    /** The last line as the trail kept it, when it differs from the finish's own words. */
    shown?: string;
    /** Its proposal's ops (given the run's own id when a function). */
    ops?: unknown[] | ((runId: string) => unknown[]);
    proposalStatus?: string;
    asked?: boolean;
    messages?: unknown[];
    /** Its stored system blocks (default: one block). */
    system?: unknown[];
    costUsd?: number;
  } = {},
): Promise<string> {
  const id = newId();
  const owner = o.user ?? userId;
  const messages = o.messages ?? [
    { role: "user", content: [{ type: "text", text: "HEADER: the opening context." }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-a" }, { type: "tool_use", id: "toolu_a1", name: "read_day", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a1", content: "{\"data\":{}}" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-b" }, { type: "tool_use", id: "toolu_a2", name: "finish", input: { summary: o.line ?? "A shipped line." } }] },
  ];
  const state = {
    v: 1,
    settings: { ceilingMicros: 1_500_000, maxCalls: 12, effort: "high", maxTokens: 16_000, rehearsal: o.rehearsal === true, timezone: "UTC" },
    system: o.system ?? [{ type: "text", text: "SYSTEM: the shared prompt.", cache_control: { type: "ephemeral" } }],
    messages,
    pending: [],
    results: [],
    awaiting: null,
    calls: 2,
    retries: 0,
    lastCall: null,
    toldAt: null,
    outputs: [400, 600],
  };
  const at = o.createdAt ?? NOW.toISOString();
  await db.insert(schema.coachRuns).values({
    id,
    userId: owner,
    parentId: o.parentId ?? null,
    role: o.role ?? "main",
    scope: o.scope ?? { kind: "auto" },
    request: o.request === undefined ? "What should I do today?" : o.request,
    status: o.status ?? "finished",
    state: JSON.stringify(state),
    steps: 3,
    costUsd: o.costUsd ?? 0.12,
    createdAt: at,
    updatedAt: at,
    finishedAt: at,
  });
  await db.insert(schema.coachRunEvents).values({
    id: `${id}:1`,
    userId: owner,
    runId: id,
    seq: 1,
    kind: "note",
    summary: o.shown ?? o.line ?? "A shipped line.",
    payload: { final: true },
    at,
  });
  if (o.asked) {
    await db.insert(schema.coachRunEvents).values({ id: `${id}:0`, userId: owner, runId: id, seq: 0, kind: "question", summary: QUESTION.text, payload: { tool: "ask_athlete", data: {} }, at });
  }
  if (o.ops) {
    await db.insert(schema.coachProposals).values({
      id: designProposalId(id),
      userId: owner,
      title: "A suggestion",
      evidence: "",
      rationale: "",
      flags: [],
      ops: typeof o.ops === "function" ? o.ops(id) : o.ops,
      status: o.proposalStatus ?? "pending",
      createdAt: at,
      expiresAt: TODAY,
    });
  }
  return id;
}

/** Every table but `llm_usage`, row by row: what a replay must leave exactly as it was. */
async function everythingButUsage(): Promise<string> {
  const tables = (await db.all(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name`)) as Array<{ name: string }>;
  const out: Record<string, unknown> = {};
  for (const { name } of tables) {
    if (name === "llm_usage") continue;
    out[name] = await db.all(sql.raw(`SELECT * FROM "${name}" ORDER BY rowid`));
  }
  return JSON.stringify(out);
}

const usageRows = () => db.select().from(schema.llmUsage);

// ── The voice block ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("the voice block", () => {
  it("is nothing at all when no variable is set: today's voice is the prompt's own", () => {
    expect(voiceBlock({})).toBeNull();
  });

  it("carries each variable's own words, one line each, in a fixed order after its head", () => {
    const all = [
      ...VOICE_LENGTHS.map((v) => ["length", v] as const),
      ...VOICE_TONES.map((v) => ["tone", v] as const),
      ...VOICE_INCLUDES.map((v) => ["include", v] as const),
      ...VOICE_PERSONS.map((v) => ["person", v] as const),
    ];
    for (const [key, value] of all) {
      const words = (VOICE_LINES[key] as Record<string, string>)[value]!;
      expect(words.length).toBeGreaterThan(0);
      expect(voiceBlock({ [key]: value })).toBe(`${VOICE_HEAD}\n- ${words}`);
    }
    expect(voiceBlock({ person: "neutral", include: "numbers", tone: "brisk", length: "sentence" })).toBe(
      [VOICE_HEAD, VOICE_LINES.length.sentence, VOICE_LINES.tone.brisk, VOICE_LINES.include.numbers, VOICE_LINES.person.neutral].join("\n- "),
    );
    // Every value's words are its own.
    const texts = all.map(([key, value]) => (VOICE_LINES[key] as Record<string, string>)[value]);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

// ── Faithful: the production request, byte for byte ───────────────────────────────────────────────────────────────

describe("a replay sends the run's own context", () => {
  it("with no variable set, each step's request is the one production sent, byte for byte — the finish, the question and the workout", async () => {
    const { runId, bodies } = await drivenRun(db, userId, env);
    for (const [at, i] of [["finish", 3], ["ask", 0], ["prose", 1]] as const) {
      const replayWire = wire([said(use("finish", { summary: "Again." }))]);
      const real = (): ReplayDeps => ({ send: (e, c) => sendMessagesBody(e, c.model, c.body, c.maxTokens, replayWire.fetchImpl), tools: allTools() });
      const res = await call("POST", "", replay(runId, [{ id: "today" }], { at }), { deps: real });
      expect(res.status).toBe(200);
      expect(replayWire.bodies).toHaveLength(1);
      expect(replayWire.bodies[0]).toBe(bodies[i]);
    }
  });

  it("a written body is routed as callMessages routes one: no key sends nothing, fixture mode answers its canned words", async () => {
    const never = (async () => {
      throw new Error("fetch must not be called");
    }) as unknown as typeof fetch;
    const body = JSON.stringify({ model: "m", max_tokens: 1, system: [], messages: [], stream: true });
    expect(await sendMessagesBody(makeEnv(email, { AI_GATEWAY_API_KEY: undefined }), "m", body, 1, never)).toMatchObject({ ok: false, kind: "no_key" });
    const canned = await sendMessagesBody(makeEnv(email, { FIXTURE_MODE: "1" }), "m", body, 1, never);
    expect(canned).toMatchObject({ ok: true, costMicros: 0 });
    expect(canned).toEqual(await callMessages(makeEnv(email, { FIXTURE_MODE: "1" }), { model: "m", system: [], messages: [], tools: [], maxTokens: 1 }, never));
  });

  it("each variable's words land in one block after the cached prefix, which is unchanged", async () => {
    const { runId } = await drivenRun(db, userId, env);
    const all = { length: "few", tone: "warm", include: "next_step", person: "you" } as const;
    const res = await call("POST", "", replay(runId, [{ id: "today" }, { id: "all", ...all }, { id: "tone", tone: "brisk" }]));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(3);
    const [base, withAll, withTone] = calls.map((c) => JSON.parse(c.body) as { messages: Array<{ content: Array<Record<string, unknown>> }> });
    for (const [v, settings] of [[withAll!, all], [withTone!, { tone: "brisk" }]] as const) {
      const last = v.messages.at(-1)!.content;
      // The block is the newest message's last, with no breakpoint of its own; the breakpoint stays where production put it.
      expect(last.at(-1)).toEqual({ type: "text", text: voiceBlock(settings) });
      expect(last.at(-2)).toHaveProperty("cache_control", { type: "ephemeral" });
      // Without it, the request is the baseline's.
      const without = structuredClone(v);
      without.messages.at(-1)!.content.pop();
      expect(without).toEqual(base);
    }
    // The client's settings come back as data, beside each variant's words.
    expect(res.body.variants.map((v: { id: string; settings: unknown }) => [v.id, v.settings])).toEqual([["today", {}], ["all", all], ["tone", { tone: "brisk" }]]);
  });

  it("answers the athlete's words, the baseline as shipped, and each variant's words with its cost and usage", async () => {
    const { runId } = await drivenRun(db, userId, env);
    replies = [
      finishing("Hips, gently: glutes first, then the hinge.", { costMicros: 160_000, cacheWrite: 30_000 }),
      ok([{ type: "text", text: "Short and kind." }, use("finish", { summary: "A short one for your hips." })], { costMicros: 12_000, cacheRead: 30_000 }),
    ];
    const res = await call("POST", "", replay(runId, [{ id: "today" }, { id: "short", length: "sentence" }]));
    expect(res.status).toBe(200);
    const turn = (await readConversation(db, userId, NOW, { endedLine })).turns.find((t) => t.runId === runId)!;
    expect(res.body).toMatchObject({
      runId,
      at: "finish",
      request: "Something calm for the hips.",
      baseline: { line: turn.line, chars: turn.line!.length },
      costUsd: 0.172,
    });
    expect(turn.line).toBe(SHIPPED_LINE);
    expect(res.body.variants).toEqual([
      {
        id: "today",
        settings: {},
        line: "Hips, gently: glutes first, then the hinge.",
        chars: 43,
        costUsd: 0.16,
        usage: { input: 20, cacheRead: 0, cacheWrite: 30_000, output: 300 },
        stopReason: "tool_use",
      },
      {
        id: "short",
        settings: { length: "sentence" },
        line: "A short one for your hips.",
        chars: 26,
        said: "Short and kind.",
        costUsd: 0.012,
        usage: { input: 20, cacheRead: 30_000, cacheWrite: 0, output: 300 },
        stopReason: "tool_use",
      },
    ]);
  });

  it("the finish's baseline is the line as the athlete read it — the trail's — not the model's words before the app clipped them", async () => {
    const runId = await storedRun({ line: "The model's own words, longer than what was shown.", shown: "As the athlete read it." });
    const res = await call("POST", "", replay(runId, [{ id: "a" }]));
    expect(res.status).toBe(200);
    expect(res.body.baseline).toEqual({ line: "As the athlete read it.", chars: 23 });
  });

  it("the question and the workout's words: the step's own baseline, and each variant's question, choices or prose", async () => {
    const { runId } = await drivenRun(db, userId, env);
    replies = [ok([use("ask_athlete", { questions: [{ text: "How much time today?", chips: ["15", "30", "45"], why: "To fit it in." }] })])];
    const asked = await call("POST", "", replay(runId, [{ id: "warm", tone: "warm" }], { at: "ask" }));
    expect(asked.status).toBe(200);
    expect(asked.body.baseline).toMatchObject({ question: QUESTION.text, choices: QUESTION.chips });
    expect(asked.body.variants[0]).toMatchObject({ id: "warm", question: "How much time today?", choices: ["15", "30", "45"] });

    const base = calmDoc({ title: "Easy hips" });
    const part = base.parts[0]!;
    const item = (i: number) => ({ ...part.items[i]!, why: `Why ${i + 1}.`, cue: `Cue ${i + 1}.` });
    const doc = { ...base, parts: [{ ...part, why: "The part's why.", items: [item(0), item(1), item(0), item(1), item(0)] }] };
    replies = [ok([use("propose_workout", { doc, target: { kind: "new", date: TODAY } })])];
    const prose = await call("POST", "", replay(runId, [{ id: "brisk", tone: "brisk" }], { at: "prose" }));
    expect(prose.status).toBe(200);
    expect(prose.body.baseline.prose).toEqual({ title: "Calm hips", intent: calmDoc().intent.summary, whys: [], cues: [] });
    // The first five whys in reading order (the part's, then its items'), the first three cues.
    expect(prose.body.variants[0].prose).toEqual({
      title: "Easy hips",
      intent: base.intent.summary,
      whys: ["The part's why.", "Why 1.", "Why 2.", "Why 1.", "Why 2."],
      cues: ["Cue 1.", "Cue 2.", "Cue 1."],
    });
  });

  it("calls the first variant alone and the rest only once it has answered: the shared prefix is written to the cache once", async () => {
    const { runId } = await drivenRun(db, userId, env);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    replies = [async () => {
      await held;
      return finishing("First.");
    }];
    const pending = call("POST", "", replay(runId, [{ id: "a" }, { id: "b", tone: "warm" }, { id: "c", tone: "brisk" }]));
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual(["start 1"]);
    release();
    expect((await pending).status).toBe(200);
    expect(order.slice(0, 2)).toEqual(["start 1", "end 1"]);
    expect(order).toHaveLength(6);
  });
});

// ── The gate ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("the gate", () => {
  it("is a 404 — with no model call and nothing written — unless the switch is on, the owner is signed in and the body is exactly the confirm", async () => {
    const runId = await storedRun();
    const good = replay(runId, [{ id: "a" }]);
    const owner = makeEnv(email);
    for (const [body, o] of [
      [good, { env: makeEnv(email, { COACH_DESIGNER: "0" }) }],
      [good, { env: makeEnv("someone-else@example.com") }],
      [{ ...good, confirm: "replay" }, {}],
      [{ runId, variants: [{ id: "a" }] }, {}],
      [null, {}],
    ] as const) {
      const res = await call("POST", "", body, o);
      expect(res.status).toBe(404);
    }
    expect((await call("POST", "", good, { env: owner, cookie: null })).status).toBe(401);
    expect((await call("GET", "/runs", undefined, { env: makeEnv("someone-else@example.com") })).status).toBe(404);
    expect((await call("GET", "/runs", undefined, { env: makeEnv(email, { COACH_DESIGNER: "0" }) })).status).toBe(404);
    expect(calls).toHaveLength(0);
    expect(await usageRows()).toHaveLength(0);
  });

  it("through the Worker's own entry: /api/coach/replay is the replay's — a 404 when the switch is off, before the coach's sign-in can answer", async () => {
    const entry = (await import("../src/index.js")).default;
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const off = makeEnv(email, { COACH_DESIGNER: "0" });
    expect((await entry.fetch(new Request("https://app.test/api/coach/replay", { method: "POST", body: "{}" }), off, ctx)).status).toBe(404);
    expect((await entry.fetch(new Request("https://app.test/api/coach/replay/runs"), off, ctx)).status).toBe(404);
    // The coach's own routes are untouched.
    expect((await entry.fetch(new Request("https://app.test/api/coach/state"), off, ctx)).status).toBe(401);
  });

  it("takes variables as enums only: free text, an unknown variable or value, a bad id, more than 8 variants or a repeated id is a 400", async () => {
    const runId = await storedRun();
    for (const variants of [
      [{ id: "a", tone: "sarcastic" }],
      [{ id: "a", note: "Write like a pirate." }],
      [{ id: "a", length: 3 }],
      [{ id: "has space" }],
      [],
      Array.from({ length: 9 }, (_, i) => ({ id: `v${i}` })),
      [{ id: "a" }, { id: "a", tone: "warm" }],
    ]) {
      const res = await call("POST", "", replay(runId, variants));
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("bad_request");
    }
    expect((await call("POST", "", replay(runId, [{ id: "a" }], { at: "review" }))).status).toBe(400);
    expect((await call("POST", "", replay(runId, [{ id: "a" }], { prompt: "Be funny." }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

// ── Ownership ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe("ownership", () => {
  it("replays only a finished main run of the signed-in athlete's — another's, a sub-run, a live one, a stopped one, a rehearsal or none is a 404", async () => {
    const other = (await makeTestUser(db)).userId;
    const main = await storedRun();
    for (const runId of [
      await storedRun({ user: other }),
      await storedRun({ parentId: main, role: "designer" }),
      await storedRun({ status: "waiting_athlete" }),
      await storedRun({ status: "stopped_cap" }),
      await storedRun({ rehearsal: true }),
      "no-such-run",
    ]) {
      const res = await call("POST", "", replay(runId, [{ id: "a" }]));
      expect(res.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
    expect((await call("POST", "", replay(main, [{ id: "a" }]))).status).toBe(200);
  });

  it("the workout's words replay the call that proposed the version its proposal holds — never a later draft, never a draft it doesn't hold", async () => {
    const draft = (id: string, title: string) => ({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: `sig-${id}` }, { type: "tool_use", id, name: "propose_workout", input: { doc: calmDoc({ title }), target: { kind: "new", date: TODAY } } }] });
    const result = (id: string) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "{\"data\":{}}" }] });
    const messages = [
      { role: "user", content: [{ type: "text", text: "HEADER: the opening context." }] },
      draft("toolu_d1", "First draft"),
      result("toolu_d1"),
      draft("toolu_d2", "Second draft"),
      result("toolu_d2"),
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_f", name: "finish", input: { summary: "Done." } }] },
    ];
    // The review kept the first version: the op holds it, by its call.
    const held = await storedRun({ messages, ops: (id) => [{ kind: "doc_workout", by: { runId: id, role: "main" }, toolUseId: "toolu_d1", doc: calmDoc({ title: "First draft" }) }] });
    const res = await call("POST", "", replay(held, [{ id: "a" }], { at: "prose" }));
    expect(res.status).toBe(200);
    expect((JSON.parse(calls[0]!.body) as { messages: unknown[] }).messages).toHaveLength(1);
    expect(res.body.baseline.prose.title).toBe("First draft");
    // A run whose proposal holds no workout of its own has no words of its own to replay, drafts or not.
    const none = await storedRun({ messages, ops: [{ kind: "plan_adjust", op: { kind: "skip" } }] });
    expect((await call("POST", "", replay(none, [{ id: "a" }], { at: "prose" }))).status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("a step the run never took is a 409 in words: no question asked, no workout of its own designed", async () => {
    const runId = await storedRun();
    for (const at of ["ask", "prose"]) {
      const res = await call("POST", "", replay(runId, [{ id: "a" }], { at }));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: "not_replayable" });
      expect(typeof res.body.why).toBe("string");
    }
    expect(calls).toHaveLength(0);
  });
});

// ── Money ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("spend", () => {
  it("refuses with the cap's words, calling nothing, when the first call's worst case would pass the weekly cutoff", async () => {
    const runId = await storedRun();
    await db.insert(schema.llmUsage).values({
      id: newId(),
      userId,
      kind: "design_main",
      model: "anthropic/claude-opus-5.5",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: LLM_BUDGET.cutoffMicros - 10_000,
      createdAt: new Date().toISOString(),
    });
    const res = await call("POST", "", replay(runId, [{ id: "a" }, { id: "b", tone: "warm" }]));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "weekly_cap", why: REPLAY_WORDS.weeklyCap });
    expect(calls).toHaveLength(0);
    expect(await usageRows()).toHaveLength(1);
  });

  it("skips, in the cap's words, the variants the weekly cutoff can't cover after the first", async () => {
    const runId = await storedRun();
    // Room for the first call's worst case (16k output at $20/M = $0.32, the prompt besides) — and once it has cost
    // $0.30, none for another's.
    await db.insert(schema.llmUsage).values({
      id: newId(),
      userId,
      kind: "design_main",
      model: "anthropic/claude-opus-5.5",
      inputTokens: 1,
      outputTokens: 1,
      costMicros: LLM_BUDGET.cutoffMicros - 450_000,
      createdAt: new Date().toISOString(),
    });
    replies = [finishing("Line 1.", { costMicros: 300_000 })];
    const res = await call("POST", "", replay(runId, [{ id: "a" }, { id: "b", tone: "warm" }, { id: "c", tone: "brisk" }]));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(res.body.variants[0].line).toBe("Line 1.");
    for (const v of res.body.variants.slice(1)) expect(v).toMatchObject({ skipped: { reason: "weekly_cap", why: REPLAY_WORDS.weeklyCap }, costUsd: 0 });
  });

  it("stops at the request's own cap: a variant the cap can't cover is skipped, never called", async () => {
    const runId = await storedRun();
    replies = [finishing("Dear.", { costMicros: REPLAY_REQUEST_CAP_MICROS - 50_000, output: 2_000 })];
    const res = await call("POST", "", replay(runId, [{ id: "a" }, { id: "b", tone: "warm" }]));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(res.body.variants[1]).toMatchObject({ id: "b", skipped: { reason: "request_cap", why: REPLAY_WORDS.requestCap }, costUsd: 0 });
    expect(res.body.costUsd).toBeLessThanOrEqual(REPLAY_REQUEST_CAP_MICROS / 1_000_000);
  });

  it("a first call that fails calls nothing more: the rest are skipped in words (the prefix was never cached)", async () => {
    const runId = await storedRun();
    replies = [{ ok: false, kind: "rejected", reason: "gateway_400", status: 400 }];
    const res = await call("POST", "", replay(runId, [{ id: "a" }, { id: "b", tone: "warm" }]));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(res.body.variants).toMatchObject([
      { id: "a", error: "rejected", costUsd: 0 },
      { id: "b", skipped: { reason: "first_failed", why: REPLAY_WORDS.firstFailed }, costUsd: 0 },
    ]);
  });

  it("records every call in llm_usage as coach_replay, at what it cost — and writes nothing else", async () => {
    const { runId } = await drivenRun(db, userId, env);
    const before = await everythingButUsage();
    const usageBefore = (await usageRows()).length;
    replies = [finishing("One.", { costMicros: 150_000 }), finishing("Two.", { costMicros: 11_000 }), { ok: false, kind: "retryable", reason: "gateway_529", status: 529 }];
    const res = await call("POST", "", replay(runId, [{ id: "a" }, { id: "b", tone: "warm" }, { id: "c", tone: "brisk" }]));
    expect(res.status).toBe(200);
    expect(res.body.variants[2]).toMatchObject({ id: "c", error: "retryable", costUsd: 0 });
    expect(await everythingButUsage()).toBe(before);
    const rows = (await usageRows()).slice(usageBefore);
    expect(rows.map((r) => [r.kind, r.costMicros])).toEqual([
      [REPLAY_USAGE_KIND, 150_000],
      [REPLAY_USAGE_KIND, 11_000],
      [REPLAY_USAGE_KIND, 0],
    ]);
    // Settled: the reservation's mark gone (never a run's fingerprint either: a dead step's spend reads `run:<id>:` rows).
    expect(rows.map((r) => r.requestFingerprint)).toEqual(["a", "b", "c"].map((id) => `replay:${runId}:finish:${id}`));
  });

  it("the per-request cap is soft, and the answer says so: the weekly cap is the hard bound", async () => {
    const runId = await storedRun();
    const res = await call("POST", "", replay(runId, [{ id: "a" }]));
    expect(res.status).toBe(200);
    expect(res.body.capNote).toBe(REPLAY_WORDS.capNote);
    expect(REPLAY_WORDS.capNote).toMatch(/soft/);
    expect(REPLAY_WORDS.capNote).toMatch(/weekly cap is the hard bound/);
  });
});

// ── A replay cut off partway (review I1) ────────────────────────────────────────────────────────────────────────────

describe("a replay's reservations", () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const reservation = (o: { kind?: string; costMicros: number; est?: number; at: string }) => ({
    id: newId(),
    userId,
    kind: o.kind ?? REPLAY_USAGE_KIND,
    model: "anthropic/claude-opus-5.5",
    inputTokens: 1,
    outputTokens: 16_000,
    costMicros: o.costMicros,
    requestFingerprint: `replay:r:finish:v${o.est === undefined ? "" : `;est=${o.est}`}`,
    createdAt: o.at,
  });

  it("are held at their worst case while a call is in flight, marked with their estimate, and settled unmarked", async () => {
    const runId = await storedRun(); // its calls' outputs: 400 and 600 tokens
    const gates = [0, 1].map(() => {
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      return { held, release };
    });
    replies = gates.map((g, i) => async () => {
      await g.held;
      return finishing(`Line ${i + 1}.`, { costMicros: 21_000, output: 300 });
    });
    const pending = call("POST", "", replay(runId, [{ id: "a" }, { id: "b", tone: "warm" }]));
    const rowOf = async (id: string) => {
      for (let i = 0; i < 50; i++) {
        const row = (await usageRows()).find((r) => r.requestFingerprint?.startsWith(`replay:${runId}:finish:${id}`));
        if (row) return row;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no row for ${id} after 50 looks`);
    };
    const opus = (u: { write?: number; read?: number; output: number }) =>
      messagesCostMicros("anthropic/claude-opus-5.5", { inputTokens: 0, cacheReadTokens: u.read ?? 0, cacheWriteTokens: u.write ?? 0, outputTokens: u.output });
    // The first, in flight: held at its worst (16k output at $20/M, the prompt besides), marked with its estimate — its
    // prompt written to the cache, twice the run's longest output.
    const first = await rowOf("a");
    expect(first.costMicros).toBeGreaterThan(320_000);
    expect(first.requestFingerprint).toBe(`replay:${runId}:finish:a;est=${opus({ write: first.inputTokens, output: 1_200 })}`);
    gates[0]!.release();
    // The second, in flight: its prompt read from the cache.
    const second = await rowOf("b");
    expect(second.requestFingerprint).toBe(`replay:${runId}:finish:b;est=${opus({ read: second.inputTokens, output: 1_200 })}`);
    gates[1]!.release();
    expect((await pending).status).toBe(200);
    expect((await usageRows()).map((r) => [r.requestFingerprint, r.costMicros])).toEqual([
      [`replay:${runId}:finish:a`, 21_000],
      [`replay:${runId}:finish:b`, 21_000],
    ]);
  });

  it(`count at their worst for ${REPLAY_RESERVATION_STALE_MINUTES} minutes — longer than any replay call can run — then at their estimate; the coach's own are unchanged`, async () => {
    expect(REPLAY_RESERVATION_STALE_MINUTES * 60_000).toBeGreaterThan(DESIGN_MODEL_TIMEOUT_MS);
    await db.insert(schema.llmUsage).values([
      reservation({ costMicros: 400_000, est: 20_000, at: minutesAgo(REPLAY_RESERVATION_STALE_MINUTES + 1) }), // orphaned: its estimate
      reservation({ costMicros: 400_000, est: 20_000, at: minutesAgo(5) }), // may still be running: its worst
      reservation({ costMicros: 30_000, at: minutesAgo(60) }), // settled: what it cost
      reservation({ kind: "design_main", costMicros: 400_000, est: 20_000, at: minutesAgo(60) }), // the coach's own: unchanged
    ]);
    expect((await llmBudgetStatus(db, userId)).spentMicros).toBe(20_000 + 400_000 + 30_000 + 400_000);
  });

  it(`an orphaned replay no longer blocks the live coach once ${REPLAY_RESERVATION_STALE_MINUTES} minutes have passed — its step, and a new ask`, async () => {
    const orphans = (at: string) => Array.from({ length: 7 }, () => reservation({ costMicros: 380_000, est: 20_000, at })); // $2.66 at worst
    const spent = { id: newId(), userId, kind: "design_main", model: "m", inputTokens: 1, outputTokens: 1, costMicros: LLM_BUDGET.cutoffMicros - 2_150_000, createdAt: minutesAgo(60) };
    const deps: RunDeps = { callModel: async () => finishing("Done.") as MessagesResult, buildContext: designContextBuilder, tools: allTools(), clock: () => 0 };
    // On the real clock: the week is the real week (llmBudgetStatus reads it so).
    const at = (s: number) => new Date(Date.now() + s * 1_000);
    /** A "now" run asked and its context built: its next step calls the model. */
    const asked = async (request: string) => {
      const runId = (await createRun(db, userId, { scope: { kind: "now" }, request }, at(0))).run.id;
      expect((await runStep(db, env, runId, userId, at(1), deps)).kind).toBe("ok");
      return runId;
    };
    const modelStep = async (runId: string) => {
      const out = await runStep(db, env, runId, userId, at(2), deps);
      return out.kind === "ok" ? out.result.status : out.kind;
    };
    await db.insert(schema.llmUsage).values(spent);
    const first = await asked("Something calm.");
    // A replay cut off just now: its reservations stand, so the coach's step can't be covered, and a new ask is refused.
    await db.insert(schema.llmUsage).values(orphans(minutesAgo(5)));
    expect(await modelStep(first)).toBe("stopped_cap");
    await expect(createRun(db, userId, { scope: { kind: "now" }, request: "Again." }, at(3))).rejects.toThrow("week_budget");
    // Orphaned past the window: they count at their estimate, and the coach goes on.
    await db.update(schema.llmUsage).set({ createdAt: minutesAgo(REPLAY_RESERVATION_STALE_MINUTES + 1) }).where(eq(schema.llmUsage.kind, REPLAY_USAGE_KIND));
    expect(await modelStep(await asked("Again."))).toBe("finished");
  });

  it("each batch's rows are dated when they are written — not when the request began — so a batch still running is held at its worst", async () => {
    // The first call takes eleven minutes to answer (its deadline is ten, and the stream may run that long); the batch
    // starts then, and is still running nine minutes later: twenty minutes after the request began.
    let clock = new Date(Date.now() - 20 * 60_000);
    const runId = await storedRun();
    const gates = [0, 1].map(() => {
      let release: () => void = () => {};
      const held = new Promise<void>((r) => (release = r));
      return { held, release };
    });
    replies = gates.map((g, i) => async () => {
      await g.held;
      return finishing(`Line ${i + 1}.`, { costMicros: 21_000 });
    });
    const pending = call("POST", "", replay(runId, [{ id: "a" }, { id: "b", tone: "warm" }]), { now: () => clock });
    const rowOf = async (id: string) => {
      for (let i = 0; i < 50; i++) {
        const row = (await usageRows()).find((r) => r.requestFingerprint?.startsWith(`replay:${runId}:finish:${id}`));
        if (row) return row;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no row for ${id} after 50 looks`);
    };
    const first = await rowOf("a");
    expect(first.createdAt).toBe(clock.toISOString());
    clock = new Date(Date.now() - 9 * 60_000);
    gates[0]!.release();
    const batch = await rowOf("b");
    // Its own insert's time: its call can still run a whole deadline from there, inside the stale window.
    expect(batch.createdAt).toBe(clock.toISOString());
    expect(Date.parse(batch.createdAt) + DESIGN_MODEL_TIMEOUT_MS).toBeLessThan(Date.parse(batch.createdAt) + REPLAY_RESERVATION_STALE_MINUTES * 60_000);
    // The week holds it at its worst while it runs (the first, settled, at its cost).
    expect((await llmBudgetStatus(db, userId)).spentMicros).toBe(21_000 + batch.costMicros);
    expect(batch.costMicros).toBeGreaterThan(320_000);
    gates[1]!.release();
    expect((await pending).status).toBe(200);
  });

  it("GET /api/coach/spend shows the week as the gate counts it: an orphaned reservation at its estimate", async () => {
    await db.insert(schema.llmUsage).values([
      reservation({ costMicros: 400_000, est: 20_000, at: minutesAgo(REPLAY_RESERVATION_STALE_MINUTES + 1) }),
      reservation({ kind: "design_main", costMicros: 50_000, at: minutesAgo(60) }),
    ]);
    const res = await mountRoutes(db, "/api/coach", coachRoutes).request("/api/coach/spend", { headers: { Cookie: cookie } }, env);
    const body = (await res.json()) as { spentMicros: number; byKind: Array<{ kind: string; costMicros: number }> };
    expect(body.spentMicros).toBe((await llmBudgetStatus(db, userId)).spentMicros);
    expect(body.spentMicros).toBe(70_000);
    expect(body.byKind.find((k) => k.kind === REPLAY_USAGE_KIND)).toMatchObject({ costMicros: 20_000 });
  });
});

// ── The workout's words: a few at a time (review, minor 3) ─────────────────────────────────────────────────────────

describe("a prose replay", () => {
  it(`takes at most ${REPLAY_PROSE_VARIANTS_MAX} variants — each answer a whole document — and says so in words`, async () => {
    const runId = await storedRun();
    const four = Array.from({ length: REPLAY_PROSE_VARIANTS_MAX + 1 }, (_, i) => ({ id: `v${i}` }));
    const res = await call("POST", "", replay(runId, four, { at: "prose" }));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "bad_request" });
    expect(res.body.why).toContain(`at most ${REPLAY_PROSE_VARIANTS_MAX}`);
    expect(calls).toHaveLength(0);
    // The other steps still take eight.
    expect((await call("POST", "", replay(runId, four))).status).toBe(200);
  });
});

// ── The listing ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe("GET /runs", () => {
  const doc = (by: { runId: string; role: string }) => ({ kind: "doc_workout", by, toolUseId: "toolu_x", doc: calmDoc() });

  it("lists the athlete's finished main runs, newest first, with what each came to and which steps replay", async () => {
    const at = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();
    const answer = await storedRun({ createdAt: at(1), line: "An answer.", request: "Why easy today?" });
    const asked = await storedRun({ createdAt: at(2), asked: true });
    const workout = await storedRun({ createdAt: at(3) });
    await db.insert(schema.coachProposals).values({
      id: designProposalId(workout),
      userId,
      title: "x",
      evidence: "",
      rationale: "",
      flags: [],
      ops: [doc({ runId: workout, role: "main" })],
      status: "pending",
      createdAt: at(3),
      expiresAt: TODAY,
    });
    const change = await storedRun({ createdAt: at(4), ops: [{ kind: "plan_adjust", op: { kind: "skip" } }] });
    // An auto run that planned a set: its workouts are its designers'.
    const set = await storedRun({ createdAt: at(5), scope: { kind: "auto" }, ops: [doc({ runId: "designer-1", role: "designer" })] });
    const plan = await storedRun({ createdAt: at(6), ops: [{ kind: "plan_structure", title: "10K", summary: "4 weeks" }] });
    // Never listed: another athlete's, a sub-run, a live run, a rehearsal.
    await storedRun({ user: (await makeTestUser(db)).userId, createdAt: at(7) });
    await storedRun({ parentId: plan, role: "designer", createdAt: at(8) });
    await storedRun({ status: "active", createdAt: at(9) });
    await storedRun({ rehearsal: true, createdAt: at(10) });

    const res = await measured("GET", "/runs?limit=20");
    expect(res.status).toBe(200);
    expect(res.cost).toBe(2);
    expect(res.body.runs.map((r: { id: string; outcome: string; steps: string[] }) => [r.id, r.outcome, r.steps])).toEqual([
      [plan, "plan", ["finish"]],
      [set, "set", ["finish"]],
      [change, "plan_change", ["finish"]],
      [workout, "workout", ["finish", "prose"]],
      [asked, "answer", ["finish", "ask"]],
      [answer, "answer", ["finish"]],
    ]);
    expect(res.body.runs.at(-1)).toEqual({
      id: answer,
      at: at(1),
      words: "Why easy today?",
      line: "An answer.",
      outcome: "answer",
      steps: ["finish"],
      costUsd: 0.12,
    });
    expect((await call("GET", "/runs?limit=2")).body.runs).toHaveLength(2);
    for (const bad of ["0", "51", "x"]) expect((await call("GET", `/runs?limit=${bad}`)).status).toBe(400);
  });
});

// ── The budget ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("statements and fetches", () => {
  it(`a replay of 8 variants stays within ${BUDGET} statements and fetches`, async () => {
    const runId = await storedRun();
    const variants = Array.from({ length: 8 }, (_, i) => ({ id: `v${i}`, ...(i > 0 ? { tone: VOICE_TONES[i % 3] } : {}) }));
    const res = await measured("POST", "", replay(runId, variants));
    expect(res.status).toBe(200);
    expect(fetches).toBe(8);
    // The sign-in (2), the run (1), the week (1), the first call (its row, the call, its settling: 3), the week again
    // (1), and the other seven (their rows in one insert, seven calls, seven settlings: 15).
    expect(res.cost).toBe(23);
    expect(res.cost).toBeLessThanOrEqual(BUDGET);
  });
});

// ── Today's prompt on the run's own context (the owner's voice, 2026-10-19) ────────────────────────────────────────

describe("prompt: current", () => {
  /** A run stored under an older prompt: its shared prefix and its role block as they were then, its profile and memory
   * as the context builder made them from its data. */
  const OLD = [
    { type: "text", text: "OLD SHARED PROMPT: the principles as they were.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "OLD MAIN BLOCK: one plain line, an apology when owed." },
    { type: "text", text: "# The athlete\nGoals: posture.", cache_control: { type: "ephemeral" } },
    { type: "text", text: "# Pinned memory\n- prefers mornings." },
  ];
  type Sent = { system: Array<Record<string, unknown>>; tools: unknown; messages: unknown; max_tokens: number };

  it("rebuilds only the static prompt text — the shared prefix and the role block, as a run started now sends them — and keeps every per-run block as stored", async () => {
    const runId = await storedRun({ system: OLD });
    const res = await call("POST", "", replay(runId, [{ id: "a" }], { prompt: "current" }));
    expect(res.status).toBe(200);
    expect(res.body.prompt).toBe("current");
    const asRun = await call("POST", "", replay(runId, [{ id: "a" }]));
    expect(asRun.body.prompt).toBe("as_run");
    const [current, stored] = calls.map((c) => JSON.parse(c.body) as Sent);
    // What a main run started now sends as its static blocks.
    const now = await buildDesignContext(db, env, userId, { id: "fresh", role: "main", scope: { kind: "auto" }, request: "x", parentId: null }, NOW);
    expect(current!.system.slice(0, 2)).toEqual(now.system.slice(0, 2));
    expect(current!.system[1]!.text).not.toBe(OLD[1]!.text);
    // The run's own: its profile and memory as stored, and its history, tools and limits as the as-run replay sends them.
    expect(current!.system.slice(2)).toEqual(OLD.slice(2));
    expect(stored!.system).toEqual(OLD);
    expect([current!.messages, current!.tools, current!.max_tokens]).toEqual([stored!.messages, stored!.tools, stored!.max_tokens]);
  });

  it("on a run made with today's prompt, current and as-run send the same request, byte for byte", async () => {
    const { runId, bodies } = await drivenRun(db, userId, env);
    const wired = wire([said(use("finish", { summary: "A." })), said(use("finish", { summary: "B." }))]);
    const real = (): ReplayDeps => ({ send: (e, c) => sendMessagesBody(e, c.model, c.body, c.maxTokens, wired.fetchImpl), tools: allTools() });
    expect((await call("POST", "", replay(runId, [{ id: "a" }], { prompt: "current" }), { deps: real })).status).toBe(200);
    expect((await call("POST", "", replay(runId, [{ id: "a" }], { prompt: "as_run" }), { deps: real })).status).toBe(200);
    expect(wired.bodies).toEqual([bodies[3], bodies[3]]);
  });

  it("a run whose prompt was laid out otherwise can only replay as it ran: current is a 409 in words, as-run goes on", async () => {
    const runId = await storedRun(); // one system block: not the context builder's four
    const res = await call("POST", "", replay(runId, [{ id: "a" }], { prompt: "current" }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "not_replayable", why: REPLAY_WORDS.notCurrent });
    expect(calls).toHaveLength(0);
    expect((await call("POST", "", replay(runId, [{ id: "a" }], { prompt: "as_run" }))).status).toBe(200);
    expect((await call("POST", "", replay(runId, [{ id: "a" }], { prompt: "today" }))).status).toBe(400);
  });
});
