import type { ZodError } from "zod";
import { and, desc, eq, gte } from "drizzle-orm";
import { activities, dailyHealth, llmUsage } from "@rg/database";
import {
  fingerprint,
  liftingPlanSchema,
  newId,
  nowInstant,
  type LiftingPlan,
  type PlanBrief,
  type StudioExercise,
  type StudioSession,
  type StudioWeek,
} from "@rg/domain";
import { fixtureModeEnabled, type Env } from "../env.js";
import { llmBudgetStatus } from "./llm.js";
import type { Db } from "./db.js";

/**
 * Plan Studio's two-tier LLM service (plan-studio-design §3).
 *
 * Structurally mirrors `llm.ts`: same Vercel AI Gateway transport, budget
 * gate BEFORE any call (reusing `llmBudgetStatus`/`LLM_BUDGET` from llm.ts —
 * literally the same thresholds, not a re-declared copy), the same
 * `llm_usage` row shape, a generous AbortController timeout, and never-throws
 * graceful degradation (every exported function's body is one big try/catch
 * that turns any escaping error into `{plan: null, reason: "llm_error"}`).
 *
 * Two entry points:
 *  - `generatePlan` — strong tier, a full `LiftingPlan` from a `PlanBrief`.
 *  - `editPlan` — cheap tier by default: the model returns a compact RFC-6902
 *    subset ops list, applied server-side by the pure `applyOps` below, then
 *    the WHOLE resulting plan is re-validated (never trust an LLM-authored
 *    patch to also police its own conformance). `major: true` skips ops
 *    entirely and asks the strong model for a full regenerate instead,
 *    sharing the same full-plan validate/retry path as `generatePlan`.
 *
 * TESTABILITY: unlike llm.ts, both entry points take an optional trailing
 * `fetchImpl` (defaulting to the global `fetch`) instead of calling `fetch`
 * directly. llm.ts itself has no tests to mirror the stubbing approach of —
 * grep confirms no test file in this repo exercises it — so this follows the
 * convention the codebase actually uses elsewhere for HTTP-calling code
 * under test: `services/coros-bridge/test/mock-coros-server.ts` returns a
 * `fetchImpl` that's dependency-injected into `CorosClient`, not a global
 * `fetch` stub (no test file in this repo uses `vi.fn()`/`vi.stubGlobal` at
 * all). The extra parameter is additive-only — every real caller omits it.
 */

export const DEFAULT_MODEL_STRONG = "anthropic/claude-opus-5";
const DEFAULT_MODEL_EDIT = "anthropic/claude-haiku-4.5";
const DEFAULT_GATEWAY = "https://ai-gateway.vercel.sh/v1";
// Opus-5-class models think adaptively before answering (uncontrollable on
// the gateway's chat-completions surface), so a large plan can legitimately
// take minutes. Never cut off a generation that is still making progress:
// Workers place no wall-clock limit on awaited subrequests while the client
// stays connected, and the browser fetch has no default timeout either.
const TIMEOUT_MS = 600_000;
// A live SSE stream delivers deltas continuously; total silence this long
// means the connection is wedged, not thinking. Enforced with a per-read
// race — an AbortController alone was live-verified NOT to cut loose an
// in-progress body read in workerd (a stuck generate hung 13+ minutes).
const STREAM_STALL_MS = 150_000;
// Pause before the single transient-failure retry in chatCompletion.
const RETRY_BACKOFF_MS = 1500;

/** One log line per rejected generation so `wrangler tail` shows WHY a
 * syntactically-successful LLM response was refused (zod paths, JSON parse,
 * truncation) — the raw content never reaches the client, so without this
 * the reason is invisible from the outside. */
function logValidationFailure(stage: string, content: string, detail: string): void {
  console.warn(
    JSON.stringify({
      level: "warn",
      msg: "studio: llm output rejected",
      stage,
      detail: detail.slice(0, 400),
      chars: content.length,
      head: content.slice(0, 200),
      tail: content.slice(-200),
    }),
  );
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

// Cost-estimate constants, same "safe over-estimate, the rolling budget caps
// the worst case regardless" reasoning as llm.ts's own. Opus-5-class pricing
// ($5 / $25 per 1M input/output tokens) and Haiku-4.5-class pricing (the
// exact figures llm.ts already uses: $1 / $5 per 1M) as of the current
// Anthropic price list.
const STRONG_INPUT_MICROS_PER_TOKEN = 5;
const STRONG_OUTPUT_MICROS_PER_TOKEN = 25;
const EDIT_INPUT_MICROS_PER_TOKEN = 1;
const EDIT_OUTPUT_MICROS_PER_TOKEN = 5;

// One flat, deliberately over-provisioned ceiling. A tight scaled cap was
// live-verified to truncate real plans (finish_reason "length" surfaced as
// output_truncated in the UI): on Opus-5-class models max_tokens covers any
// adaptive thinking PLUS the answer, and the per-session estimate ran low.
// The cap exists to never be hit — the largest possible plan (16 weeks × 6
// sessions, verbose exercises) plus thinking is well under half of this.
// Worst-case cost at $25/1M output is $1.60, still bounded by the $8 rolling
// weekly cutoff, and real generations bill only what they produce.
const MAX_OUTPUT_TOKENS_GENERATE = 64_000;

// An edit's ops list stays small regardless of plan size — it's a diff, not
// the whole plan — but the same never-truncate rule applies, and the cheap
// tier's $5/1M output price makes headroom effectively free.
const MAX_OUTPUT_TOKENS_EDIT = 16_000;

// The real COROS catalog is ~382 entries (spec §4); this only engages
// defensively if a larger catalog is ever synced. Capped, never silent.
const MAX_CATALOG_LINES = 400;

export interface CatalogEntry {
  id: string;
  name: string;
}

type ChatRole = "system" | "user" | "assistant";
interface ChatMessage {
  role: ChatRole;
  content: string;
}

// ─────────────────────────────────────────────────────────────────────────
// applyOps — pure RFC-6902 subset (add/replace/remove) patch application.
//
// CARRY-FORWARD (binding, from Task 4's brief): liftingPlanSchema is a
// ZodEffects (it has a top-level .refine for weeks.length === durationWeeks)
// — .shape/.extend/.partial are not available on it. So this module does NOT
// attempt schema-aware patch surgery; it mutates a plain deep-cloned JSON
// value with only generic object/array navigation, and the caller
// (editPlan) is responsible for the full `liftingPlanSchema.safeParse` after
// every application. That re-parse is the actual safety net for "is this
// still a valid plan" — applyOps's own job is narrower: never let a patch
// escape the plan's *shape* (prototype pollution, out-of-bounds indices,
// navigating through a scalar) regardless of what the resulting content
// turns out to validate as.
// ─────────────────────────────────────────────────────────────────────────

export interface PatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

export type ApplyOpsResult = { ok: true; plan: unknown } | { ok: false; error: string };

/** Prototype-pollution guard: `obj["__proto__"] = x` sets the prototype, not
 * an own property, even on a plain structuredClone'd object — so these are
 * rejected as *any* path segment, not just the final one. */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const VALID_PATCH_OPS = new Set(["add", "replace", "remove"]);

/**
 * `/brief` is immutable via ops — enforced here, not just asked for in the
 * prompt. Found exploitable in review: `{op:"replace", path:"/brief/equipment"}`
 * passes ops (no shape violation) and passes the schema (brief fields don't
 * participate in the weeks.length===durationWeeks refine), so nothing else
 * catches it. `request` is user-controlled free text reaching the cheap-tier
 * model, so a prompt-injected edit request rewriting `brief.constraints`
 * (safety-relevant: injuries/exclusions) is a real surface, not just a
 * hallucination risk — this closes it in code regardless of what the model
 * decides to emit. `name` is deliberately NOT included: renaming the plan is
 * a legitimate edit.
 */
const IMMUTABLE_ROOT_SEGMENT = "brief";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseArrayIndex(segment: string): number | null {
  // No leading zeros, no sign, no decimals — "01"/"-1"/"1.5" are all invalid
  // JSON-Pointer array indices, only "-" (append) is handled by the caller.
  if (!/^(0|[1-9]\d*)$/.test(segment)) return null;
  return Number(segment);
}

interface ParsedPath {
  segments: string[];
}

function parsePath(path: string): { ok: true; parsed: ParsedPath } | { ok: false; error: string } {
  if (typeof path !== "string" || path.length === 0 || path[0] !== "/") {
    return { ok: false, error: `invalid path: ${JSON.stringify(path)}` };
  }
  // "/weeks/0/reps".split("/") === ["", "weeks", "0", "reps"]; the leading
  // empty string is the split before the root slash, not a segment.
  const segments = path.split("/").slice(1);
  if (segments[0] === IMMUTABLE_ROOT_SEGMENT) {
    return { ok: false, error: `path escapes the plan shape: ${path} (brief is immutable via ops)` };
  }
  for (const seg of segments) {
    if (FORBIDDEN_SEGMENTS.has(seg)) {
      return { ok: false, error: `path escapes the plan shape: ${path}` };
    }
  }
  return { ok: true, parsed: { segments } };
}

interface ParsedPatchOp {
  op: "add" | "replace" | "remove";
  segments: string[];
  value: unknown;
  hasValue: boolean;
}

function parseOp(raw: unknown): { ok: true; op: ParsedPatchOp } | { ok: false; error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "each op must be an object" };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.op !== "string" || !VALID_PATCH_OPS.has(r.op)) {
    return { ok: false, error: `unknown op: ${JSON.stringify(r.op)}` };
  }
  if (typeof r.path !== "string") {
    return { ok: false, error: "op.path must be a string" };
  }
  const parsedPath = parsePath(r.path);
  if (!parsedPath.ok) return parsedPath;
  return {
    ok: true,
    op: {
      op: r.op as "add" | "replace" | "remove",
      segments: parsedPath.parsed.segments,
      value: r.value,
      hasValue: "value" in r,
    },
  };
}

/**
 * Walk every segment but the last, requiring each intermediate container to
 * already exist (no auto-vivification) — a path through a container that
 * doesn't exist, or through a scalar (string/number/bool/null), is exactly
 * "escaping the plan shape" and rejected. Returns the parent container and
 * the unparsed final segment; the caller (applyOne) interprets that segment
 * against the parent's concrete type (array index vs. object key).
 */
function navigateToParent(
  root: unknown,
  segments: string[],
): { ok: true; parent: unknown; lastSegment: string } | { ok: false; error: string } {
  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (Array.isArray(current)) {
      const idx = parseArrayIndex(seg);
      if (idx === null || idx < 0 || idx >= current.length) {
        return { ok: false, error: `out-of-bounds array index in path: ${seg}` };
      }
      current = current[idx];
    } else if (isPlainObject(current)) {
      if (!(seg in current)) {
        return { ok: false, error: `path segment not found: ${seg}` };
      }
      current = current[seg];
    } else {
      return { ok: false, error: `path escapes the plan shape at segment: ${seg}` };
    }
  }
  const lastSegment = segments[segments.length - 1]!;
  if (Array.isArray(current) || isPlainObject(current)) {
    return { ok: true, parent: current, lastSegment };
  }
  return { ok: false, error: "path escapes the plan shape: parent is not an object or array" };
}

function applyOne(root: unknown, op: ParsedPatchOp): { ok: true; value: unknown } | { ok: false; error: string } {
  const nav = navigateToParent(root, op.segments);
  if (!nav.ok) return nav;
  const { parent, lastSegment } = nav;

  if (Array.isArray(parent)) {
    if (op.op === "add") {
      if (!op.hasValue) return { ok: false, error: "add requires a value" };
      const idx = lastSegment === "-" ? parent.length : parseArrayIndex(lastSegment);
      if (idx === null || idx < 0 || idx > parent.length) {
        return { ok: false, error: `out-of-bounds array index in path: ${lastSegment}` };
      }
      parent.splice(idx, 0, op.value);
      return { ok: true, value: root };
    }
    const idx = parseArrayIndex(lastSegment);
    if (idx === null || idx < 0 || idx >= parent.length) {
      return { ok: false, error: `out-of-bounds array index in path: ${lastSegment}` };
    }
    if (op.op === "replace") {
      if (!op.hasValue) return { ok: false, error: "replace requires a value" };
      parent[idx] = op.value;
      return { ok: true, value: root };
    }
    parent.splice(idx, 1); // remove
    return { ok: true, value: root };
  }

  if (isPlainObject(parent)) {
    if (FORBIDDEN_SEGMENTS.has(lastSegment)) {
      return { ok: false, error: `path escapes the plan shape: ${lastSegment}` };
    }
    if (op.op === "add") {
      if (!op.hasValue) return { ok: false, error: "add requires a value" };
      parent[lastSegment] = op.value;
      return { ok: true, value: root };
    }
    if (!(lastSegment in parent)) {
      return { ok: false, error: `path not found: ${lastSegment}` };
    }
    if (op.op === "replace") {
      if (!op.hasValue) return { ok: false, error: "replace requires a value" };
      parent[lastSegment] = op.value;
      return { ok: true, value: root };
    }
    delete parent[lastSegment]; // remove
    return { ok: true, value: root };
  }

  return { ok: false, error: "path escapes the plan shape" };
}

/**
 * Applies a raw (untrusted, LLM-authored) ops array to a deep clone of
 * `plan`, purely and without ever throwing. The result is NOT guaranteed to
 * still satisfy `liftingPlanSchema` — the caller must re-parse it (unknown
 * fields, wrong types, and a `weeks.length` that no longer matches
 * `brief.durationWeeks` all pass applyOps and are only caught there).
 */
export function applyOps(plan: LiftingPlan, ops: unknown): ApplyOpsResult {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, error: "ops must be a non-empty array" };
  }
  let working: unknown;
  try {
    working = structuredClone(plan);
  } catch {
    working = JSON.parse(JSON.stringify(plan));
  }
  for (const raw of ops) {
    const parsed = parseOp(raw);
    if (!parsed.ok) return parsed;
    const applied = applyOne(working, parsed.op);
    if (!applied.ok) return applied;
    working = applied.value;
  }
  return { ok: true, plan: working };
}

// ─────────────────────────────────────────────────────────────────────────
// Prompts — stable-prefix-first: system = role + hard rules + catalog lines
// (identical across many calls sharing a catalog), user = the volatile
// brief/plan/request JSON, always last. Pure functions of their inputs, so
// they're independently testable for determinism.
// ─────────────────────────────────────────────────────────────────────────

function catalogLines(catalog: CatalogEntry[]): string {
  const capped = catalog.slice(0, MAX_CATALOG_LINES);
  const lines = capped.map((c) => `${c.id}|${c.name}`).join("\n");
  const notice =
    catalog.length > MAX_CATALOG_LINES
      ? `\n(catalog truncated to ${MAX_CATALOG_LINES} of ${catalog.length} entries)`
      : "";
  return lines + notice;
}

const PLAN_JSON_SHAPE =
  '{"name": string, "brief": <object>, "weeks": [{"sessions": [{"title": string, "weekday": 1-7, ' +
  '"exercises": [{"originId": string, "name": string, "sets": int, "reps": int, ' +
  '"weight": {"type":"bodyweight"} | {"type":"kg","value": number}, "restSeconds": int, "note"?: string}]}]}]}';

const PLAN_HARD_RULES = [
  "- weeks.length MUST equal brief.durationWeeks exactly.",
  "- Every week's sessions.length must equal brief.sessionsPerWeek and must never exceed 6; every session's weekday must be one of brief.preferredDays.",
  "- Every session needs at least one exercise.",
  "- Every exercise's originId MUST be one of the ids listed in the catalog below, copied exactly; its name must be that catalog entry's name.",
  "- Respect brief.constraints (injuries/exclusions) and brief.equipment. Apply sensible progressive overload across weeks. Never schedule two sessions on the same weekday.",
  "- Ranges: sets 1-10, reps 1-50, restSeconds 0-900, weight.value (kg) 0-500.",
  "- Session titles and the plan name must each be 80 characters or fewer.",
].join("\n");

export function buildGenerateSystemPrompt(catalog: CatalogEntry[]): string {
  return [
    "You are a certified strength coach who writes structured lifting plans as pure JSON.",
    "Hard rules:",
    `- Reply with ONLY a JSON object of this shape and nothing else — no prose, no markdown fences:\n  ${PLAN_JSON_SHAPE}`,
    PLAN_HARD_RULES,
    "",
    "Available exercises (originId|name), one per line:",
    catalogLines(catalog),
  ].join("\n");
}

export function buildGenerateUserPrompt(brief: PlanBrief, athleteContext?: string): string {
  const base = `Brief (JSON):\n${JSON.stringify(brief, null, 2)}`;
  return athleteContext ? `${base}\n\n${athleteContext}` : base;
}

/**
 * Compact, read-only telemetry from the athlete's own synced COROS data —
 * recent load, recovery markers, and what they've actually been doing — so
 * the plan is calibrated to the real person, not a hypothetical one.
 * Best-effort: any failure returns "" and generation proceeds without it.
 */
export async function buildAthleteContext(db: Db, userId: string): Promise<string> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const since14 = addDaysLocal(today, -14);
    const since28 = addDaysLocal(today, -28);

    const health = await db
      .select()
      .from(dailyHealth)
      .where(and(eq(dailyHealth.userId, userId), gte(dailyHealth.date, since14)))
      .orderBy(desc(dailyHealth.date))
      .limit(14);
    const acts = await db
      .select({
        sport: activities.sport,
        durationSeconds: activities.durationSeconds,
        distanceMeters: activities.distanceMeters,
        startTime: activities.startTime,
      })
      .from(activities)
      .where(and(eq(activities.userId, userId), gte(activities.startTime, `${since28}T00:00:00Z`)));

    const lines: string[] = [];
    const avg = (xs: number[]) =>
      xs.length > 0 ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
    const rhr = avg(health.map((h) => h.restingHeartRate).filter((v): v is number => v != null));
    const hrv = avg(health.map((h) => h.hrv).filter((v): v is number => v != null));
    const load = health.find((h) => h.trainingLoad7d != null)?.trainingLoad7d;
    if (rhr != null) lines.push(`- Resting heart rate (14-day avg): ${rhr} bpm`);
    if (hrv != null) lines.push(`- Sleep HRV (14-day avg): ${hrv} ms`);
    if (load != null) lines.push(`- COROS 7-day training load: ${Math.round(load)}`);

    const runs = acts.filter((a) => a.sport === "run");
    if (runs.length > 0) {
      const km = runs.reduce((a, r) => a + (r.distanceMeters ?? 0), 0) / 1000;
      const hours = runs.reduce((a, r) => a + r.durationSeconds, 0) / 3600;
      lines.push(
        `- Running, last 28 days: ${runs.length} runs, ${km.toFixed(0)} km, ${hours.toFixed(1)} h — this training continues alongside the lifting plan`,
      );
    }
    const lifts = acts.filter((a) => a.sport === "strength").length;
    const yogas = acts.filter((a) => a.sport === "yoga").length;
    if (lifts > 0) lines.push(`- Strength sessions, last 28 days: ${lifts}`);
    if (yogas > 0) lines.push(`- Yoga sessions, last 28 days: ${yogas}`);

    if (lines.length === 0) return "";
    return [
      "Athlete telemetry (read-only, from their synced COROS account — use it to calibrate volume and intensity; the brief always wins on explicit preferences):",
      ...lines,
    ].join("\n");
  } catch {
    return "";
  }
}

/** Local-date arithmetic without pulling the whole domain package in here. */
function addDaysLocal(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function buildMajorReviseSystemPrompt(catalog: CatalogEntry[]): string {
  return [
    "You are a certified strength coach who revises an existing structured lifting plan as pure JSON.",
    "You will be given the CURRENT plan and a plain-English revision request. Produce a complete, revised plan.",
    "Hard rules:",
    `- Reply with ONLY the complete revised plan as a JSON object of this shape and nothing else — no prose, no markdown fences:\n  ${PLAN_JSON_SHAPE}`,
    "- Copy brief verbatim from the current plan unless the request explicitly asks to change duration, sessions per week, or days — in that case weeks.length must still equal the (possibly new) brief.durationWeeks exactly.",
    PLAN_HARD_RULES,
    "",
    "Available exercises (originId|name), one per line:",
    catalogLines(catalog),
  ].join("\n");
}

export function buildMajorReviseUserPrompt(
  plan: LiftingPlan,
  request: string,
  athleteContext?: string,
): string {
  const base = `Current plan (JSON):\n${JSON.stringify(plan, null, 2)}\n\nRevision request:\n${request}`;
  return athleteContext ? `${base}\n\n${athleteContext}` : base;
}

export function buildEditSystemPrompt(catalog: CatalogEntry[]): string {
  return [
    "You are a lifting-plan editor. You receive the CURRENT plan and a plain-English edit request, and reply with",
    "a compact list of patch operations to apply to it — never the whole plan.",
    "Hard rules:",
    '- Reply with ONLY a JSON object of the form {"ops": [{"op": "add"|"replace"|"remove", "path": string, "value"?: <json>}]} and nothing else.',
    "- path is a JSON Pointer into the CURRENT plan, e.g. /weeks/0/sessions/1/exercises/2/reps. Array indices are 0-based; use \"-\" as the final segment to append to an array.",
    '- "add" and "replace" require value; "remove" must not include value.',
    "- Never touch /brief. Only touch /name if the request explicitly asks to rename the plan.",
    "- Any exercise originId you add or change MUST be one of the ids listed in the catalog below, copied exactly, with name kept in sync.",
    "- Keep the number of operations minimal — only the fields the request actually changes.",
    "- Ranges: sets 1-10, reps 1-50, restSeconds 0-900, weight.value (kg) 0-500.",
    "- A week must never end up with more than 6 sessions. Session titles and the plan name must each be 80 characters or fewer.",
    "",
    "Available exercises (originId|name), one per line:",
    catalogLines(catalog),
  ].join("\n");
}

export function buildEditUserPrompt(plan: LiftingPlan, request: string): string {
  return `Current plan (JSON):\n${JSON.stringify(plan, null, 2)}\n\nEdit request:\n${request}`;
}

function feedbackMessage(feedback: string): string {
  return (
    `Your previous output was invalid: ${feedback}\n\n` +
    "Return corrected output that fixes exactly this problem. Reply with ONLY the JSON object and nothing else."
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Gateway transport — same shape as llm.ts's inline fetch (OpenAI-compatible
// chat completions, generous AbortController timeout), factored into a
// helper because both entry points may call it twice (the one
// feedback-retry). Transient gateway failures get one automatic in-place
// retry here, below the feedback-retry layer.
//
// Prompt-cache passthrough: investigated per spec §3 ("try it once, don't
// invent wire fields if you can't verify one"). llm.ts — the only other
// gateway caller in this codebase — sends no cache-control-shaped field or
// header, and nothing in this repo documents one for the Vercel AI Gateway's
// OpenAI-compatible endpoint. Not implemented; left as a documented gap
// rather than a guess. The load-bearing efficiency measure is the
// stable-prefix-first message ordering above, per spec.
// ─────────────────────────────────────────────────────────────────────────

export async function chatCompletion(
  env: Env,
  fetchImpl: typeof fetch,
  model: string,
  maxTokens: number,
  messages: ChatMessage[],
): Promise<
  | { ok: true; content: string; inputTokens: number; outputTokens: number; truncated: boolean }
  | { ok: false; reason: string }
> {
  // One bounded in-place retry on transient failures (rate limits, 5xx,
  // dropped connections). Deterministic failures are returned immediately:
  // a non-retryable 4xx won't change on a resend, and our own timeout abort
  // has already spent the full patience budget.
  const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
  let lastFailure: { ok: false; reason: string } = { ok: false, reason: "llm_error" };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetchImpl(`${env.AI_GATEWAY_BASE_URL || DEFAULT_GATEWAY}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages,
            // Streaming is load-bearing, not cosmetic: a buffered completion
            // must finish inside the gateway's own response window, and a
            // large plan on an Opus-5-class model takes minutes — the
            // non-streaming form was live-verified to die as a gateway 524.
            // With SSE the bytes flow as they're generated, nothing times
            // out, and this worker just assembles the full text below.
            stream: true,
            // No response_format: the Vercel AI Gateway's chat-completions
            // surface only supports json_schema / legacy json — the OpenAI
            // json_object mode is rejected with a 400 (live-verified: both
            // this service and llm.ts failed every call with gateway_400
            // until it was removed). Prompts demand JSON-only and
            // extractJson tolerates prose/fences; zod validation + the
            // feedback-retry loop catch the rest.
          }),
        });
      } catch {
        lastFailure = { ok: false, reason: "llm_error" };
        if (controller.signal.aborted) return lastFailure;
        continue;
      }
      if (!response.ok) {
        // Surface the gateway's own error message in `wrangler tail` — a
        // bare status code turned out to be undebuggable from the outside.
        const detail = await response.text().catch(() => "");
        console.warn(
          JSON.stringify({
            level: "warn",
            msg: "studio: ai gateway error",
            status: response.status,
            model,
            attempt,
            detail: detail.slice(0, 600),
          }),
        );
        lastFailure = { ok: false, reason: `gateway_${response.status}` };
        if (RETRYABLE_STATUSES.has(response.status)) continue;
        return lastFailure;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream") && response.body) {
        // SSE accumulation. `data:` lines carry OpenAI-compatible chunk
        // objects; content arrives as choices[0].delta.content pieces and
        // finish_reason/usage ride the final chunks. The AbortController
        // above still bounds the whole read.
        let content = "";
        let finishReason: string | undefined;
        let inputTokens = 0;
        let outputTokens = 0;
        const startedAt = Date.now();
        let chunks = 0;
        let stalled = false;
        const reader = response.body.getReader();
        try {
          const decoder = new TextDecoder();
          let buffered = "";
          for (;;) {
            const elapsed = Date.now() - startedAt;
            const next = await withTimeout(
              reader.read(),
              Math.max(1000, Math.min(STREAM_STALL_MS, TIMEOUT_MS - elapsed)),
            );
            if (next === "timed_out") {
              stalled = true;
              await reader.cancel().catch(() => undefined);
              break;
            }
            const { done, value } = next;
            if (done) break;
            chunks += 1;
            if (chunks === 1) {
              console.warn(
                JSON.stringify({ level: "info", msg: "studio: llm stream first byte", model, ms: elapsed }),
              );
            }
            buffered += decoder.decode(value, { stream: true });
            let newline: number;
            while ((newline = buffered.indexOf("\n")) >= 0) {
              const line = buffered.slice(0, newline).trim();
              buffered = buffered.slice(newline + 1);
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") continue;
              let chunk: {
                choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };
              try {
                chunk = JSON.parse(data) as typeof chunk;
              } catch {
                continue; // partial or non-JSON keepalive line
              }
              const choice = chunk.choices?.[0];
              if (choice?.delta?.content) content += choice.delta.content;
              if (choice?.finish_reason) finishReason = choice.finish_reason;
              if (chunk.usage) {
                inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
                outputTokens = chunk.usage.completion_tokens ?? outputTokens;
              }
            }
          }
        } catch {
          // Stream died mid-read (network blip or our timeout abort).
          lastFailure = { ok: false, reason: "llm_error" };
          if (controller.signal.aborted) return lastFailure;
          continue;
        }
        console.warn(
          JSON.stringify({
            level: "info",
            msg: "studio: llm stream done",
            model,
            ms: Date.now() - startedAt,
            chunks,
            chars: content.length,
            stalled,
            finishReason: finishReason ?? null,
          }),
        );
        if (stalled || content.length === 0) {
          lastFailure = { ok: false, reason: stalled ? "llm_error" : "gateway_bad_response" };
          continue;
        }
        // Budget accounting must never be the thing that breaks a working
        // generation: if the stream carried no usage chunk, over-estimate
        // at ~4 chars/token so the rolling cutoff still sees real spend.
        if (outputTokens === 0) outputTokens = Math.ceil(content.length / 4);
        if (inputTokens === 0) {
          inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
        }
        return { ok: true, content, inputTokens, outputTokens, truncated: finishReason === "length" };
      }

      // Non-streaming JSON body — kept as a fallback in case the gateway
      // ever answers a stream request with a plain completion.
      const body = (await response.json().catch(() => null)) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;
      if (!body) {
        lastFailure = { ok: false, reason: "gateway_bad_response" };
        continue;
      }
      return {
        ok: true,
        content: body.choices?.[0]?.message?.content ?? "",
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        // OpenAI-compatible convention: finish_reason "length" means the
        // response was cut off by max_tokens, not that the model finished.
        truncated: body.choices?.[0]?.finish_reason === "length",
      };
    } finally {
      clearTimeout(timer);
    }
  }
  return lastFailure;
}

/** Tolerates a fenced ```json block or leading/trailing prose, same as llm.ts. */
export function extractJson(raw: string): unknown | null {
  if (!raw) return null;
  try {
    const stripped = raw
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    const slice = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

function summarizeZodError(error: ZodError): string {
  const issues = error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  return issues.join("; ").slice(0, 800);
}

function findUnknownOriginId(plan: LiftingPlan, catalogIds: Set<string>): string | null {
  for (const week of plan.weeks) {
    for (const session of week.sessions) {
      for (const exercise of session.exercises) {
        if (!catalogIds.has(exercise.originId)) return exercise.originId;
      }
    }
  }
  return null;
}

/**
 * `llm_usage` row shape, byte-for-byte the same columns llm.ts writes
 * (no new discriminator column was added to the table — `kind` already
 * existed and just gained two new string values, see product.ts).
 */
export async function recordUsage(
  db: Db,
  userId: string,
  kind: "studio_generate" | "studio_edit" | "coach_wake" | "coach_analysis",
  model: string,
  tier: "strong" | "edit",
  chat: { inputTokens: number; outputTokens: number },
  requestFingerprint: string,
): Promise<void> {
  const inputMicros = tier === "strong" ? STRONG_INPUT_MICROS_PER_TOKEN : EDIT_INPUT_MICROS_PER_TOKEN;
  const outputMicros = tier === "strong" ? STRONG_OUTPUT_MICROS_PER_TOKEN : EDIT_OUTPUT_MICROS_PER_TOKEN;
  const costMicros = Math.ceil(chat.inputTokens * inputMicros + chat.outputTokens * outputMicros);
  await db.insert(llmUsage).values({
    id: newId(),
    userId,
    kind,
    model,
    inputTokens: chat.inputTokens,
    outputTokens: chat.outputTokens,
    costMicros,
    cacheHit: false,
    requestFingerprint,
    createdAt: nowInstant(),
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Attempt runners — one gateway round trip, validated. Shared by both the
// first try and the single feedback-retry.
// ─────────────────────────────────────────────────────────────────────────

type AttemptResult =
  | { kind: "success"; plan: LiftingPlan }
  | { kind: "transport_failure"; reason: string }
  | { kind: "validation_failure"; reason: string; feedback: string; rawContent: string };

/** Used by generatePlan and by editPlan's major:true (full-regenerate) path — both produce a complete plan. */
async function runFullPlanAttempt(
  env: Env,
  db: Db,
  userId: string,
  model: string,
  messages: ChatMessage[],
  catalogIds: Set<string>,
  usageKind: "studio_generate" | "studio_edit",
  requestFingerprint: string,
  fetchImpl: typeof fetch,
  maxTokens: number,
): Promise<AttemptResult> {
  const chat = await chatCompletion(env, fetchImpl, model, maxTokens, messages);
  if (!chat.ok) return { kind: "transport_failure", reason: chat.reason };
  await recordUsage(db, userId, usageKind, model, "strong", chat, requestFingerprint);

  const parsed = extractJson(chat.content);
  if (parsed === null) {
    // A JSON-parse failure that also hit the token cap is a truncation, not a
    // hallucination — the route/UI can say something true ("try a shorter
    // plan" / "we'll widen the budget") instead of a generic invalid-output
    // message. Retrying with the SAME maxTokens rarely helps on its own, but
    // the feedback text below asks the model to be more compact, which does.
    logValidationFailure("json_parse", chat.content, chat.truncated ? "truncated" : "not JSON");
    if (chat.truncated) {
      return {
        kind: "validation_failure",
        reason: "output_truncated",
        feedback:
          "output was truncated before it finished (hit the token limit) and could not be parsed as JSON. " +
          "Reply with the same plan but more compactly — shorter titles/notes, no extra fields — so it fits.",
        rawContent: chat.content,
      };
    }
    return { kind: "validation_failure", reason: "invalid_output", feedback: "output was not valid JSON.", rawContent: chat.content };
  }
  const result = liftingPlanSchema.safeParse(parsed);
  if (!result.success) {
    logValidationFailure("schema", chat.content, summarizeZodError(result.error));
    return {
      kind: "validation_failure",
      reason: "invalid_output",
      feedback: summarizeZodError(result.error),
      rawContent: chat.content,
    };
  }
  const plan = result.data as LiftingPlan;
  const badId = findUnknownOriginId(plan, catalogIds);
  if (badId) {
    return {
      kind: "validation_failure",
      reason: "unknown_exercise",
      feedback: `originId ${badId} is not in the synced catalog.`,
      rawContent: chat.content,
    };
  }
  return { kind: "success", plan };
}

/** editPlan's default (non-major) path: ops → applyOps → full re-parse. */
async function runOpsEditAttempt(
  env: Env,
  db: Db,
  userId: string,
  model: string,
  messages: ChatMessage[],
  basePlan: LiftingPlan,
  catalogIds: Set<string>,
  requestFingerprint: string,
  fetchImpl: typeof fetch,
): Promise<AttemptResult> {
  const chat = await chatCompletion(env, fetchImpl, model, MAX_OUTPUT_TOKENS_EDIT, messages);
  if (!chat.ok) return { kind: "transport_failure", reason: chat.reason };
  await recordUsage(db, userId, "studio_edit", model, "edit", chat, requestFingerprint);

  const parsed = extractJson(chat.content) as { ops?: unknown } | null;
  if (parsed === null || !Array.isArray(parsed.ops)) {
    if (parsed === null && chat.truncated) {
      return {
        kind: "validation_failure",
        reason: "output_truncated",
        feedback:
          "output was truncated before it finished (hit the token limit) and could not be parsed as JSON. " +
          'Reply with a shorter ops list — fewer operations, or a more compact "value" — so it fits.',
        rawContent: chat.content,
      };
    }
    return {
      kind: "validation_failure",
      reason: "invalid_output",
      feedback: 'output must be a JSON object of the form {"ops": [...]}.',
      rawContent: chat.content,
    };
  }
  const applied = applyOps(basePlan, parsed.ops);
  if (!applied.ok) {
    return { kind: "validation_failure", reason: "invalid_ops", feedback: applied.error, rawContent: chat.content };
  }
  const result = liftingPlanSchema.safeParse(applied.plan);
  if (!result.success) {
    return {
      kind: "validation_failure",
      reason: "invalid_output",
      feedback: summarizeZodError(result.error),
      rawContent: chat.content,
    };
  }
  const plan = result.data as LiftingPlan;
  const badId = findUnknownOriginId(plan, catalogIds);
  if (badId) {
    return {
      kind: "validation_failure",
      reason: "unknown_exercise",
      feedback: `originId ${badId} is not in the synced catalog.`,
      rawContent: chat.content,
    };
  }
  return { kind: "success", plan };
}

// ─────────────────────────────────────────────────────────────────────────
// Fixture mode — deterministic, no gateway call, no usage row (spec §8).
// ─────────────────────────────────────────────────────────────────────────

const FIXTURE_WEEKS = 2;
const FIXTURE_SESSION_TITLES = ["Full Body A", "Full Body B", "Full Body C"];
const FIXTURE_WEEKDAYS = [1, 3, 5]; // Mon, Wed, Fri
const FIXTURE_EXERCISES_PER_SESSION = 3;

function pickFixtureExercises(catalog: CatalogEntry[], dayIndex: number): StudioExercise[] {
  const count = Math.min(FIXTURE_EXERCISES_PER_SESSION, catalog.length);
  const out: StudioExercise[] = [];
  for (let i = 0; i < count; i++) {
    const entry = catalog[(dayIndex * FIXTURE_EXERCISES_PER_SESSION + i) % catalog.length]!;
    out.push({
      originId: entry.id,
      name: entry.name,
      sets: 3,
      reps: 10,
      weight: { type: "bodyweight" },
      restSeconds: 60,
    });
  }
  return out;
}

/**
 * A deterministic 2-week / 3-day (Mon/Wed/Fri) full-body split built from
 * whatever catalog the caller passes — real fixture catalog ids in practice
 * (worker fixtures seed a small `coros_exercises` set; see fixtures.ts).
 * `null` on an empty catalog: there is nothing honest to build, and there is
 * no LLM to feed back to in fixture mode, so the caller surfaces `no_catalog`.
 *
 * Deliberately ignores most of `brief` (duration/sessions/days are fixed by
 * the template) but keeps its own `brief` internally consistent — the
 * `weeks.length === brief.durationWeeks` and `preferredDays.length ===
 * sessionsPerWeek` invariants are both zod-enforced (studio.ts), so a canned
 * plan whose brief just echoed the caller's arbitrary durationWeeks would
 * fail its own validation the moment weeks.length disagreed with it.
 */
function buildFixturePlan(brief: PlanBrief, catalog: CatalogEntry[]): LiftingPlan | null {
  if (catalog.length === 0) return null;
  const fixtureBrief: PlanBrief = {
    ...brief,
    durationWeeks: FIXTURE_WEEKS,
    sessionsPerWeek: FIXTURE_SESSION_TITLES.length,
    preferredDays: FIXTURE_WEEKDAYS,
  };
  const weeks: StudioWeek[] = [];
  for (let w = 0; w < FIXTURE_WEEKS; w++) {
    const sessions: StudioSession[] = FIXTURE_SESSION_TITLES.map((title, dayIndex) => ({
      title,
      weekday: FIXTURE_WEEKDAYS[dayIndex]!,
      exercises: pickFixtureExercises(catalog, dayIndex),
    }));
    weeks.push({ sessions });
  }
  return { name: `${FIXTURE_WEEKS}-Week Fixture Plan`, brief: fixtureBrief, weeks };
}

// ─────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────

/** Strong-tier: generates a complete `LiftingPlan` from a `PlanBrief`. */
export async function generatePlan(
  env: Env,
  db: Db,
  userId: string,
  brief: PlanBrief,
  catalog: CatalogEntry[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ plan: LiftingPlan | null; reason?: string }> {
  try {
    if (fixtureModeEnabled(env)) {
      const plan = buildFixturePlan(brief, catalog);
      return plan ? { plan } : { plan: null, reason: "no_catalog" };
    }
    if (!env.AI_GATEWAY_API_KEY) return { plan: null, reason: "no_api_key" };
    const budget = await llmBudgetStatus(db, userId);
    if (budget.cutoff) return { plan: null, reason: "budget_cutoff" };

    const model = env.AI_STUDIO_MODEL_STRONG || DEFAULT_MODEL_STRONG;
    const catalogIds = new Set(catalog.map((c) => c.id));
    const requestFingerprint = fingerprint({ brief, catalogSize: catalog.length });
    const maxTokens = MAX_OUTPUT_TOKENS_GENERATE;
    const athlete = await buildAthleteContext(db, userId);
    const messages: ChatMessage[] = [
      { role: "system", content: buildGenerateSystemPrompt(catalog) },
      { role: "user", content: buildGenerateUserPrompt(brief, athlete) },
    ];

    let attempt = await runFullPlanAttempt(
      env, db, userId, model, messages, catalogIds, "studio_generate", requestFingerprint, fetchImpl, maxTokens,
    );
    if (attempt.kind === "validation_failure") {
      messages.push({ role: "assistant", content: attempt.rawContent });
      messages.push({ role: "user", content: feedbackMessage(attempt.feedback) });
      attempt = await runFullPlanAttempt(
        env, db, userId, model, messages, catalogIds, "studio_generate", requestFingerprint, fetchImpl, maxTokens,
      );
    }
    if (attempt.kind === "success") return { plan: attempt.plan };
    return { plan: null, reason: attempt.reason };
  } catch {
    return { plan: null, reason: "llm_error" };
  }
}

/**
 * Cheap-tier by default: applies a plain-English `request` to `plan` via a
 * server-applied ops patch. `major: true` routes to the strong model for a
 * full regenerate (current plan + request as context) instead.
 *
 * DEVIATION FROM THE BRIEF'S ONE-LINE SIGNATURE: the task brief sketches
 * `editPlan(env, db, userId, plan, request, major)` with no catalog
 * parameter. Added anyway, on the reasoning's own merits (not a citation to
 * any brief/spec section): an ops-based edit can add or change an exercise's
 * originId exactly as freely as a full generate can, so an originId
 * validation requirement has to apply here too for the guarantee to mean
 * anything — and that isn't possible to implement without a catalog to check
 * against. `catalog` is added as a trailing parameter for this reason;
 * every other part of the signature is unchanged.
 */
export async function editPlan(
  env: Env,
  db: Db,
  userId: string,
  plan: LiftingPlan,
  request: string,
  major: boolean,
  catalog: CatalogEntry[],
  fetchImpl: typeof fetch = fetch,
): Promise<{ plan: LiftingPlan | null; reason?: string }> {
  try {
    if (fixtureModeEnabled(env)) {
      // Deterministic and testable, per spec §8 — the request/major/catalog
      // are deliberately ignored; no gateway call, no usage row.
      return { plan: { ...plan, name: `${plan.name} (edited)` } };
    }
    if (!env.AI_GATEWAY_API_KEY) return { plan: null, reason: "no_api_key" };
    const budget = await llmBudgetStatus(db, userId);
    if (budget.cutoff) return { plan: null, reason: "budget_cutoff" };

    const catalogIds = new Set(catalog.map((c) => c.id));
    const requestFingerprint = fingerprint({ planName: plan.name, request, major });

    if (major) {
      const model = env.AI_STUDIO_MODEL_STRONG || DEFAULT_MODEL_STRONG;
      const maxTokens = MAX_OUTPUT_TOKENS_GENERATE;
      const athlete = await buildAthleteContext(db, userId);
      const messages: ChatMessage[] = [
        { role: "system", content: buildMajorReviseSystemPrompt(catalog) },
        { role: "user", content: buildMajorReviseUserPrompt(plan, request, athlete) },
      ];
      let attempt = await runFullPlanAttempt(
        env, db, userId, model, messages, catalogIds, "studio_edit", requestFingerprint, fetchImpl, maxTokens,
      );
      if (attempt.kind === "validation_failure") {
        messages.push({ role: "assistant", content: attempt.rawContent });
        messages.push({ role: "user", content: feedbackMessage(attempt.feedback) });
        attempt = await runFullPlanAttempt(
          env, db, userId, model, messages, catalogIds, "studio_edit", requestFingerprint, fetchImpl, maxTokens,
        );
      }
      if (attempt.kind === "success") return { plan: attempt.plan };
      return { plan: null, reason: attempt.reason };
    }

    const model = env.AI_STUDIO_MODEL_EDIT || DEFAULT_MODEL_EDIT;
    const messages: ChatMessage[] = [
      { role: "system", content: buildEditSystemPrompt(catalog) },
      { role: "user", content: buildEditUserPrompt(plan, request) },
    ];
    let attempt = await runOpsEditAttempt(
      env, db, userId, model, messages, plan, catalogIds, requestFingerprint, fetchImpl,
    );
    if (attempt.kind === "validation_failure") {
      messages.push({ role: "assistant", content: attempt.rawContent });
      messages.push({ role: "user", content: feedbackMessage(attempt.feedback) });
      attempt = await runOpsEditAttempt(
        env, db, userId, model, messages, plan, catalogIds, requestFingerprint, fetchImpl,
      );
    }
    if (attempt.kind === "success") return { plan: attempt.plan };
    return { plan: null, reason: attempt.reason };
  } catch {
    return { plan: null, reason: "llm_error" };
  }
}
