/**
 * THE COACH DESIGNER'S CPU, REQUEST BY REQUEST (Stage 3 go-live gate). On the Workers free plan a request has 10 ms of
 * CPU. A step that goes over dies mid-way, is taken over 15 minutes later and is billed again (fix wave 3A, M6). Time
 * spent waiting on the model's stream or on D1 is not CPU; the Worker's JavaScript is.
 *
 * Every shape is a real request through its route (`POST /api/coach/runs/:id/step`, the approve, the board, the current
 * run), each run from the same starting database:
 *  1. the first steps of a "now" run on a rich account: the opening context (its own step); the first model call, a
 *     streamed tool_use turn asking for 12 reads (the step runs what its CPU room holds: MODEL_STEP_CPU_ROOM); the
 *     queued reads, a step at a time (PENDING_STEP_CPU_ROOM, MAX_TOOL_CALLS_PER_STEP); and a turn of eight multi-word
 *     searches (1d, fix wave 13 round 2, C1): the model step runs what search_library's declared weight packs, the
 *     queued steps the rest;
 *  2. a heavy designer turn: a streamed answer carrying whole workout documents (~3.4k tokens each) after thinking — an
 *     answer over DOCUMENT_ANSWER_BYTES, so the step that reads it runs none of its calls — then the steps that run them:
 *     4 × validate_workout (the answer cap, 64 KB, holds no more than ~4 such documents), 3 in a step at most
 *     (MAX_DOCUMENT_TOOLS_PER_STEP); or validate_workout then propose_workout, run together in the next step, which builds
 *     the reviewer's packet and starts the reviewer; or propose_workout alone (an answer just under the threshold: it
 *     runs in the model step); and 9 smaller documents, then their validates three steps of 3;
 *  3. a model step at a state near its cap (~190 KB): its parse, the request body, the answer, the write;
 *  4. the reviewer: its packet (cut near 24 KB, evidence first), its opening context, its submit_review turn, and the
 *     designer's resume;
 *  5. the manifest of a 7-workout set with 3 changes (`placedTimes`, `relaidDay`), and its approve, chunk by chunk; and
 *     (5p, §8 §5) a programme change's approve — six a week at four weeks ahead onto other days, its settings written
 *     and its sessions placed a request's room at a time (`placeSlotsWithin`) — request by request;
 *  6. `GET /api/objectives/board` over two years of runs, sessions and sets (best ever reads all of it);
 *  7. `GET /api/coach/runs/current` with 50 events;
 *  8. every tool's own call, alone, as a step runs it (`measureTool`): its scaled p50 must stay at or under the tool's
 *     declared `cpuWeight`, which the step loop spends its CPU room by — the rich athlete holding an owner-shaped
 *     account's plans (`seedOwnerPlans`: a four-phase running line, three buckets of one-offs, a 24-week Studio plan
 *     with its pushes), what read_plans reads;
 *  9. the step alarm (COACH_STEP_ALARM, coach-run-stepper.ts): the armed `POST /step` (the run read, its object armed),
 *     and the run's object's alarm running the tightest model step (2c) and the heaviest step of queued calls (2b.q) —
 *     an alarm invocation is a Worker invocation, under the same budgets, and its work is the step's;
 * 10. the conversation (the new shape §5): an auto run's opening context as a later turn of a conversation — the
 *     conversation so far read and written, six turns of the longest words and lines, each with a set's seven whole
 *     workouts and three changes (10a) — and `GET /api/coach/conversation` over twenty such turns (10b);
 * 11. Growth's body map (the new shape §7), `GET /api/growth/body`, over a busy season — two strength sessions of 18
 *     working sets and a run every day for 90 days: the month (11a) and the season (11b);
 * 12. the voice workshop's replay of a finished run's workout words (`POST /api/coach/replay`, `at: "prose"`): its state
 *     parsed and its request written once, and the three answers a prose replay takes at most, each a whole document.
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
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import { addDays, newId, todayInZone, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { Rng } from "@rg/session-engine";
import type { AppContext } from "../src/auth/middleware.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import { coachRoutes } from "../src/routes/coach.js";
import { makeCoachRunRoutes } from "../src/routes/coach-runs.js";
import { makeCoachConversationRoutes } from "../src/routes/coach-conversation.js";
import { objectiveBoardRoutes } from "../src/routes/objectives-board.js";
import { growthRoutes } from "../src/routes/growth.js";
import { ANSWER_MAX_BYTES, createRun, DOCUMENT_ANSWER_BYTES, noteOnTrail, STATE_MAX_BYTES, type RunDeps, type RunState } from "../src/services/coach-runs.js";
import { CoachRunStepper } from "../src/services/coach-run-stepper.js";
import { designContextBuilder } from "../src/services/design-context.js";
import { REVIEW_DIMENSIONS } from "../src/services/design-prompt.js";
import { reviewPacket, toolRecords, TOOL_RECORDS_MAX_BYTES } from "../src/services/design-review.js";
import { adjustPlan } from "../src/services/design-tools/adjust-plan.js";
import { allTools } from "../src/services/design-tools/index.js";
import { designProposalId, proposeWorkout } from "../src/services/design-tools/propose.js";
import { MAX_PLAN_SESSIONS } from "../src/services/design-tools/propose-plan.js";
import { changeProgramme } from "../src/services/design-tools/change-programme.js";
import { loadPreferences } from "../src/services/calendar-sync.js";
import { placeSlots } from "../src/services/program-slots.js";
import { isToolErr, type DraftForReview, type OpReview, type SetHooks, type SetRound, type ToolContext } from "../src/services/design-tools/types.js";
import { utf8Bytes } from "../src/services/utf8.js";
import { validateWorkout } from "../src/services/design-tools/validate.js";
import { callMessages, sendMessagesBody } from "../src/services/llm-messages.js";
import { makeCoachReplayRoutes } from "../src/routes/coach-replay.js";
import { REPLAY_CONFIRM } from "../src/services/coach-replay.js";
import type { Db } from "../src/services/db.js";
import { at, day, NOW, seedOwnerPlans, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { seedLongHistory, words } from "./long-history-fixture.js";
import { activateTmj, calmDoc } from "./doc-workout-fixture.js";
import { makeTestDb, makeTestUser, MAX_LOOP_ITERATIONS, mountRoutes } from "./helpers.js";
import { longBatchPosts, seedSavedBatch } from "./saves-batch-fixture.js";

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
  conversation: Hono<AppContext>;
  growth: Hono<AppContext>;
  replay: Hono<AppContext>;
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
    conversation: mountRoutes(db, "/api/coach/conversation", makeCoachConversationRoutes({ now: () => NOW })),
    growth: mountRoutes(db, "/api/growth", growthRoutes),
    replay: mountRoutes(db, "/api/coach/replay", replayRoutes),
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
  const once = async () =>
    (await measure(`8.${name}`, `8. ${name} (declared ${tool.cpuWeight})`, image, async (x) => {
      const r = await tool.run(ctx(x), input);
      if (isToolErr(r)) throw new Error(`${name} refused: ${r.error} — ${r.why}`);
      utf8Bytes(JSON.stringify({ provenance: r.provenance, missing: r.missing, data: r.data }));
      JSON.stringify(input);
    }, { budget: null })).close();
  // A tool's runs are timed together, so a burst of contention can take a whole measurement (one measured at 4× its
  // usual p50 on a loaded runner). Over its declaration, it is measured again, up to twice: the lowest p50 stands — a
  // tool really heavier than it declares is over every time.
  let best: Shape | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await once();
    const s = shapes.get(`8.${name}`)!;
    if (!best || p50Of(s) < p50Of(best)) best = s;
    if (p50Of(best) * (REFERENCE_CALIBRATION_MS / calibrationBefore) <= tool.cpuWeight) break;
  }
  shapes.set(`8.${name}`, best!);
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
/** The voice workshop's replay (shape 12), over the same "gateway". */
const replayRoutes = makeCoachReplayRoutes(() => ({ send: (e, c) => sendMessagesBody(e, c.model, c.body, c.maxTokens, gatewayFetch), tools: allTools() }), { now: () => NOW });

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

// ── 9: the step alarm ──

/** An object's storage, in memory (the real one is the object's own in-process SQLite: a few calls a step). */
function memoryStorage(seed: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(seed));
  let alarm: number | null = null;
  return {
    get: async (k: string) => data.get(k),
    put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
    delete: async (k: string) => data.delete(k),
    deleteAll: async () => data.clear(),
    getAlarm: async () => alarm,
    setAlarm: async (t: number) => void (alarm = t),
    deleteAlarm: async () => void (alarm = null),
  };
}

/** The run's object over `db`, its run armed and a client watching: its alarm runs the step that is due. */
const stepperOn = (db: Db): CoachRunStepper =>
  new CoachRunStepper(
    { storage: memoryStorage({ run: { runId, userId, touchedAt: Date.now(), nextAt: Date.now(), step: null, deaths: 0 } }) } as unknown as DurableObjectState,
    env,
    { db, deps: () => deps, clock: () => Date.now() },
  );
const alarmStep = async (w: World): Promise<void> => {
  await stepperOn(w.db).alarm();
};

/** The Worker with the step alarm on: the namespace's objects in memory, one request each. */
const alarmEnv = {
  ...env,
  COACH_STEP_ALARM: "1",
  COACH_RUN_STEPPER: {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: (input: string, init?: RequestInit) =>
        new CoachRunStepper({ storage: memoryStorage() } as unknown as DurableObjectState, env, { deps: () => deps }).fetch(new Request(input, init)),
    }),
  },
} as unknown as Env;

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
/**
 * A conversation of `turns` finished auto runs (the new shape §5), oldest first, a minute apart, ending a minute before
 * NOW: each asked in the longest words a request holds, finished on a long line (its finish's event, its whole text in
 * the payload), and holding a set's proposal of seven whole designed workouts and three changes — the most a turn's card
 * reads. Answers the conversation's id (its first run's).
 */
async function seedConversation(db: Db, userId: string, turns: number, moves: readonly string[]): Promise<string> {
  let first = "";
  for (let i = 0; i < turns; i++) {
    const id = newId();
    first ||= id;
    const at = new Date(NOW.getTime() - (turns - i) * 60_000).toISOString();
    await db.insert(schema.coachRuns).values({
      id, userId, parentId: null, role: "main", scope: { kind: "auto" }, request: words(i, 1_990), status: "finished",
      state: JSON.stringify({ v: 1, settings: { ceilingMicros: 6_000_000, maxCalls: 12, effort: "high", maxTokens: 16_000, rehearsal: false, conversationId: first, raisedAt: at }, system: null, messages: [] }),
      steps: 9, costUsd: 0.9, createdAt: at, updatedAt: at, finishedAt: at,
    });
    await db.run(sql`INSERT INTO coach_run_events (id, user_id, run_id, seq, kind, summary, payload, at)
      VALUES (${`${id}:1`}, ${userId}, ${id}, 1, 'note', ${words(i, 290)}, ${JSON.stringify({ text: words(i, 1_190), receipt: { final: true } })}, ${at})`);
    const ops = [
      ...Array.from({ length: 7 }, (_, k) => ({
        kind: "doc_workout", target: { kind: "new", date: addDays(TODAY, k) }, date: addDays(TODAY, k), doc: designedDoc(moves, i * 7 + k, []),
        review: null, issues: [], derived: { minutes: 45 }, by: { runId: `${id}-d${k}`, role: "designer" }, toolUseId: `t${k}`, at,
      })),
      ...Array.from({ length: 3 }, (_, k) => ({
        kind: "plan_adjust", id: `adj-w${k}`, op: { kind: "skip", workoutId: `w${k}` }, why: words(k, 290), issues: [], date: addDays(TODAY, k),
        row: { date: addDays(TODAY, k), time: "07:00", title: "Easy run", minutes: 40, category: "easy", origin: null, onWatch: false }, toolUseId: `a${k}`, at,
      })),
    ];
    await db.insert(schema.coachProposals).values({
      id: designProposalId(id), userId, planId: null, title: words(i, 80), evidence: "", rationale: "", flags: [], ops, status: "pending", createdAt: at, expiresAt: addDays(TODAY, 7),
    });
  }
  return first;
}

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

// ── Measuring ───────────────────────────────────────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);

  // ── 1–4: a "now" run on the rich athlete, on its fixed clock ──
  const base = makeTestDb();
  rich = await seedRichAthlete(base);
  userId = rich.userId;
  // An owner-shaped account's plans (training lines, final review I3): a four-phase running line with its weeks and
  // sessions, three buckets of one-offs, a 24-week Studio plan with its pushes — what read_plans (step 8) reads.
  await seedOwnerPlans(base, userId);
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

  // 1d. A turn of searches (fix wave 13, round 2, C1): the model asks for eight multi-word searches at once — a list of
  // what it wants, as the live coach writes them; the model step runs what its CPU room holds by search_library's
  // declared weight, the queued steps the rest, under the same budgets as 1b and 1c.
  {
    w.close();
    const searches = [
      "hip flexor hamstring stretch mobility",
      "glute bridge hip thrust strength",
      "calf soleus stretch ankle mobility warmup",
      "thoracic rotation upper back opening breathing",
      "core anti rotation plank side bridge",
      "hamstring eccentric slow lowering strength hinge",
      "jaw care neck release breathing downshift",
      "single leg balance knee ankle landing control",
    ];
    answer = streamOf([thinking(1_200), { type: "text", text: words(1, 120) }, ...searches.map((query) => use("search_library", { query, filters: { fitToday: true } }))]).chunks;
    let searched = 0;
    const sw = await measure("1d", "1d. model step: a turn of 8 searches", images.get("opened")!, step, {
      budget: GO_LIVE_BUDGET_MS,
      check: (b) => {
        expectStep("active", (k) => (searched = resultsIn(k)) > 0)(b);
      },
    });
    shapes.get("1d")!.label = `1d. model step: a turn of 8 multi-word searches, ${searched} run`;
    images.set("searched1", imageOf(sw.db));
    sw.close();
    (await drain("1d.q", (k, n) => `1d.q pending step ${k}: ${n} queued searches`, images.get("searched1")!, 5)).close();
    w = open(images.get("read12")!);
  }

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
      ["read_plans", {}],
      ["list_workouts", { from: day(45), to: day(-45), limit: 50 }],
      ["get_workout", { id: rich.pastDocId }],
      ["read_history", { from: day(91), to: TODAY, limit: 30 }],
      ["read_balance", { from: day(91), to: TODAY }],
      ["read_readiness", { days: 30 }],
      ["read_answers", { since: day(91), limit: 50 }],
      ["read_objectives", { limit: 12 }],
      // A list of words, as the coach writes them (round 2, C1): eight words count, the most its work grows with.
      ["search_library", { query: "hip hamstring calf stretch mobility warmup glute bridge", filters: { fitToday: true }, limit: 30 }],
      ["get_exercise", { id: "gobletSquat", howTo: true }],
      ["list_templates", { limit: 50 }],
      ["read_proposals", { limit: 30 }],
      ["recall_memory", { limit: 30 }],
    ];
    for (const [name, input] of reads) await measureTool(name, images.get("read12")!, ctx, input);
    // read_saves (saved-posts import, Task 17) over a bootstrap-sized saved batch: 40 posts — four routines of three new
    // moves at their longest (an 80-character name, a 160-character summary, a long link, creator and reading), then 36
    // posts of three library moves each (24 of them), half of them routines — 120 links grouped into 36 moves, the 12 it lists.
    {
      const withSaves = open(images.get("read12")!);
      const library = EXERCISES.slice(0, 24).map((e) => e.id);
      const more = Array.from({ length: 36 }, (_, i) => ({
        kind: i % 2 ? ("routine" as const) : ("single_move" as const),
        summary: words(i, 280),
        moves: [0, 1, 2].map((k) => ({ library: library[(i * 3 + k) % library.length]! })),
      }));
      const { batchId, moveIds } = await seedSavedBatch(withSaves.db, userId, { savedAt: at(day(1)), posts: [...longBatchPosts(), ...more], pinned: library.slice(0, 6) });
      images.set("saves", imageOf(withSaves.db));
      withSaves.close();
      // Once, before timing it: the call reads that batch and lists its moves (as many of its long ones as fit the answer),
      // never the no-batch path a window or clock shift would leave it.
      const probe = open(images.get("saves")!);
      const read = await allTools().find((t) => t.name === "read_saves")!.run(ctx(probe), {});
      probe.close();
      const data = isToolErr(read) ? null : (read.data as { batch?: { id?: string } | null; moves?: unknown[] });
      if (data?.batch?.id !== batchId || !data.moves?.length) throw new Error(`8. read_saves: the bench's call didn't read its batch (${JSON.stringify(data?.batch ?? null)})`);
      await measureTool("read_saves", images.get("saves")!, ctx, {});
      // pin_moves (Task 18) at its widest, over the same account (its personal moves in the library it reads): twenty to
      // pin — every one of the batch's twelve new moves among them, as the card must account for each (the fix wave,
      // coach-context audit I5) — twenty to unpin, the batch, and twenty lines at their longest.
      const personal = [...new Set(moveIds.flat().filter((id): id is string => typeof id === "string" && id.startsWith("my")))];
      const toPin = [...personal, ...EXERCISES.slice(24).map((e) => e.id)].slice(0, 20);
      const toUnpin = EXERCISES.slice(24).map((e) => e.id).filter((id) => !toPin.includes(id)).slice(0, 20);
      await measureTool("pin_moves", images.get("saves")!, ctx, {
        pin: toPin,
        unpin: toUnpin,
        batchId,
        title: words(4, 60),
        summary: words(5, 120),
        lines: Array.from({ length: 20 }, (_, i) => words(i, 160)),
        why: words(6, 300),
      });
    }
    await measureTool("validate_workout", images.get("read12")!, ctx, { doc: docs[0], date: TODAY });
    await measureTool("propose_workout", images.get("read12")!, ctx, { doc: docs[0], target: { kind: "new", date: TODAY }, changeNote: words(6, 180) });
    // propose_plan at its heaviest (§8 §5; the decision guidance's fix round, I1): MAX_PLAN_SESSIONS (24) lift and
    // mobility sessions over its two firm weeks — today's and the next — four moves each from three sets, at four
    // categories (three efforts: maintain, develop, recover), the recovery ones raising the active condition profile's
    // softer findings, and four shape weeks: the guardrails over the whole plan, the condition rules' check (one
    // document a day class and effort), the catalog's names, the manifest's lines. The rich athlete's profile is on:
    // the probe first proves the check runs here (a later day's jump is refused). Its world holds a realistic synced
    // COROS catalog — every strength T-code COROS names, ~390 rows — whose name index the call builds (the fix round's
    // second ruling: the declared weight must hold for a real account).
    {
      const tool = allTools().find((t) => t.name === "propose_plan")!;
      const withCatalog = open(images.get("read12")!);
      const codes = Object.keys(COROS_EXERCISE_NAMES).filter((k) => /^T1\d{3}$/.test(k));
      for (let at = 0; at < codes.length; at += 20) {
        await withCatalog.db.insert(schema.corosExercises).values(
          codes.slice(at, at + 20).map((name, i) => {
            const id = `46964646340${String(at + i).padStart(8, "0")}`;
            return { id, name, raw: { id, name }, updatedAt: NOW.toISOString() };
          }),
        );
      }
      if (codes.length < 350) throw new Error(`8. propose_plan: a catalog of ${codes.length} rows is not a real account's`);
      images.set("plan-catalog", imageOf(withCatalog.db));
      withCatalog.close();
      const moves = [
        ["Goblet squat", "Romanian deadlift", "Split squat", "Farmer carry"],
        ["Prone Y-T-W raises", "Push-up pull-through", "Short Copenhagen side plank", "Dead bug"],
        ["Cat-cow", "World's greatest stretch", "90/90 hip switch", "Glute bridge"],
      ];
      const categories = ["strength", "quality", "recovery", "yoga"] as const;
      const session = (n: number, names = moves[n % 3]!) => {
        const category = categories[n % 4]!;
        const body = { exercises: names.map((name) => ({ name, sets: 3, reps: 8, note: words(n, 60) })) };
        return { category, title: `Session ${n}`, durationMinutes: 40, ...(category === "yoga" ? { mobility: body } : { lift: body }) };
      };
      // Twelve a week: today's week from today (Wed 13 May: five days), the next whole.
      const firmSessions = Array.from({ length: MAX_PLAN_SESSIONS }, (_, n) => ({ date: n < 12 ? addDays(TODAY, n % 5) : addDays(TODAY, 5 + (n % 7)), session: session(n) }));
      const monday = addDays(TODAY, 5);
      const shapeWeeks = [1, 2, 3, 4].map((w) => ({ weekStart: addDays(monday, 7 * w), volumeTarget: words(w, 40), keySessions: [words(w, 60), words(w + 1, 60)] }));
      const plan = (sessions: typeof firmSessions) => ({
        change: { kind: "createPlan", discipline: "lift", name: "Strength block", startDate: TODAY, endDate: addDays(monday, 34), firmSessions: sessions, shapeWeeks },
        why: words(7, 280),
      });
      const probe = open(images.get("plan-catalog")!);
      const refused = await tool.run(ctx(probe), plan([...firmSessions.slice(1), { date: addDays(TODAY, 6), session: session(1, ["Pogo hops"]) }]));
      probe.close();
      if (!isToolErr(refused) || refused.error !== "plan_refused") throw new Error("8. propose_plan: the condition rules' check didn't run in the bench's world");
      await measureTool("propose_plan", images.get("plan-catalog")!, ctx, plan(firmSessions));
    }
    await measureTool("ask_athlete", images.get("read12")!, ctx, {
      questions: [{ text: "How tight are the calves today?", chips: [{ label: "a little", value: 2 }, { label: "a lot", value: 7 }], why: "It sets the range.", checkin: { question: "tightness", area: "calves" } }],
    });
    await measureTool("record_answer", images.get("read12")!, ctx, { answers: [{ question: "tightness", area: "calves", quote: "My calves are tight from Sunday's hills" }] });
    await measureTool("remember", images.get("read12")!, ctx, { kind: "fact", body: words(1, 200), confidence: "stated" });
    await measureTool("adjust_plan", images.get("read12")!, ctx, { workoutId: rich.outlineToday, change: { kind: "skip", reason: "Rest the legs today." }, why: words(2, 150) });
    // change_programme (§8 §5): the rich athlete's programme onto other days, a goal and minutes — its preview of where
    // the sessions go, its lines.
    await measureTool("change_programme", images.get("read12")!, ctx, { programmeId: rich.programId, days: ["Tue", "Thu", "Sat"], weeklyGoal: 3, minutes: 45, why: words(2, 150) });
    await measureTool("finish", images.get("read12")!, ctx, { summary: words(3, 200) });

    // A search that finds nothing (fix wave 13, round 3, R2-M1) says why from the library's word index — no move says a
    // word, or every move is turned away (here by the place's gear) — within what search_library declares.
    const search = allTools().find((t) => t.name === "search_library")!;
    const zeros: Array<[string, string, unknown]> = [
      ["8z.unknown", "8z. search_library: 8 words no move says", { query: "zqxva zqxvb zqxvc zqxvd zqxve zqxvf zqxvg zqxvh" }],
      ["8z.away", "8z. search_library: 8 words, every move turned away by the place's gear", { query: "kettlebell swing deadlift goblet squat press row carry", filters: { place: "mat", equipment: "kettlebell" } }],
    ];
    for (const [id, label, input] of zeros) {
      (await measure(id, `${label} (declared ${search.cpuWeight})`, images.get("read12")!, async (x) => {
        const r = await search.run(ctx(x), input);
        if (isToolErr(r)) throw new Error(`${id} refused: ${r.error}`);
        if ((r.data as { moves: unknown[] }).moves.length > 0) throw new Error(`${id}: not a zero`);
        utf8Bytes(JSON.stringify({ provenance: r.provenance, missing: r.missing, data: r.data }));
      }, { budget: search.cpuWeight })).close();
    }
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
  {
    // 9c. The same step of queued calls, run by the run's object's alarm.
    const x = await measure("9c", "9c. the alarm: 2b.q's step (validate + propose, packet built, reviewer started)", images.get("validate-propose-queued")!, alarmStep, {
      budget: GO_LIVE_BUDGET_MS,
    });
    const kinds = (await x.db.select({ kind: schema.coachRunEvents.kind }).from(schema.coachRunEvents).where(eq(schema.coachRunEvents.runId, runId))).map((e) => e.kind);
    if (!kinds.includes("draft")) throw new Error(`9c: the alarm's step wrote no draft (${kinds.join(", ")})`);
    x.close();
  }

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
    // 9b. The same model step, run by the run's object's alarm: the same answer read, nine validates queued.
    const y = await measure("9b", "9b. the alarm: 2c's model step (9 half documents streamed, none run)", images.get("read12")!, alarmStep, {
      budget: GO_LIVE_BUDGET_MS,
    });
    const queued = (await stateOf(y.db, runId)).pending.length;
    if (queued !== 9) throw new Error(`9b: the alarm's model step queued ${queued} calls, not 9`);
    y.close();
    // 9a. The armed step request: the run checked and read, its events after the client's last, its object armed.
    (await measure("9a", "9a. POST /step with the step alarm on (the run read, its object armed)", images.get("read12")!,
      (z) => z.runs.request(`/api/coach/runs/${runId}/step?afterSeq=0`, { method: "POST", headers: { Cookie: cookie } }, alarmEnv), {
        budget: 2,
        check: (b) => {
          if ((b as { armed?: unknown }).armed !== true) throw new Error(`9a: not armed: ${JSON.stringify(b).slice(0, 200)}`);
        },
      })).close();
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
    accepted: [{ dimension: "fit", why: words(8, 200) }],
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

  // 12. The voice workshop's replay of the workout's words (coach-replay.ts): the run finished, its proposing call
  // replayed for 3 variants — the most a prose replay takes — each answer a whole document streamed. Its state parsed
  // and its request written once, the 3 answers parsed, the rows written and settled.
  {
    const done = open(images.get("reviewed")!);
    await done.db.update(schema.coachRuns).set({ status: "finished" }).where(eq(schema.coachRuns.id, runId));
    const [owner] = await done.db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId));
    images.set("replayable", imageOf(done.db));
    done.close();
    answer = streamOf([thinking(3_000), { type: "text", text: words(5, 200) }, use("propose_workout", { doc: docs[1], target: { kind: "new", date: TODAY } })]).chunks;
    const body = JSON.stringify({ confirm: REPLAY_CONFIRM, runId, at: "prose", variants: [{ id: "a" }, { id: "b", tone: "warm" }, { id: "c", tone: "brisk" }] });
    const replayEnv = { ...env, ALLOWED_GOOGLE_EMAIL: owner!.email };
    (await measure("12", "12. POST /api/coach/replay at prose: 3 whole documents streamed", images.get("replayable")!, (x) =>
      x.replay.request("/api/coach/replay", { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body }, replayEnv), {
      budget: GO_LIVE_BUDGET_MS,
      check: (b) => expect((b as { variants: Array<{ prose?: { title: string } }> }).variants.map((v) => v.prose?.title)).toEqual([docs[1]!.title, docs[1]!.title, docs[1]!.title]),
    })).close();
  }

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

  // ── 10: the conversation (the new shape §5) ──
  {
    const conv = makeTestDb();
    const a = await seedRichAthlete(conv);
    const cookie10 = `${SESSION_COOKIE}=${await createSession(conv, a.userId)}`;
    const first = await seedConversation(conv, a.userId, 20, moves);
    const auto = (await createRun(conv, a.userId, { request: REQUEST, conversationId: first }, NOW)).run;
    if (auto.conversationId !== first || auto.scope.kind !== "auto") throw new Error("the bench's auto run is no later turn of its conversation");
    images.set("conversation", imageOf(conv));
    clientOf(conv).close();
    const autoStep = (x: World) => x.runs.request(`/api/coach/runs/${auto.id}/step`, { method: "POST", headers: { Cookie: cookie10 } }, env);
    const opened10 = await measure("10a", "10a. an auto run's context step, a later turn (6 of 20 turns)", images.get("conversation")!, autoStep, { budget: 3, check: expectStep("active") });
    const header = (await stateOf(opened10.db, auto.id)).messages[0] as { content: Array<{ text: string }> };
    sizes.push(`the conversation so far: ${header.content[0]!.text.slice(header.content[0]!.text.indexOf("The conversation so far")).length} B of the opening message`);
    opened10.close();
    (await measure("10b", "10b. GET /api/coach/conversation (20 turns, a set each)", images.get("conversation")!, (x) => x.conversation.request("/api/coach/conversation", { headers: { Cookie: cookie10 } }, env), {
      budget: 2,
      check: (b) => expect((b as { turns: unknown[] }).turns).toHaveLength(20),
    })).close();
  }

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

  // ── 5p: a programme change's approve (§8 §5), request by request — six a week at four weeks ahead onto other days ──
  {
    // On a Wednesday noon's clock (Date only): on the real one, early on a Monday in the athlete's zone (01:05, not
    // noon), the programme placed and retracted in two requests, not three or more, and the check below went red.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-21T19:00:00Z"));
    const today = todayInZone(TZ);
    const dbp = makeTestDb();
    const { userId: uid } = await makeTestUser(dbp, { timezone: TZ });
    const cookiep = `${SESSION_COOKIE}=${await createSession(dbp, uid)}`;
    const stamp = new Date().toISOString();
    const programId = newId();
    await dbp.insert(schema.programs).values({
      id: programId, userId: uid, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"], startDate: null, endDate: null,
      raceDate: null, source: null, config: { weeklyGoal: 6, preferredDays: [0, 1, 2, 3, 4, 5], placementWeeksAhead: 4 }, createdAt: stamp, updatedAt: stamp, archivedAt: null,
    });
    await placeSlots(dbp, uid, programId, today, await loadPreferences(dbp, uid), stamp);
    const runId = `run-${newId()}`;
    await dbp.insert(schema.coachRuns).values({ id: runId, userId: uid, parentId: null, role: "main", scope: { kind: "auto" }, request: null, status: "active", state: null, steps: 0, costUsd: 0, createdAt: stamp, updatedAt: stamp });
    const made = await changeProgramme.run(
      { db: dbp, env, userId: uid, run: { id: runId, role: "main", scope: { kind: "auto" }, parentId: null, rehearsal: false }, now: new Date(), toolUseId: `toolu_${newId()}` },
      { programmeId: programId, days: ["Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], why: words(2, 150) },
    );
    if (isToolErr(made)) throw new Error(`change_programme refused: ${made.error} — ${made.why}`);
    const proposalId = designProposalId(runId);
    await dbp.update(schema.coachProposals).set({ status: "pending" }).where(and(eq(schema.coachProposals.id, proposalId), eq(schema.coachProposals.userId, uid)));
    images.set("programme-change", imageOf(dbp));
    clientOf(dbp).close();
    vi.stubGlobal("fetch", (async () => new Response("{}", { status: 404 })) as typeof fetch);
    const chunkSamples: Sample[][] = [];
    const chunkFirst: number[] = [];
    for (let i = 0; i < WARMUP + RUNS; i++) {
      const x = open(images.get("programme-change")!);
      let remaining: string[] | null = null;
      for (let k = 0; remaining === null || remaining.length > 0; k++) {
        if (k >= MAX_LOOP_ITERATIONS) throw new Error("the programme change's approve never finished");
        const pending: Array<Promise<unknown>> = [];
        const executionCtx = { waitUntil: (pr: Promise<unknown>) => void pending.push(pr), passThroughOnException: () => undefined, props: {} };
        x.clock.reset();
        const t = performance.now();
        const res = await x.coach.request(
          `/api/coach/proposals/${proposalId}/approve`,
          { method: "POST", headers: { Cookie: cookiep, "Content-Type": "application/json" }, body: JSON.stringify(remaining ? { opIds: remaining } : {}) },
          env,
          executionCtx as never,
        );
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
      shapes.set(`5p.${k + 1}`, { label: `5p. programme change approve request ${k + 1} of ${chunkSamples.length}`, samples, first: chunkFirst[k]!, budget: 4 });
    });
    vi.useRealTimers();
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

  // ── 11: Growth's body map over a busy season (the new shape §7) ──
  {
    const db11 = makeTestDb();
    const { userId: uid } = await makeTestUser(db11, { timezone: TZ, weightUnit: "kg", units: "km" });
    await seedBusySeason(db11, uid, today);
    const cookie11 = `${SESSION_COOKIE}=${await createSession(db11, uid)}`;
    const count = async (t: typeof schema.performedSets | typeof schema.activities | typeof schema.performedSessions) => (await db11.select({ n: sql<number>`count(*)` }).from(t))[0]!.n;
    sizes.push(`a busy season: ${await count(schema.performedSessions)} sessions, ${await count(schema.performedSets)} sets, ${await count(schema.activities)} runs`);
    images.set("season", imageOf(db11));
    clientOf(db11).close();
    for (const [id, period] of [["11a", "month"], ["11b", "season"]] as const) {
      (await measure(id, `${id}. GET /api/growth/body?period=${period} (two sessions of 18 sets and a run a day)`, images.get("season")!, (x) =>
        x.growth.request(`/api/growth/body?period=${period}`, { headers: { Cookie: cookie11 } }, env), {
        budget: GO_LIVE_BUDGET_MS,
        check: (b) => expect((b as { sessions: number }).sessions).toBe(period === "month" ? 60 : 180),
      })).close();
    }
  }

  calibrationAfter = calibrate();
  loadAfter = loadavg();
  calibration = (calibrationBefore + calibrationAfter) / 2;
  report();
}, 600_000);

/**
 * A busy season for Growth's body map (11): every day of the last 90, two strength sessions of 18 working sets (six
 * moves of three sets: loaded moves, a timed hold, a side-at-a-time hold, played moves) and a run; two focus areas.
 */
async function seedBusySeason(db: Db, uid: string, today: string): Promise<void> {
  const T0 = at(today);
  const MOVES: Array<{ id: string; seconds?: number; perSide?: boolean }> = [
    { id: "gobletSquat" }, { id: "bandRow" }, { id: "deadBug" }, { id: "wallSit", seconds: 45 }, { id: "sidePlank", seconds: 30, perSide: true }, { id: "calfRaise" },
    { id: "chinTuck" }, { id: "catCow" }, { id: "plankBlock", seconds: 40 },
  ];
  await db.insert(schema.athleteProfiles).values({
    id: newId(), userId: uid, updatedAt: T0,
    focusAreas: [{ id: "hips", label: "Hips", refs: ["hips"] }, { id: "upper-back", label: "Upper back", refs: ["upper-back", "rhomboids"] }],
  });
  const sessions: Array<typeof schema.performedSessions.$inferInsert> = [];
  const sets: Array<typeof schema.performedSets.$inferInsert> = [];
  const runs: Array<typeof schema.activities.$inferInsert> = [];
  for (let n = 0; n < 90; n++) {
    const date = addDays(today, -n);
    for (let k = 0; k < 2; k++) {
      const id = newId();
      sessions.push({
        id, userId: uid, source: "app", localDate: date, seconds: 2400, payloadHash: `h${n}-${k}`, createdAt: T0, updatedAt: T0,
        movesDone: [{ exerciseId: "catCow", seconds: 60 }, { exerciseId: "worldsGreatestStretch", seconds: 90 }],
      });
      for (let e = 0; e < 6; e++) {
        const m = MOVES[(n + k * 3 + e) % MOVES.length]!;
        for (let s = 0; s < 3; s++) {
          const base = { performedSessionId: id, entryIndex: e, exerciseId: m.id, setIndex: s, done: true };
          if (m.perSide) {
            sets.push({ id: newId(), ...base, seconds: m.seconds! + s, perSide: true, side: s % 2 ? "left" : "right" });
          } else if (m.seconds) sets.push({ id: newId(), ...base, seconds: m.seconds + s });
          else sets.push({ id: newId(), ...base, reps: 8 + s, loadValue: 16, loadUnit: "kg", loadKg: 16 });
        }
      }
    }
    runs.push({
      id: newId(), userId: uid, sport: "run", startTime: `${date}T14:00:00.000Z`, startTimeLocal: `${date}T07:00:00`, durationSeconds: 2400 + n * 7,
      distanceMeters: 7000, avgHeartRate: 140, avgPaceSecPerKm: 343, createdAt: T0, updatedAt: T0,
    });
  }
  for (let i = 0; i < sessions.length; i += 200) await db.insert(schema.performedSessions).values(sessions.slice(i, i + 200));
  for (let i = 0; i < sets.length; i += 500) await db.insert(schema.performedSets).values(sets.slice(i, i + 500));
  for (let i = 0; i < runs.length; i += 200) await db.insert(schema.activities).values(runs.slice(i, i + 200));
}

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
 * OVER THE GO-LIVE BUDGET (scaled p50), each with the fix it waits on: until then held under a regression ceiling
 * (~1.35× its measurement), so nothing gets worse unseen; once its fix lands it leaves this list and meets its budget
 * like the rest. None now: the designer's shapes (1b, 2a–2d) left it with the cheaper stream reader, the
 * document-sized answer's queued calls and the step's CPU room; the board (6) with its best ever's window starts
 * hoisted and its logged sets read as plain rows.
 */
const KNOWN_OVER: Readonly<Record<string, { measured: number; ceiling: number; waitsOn: string }>> = {};

/** Shapes measured as a run of requests — the queued calls' steps, the approve's chunks — each `${id}.${k}`. */
const GROUPS = ["1c", "1d.q", "2a.q", "2d", "5b", "5p"] as const;
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
    expect([...shapes.keys()].filter((k) => shapes.get(k)!.budget !== null && !grouped(k))).toEqual(["1a", "1b", "1d", "2a", "8z.unknown", "8z.away", "2b", "2b.q", "9c", "2e", "2c", "9b", "9a", "4b", "4c", "4d", "12", "3", "10a", "10b", "7", "5a", "6", "11a", "11b"]);
    // The queued reads go in two steps or more; four whole documents' validates in two (three, then one); nine half
    // documents' in three; the approve in five chunks or more.
    expect(inGroup("1c").length).toBeGreaterThanOrEqual(2);
    // A turn of eight searches: the model step runs what search_library's weight packs, a queued step or more the rest.
    expect(inGroup("1d.q").length).toBeGreaterThanOrEqual(1);
    expect(inGroup("2a.q").map((k) => shapes.get(k)!.label)).toEqual([expect.stringContaining(": 3 ×"), expect.stringContaining(": 1 ×")]);
    expect(inGroup("2d").map((k) => shapes.get(k)!.label)).toEqual([1, 2, 3].map(() => expect.stringContaining(": 3 ×")));
    expect(inGroup("5b").length).toBeGreaterThanOrEqual(5);
    // A programme's six a week at four weeks ahead onto other days: its retractions and placings over several requests.
    expect(inGroup("5p").length).toBeGreaterThanOrEqual(3);
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

  for (const id of ["1a", "1b", "1c", "1d", "1d.q", "8z.unknown", "8z.away", "2a", "2a.q", "2b", "2b.q", "2c", "2d", "2e", "3", "4b", "4c", "4d", "5a", "5b", "5p", "6", "7", "9a", "9b", "9c", "10a", "10b", "11a", "11b", "12"]) {
    const over = KNOWN_OVER[id];
    it(
      over
        ? `${id}: OVER the ${GO_LIVE_BUDGET_MS} ms budget (~${over.measured} ms) until ${over.waitsOn}; held under ${over.ceiling} ms`
        : `${id}: under its budget (scaled p50), and under ${WORKERS_CPU_LIMIT_MS} ms at p95`,
      (ctx) => within(id, ctx),
    );
  }
});
