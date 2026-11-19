/**
 * THE PHONE'S VIEW OF THE COACH (R1 review A/MAJOR-1; the lead's v0.20 "structured results over raw transcripts"; the v4
 * grant's promise, "Never heart rate, pace, routes or health readings").
 *
 * The laptop's coach answers carry its working trail: what each tool read (readiness — heart-rate variability, resting heart
 * rate, sleep, stress —, the day's condition checks, the profile's conditions, the memory core), what it was asked, and the
 * coach's own words. A phone (`training-v5`) gets a structured, allowlisted projection of the same answers instead, built
 * here and applied to every coach answer a device reads (`deviceCoachView`, a response middleware on the coach routes):
 *
 *  - a run's trail: each event's kind, sequence, time and a line — a tool's own fixed line (`Read your readiness`), never
 *    what it read or was given; a payload of `tool`, `ok`, `missing`, a proposal's id, whether it is the run's last line,
 *    and a question's words and chips (readings stripped), or `check: "condition"` with nothing of the condition;
 *  - the coach's lines (a finish, an answer, a card's title and summary, a question's why) with every sentence that names a
 *    reading, a pace or a condition taken out (`stripReadings`);
 *  - nothing it never needs: tool inputs and results (`input`, `data`), refusals' fixes, documents, evidence, the account's
 *    id, provenance beyond a read's source;
 *  - a memory item as `{id, kind, body, confidence, pinned, expiresAt, learnedAt, source}` (A MINOR-1: never `userId` or the
 *    ids in its provenance) — memory is what the v5 grant lets the phone see and edit, so its words stay whole.
 *
 * The laptop's (cookie) answers are unchanged. Pinned by device-never-list.test.ts: readings, a condition and a memory-core
 * line planted where the coach reads them reach no v5 answer.
 */
import type { MiddlewareHandler } from "hono";
import { PROFILES } from "@rg/exercise-library";
import type { AppContext } from "../auth/middleware.js";

// ── Words ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Words that name a body reading, a pace, or the coach's view of either. */
const READING = /\b(hrv|heart[\s-]?rate|resting\s+hr|rhr|bpm|pulse|sleep\w*|slept|stress\w*|readiness|body\s+battery|spo2|vo2\s*max|blood\s+pressure|temperature|recovery\s+score|pace[sd]?|per\s+km|per\s+mile|min\/km|min\/mi|threshold)\b|\d\s*(ms|bpm)\b|\d+:\d{2}\s*\/\s*(km|mi)\b/i;

/** Each condition the library knows, by its id and label, and the words its checks use. */
const CONDITION_WORDS: readonly string[] = Object.entries(PROFILES).flatMap(([id, p]) => [id, (p as { label?: string }).label ?? id, ...(id === "tmj" ? ["jaw", "clench", "clenched", "clenching"] : [])]);
const CONDITION = new RegExp(`\\b(${[...new Set(CONDITION_WORDS.map((w) => w.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()).filter(Boolean))].join("|")}|flare\\w*|condition\\s+check\\w*|feeling\\s+off)\\b`, "i");

/** Whether a line names a reading, a pace or a condition. */
export const namesReading = (text: string): boolean => READING.test(text) || CONDITION.test(text);

/** A line with every sentence that names a reading, a pace or a condition taken out; null when nothing is left. */
export function stripReadings(text: string): string | null {
  const kept = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !namesReading(s));
  return kept.length > 0 ? kept.join(" ") : null;
}

// ── Events ───────────────────────────────────────────────────────────────────────────────────────────────────────

const EVENT_KINDS = new Set(["tool_call", "tool_result", "draft", "review", "revision", "question", "note", "error"]);

/** A tool's own line on the phone: what it did, never what it found. */
const TOOL_LINES: Readonly<Record<string, string>> = {
  read_readiness: "Read your readiness",
  read_day: "Read your day",
  read_profile: "Read your profile",
  recall_memory: "Recalled what it remembers",
  read_history: "Read your recent sessions",
  read_sessions: "Read your recent sessions",
  read_plan: "Read your plan",
  read_plans: "Read your plans",
  read_workouts: "Read your workouts",
  read_templates: "Read your saved workouts",
  read_library: "Looked through the library",
  search_library: "Looked through the library",
  read_balance: "Read your week's balance",
  read_objectives: "Read your goals",
  read_answers: "Read your answers",
  read_saves: "Read your saved posts",
  read_set: "Read the set",
  read_proposals: "Read its suggestions",
  propose_workout: "Drafted a workout",
  adjust_plan: "Suggested a change to your plan",
  plan_set: "Planned a set",
  remember: "Noted something to remember",
  ask_athlete: "Asked you",
  finish: "Finished",
};
const toolLine = (tool: unknown): string => (typeof tool === "string" && TOOL_LINES[tool]) || (typeof tool === "string" ? `Used ${tool.replace(/_/g, " ")}` : "Worked on it");

/** The fixed line of an event kind whose own words are all readings. */
const KIND_LINES: Readonly<Record<string, string>> = {
  draft: "Drafted a workout",
  review: "Reviewed the draft",
  revision: "Revised the draft",
  question: "The coach has a question.",
  note: "The coach is working on it.",
  error: "Something went wrong.",
};

const textOr = (v: unknown, fallback: string): string => (typeof v === "string" ? (stripReadings(v) ?? fallback) : fallback);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** A question event's words, as the phone shows them: each question's text, chips and why, readings stripped; a condition
 * check asked for as `check: "condition"` alone. */
function questionPayload(data: unknown): Record<string, unknown> {
  const d = obj(data);
  if (d?.check === "condition") return { check: "condition" };
  const qs = Array.isArray(d?.questions) ? (d!.questions as unknown[]) : [];
  return {
    questions: qs.map((raw) => {
      const q = obj(raw) ?? {};
      const chips = Array.isArray(q.chips) ? (q.chips as unknown[]) : [];
      return {
        text: textOr(q.text, "The coach has a question."),
        chips: chips.map((c) => (typeof c === "string" ? c : obj(c)?.label)).filter((l): l is string => typeof l === "string" && !namesReading(l)),
        why: typeof q.why === "string" ? stripReadings(q.why) : null,
      };
    }),
  };
}

/** One trail event as the phone reads it (see the module comment). */
export function deviceEvent(e: Record<string, unknown>): Record<string, unknown> {
  const kind = String(e.kind);
  const p = obj(e.payload) ?? {};
  const base = { seq: e.seq, kind, at: e.at };
  if (kind === "tool_call" || kind === "tool_result") {
    const source = obj(p.provenance)?.source;
    return {
      ...base,
      summary: p.ok === false ? `${toolLine(p.tool)} — it couldn't` : toolLine(p.tool),
      payload: {
        ...(typeof p.tool === "string" ? { tool: p.tool } : {}),
        ...(typeof p.ok === "boolean" ? { ok: p.ok } : {}),
        ...(typeof source === "string" ? { provenance: { source: stripReadings(source) ?? "what the coach reads" } } : {}),
        ...(Array.isArray(p.missing) ? { missing: p.missing.filter((m): m is string => typeof m === "string" && !namesReading(m)) } : {}),
      },
    };
  }
  if (kind === "question") return { ...base, summary: textOr(e.summary, KIND_LINES.question!), payload: { ...(typeof p.tool === "string" ? { tool: p.tool } : {}), ...questionPayload(p.data) } };
  return {
    ...base,
    summary: textOr(e.summary, KIND_LINES[kind] ?? "The coach is working on it."),
    payload: {
      ...(typeof p.proposalId === "string" ? { proposalId: p.proposalId } : {}),
      ...(p.final === true ? { final: true } : {}),
      ...(p.answer === true ? { answer: true } : {}),
      ...(typeof p.text === "string" && stripReadings(p.text) ? { text: stripReadings(p.text) } : {}),
    },
  };
}

// ── Memory ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A memory item as the phone reads it (A MINOR-1): its words and standing, and where it came from in one word. */
export function deviceMemoryItem(m: Record<string, unknown>): Record<string, unknown> {
  const provenance = obj(m.provenance);
  const source = typeof m.source === "string" ? m.source : typeof provenance?.source === "string" ? provenance.source : null;
  return {
    id: m.id,
    kind: m.kind,
    body: m.body,
    confidence: m.confidence,
    pinned: m.pinned === true || m.pinned === 1,
    expiresAt: m.expiresAt ?? null,
    learnedAt: m.learnedAt ?? null,
    source,
  };
}

const isEvent = (o: Record<string, unknown>): boolean => typeof o.seq === "number" && typeof o.kind === "string" && EVENT_KINDS.has(o.kind) && "payload" in o && typeof o.at === "string";
const isMemoryRow = (o: Record<string, unknown>): boolean => typeof o.body === "string" && typeof o.confidence === "string" && typeof o.kind === "string" && "learnedAt" in o;

/** Keys a phone never reads in a coach answer: what a tool was given or found, a fix, a document, evidence, the account. */
const DROPPED = new Set(["input", "data", "fix", "doc", "evidence", "userId", "pinLines", "context", "cites", "post", "steps", "thresholdSecPerKm", "paces", "conditionMax", "conditionNotes", "readings"]);
/** The coach's own words in an answer: each sentence naming a reading, a pace or a condition taken out. */
const WORDS = new Set(["summary", "line", "text", "why", "title", "message", "headline", "detail", "note", "words", "label", "count"]);

/** A device's coach answer (see the module comment), whatever its route: events and memory items by their shape, the rest
 * walked — the keys it never reads dropped, the coach's words stripped. */
export function deviceView(v: unknown, key?: string): unknown {
  if (Array.isArray(v)) {
    const out = v.map((x) => deviceView(x, key));
    return key === "lines" || key === "choices" ? out.filter((x) => typeof x !== "string" || x.length > 0) : out;
  }
  const o = obj(v);
  if (o) {
    if (isEvent(o)) return deviceEvent(o);
    if (isMemoryRow(o)) return deviceMemoryItem(o);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      if (DROPPED.has(k)) continue;
      // The athlete's own words come back as they wrote them (a request, an answer, a frame's lines are the phone's own).
      if (k === "request" || k === "words" || k === "frameLines" || k === "answers") {
        out[k] = x;
        continue;
      }
      out[k] = deviceView(x, k);
    }
    return out;
  }
  if (typeof v === "string" && key && (WORDS.has(key) || key === "lines" || key === "choices")) return stripReadings(v) ?? "";
  return v;
}

/**
 * The response middleware: a device's JSON answer from these coach routes, as `deviceView` makes it. A cookie's answer, and
 * anything not JSON, passes as it is.
 */
export const deviceCoachView: MiddlewareHandler<AppContext> = async (c, next) => {
  await next();
  if (!c.get("device")) return;
  const type = c.res.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) return;
  const body = (await c.res.clone().json().catch(() => undefined)) as unknown;
  if (body === undefined) return;
  const headers = new Headers(c.res.headers);
  headers.delete("content-length");
  c.res = new Response(JSON.stringify(deviceView(body)), { status: c.res.status, headers });
};
