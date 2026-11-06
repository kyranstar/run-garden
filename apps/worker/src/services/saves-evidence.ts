/**
 * THE EVIDENCE WORDS (import trail phase 3; design 2026-11-05 §8.1, §3.3, §14.2). A saved move's reading as the coach
 * reads its evidence, and the chips a review card's cites become. Pure: no database, no clock.
 *
 * - Quote ids are `q<n>.<k>`: `n` the move's 1-based place in its batch's one order (read_saves'), `k` the quote's place
 *   across the move's links in post order — stable across the pages of a batch, so a cite from an earlier page still
 *   resolves (phase 3's ruling 1).
 * - A quote's check, in words: "said" (found in words the reader didn't write: a transcript, a description), "in the
 *   caption", "heard" (found only in the reader's own transcription of the video: near the creator's words, never proof
 *   — §14.2), "on screen" (text the reader says the video shows: unchecked), "not in the post" (the reader quoted words
 *   that aren't there; the field it supports counts as inferred, §5.6).
 * - Every text here came from a post or the reader: marked (`untrusted`) for the model, drawn as text by the app.
 */
import type { QuoteCheck } from "@rg/saves";
import { untrusted, untrustedOrNull, type Untrusted } from "./design-tools/read-common.js";

export const QUOTE_ID_RE = /^q\d{1,3}\.\d{1,3}$/;

/** A quote's id: the move's place in its batch and the quote's place across the move's links. */
export const quoteId = (moveNo: number, k: number): string => `q${moveNo}.${k}`;

export type CheckWord = "said" | "in the caption" | "heard" | "on screen" | "not in the post";

/** How a quote checked out, in the words a chip and the coach use. */
export function checkWord(check: QuoteCheck | null | undefined, from: string): CheckWord {
  switch (check) {
    case "verified":
      return from === "caption" ? "in the caption" : "said";
    case "in_speech":
      return "heard";
    case "on_screen":
      return "on screen";
    default:
      return "not in the post";
  }
}

/** Seconds as a clock: "1:12", "1:02:05". */
export function clockOf(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/** Where a quote id points: the post, the move's position in it, the quote's index in that reading, how it checked out. */
export interface QuoteRef {
  postId: string;
  position: number;
  quote: number;
  check: QuoteCheck | null;
  from: string;
  at: number | null;
}

/** A quote's chip: "said 1:12", "heard 0:12", "in the caption", "on screen", "not in the post". */
export function quoteLabel(ref: QuoteRef): string {
  const word = checkWord(ref.check, ref.from);
  return (word === "said" || word === "heard") && ref.at !== null ? `${word} ${clockOf(ref.at)}` : word;
}

/** A field the reader may have guessed: what `inferred:<field>` names. */
export const INFERRED_FIELDS = ["name", "dose", "steps", "purpose", "useWhen", "skipWhen", "why"] as const;
export type InferredField = (typeof INFERRED_FIELDS)[number];

/** A cite as a review line stores it, ready to draw: a chip's words and what it opens. */
export type CiteRef =
  | { id: string; kind: "quote"; label: string; postId: string; position: number; quote: number }
  | { id: "history"; kind: "history"; label: "your history" }
  | { id: string; kind: "goal"; label: "your goal"; goalId: string }
  | { id: string; kind: "inferred"; label: "reader's guess"; field: string; postId?: string; position?: number };

export type ParsedCite =
  | { kind: "quote"; id: string }
  | { kind: "history"; id: "history" }
  | { kind: "goal"; id: string; goalId: string }
  | { kind: "inferred"; id: string; field: InferredField };

/** A cite as the coach writes it: a quote id, `history`, `goal:<id>` or `inferred:<field>` — else null. */
export function parseCite(id: string): ParsedCite | null {
  if (QUOTE_ID_RE.test(id)) return { kind: "quote", id };
  if (id === "history") return { kind: "history", id: "history" };
  const goal = /^goal:(\S{1,80})$/.exec(id);
  if (goal) return { kind: "goal", id, goalId: goal[1]! };
  const inferred = /^inferred:(\w+)$/.exec(id);
  if (inferred && (INFERRED_FIELDS as readonly string[]).includes(inferred[1]!)) return { kind: "inferred", id, field: inferred[1] as InferredField };
  return null;
}

const SAY = String.raw`(?:says?|said|shows?|showed|recommends?|recommended|suggests?|suggested|claims?|claimed|pitch(?:es|ed)?|calls?|called|argues?|explains?|insists?|swears?|states?)`;
/** Words that attribute a claim to the post or its creator ("she says", "the caption says", "according to"). */
const CLAIM = new RegExp(
  String.raw`\b(?:s?he|they)\s+(?:also\s+)?${SAY}\b|\b(?:post|creator|caption|description|video|transcript|reel|channel|author)\s+(?:also\s+)?${SAY}\b|\baccording to\b|\bthe creator\b`,
  "i",
);

/** Whether a line attributes a claim to the post or its creator: such a line needs a quote cited (§8.3). */
export const claimsThePost = (text: string): boolean => CLAIM.test(text);

/** Every number in a dose's words, in order: what two doses are compared by. */
export const doseNumbers = (text: string): number[] => (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);

/** A use-when or skip-when case, as the coach reads it: its words, and whether the post said it. */
export interface Case {
  text: Untrusted;
  said: boolean;
}

export interface EvidenceQuote {
  id: string;
  field: string;
  text: Untrusted;
  check: CheckWord;
  at?: string;
}

/** A saved move's reading in one post, as the coach weighs it (§8.1). */
export interface ReadingEvidence {
  confidence: string | null;
  stated: string[];
  inferred: string[];
  /** The post's own dose words (the reader's reading of them). */
  dose: Untrusted | null;
  why?: Untrusted;
  useWhen?: Case[];
  skipWhen?: Case[];
  quotes: EvidenceQuote[];
}

const EVIDENCE_ORDER = ["name", "dose", "steps", "purpose", "useWhen", "skipWhen"] as const;

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

function casesOf(v: unknown): Case[] {
  return (Array.isArray(v) ? v : []).flatMap((c) => {
    const o = obj(c);
    const t = text(o?.text);
    return t ? [{ text: untrusted(t), said: o!.evidence === "stated" }] : [];
  });
}

/**
 * One post's reading of one move (`extraction.moves[position]`), as evidence: what it stated and what it inferred (a
 * field whose quotes were all not found reads as inferred), the post's dose words, why, when to use it or not, and each
 * quote with its id (from `firstK`) and its check — and each quote id's ref. Null for anything that isn't a move.
 */
export function readingEvidence(
  move: unknown,
  o: { moveNo: number; firstK: number; postId: string; position: number },
): { evidence: ReadingEvidence; refs: Array<[string, QuoteRef]> } | null {
  const m = obj(move);
  if (!m) return null;
  const said = obj(m.evidence) ?? {};
  const quotes = (Array.isArray(m.quotes) ? m.quotes : []).flatMap((q) => {
    const x = obj(q);
    return x && text(x.text) && typeof x.field === "string" ? [x] : [];
  });
  // A field whose every quote is not in the post is the reader's guess, whatever it said (§5.6).
  const found = new Map<string, boolean>();
  for (const q of quotes) found.set(q.field as string, (found.get(q.field as string) ?? false) || (q.check !== undefined && q.check !== "not_found"));
  const stated: string[] = [];
  const inferred: string[] = [];
  for (const f of EVIDENCE_ORDER) {
    const v = said[f];
    if (v !== "stated" && v !== "inferred") continue;
    if (v === "stated" && found.get(f) !== false) stated.push(f);
    else inferred.push(f);
  }
  const refs: Array<[string, QuoteRef]> = [];
  const listed = quotes.map((q, i): EvidenceQuote => {
    const id = quoteId(o.moveNo, o.firstK + i);
    const check = typeof q.check === "string" ? (q.check as QuoteCheck) : null;
    const from = typeof q.from === "string" ? q.from : "caption";
    const at = typeof q.at === "number" && Number.isFinite(q.at) ? q.at : null;
    refs.push([id, { postId: o.postId, position: o.position, quote: i, check, from, at }]);
    return { id, field: q.field as string, text: untrusted(q.text as string), check: checkWord(check, from), ...(at !== null ? { at: clockOf(at) } : {}) };
  });
  const why = text(m.why);
  const useWhen = casesOf(m.useWhen);
  const skipWhen = casesOf(m.skipWhen);
  return {
    evidence: {
      confidence: typeof m.confidence === "string" ? m.confidence : null,
      stated,
      inferred,
      dose: untrustedOrNull(obj(m.dose)?.text),
      ...(why ? { why: untrusted(why) } : {}),
      ...(useWhen.length ? { useWhen } : {}),
      ...(skipWhen.length ? { skipWhen } : {}),
      quotes: listed,
    },
    refs,
  };
}
