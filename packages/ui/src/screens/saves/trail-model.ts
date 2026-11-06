/**
 * ONE IMPORT'S TRAIL, PURE (design 2026-11-05 §3.4): what the trail sheet draws from `GET /api/my-saves/posts/:id/trail`,
 * read top to bottom as an account, each level one tap deeper than the last.
 *
 *   trailAccount   level 1, always open: where it came from, what it is, its moves (new, the same as one of yours, the
 *                  library's) with the reader's line on each, what the coach did, corrections, one health word — and,
 *                  for a post from before the trail, that its raw replies weren't kept
 *   trailSections  level 2: one section per stage present, in pipeline order (read and submit are both "Reading"),
 *                  folded, each with a one-line result; opened, each step's facts as key: value rows — the decision, a
 *                  move's own facts under its name, then the call (model, prompt, tokens, cost, time, attempt)
 *   blobs          level 3: the raw reply, the prompt as sent… listed by what they are and their size; the sheet reads
 *                  one only when it is opened
 *   moveDetail     a move's own section (from its account line): its check, its match, the owner's choices about it
 *
 * Two rules the coach's trail didn't keep: the most important content first, and nothing cut — a value past
 * DETAIL_VALUE_MAX is a preview whose whole is kept in `full` (the sheet's "Show all"). A value is always words: an object
 * is key: value lines, never JSON; an id is a move's name where the trail knows it. Every text here came from a stage,
 * a model or a stranger's post: the sheet draws it as text, never as markup. Pure: no React, no network.
 */
import { clock, failureWords, IMPORT_STAGES, transcriptSegments, WAITING_FOR_EXTENSION, type BlobKind, type ImportStage, type ImportTrailDto, type TrailEventDto, type TrailStatus } from "@rg/saves";
import { formatTime } from "../../components.js";
import { DETAIL_VALUE_MAX, keyWords, type DetailRow } from "../studio/run-model.js";
import { dayOf } from "../studio/saves-model.js";

// ── Shapes ───────────────────────────────────────────────────────────────────

/** A key: value row (the coach trail's `DetailRow`), its value a preview when `full` holds more. */
export type TrailRow = Pick<DetailRow, "key" | "value"> & {
  /** The whole value, when `value` is its preview: the sheet's "Show all". */
  full?: string;
  /** Drawn struck through: a quote the reader made that isn't in the post (§5.6). */
  struck?: boolean;
  /** The quote a review card's chip opened the trail at (import trail phase 3, §3.3): marked, and scrolled into view. */
  focus?: boolean;
};

/** A group of rows under an optional heading (the coach trail's `DetailSection`). */
export interface TrailDetail {
  title: string | null;
  rows: TrailRow[];
}

export interface AccountLine {
  key: string;
  kind: "from" | "what" | "video" | "move" | "coach" | "correction" | "health" | "rebuilt";
  text: string;
  /** A second line: what the reader says a move is for. */
  sub?: string | null;
  /** The health word's status (its mark). */
  status?: TrailStatus;
  /** A move line's place in the post: it opens the move's own section (`moveDetail`). */
  position?: number;
  /** A video line that offers Watch it too, with what watching would cost (design 2026-11-05 §5.4). */
  watch?: { costMicros: number | null };
}

/**
 * A blob's text as the trail shows it: a transcript's lines with the [m:ss] clock the reader was given (stored as
 * `<seconds>\t<words>`; final audit G20); anything else as it was kept.
 */
export function blobDisplayText(kind: BlobKind, text: string): string {
  if (kind !== "transcript") return text;
  return transcriptSegments(text).map(([at, words]) => `[${clock(at)}] ${words}`).join("\n");
}

/** The button that asks for a long video to be watched, with its typical cost. */
export function watchLabel(costMicros: number | null): string {
  return costMicros === null ? "Watch it too" : `Watch it too (about $${(costMicros / 1_000_000).toFixed(2)})`;
}
export const TRANSCRIPT_ONLY_LINE = "Read from the transcript only (over 20 minutes)";

/** A raw piece of a step, listed by what it is and its size; its text is read when opened. */
export interface TrailBlob {
  id: string;
  kind: BlobKind;
  chars: number;
  label: string;
  size: string;
}

/** One event of a stage: its own line, when, its facts, its raw pieces. */
export interface TrailStep {
  id: string;
  summary: string;
  status: TrailStatus;
  when: string;
  rebuilt: boolean;
  details: TrailDetail[];
  blobs: TrailBlob[];
}

/** A section's stage: read and submit share one ("Reading"). */
export type SectionStage = Exclude<ImportStage, "submit">;

export interface StageSection {
  stage: SectionStage;
  title: string;
  /** One line: what came of it. */
  result: string;
  status: TrailStatus;
  steps: TrailStep[];
}

// ── Words ────────────────────────────────────────────────────────────────────

export const STAGE_TITLES: Readonly<Record<SectionStage, string>> = {
  read: "Reading",
  screen: "Screening",
  extract: "Reading the moves",
  check: "Checking the reading",
  match: "Matching",
  batch: "Batch",
  choice: "Your choices",
  save: "Saved",
  coach: "The coach",
  correction: "Corrections",
};

const sectionOf = (stage: ImportStage): SectionStage => (stage === "submit" ? "read" : stage);

/** A status's mark and its word for a reader — never colour alone. */
export const STATUS_MARK: Readonly<Record<TrailStatus, { mark: string; word: string }>> = {
  ok: { mark: "✓", word: "Done: " },
  warn: { mark: "!", word: "Needs a look: " },
  fail: { mark: "✕", word: "Didn't work: " },
  info: { mark: "–", word: "" },
  skip: { mark: "–", word: "Skipped: " },
};

export const REBUILT_LINE = "Kept from before the trail: the raw replies weren't kept then.";
/** Phase 1 records no coach decisions (they come with phase 3's review): say only what the trail knows. */
export const NOT_REVIEWED_LINE = "No coach decision on its trail yet";
export const TOO_LONG_LINE = "Too long to show here — the whole of it is below";

const SOURCE_WORDS: Readonly<Record<string, string>> = { instagram: "Instagram", youtube: "YouTube" };
const sourceWord = (s: string): string => SOURCE_WORDS[s] ?? s;

const KIND_LINE: Readonly<Record<string, string>> = { routine: "A routine", single_move: "One move", tips: "Tips", not_training: "Not training" };

const BLOB_LABELS: Readonly<Record<BlobKind, string>> = {
  raw_reply: "The raw reply",
  prompt_user: "The prompt as sent",
  transcript: "The transcript",
  speech: "What the reader heard",
  read_facts: "What was read",
  detail: "The whole detail",
};
export const blobLabel = (kind: BlobKind): string => BLOB_LABELS[kind] ?? keyWords(kind);

/**
 * A blob's label on its step: the prompt is "as sent" only when the extension's hash matched the app's rebuild of it;
 * otherwise it is the app's own rebuild and says so (final review, 2026-11-05).
 */
function blobLabelOf(kind: BlobKind, detail: unknown): string {
  if (kind !== "prompt_user") return blobLabel(kind);
  const asSent = detail && typeof detail === "object" ? (detail as { asSent?: unknown }).asSent : undefined;
  return asSent === true ? "The prompt as sent" : "The prompt, as the app rebuilt it";
}

/** Each key a stage writes, in the owner's words. */
const LABELS: Readonly<Record<string, string>> = {
  verdict: "Verdict",
  reason: "Why",
  errorCode: "What went wrong",
  code: "What went wrong",
  failure: "The call failed",
  tokens: "Tokens",
  kind: "Kind",
  moves: "Moves",
  issues: "Issues",
  finishReason: "Finished",
  promptSha: "Prompt hash (the app's)",
  promptShaSent: "Prompt hash (as sent)",
  asSent: "Prompt as the app wrote it",
  videoSeen: "Video seen",
  watched: "Watched",
  quotes: "Quotes",
  dropped: "Left out",
  youtube: "The video",
  captions: "Captions",
  segments: "Transcript lines",
  transcriptChars: "Transcript",
  chapters: "Chapters",
  chaptersFrom: "Chapters from",
  ms: "Time taken",
  bytes: "Bytes",
  readFacts: "What was sent",
  variantWidth: "Video size",
  byLink: "By link",
  images: "Images",
  via: "How it came",
  extVersion: "Extension",
  page: "Page",
  coverSent: "Cover sent",
  mediaCount: "Media",
  source: "Source",
  mediaType: "Media",
  captionChars: "Caption",
  hashtags: "Hashtags",
  cover: "Cover",
  repairs: "Repairs",
  problems: "Problems",
  doseOrigin: "Dose from",
  evidence: "Said in the post",
  confidence: "Confidence",
  outcome: "Came out",
  by: "Matched by",
  candidates: "Candidates",
  judge: "Judge",
  judgeAnswer: "Judge said",
  like: "Looks like",
  check: "Check this",
  insightsKept: "Notes kept",
  insightsDropped: "Notes left out",
  fields: "Changed",
  choices: "Choices",
  from: "From",
  to: "To",
  position: "Move",
  message: "The site said",
  action: "Action",
  before: "Before",
  after: "After",
};
const label = (k: string, stage?: ImportStage): string => (k === "stage" && stage === "screen" ? "Decided by" : (LABELS[k] ?? keyWords(k)));

/** Enumerations, in words, by the key that holds them. */
const VALUE_WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  verdict: { training: "training", not: "not training", maybe: "maybe" },
  stage: { creator: "the creator rule", keyword: "a training word in the caption", model: "the model", seed: "the first import", owner: "you" },
  kind: { routine: "a routine", single_move: "a single move", tips: "tips", not_training: "not training" },
  finishReason: { stop: "done", length: "cut off at the output limit", content_filter: "stopped by a content filter" },
  via: { saved_list: "your saved list", pasted: "a pasted link", captured: "the player's own captions", panel: "the transcript panel" },
  chaptersFrom: { player: "the player bar", description: "the description" },
  doseOrigin: { post: "the post", reading: "the reader's reading", default: "a default — the post gave none" },
  outcome: { new: "a new move", personal: "already yours", yours: "already yours", library: "from the library" },
  by: { name: "its name", judge: "the judge", fuzzy: "a close name", new: "no match" },
  judge: { asked: "asked", not_needed: "not needed", failed: "its call failed", budget: "not asked: the import budget" },
  evidence: { stated: "stated", inferred: "the reader's guess" },
};

/** Keys that say nothing to the owner: the system's own ids and markers. */
const QUIET = new Set(["batchId", "moveId", "id", "usageId", "runId", "proposalId", "key", "untrusted", "signature", "cut", "head"]);
/** The call's own facts: under "The call", not the decision. */
const CALL_KEYS = new Set(["tokens", "finishReason", "asSent", "promptSha", "promptShaSent", "failure"]);

const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const num = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const plural = (n: number, one: string): string => `${num(n)} ${n === 1 ? one : `${one}s`}`;

function bytesWords(n: number): string {
  if (n < 1_000) return plural(n, "byte");
  if (n < 1_000_000) return `${Math.round(n / 1_000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

function costWords(micros: number): string {
  const d = micros / 1_000_000;
  return d > 0 && d < 0.01 ? `$${d.toFixed(4)}` : `$${d.toFixed(2)}`;
}

const timeWords = (ms: number): string => (ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`);

function lengthWords(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s} s`;
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** "Tue 3 Nov, 10:02 AM", on this device's clock. */
export function whenWords(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  return `${dayOf(at)}, ${formatTime(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`)}`;
}

/** The call's failure ("gateway_402", "llm_error") in words: the HTTP status the gateway gave, when it gave one. */
function failureCall(f: string): string {
  const http = /^gateway_(\d{3})$/.exec(f);
  if (http) return `the model gateway answered ${http[1]}`;
  if (f === "llm_error") return "the model couldn't be reached";
  return f.replace(/_/g, " ");
}

/** The trail's names for ids: each move of the post, and what matching named. */
function namesOf(dto: ImportTrailDto): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of dto.account.moves) if (m.moveId && m.name) names.set(m.moveId, m.name);
  for (const e of dto.events) {
    if (e.stage !== "match") continue;
    for (const m of movesOf(e)) {
      if (typeof m.moveId === "string" && typeof m.name === "string" && !names.has(m.moveId)) names.set(m.moveId, m.name);
      for (const c of Array.isArray(m.candidates) ? m.candidates : []) {
        const cr = record(c);
        if (cr && typeof cr.id === "string" && typeof cr.name === "string" && !names.has(cr.id)) names.set(cr.id, cr.name);
      }
    }
  }
  return names;
}

const movesOf = (e: TrailEventDto): Record<string, unknown>[] => {
  const moves = record(e.detail)?.moves;
  return Array.isArray(moves) ? moves.flatMap((m) => (record(m) ? [record(m)!] : [])) : [];
};

interface Ctx {
  stage?: ImportStage;
  names: Map<string, string>;
  moveAt: (position: number) => string | null;
}

/** A value inline, in words: text as it is, numbers, yes/no, lists and objects as words — never JSON, never cut. */
function inline(v: unknown, ctx: Ctx): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number") return num(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.length === 0 ? "none" : v.map((x) => inline(x, ctx)).join(", ");
  const o = record(v);
  if (!o) return String(v);
  if (typeof o.text === "string" && Object.keys(o).every((k) => k === "text" || k === "untrusted")) return o.text.trim();
  return Object.entries(o)
    .filter(([k, x]) => !QUIET.has(k) && x !== null && x !== undefined)
    .map(([k, x]) => `${label(k).toLowerCase()} ${record(x) || Array.isArray(x) ? inline(x, ctx) : field(k, x, ctx)}`)
    .join(" · ");
}

/** A list of strings: lines when any reads as a sentence, else one line. */
function listWords(items: readonly unknown[], ctx: Ctx): string {
  if (items.length === 0) return "none";
  const words = items.map((x) => (record(x) ? inline(x, ctx) : field("", x, ctx)));
  return words.some((w) => w.length > 24 || w.includes(": ") || items.some((x) => record(x) !== null)) ? words.join("\n") : words.join(", ");
}

/** One field's value, in words, by its key. */
function field(k: string, v: unknown, ctx: Ctx): string {
  const said = VALUE_WORDS[k];
  if (said && typeof v === "string") return said[v] ?? v.replace(/_/g, " ");
  switch (k) {
    case "code":
    case "errorCode":
      return typeof v === "string" ? (failureWords(v, null) ?? v) : inline(v, ctx);
    case "failure":
      return typeof v === "string" ? failureCall(v) : inline(v, ctx);
    case "tokens": {
      const t = record(v);
      return t ? [typeof t.in === "number" ? `${num(t.in)} in` : null, typeof t.out === "number" ? `${num(t.out)} out` : null].filter(Boolean).join(" · ") : inline(v, ctx);
    }
    case "asSent":
      return v === false ? "no — an older extension's prompt" : inline(v, ctx);
    case "watched":
      return v === false ? "no — over 20 minutes, read from its words" : inline(v, ctx);
    case "videoSeen":
      return v === false ? "no — the reader read the transcript only" : inline(v, ctx);
    case "quotes": {
      const q = record(v);
      if (!q) return inline(v, ctx);
      const n = (x: unknown) => (typeof x === "number" ? x : 0);
      const parts = [
        n(q.verified) ? `${num(n(q.verified))} in the words` : "",
        n(q.in_speech) ? `${num(n(q.in_speech))} heard by the reader` : "",
        n(q.on_screen) ? `${num(n(q.on_screen))} shown on screen` : "",
        n(q.not_found) ? `${num(n(q.not_found))} not in the post` : "",
      ].filter(Boolean);
      return parts.length ? parts.join(" · ") : "none";
    }
    case "dropped":
      return Array.isArray(v)
        ? v
            .map((x) => {
              const o = record(x);
              if (!o) return inline(x, ctx);
              const at = typeof o.move === "number" ? (ctx.moveAt(o.move) ?? `Move ${o.move + 1}`) : "A move";
              return `${at}: ${typeof o.field === "string" ? keyWords(o.field).toLowerCase() : "a list"} — ${inline(o.values, ctx)}`;
            })
            .join("\n")
        : inline(v, ctx);
    case "captions": {
      const c = record(v);
      if (!c) return v === null ? "none" : inline(v, ctx);
      return `${c.kind === "auto" ? "auto-generated" : "uploaded"}${typeof c.lang === "string" ? ` (${c.lang})` : ""}`;
    }
    case "transcriptChars":
      return typeof v === "number" ? plural(v, "character") : inline(v, ctx);
    case "ms":
      return typeof v === "number" ? timeWords(v) : inline(v, ctx);
    case "bytes":
      return typeof v === "number" ? bytesWords(v) : inline(v, ctx);
    case "variantWidth":
      return typeof v === "number" ? `${num(v)} px wide` : inline(v, ctx);
    case "captionChars":
      return typeof v === "number" ? plural(v, "character") : inline(v, ctx);
    case "source":
      return typeof v === "string" ? sourceWord(v) : inline(v, ctx);
    case "confidence":
      return typeof v === "number" ? pct(v) : inline(v, ctx);
    case "candidates":
      return Array.isArray(v)
        ? v.length === 0
          ? "none"
          : v
              .map((c) => {
                const cr = record(c);
                if (!cr) return inline(c, ctx);
                const facts = [typeof cr.score === "number" ? pct(cr.score) : null, cr.kind === "personal" ? "yours" : typeof cr.kind === "string" ? cr.kind : null].filter(Boolean);
                const name = typeof cr.name === "string" ? cr.name : typeof cr.id === "string" ? (ctx.names.get(cr.id) ?? "a move") : "a move";
                return facts.length ? `${name} (${facts.join(", ")})` : name;
              })
              .join("\n")
        : inline(v, ctx);
    case "like": {
      const o = record(v);
      if (!o) return inline(v, ctx);
      return typeof o.name === "string" && o.name ? o.name : typeof o.id === "string" ? (ctx.names.get(o.id) ?? "another move") : "another move";
    }
    case "judgeAnswer":
    case "from":
    case "to":
      return typeof v === "string" ? (ctx.names.get(v) ?? v) : inline(v, ctx);
    case "position":
      return typeof v === "number" ? (ctx.moveAt(v) ?? `the move at ${v + 1}`) : inline(v, ctx);
    case "choices": {
      const o = record(v);
      return o
        ? Object.entries(o)
            .filter(([, c]) => c !== null && c !== undefined)
            .map(([id, c]) => `${ctx.names.get(id) ?? id}: ${inline(c, ctx)}`)
            .join("\n") || "none"
        : inline(v, ctx);
    }
    case "insightsDropped":
      return Array.isArray(v)
        ? v.length === 0
          ? "none"
          : v
              .map((x) => {
                const o = record(x);
                return o && typeof o.text === "string" ? (typeof o.why === "string" ? `${o.text} — ${o.why}` : o.text) : inline(x, ctx);
              })
              .join("\n")
        : inline(v, ctx);
  }
  if (Array.isArray(v)) return listWords(v, ctx);
  const o = record(v);
  if (!o) return inline(v, ctx);
  if (typeof o.text === "string" && Object.keys(o).every((kk) => kk === "text" || kk === "untrusted")) return o.text.trim();
  // An object is key: value lines (the reading's evidence, what was sent); one inside it reads inline.
  const lines = Object.entries(o)
    .filter(([kk, x]) => !QUIET.has(kk) && x !== null && x !== undefined)
    .map(([kk, x]) => {
      const words =
        k === "evidence" && typeof x === "string"
          ? (VALUE_WORDS.evidence![x] ?? x)
          : WORDED.has(kk) || !(record(x) || Array.isArray(x))
            ? field(kk, x, ctx)
            : inline(x, ctx);
      // A video's own `via` is how its transcript was got, not how the post came.
      return `${k === "youtube" && kk === "via" ? "Transcript from" : label(kk)}: ${words}`;
    });
  return lines.join("\n") || "—";
}

/** Objects and lists `field` has its own words for, wherever they sit. */
const WORDED = new Set(["captions", "quotes", "dropped", "tokens"]);

/** A row: its whole value, or a preview cut at a word with the whole kept for "Show all". */
export function rowOf(key: string, whole: string): TrailRow {
  if (whole.length <= DETAIL_VALUE_MAX) return { key, value: whole };
  const room = whole.slice(0, DETAIL_VALUE_MAX - 1);
  const space = room.lastIndexOf(" ");
  return { key, value: `${(space > DETAIL_VALUE_MAX / 2 ? room.slice(0, space) : room).trimEnd()}…`, full: whole };
}

// ── A step's facts ───────────────────────────────────────────────────────────

const CALL_ORDER = ["model", "promptVersion", "asSent", "promptSha", "promptShaSent", "attempt", "tokens", "finishReason", "failure", "cost", "time"] as const;
const CALL_LABEL: Readonly<Record<string, string>> = { model: "Model", promptVersion: "Prompt", attempt: "Attempt", cost: "Cost", time: "Time" };

function stepDetails(e: TrailEventDto, ctx: Ctx): TrailDetail[] {
  const main: TrailRow[] = [];
  const groups: TrailDetail[] = [];
  const call = new Map<string, TrailRow>();
  const c: Ctx = { ...ctx, stage: e.stage };
  const d = record(e.detail);
  if (d && d.cut === true) {
    // Too long for its event: the whole is its `detail` blob — never the JSON head it kept.
    main.push({ key: "Detail", value: TOO_LONG_LINE });
  } else if (d) {
    for (const [k, v] of Object.entries(d)) {
      if (v === null || v === undefined || QUIET.has(k)) continue;
      if (CALL_KEYS.has(k)) {
        call.set(k, rowOf(label(k), field(k, v, c)));
        continue;
      }
      if (k === "moves" && Array.isArray(v)) {
        groups.push(...moveGroups(v, c));
        continue;
      }
      main.push(rowOf(label(k, e.stage), field(k, v, c)));
    }
  } else if (e.detail !== null && e.detail !== undefined) {
    main.push(rowOf("Detail", inline(e.detail, c)));
  }
  if (e.rebuilt) main.push({ key: "Kept", value: "Rebuilt from what was kept" });
  if (e.model) call.set("model", rowOf(CALL_LABEL.model!, e.model));
  if (e.promptVersion) call.set("promptVersion", rowOf(CALL_LABEL.promptVersion!, e.promptVersion));
  if (e.attempt !== null) call.set("attempt", { key: CALL_LABEL.attempt!, value: num(e.attempt) });
  if (e.costMicros !== null) call.set("cost", { key: CALL_LABEL.cost!, value: costWords(e.costMicros) });
  if (e.latencyMs !== null) call.set("time", { key: CALL_LABEL.time!, value: timeWords(e.latencyMs) });
  const callRows = CALL_ORDER.flatMap((k) => (call.has(k) ? [call.get(k)!] : []));
  return [
    ...(main.length ? [{ title: null, rows: main }] : []),
    ...groups,
    ...(callRows.length ? [{ title: "The call", rows: callRows }] : []),
  ];
}

/** A stage's per-move entries (check, match): each under "1. Its name", its own facts in words. */
function moveGroups(moves: readonly unknown[], ctx: Ctx): TrailDetail[] {
  return moves.flatMap((m, i): TrailDetail[] => {
    const o = record(m);
    if (!o) return [{ title: null, rows: [rowOf(label("moves"), inline(m, ctx))] }];
    const position = typeof o.position === "number" ? o.position : i;
    const name = typeof o.name === "string" && o.name ? o.name : (ctx.moveAt(position) ?? "A move");
    return [{ title: `${position + 1}. ${name}`, rows: moveRows(o, ctx) }];
  });
}

function moveRows(o: Record<string, unknown>, ctx: Ctx): TrailRow[] {
  return Object.entries(o)
    .filter(([k, v]) => !["position", "name"].includes(k) && !QUIET.has(k) && v !== null && v !== undefined)
    .map(([k, v]) => rowOf(label(k), field(k, v, ctx)));
}

const blobsOf = (e: TrailEventDto): TrailBlob[] =>
  e.blobs.map((b) => ({ id: b.id, kind: b.kind, chars: b.chars, label: blobLabelOf(b.kind, e.detail), size: plural(b.chars, "character") }));

function ctxOf(dto: ImportTrailDto): Ctx {
  const names = namesOf(dto);
  const at = new Map(dto.account.moves.map((m) => [m.position, m.name]));
  return { names, moveAt: (p) => at.get(p) ?? null };
}

// ── Level 1: the account ─────────────────────────────────────────────────────

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

export function trailAccount(dto: ImportTrailDto): AccountLine[] {
  const { post, account } = dto;
  const out: AccountLine[] = [];
  const creator = post.creator.name?.trim() || post.creator.handle.trim();
  const who = post.title ? (creator ? `${post.title} by ${creator}` : post.title) : creator || "an unknown creator";
  const day = dayOf(post.firstSeenAt);
  const from = [
    `From ${who}`,
    sourceWord(post.source),
    post.durationSec ? lengthWords(post.durationSec) : null,
    day ? (post.origin === "pasted" ? `pasted ${day}` : day) : null,
  ].filter(Boolean);
  out.push({ key: "from", kind: "from", text: from.join(" · ") });

  // A video's watching (design 2026-11-05 §5.4): a long one read from its words offers to be watched; asked, it waits.
  const video = post.video;
  if (video?.watchAsked && post.status === "queued") out.push({ key: "video", kind: "video", text: WAITING_FOR_EXTENSION, status: "info" });
  else if (video?.offerWatch) out.push({ key: "video", kind: "video", text: TRANSCRIPT_ONLY_LINE, status: "info", watch: { costMicros: video.watchCostMicros } });

  const kind = account.kind ? (KIND_LINE[account.kind] ?? account.kind) : null;
  const what = kind && account.summary ? `${kind}: ${account.summary}` : (kind ?? account.summary);
  if (what) out.push({ key: "what", kind: "what", text: what });

  // The post's own words for each move: the latest match step's.
  const match = [...dto.events].reverse().find((e) => e.stage === "match");
  const postName = new Map(match ? movesOf(match).flatMap((m) => (typeof m.position === "number" && typeof m.name === "string" ? [[m.position, m.name] as const] : [])) : []);
  for (const m of account.moves) {
    const said = postName.get(m.position);
    const differs = !!said && norm(said) !== norm(m.name);
    const text =
      m.outcome === "new"
        ? `${said ?? m.name} — new`
        : m.outcome === "yours"
          ? differs
            ? `${said} — same as your ${m.name}`
            : `${m.name} — already yours`
          : differs
            ? `${said} — the library's ${m.name}`
            : `${m.name} — from the library`;
    out.push({ key: `move-${m.position}`, kind: "move", text, sub: m.purpose, position: m.position });
  }

  // What the coach did: its latest word on each move (and each of its steps that names none).
  const coach = dto.events.filter((e) => e.stage === "coach");
  const latest = new Map<string, TrailEventDto>();
  for (const e of coach) latest.set(e.moveId ?? e.id, e);
  if (latest.size > 0) for (const [k, e] of latest) out.push({ key: `coach-${k}`, kind: "coach", text: e.summary, status: e.status });
  else if (account.moves.length > 0) out.push({ key: "coach", kind: "coach", text: NOT_REVIEWED_LINE });

  for (const e of dto.events) if (e.stage === "correction") out.push({ key: `correction-${e.id}`, kind: "correction", text: e.summary, status: e.status });

  out.push({ key: "health", kind: "health", text: account.health.line, status: account.health.status });
  if (dto.rebuilt) out.push({ key: "rebuilt", kind: "rebuilt", text: REBUILT_LINE });
  return out;
}

// ── Level 2: the stages ──────────────────────────────────────────────────────

const ORDINAL = ["first", "second", "third", "fourth", "fifth"];

/** The issue a failed attempt names first, else its own line. */
function issueOf(s: TrailEventDto): string {
  const issues = record(s.detail)?.issues;
  return Array.isArray(issues) && typeof issues[0] === "string" && issues[0].trim() ? issues[0].trim() : s.summary;
}

function resultOf(stage: SectionStage, events: readonly TrailEventDto[]): string {
  const last = events.at(-1)!;
  if (events.length === 1) return last.summary;
  const n = events.length;
  if (stage === "extract") {
    const failed = events.filter((e) => e.status === "fail");
    if (failed.length === 0) return last.summary;
    if (last.status === "fail") {
      if (failed.length === n) return `${n} attempts — ${n === 2 ? "both" : "all"} failed: ${issueOf(last)}`;
      return `${n} attempts — the last failed: ${issueOf(last)}`;
    }
    if (failed.length === 1) {
      const i = events.indexOf(failed[0]!);
      return `${n} attempts — ${ORDINAL[i] ? `the ${ORDINAL[i]}` : `attempt ${i + 1}`} failed: ${issueOf(failed[0]!)}`;
    }
    return `${n} attempts — ${failed.length} failed, the first: ${issueOf(failed[0]!)}`;
  }
  if (stage === "read") {
    // How it came in: a failure first, else the first step's line.
    return (events.find((e) => e.status === "fail") ?? events.find((e) => e.status === "warn") ?? events[0]!).summary;
  }
  const noun = stage === "choice" ? "choices" : stage === "correction" ? "corrections" : stage === "coach" ? "steps" : "times";
  return `${n} ${noun} — the latest: ${last.summary}`;
}

function statusOf(events: readonly TrailEventDto[]): TrailStatus {
  const last = events.at(-1)!.status;
  if (last === "fail") return "fail";
  // A step that went wrong before one that went right: it needed a look, it isn't a failure.
  if (events.some((e) => e.status === "fail" || e.status === "warn")) return "warn";
  return last;
}

export function trailSections(dto: ImportTrailDto): StageSection[] {
  const ctx = ctxOf(dto);
  const by = new Map<SectionStage, TrailEventDto[]>();
  // Oldest first within a section, a read before its submit (they share a moment).
  const rank = (e: TrailEventDto) => IMPORT_STAGES.indexOf(e.stage);
  for (const e of [...dto.events].sort((a, b) => rank(a) - rank(b))) {
    const s = sectionOf(e.stage);
    const list = by.get(s) ?? [];
    list.push(e);
    by.set(s, list);
  }
  const order = IMPORT_STAGES.filter((s): s is SectionStage => s !== "submit");
  return order.flatMap((stage): StageSection[] => {
    const events = by.get(stage);
    if (!events?.length) return [];
    return [
      {
        stage,
        title: STAGE_TITLES[stage],
        result: resultOf(stage, events),
        status: statusOf(events),
        steps: events.map((e) => ({
          id: e.id,
          summary: e.summary,
          status: e.status,
          when: whenWords(e.at),
          rebuilt: e.rebuilt,
          details: stepDetails(e, ctx),
          blobs: blobsOf(e),
        })),
      },
    ];
  });
}

/** A `detail` blob's text, read back as rows — never shown as its JSON; null when it doesn't parse. */
export function detailBlobRows(text: string, stage: ImportStage, dto: ImportTrailDto): TrailDetail[] | null {
  let detail: unknown;
  try {
    detail = JSON.parse(text);
  } catch {
    return null;
  }
  const bare: TrailEventDto = {
    id: "detail", stage, source: "worker", status: "info", summary: "", detail, moveId: null, model: null, promptVersion: null,
    costMicros: null, latencyMs: null, attempt: null, runId: null, proposalId: null, rebuilt: false, blobs: [], at: "",
  };
  return stepDetails(bare, ctxOf(dto));
}

// ── A move's own section ─────────────────────────────────────────────────────

export const POST_SAYS = "What the post says";
const QUOTE_FIELD: Readonly<Record<string, string>> = {
  name: "Name", dose: "Dose", purpose: "Purpose", useWhen: "Use when", skipWhen: "Skip when", steps: "Steps", why: "Why",
};
const QUOTE_CHECK: Readonly<Record<string, string>> = {
  verified: "in the words",
  in_speech: "what the reader heard in the video",
  on_screen: "shown on screen in the video (the app can't check it)",
  not_found: "the reader quoted words that aren't in the post",
};

/** When the post says to use a move or not, why, and its quotes with how each checked out (§5.5–5.6): a stranger's words. */
function postSays(m: ImportTrailDto["account"]["moves"][number], focusQuote?: number): TrailRow[] {
  const cases = (list: { text: string; evidence: string }[] | undefined) =>
    (list ?? []).map((c) => (c.evidence === "inferred" ? `${c.text.trim()} (the reader's guess)` : c.text.trim())).join("; ");
  const rows: TrailRow[] = [];
  if (m.why?.trim()) rows.push(rowOf("Why", m.why.trim()));
  if (m.useWhen?.length) rows.push(rowOf("Use when", cases(m.useWhen)));
  if (m.skipWhen?.length) rows.push(rowOf("Skip when", cases(m.skipWhen)));
  for (const [i, q] of (m.quotes ?? []).entries()) {
    const key = `${QUOTE_FIELD[q.field] ?? keyWords(q.field)}${typeof q.at === "number" ? ` · ${clock(q.at)}` : ""}`;
    const check = q.check ? QUOTE_CHECK[q.check] : null;
    const row = rowOf(key, `“${q.text.trim()}”${check ? ` — ${check}` : ""}`);
    rows.push({ ...row, ...(q.check === "not_found" ? { struck: true } : {}), ...(i === focusQuote ? { focus: true } : {}) });
  }
  return rows;
}

/** Everything the trail says of one move: its check, its match (the latest of each), and each choice, coach step and
 * correction that names it. */
export function moveDetail(dto: ImportTrailDto, position: number, focusQuote?: number): TrailDetail[] {
  const ctx = ctxOf(dto);
  const move = dto.account.moves.find((m) => m.position === position);
  const out: TrailDetail[] = [];
  const said = move ? postSays(move, focusQuote) : [];
  if (said.length) out.push({ title: POST_SAYS, rows: said });
  for (const stage of ["check", "match"] as const) {
    const e = [...dto.events].reverse().find((x) => x.stage === stage && movesOf(x).some((m) => m.position === position));
    const entry = e ? movesOf(e).find((m) => m.position === position) : undefined;
    if (entry) out.push({ title: STAGE_TITLES[stage], rows: moveRows(entry, { ...ctx, stage }) });
  }
  for (const stage of ["choice", "coach", "correction"] as const) {
    const rows = dto.events
      .filter((e) => e.stage === stage && ((move?.moveId && e.moveId === move.moveId) || record(e.detail)?.position === position))
      .map((e) => rowOf(dayOf(e.at) || "—", e.summary));
    if (rows.length) out.push({ title: STAGE_TITLES[stage], rows });
  }
  return out;
}
