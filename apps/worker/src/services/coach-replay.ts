/**
 * THE COACH'S VOICE WORKSHOP: A REPLAY (owner-gated; routes/coach-replay.ts). One finished main run's athlete-facing
 * step, called again with the production model on the run's own stored context — once per voice variant
 * (coach-voice.ts) — and only the coach's words answered, so the owner can compare tone, length and what a line carries,
 * side by side. Production data stays in production: the replay runs here, and answers words, costs and usage only.
 *
 * WHAT A FINISHED RUN KEEPS (coach-runs.ts): its whole agent state, never compacted — the system blocks as the opening
 * context built them, and the append-only history (thinking blocks with their signatures, every tool call and every
 * result as the model saw it, the clock lines and last-turn notes in the messages they were sent in), up to
 * STATE_MAX_BYTES. So the request behind any of its model calls can be written again exactly: the system, the history up
 * to that call's answer, and the run's own effort and output ceiling. Not kept: the tool list as it stood (today's is
 * sent — the same unless a deploy since changed a tool), and the model id (today's `designModel`).
 *
 * THE STEPS (`at`), each the main run's own model call:
 *  - `finish` (default): its last call — the finish line, or an answer in words. Baseline: the line the conversation
 *    showed (its final event).
 *  - `ask`: the call that asked the athlete its question (ask_athlete with questions; a condition-check ask has no words
 *    of the model's). Baseline: that question and its chips.
 *  - `prose`: the call that proposed the workout the run's proposal holds (its op's `toolUseId`), the main run's own —
 *    a set's workouts are its designers' runs, not replayed here. The model writes the whole document again: the
 *    answer is its title, intent, first whys and cues — and its exercises may differ. Baseline: the document shipped.
 * Sub-runs (designers, reviewers) and the trail's narration beside tool calls are not replayed.
 *
 * WHERE THE VOICE GOES: one text block after the newest message's cache breakpoint — so the cached prefix (tools,
 * system, history) is the production request's own and every variant after the first reads it from the cache. A
 * variant that sets no variable adds nothing: its request is the production request byte for byte (pinned). The block
 * sits at the end of the prompt, where it weighs more than it would inside the system prompt: a replay is a fair
 * comparison between variants, a strong one of the block itself.
 *
 * MONEY: the first variant is called alone (it writes the shared prefix to the cache), the rest together once it has
 * answered. Before each, the weekly cap (`llmBudgetStatus`, as the runs: a call's worst case — the prompt written to the
 * cache and its whole output ceiling — must fit under the cutoff) and this request's own cap (REPLAY_REQUEST_CAP_MICROS,
 * on a realistic estimate: the prompt read from the cache, twice the largest output seen). A variant neither covers is
 * skipped, in words; a first call the week can't cover refuses the whole replay. THE REQUEST'S CAP IS SOFT (review,
 * minor 2): a short first answer can let later ones run much longer than estimated — up to about three times the cap
 * (the review's probe: $2.57) — and production's output ceiling is kept, for the baseline's sake. The weekly cap is the
 * hard bound; every answer says so (`capNote`). Every call is recorded in `llm_usage` as `coach_replay` — written before
 * it at its worst case, marked with its estimate, settled after — and nothing else is written anywhere. A request cut
 * off partway leaves its rows marked: they count at their worst while a call of theirs may still run, then at their
 * estimate (llm.ts `weekCostSql`, REPLAY_RESERVATION_STALE_MINUTES; review I1), so an orphaned batch never locks the
 * coach out for the week.
 *
 * A PROSE REPLAY takes at most REPLAY_PROSE_VARIANTS_MAX variants: each answer is a whole streamed document, and its
 * parse is the request's CPU (review, minor 3; the design CPU bench's shape 12).
 *
 * STATEMENTS: the run (1), the week (1), the first call (its row, the fetch, its settling: 3), the week again (1), the
 * rest (their rows in one insert, a fetch and a settling each). Eight variants: 21 with the route's sign-in beside.
 * CPU: the state is parsed once and the shared prefix serialised once; each variant writes only its newest message.
 */
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { llmUsage } from "@rg/database";
import { newId } from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { capSystemBreakpoints, PROMPT_BYTES_PER_TOKEN, readRunState, toolSpecs, withMessageBreakpoint, type RunState } from "./coach-runs.js";
import { voiceBlock, voiceSettingsOf, voiceSettingsSchema, type VoiceSettings } from "./coach-voice.js";
import { PROSE_CEILING } from "./design-tools/act-common.js";
import { CHECK_ASKED } from "./design-tools/ask.js";
import { ANSWER_MAX, LINE_MAX } from "./design-tools/finish.js";
import { allTools } from "./design-tools/index.js";
import { designProposalId } from "./design-tools/propose.js";
import type { DesignTool } from "./design-tools/types.js";
import { athleteText, clipProse } from "./design-prose.js";
import { LLM_BUDGET, llmBudgetStatus, REPLAY_USAGE_KIND, RESERVATION_MARK } from "./llm.js";
import {
  designModel,
  messagesCostMicros,
  sendMessagesBody,
  type ContentBlock,
  type MessageParam,
  type MessagesResult,
  type RequestBlock,
  type ToolUseBlock,
} from "./llm-messages.js";
import { utf8Bytes } from "./utf8.js";

// ── The contract ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The body's exact confirm: without it the route is a 404. */
export const REPLAY_CONFIRM = "replay a coach run";
export const REPLAY_VARIANTS_MAX = 8;
/** A prose replay's variants, at most: each answer a whole document, parsed in this request's CPU. */
export const REPLAY_PROSE_VARIANTS_MAX = 3;
/** What one replay request may spend, on its estimates — soft: see MONEY above. */
export const REPLAY_REQUEST_CAP_MICROS = 1_000_000;
/** Its calls' kind in `llm_usage` (llm.ts, where the week counts it). */
export { REPLAY_USAGE_KIND };
export const REPLAY_STEPS = ["finish", "ask", "prose"] as const;
export type ReplayStep = (typeof REPLAY_STEPS)[number];
export const REPLAY_LIST_DEFAULT = 20;
export const REPLAY_LIST_MAX = 50;
/** The first whys and cues a prose replay answers. */
const WHYS_SHOWN = 5;
const CUES_SHOWN = 3;
/** A question's why where the athlete reads it (ask.ts WHY_MAX). */
const QUESTION_WHY_MAX = 200;
/** A listed run's line, at most (characters). */
const LIST_LINE_MAX = 200;
/** The output a first call is estimated at when the run kept none (tokens). */
const OUTPUT_GUESS = 4_000;
/** A finish line as the conversation shows it whole: the payload keeps it up to this (coach-runs.ts FINISH_KEPT_MAX). */
const FINISH_SHOWN_MAX = LINE_MAX * PROSE_CEILING;

export const REPLAY_WORDS = {
  weeklyCap: "The weekly AI budget can't cover this call.",
  requestCap: "This replay reached its own spending limit.",
  capNote:
    "The $1.00 limit per replay is soft: it is checked on an estimate (twice the longest answer seen so far), so a replay can spend up to about three times it. The weekly cap is the hard bound.",
  proseVariants: `at most ${REPLAY_PROSE_VARIANTS_MAX} for the workout's words: each answer is a whole document`,
  firstFailed: "Not called: the first variant's call failed.",
  notReplayable: {
    finish: "This run made no model call to replay.",
    ask: "This run asked no question of its own.",
    prose: "This run designed no workout of its own (a set's workouts are its designers').",
  } satisfies Record<ReplayStep, string>,
  unreadable: "This run's stored context can't be read.",
};

const VARIANT_ID = /^[A-Za-z0-9_-]{1,40}$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** A variant: an id and the voice's variables (strict, as `voiceSettingsSchema` is: nothing else). */
export const replayVariantSchema = voiceSettingsSchema.extend({ id: z.string().regex(VARIANT_ID, "an id of letters, digits, - or _") });

/** The body, the confirm included (the route answers 404 before this for a body without it). Variables are enums. */
export const replayBodySchema = z
  .object({
    confirm: z.literal(REPLAY_CONFIRM),
    runId: z.string().regex(RUN_ID, "a run's id"),
    at: z.enum(REPLAY_STEPS).optional(),
    variants: z
      .array(replayVariantSchema)
      .min(1)
      .max(REPLAY_VARIANTS_MAX)
      .refine((vs) => new Set(vs.map((v) => v.id)).size === vs.length, "each variant's id once"),
  })
  .strict()
  .refine((b) => b.at !== "prose" || b.variants.length <= REPLAY_PROSE_VARIANTS_MAX, { path: ["variants"], message: REPLAY_WORDS.proseVariants });
export type ReplayBody = z.infer<typeof replayBodySchema>;

/** The model, at the transport: a body already written (llm-messages.ts `sendMessagesBody`). Tests stub it. */
export interface ReplayDeps {
  send(env: Env, call: { model: string; body: string; maxTokens: number }): Promise<MessagesResult>;
  /** The tools the request offers (the runs': `allTools()`). */
  tools: DesignTool[];
}

export function defaultReplayDeps(): ReplayDeps {
  return { send: (env, c) => sendMessagesBody(env, c.model, c.body, c.maxTokens), tools: allTools() };
}

// ── What comes back ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ReplayProse {
  title: string | null;
  intent: string | null;
  /** The first whys, in reading order: each part's, then its items'. */
  whys: string[];
  cues: string[];
}

/** The athlete-facing words of one answer (or of the run as shipped). */
export interface ReplayWords {
  /** The finish line or answer, as the conversation shows it (the athlete's words, clipped where it clips). */
  line?: string;
  chars?: number;
  question?: string;
  choices?: string[];
  questions?: Array<{ text: string; choices: string[]; why: string | null }>;
  check?: true;
  prose?: ReplayProse;
  /** Text beside the answer's tool calls (the trail shows it as the coach works). */
  said?: string;
  /** Other tools the answer called instead (never run). */
  called?: string[];
}

export interface ReplayVariantDto extends ReplayWords {
  id: string;
  settings: VoiceSettings;
  costUsd: number;
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number };
  stopReason?: string | null;
  /** The call failed: its kind (no_key, out_of_credits, retryable, rejected). */
  error?: string;
  /** Not called. */
  skipped?: { reason: "weekly_cap" | "request_cap" | "first_failed"; why: string };
}

export interface ReplayDto {
  runId: string;
  at: ReplayStep;
  /** The athlete's own words. */
  request: string | null;
  model: string;
  baseline: ReplayWords;
  variants: ReplayVariantDto[];
  costUsd: number;
  /** The per-request cap is soft; the weekly cap is the hard bound (REPLAY_WORDS.capNote). */
  capNote: string;
}

export type ReplayOutcome =
  | { kind: "ok"; body: ReplayDto }
  | { kind: "not_found" }
  | { kind: "not_replayable"; why: string }
  | { kind: "weekly_cap"; why: string; spentUsd: number; cutoffUsd: number };

// ── The run, as a replay reads it ───────────────────────────────────────────────────────────────────────────────────

const DESIGNED_PREFIX = designProposalId("");

/** A run the replay may read: the athlete's own finished main run (no parent, as the conversation reads its turns), never
 * a rehearsal's. */
const replayable = (userId: string) =>
  sql`r.user_id = ${userId} AND r.parent_id IS NULL AND r.status = 'finished'
    AND coalesce(CASE WHEN json_valid(r.state) THEN json_extract(r.state, '$.settings.rehearsal') END, 0) = 0`;

/** The run's last line, as the conversation reads it (coach-conversation.ts `conversationRows`). */
const FINAL_LINE = sql.raw(`(SELECT CASE WHEN json_valid(e.payload) THEN coalesce(json_extract(e.payload, '$.text'), e.summary) ELSE e.summary END
  FROM coach_run_events e WHERE e.run_id = r.id AND e.user_id = r.user_id AND e.kind = 'note' AND json_valid(e.payload)
    AND (json_extract(e.payload, '$.receipt.final') = 1 OR json_extract(e.payload, '$.final') = 1)
  ORDER BY e.seq DESC LIMIT 1)`);

const OPS_OF = sql.raw(`FROM coach_proposals p, json_each(CASE WHEN json_valid(p.ops) THEN p.ops ELSE '[]' END) o
  WHERE p.id = '${DESIGNED_PREFIX}' || r.id AND p.user_id = r.user_id`);
const opKind = sql.raw(`json_extract(o.value, '$.kind')`);

interface RunRow {
  id: string;
  request: string | null;
  state: string | null;
  line: string | null;
  ops: number | null;
  designed: string | null;
}

/** ONE statement: the run, its last line, how many ops its proposal holds, and the workout it designed itself. */
async function readRun(db: Db, userId: string, runId: string): Promise<RunRow | null> {
  const [row] = (await db.all(sql`
    SELECT r.id AS id, r.request AS request, r.state AS state, ${FINAL_LINE} AS line,
      (SELECT count(*) ${OPS_OF}) AS ops,
      (SELECT json_object('toolUseId', json_extract(o.value, '$.toolUseId'), 'doc', json(json_extract(o.value, '$.doc'))) ${OPS_OF}
        AND ${opKind} = 'doc_workout' AND json_extract(o.value, '$.by.runId') = r.id ORDER BY CAST(o.key AS INTEGER) DESC LIMIT 1) AS designed
    FROM coach_runs r WHERE r.id = ${runId} AND ${replayable(userId)}
  `)) as RunRow[];
  return row ?? null;
}

const parsed = (text: string | null): unknown => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// ── Which call, and its words ───────────────────────────────────────────────────────────────────────────────────────

const usesOf = (content: MessageParam["content"]): ToolUseBlock[] =>
  typeof content === "string" ? [] : content.filter((b): b is ToolUseBlock => b.type === "tool_use");

const asksWords = (u: ToolUseBlock): boolean => u.name === "ask_athlete" && Array.isArray((u.input as { questions?: unknown } | null)?.questions);

/** The history's index of the step's answer (an assistant message); null when the run never took that step. */
function stepIndex(state: RunState, at: ReplayStep, designed: { toolUseId?: unknown } | null): number | null {
  for (let i = state.messages.length - 1; i >= 1; i--) {
    const m = state.messages[i]!;
    if (m.role !== "assistant") continue;
    if (at === "finish") return i;
    const uses = usesOf(m.content);
    if (at === "ask" && uses.some(asksWords)) return i;
    // The call that proposed the version its proposal holds (none designed: no call matches).
    if (at === "prose" && uses.some((u) => u.name === "propose_workout" && u.id === designed?.toolUseId)) return i;
  }
  return null;
}

const lineOf = (words: string, answer: boolean): Pick<ReplayWords, "line" | "chars"> => {
  const line = clipProse(athleteText(words.trim()), answer ? ANSWER_MAX : FINISH_SHOWN_MAX);
  return { line, chars: line.length };
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function questionOf(input: unknown): Pick<ReplayWords, "question" | "choices" | "questions" | "check"> {
  const x = input as { questions?: unknown; check?: unknown } | null;
  if (x?.check === "condition") return { question: CHECK_ASKED, choices: [], check: true };
  const questions = (Array.isArray(x?.questions) ? x.questions : []).flatMap((q) => {
    const y = q as { text?: unknown; chips?: unknown; why?: unknown } | null;
    if (typeof y?.text !== "string") return [];
    const choices = (Array.isArray(y.chips) ? y.chips : []).flatMap((c) => {
      const label = typeof c === "string" ? c : (c as { label?: unknown } | null)?.label;
      return typeof label === "string" ? [label] : [];
    });
    // As the question shows (ask.ts): its words and its why in the athlete's words, the why clipped; the chips as given.
    const why = str(y.why);
    return [{ text: athleteText(y.text), choices, why: why ? clipProse(athleteText(why), QUESTION_WHY_MAX) : null }];
  });
  const first = questions[0];
  return first ? { question: first.text, choices: first.choices, questions } : {};
}

/** A document's words: its title, its intent, its first whys (each part's, then its items') and cues. */
export function proseOf(doc: unknown): ReplayProse | null {
  const d = doc as { title?: unknown; intent?: { summary?: unknown }; parts?: unknown } | null;
  if (!d || typeof d !== "object") return null;
  const whys: string[] = [];
  const cues: string[] = [];
  for (const part of Array.isArray(d.parts) ? d.parts : []) {
    const p = part as { why?: unknown; items?: unknown } | null;
    const why = str(p?.why);
    if (why) whys.push(why);
    for (const item of Array.isArray(p?.items) ? p.items : []) {
      const it = item as { why?: unknown; cue?: unknown } | null;
      const w = str(it?.why);
      const c = str(it?.cue);
      if (w) whys.push(w);
      if (c) cues.push(c);
    }
  }
  return { title: str(d.title), intent: str(d.intent?.summary), whys: whys.slice(0, WHYS_SHOWN), cues: cues.slice(0, CUES_SHOWN) };
}

/** The tools whose words a replay reads; any other a replayed answer calls is named, never run. */
const WORD_TOOLS: readonly string[] = ["finish", "ask_athlete", "propose_workout"];

/** An answer's athlete-facing words. `answer`: the run suggested nothing, so its line is an answer's (its longer cap). */
export function wordsOf(content: readonly ContentBlock[], answer: boolean): ReplayWords {
  const text = content
    .filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");
  const uses = content.filter((b): b is ToolUseBlock => b.type === "tool_use");
  const out: ReplayWords = {};
  const summary = str((uses.find((u) => u.name === "finish")?.input as { summary?: unknown } | null)?.summary);
  // A turn of words alone ends a run as a finish in words does (coach-runs.ts `finishInWords`): they are its line.
  if (summary) Object.assign(out, lineOf(summary, answer));
  else if (uses.length === 0 && text) Object.assign(out, lineOf(text, answer));
  if (text && uses.length > 0) out.said = athleteText(text);
  const ask = uses.find((u) => u.name === "ask_athlete");
  if (ask) Object.assign(out, questionOf(ask.input));
  const proposed = uses.find((u) => u.name === "propose_workout");
  const prose = proposed ? proseOf((proposed.input as { doc?: unknown } | null)?.doc) : null;
  if (prose) out.prose = prose;
  const others = uses.map((u) => u.name).filter((n) => !WORD_TOOLS.includes(n));
  if (others.length > 0) out.called = others;
  return out;
}

// ── The request, written once ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The step's request as `callMessages` writes it (llm-messages.ts: model, max_tokens, system, tools, messages,
 * output_config, stream — the history with its breakpoint on the newest message, the system's as the loop caps them),
 * up to the newest message: `head` holds everything before it, serialised once; `newest` and `tail` close it.
 */
export interface ReplayRequest {
  model: string;
  maxTokens: number;
  head: string;
  newest: MessageParam;
  tail: string;
  headBytes: number;
}

export function replayRequest(state: RunState, cut: number, tools: DesignTool[], model: string): ReplayRequest {
  const sent = withMessageBreakpoint(state.messages.slice(0, cut));
  const settings = state.settings;
  const specs = toolSpecs(tools, state);
  const open = JSON.stringify({
    model,
    max_tokens: settings.maxTokens,
    system: capSystemBreakpoints(state.system ?? []),
    ...(specs.length > 0 ? { tools: specs } : {}),
    messages: sent.slice(0, -1),
  });
  // `open` ends with the messages' `]}`: the newest message goes on after the others.
  const head = `${open.slice(0, -2)}${sent.length > 1 ? "," : ""}`;
  const close = JSON.stringify({ ...(settings.effort ? { output_config: { effort: settings.effort } } : {}), stream: true });
  return { model, maxTokens: settings.maxTokens, head, newest: sent.at(-1)!, tail: `],${close.slice(1)}`, headBytes: utf8Bytes(head) };
}

/** The whole body, the voice block (when there is one) after the newest message's breakpoint. */
export function replayBody(r: ReplayRequest, voice: string | null): string {
  if (voice === null) return `${r.head}${JSON.stringify(r.newest)}${r.tail}`;
  const block: RequestBlock = { type: "text", text: voice };
  const newest: MessageParam[] =
    r.newest.role === "user"
      ? [{ role: "user", content: [...(typeof r.newest.content === "string" ? [{ type: "text" as const, text: r.newest.content }] : r.newest.content), block] }]
      : [r.newest, { role: "user", content: [block] }];
  return `${r.head}${newest.map((m) => JSON.stringify(m)).join(",")}${r.tail}`;
}

// ── The replay ──────────────────────────────────────────────────────────────────────────────────────────────────────

const usd = (micros: number): number => micros / 1_000_000;

interface Planned {
  index: number;
  body: string;
  promptTokens: number;
  worstMicros: number;
  /** Its realistic cost, once planned: what its reservation counts at if its request dies (llm.ts `weekCostSql`). */
  estimateMicros: number;
  usageId: string;
}

/** `clock`: the time each batch's rows are written at — read at their insert, never the request's start (a batch begins
 * only once the first call has answered, up to its whole deadline later, and its rows' stale window runs from there). */
export async function replayRun(db: Db, env: Env, userId: string, input: ReplayBody, deps: ReplayDeps, clock: () => Date): Promise<ReplayOutcome> {
  const at: ReplayStep = input.at ?? "finish";
  const row = await readRun(db, userId, input.runId);
  if (!row) return { kind: "not_found" };
  const state = readRunState(row.state);
  if (!state || !state.system) return { kind: "not_replayable", why: REPLAY_WORDS.unreadable };
  const designed = parsed(row.designed) as { toolUseId?: unknown; doc?: unknown } | null;
  const cut = stepIndex(state, at, designed);
  if (cut === null) return { kind: "not_replayable", why: REPLAY_WORDS.notReplayable[at] };

  const answer = !row.ops;
  const original = state.messages[cut]!.content;
  const originalWords = typeof original === "string" ? lineOf(original, answer) : wordsOf(original as ContentBlock[], answer);
  const baseline: ReplayWords =
    at === "finish"
      ? row.line
        ? { line: row.line, chars: row.line.length }
        : originalWords
      : at === "ask"
        ? questionOf(usesOf(original).find(asksWords)?.input)
        : { prose: proseOf(designed?.doc) ?? undefined };

  const model = designModel(env);
  const request = replayRequest(state, cut, deps.tools, model);
  const variants: ReplayVariantDto[] = input.variants.map((v) => ({ id: v.id, settings: voiceSettingsOf(v), costUsd: 0 }));
  const plan = (index: number): Planned => {
    const body = replayBody(request, voiceBlock(input.variants[index]!));
    const promptTokens = Math.ceil((request.headBytes + utf8Bytes(body.slice(request.head.length))) / PROMPT_BYTES_PER_TOKEN);
    const worstMicros = messagesCostMicros(model, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: promptTokens, outputTokens: request.maxTokens });
    return { index, body, promptTokens, worstMicros, estimateMicros: 0, usageId: newId() };
  };
  const fingerprint = (p: Planned) => `replay:${input.runId}:${at}:${variants[p.index]!.id}`;
  /** The outputs seen so far (tokens), and what the calls cost (micros). */
  const outputs: number[] = [];
  let spent = 0;

  /**
   * Rows first, at each call's worst case and marked with its estimate (a request killed mid-call is still counted —
   * at its worst while a call of it may still run, then at the estimate: llm.ts `weekCostSql`); the calls; each settled,
   * its mark gone.
   */
  const call = async (batch: Planned[]): Promise<void> => {
    const writtenAt = clock().toISOString();
    await db.insert(llmUsage).values(
      batch.map((p) => ({
        id: p.usageId,
        userId,
        kind: REPLAY_USAGE_KIND,
        model,
        inputTokens: p.promptTokens,
        outputTokens: request.maxTokens,
        costMicros: p.worstMicros,
        cacheHit: false,
        requestFingerprint: `${fingerprint(p)}${RESERVATION_MARK}${p.estimateMicros}`,
        createdAt: writtenAt,
      })),
    );
    await Promise.all(
      batch.map(async (p) => {
        let result: MessagesResult;
        try {
          result = await deps.send(env, { model, body: p.body, maxTokens: request.maxTokens });
        } catch {
          result = { ok: false, kind: "retryable", reason: "llm_error" };
        }
        const billed = result.ok ? { usage: result.usage, costMicros: result.costMicros } : result.kind === "retryable" && result.usage ? { usage: result.usage, costMicros: result.costMicros ?? messagesCostMicros(model, result.usage) } : null;
        await db
          .update(llmUsage)
          .set(
            billed
              ? {
                  inputTokens: billed.usage.inputTokens + billed.usage.cacheReadTokens + billed.usage.cacheWriteTokens,
                  outputTokens: billed.usage.outputTokens,
                  costMicros: billed.costMicros,
                  cacheHit: billed.usage.cacheReadTokens > 0,
                  requestFingerprint: fingerprint(p),
                }
              : { inputTokens: 0, outputTokens: 0, costMicros: 0, cacheHit: false, requestFingerprint: fingerprint(p) },
          )
          .where(eq(llmUsage.id, p.usageId));
        const v = variants[p.index]!;
        v.costUsd = usd(billed?.costMicros ?? 0);
        if (billed) {
          const u = billed.usage;
          v.usage = { input: u.inputTokens, cacheRead: u.cacheReadTokens, cacheWrite: u.cacheWriteTokens, output: u.outputTokens };
        }
        if (result.ok) {
          Object.assign(v, wordsOf(result.content, answer));
          v.stopReason = result.stopReason;
          outputs.push(result.usage.outputTokens);
        } else {
          v.error = result.kind;
        }
        spent += billed?.costMicros ?? 0;
      }),
    );
  };

  const kept = state.outputs ?? [];
  /** A call's realistic cost: its prompt from the cache (written, for the first), twice the largest output seen. */
  const estimate = (p: Planned, first: boolean): number => {
    const out = 2 * Math.max(kept.length > 0 || outputs.length > 0 ? Math.max(...kept, ...outputs) : OUTPUT_GUESS, 1);
    return messagesCostMicros(model, { inputTokens: 0, cacheReadTokens: first ? 0 : p.promptTokens, cacheWriteTokens: first ? p.promptTokens : 0, outputTokens: out });
  };

  // ── The first variant, alone: it writes the shared prefix to the cache ──
  const week = (await llmBudgetStatus(db, userId)).spentMicros;
  const first = plan(0);
  if (week + first.worstMicros > LLM_BUDGET.cutoffMicros) {
    return { kind: "weekly_cap", why: REPLAY_WORDS.weeklyCap, spentUsd: usd(week), cutoffUsd: usd(LLM_BUDGET.cutoffMicros) };
  }
  first.estimateMicros = estimate(first, true);
  if (first.estimateMicros > REPLAY_REQUEST_CAP_MICROS) {
    for (const v of variants) v.skipped = { reason: "request_cap", why: REPLAY_WORDS.requestCap };
  } else {
    await call([first]);
  }

  // ── The rest, together, as far as the week and this request's cap cover them ──
  if (variants.length > 1 && !variants[0]!.skipped) {
    if (variants[0]!.error) {
      for (const v of variants.slice(1)) v.skipped = { reason: "first_failed", why: REPLAY_WORDS.firstFailed };
    } else {
      const weekNow = (await llmBudgetStatus(db, userId)).spentMicros;
      const batch: Planned[] = [];
      let estimated = spent;
      let worst = weekNow;
      for (let i = 1; i < variants.length; i++) {
        const p = plan(i);
        const est = estimate(p, false);
        if (estimated + est > REPLAY_REQUEST_CAP_MICROS) {
          variants[i]!.skipped = { reason: "request_cap", why: REPLAY_WORDS.requestCap };
        } else if (worst + p.worstMicros > LLM_BUDGET.cutoffMicros) {
          variants[i]!.skipped = { reason: "weekly_cap", why: REPLAY_WORDS.weeklyCap };
        } else {
          p.estimateMicros = est;
          batch.push(p);
          estimated += est;
          worst += p.worstMicros;
        }
      }
      if (batch.length > 0) await call(batch);
    }
  }

  return {
    kind: "ok",
    body: {
      runId: input.runId,
      at,
      request: row.request,
      model,
      baseline,
      variants,
      costUsd: usd(spent),
      capNote: REPLAY_WORDS.capNote,
    },
  };
}

// ── The listing ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReplayOutcomeKind = "answer" | "workout" | "plan_change" | "set" | "plan";

export interface ReplayListItem {
  id: string;
  at: string;
  /** The athlete's own words. */
  words: string | null;
  /** The coach's last line, clipped. */
  line: string | null;
  outcome: ReplayOutcomeKind;
  /** The steps a replay can take: always its finish; its question when it asked one; its own workout's words. */
  steps: ReplayStep[];
  /** What the run cost (its own calls). */
  costUsd: number;
}

interface ListRow {
  id: string;
  at: string;
  words: string | null;
  costUsd: number | null;
  line: string | null;
  ops: string | null;
  asked: number;
}

/** The athlete's finished main runs, newest first, at most `limit` (never a rehearsal's). ONE statement. */
export async function listReplayable(db: Db, userId: string, limit: number): Promise<{ runs: ReplayListItem[] }> {
  const count = (where: string) => `count(CASE WHEN ${where} THEN 1 END)`;
  const k = "json_extract(o.value, '$.kind')";
  const rows = (await db.all(sql`
    SELECT r.id AS id, r.created_at AS at, r.request AS words, r.cost_usd AS costUsd,
      ${FINAL_LINE} AS line,
      (SELECT json_object(
          'workouts', ${sql.raw(count(`${k} = 'doc_workout'`))},
          'mine', ${sql.raw(count(`${k} = 'doc_workout' AND json_extract(o.value, '$.by.runId') = r.id`))},
          'designers', ${sql.raw(count(`${k} = 'doc_workout' AND json_extract(o.value, '$.by.role') = 'designer'`))},
          'changes', ${sql.raw(count(`${k} = 'plan_adjust'`))},
          'plans', ${sql.raw(count(`${k} = 'plan_structure'`))}) ${OPS_OF}) AS ops,
      EXISTS (SELECT 1 FROM coach_run_events q WHERE q.run_id = r.id AND q.user_id = r.user_id AND q.kind = 'question'
        AND (NOT json_valid(q.payload) OR json_extract(q.payload, '$.data.check') IS NULL)) AS asked
    FROM coach_runs r WHERE ${replayable(userId)}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ${limit}
  `)) as ListRow[];
  return {
    runs: rows.map((r) => {
      const ops = (parsed(r.ops) ?? {}) as { workouts?: number; mine?: number; designers?: number; changes?: number; plans?: number };
      // A set's workouts are its designers' (whatever the scope: an auto run plans one too).
      const outcome: ReplayOutcomeKind =
        (ops.plans ?? 0) > 0
          ? "plan"
          : (ops.designers ?? 0) > 0
            ? "set"
            : (ops.workouts ?? 0) > 0
              ? "workout"
              : (ops.changes ?? 0) > 0
                ? "plan_change"
                : "answer";
      return {
        id: r.id,
        at: r.at,
        words: r.words,
        line: r.line ? clipProse(r.line, LIST_LINE_MAX) : null,
        outcome,
        steps: ["finish", ...(r.asked ? (["ask"] as const) : []), ...((ops.mine ?? 0) > 0 ? (["prose"] as const) : [])],
        costUsd: Number(r.costUsd ?? 0),
      };
    }),
  };
}
