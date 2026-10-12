#!/usr/bin/env node
/**
 * The free schema probe for the coach designer's model (Stage 3 spec §2; llm-messages.ts).
 *
 *   node apps/worker/scripts/probe-gateway-model.mjs [--model anthropic/claude-opus-5.5] [--base https://ai-gateway.vercel.sh/v1]
 *
 * Costs nothing and holds no secret: it never reads AI_GATEWAY_API_KEY, and every POST carries the junk key below.
 *
 *   1. The model: `GET {base}/models` is public. Is the model listed, and at what prices? (The Messages endpoint does
 *      not check the model id before it authenticates — a made-up id also answers 401 — so the listing is the check.)
 *      Prints the row for llm-messages.ts's MODEL_PRICES, and the strongest Claude ids the gateway lists.
 *   2. The body: the gateway validates the body BEFORE it authenticates. Each probe posts one deliberately invalid
 *      value with the junk key: a 400 naming the field means the field is parsed; a 401 means it was dropped as
 *      unknown. A valid control body must answer 401 (well-formed, then refused for the key).
 *
 * Exit code 1 when the model is not listed or a field the client relies on is not parsed.
 */
import { parseArgs } from "node:util";

const JUNK_KEY = "sk-junk-schema-probe";

const { values } = parseArgs({
  options: {
    model: { type: "string", default: "anthropic/claude-opus-5.5" },
    base: { type: "string", default: "https://ai-gateway.vercel.sh/v1" },
  },
});
const { model, base } = values;

const usd = (perToken) => (perToken === undefined ? "?" : Number((Number(perToken) * 1_000_000).toFixed(6)));

let failed = false;

// ── 1. The model ─────────────────────────────────────────────────────────
const listing = await fetch(`${base}/models`);
const models = listing.ok ? ((await listing.json()).data ?? []) : [];
console.log(`GET ${base}/models → ${listing.status} (${models.length} models)`);
const row = models.find((m) => m.id === model);
if (!row) {
  failed = true;
  console.log(`  ✗ ${model} is not listed`);
} else {
  const p = row.pricing ?? {};
  console.log(`  ✓ ${model} is listed — USD per 1M tokens:`);
  console.log(
    `    "${model}": { input: ${usd(p.input)}, output: ${usd(p.output)}, cacheRead: ${usd(p.input_cache_read)}, cacheWrite: ${usd(p.input_cache_write)} },`,
  );
}
const claude = models
  .filter((m) => /^anthropic\/claude-(opus|fable|sonnet)-/.test(m.id) && !m.id.endsWith("-fast"))
  .map((m) => `${m.id} ($${usd(m.pricing?.input)} / $${usd(m.pricing?.output)})`);
console.log(`  Claude Opus / Fable / Sonnet ids listed: ${claude.join(", ")}`);

// ── 2. The body ──────────────────────────────────────────────────────────
const user = [{ role: "user", content: "hi" }];
const tool = { name: "t", description: "d", input_schema: { type: "object", properties: {} } };
const probes = [
  { name: "control: the client's request shape", expect: 401, body: {
    model, max_tokens: 8, stream: true, output_config: { effort: "high" },
    system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], tools: [tool], messages: user } },
  { name: "output_config.effort", expect: 400, body: { model, max_tokens: 8, output_config: { effort: "banana" }, messages: user } },
  { name: "system[].cache_control", expect: 400, body: {
    model, max_tokens: 8, system: [{ type: "text", text: "s", cache_control: { type: "banana" } }], messages: user } },
  { name: "tools[].cache_control", expect: 400, body: {
    model, max_tokens: 8, tools: [{ ...tool, cache_control: { type: "banana" } }], messages: user } },
  { name: "messages[].content[].cache_control", expect: 400, body: { model, max_tokens: 8, messages: [{ role: "user",
    content: [{ type: "tool_result", tool_use_id: "x", content: "r", cache_control: { type: "banana" } }] }] } },
  { name: "top-level cache_control", expect: 400, body: { model, max_tokens: 8, cache_control: { type: "banana" }, messages: user } },
  { name: "tool_choice", expect: 400, body: { model, max_tokens: 8, tools: [tool], tool_choice: { type: "banana" }, messages: user } },
  { name: "thinking", expect: 400, body: { model, max_tokens: 8, thinking: { type: "banana" }, messages: user } },
  { name: "stream", expect: 400, body: { model, max_tokens: 8, stream: "banana", messages: user } },
  { name: "(info) an unknown top-level field", expect: null, body: { model, max_tokens: 8, banana_field: 1, messages: user } },
  { name: "(info) a made-up model id", expect: null, body: { model: "anthropic/claude-not-a-model", max_tokens: 8, messages: user } },
];

console.log(`\nPOST ${base}/messages with a junk key (400 = parsed, 401 = dropped / well-formed):`);
for (const probe of probes) {
  const res = await fetch(`${base}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${JUNK_KEY}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(probe.body),
  });
  const text = await res.text();
  let message = text;
  try {
    message = JSON.parse(text).error?.message ?? text;
  } catch {
    // keep the raw text
  }
  const ok = probe.expect === null || probe.expect === res.status;
  if (!ok) failed = true;
  console.log(`  ${probe.expect === null ? "·" : ok ? "✓" : "✗"} ${probe.name} → ${res.status} ${String(message).slice(0, 140)}`);
}

process.exit(failed ? 1 : 0);
