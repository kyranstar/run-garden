/**
 * THE STREAM READER, CHEAPER AND THE SAME (the go-live CPU gate: design-cpu-bench.test.ts). A document turn arrives as
 * thousands of events, each read on its own, and the reader was most of such a step's CPU: a timer raced against
 * every read, and every event parsed whole. Now one stall watchdog serves the whole answer (re-armed only when it
 * fires), and a tool input's piece — the line `data: {"type":"content_block_delta","index":N,"delta":{"type":
 * "input_json_delta","partial_json":"…"}}`, most of a document turn — is read without parsing the event whole.
 *
 * Exactly equivalent: the reader as it was (`legacyReadStream`, frozen below as it stood at e2ff1b8) and the reader now
 * are fed the same bytes — recorded answers and randomized ones, split anywhere (mid-line, mid-event, mid-character of
 * multi-byte UTF-8), with escaped quotes, backslashes and unicode escapes in the pieces, odd spacing and line endings,
 * broken lines, unknown blocks, errors and streams that stop early — and must answer the same, to the byte. Their
 * stall and deadline timings are compared on a fake clock.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rng } from "@rg/session-engine";
import { readStream } from "../src/services/llm-messages.js";

// ── The reader as it was (frozen; e2ff1b8, llm-messages.ts) ────────────────────────────────────────────────────────

const TIMEOUT_MS = 600_000;
const STREAM_STALL_MS = 150_000;
type RawUsage = Record<string, unknown>;
type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal";
interface Answer {
  ok: true;
  content: unknown[];
  stopReason: StopReason | null;
  usage: RawUsage;
}
interface Cut {
  ok: false;
  cut: true;
  reason: string;
  usage: RawUsage;
  content: unknown[];
  outputReported: boolean;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const cutOff = (reason: string, usage: RawUsage = {}, content: unknown[] = [], outputReported = false): Cut => ({ ok: false, cut: true, reason, usage, content, outputReported });
function readWait(startedAt: number): number {
  return Math.max(1000, Math.min(STREAM_STALL_MS, TIMEOUT_MS - (Date.now() - startedAt)));
}
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
async function legacyReadStream(body: ReadableStream<Uint8Array>, startedAt: number, deadline: AbortSignal): Promise<Answer | Cut> {
  const reader = body.getReader();
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
      const next = await withTimeout(reader.read(), readWait(startedAt));
      if (next === "timed_out") {
        await reader.cancel().catch(() => undefined);
        return cutOff("llm_timeout", usage, sofar(), outputReported);
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
          continue;
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
                // cut off mid-input
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
    }
  } catch {
    return cutOff(deadline.aborted ? "llm_timeout" : "llm_error", usage, sofar(), outputReported);
  }
  if (!stopped && stopReason === null) return cutOff("gateway_bad_response", usage, sofar(), outputReported);
  return { ok: true, content: blocks.filter((b): b is Record<string, unknown> => !!b), stopReason, usage };
}

// ── Streams ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A body that hands over these chunks, one a read. */
function bodyOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

/** Both readers over the same bytes. */
async function both(chunks: readonly Uint8Array[]): Promise<{ now: unknown; before: unknown }> {
  const signal = new AbortController().signal;
  const before = await legacyReadStream(bodyOf(chunks), Date.now(), signal);
  const now = await readStream(bodyOf(chunks), Date.now(), signal);
  return { now, before };
}

const encoder = new TextEncoder();
const sse = (e: Record<string, unknown>): string => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`;

/** Split bytes at random places: lines, events and UTF-8 characters cut across reads. */
function split(bytes: Uint8Array, rng: () => number, max: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    const n = 1 + Math.floor(rng() * max);
    out.push(bytes.slice(at, at + n));
    at += n;
  }
  return out;
}

const WORDS = ['plain', 'a "quoted" word', "back\\slash", "tab\there", "new\nline", "café", "Straße", "東京", "😀", " ", "</script>", "\\u00e9", "\u0000", "\u001f", "end\\"];

function randomInput(rng: () => number, depth = 0): unknown {
  const pick = rng();
  if (depth > 2 || pick < 0.3) return WORDS[Math.floor(rng() * WORDS.length)]! + (rng() < 0.5 ? "" : String(Math.floor(rng() * 100)));
  if (pick < 0.4) return Math.round(rng() * 1000) / 10;
  if (pick < 0.45) return rng() < 0.5;
  if (pick < 0.7) return Array.from({ length: Math.floor(rng() * 4) }, () => randomInput(rng, depth + 1));
  const o: Record<string, unknown> = {};
  for (let k = 0; k < 1 + Math.floor(rng() * 4); k++) o[WORDS[Math.floor(rng() * WORDS.length)]!] = randomInput(rng, depth + 1);
  return o;
}

/** A piece of text, cut at random sizes. */
function piecesOf(text: string, rng: () => number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    const n = 1 + Math.floor(rng() * 24);
    out.push(text.slice(at, at + n));
    at += n;
  }
  return out;
}

/** Spell a data line differently: the JSON's own escapes swapped for \u escapes, odd spacing, CRLF, keys reordered. */
function respell(line: string, e: Record<string, unknown>, rng: () => number): string {
  const r = rng();
  if (r < 0.06) return `data:${JSON.stringify(e)}`; // no space
  if (r < 0.1) return `data:   ${JSON.stringify(e)}   `; // spaces both sides
  if (r < 0.14) return ` ${line}`; // leading space
  if (r < 0.2) return `${line}\r`; // CRLF
  if (r < 0.24) return `${line} `; // a trailing space
  if (r < 0.28) return `data: ${JSON.stringify(Object.fromEntries(Object.entries(e).reverse()))}`; // keys reordered
  if (r < 0.4) {
    // Characters of the piece spelled as \u escapes (and a surrogate pair as two), as another encoder might write them.
    return line.replace(/[^\x00-\x7f]|[a-z]/g, (ch) => (rng() < 0.3 ? `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}` : ch));
  }
  if (r < 0.44) return line.replace(/"index":(\d+)/, '"index":0$1'); // a leading zero: not JSON
  if (r < 0.47) return line.replace(/"partial_json":"/, '"partial_json":"\u0001'); // a raw control character: not JSON
  if (r < 0.5) return line.replace(/"partial_json":"/, '"partial_json":"\\x'); // a bad escape: not JSON
  if (r < 0.52) return line.replace(/"}}$/, '\\u12"}}'); // a cut \u escape: not JSON
  if (r < 0.54) return line.replace(/}}$/, '},"extra":1}'); // another key
  if (r < 0.56) return line.replace(/}}$/, "}}}"); // a stray brace
  if (r < 0.58) return line.replace(/"partial_json":"/, '"partial_json":"a"b'); // an unescaped quote inside
  if (r < 0.6) return line.replace(/"}}$/, '\\"}}'); // the closing quote escaped
  return line;
}

/** A randomized answer: thinking, text and tool calls, the inputs in pieces, with every oddity above now and then. */
function randomAnswer(rng: () => number): string {
  const lines: string[] = [];
  const push = (e: Record<string, unknown>) => {
    const line = `data: ${JSON.stringify(e)}`;
    lines.push(rng() < 0.2 ? "" : `event: ${String(e.type)}`);
    lines.push(rng() < 0.35 ? respell(line, e, rng) : line);
    lines.push("");
    if (rng() < 0.03) lines.push(rng() < 0.5 ? ": keepalive" : "data: {broken");
  };
  push({ type: "message_start", message: { id: "msg_r", usage: { input_tokens: Math.floor(rng() * 5000), cache_read_input_tokens: 100, output_tokens: 1 } } });
  const blocks = 1 + Math.floor(rng() * 5);
  for (let index = 0; index < blocks; index++) {
    const kind = rng();
    if (rng() < 0.05) push({ type: "content_block_delta", index: index + 7, delta: { type: "input_json_delta", partial_json: "{}" } }); // no such block
    if (kind < 0.2) {
      push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      for (const p of piecesOf(String(randomInput(rng)), rng)) push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: p } });
      push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "EqQBsig==" } });
    } else if (kind < 0.4) {
      push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const p of piecesOf(JSON.stringify(randomInput(rng)), rng)) push({ type: "content_block_delta", index, delta: { type: "text_delta", text: p } });
    } else {
      push({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${index}`, name: "validate_workout", input: {} } });
      if (rng() < 0.7) push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "" } });
      const json = JSON.stringify({ doc: randomInput(rng), note: randomInput(rng) });
      // Now and then cut off mid-input (a max_tokens answer).
      const cut = rng() < 0.08 ? json.slice(0, Math.floor(json.length * rng())) : json;
      for (const p of piecesOf(cut, rng)) push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: p } });
    }
    if (rng() < 0.03) push({ type: "ping" });
    push({ type: "content_block_stop", index });
  }
  if (rng() < 0.05) push({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
  if (rng() < 0.9) push({ type: "message_delta", delta: { stop_reason: rng() < 0.9 ? "tool_use" : "max_tokens", stop_sequence: null }, usage: { output_tokens: Math.floor(rng() * 9000) } });
  if (rng() < 0.9) push({ type: "message_stop" });
  return lines.join("\n") + (rng() < 0.5 ? "\n" : "");
}

/** A designer's document turn as the gateway streams it: thinking, words, and a whole document in 16-character pieces. */
function documentTurn(): string {
  const doc = {
    version: 1,
    title: 'Hips, upper back and a "calm" trunk — café edition 😀',
    intent: { summary: "Wakes the hips before any loading so the first working set feels smooth.\nThen the back.", goals: ["posture", "strength"], objectiveIds: ["obj-1"] },
    parts: Array.from({ length: 6 }, (_, i) => ({
      purpose: ["warmup", "activation", "main", "accessory", "care", "cooldown"][i],
      why: `Part ${i}: keeps the jaw soft; the trunk braces without clenching \\ holding the breath.`,
      items: Array.from({ length: 2 }, (__, k) => ({ kind: "exercise", libraryId: `move${i}${k}`, dose: { sets: 2, reps: 8, restSec: 45 }, cue: "Slow lowering — 3 s down, “no bounce”." })),
    })),
  };
  const events: Array<Record<string, unknown>> = [
    { type: "message_start", message: { id: "msg_doc", type: "message", role: "assistant", content: [], usage: { input_tokens: 1850, cache_creation_input_tokens: 2400, cache_read_input_tokens: 14_200, output_tokens: 1 } } },
    { type: "ping" },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBCkgIBx".repeat(200) } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    ...["Checking what ", "fits today — ", "and why."].map((text) => ({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text } })),
    { type: "content_block_stop", index: 1 },
  ];
  for (let index = 2; index < 6; index++) {
    events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${index}`, name: "validate_workout", input: {} } });
    events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: "" } });
    const json = JSON.stringify({ doc, date: "2026-10-16" });
    for (let at = 0; at < json.length; at += 16) events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(at, at + 16) } });
    events.push({ type: "content_block_stop", index });
  }
  events.push({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 13_000 } });
  events.push({ type: "message_stop" });
  return events.map(sse).join("");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the stream reader: the same answer as before, from the same bytes", () => {
  it("a recorded document turn, an event a read, in one read, and split every few bytes", async () => {
    const text = documentTurn();
    const bytes = encoder.encode(text);
    const rng = Rng.create("document-turn");
    for (const chunks of [text.split(/(?<=\n\n)/).map((e) => encoder.encode(e)), [bytes], split(bytes, rng, 7), split(bytes, rng, 300)]) {
      const { now, before } = await both(chunks);
      expect((before as Answer).ok).toBe(true);
      expect((before as Answer).content).toHaveLength(6);
      expect(now).toEqual(before);
    }
  });

  it("randomized answers — escapes, unicode escapes, multi-byte characters split across reads, odd lines and broken ones — answer the same", async () => {
    const rng = Rng.create("stream-differential");
    let fast = 0;
    for (let n = 0; n < 400; n++) {
      const text = randomAnswer(rng);
      fast += (text.match(/"input_json_delta","partial_json":"/g) ?? []).length;
      const bytes = encoder.encode(text);
      const chunks = rng() < 0.3 ? [bytes] : split(bytes, rng, rng() < 0.5 ? 5 : 80);
      const { now, before } = await both(chunks);
      expect(now, `answer ${n}: ${text.slice(0, 400)}`).toEqual(before);
    }
    // The fast path's own shape was met thousands of times (and its near misses, respelled, hundreds).
    expect(fast).toBeGreaterThan(2_000);
  });

  it("lines no fast path may take: each answers as the whole parse did", async () => {
    const start = sse({ type: "message_start", message: { usage: { input_tokens: 1 } } }) + sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: "n", input: {} } });
    const end = sse({ type: "content_block_stop", index: 0 }) + sse({ type: "message_stop" });
    const lines = [
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"a\\":"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\u0031\\ud83d\\ude00\\/\\b\\f\\n\\r\\t\\\\"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\u12"}}',
      'data: {"type":"content_block_delta","index":00,"delta":{"type":"input_json_delta","partial_json":"x"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"x"}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"x"}} ',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"x"},"type":"ping"}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"x" }}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"x\\"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"x"y"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}}',
      'data: {"type":"content_block_delta","index":1234567890123,"delta":{"type":"input_json_delta","partial_json":"x"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\t"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"1\\"}"}}\r',
      'data: {"type":"content_block_delta","index":,"delta":{"type":"input_json_delta","partial_json":"x"}}',
      // A piece that would make an input of its own, on a line that isn't JSON: never taken.
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"[1]"]}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"[1]" }',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"[1]"}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"[1]"}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"[1]"}}',
    ];
    for (const line of lines) {
      for (const tail of ["\n", "\r\n", "\n\n"]) {
        const text = `${start}${line}${tail}${end}`;
        const { now, before } = await both([encoder.encode(text)]);
        expect(now, line).toEqual(before);
        const { now: split1, before: split2 } = await both(split(encoder.encode(text), Rng.create(line), 3));
        expect(split1, line).toEqual(split2);
      }
    }
  });
});

describe("the stream reader does less work for the same answer", () => {
  it("one stall watchdog for the whole answer, not a timer a read", async () => {
    const chunks = documentTurn().split(/(?<=\n\n)/).map((e) => encoder.encode(e));
    const timers = vi.spyOn(globalThis, "setTimeout");
    const answer = await readStream(bodyOf(chunks), Date.now(), new AbortController().signal);
    expect((answer as Answer).ok).toBe(true);
    expect(chunks.length).toBeGreaterThan(500);
    expect(timers.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("a tool input's pieces are read without parsing their events whole — CRLF lines too", async () => {
    for (const text of [documentTurn(), documentTurn().replace(/\n/g, "\r\n")]) {
      const chunks = text.split(/(?<=\n\r?\n)/).map((e) => encoder.encode(e));
      const parse = vi.spyOn(JSON, "parse");
      const answer = await readStream(bodyOf(chunks), Date.now(), new AbortController().signal);
      expect((answer as Answer).ok).toBe(true);
      expect((answer as Answer).content).toHaveLength(6);
      const whole = parse.mock.calls.filter(([raw]) => typeof raw === "string" && raw.includes('"input_json_delta"'));
      expect(whole).toEqual([]);
      parse.mockRestore();
    }
  });
});

describe("the stall guard keeps its timing", () => {
  /** A body whose chunks arrive after these gaps (ms, on the fake clock); a gap of Infinity never arrives. */
  function slowBody(gaps: readonly number[], text: string): ReadableStream<Uint8Array> {
    const bytes = encoder.encode(text);
    const size = Math.ceil(bytes.length / (gaps.length + 1));
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i > gaps.length) {
          controller.close();
          return;
        }
        const chunk = bytes.slice(i * size, (i + 1) * size);
        const gap = i === 0 ? 0 : gaps[i - 1]!;
        i += 1;
        if (gap === 0) {
          controller.enqueue(chunk);
          return;
        }
        if (!Number.isFinite(gap)) return new Promise<void>(() => undefined);
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            controller.enqueue(chunk);
            resolve();
          }, gap),
        );
      },
    });
  }

  async function timed(read: typeof readStream, gaps: readonly number[]): Promise<{ result: unknown; tookMs: number }> {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-16T08:00:00Z"));
    const t0 = Date.now();
    let settledAt = -1;
    const pending = read(slowBody(gaps, documentTurn()), t0, new AbortController().signal).then((r) => {
      settledAt = Date.now();
      return r;
    });
    for (let k = 0; k < 2_000 && settledAt < 0; k++) await vi.advanceTimersByTimeAsync(500);
    expect(settledAt, "the read settled").toBeGreaterThanOrEqual(0);
    const result = await pending;
    vi.useRealTimers();
    return { result, tookMs: settledAt - t0 };
  }

  for (const [name, gaps] of [
    ["reads just inside the stall limit go on", [149_000, 149_000, 1_000]],
    ["a read past the stall limit is cut at it", [10_000, 150_500]],
    ["silence from the start is cut at the stall limit", [Infinity]],
    ["near the deadline a read waits only what is left of it", [140_000, 140_000, 140_000, 140_000, 50_000]],
    ["the last second: a read waits at least one", [140_000, 140_000, 140_000, 140_000, 39_500, 2_000]],
  ] as const) {
    it(name, async () => {
      const before = await timed(legacyReadStream as typeof readStream, gaps);
      const now = await timed(readStream, gaps);
      expect(now.result).toEqual(before.result);
      // The same instant, to the fake clock's step.
      expect(Math.abs(now.tookMs - before.tookMs)).toBeLessThanOrEqual(500);
    });
  }
});
