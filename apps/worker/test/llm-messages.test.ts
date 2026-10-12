/**
 * The coach designer's model client: the AI gateway's native Messages endpoint (Stage 3 Task 1, spec §2).
 *
 * No key and no network: every call goes through an injected `fetchImpl` (the repo's seam — see
 * studio-llm.test.ts), which records what reached the "gateway" and answers with a scripted JSON body or SSE stream.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { isOutOfCredits, OUT_OF_CREDITS_REASON } from "../src/services/ai-credits.js";
import {
  callMessages,
  DEFAULT_DESIGN_MODEL,
  designModel,
  messagesCostMicros,
  MODEL_PRICES,
  type MessageParam,
  type MessagesRequest,
  type SystemBlock,
  type ToolDefinition,
} from "../src/services/llm-messages.js";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "test-session-secret",
    TOKEN_ENCRYPTION_KEY: "test-token-encryption-key",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    AI_GATEWAY_API_KEY: "test-gateway-key",
    ...overrides,
  };
}

interface Scripted {
  status?: number;
  /** A JSON body (non-streaming answer). */
  json?: unknown;
  /** SSE events, sent as `event:`/`data:` pairs in small chunks that split lines. */
  sse?: Array<Record<string, unknown>>;
  /** Raw body text, sent as-is. */
  text?: string;
  throws?: boolean;
  /** A stream that sends these events and then never ends. */
  hangAfter?: Array<Record<string, unknown>>;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function sseText(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

/** A body that arrives 7 bytes at a time, so lines and JSON split across reads. */
function chunked(text: string, hang = false): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        if (!hang) controller.close();
        return hang ? new Promise<void>(() => undefined) : undefined;
      }
      controller.enqueue(bytes.slice(at, at + 7));
      at += 7;
      return undefined;
    },
  });
}

function scriptedFetch(responses: Scripted[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    calls.push({
      url: String(input),
      headers,
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
    });
    const spec = responses[i++];
    if (!spec) throw new Error("scriptedFetch: no more responses configured");
    if (spec.throws) throw new TypeError("fetch failed");
    if (spec.sse || spec.hangAfter) {
      return new Response(chunked(sseText(spec.sse ?? spec.hangAfter ?? []), !!spec.hangAfter), {
        status: spec.status ?? 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (spec.text !== undefined) {
      return new Response(spec.text, { status: spec.status ?? 200, headers: { "content-type": "text/plain" } });
    }
    return new Response(JSON.stringify(spec.json ?? {}), {
      status: spec.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const failingFetch = (async () => {
  throw new Error("fetchImpl must not be called in this test");
}) as typeof fetch;

// ── A request the designer might make ────────────────────────────────────

const SYSTEM: SystemBlock[] = [
  { type: "text", text: "PRINCIPLES AND TOOL CONTRACTS (stable)" },
  { type: "text", text: "ACTIVE PROFILE SUMMARY (stable per athlete)", cache_control: { type: "ephemeral" } },
  { type: "text", text: "PINNED MEMORY (changes)" },
];

const TOOLS: ToolDefinition[] = [
  {
    name: "search_library",
    description: "Find moves in the library.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "validate_workout",
    description: "Check a draft document.",
    input_schema: { type: "object", properties: { doc: { type: "object" } }, required: ["doc"] },
  },
];

const MESSAGES: MessageParam[] = [
  { role: "user", content: "TODAY HEADER\n<athlete_request>something gentle</athlete_request>" },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "tool_use", id: "toolu_1", name: "search_library", input: { query: "hip" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: '{"data":[]}', cache_control: { type: "ephemeral" } },
    ],
  },
];

function request(over: Partial<MessagesRequest> = {}): MessagesRequest {
  return { system: SYSTEM, messages: MESSAGES, tools: TOOLS, maxTokens: 8000, ...over };
}

function messageJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: "Done." }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────

describe("callMessages — the request", () => {
  it("posts the Messages body: system blocks with their cache breakpoint, tools, messages, effort, streaming", async () => {
    const { fetchImpl, calls } = scriptedFetch([{ json: messageJson() }]);
    const result = await callMessages(makeEnv(), request({ effort: "high" }), fetchImpl);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://ai-gateway.vercel.sh/v1/messages");
    expect(call.headers.authorization).toBe("Bearer test-gateway-key");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.body).toEqual({
      model: DEFAULT_DESIGN_MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      tools: TOOLS,
      messages: MESSAGES,
      output_config: { effort: "high" },
      stream: true,
    });
    // The breakpoint is where the caller put it — and only there.
    const system = call.body.system as SystemBlock[];
    expect(system.map((b) => b.cache_control ?? null)).toEqual([null, { type: "ephemeral" }, null]);
  });

  it("sends no output_config without an effort, and no tools key for an empty tool list", async () => {
    const { fetchImpl, calls } = scriptedFetch([{ json: messageJson() }]);
    await callMessages(makeEnv(), request({ tools: [] }), fetchImpl);
    expect(calls[0]!.body).not.toHaveProperty("output_config");
    expect(calls[0]!.body).not.toHaveProperty("tools");
  });

  it("takes the model from AI_DESIGN_MODEL (a caller's model wins) and the base URL from AI_GATEWAY_BASE_URL", async () => {
    const env = makeEnv({ AI_DESIGN_MODEL: "anthropic/claude-sonnet-5.5", AI_GATEWAY_BASE_URL: "https://gw.test/v1" });
    expect(designModel(env)).toBe("anthropic/claude-sonnet-5.5");
    expect(designModel(makeEnv())).toBe(DEFAULT_DESIGN_MODEL);

    const { fetchImpl, calls } = scriptedFetch([{ json: messageJson() }, { json: messageJson() }]);
    const first = await callMessages(env, request(), fetchImpl);
    const second = await callMessages(env, request({ model: "anthropic/claude-opus-5" }), fetchImpl);
    expect(calls.map((c) => [c.url, c.body.model])).toEqual([
      ["https://gw.test/v1/messages", "anthropic/claude-sonnet-5.5"],
      ["https://gw.test/v1/messages", "anthropic/claude-opus-5"],
    ]);
    expect(first.ok && first.model).toBe("anthropic/claude-sonnet-5.5");
    expect(second.ok && second.model).toBe("anthropic/claude-opus-5");
  });

  it("defaults to the strongest Claude id the gateway lists (probed 2026-10-12)", () => {
    expect(DEFAULT_DESIGN_MODEL).toBe("anthropic/claude-opus-5.5");
    expect(MODEL_PRICES[DEFAULT_DESIGN_MODEL]).toBeDefined();
  });
});

describe("callMessages — the answer (JSON)", () => {
  it("returns the content blocks verbatim, the stop reason, and usage with cache reads and writes", async () => {
    const content = [
      { type: "thinking", thinking: "", signature: "sig-abc" },
      { type: "text", text: "Looking at the library." },
      { type: "tool_use", id: "toolu_9", name: "search_library", input: { query: "ankle" } },
    ];
    const { fetchImpl } = scriptedFetch([
      {
        json: messageJson({
          content,
          stop_reason: "tool_use",
          usage: {
            input_tokens: 1_000,
            cache_creation_input_tokens: 2_000,
            cache_read_input_tokens: 10_000,
            output_tokens: 500,
          },
        }),
      },
    ]);
    const result = await callMessages(makeEnv(), request(), fetchImpl);
    expect(result).toEqual({
      ok: true,
      model: DEFAULT_DESIGN_MODEL,
      content,
      stopReason: "tool_use",
      usage: { inputTokens: 1_000, cacheReadTokens: 10_000, cacheWriteTokens: 2_000, outputTokens: 500 },
      // Opus 5.5 per 1M: $4 in, $0.20 cache read, $5 cache write, $20 out.
      costMicros: 1_000 * 4 + 10_000 * 0.2 + 2_000 * 5 + 500 * 20,
    });
  });
});

describe("cost", () => {
  it("prices every token kind at its own rate, in whole micro-dollars rounded up", () => {
    const usage = { inputTokens: 1_000, cacheReadTokens: 10_000, cacheWriteTokens: 2_000, outputTokens: 500 };
    expect(messagesCostMicros("anthropic/claude-opus-5.5", usage)).toBe(26_000);
    // Cache reads alone are not free, and are cheaper than fresh input.
    expect(messagesCostMicros("anthropic/claude-opus-5.5", { ...usage, inputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })).toBe(2_000);
    // Opus 5 reads its cache at $0.50 / 1M — a different ratio, from the table, not a rule of thumb.
    expect(messagesCostMicros("anthropic/claude-opus-5", { ...usage, inputTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })).toBe(5_000);
    // 3 cache-read tokens at 0.2 µ$ each = 0.6 µ$ → 1, never 0 and never a float.
    expect(messagesCostMicros("anthropic/claude-opus-5.5", { inputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 0, outputTokens: 0 })).toBe(1);
  });

  it("prices a model missing from the table at the table's highest rates — the cap trips early, never late", () => {
    const usage = { inputTokens: 1_000, cacheReadTokens: 1_000, cacheWriteTokens: 1_000, outputTokens: 1_000 };
    const highest = Object.values(MODEL_PRICES).reduce(
      (m, p) => ({
        input: Math.max(m.input, p.input),
        output: Math.max(m.output, p.output),
        cacheRead: Math.max(m.cacheRead, p.cacheRead),
        cacheWrite: Math.max(m.cacheWrite, p.cacheWrite),
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );
    const expected = Math.ceil(1_000 * (highest.input + highest.output + highest.cacheRead + highest.cacheWrite));
    expect(messagesCostMicros("anthropic/claude-something-new", usage)).toBe(expected);
    expect(expected).toBeGreaterThan(messagesCostMicros(DEFAULT_DESIGN_MODEL, usage));
  });

  it("a response without usage is never free: tokens are estimated from the bytes", async () => {
    const { usage: _dropped, ...noUsage } = messageJson({ content: [{ type: "text", text: "x".repeat(400) }] });
    const { fetchImpl } = scriptedFetch([{ json: noUsage }]);
    const result = await callMessages(makeEnv(), request(), fetchImpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThanOrEqual(100);
    expect(result.costMicros).toBeGreaterThan(0);
  });
});

describe("callMessages — failures", () => {
  it("a 402 is out_of_credits under the existing marker: one fetch, never retried", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 402, json: { error: { message: "A positive credit balance is required" } } },
      { json: messageJson() },
    ]);
    const result = await callMessages(makeEnv(), request(), fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: "out_of_credits", reason: OUT_OF_CREDITS_REASON, status: 402 });
    expect(!result.ok && isOutOfCredits(result.reason)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it.each([500, 502, 503, 504, 524, 529, 429, 408])("a %i is retryable — one fetch; the step loop retries, not the client", async (status) => {
    const { fetchImpl, calls } = scriptedFetch([{ status, json: { error: { message: "busy" } } }, { json: messageJson() }]);
    const result = await callMessages(makeEnv(), request(), fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: "retryable", reason: `gateway_${status}`, status });
    expect(calls).toHaveLength(1);
  });

  it("a network failure is retryable", async () => {
    const { fetchImpl } = scriptedFetch([{ throws: true }]);
    const result = await callMessages(makeEnv(), request(), fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: "retryable", reason: "llm_error" });
  });

  it.each([400, 401, 403, 404, 413])("a %i is rejected — a resend would say the same", async (status) => {
    const { fetchImpl } = scriptedFetch([{ status, json: { error: { message: "output_config.effort: Invalid option" } } }]);
    const result = await callMessages(makeEnv(), request(), fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: "rejected", reason: `gateway_${status}`, status });
  });

  it("a 200 that is not a message is retryable, not an empty answer", async () => {
    const { fetchImpl } = scriptedFetch([
      { text: "<html>gateway hiccup</html>" },
      // Well-formed JSON in another shape (a chat-completions answer from a misconfigured recorded server).
      { json: { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } },
    ]);
    const result = await callMessages(makeEnv(), request(), fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: "retryable", reason: "gateway_bad_response" });
    const other = await callMessages(makeEnv(), request(), fetchImpl);
    expect(other).toMatchObject({ ok: false, kind: "retryable", reason: "gateway_bad_response" });
  });

  it("no key → no_key, and nothing is sent", async () => {
    const result = await callMessages(makeEnv({ AI_GATEWAY_API_KEY: undefined }), request(), failingFetch);
    expect(result).toEqual({ ok: false, kind: "no_key", reason: "no_key" });
    const empty = await callMessages(makeEnv({ AI_GATEWAY_API_KEY: "" }), request(), failingFetch);
    expect(empty).toMatchObject({ ok: false, kind: "no_key" });
  });
});

describe("callMessages — fixture mode (like the coach wake)", () => {
  it("without a loopback FIXTURE_MODEL_URL: a canned answer, no network — even with a key and a gateway URL", async () => {
    const env = makeEnv({ FIXTURE_MODE: "1", AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh/v1" });
    const result = await callMessages(env, request(), failingFetch);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stopReason).toBe("end_turn");
    expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/fixture mode/i) }]);
    expect(result.costMicros).toBe(0);

    const remote = makeEnv({ FIXTURE_MODE: "1", FIXTURE_MODEL_URL: "https://ai-gateway.vercel.sh/v1" });
    expect((await callMessages(remote, request(), failingFetch)).ok).toBe(true);
  });

  it("with a loopback FIXTURE_MODEL_URL: the recorded model's /messages, never the gateway", async () => {
    const env = makeEnv({
      FIXTURE_MODE: "1",
      FIXTURE_MODEL_URL: "http://127.0.0.1:8899",
      AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh/v1",
    });
    const { fetchImpl, calls } = scriptedFetch([{ json: messageJson() }]);
    const result = await callMessages(env, request(), fetchImpl);
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:8899/messages"]);

    // …and still not without a key, as the wake.
    const keyless = { ...env, AI_GATEWAY_API_KEY: undefined };
    expect(await callMessages(keyless, request(), failingFetch)).toMatchObject({ ok: false, kind: "no_key" });
  });
});

describe("callMessages — the streamed answer", () => {
  const STREAM: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        id: "msg_s",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1_200, cache_creation_input_tokens: 300, cache_read_input_tokens: 9_000, output_tokens: 1 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBCkgIBx==" } },
    { type: "content_block_stop", index: 0 },
    { type: "ping" },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking what " } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "fits today." } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_s", name: "search_library", input: {} } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"query": "hip m' } },
    { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: 'obility", "limit": 5}' } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_t", name: "validate_workout", input: {} } },
    { type: "content_block_stop", index: 3 },
    { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 640 } },
    { type: "message_stop" },
  ];

  it("assembles thinking (signature verbatim), text, and tool calls whose input arrives in pieces; usage merges start and delta", async () => {
    const { fetchImpl } = scriptedFetch([{ sse: STREAM }]);
    const result = await callMessages(makeEnv(), request(), fetchImpl);
    expect(result).toEqual({
      ok: true,
      model: DEFAULT_DESIGN_MODEL,
      content: [
        { type: "thinking", thinking: "", signature: "EqQBCkgIBx==" },
        { type: "text", text: "Checking what fits today." },
        { type: "tool_use", id: "toolu_s", name: "search_library", input: { query: "hip mobility", limit: 5 } },
        { type: "tool_use", id: "toolu_t", name: "validate_workout", input: {} },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 1_200, cacheReadTokens: 9_000, cacheWriteTokens: 300, outputTokens: 640 },
      costMicros: Math.ceil(1_200 * 4 + 9_000 * 0.2 + 300 * 5 + 640 * 20),
    });
  });

  it("a stream that ends before message_stop is retryable, not a partial answer", async () => {
    const { fetchImpl } = scriptedFetch([{ sse: STREAM.slice(0, 9) }]);
    const result = await callMessages(makeEnv(), request(), fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: "retryable", reason: "gateway_bad_response" });
  });

  it("an error event mid-stream is retryable", async () => {
    const { fetchImpl } = scriptedFetch([
      { sse: [...STREAM.slice(0, 5), { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }] },
    ]);
    const result = await callMessages(makeEnv(), request(), fetchImpl);
    expect(result).toMatchObject({ ok: false, kind: "retryable", reason: "stream_overloaded_error" });
  });

  it("a stream that goes silent is cut loose and retryable", async () => {
    vi.useFakeTimers();
    const { fetchImpl } = scriptedFetch([{ hangAfter: STREAM.slice(0, 3) }]);
    const pending = callMessages(makeEnv(), request(), fetchImpl);
    await vi.advanceTimersByTimeAsync(151_000);
    expect(await pending).toMatchObject({ ok: false, kind: "retryable", reason: "llm_timeout" });
  });
});
