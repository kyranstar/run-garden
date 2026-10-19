import { fixtureModeEnabled, type Env } from "../env.js";
import { OUT_OF_CREDITS_REASON } from "./ai-credits.js";
import { wakeGateway } from "./gateway-route.js";

/**
 * THE COACH DESIGNER'S MODEL CLIENT — the AI gateway's native Messages endpoint (Stage 3 spec §2).
 *
 * The thread coach talks to the gateway's OpenAI-compatible `/chat/completions` (studio-llm.ts `chatCompletion`).
 * The designer needs three things that surface cannot carry, so it talks to `POST {base}/messages` on the same host
 * with the same key instead: tool definitions and tool-use turns, prompt caching at explicit breakpoints
 * (`cache_control: {type: "ephemeral"}`), and the real effort setting (`output_config.effort`, which the
 * chat-completions surface parses but never forwards on Claude 5 — see the probe write-up above `chatCompletion`).
 *
 * One call is ONE fetch, and it is never retried here: a step's budget counts it as one (≤ 45 statements + fetches
 * per request), so a transient failure comes back `retryable` and the step loop decides when to try again. A 402 is
 * `out_of_credits` under the existing marker (ai-credits.ts), so `noteGatewayOutcome(db, userId, result)` records and
 * clears it exactly as it does for the coach. Spend is not recorded here (this module takes no database): the caller
 * writes `costMicros` to `llm_usage` and enforces the weekly cap before calling.
 *
 * Fixture mode routes exactly as the coach wake does (`wakeGateway`, gateway-route.ts): a canned answer and no network, unless
 * `FIXTURE_MODEL_URL` names a recorded-model server on loopback, which then gets `{FIXTURE_MODEL_URL}/messages`.
 *
 * WHAT THE GATEWAY ACCEPTS (free schema probe, `apps/worker/scripts/probe-gateway-model.mjs`, 2026-10-12). The gateway
 * validates the body before it authenticates, so a junk key and a deliberately invalid value tell whether a field is
 * parsed (400 naming it) or dropped (401). `output_config.effort` (enum low|medium|high|max|xhigh), `cache_control` on
 * system blocks, on tools, on message content blocks and at the top level, `tool_choice`, `thinking`, `stream` and
 * `max_tokens` are all parsed. The model id is NOT checked before authentication (a made-up id also answers 401), so
 * the model ids and their prices come from the gateway's public, unauthenticated `GET {base}/models` listing instead.
 */

/** The owner's chosen default (2026-10-10: quality first — Opus 5.5 with caching, inside the $20/week cap): Claude
 * Opus 5.5 under the gateway's naming, listed by the gateway on 2026-10-12. Configurable via `AI_DESIGN_MODEL`. */
export const DEFAULT_DESIGN_MODEL = "anthropic/claude-opus-5.5";
const DEFAULT_GATEWAY = "https://ai-gateway.vercel.sh/v1";
const ANTHROPIC_VERSION = "2023-06-01";
// A design step can think for minutes. Streaming is load-bearing for that, not cosmetic: a buffered answer must finish
// inside the gateway's own response window, and the old Studio's buffered Opus calls were live-verified to die as 524s.
// Silence this long means a wedged connection, not thinking; it is enforced per read, because an AbortController
// alone was live-verified not to cut loose an in-progress body read in workerd (studio-llm.ts).
const TIMEOUT_MS = 600_000;
const STREAM_STALL_MS = 150_000;
/** A design call's own deadline (TIMEOUT_MS): the run's stepper waits it out before it takes back a step it can't know
 * is dead (coach-run-stepper.ts). */
export const DESIGN_MODEL_TIMEOUT_MS = TIMEOUT_MS;
/** The shortest deadline the fixture stack may name (`FIXTURE_MODEL_TIMEOUT_MS`). */
const FIXTURE_TIMEOUT_MIN_MS = 5_000;

/**
 * A design call's deadline here: TIMEOUT_MS — or, in fixture mode only (the fixture stack and local dev; production is
 * never fixture mode, pinned), `FIXTURE_MODEL_TIMEOUT_MS` when it names a shorter one. A test seam: the e2e takes the
 * worker down mid-step, and the run's object takes that step back only once no call could still be running (this
 * deadline, and a minute) — with 10 minutes that is an 11-minute journey. The call and the takeback read the same value.
 */
export function designModelTimeoutMs(env: Pick<Env, "FIXTURE_MODE" | "FIXTURE_MODEL_TIMEOUT_MS"> | undefined): number {
  if (env?.FIXTURE_MODE !== "1") return TIMEOUT_MS;
  const ms = Number(env.FIXTURE_MODEL_TIMEOUT_MS);
  return Number.isInteger(ms) && ms >= FIXTURE_TIMEOUT_MIN_MS && ms < TIMEOUT_MS ? ms : TIMEOUT_MS;
}

/**
 * The fixture stack's scripted model (Task 9): `AI_DESIGN_MODEL=scripted:<name>` names a script its stand-in model on
 * loopback serves (apps/web/e2e/coach-design-model.mjs, reached through `FIXTURE_MODEL_URL`), so the composer → run →
 * proposal → approve journey runs with no key. A test seam, never a model: outside fixture mode — the guard `/api/dev/*`
 * uses — a scripted id is ignored and the default model stands, so production can never be pointed at a script.
 */
export const SCRIPTED_MODEL_PREFIX = "scripted:";

/** `wanted`, unless it is a scripted id outside fixture mode (then the default). */
function honoured(env: Env, wanted: string | undefined): string | undefined {
  return wanted?.startsWith(SCRIPTED_MODEL_PREFIX) && !fixtureModeEnabled(env) ? undefined : wanted;
}

export function designModel(env: Env): string {
  return honoured(env, env.AI_DESIGN_MODEL) || DEFAULT_DESIGN_MODEL;
}

// ── Prices ──────────────────────────────────────────────────────────────

/** US dollars per 1M tokens. A cache write is the 5-minute write (the only TTL this client sends). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * The one price table: every Claude id in the gateway's own listing (`GET https://ai-gateway.vercel.sh/v1/models`,
 * 2026-10-12, global rates; the "us"/"eu" regional rates are 10% higher and this client asks for no region). Cache
 * reads are not a fixed fraction of input — Opus 5.5 reads at 0.05×, Opus 5 at 0.1×, Fable 5 at 0.1×, Fable 5.1 at
 * 0.025× — so every rate is listed, never derived. A model whose prices rise with the prompt's length (Haiku 5.5 past
 * 100k tokens, Sonnet 4 / 4.5 past 200k) is entered at its top tier: an over-estimate, never an under-estimate. Re-run
 * the probe script and update a row when the gateway's prices move.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "anthropic/claude-opus-5.5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "anthropic/claude-opus-5.5-fast": { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
  "anthropic/claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "anthropic/claude-opus-5-fast": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "anthropic/claude-opus-4.8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "anthropic/claude-opus-4.8-fast": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "anthropic/claude-opus-4.7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "anthropic/claude-opus-4.6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "anthropic/claude-opus-4.5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "anthropic/claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "anthropic/claude-fable-5.1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "anthropic/claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "anthropic/claude-sonnet-5.5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "anthropic/claude-sonnet-4.6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "anthropic/claude-sonnet-4.5": { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 },
  "anthropic/claude-sonnet-4": { input: 6, output: 22.5, cacheRead: 0.6, cacheWrite: 7.5 },
  "anthropic/claude-haiku-5.5": { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "anthropic/claude-3-haiku": { input: 0.25, output: 1.25, cacheRead: 0.03, cacheWrite: 0.3 },
};

/**
 * What a model the table does not know is charged: the highest rate the gateway listed for each kind of token, so
 * the weekly cap can only trip early, never late. That is Claude Opus 4 ($15 / $75, cache read $1.50, cache write
 * $18.75), which was in the listing on the morning of 2026-10-12 and gone from it an hour later; the listing changes
 * between calls, so the ceiling keeps the highest seen. Every row above sits at or under it.
 */
export const PRICE_CEILING: Readonly<ModelPrice> = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };

export interface MessagesUsage {
  /** Uncached input only: the whole prompt is inputTokens + cacheReadTokens + cacheWriteTokens. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Includes the model's thinking, billed as output. */
  outputTokens: number;
}

/** Whole micro-dollars, rounded up. $1 per 1M tokens is 1 µ$ per token; the sum is taken in integer µ$-per-1M
 * units so 0.2 µ$ × 3 is 1 µ$, not 0.6000000000000001 → 1 by luck. */
export function messagesCostMicros(model: string, usage: MessagesUsage): number {
  const p = MODEL_PRICES[model] ?? PRICE_CEILING;
  const perMillion = (usd: number) => Math.round(usd * 1_000_000);
  const total =
    usage.inputTokens * perMillion(p.input) +
    usage.cacheReadTokens * perMillion(p.cacheRead) +
    usage.cacheWriteTokens * perMillion(p.cacheWrite) +
    usage.outputTokens * perMillion(p.output);
  return Math.ceil(total / 1_000_000);
}

// ── Wire shapes (Anthropic Messages) ────────────────────────────────────

export type CacheControl = { type: "ephemeral" };
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** A system block. Put `cache_control` on the last block of each stable stretch: everything up to it (tools, then
 * system) is cached as one prefix. At most 4 breakpoints per request, counting tools and messages. */
export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}

export interface TextBlock {
  type: "text";
  text: string;
}
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
/** The model's thinking. Echo it back unchanged (signature and all) in the next request: Claude Opus 5.5 checks that
 * the history it reasoned over was not edited. With the default display its text is empty. */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}
export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}
/** What the model answers with. Blocks of any other type pass through verbatim (the turn must echo unchanged); the
 * designer, which sends no server tools, meets these four. */
export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | RedactedThinkingBlock;

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | TextBlock[];
  is_error?: boolean;
}

type Cacheable<T> = T & { cache_control?: CacheControl };
export type RequestBlock =
  | Cacheable<TextBlock>
  | Cacheable<ToolUseBlock>
  | Cacheable<ToolResultBlock>
  | ThinkingBlock
  | RedactedThinkingBlock;

export interface MessageParam {
  role: "user" | "assistant";
  content: string | RequestBlock[];
}

export interface MessagesRequest {
  /** Defaults to `designModel(env)`. */
  model?: string;
  system: SystemBlock[];
  messages: MessageParam[];
  tools: ToolDefinition[];
  maxTokens: number;
  /** Omitted: the model's default (Opus 5.5: medium). */
  effort?: Effort;
}

export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal";

export interface MessagesOk {
  ok: true;
  /** The model asked for, in the gateway's naming (the price table's key). */
  model: string;
  content: ContentBlock[];
  stopReason: StopReason | null;
  usage: MessagesUsage;
  costMicros: number;
}

export type MessagesFailure =
  /** No key configured: nothing was sent. */
  | { ok: false; kind: "no_key"; reason: "no_key" }
  /** 402: the account needs credits. Never retried; `isOutOfCredits(reason)` is true. */
  | { ok: false; kind: "out_of_credits"; reason: typeof OUT_OF_CREDITS_REASON; status: 402 }
  /** 408, 429, 5xx, a dropped or silent connection, a broken answer: worth another try on a later step. When the
   * answer had begun (a 200 that then stalled, broke off, errored mid-stream or hit the deadline) the call is billed
   * as far as it got: `usage` is what the stream had reported (message_start / message_delta), else an estimate from
   * the request's size, and `costMicros` its price. */
  | { ok: false; kind: "retryable"; reason: string; status?: number; usage?: MessagesUsage; costMicros?: number }
  /** Any other 4xx: the request itself is wrong, and a resend would say the same. */
  | { ok: false; kind: "rejected"; reason: string; status: number };

export type MessagesResult = MessagesOk | MessagesFailure;

const retryable = (reason: string, status?: number): MessagesFailure =>
  status === undefined ? { ok: false, kind: "retryable", reason } : { ok: false, kind: "retryable", reason, status };

function failureForStatus(status: number): MessagesFailure {
  if (status === 402) return { ok: false, kind: "out_of_credits", reason: OUT_OF_CREDITS_REASON, status: 402 };
  if (status === 408 || status === 429 || status >= 500) return retryable(`gateway_${status}`, status);
  return { ok: false, kind: "rejected", reason: `gateway_${status}`, status };
}

/** Fixture mode's whole model: an answer that says what it is. */
const CANNED_TEXT = "Fixture mode: a canned answer from the designer's model client. No model was called.";

// ── The call ────────────────────────────────────────────────────────────

/** Fixture mode's answer (no network), or no key's (nothing sent); null when the call goes to the model. */
function unsent(gateway: ReturnType<typeof wakeGateway>, model: string): MessagesResult | null {
  if (gateway.kind === "no_key") return { ok: false, kind: "no_key", reason: "no_key" };
  if (gateway.kind === "canned") {
    return {
      ok: true,
      model,
      content: [{ type: "text", text: CANNED_TEXT }],
      stopReason: "end_turn",
      usage: { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 },
      costMicros: 0,
    };
  }
  return null;
}

export async function callMessages(
  env: Env,
  req: MessagesRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<MessagesResult> {
  const model = honoured(env, req.model) || designModel(env);
  const gateway = wakeGateway(env);
  if (gateway.kind !== "model") return unsent(gateway, model)!;

  const body = JSON.stringify({
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    ...(req.tools.length > 0 ? { tools: req.tools } : {}),
    messages: req.messages,
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    stream: true,
  });
  return post(gateway.env, env, model, body, req.maxTokens, fetchImpl);
}

/**
 * A call whose body is already written — exactly as `callMessages` writes one (its keys in its order, `stream: true`)
 * — for `model`, already resolved (`designModel(env)`). The voice workshop's replay (coach-replay.ts) writes a run's
 * shared prefix once and only each variant's newest message after it, rather than serialising the whole history once a
 * variant. Routed, answered and priced exactly as `callMessages` is.
 */
export async function sendMessagesBody(
  env: Env,
  model: string,
  body: string,
  maxTokens: number,
  fetchImpl: typeof fetch = fetch,
): Promise<MessagesResult> {
  const gateway = wakeGateway(env);
  if (gateway.kind !== "model") return unsent(gateway, model)!;
  return post(gateway.env, env, model, body, maxTokens, fetchImpl);
}

/** The one POST, its answer read and priced (`callMessages`, `sendMessagesBody`). `gatewayEnv` is where it goes. */
async function post(
  gatewayEnv: Env,
  env: Env,
  model: string,
  body: string,
  maxTokens: number,
  fetchImpl: typeof fetch,
): Promise<MessagesResult> {
  const startedAt = Date.now();
  const timeoutMs = designModelTimeoutMs(env);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${gatewayEnv.AI_GATEWAY_BASE_URL || DEFAULT_GATEWAY}/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${gatewayEnv.AI_GATEWAY_API_KEY ?? ""}`,
          "Content-Type": "application/json",
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
      });
    } catch {
      return retryable(controller.signal.aborted ? "llm_timeout" : "llm_error");
    }

    if (!response.ok) {
      // The gateway's own words, for `wrangler tail` — a bare status was undebuggable (llm.ts). Never the request.
      const detail = await response.text().catch(() => "");
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "llm-messages: ai gateway error",
          status: response.status,
          model,
          detail: detail.slice(0, 600),
        }),
      );
      return failureForStatus(response.status);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const answer =
      contentType.includes("text/event-stream") && response.body
        ? await readStream(response.body, startedAt, controller.signal, timeoutMs)
        : await readJson(response, startedAt, controller.signal, timeoutMs);
    if (!answer.ok) {
      if (!("cut" in answer)) return answer;
      // The answer began, so the call was billed: as far as the stream reported, or at an estimate of the input.
      const usage = cutUsage(answer, body, Date.now() - startedAt, maxTokens);
      return { ok: false, kind: "retryable", reason: answer.reason, usage, costMicros: messagesCostMicros(model, usage) };
    }

    const usage = usageOf(answer.usage, body, answer.content);
    return {
      ok: true,
      model,
      content: answer.content,
      stopReason: answer.stopReason,
      usage,
      costMicros: messagesCostMicros(model, usage),
    };
  } finally {
    clearTimeout(deadline);
  }
}

// ── Reading the answer ──────────────────────────────────────────────────

type RawUsage = Record<string, unknown>;
interface Answer {
  ok: true;
  content: ContentBlock[];
  stopReason: StopReason | null;
  usage: RawUsage;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The gateway's usage, field by field. A count it did not send is estimated at ~4 characters per token rather than
 * taken as zero: the weekly cap must see real spend, and an answer is never free (studio-llm.ts does the same). */
function usageOf(raw: RawUsage, requestBody: string, content: ContentBlock[]): MessagesUsage {
  return {
    inputTokens: num(raw.input_tokens) ?? Math.ceil(requestBody.length / 4),
    cacheReadTokens: num(raw.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: num(raw.cache_creation_input_tokens) ?? 0,
    outputTokens: num(raw.output_tokens) ?? Math.ceil(JSON.stringify(content).length / 4),
  };
}

/** An answer that began (the gateway said 200) and then failed: the reason, with what the stream had said so far. */
interface Cut {
  ok: false;
  cut: true;
  reason: string;
  usage: RawUsage;
  content: unknown[];
  /** A message_delta reported the output count: the real one, not a guess. */
  outputReported: boolean;
}
const cutOff = (reason: string, usage: RawUsage = {}, content: unknown[] = [], outputReported = false): Cut => ({
  ok: false,
  cut: true,
  reason,
  usage,
  content,
  outputReported,
});

/** How fast a model is taken to have written while nothing said how much: pessimistic, so the cap trips early. */
export const PESSIMISTIC_OUTPUT_TOKENS_PER_SECOND = 60;

/**
 * A broken-off answer's usage: the counts the stream reported; the input estimated from the request when it never
 * said. The output is the stream's own count when a message_delta reported one; otherwise — cut off, or never seen
 * (thinking is billed and not shown) — it is taken pessimistically as the larger of what arrived (~4 characters a
 * token) and 60 tokens a second of the call so far, capped at the call's max_tokens.
 */
function cutUsage(cut: Cut, requestBody: string, elapsedMs: number, maxTokens: number): MessagesUsage {
  const raw = cut.usage;
  const arrived = cut.content.length > 0 ? Math.ceil(JSON.stringify(cut.content).length / 4) : 0;
  const reported = num(raw.output_tokens);
  const outputTokens =
    cut.outputReported && reported !== null
      ? Math.max(reported, arrived)
      : Math.min(
          maxTokens,
          Math.max(arrived, reported ?? 0, Math.ceil((Math.max(0, elapsedMs) / 1000) * PESSIMISTIC_OUTPUT_TOKENS_PER_SECOND)),
        );
  return {
    inputTokens: num(raw.input_tokens) ?? Math.ceil(requestBody.length / 4),
    cacheReadTokens: num(raw.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: num(raw.cache_creation_input_tokens) ?? 0,
    outputTokens,
  };
}

type RawMessage = { content?: unknown; stop_reason?: unknown; usage?: unknown };

/** How long the next read may take: the stall limit, or what is left of the whole call's deadline if less. */
function readWait(startedAt: number, timeoutMs: number): number {
  return Math.max(1000, Math.min(STREAM_STALL_MS, timeoutMs - (Date.now() - startedAt)));
}

/**
 * THE STALL GUARD: every read may wait `readWait` from when it began, and a read that waits longer is cut loose — the
 * reader cancelled, which settles the read, and the answer is a timeout. One watchdog serves the whole answer: a single
 * timer, re-armed only when it fires (for what is left of the read then under way), never a timer raced against each
 * read — a document turn is thousands of reads, and a timer each was a large part of its CPU. A later read never times
 * out before an earlier one would have (`readWait` shrinks no faster than the clock moves), so the timer is never
 * late; each read times out at the same instant as before.
 */
interface StallGuard {
  /** Call as each read begins. */
  reading(): void;
  /** The guard cut the read loose: the answer is a timeout. */
  readonly stalled: boolean;
  /** The answer is read (or given up): the timer goes. */
  stop(): void;
}

function stallGuard(reader: ReadableStreamDefaultReader<Uint8Array>, startedAt: number, timeoutMs: number): StallGuard {
  let began = 0;
  let wait = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stalled = false;
  let stopped = false;
  const check = () => {
    timer = undefined;
    if (stopped) return;
    const waited = Date.now() - began;
    if (waited < wait) {
      timer = setTimeout(check, wait - waited);
      return;
    }
    stalled = true;
    void reader.cancel().catch(() => undefined);
  };
  return {
    reading() {
      began = Date.now();
      wait = readWait(startedAt, timeoutMs);
      timer ??= setTimeout(check, wait);
    },
    get stalled() {
      return stalled;
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** A buffered answer. Its body is read through a reader, read by read, with the same stall guard as a stream's
 * reads (the abort alone does not cut a body read loose in workerd), so a stalled body can be cancelled:
 * `response.text()` would lock the body and leave nothing to cancel, keeping the connection open until the
 * invocation ends. */
async function readJson(response: Response, startedAt: number, deadline: AbortSignal, timeoutMs: number): Promise<Answer | Cut> {
  if (!response.body) return cutOff("gateway_bad_response");
  const reader = response.body.getReader();
  const guard = stallGuard(reader, startedAt, timeoutMs);
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      guard.reading();
      const next = await reader.read();
      if (guard.stalled) return cutOff("llm_timeout");
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    // The stall guard or the whole call's deadline cutting the read loose is a timeout; anything else is the
    // connection failing.
    return cutOff(guard.stalled || deadline.aborted ? "llm_timeout" : "llm_error");
  } finally {
    guard.stop();
  }
  let parsed: RawMessage | null;
  try {
    parsed = JSON.parse(text) as RawMessage | null;
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.content)) return cutOff("gateway_bad_response");
  return {
    ok: true,
    content: parsed.content as ContentBlock[],
    stopReason: typeof parsed.stop_reason === "string" ? (parsed.stop_reason as StopReason) : null,
    usage: parsed.usage && typeof parsed.usage === "object" ? (parsed.usage as RawUsage) : {},
  };
}

type StreamEvent = {
  type?: string;
  index?: number;
  message?: { usage?: RawUsage };
  content_block?: Record<string, unknown>;
  delta?: Record<string, unknown>;
  usage?: RawUsage;
  error?: { type?: string };
};

/** A tool input's piece, as the Messages API writes its line: this, the block's index, INPUT_DELTA_MID, the piece as
 * one JSON string, and `}}`. */
const INPUT_DELTA_HEAD = 'data: {"type":"content_block_delta","index":';
const INPUT_DELTA_MID = ',"delta":{"type":"input_json_delta","partial_json":"';
/** An index the fast path reads has at most this many digits (a longer one is read by the whole parse). */
const INDEX_DIGITS_MAX = 9;
const DIGIT_0 = 48;
const DIGIT_9 = 57;
const CR = 13;
const QUOTE = 34;
const CLOSE_BRACE = 125;

/** One JSON string literal's value; null when the text is not exactly one. */
function jsonString(literal: string): string | null {
  try {
    const value: unknown = JSON.parse(literal);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/**
 * Assemble an SSE answer into the message it describes: message_start (usage) → per block content_block_start /
 * _delta / _stop → message_delta (stop reason, final usage) → message_stop. A tool call's input arrives as JSON in
 * pieces and is parsed once its block stops. A stream that ends before the model says it stopped is a dropped
 * connection, not a short answer.
 *
 * THE FAST PATH. Most of a document turn is its tool inputs' pieces, an event each. A line that is exactly
 * INPUT_DELTA_HEAD, an index (a JSON integer: no leading zero), INPUT_DELTA_MID's rest, one JSON string and `}}` (a CR
 * before its newline allowed) is read without parsing the event whole: only its string is parsed. Such a line is
 * exactly the event `{type: "content_block_delta", index, delta: {type: "input_json_delta", partial_json}}` — these
 * keys, in this order, nothing else — so the whole parse would have read the same; any other line (another spelling,
 * another key, a broken string) is parsed whole, as every line was.
 */
export async function readStream(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  deadline: AbortSignal,
  timeoutMs: number = TIMEOUT_MS,
): Promise<Answer | Cut> {
  const reader = body.getReader();
  const guard = stallGuard(reader, startedAt, timeoutMs);
  const decoder = new TextDecoder();
  const blocks: Array<Record<string, unknown> | undefined> = [];
  const toolJson: string[] = [];
  let usage: RawUsage = {};
  let stopReason: StopReason | null = null;
  let stopped = false;
  let buffered = "";
  const sofar = (): unknown[] => blocks.filter((b): b is Record<string, unknown> => !!b);
  let outputReported = false;
  try {
    for (;;) {
      guard.reading();
      const next = await reader.read();
      if (guard.stalled) return cutOff("llm_timeout", usage, sofar(), outputReported);
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      // The lines read are skipped by position; what is left after the last newline is kept once, at the end.
      let from = 0;
      let newline: number;
      while ((newline = buffered.indexOf("\n", from)) >= 0) {
        const at = from;
        from = newline + 1;
        if (buffered.startsWith(INPUT_DELTA_HEAD, at)) {
          const digits = at + INPUT_DELTA_HEAD.length;
          let p = digits;
          let index = 0;
          for (let c = buffered.charCodeAt(p); c >= DIGIT_0 && c <= DIGIT_9 && p - digits < INDEX_DIGITS_MAX; c = buffered.charCodeAt(++p)) {
            index = index * 10 + (c - DIGIT_0);
          }
          const open = p + INPUT_DELTA_MID.length - 1;
          const end = buffered.charCodeAt(newline - 1) === CR ? newline - 1 : newline;
          if (
            p > digits &&
            (p === digits + 1 || buffered.charCodeAt(digits) !== DIGIT_0) &&
            buffered.startsWith(INPUT_DELTA_MID, p) &&
            end - 3 > open &&
            buffered.charCodeAt(end - 1) === CLOSE_BRACE &&
            buffered.charCodeAt(end - 2) === CLOSE_BRACE &&
            buffered.charCodeAt(end - 3) === QUOTE
          ) {
            const piece = jsonString(buffered.slice(open, end - 2));
            if (piece !== null) {
              if (blocks[index]) toolJson[index] = (toolJson[index] ?? "") + piece;
              continue;
            }
          }
        }
        const line = buffered.slice(at, newline).trim();
        if (!line.startsWith("data:")) continue;
        let event: StreamEvent;
        try {
          event = JSON.parse(line.slice(5).trim()) as StreamEvent;
        } catch {
          continue; // a keepalive or a non-JSON line
        }
        const i = event.index ?? -1;
        switch (event.type) {
          case "message_start":
            usage = { ...(event.message?.usage ?? {}) };
            break;
          case "content_block_start":
            if (i >= 0 && event.content_block) {
              blocks[i] = { ...event.content_block };
              if (event.content_block.type === "tool_use") toolJson[i] = "";
            }
            break;
          case "content_block_delta": {
            const block = blocks[i];
            const d = event.delta ?? {};
            if (!block) break;
            if (d.type === "text_delta") block.text = String(block.text ?? "") + String(d.text ?? "");
            else if (d.type === "thinking_delta") block.thinking = String(block.thinking ?? "") + String(d.thinking ?? "");
            else if (d.type === "signature_delta") block.signature = String(block.signature ?? "") + String(d.signature ?? "");
            else if (d.type === "input_json_delta") toolJson[i] = (toolJson[i] ?? "") + String(d.partial_json ?? "");
            break;
          }
          case "content_block_stop": {
            const block = blocks[i];
            const json = toolJson[i];
            if (block?.type === "tool_use" && json) {
              try {
                block.input = JSON.parse(json);
              } catch {
                // Cut off mid-input (stop reason max_tokens): the input stays `{}` and the tool's own validation
                // answers it; the step loop must not run tools on a max_tokens turn anyway.
              }
            }
            break;
          }
          case "message_delta":
            if (typeof event.delta?.stop_reason === "string") stopReason = event.delta.stop_reason as StopReason;
            for (const [k, v] of Object.entries(event.usage ?? {})) if (num(v) !== null) usage[k] = v;
            if (num(event.usage?.output_tokens) !== null) outputReported = true;
            break;
          case "message_stop":
            stopped = true;
            break;
          case "error":
            await reader.cancel().catch(() => undefined);
            return cutOff(`stream_${event.error?.type ?? "error"}`, usage, sofar(), outputReported);
        }
      }
      if (from > 0) buffered = buffered.slice(from);
    }
  } catch {
    // The stall guard or the whole call's deadline cutting the read loose is a timeout; anything else is the
    // connection failing.
    return cutOff(guard.stalled || deadline.aborted ? "llm_timeout" : "llm_error", usage, sofar(), outputReported);
  } finally {
    guard.stop();
  }
  if (!stopped && stopReason === null) return cutOff("gateway_bad_response", usage, sofar(), outputReported);
  return {
    ok: true,
    content: blocks.filter((b): b is Record<string, unknown> => !!b) as unknown as ContentBlock[],
    stopReason,
    usage,
  };
}
