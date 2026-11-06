import type { Extraction, QuoteCheck } from "./schemas.js";
import type { Segment } from "./transcript.js";

// QUOTE VERIFICATION (design 2026-11-05 §5.6, deterministic): a reading's quotes are the creator's words only when the
// words are there. Run by the Worker after the parse; the check it writes replaces any the model wrote.

/** Case, accents, punctuation and spacing folded away: "Café—LIFT, now!" is "cafe lift now". Any script's letters stay. */
export function foldWords(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The share of a quote's words a window must hold to count as the quote (a transcript's words garble). */
export const QUOTE_OVERLAP_MIN = 0.8;
/** How far from a quote's `at` its window is looked for, in seconds. */
const NEAR_SECONDS = 45;
/** A transcript longer than this, in words, is only searched near a quote's time (CPU: the Worker has 10 ms). */
const WHOLE_SEARCH_MAX_WORDS = 20_000;

const EVIDENCE_FIELDS = new Set(["name", "dose", "steps", "purpose", "useWhen", "skipWhen"]);

export interface QuoteSources {
  caption: string;
  title?: string | null;
  chapters?: readonly string[];
  /** The transcript, or a way to get it: read (and folded) only when a quote isn't found in the other words (F2). */
  transcript?: readonly Segment[] | (() => readonly Segment[] | null) | null;
  /** The reader's own transcription of the video: words near the creator's, never proof. */
  speech?: string | null;
}
export interface QuoteResult {
  move: number;
  quote: number;
  check: QuoteCheck;
  /** Where in the transcript it was found (seconds), else the quote's own `at`, else null. */
  at: number | null;
}

/** A whole-word substring test: " ten " is not in " often ". */
const hasWords = (padded: string, needle: string): number => padded.indexOf(` ${needle} `);
/** A text padded once for `hasWords` (padding it per quote copied a long transcript each time: final review F2). */
const pad = (s: string): string => ` ${s} `;

/** Whether some window of `quote.length` words in `words` holds at least QUOTE_OVERLAP_MIN of them (as a multiset). */
function overlaps(quote: readonly string[], words: readonly string[]): number {
  const n = quote.length;
  if (n === 0 || words.length === 0) return -1;
  const want = new Map<string, number>();
  for (const w of quote) want.set(w, (want.get(w) ?? 0) + 1);
  const have = new Map<string, number>();
  let hits = 0;
  const add = (w: string, d: 1 | -1) => {
    const need = want.get(w);
    if (need === undefined) return;
    const before = have.get(w) ?? 0;
    const after = before + d;
    have.set(w, after);
    if (d === 1 && after <= need) hits++;
    if (d === -1 && before <= need) hits--;
  };
  for (let i = 0; i < words.length; i++) {
    add(words[i]!, 1);
    if (i >= n) add(words[i - n]!, -1);
    if (i >= Math.min(n, words.length) - 1 && hits / n >= QUOTE_OVERLAP_MIN) return Math.max(0, i - n + 1);
  }
  return -1;
}

interface FoldedTranscript {
  text: string;
  /** `text` padded once for whole-word search. */
  padded: string;
  /** Each segment's start in `text`, and its time. */
  starts: { offset: number; at: number; words: string[] }[];
  words: number;
}

function foldTranscript(segments: readonly Segment[]): FoldedTranscript {
  const starts: FoldedTranscript["starts"] = [];
  let text = "";
  let words = 0;
  for (const [at, raw] of segments) {
    const folded = foldWords(raw);
    if (!folded) continue;
    if (text) text += " ";
    starts.push({ offset: text.length, at, words: folded.split(" ") });
    words += starts.at(-1)!.words.length;
    text += folded;
  }
  return { text, padded: pad(text), starts, words };
}

/** The segment a position in the folded transcript falls in. */
function atOffset(t: FoldedTranscript, offset: number): number {
  let lo = 0;
  let hi = t.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t.starts[mid]!.offset <= offset) lo = mid;
    else hi = mid - 1;
  }
  return t.starts[lo]?.at ?? 0;
}

/** The transcript's words near `at` (or all of them when short enough), each with its segment's time. */
function windowOf(t: FoldedTranscript, at: number | undefined): { words: string[]; times: number[] } | null {
  const near = at === undefined ? (t.words <= WHOLE_SEARCH_MAX_WORDS ? t.starts : null) : t.starts.filter((s) => Math.abs(s.at - at) <= NEAR_SECONDS);
  if (!near?.length) return null;
  const words: string[] = [];
  const times: number[] = [];
  for (const s of near) for (const w of s.words) {
    words.push(w);
    times.push(s.at);
  }
  return { words, times };
}

/**
 * Every quote of the reading checked against the words: `verified` (in a caption, title, chapter or transcript — text
 * the reader didn't write — as words, or near its time in the transcript with QUOTE_OVERLAP_MIN of its words),
 * `in_speech` (found only in the reader's own transcription), `not_found`. A field whose quotes were all not found
 * reads as inferred.
 */
export function verifyQuotes(extraction: Extraction, sources: QuoteSources): { extraction: Extraction; results: QuoteResult[] } {
  if (!extraction.moves.some((m) => m.quotes?.length)) return { extraction, results: [] };
  const fixed = [sources.caption, sources.title ?? "", ...(sources.chapters ?? [])].map(foldWords).filter(Boolean).map(pad);
  let folded: FoldedTranscript | null | undefined;
  const transcriptOf = (): FoldedTranscript | null => {
    if (folded !== undefined) return folded;
    const segs = typeof sources.transcript === "function" ? sources.transcript() : sources.transcript;
    folded = segs?.length ? foldTranscript(segs) : null;
    return folded;
  };
  const speech = sources.speech ? pad(foldWords(sources.speech)) : "";
  const speechWords = speech ? speech.trim().split(" ") : [];
  const results: QuoteResult[] = [];

  const moves = extraction.moves.map((m, move) => {
    if (!m.quotes?.length) return m;
    const found = new Map<string, boolean>();
    const quotes = m.quotes.map((q, quote) => {
      const quoted = foldWords(q.text);
      const words = quoted ? quoted.split(" ") : [];
      let check: QuoteCheck = "not_found";
      let at: number | null = q.at ?? null;
      const inFixed = words.length > 0 && fixed.some((f) => hasWords(f, quoted) >= 0);
      const transcript = words.length && !inFixed ? transcriptOf() : null;
      if (words.length) {
        if (inFixed) check = "verified";
        else if (transcript) {
          const i = hasWords(transcript.padded, quoted);
          if (i >= 0) {
            check = "verified";
            at = atOffset(transcript, i);
          } else {
            const win = windowOf(transcript, q.at);
            const j = win ? overlaps(words, win.words) : -1;
            if (win && j >= 0) {
              check = "verified";
              at = win.times[j]!;
            }
          }
        }
        if (check === "not_found" && speech && (hasWords(speech, quoted) >= 0 || overlaps(words, speechWords) >= 0)) check = "in_speech";
      }
      results.push({ move, quote, check, at });
      found.set(q.field, (found.get(q.field) ?? false) || check !== "not_found");
      return { ...q, check };
    });
    const evidence = { ...m.evidence } as Record<string, string | undefined>;
    for (const [field, any] of found) if (!any && EVIDENCE_FIELDS.has(field) && evidence[field] === "stated") evidence[field] = "inferred";
    return { ...m, quotes, evidence: evidence as typeof m.evidence };
  });
  return { extraction: { ...extraction, moves }, results };
}
