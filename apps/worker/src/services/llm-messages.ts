import type { Env } from "../env.js";
import { OUT_OF_CREDITS_REASON } from "./ai-credits.js";
import { wakeGateway } from "./coach-wake.js";

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
 * Fixture mode routes exactly as the coach wake does (`wakeGateway`): a canned answer and no network, unless
 * `FIXTURE_MODEL_URL` names a recorded-model server on loopback, which then gets `{FIXTURE_MODEL_URL}/messages`.
 *
 * WHAT THE GATEWAY ACCEPTS (free schema probe, `apps/worker/scripts/probe-gateway-model.mjs`, 2026-10-12). The gateway
 * validates the body before it authenticates, so a junk key and a deliberately invalid value tell whether a field is
 * parsed (400 naming it) or dropped (401). `output_config.effort` (enum low|medium|high|max|xhigh), `cache_control` on
 * system blocks, on tools, on message content blocks and at the top level, `tool_choice`, `thinking`, `stream` and
 * `max_tokens` are all parsed. The model id is NOT checked before authentication (a made-up id also answers 401), so
 * the model ids and their prices come from the gateway's public, unauthenticated `GET {base}/models` listing instead.
 */

/** The strongest Claude model the gateway lists (probe, 2026-10-12): Claude Opus 5.5 under the gateway's naming. */
export const DEFAULT_DESIGN_MODEL = "anthropic/claude-opus-5.5";
const DEFAULT_GATEWAY = "https://ai-gateway.vercel.sh/v1";
const ANTHROPIC_VERSION = "2023-06-01";
// A design step can think for minutes. Streaming is load-bearing for that, not cosmetic: a buffered answer must finish
// inside the gateway's own response window, and the old Studio's buffered Opus calls were live-verified to die as 524s.
// Silence this long means a wedged connection, not thinking; it is enforced per read, because an AbortController
// alone was live-verified not to cut loose an in-progress body read in workerd (studio-llm.ts).
const TIMEOUT_MS = 600_000;
const STREAM_STALL_MS = 150_000;

export function designModel(env: Env): string {
  return env.AI_DESIGN_MODEL || DEFAULT_DESIGN_MODEL;
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
 * The one price table: copied from the gateway's own listing (`GET https://ai-gateway.vercel.sh/v1/models`,
 * 2026-10-12, global rates; the "us"/"eu" regional rates are 10% higher and this client asks for no region).
 * Cache reads are not a fixed fraction of input — Opus 5.5 reads at 0.05×, Opus 5 at 0.1×, Fable 5.1 at 0.025× — so
 * every rate is listed, never derived. Re-run the probe script and update a row when the gateway's prices move.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  "anthropic/claude-opus-5.5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "anthropic/claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "anthropic/claude-fable-5.1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "anthropic/claude-sonnet-5.5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** A model the table does not know is priced at its highest rate for each kind of token: the weekly cap can then
 * only trip early, never late. */
const UNKNOWN_MODEL_PRICE: ModelPrice = Object.values(MODEL_PRICES).reduce(
  (m, p) => ({
    input: Math.max(m.input, p.input),
    output: Math.max(m.output, p.output),
    cacheRead: Math.max(m.cacheRead, p.cacheRead),
    cacheWrite: Math.max(m.cacheWrite, p.cacheWrite),
  }),
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
);

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
  const p = MODEL_PRICES[model] ?? UNKNOWN_MODEL_PRICE;
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
  /** 408, 429, 5xx, a dropped or silent connection, a broken answer: worth another try on a later step. */
  | { ok: false; kind: "retryable"; reason: string; status?: number }
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

export async function callMessages(
  env: Env,
  req: MessagesRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<MessagesResult> {
  const model = req.model || designModel(env);
  const gateway = wakeGateway(env);
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

  const body = JSON.stringify({
    model,
    max_tokens: req.maxTokens,
    system: req.system,
    ...(req.tools.length > 0 ? { tools: req.tools } : {}),
    messages: req.messages,
    ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    stream: true,
  });

  const startedAt = Date.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${gateway.env.AI_GATEWAY_BASE_URL || DEFAULT_GATEWAY}/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${gateway.env.AI_GATEWAY_API_KEY ?? ""}`,
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
        ? await readStream(response.body, startedAt)
        : await readJson(response);
    if (!answer.ok) return answer;

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

type RawMessage = { content?: unknown; stop_reason?: unknown; usage?: unknown };

async function readJson(response: Response): Promise<Answer | MessagesFailure> {
  const text = await response.text().catch(() => null);
  let parsed: RawMessage | null;
  try {
    parsed = text === null ? null : (JSON.parse(text) as RawMessage | null);
  } catch {
    parsed = null;
  }
  if (!parsed || !Array.isArray(parsed.content)) return retryable("gateway_bad_response");
  return {
    ok: true,
    content: parsed.content as ContentBlock[],
    stopReason: typeof parsed.stop_reason === "string" ? (parsed.stop_reason as StopReason) : null,
    usage: parsed.usage && typeof parsed.usage === "object" ? (parsed.usage as RawUsage) : {},
  };
}

/** Race a promise against a timer without leaking the timer. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timed_out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timed_out">((resolve) => {
    timer = setTimeout(() => resolve("timed_out"), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
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

/**
 * Assemble an SSE answer into the message it describes: message_start (usage) → per block content_block_start /
 * _delta / _stop → message_delta (stop reason, final usage) → message_stop. A tool call's input arrives as JSON in
 * pieces and is parsed once its block stops. A stream that ends before the model says it stopped is a dropped
 * connection, not a short answer.
 */
async function readStream(body: ReadableStream<Uint8Array>, startedAt: number): Promise<Answer | MessagesFailure> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const blocks: Array<Record<string, unknown> | undefined> = [];
  const toolJson: string[] = [];
  let usage: RawUsage = {};
  let stopReason: StopReason | null = null;
  let stopped = false;
  let buffered = "";
  try {
    for (;;) {
      const wait = Math.max(1000, Math.min(STREAM_STALL_MS, TIMEOUT_MS - (Date.now() - startedAt)));
      const next = await withTimeout(reader.read(), wait);
      if (next === "timed_out") {
        await reader.cancel().catch(() => undefined);
        return retryable("llm_timeout");
      }
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
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
            break;
          case "message_stop":
            stopped = true;
            break;
          case "error":
            await reader.cancel().catch(() => undefined);
            return retryable(`stream_${event.error?.type ?? "error"}`);
        }
      }
    }
  } catch {
    return retryable("llm_error");
  }
  if (!stopped && stopReason === null) return retryable("gateway_bad_response");
  return {
    ok: true,
    content: blocks.filter((b): b is Record<string, unknown> => !!b) as unknown as ContentBlock[],
    stopReason,
    usage,
  };
}
