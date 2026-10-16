/**
 * THE COACH DESIGNER'S CPU, REQUEST BY REQUEST (Stage 3 go-live gate). On the Workers free plan a request has 10 ms of
 * CPU. A step that goes over dies mid-way, is taken over 15 minutes later and is billed again (fix wave 3A, M6). Time
 * spent waiting on the model's stream or on D1 is not CPU; the Worker's JavaScript is.
 *
 * Every shape is a real request through its route (`POST /api/coach/runs/:id/step`, the approve, the board, the current
 * run), each run from the same starting database:
 *  1. the first steps of a "now" run on a rich account: the opening context (its own step); the first model call, a
 *     streamed tool_use turn asking for 12 reads (the step runs what its CPU room holds: MODEL_STEP_CPU_ROOM); the
 *     queued reads, a step at a time (PENDING_STEP_CPU_ROOM, MAX_TOOL_CALLS_PER_STEP);
 *  2. a heavy designer turn: a streamed answer carrying whole workout documents (~3.4k tokens each) after thinking — an
 *     answer over DOCUMENT_ANSWER_BYTES, so the step that reads it runs none of its calls — then the steps that run them:
 *     4 × validate_workout (the answer cap, 64 KB, holds no more than ~4 such documents), 3 in a step at most
 *     (MAX_DOCUMENT_TOOLS_PER_STEP); or validate_workout then propose_workout, run together in the next step, which builds
 *     the reviewer's packet and starts the reviewer; or propose_workout alone (an answer just under the threshold: it
 *     runs in the model step); and 9 smaller documents, then their validates three steps of 3;
 *  3. a model step at a state near its cap (~190 KB): its parse, the request body, the answer, the write;
 *  4. the reviewer: its packet (cut near 24 KB, evidence first), its opening context, its submit_review turn, and the
 *     designer's resume;
 *  5. the manifest of a 7-workout set with 3 changes (`placedTimes`, `relaidDay`), and its approve, chunk by chunk;
 *  6. `GET /api/objectives/board` over two years of runs, sessions and sets (best ever reads all of it);
 *  7. `GET /api/coach/runs/current` with 50 events;
 *  8. every tool's own call, alone, as a step runs it (`measureTool`): its scaled p50 must stay at or under the tool's
 *     declared `cpuWeight`, which the step loop spends its CPU room by.
 *
 * THE MODEL'S ANSWER is the Messages API's event stream, fed to the real client (llm-messages.ts `callMessages`) through
 * its fetch seam, one event to a read — how a streamed answer arrives while the model writes it. A tool's input comes in
 * ~16-character `input_json_delta` pieces. Both are assumptions: the parse costs ~0.7 µs an event and ~0.7 µs a read
 * here, so a document turn's cost moves with the real granularity (token-sized pieces cost ~2.5× this; pieces arriving
 * together in one read, half). The "part" lines print the parse alone, both ways.
 *
 * THE WORKER'S CPU is the request's time minus SQLite's own work (preparing and running statements, building rows, D1
 * writing its answer as JSON): on Workers that is D1's. What the Worker does pay for D1 is counted: its binding sends the
 * parameters as JSON and parses the rows back (workerd's D1 shim), so each statement's parameters are stringified and its
 * rows parsed once inside the timing — the `wire` column.
 *
 * The rich account lives on a fixed clock (design-read-fixture.ts), so the run's steps see a frozen `Date` (vitest's fake
 * Date: a few hundredths of a ms on a step); the approve, the board and the current run use the real clock.
 *
 * Timed like the other benches (session-build-bench.test.ts, coach-runs-bench.test.ts): a fixed calibration loop before
 * and after, times scaled to the reference machine (`× reference / calibration`); on CI, on a runner far from the
 * reference or whose speed drifted while measuring, or on one with more runnable work than cores, every timing assertion
 * skips with the reason. A shape's budget is GO_LIVE_BUDGET_MS scaled at p50 — headroom under the 10 ms for workerd
 * being slower than node, for GC, and for a colder isolate (the `first` column) — or tighter where it measured well
 * under; its p95 must stay under the limit. Shapes measured over the budget at this commit are listed in KNOWN_OVER with
 * the fix each waits on, and held under a regression ceiling until then. DESIGN_CPU_RUNS sets the timed runs a shape
 * (default 21). Synthetic data only.
 */
import type Database from "better-sqlite3";
import BetterSqlite from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { and, eq, sql } from "drizzle-orm";
import { availableParallelism, loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, todayInZone, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { Rng } from "@rg/session-engine";
import type { AppContext } from "../src/auth/middleware.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { coachRoutes } from "../src/routes/coach.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { objectiveBoardRoutes } from "../src/routes/objectives-board.js";
import { ANSWER_MAX_BYTES, createRun, DOCUMENT_ANSWER_BYTES, noteOnTrail, STATE_MAX_BYTES, type RunDeps, type RunState } from "../src/services/coach-runs.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { reviewPacket, toolRecords, TOOL_RECORDS_MAX_BYTES } from "../src/services/design-review.js";
import { adjustPlan } from "../src/services/design-tools/adjust-plan.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId, proposeWorkout } from "../src/services/design-tools/propose.js";
import { isToolErr, type DraftForReview, type OpReview, type SetHooks, type SetRound, type ToolContext } from "../src/services/design-tools/types.js";
import { utf8Bytes } from "../src/services/utf8.js";
import { validateWorkout } from "../src/services/design-tools/validate.js";
import { callMessages } from "../src/services/llm-messages.js";
import type { Db } from "../src/services/db.js";
import { at, day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { activateTmj, calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";

const ON_CI = process.env.CI === "true";
/** The calibration loop's median on the reference machine (session-build-bench.test.ts: Apple silicon, Node 21). */
const REFERENCE_CALIBRATION_MS = 6.2;
const MAX_RUNNER_RATIO = 1.5;
const WORKERS_CPU_LIMIT_MS = 10;
/** A request's budget at p50, scaled: the limit less room for workerd, GC and a colder isolate. */
const GO_LIVE_BUDGET_MS = 6;
const RUNS = Math.max(5, Number(process.env.DESIGN_CPU_RUNS) || 21);
const WARMUP = 3;
const TZ = "America/Los_Angeles";

// ── Timing ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function calibrationLoop(): number {
  const rng = Rng.create("calibration");
  const items = Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}`, score: rng(), tags: [i % 7, i % 11] }));
  items.sort((a, b) => b.score - a.score);
  let total = 0;
  for (const it of items) total += it.tags[0]! * it.score + (it.id.length > 4 ? 1 : 0);
  return total + JSON.stringify(items.slice(0, 2000)).length;
}

function percentile(xs: readonly number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function calibrate(): number {
  const out: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    calibrationLoop();
    out.push(performance.now() - t);
  }
  return percentile(out, 50);
}

interface D1Clock {
  reset(): void;
  /** SQLite's own work, and D1 writing its answer: not the Worker's CPU. */
  sqlite(): number;
  /** The Worker's side of D1's wire: the parameters sent as JSON, the rows parsed back. Inside the Worker's time. */
  wire(): number;
  statements(): number;
}

function d1Clock(client: Database.Database): D1Clock {
  let sqliteMs = 0;
  let wireMs = 0;
  let count = 0;
  const prepare = client.prepare.bind(client);
  (client as unknown as { prepare: (src: string) => unknown }).prepare = (src: string) => {
    const t0 = performance.now();
    const stmt = prepare(src) as unknown as Record<string, unknown>;
    sqliteMs += performance.now() - t0;
    for (const method of ["all", "get", "run", "values"]) {
      const f = stmt[method];
      if (typeof f !== "function") continue;
      const bound = (f as (...a: unknown[]) => unknown).bind(stmt);
      stmt[method] = (...a: unknown[]) => {
        const t1 = performance.now();
        JSON.stringify(a);
        const t2 = performance.now();
        let out: unknown;
        try {
          out = bound(...a);
        } finally {
          count += 1;
        }
        const text = out === undefined ? "null" : JSON.stringify(out);
        const t3 = performance.now();
        JSON.parse(text);
        const t4 = performance.now();
        sqliteMs += t3 - t2;
        wireMs += t2 - t1 + (t4 - t3);
        return out;
      };
    }
    return stmt;
  };
  return {
    reset: () => {
      sqliteMs = 0;
      wireMs = 0;
      count = 0;
    },
    sqlite: () => sqliteMs,
    wire: () => wireMs,
    statements: () => count,
  };
}

interface Sample {
  /** The Worker's CPU: the request's time minus SQLite's own; D1's wire (JSON both ways) included. */
  js: number;
  wire: number;
  sqlite: number;
  statements: number;
}

interface Shape {
  label: string;
  samples: Sample[];
  /** The first run's time: code this path had not run before (a colder isolate). */
  first: number;
  /** Scaled p50 budget; null for a part printed only. */
  budget: number | null;
}
const shapes = new Map<string, Shape>();

/** A database and the routes over it, opened from an image of another (each run starts from the same rows). */
interface World {
  db: Db;
  clock: D1Clock;
  runs: Hono<AppContext>;
  coach: Hono<AppContext>;
  board: Hono<AppContext>;
  close(): void;
}

const clientOf = (db: Db): Database.Database => (db as unknown as { $client: Database.Database }).$client;
const imageOf = (db: Db): Buffer => clientOf(db).serialize();

function open(image: Buffer): World {
  const client = new BetterSqlite(image);
  const clock = d1Clock(client);
  const db = drizzle(client, { schema }) as unknown as Db;
  return {
    db,
    clock,
    runs: mountRoutes(db, "/api/coach/runs", runRoutes),
    coach: mountRoutes(db, "/api/coach", coachRoutes),
    board: mountRoutes(db, "/api/objectives/board", objectiveBoardRoutes),
    close: () => client.close(),
  };
}

/** Time `run` on a fresh copy of `image`, WARMUP + RUNS times; answers the database the last run left (open). */
async function measure(
  id: string,
  label: string,
  image: Buffer,
  run: (w: World) => Response | Promise<Response | void>,
  o: { budget: number | null; check?: (body: unknown) => void },
): Promise<World> {
  const samples: Sample[] = [];
  let first = 0;
  let last: World | null = null;
  for (let i = 0; i < WARMUP + RUNS; i++) {
    last?.close();
    const w = open(image);
    w.clock.reset();
    const t = performance.now();
    const res = await run(w);
    const total = performance.now() - t;
    const s: Sample = { js: total - w.clock.sqlite(), wire: w.clock.wire(), sqlite: w.clock.sqlite(), statements: w.clock.statements() };
    if (res) {
      const text = await res.text();
      if (res.status !== 200) throw new Error(`${label}: answered ${res.status} ${text.slice(0, 300)}`);
      if (i === 0) o.check?.(JSON.parse(text));
    }
    if (i === 0) first = s.js;
    if (i >= WARMUP) samples.push(s);
    last = w;
  }
  shapes.set(id, { label, samples, first, budget: o.budget });
  return last!;
}

/**
 * One tool's call, alone, as a step runs it: the call itself, and what the loop does with its answer and input (the
 * result's JSON and its size in bytes, the input bounded for the trail). Its scaled p50 is what the tool's declared
 * `cpuWeight` must cover (section 8).
 */
async function measureTool(name: string, image: Buffer, ctx: (w: World) => ToolContext, input: unknown): Promise<void> {
  const tool = allTools().find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  (await measure(`8.${name}`, `8. ${name} (declared ${tool.cpuWeight})`, image, async (x) => {
    const r = await tool.run(ctx(x), input);
    if (isToolErr(r)) throw new Error(`${name} refused: ${r.error} — ${r.why}`);
    utf8Bytes(JSON.stringify({ provenance: r.provenance, missing: r.missing, data: r.data }));
    JSON.stringify(input);
  }, { budget: null })).close();
}

/** The loop's side of a set, as a main run's step gives it (setHooks), over these rounds; starting a designer inserts
 * nothing here (that insert is SQLite's own work). */
function setHooksOf(rounds: SetRound[]): SetHooks {
  return {
    rounds: () => rounds,
    start: async (designers) => designers.map((d) => d.runId),
    budget: () => ({ ceilingMicros: 6_000_000, spentMicros: 120_000, mainSpentMicros: 60_000, perDesignerMicros: null, estimate: null }),
    started: () => false,
    keyLine: () => undefined,
  };
}

/** Time a part of a request alone (no D1): printed, never asserted. */
async function measurePart(id: string, label: string, f: () => Promise<unknown>): Promise<void> {
  const samples: Sample[] = [];
  let first = 0;
  for (let i = 0; i < WARMUP + RUNS; i++) {
    const t = performance.now();
    await f();
    const js = performance.now() - t;
    if (i === 0) first = js;
    if (i >= WARMUP) samples.push({ js, wire: 0, sqlite: 0, statements: 0 });
  }
  shapes.set(id, { label, samples, first, budget: null });
}

// ── The model's answer: the Messages API's event stream ─────────────────────────────────────────────────────────────

type AnswerBlock = { type: "thinking"; signature: string } | { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

const pieces = (text: string, size: number): string[] => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

/** The answer as the gateway streams it, one SSE event to a read: text in ~6-token deltas, a tool's input in ~16-character
 * pieces of its JSON, the thinking's signature in one delta (the default display sends no thinking text), a ping now and
 * then. */
function streamOf(blocks: AnswerBlock[]): { chunks: Uint8Array[]; contentBytes: number } {
  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: `msg_${newId()}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1_850, cache_creation_input_tokens: 2_400, cache_read_input_tokens: 14_200, output_tokens: 1 },
      },
    },
    { type: "ping" },
  ];
  blocks.forEach((b, index) => {
    if (b.type === "thinking") {
      events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: b.signature } });
    } else if (b.type === "text") {
      events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const p of pieces(b.text, 24)) events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: p } });
    } else {
      events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "" } });
      for (const p of pieces(JSON.stringify(b.input), 16)) events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: p } });
    }
    events.push({ type: "content_block_stop", index });
  });
  const contentBytes = JSON.stringify(blocks.map((b) => (b.type === "thinking" ? { type: "thinking", thinking: "", signature: b.signature } : b))).length;
  events.push({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: Math.ceil(contentBytes / 4) } });
  events.push({ type: "message_stop" });
  const withPings = events.flatMap((e, i) => (i > 0 && i % 250 === 0 ? [{ type: "ping" }, e] : [e]));
  const encoder = new TextEncoder();
  return { chunks: withPings.map((e) => encoder.encode(`event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`)), contentBytes };
}

/** What the "gateway" answers the next model call with, a chunk to a read. */
let answer: Uint8Array[] = [];
const gatewayFetch = (async () => {
  const chunks = answer;
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}) as unknown as typeof fetch;

const deps: RunDeps = {
  callModel: (e, req) => callMessages(e, req, gatewayFetch),
  buildContext: designContextBuilder,
  tools: allTools(),
  review: true,
};
const runRoutes = makeCoachRunRoutes(() => deps);

const env = {
  DB: {} as Env["DB"],
  ASSETS: {} as Env["ASSETS"],
  APP_URL: "https://app.test",
  FIXTURE_MODE: "0",
  AI_DEFAULT_ENABLED: "1",
  AI_GATEWAY_API_KEY: "bench-key",
  COACH_DESIGNER: "1",
  SESSION_SECRET: "s",
  TOKEN_ENCRYPTION_KEY: "k",
  ALLOWED_GOOGLE_EMAIL: "runner@example.com",
  GOOGLE_CLIENT_ID: "c",
  GOOGLE_CLIENT_SECRET: "c",
} as Env;

// ── Words a model writes: plain, varied, near the schema's lengths ──────────────────────────────────────────────────

const SENTENCES = [
  "Wakes the hips before any loading so the first working set feels smooth rather than stiff",
  "Keeps the jaw soft and the breath slow; the trunk braces without clenching or holding the breath",
  "Upper back has gone untrained for six days and the desk hours pull the shoulders forward",
  "A small step up from last week's clean sessions: one more rep each set, the same load",
  "The calves were sore after the hills, so the lower legs stay light and the knees stay quiet today",
  "Pairs a pull with the press so the shoulders stay balanced across the week, not just today",
  "Slow lowering builds control under load without needing heavier dumbbells than the garage has",
  "Ends by opening the hips through the range the squats used, so the low back is left relaxed",
  "Holds the ribs down and the pelvis level; stop the set the moment the low back takes over",
  "Fits the thirty-five minutes the athlete usually has before work, with the warm-up kept short",
];
const words = (seed: number, max: number): string => {
  let out = "";
  for (let i = 0; out.length < max - 20; i++) out += (out ? ". " : "") + SENTENCES[(seed + i * 3) % SENTENCES.length];
  return `${out.slice(0, max - 1).trimEnd()}.`;
};

/** A workout document as a designer writes one: every move with its dose, why, cue, progression and two alternates.
 * Twelve moves over six parts is ~12 KB of JSON (~3.4k tokens), a full 45-minute draft; six moves, about half. */
function designedDoc(moves: readonly string[], variant: number, objectiveIds: string[], size: "whole" | "half" = "whole"): WorkoutDoc {
  let k = variant;
  const item = () => {
    k += 1;
    return {
      kind: "exercise",
      libraryId: moves[k % moves.length]!,
      dose: { sets: 2, reps: 8, restSec: 45 },
      why: words(k, 150),
      progression: words(k + 1, 110),
      cue: words(k + 2, 150),
      alternates: [
        { libraryId: moves[(k + 7) % moves.length]!, why: words(k + 3, 110) },
        { libraryId: moves[(k + 13) % moves.length]!, why: words(k + 4, 110) },
      ],
    };
  };
  const parts =
    size === "whole"
      ? [
          { purpose: "warmup", why: words(1, 150), format: "straight", items: [item(), item()] },
          { purpose: "activation", why: words(2, 150), format: "straight", items: [item(), item()] },
          { purpose: "main", why: words(3, 150), format: "superset", rounds: 3, restBetweenRoundsSec: 90, items: [item(), item()] },
          { purpose: "accessory", why: words(4, 150), format: "circuit", rounds: 2, items: [item(), item(), item()] },
          { purpose: "care", why: words(5, 150), format: "straight", items: [item(), item()] },
          { purpose: "cooldown", why: words(6, 150), format: "straight", items: [item()] },
        ]
      : [
          { purpose: "warmup", why: words(1, 150), format: "straight", items: [item(), item()] },
          { purpose: "main", why: words(3, 150), format: "superset", rounds: 3, restBetweenRoundsSec: 90, items: [item(), item()] },
          { purpose: "cooldown", why: words(6, 150), format: "straight", items: [item(), item()] },
        ];
  return workoutDocSchema.parse({
    version: 1,
    title: `Hips, upper back and a calm trunk ${variant}`,
    intent: { summary: words(variant, 190), goals: ["posture", "strength", "mobility"], focus: ["upper-back", "glutes"], effort: "develop", objectiveIds },
    parts,
    source: { kind: "coach" },
    notes: words(variant + 5, 480),
  });
}

const thinking = (n: number): AnswerBlock => ({ type: "thinking", signature: `Eq${"QWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo".repeat(Math.ceil(n / 34))}`.slice(0, n) });
let callSeq = 0;
const use = (name: string, input: unknown): AnswerBlock => ({ type: "tool_use", id: `toolu_bench${++callSeq}`, name, input });

// ── The accounts ────────────────────────────────────────────────────────────────────────────────────────────────────

const REQUEST =
  "Something for my hips and upper back, about 40 minutes, at home with the dumbbells and the band. My calves are tight " +
  "from Sunday's hills, so go easy on the lower legs. I'd like to feel taller at my desk afterwards, and keep the squat " +
  "progressing if it fits.";

let cookie = "";
let userId = "";
let runId = "";
let rich: Awaited<ReturnType<typeof seedRichAthlete>>;
const images = new Map<string, Buffer>();
const sizes: string[] = [];
let calibration = 0;
let calibrationBefore = 0;
let calibrationAfter = 0;
let loadBefore: number[] = [];
let loadAfter: number[] = [];

async function stateOf(db: Db, id: string): Promise<RunState> {
  const [row] = await db.select({ state: schema.coachRuns.state }).from(schema.coachRuns).where(eq(schema.coachRuns.id, id));
  return JSON.parse(row!.state!) as RunState;
}

const step = (w: World) => w.runs.request(`/api/coach/runs/${runId}/step`, { method: "POST", headers: { Cookie: cookie } }, env);

/** The step's answer, checked: its status, and the kinds of the events it wrote. */
const expectStep = (status: string | null, kinds?: (k: string[]) => boolean) => (body: unknown) => {
  const b = body as { status: string; events: Array<{ kind: string; summary: string }> };
  const k = b.events.map((e) => e.kind);
  if ((status !== null && b.status !== status) || (kinds && !kinds(k))) {
    throw new Error(`expected ${status}, got ${b.status}: ${b.events.map((e) => `${e.kind}: ${e.summary}`).join(" | ")}`);
  }
};
const resultsIn = (k: string[]): number => k.filter((x) => x === "tool_result").length;
const results = (n: number) => (k: string[]) => resultsIn(k) === n;
/** Steps of queued calls a drain takes at most (a turn's twelve calls go in three). */
const DRAIN_STEPS_MAX = 8;

/**
 * The steps of queued calls after `image`, each measured from where the last left off, until the run's queue is empty:
 * shapes `${id}.1`, `${id}.2`, … (each labelled with how many calls it ran). Answers the database the last left (open).
 */
async function drain(id: string, label: (k: number, ran: number) => string, image: Buffer, budget: number): Promise<World> {
  let from = image;
  for (let k = 1; k <= DRAIN_STEPS_MAX; k++) {
    let ran = 0;
    const w = await measure(`${id}.${k}`, "", from, step, {
      budget,
      check: (b) => {
        expectStep("active", (kinds) => (ran = resultsIn(kinds)) > 0)(b);
      },
    });
    shapes.get(`${id}.${k}`)!.label = label(k, ran);
    if ((await stateOf(w.db, runId)).pending.length === 0) return w;
    from = imageOf(w.db);
    w.close();
  }
  throw new Error(`${id}: the queue was not empty after ${DRAIN_STEPS_MAX} steps`);
}

const mainCtx = (db: Db): ToolContext => ({ db, env, userId, run: { id: runId, role: "main", scope: { kind: "now" }, parentId: null, rehearsal: false }, now: NOW });

/** Moves the rich athlete may do today, each alone (validate_workout finds no error): what a designer would pick from. */
async function movesForToday(db: Db): Promise<string[]> {
  const ok: string[] = [];
  for (const ex of EXERCISES) {
    if (ok.length >= 24) break;
    const doc = {
      version: 1, title: "Probe", intent: { summary: "Probe.", goals: [], focus: [], effort: "maintain" },
      parts: [{ purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: ex.id, dose: { sets: 2, reps: 8, restSec: 45 } }] }], source: { kind: "coach" },
    };
    const r = await validateWorkout.run(mainCtx(db), { doc, date: TODAY });
    if (!isToolErr(r) && (r.data as { valid?: boolean }).valid) ok.push(ex.id);
  }
  if (ok.length < 20) throw new Error(`only ${ok.length} moves fit today`);
  return ok;
}

async function expectValid(db: Db, docs: WorkoutDoc[]): Promise<void> {
  for (const doc of docs) {
    const v = await validateWorkout.run(mainCtx(db), { doc, date: TODAY });
    if (isToolErr(v) || !(v.data as { valid: boolean }).valid) throw new Error(`a designed document is not valid: ${JSON.stringify(isToolErr(v) ? v : (v.data as { errors: unknown }).errors)}`);
  }
}

/** A run state padded near its cap with turns like the ones it holds (a read, answered as before). */
function padded(state: RunState, targetBytes: number): RunState {
  const out = structuredClone(state);
  const answered = out.messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content.filter((b) => b.type === "tool_result"))) as Array<{ content: string }>;
  for (let turn = 0; JSON.stringify(out).length < targetBytes && turn < 200; turn++) {
    const id = `toolu_pad${turn}`;
    out.messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: (thinking(1_200) as { signature: string }).signature },
        { type: "text", text: words(turn, 160) },
        { type: "tool_use", id, name: "read_history", input: { from: day(91), to: TODAY, limit: 30 } },
      ],
    });
    out.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: answered[turn % answered.length]!.content }] });
  }
  return out;
}

/** Two years of an athlete's record up to `today`: a session every other day (11 sets; a third from a coach or Studio
 * document, with its locked build), a run every other day, threshold pace every day, three objectives over every
 * measure family. */
async function seedLongHistory(db: Db, uid: string, today: string): Promise<void> {
  const daysAgo = (n: number) => addDays(today, -n);
  const T0 = at(today);
  const objectiveIds = [`${uid}-obj-hold`, `${uid}-obj-run`];
  const sessions: Array<typeof schema.performedSessions.$inferInsert> = [];
  const sets: Array<typeof schema.performedSets.$inferInsert> = [];
  const planned: Array<typeof schema.plannedWorkouts.$inferInsert> = [];
  const builds: Array<typeof schema.sessionBuilds.$inferInsert> = [];
  const doc = (n: number): WorkoutDoc =>
    workoutDocSchema.parse({
      version: 1,
      title: `Strength ${n}`,
      intent: { summary: words(n, 150), goals: ["strength"], focus: [], effort: "develop", objectiveIds },
      parts: [
        {
          purpose: "main",
          format: "straight",
          items: [
            { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 3, reps: 8, load: { typed: "35 lb", kg: 15.9 }, restSec: 90 } },
            { kind: "exercise", libraryId: "wallSit", dose: { sets: 3, holdSec: 45 } },
            { kind: "exercise", libraryId: "deadBug", dose: { sets: 2, reps: 10, perSide: true } },
            { kind: "exercise", libraryId: "bandRow", dose: { sets: 3, reps: 12 } },
          ],
        },
      ],
      source: { kind: n % 2 ? "coach" : "studio" },
    });
  for (let n = 1; n <= 730; n += 2) {
    const date = daysAgo(n);
    const id = `long-s${n}`;
    const fromDoc = n % 3 === 1;
    const workoutId = fromDoc ? `long-w${n}` : null;
    const buildId = fromDoc ? `long-b${n}` : null;
    if (fromDoc) {
      const d = doc(n);
      planned.push({
        id: workoutId!, userId: uid, planId: `studio-${uid}`, sourceWorkoutId: workoutId!, title: d.title, category: "strength", sport: "strength",
        originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "07:00", sourceContentFingerprint: "fp",
        calendarBlockDurationSeconds: 2700, completionState: "completed", origin: "studio", workoutDoc: JSON.stringify(d), workoutDocRev: 1, createdAt: T0, updatedAt: T0,
      });
      builds.push({
        id: buildId!, userId: uid, workoutId: workoutId!, version: 1, engineVersion: "bench", inputsHash: "h", workoutDoc: JSON.stringify(d), lockedAt: at(date, "06:55"), createdAt: at(date, "06:50"),
        payload: {
          build: {
            steps: [
              ...[0, 1, 2].map((i) => ({ kind: "set", exerciseId: "gobletSquat", slotKey: "main-0", log: 1, set: i, target: { reps: 8, w: { v: 35, u: "lb" } } })),
              ...[0, 1, 2].map((i) => ({ kind: "timed", exerciseId: "wallSit", slotKey: "main-1", log: 1, set: i, seconds: 45 })),
              ...[0, 1].map((i) => ({ kind: "set", exerciseId: "deadBug", slotKey: "main-2", log: 1, set: i, target: { reps: 10 } })),
              ...[0, 1, 2].map((i) => ({ kind: "set", exerciseId: "bandRow", slotKey: "main-3", log: 1, set: i, target: { reps: 12 } })),
            ],
          },
        },
      });
    }
    sessions.push({
      id, userId: uid, source: "app", localDate: date, startedAt: at(date, "07:00"), seconds: 2400, minutes: 40, mode: "build", theme: "fullBody", completed: true,
      workoutId, buildId,
      movesDone: ["gobletSquat", "wallSit", "deadBug", "bandRow"].map((exerciseId, i) => ({ exerciseId, seconds: 240, slotKey: `main-${i}` })),
      payloadHash: `h-${n}`, createdAt: at(date, "07:45"), updatedAt: at(date, "07:45"),
    });
    const set = (entryIndex: number, exerciseId: string, setIndex: number, o: Partial<typeof schema.performedSets.$inferInsert>) =>
      sets.push({ id: `${id}-${entryIndex}-${setIndex}`, performedSessionId: id, entryIndex, exerciseId, setIndex, done: true, ...o });
    const kg = 13.6 + Math.floor((730 - n) / 60) * 1.1;
    for (let i = 0; i < 3; i++) set(0, "gobletSquat", i, { reps: 8 - (i === 2 ? 1 : 0), loadValue: Math.round(kg * 2.2), loadUnit: "lb", loadKg: kg });
    for (let i = 0; i < 3; i++) set(1, "wallSit", i, { seconds: 35 + ((730 - n) % 40) + i });
    for (let i = 0; i < 2; i++) set(2, "deadBug", i, { reps: 10, perSide: true });
    for (let i = 0; i < 3; i++) set(3, "bandRow", i, { reps: 12 });
  }
  const runs: Array<typeof schema.activities.$inferInsert> = [];
  for (let n = 0; n < 730; n += 2) {
    const date = daysAgo(n);
    const meters = [5000, 6400, 8000, 10_000, 5000, 12_000, 21_100][n % 7]!;
    const seconds = Math.round((meters / 1000) * (300 + (n % 9) * 6));
    runs.push({
      id: `long-r${n}`, userId: uid, source: "coros", startTime: at(date, "18:00"), startTimeLocal: `${date}T18:00:00`, sport: "run", durationSeconds: seconds,
      distanceMeters: meters, avgHeartRate: 138 + (n % 18), avgPaceSecPerKm: seconds / (meters / 1000), trainingLoad: 50 + (n % 40),
      telemetry: { feelRating: 3 + (n % 3), aerobicEffect: 2.8 }, title: "Evening run", createdAt: at(date, "19:00"), updatedAt: at(date, "19:00"),
    });
  }
  const health = Array.from({ length: 730 }, (_, n) => ({
    id: `${uid}:${daysAgo(n)}`, userId: uid, date: daysAgo(n), restingHeartRate: 50 + (n % 4), hrv: 55 + (n % 7), thresholdPaceSecPerKm: 290 + (n % 11), contentFingerprint: "fp", updatedAt: T0,
  }));
  const chunked = async <T>(rows: T[], insert: (part: T[]) => Promise<unknown>) => {
    for (let i = 0; i < rows.length; i += 100) await insert(rows.slice(i, i + 100));
  };
  await chunked(planned, (p) => db.insert(schema.plannedWorkouts).values(p));
  await chunked(builds, (p) => db.insert(schema.sessionBuilds).values(p));
  await chunked(sessions, (p) => db.insert(schema.performedSessions).values(p));
  await chunked(sets, (p) => db.insert(schema.performedSets).values(p));
  await chunked(runs, (p) => db.insert(schema.activities).values(p));
  await chunked(health, (p) => db.insert(schema.dailyHealth).values(p));
  await db.insert(schema.objectives).values([
    { id: objectiveIds[0]!, userId: uid, title: "Hold a strong wall sit", why: "Ski legs", status: "active", goalIds: ["strength"], sort: 0, createdAt: T0, updatedAt: T0 },
    { id: objectiveIds[1]!, userId: uid, title: "A faster half", status: "active", goalIds: ["speed"], sort: 1, createdAt: T0, updatedAt: T0 },
    { id: `${uid}-obj-back`, userId: uid, title: "A stronger back", status: "active", goalIds: ["posture"], sort: 2, createdAt: T0, updatedAt: T0 },
  ]);
  const kr = (objectiveId: string, label: string, measure: Record<string, unknown>, unit: string, position: number, o: { target?: number; direction?: string } = {}) => ({
    id: newId(), userId: uid, objectiveId, label, measure, direction: o.direction ?? "up", baseline: null, target: o.target ?? null, unit, position, createdAt: T0, updatedAt: T0,
  });
  await db.insert(schema.keyResults).values([
    kr(objectiveIds[0]!, "Wall sit hold", { kind: "hold_max", libraryIds: ["wallSit"], windowDays: 90 }, "s", 0, { target: 90 }),
    kr(objectiveIds[0]!, "Goblet squat estimated max", { kind: "best_set", libraryIds: ["gobletSquat"], metric: "e1rm", windowDays: 90 }, "lb", 1, { target: 60 }),
    kr(objectiveIds[1]!, "5K time", { kind: "run_best", distanceM: 5000, windowDays: 180 }, "s", 0, { direction: "down", target: 1500 }),
    kr(objectiveIds[1]!, "10K time", { kind: "run_best", distanceM: 10_000, windowDays: 180 }, "s", 1, { direction: "down", target: 3100 }),
    kr(objectiveIds[1]!, "Pace at easy heart rate", { kind: "pace_at_hr", hrLow: 140, hrHigh: 155, minDurationSec: 1200, windowDays: 90 }, "s/km", 2, { direction: "down" }),
    kr(objectiveIds[1]!, "Threshold pace", { kind: "threshold_pace", windowDays: 90 }, "s/km", 3, { direction: "down" }),
    kr(objectiveIds[1]!, "Predicted half", { kind: "predicted_time", distanceM: 21_097, windowDays: 90 }, "min", 4, { direction: "down" }),
    kr(`${uid}-obj-back`, "Band row reps", { kind: "best_set", libraryIds: ["bandRow", "deadBug"], metric: "reps", windowDays: 60 }, "reps", 0, { target: 15 }),
  ]);
}

// ── Measuring ───────────────────────────────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  // ── 1–4: a "now" run on the rich athlete, on its fixed clock ──
  const base = makeTestDb();
  rich = await seedRichAthlete(base);
  userId = rich.userId;
  cookie = `${SESSION_COOKIE}=${await createSession(base, userId)}`;
  runId = (await createRun(base, userId, { scope: { kind: "now" }, request: REQUEST }, NOW)).run.id;
  const moves = await movesForToday(base);
  images.set("created", imageOf(base));
  clientOf(base).close();

  // The runner's speed, taken once the process has settled (as session-build-bench.test.ts takes it, after its setup).
  loadBefore = loadavg();
  calibrate();
  calibrationBefore = calibrate();

  // 1a. The opening context: its own step.
  let w = await measure("1a", "1a. context step (the opening context)", images.get("created")!, step, { budget: 3, check: expectStep("active") });
  const opened = await stateOf(w.db, runId);
  const systemBytes = JSON.stringify(opened.system).length;
  const headerBytes = JSON.stringify(opened.messages).length;
  const toolBytes = JSON.stringify(allTools().map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))).length;
  sizes.push(`opening context: system ${systemBytes} B + header ${headerBytes} B (~${Math.round((systemBytes + headerBytes) / 3.5)} tokens at 3.5 B a token); tools ${toolBytes} B (~${Math.round(toolBytes / 3.5)} tokens)`);
  images.set("opened", imageOf(w.db));
  w.close();

  // 1b. The first model call: a tool_use turn of 12 reads, heaviest first; the step runs what fits its CPU room.
  const twelve = streamOf([
    thinking(2_400),
    { type: "text", text: words(0, 220) },
    use("read_balance", { from: day(91), to: TODAY }),
    use("read_history", { from: day(91), to: TODAY, limit: 30 }),
    use("search_library", {}),
    use("read_objectives", {}),
    use("read_answers", { limit: 50 }),
    use("read_plan", { from: TODAY, to: day(-13), limit: 50 }),
    use("read_readiness", { days: 30 }),
    use("read_day", { date: TODAY }),
    use("read_profile", {}),
    use("recall_memory", { limit: 30 }),
    use("list_workouts", { from: day(30), to: day(-14), limit: 50 }),
    use("list_templates", { limit: 50 }),
  ]);
  answer = twelve.chunks;
  sizes.push(`the 12-read answer: ${twelve.contentBytes} B of content in ${twelve.chunks.length} events`);
  let ran = 0;
  w = await measure("1b", "1b. first model step: a stream of 12 reads", images.get("opened")!, step, {
    budget: GO_LIVE_BUDGET_MS,
    check: (b) => {
      expectStep("active", (k) => (ran = resultsIn(k)) > 0)(b);
    },
  });
  shapes.get("1b")!.label = `1b. first model step: a stream of 12 reads, ${ran} run`;
  images.set("read1", imageOf(w.db));
  w.close();

  // 1c. The queued reads (no model call), a step at a time until none is left.
  w = await drain("1c", (k, n) => `1c. pending step ${k}: ${n} queued reads`, images.get("read1")!, 5);
  images.set("read12", imageOf(w.db));
  const afterReads = await stateOf(w.db, runId);
  sizes.push(`state after the 12 reads: ${JSON.stringify(afterReads).length} B`);

  // 2a. Thinking and four whole documents to validate: the model step reads them and runs none (a document-sized
  // answer); the steps after it run the validates, MAX_DOCUMENT_TOOLS_PER_STEP at a time.
  const objectiveIds = [`${userId}-obj-hold`];
  const docs = [0, 1, 2, 3].map((v) => designedDoc(moves, v, objectiveIds));
  await expectValid(w.db, docs);
  w.close();
  const four = streamOf([thinking(3_000), { type: "text", text: words(3, 200) }, ...docs.map((doc) => use("validate_workout", { doc, date: TODAY }))]);
  if (four.contentBytes > ANSWER_MAX_BYTES) throw new Error(`the 4-document answer is ${four.contentBytes} B, over the answer cap`);
  sizes.push(
    `a whole document: ${JSON.stringify(docs[0]).length} B (~${Math.round(JSON.stringify(docs[0]).length / 3.5)} tokens); the 4-document answer: ` +
      `${four.contentBytes} B of content in ${four.chunks.length} events (${four.chunks.reduce((s, c) => s + c.length, 0)} B streamed)`,
  );
  answer = four.chunks;
  w = await measure("2a", "2a. model step: 4 whole documents streamed (none run: a document-sized answer)", images.get("read12")!, step, {
    budget: GO_LIVE_BUDGET_MS,
    check: expectStep("active", results(0)),
  });
  images.set("four-queued", imageOf(w.db));
  w.close();
  (await drain("2a.q", (k, n) => `2a.q pending step ${k}: ${n} × validate_workout of a whole document`, images.get("four-queued")!, GO_LIVE_BUDGET_MS)).close();
  const tiny = { system: [], messages: [{ role: "user" as const, content: "x" }], tools: [], maxTokens: 16_000 };
  await measurePart("2a.stream", "   part: that answer's stream alone, an event a read", async () => {
    answer = four.chunks;
    if (!(await callMessages(env, tiny, gatewayFetch)).ok) throw new Error("stream failed");
  });
  const oneRead = new Uint8Array(four.chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of four.chunks) {
    oneRead.set(c, offset);
    offset += c.length;
  }
  await measurePart("2a.parse", "   part: the same stream in one read (the parse alone)", async () => {
    answer = [oneRead];
    if (!(await callMessages(env, tiny, gatewayFetch)).ok) throw new Error("stream failed");
  });
  (await measure("2a.validate", "   part: one validate_workout of a whole document", images.get("read12")!, async (x) => {
    if (isToolErr(await validateWorkout.run(mainCtx(x.db), { doc: docs[0], date: TODAY }))) throw new Error("validate failed");
  }, { budget: null })).close();

  // 8. Each tool's own CPU, on the rich athlete after the twelve reads: the read tools at their widest asks, and the
  // act tools as a designer turn calls them (a whole document to validate and propose).
  {
    const ctx = (x: World): ToolContext => ({ ...mainCtx(x.db), toolUseId: "toolu_bench_weight" });
    const reads: Array<[string, unknown]> = [
      ["read_profile", {}],
      ["read_day", { date: TODAY }],
      ["read_plan", { from: day(30), to: day(-60), limit: 50 }],
      ["list_workouts", { from: day(45), to: day(-45), limit: 50 }],
      ["get_workout", { id: rich.pastDocId }],
      ["read_history", { from: day(91), to: TODAY, limit: 30 }],
      ["read_balance", { from: day(91), to: TODAY }],
      ["read_readiness", { days: 30 }],
      ["read_answers", { since: day(91), limit: 50 }],
      ["read_objectives", { limit: 12 }],
      ["search_library", { query: "hip", filters: { fitToday: true }, limit: 30 }],
      ["get_exercise", { id: "gobletSquat", howTo: true }],
      ["list_templates", { limit: 50 }],
      ["read_proposals", { limit: 30 }],
      ["recall_memory", { limit: 30 }],
    ];
    for (const [name, input] of reads) await measureTool(name, images.get("read12")!, ctx, input);
    await measureTool("validate_workout", images.get("read12")!, ctx, { doc: docs[0], date: TODAY });
    await measureTool("propose_workout", images.get("read12")!, ctx, { doc: docs[0], target: { kind: "new", date: TODAY }, changeNote: words(6, 180) });
    await measureTool("ask_athlete", images.get("read12")!, ctx, {
      questions: [{ text: "How tight are the calves today?", chips: [{ label: "a little", value: 2 }, { label: "a lot", value: 7 }], why: "It sets the range.", checkin: { question: "tightness", area: "calves" } }],
    });
    await measureTool("record_answer", images.get("read12")!, ctx, { answers: [{ question: "tightness", area: "calves", quote: "My calves are tight from Sunday's hills" }] });
    await measureTool("remember", images.get("read12")!, ctx, { kind: "fact", body: words(1, 200), confidence: "stated" });
    await measureTool("adjust_plan", images.get("read12")!, ctx, { workoutId: rich.outlineToday, change: { kind: "skip", reason: "Rest the legs today." }, why: words(2, 150) });
    await measureTool("finish", images.get("read12")!, ctx, { summary: words(3, 200) });
  }

  // 2b. Validate, then propose: two documents, so the model step runs neither; the next runs both — the reviewer's
  // packet is built and the reviewer started, in that step.
  answer = streamOf([
    thinking(3_000),
    { type: "text", text: words(5, 200) },
    use("validate_workout", { doc: docs[0], date: TODAY }),
    use("propose_workout", { doc: docs[0], target: { kind: "new", date: TODAY }, changeNote: words(6, 180) }),
  ]).chunks;
  w = await measure("2b", "2b. model step: validate + propose streamed (none run: a document-sized answer)", images.get("read12")!, step, {
    budget: GO_LIVE_BUDGET_MS,
    check: expectStep("active", results(0)),
  });
  images.set("validate-propose-queued", imageOf(w.db));
  w.close();
  w = await measure("2b.q", "2b.q pending step: validate + propose (packet built, reviewer started)", images.get("validate-propose-queued")!, step, {
    budget: GO_LIVE_BUDGET_MS,
    check: expectStep(null, (k) => k.includes("draft")),
  });
  images.set("proposed", imageOf(w.db));

  // 2e. Propose alone (what the prompt asks for once the designer is confident: propose re-validates): one whole
  // document, its answer just under DOCUMENT_ANSWER_BYTES, so propose runs in the model step.
  const alone = streamOf([
    thinking(3_000),
    { type: "text", text: words(5, 200) },
    use("propose_workout", { doc: docs[0], target: { kind: "new", date: TODAY }, changeNote: words(6, 180) }),
  ]);
  sizes.push(`the propose-alone answer: ${alone.contentBytes} B of content (a document-sized answer is over ${DOCUMENT_ANSWER_BYTES} B)`);
  answer = alone.chunks;
  (await measure("2e", "2e. model step: one whole document streamed, propose_workout alone", images.get("read12")!, step, {
    budget: GO_LIVE_BUDGET_MS,
    check: expectStep(null, (k) => k.includes("draft")),
  })).close();

  // 2c / 2d. Nine smaller documents to validate: the model step reads them and runs none; the steps after it run the
  // validates, MAX_DOCUMENT_TOOLS_PER_STEP at a time.
  {
    const halves = Array.from({ length: 9 }, (_, v) => designedDoc(moves, v, objectiveIds, "half"));
    const nine = streamOf([thinking(2_000), ...halves.map((doc) => use("validate_workout", { doc, date: TODAY }))]);
    if (nine.contentBytes > ANSWER_MAX_BYTES) throw new Error(`the 9-document answer is ${nine.contentBytes} B, over the answer cap`);
    answer = nine.chunks;
    const x = await measure("2c", "2c. model step: 9 half documents streamed (none run: a document-sized answer)", images.get("read12")!, step, {
      budget: GO_LIVE_BUDGET_MS,
      check: expectStep("active", results(0)),
    });
    images.set("nine-queued", imageOf(x.db));
    x.close();
    (await drain("2d", (k, n) => `2d. pending step ${k}: ${n} × validate_workout of a half document`, images.get("nine-queued")!, GO_LIVE_BUDGET_MS)).close();
  }

  // 4a. The reviewer's packet alone: the designer's calls, ranked by evidence, cut near 24 KB.
  const designer = await stateOf(w.db, runId);
  const [proposal] = await w.db.select({ ops: schema.coachProposals.ops }).from(schema.coachProposals).where(eq(schema.coachProposals.id, designProposalId(runId)));
  w.close();
  const op = (proposal!.ops as Array<Record<string, unknown>>)[0]!;
  const draft: DraftForReview = {
    proposalId: designProposalId(runId),
    target: op.target as DraftForReview["target"],
    date: String(op.date),
    doc: op.doc as WorkoutDoc,
    issues: (op.issues ?? []) as DraftForReview["issues"],
    derived: op.derived as Record<string, unknown>,
    changeNote: words(6, 180),
  };
  const records = toolRecords(designer.messages, designer.results);
  sizes.push(
    `the reviewer's packet: ${records.length} records (${JSON.stringify(records).length} B) → ${reviewPacket({ round: 1, draft, records }).length} B ` +
      `(records cut near ${TOOL_RECORDS_MAX_BYTES} B)`,
  );
  await measurePart("4a", "4a. the reviewer's packet (toolRecords + reviewPacket), inside 2b", async () => reviewPacket({ round: 1, draft, records: toolRecords(designer.messages, designer.results) }));

  // 4b. The reviewer's opening context (its packet in the header).
  w = await measure("4b", "4b. reviewer context step", images.get("proposed")!, step, { budget: 3 });
  images.set("reviewer-opened", imageOf(w.db));
  w.close();

  // 4c. The reviewer's turn: thinking and submit_review.
  const reviewInput = {
    scores: Object.fromEntries(REVIEW_DIMENSIONS.map((d, i) => [d.id, 3 + (i % 3)])),
    notes: Object.fromEntries(REVIEW_DIMENSIONS.map((d, i) => [d.id, words(i, 230)])),
    mustFix: [words(1, 220), words(2, 220)],
    improvements: [words(3, 220), words(4, 220), words(5, 220), words(6, 220)],
    accepted: [{ dimension: "time_fit", why: words(8, 200) }],
  };
  {
    // 8. submit_review's own CPU, as the reviewer calls it.
    const x = open(images.get("reviewer-opened")!);
    const [rv] = await x.db
      .select({ id: schema.coachRuns.id, state: schema.coachRuns.state })
      .from(schema.coachRuns)
      .where(and(eq(schema.coachRuns.parentId, runId), eq(schema.coachRuns.role, "reviewer")));
    const reviewOf = (JSON.parse(rv!.state!) as RunState).reviewOf!;
    x.close();
    await measureTool(
      "submit_review",
      images.get("reviewer-opened")!,
      (y) => ({ db: y.db, env, userId, run: { id: rv!.id, role: "reviewer", scope: { kind: "now" }, parentId: runId, rehearsal: false }, now: NOW, reviewOf, toolUseId: "toolu_bench_review" }),
      reviewInput,
    );
  }
  answer = streamOf([thinking(4_000), { type: "text", text: words(7, 200) }, use("submit_review", reviewInput)]).chunks;
  w = await measure("4c", "4c. reviewer model step (submit_review)", images.get("reviewer-opened")!, step, { budget: 4, check: expectStep(null, (k) => k.includes("review")) });
  images.set("reviewed", imageOf(w.db));
  w.close();

  // 4d. The designer resumes with its review.
  (await measure("4d", "4d. designer resumes with the review", images.get("reviewed")!, step, { budget: 3, check: expectStep("active") })).close();

  // 3. A model step at a state near its cap: two light reads; everything else is the state's own weight.
  {
    const near = open(images.get("read12")!);
    const text = JSON.stringify(padded(afterReads, 185_000));
    if (text.length >= STATE_MAX_BYTES) throw new Error("padded past the cap");
    await near.db.update(schema.coachRuns).set({ state: text }).where(eq(schema.coachRuns.id, runId));
    images.set("near-cap", imageOf(near.db));
    near.close();
    sizes.push(`the near-cap state: ${text.length} B`);
  }
  answer = streamOf([thinking(2_000), { type: "text", text: words(9, 200) }, use("read_day", { date: TODAY }), use("read_readiness", { days: 7 })]).chunks;
  (await measure("3", "3. model step at a ~190 KB state (2 reads)", images.get("near-cap")!, step, { budget: 5.5, check: expectStep("active", results(2)) })).close();

  // From here on, the real clock.
  vi.useRealTimers();
  const today = todayInZone(TZ);

  // ── 7: GET /api/coach/runs/current with 50 events of the size a run writes (inputs bounded at 1.5 KB, receipts) ──
  let cookie7 = "";
  {
    const trail = open(images.get("reviewed")!);
    // A session signed in on the real clock (the run's own expired with its fixed one).
    cookie7 = `${SESSION_COOKIE}=${await createSession(trail.db, userId)}`;
    for (let i = 0; i < 50; i++) {
      await noteOnTrail(trail.db, userId, runId, words(i, 280), {
        tool: "read_history",
        input: { from: day(91), to: TODAY, note: words(i, 1_400) },
        ok: true,
        provenance: { source: "logged sessions, runs and other sports", asOf: NOW.toISOString() },
        receipt: { rows: 30, more: true, text: words(i + 1, 1_500) },
      }, NOW);
    }
    images.set("trail", imageOf(trail.db));
    trail.close();
  }
  (await measure("7", "7. GET /api/coach/runs/current (50 events)", images.get("trail")!, (x) => x.runs.request("/api/coach/runs/current", { headers: { Cookie: cookie7 } }, env), {
    budget: 2,
    check: (b) => expect((b as { events: unknown[] }).events).toHaveLength(50),
  })).close();

  // ── 5: a 7-workout set with 3 changes on a busy fortnight — its manifest, then its approve, chunk by chunk ──
  {
    const db5 = makeTestDb();
    const { userId: uid } = await makeTestUser(db5, { timezone: TZ });
    await activateTmj(db5, uid);
    const cookie5 = `${SESSION_COOKIE}=${await createSession(db5, uid)}`;
    const stamp = new Date().toISOString();
    for (let i = 0; i < 14; i++) {
      const date = addDays(today, i);
      for (const slot of i % 3 === 0 ? ["07:00", "18:00"] : ["07:00"]) {
        const id = `w-${i}-${slot}`;
        await db5.insert(schema.plannedWorkouts).values({
          id, userId: uid, planId: "plan-1", sourceWorkoutId: id, title: "Easy run", category: "easy", sport: "run", originalPlanDate: date, lastVerifiedCorosDate: "",
          effectiveDate: date, effectiveTime: slot, sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
          createdAt: stamp, updatedAt: stamp,
        });
      }
    }
    const newRun = async (role: "main" | "designer", parentId: string | null) => {
      const id = `run-${newId()}`;
      await db5.insert(schema.coachRuns).values({ id, userId: uid, parentId, role, scope: { kind: "week" }, request: null, status: "active", state: null, steps: 0, costUsd: 0, createdAt: stamp, updatedAt: stamp });
      return { id, role, scope: { kind: "week" as const }, parentId, rehearsal: false };
    };
    const main = await newRun("main", null);
    const ctxOf = (r: ToolContext["run"]): ToolContext => ({ db: db5, env, userId: uid, run: r, now: new Date(), toolUseId: `toolu_${newId()}` });
    for (const c of [
      { workoutId: "w-1-07:00", change: { kind: "skip", reason: "Rest the legs." }, why: "Heavy legs." },
      { workoutId: "w-2-07:00", change: { kind: "adjust", durationMinutes: 20 }, why: "Keep it short." },
      { workoutId: "w-4-07:00", change: { kind: "move", toDate: addDays(today, 5), toTime: "12:00" }, why: "A freer day." },
    ]) {
      const r = await adjustPlan.run(ctxOf(main), c);
      if (isToolErr(r)) throw new Error(`adjust refused: ${r.error} — ${r.why}`);
    }
    const designers: string[] = [];
    for (let i = 0; i < 7; i++) {
      const designer = await newRun("designer", main.id);
      designers.push(designer.id);
      const r = await proposeWorkout.run(ctxOf(designer), { doc: calmDoc({ title: `Day ${i + 1}` }), target: { kind: "new", date: addDays(today, i + 1) } });
      if (isToolErr(r)) throw new Error(`propose refused: ${r.error} — ${r.why}`);
    }
    const proposalId = designProposalId(main.id);
    const [p] = await db5.select().from(schema.coachProposals).where(eq(schema.coachProposals.id, proposalId));
    const REVIEW: OpReview = { scores: { intent: 4, sequencing: 4 }, notes: { intent: "Clear." }, mustFix: [], improvements: [], rounds: 1, changes: [] };
    const ops = (p!.ops as Array<Record<string, unknown>>).map((x) => (x.kind === "doc_workout" ? { ...x, review: REVIEW } : x));
    await db5.update(schema.coachProposals).set({ ops }).where(and(eq(schema.coachProposals.id, proposalId), eq(schema.coachProposals.userId, uid)));
    images.set("set-unreviewed", imageOf(db5));
    await db5.update(schema.coachProposals).set({ status: "pending" }).where(and(eq(schema.coachProposals.id, proposalId), eq(schema.coachProposals.userId, uid)));
    images.set("set", imageOf(db5));
    clientOf(db5).close();

    // 8. The set's tools, on the set as the main coach holds it (its designers' round; a fresh week run for plan_set).
    {
      const round: SetRound = { toolUseId: "toolu_bench_plan", redo: false, briefs: [], designers: designers.map((runId, i) => ({ key: `d${i + 1}`, runId })) };
      const setCtx = (x: World, rounds: SetRound[], run = main): ToolContext => ({ ...ctxOf(run), db: x.db, toolUseId: "toolu_bench_set", set: setHooksOf(rounds) });
      await measureTool("read_set", images.get("set-unreviewed")!, (x) => setCtx(x, [round]), {});
      await measureTool("drop_workout", images.get("set-unreviewed")!, (x) => setCtx(x, [round]), { opId: designers[3], reason: words(2, 120) });
      const fresh = open(images.get("set-unreviewed")!);
      const planner = await (async () => {
        const id = `run-${newId()}`;
        await fresh.db.insert(schema.coachRuns).values({ id, userId: uid, parentId: null, role: "main", scope: { kind: "week" }, request: null, status: "active", state: null, steps: 0, costUsd: 0, createdAt: stamp, updatedAt: stamp });
        return { id, role: "main" as const, scope: { kind: "week" as const }, parentId: null, rehearsal: false };
      })();
      images.set("set-planner", imageOf(fresh.db));
      fresh.close();
      const briefs = [1, 3, 5].map((d, i) => ({
        key: `day${i + 1}`,
        date: addDays(today, d),
        time: "12:30",
        purpose: words(i, 160),
        emphasis: words(i + 1, 160),
        constraints: words(i + 2, 240),
        why: words(i + 3, 240),
        sameDayWhy: words(i + 4, 160),
      }));
      await measureTool("plan_set", images.get("set-planner")!, (x) => setCtx(x, [], planner), { briefs });
    }

    (await measure("5a", "5a. GET /api/coach/proposals/:id (the manifest: placedTimes, relaidDay)", images.get("set")!, (x) => x.coach.request(`/api/coach/proposals/${proposalId}`, { headers: { Cookie: cookie5 } }, env), {
      budget: 3,
      check: (b) => expect((b as { lines: unknown[] }).lines).toHaveLength(7),
    })).close();

    // Each approve request in turn, from the same start: the chunks the client asks for until nothing remains.
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
    const chunkSamples: Sample[][] = [];
    const chunkFirst: number[] = [];
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const x = open(images.get("set")!);
      let remaining: string[] | null = null;
      for (let k = 0; remaining === null || remaining.length > 0; k++) {
        if (k >= MAX_LOOP_ITERATIONS) throw new Error("the approve never finished");
        const pending: Array<Promise<unknown>> = [];
        const executionCtx = { waitUntil: (pr: Promise<unknown>) => void pending.push(pr), passThroughOnException: () => undefined, props: {} };
        x.clock.reset();
        const t = performance.now();
        const res = await x.coach.request(
          `/api/coach/proposals/${proposalId}/approve`,
          { method: "POST", headers: { Cookie: cookie5, "Content-Type": "application/json" }, body: JSON.stringify(remaining ? { opIds: remaining } : {}) },
          env,
          executionCtx as never,
        );
        // The request's waitUntil work (the calendar's step) is in its CPU too.
        await Promise.all(pending);
        const total = performance.now() - t;
        const s: Sample = { js: total - x.clock.sqlite(), wire: x.clock.wire(), sqlite: x.clock.sqlite(), statements: x.clock.statements() };
        if (res.status !== 200) throw new Error(`approve answered ${res.status}: ${await res.text()}`);
        remaining = ((await res.json()) as { remaining: string[] }).remaining;
        if (i === 0) chunkFirst[k] = s.js;
        if (i >= WARMUP) (chunkSamples[k] ??= []).push(s);
      }
      x.close();
    }
    vi.unstubAllGlobals();
    chunkSamples.forEach((samples, k) => {
      shapes.set(`5b.${k + 1}`, { label: `5b. approve request ${k + 1} of ${chunkSamples.length}${k === 0 ? " (the 3 changes)" : " (workouts)"}`, samples, first: chunkFirst[k]!, budget: 4 });
    });
  }

  // ── 6: the objectives board over two years ──
  {
    const db6 = makeTestDb();
    const { userId: uid } = await makeTestUser(db6, { timezone: TZ, weightUnit: "lb", units: "km", raceDate: addDays(today, 38), raceDistanceKm: 21.1 });
    await seedLongHistory(db6, uid, today);
    const cookie6 = `${SESSION_COOKIE}=${await createSession(db6, uid)}`;
    const count = async (t: typeof schema.performedSets | typeof schema.activities | typeof schema.performedSessions) => (await db6.select({ n: sql<number>`count(*)` }).from(t))[0]!.n;
    sizes.push(`two years: ${await count(schema.performedSessions)} sessions, ${await count(schema.performedSets)} sets, ${await count(schema.activities)} runs, 730 threshold days`);
    images.set("long", imageOf(db6));
    clientOf(db6).close();
    (await measure("6", "6. GET /api/objectives/board (2 years; best ever reads it all)", images.get("long")!, (x) => x.board.request("/api/objectives/board", { headers: { Cookie: cookie6 } }, env), {
      budget: GO_LIVE_BUDGET_MS,
      check: (b) => expect((b as { objectives: unknown[] }).objectives).toHaveLength(3),
    })).close();
  }

  calibrationAfter = calibrate();
  loadAfter = loadavg();
  calibration = (calibrationBefore + calibrationAfter) / 2;
  report();
}, 600_000);

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const scaled = (ms: number) => ms * (REFERENCE_CALIBRATION_MS / (calibration || REFERENCE_CALIBRATION_MS));
const p50Of = (s: Shape) => percentile(s.samples.map((x) => x.js), 50);
const p95Of = (s: Shape) => percentile(s.samples.map((x) => x.js), 95);

function report(): void {
  const f = (x: number) => x.toFixed(2).padStart(6);
  const lines = [
    `[design CPU] ${RUNS} timed runs a shape after ${WARMUP} warm-up; calibration ${calibrationBefore.toFixed(1)} / ${calibrationAfter.toFixed(1)} ms vs ` +
      `${REFERENCE_CALIBRATION_MS} (scale ×${(REFERENCE_CALIBRATION_MS / calibration).toFixed(2)}); load ${loadBefore.map((x) => x.toFixed(2)).join(" ")} → ` +
      `${loadAfter.map((x) => x.toFixed(2)).join(" ")} on ${availableParallelism()} cores`,
    ...sizes.map((s) => `[design CPU]   ${s}`),
    `[design CPU] ${"ms (Worker CPU; wire = D1's JSON, inside it)".padEnd(72)}   p50    p95  first   wire sqlite stmts | scaled p50  p95 budget`,
  ];
  for (const [, s] of shapes) {
    lines.push(
      `[design CPU] ${s.label.padEnd(72)} ${f(p50Of(s))} ${f(p95Of(s))} ${f(s.first)} ${f(percentile(s.samples.map((x) => x.wire), 50))} ` +
        `${f(percentile(s.samples.map((x) => x.sqlite), 50))} ${String(s.samples[0]!.statements).padStart(5)} | ${f(scaled(p50Of(s)))} ${f(scaled(p95Of(s)))} ` +
        `${s.budget === null ? "     -" : f(s.budget)}${s.budget !== null && scaled(p50Of(s)) >= s.budget ? "  OVER" : ""}`,
    );
  }
  console.log(lines.join("\n"));
}

function unscalable(): string | null {
  if (ON_CI) return "on CI: timings printed, not asserted (a shared runner's speed is not the reference machine's)";
  const ratio = calibration / REFERENCE_CALIBRATION_MS;
  const drift = Math.max(calibrationBefore, calibrationAfter) / Math.min(calibrationBefore, calibrationAfter);
  if (ratio > MAX_RUNNER_RATIO || ratio < 1 / MAX_RUNNER_RATIO || drift > MAX_RUNNER_RATIO) {
    return (
      `runner at ${ratio.toFixed(2)}× the reference machine's speed (calibration ${calibrationBefore.toFixed(1)} / ${calibrationAfter.toFixed(1)} ms ` +
      `before / after vs ${REFERENCE_CALIBRATION_MS} ms): a CPU timing here would measure the runner, not the request`
    );
  }
  const load = Math.max(loadBefore[0] ?? 0, loadAfter[0] ?? 0);
  if (load > availableParallelism()) return `runner loaded (1-minute load ${load.toFixed(1)} on ${availableParallelism()} cores): a CPU timing here would measure the load`;
  return null;
}

/**
 * OVER THE GO-LIVE BUDGET at this commit (scaled p50 as measured on 2026-10-16), each with the fix it waits on. Until
 * then each is held under a regression ceiling (~1.35× its measurement), so nothing gets worse unseen; once its fix
 * lands it leaves this list and meets its budget like the rest. The designer's shapes (1b, 2a–2d) left it with the
 * cheaper stream reader, the document-sized answer's queued calls and the step's CPU room.
 */
const KNOWN_OVER: Readonly<Record<string, { measured: number; ceiling: number; waitsOn: string }>> = {
  "6": { measured: 6.4, ceiling: 8.5, waitsOn: "best ever: window starts hoisted out of the per-run filter; the logged sets read as plain rows, not mapped by drizzle" },
};

/** Shapes measured as a run of requests — the queued calls' steps, the approve's chunks — each `${id}.${k}`. */
const GROUPS = ["1c", "2a.q", "2d", "5b"] as const;
const inGroup = (id: string) => [...shapes.keys()].filter((k) => k.startsWith(`${id}.`));

/** The shape `id` — or, for a group, every request of it — under its budget at p50 and the limit at p95 (scaled); a
 * shape over the budget, under its regression ceiling. */
function within(id: string, ctx: TestContext): void {
  const why = unscalable();
  if (why) ctx.skip(why);
  const over = KNOWN_OVER[id];
  const ids = (GROUPS as readonly string[]).includes(id) ? inGroup(id) : [id];
  for (const s of ids.map((k) => shapes.get(k)!)) {
    if (over) {
      expect(scaled(p50Of(s)), `${s.label}: scaled p50, over the budget, under its regression ceiling`).toBeLessThan(over.ceiling);
      continue;
    }
    expect(scaled(p50Of(s)), `${s.label}: scaled p50`).toBeLessThan(s.budget!);
    expect(scaled(p95Of(s)), `${s.label}: scaled p95`).toBeLessThan(WORKERS_CPU_LIMIT_MS);
  }
}

describe("the coach designer's requests within the Workers free plan's CPU", () => {
  it("every shape was measured", () => {
    const grouped = (k: string) => GROUPS.some((g) => k.startsWith(`${g}.`));
    expect([...shapes.keys()].filter((k) => shapes.get(k)!.budget !== null && !grouped(k))).toEqual(["1a", "1b", "2a", "2b", "2b.q", "2e", "2c", "4b", "4c", "4d", "3", "7", "5a", "6"]);
    // The queued reads go in two steps or more; four whole documents' validates in two (three, then one); nine half
    // documents' in three; the approve in five chunks or more.
    expect(inGroup("1c").length).toBeGreaterThanOrEqual(2);
    expect(inGroup("2a.q").map((k) => shapes.get(k)!.label)).toEqual([expect.stringContaining(": 3 ×"), expect.stringContaining(": 1 ×")]);
    expect(inGroup("2d").map((k) => shapes.get(k)!.label)).toEqual([1, 2, 3].map(() => expect.stringContaining(": 3 ×")));
    expect(inGroup("5b").length).toBeGreaterThanOrEqual(5);
    expect(inGroup("8").map((k) => k.slice(2)).sort()).toEqual(allTools().map((t) => t.name).sort());
  });

  it("8: every tool's declared cpuWeight covers what one call of it takes (scaled p50)", (ctx) => {
    const why = unscalable();
    if (why) ctx.skip(why);
    for (const t of allTools()) {
      const s = shapes.get(`8.${t.name}`)!;
      expect(scaled(p50Of(s)), `${t.name}: declared ${t.cpuWeight} ms`).toBeLessThanOrEqual(t.cpuWeight);
    }
  });

  for (const id of ["1a", "1b", "1c", "2a", "2a.q", "2b", "2b.q", "2c", "2d", "2e", "3", "4b", "4c", "4d", "5a", "5b", "6", "7"]) {
    const over = KNOWN_OVER[id];
    it(
      over
        ? `${id}: OVER the ${GO_LIVE_BUDGET_MS} ms budget (~${over.measured} ms) until ${over.waitsOn}; held under ${over.ceiling} ms`
        : `${id}: under its budget (scaled p50), and under ${WORKERS_CPU_LIMIT_MS} ms at p95`,
      (ctx) => within(id, ctx),
    );
  }
});
