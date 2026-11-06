import type { Extraction, QuoteCheck } from "./schemas.js";
import type { Segment } from "./transcript.js";

// QUOTE VERIFICATION (design 2026-11-05 §5.6, deterministic): a reading's quotes are the creator's words only when the
// words are there. Run by the Worker after the parse; the check it writes replaces any the model wrote.

const ASCII = /^[\x00-\x7f]*$/;

/** Case, accents, punctuation and spacing folded away: "Café—LIFT, now!" is "cafe lift now". Any script's letters stay. */
export function foldWords(s: string): string {
  // Plain ASCII needs no accent folding, and a byte-class regex is several times cheaper (final audit G1).
  if (ASCII.test(s)) return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
/** A transcript longer than this, in words, is searched only for a time-less quote's exact words (CPU: the Worker has 10 ms). */
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
  /** Counts the work done (tests of its bound). */
  meter?: QuoteMeter;
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

/** A text's folded words: one match for plain ASCII (the common case, and the cheap one), else `foldWords`. */
function foldTokens(s: string): string[] {
  if (ASCII.test(s)) return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const f = foldWords(s);
  return f ? f.split(" ") : [];
}

/** The work a check did, for the CPU bound's tests: characters of transcript folded, words compared. */
export interface QuoteMeter {
  foldedChars: number;
  scannedWords: number;
}

/** The most windows one quote with no time may try against the whole transcript: its work stays bounded (G1). */
const CANDIDATES_MAX = 400;

/** The words of `words` from `start` are `quote`, in order. */
function sequenceAt(words: readonly string[], start: number, quote: readonly string[]): boolean {
  if (start < 0 || start + quote.length > words.length) return false;
  for (let k = 0; k < quote.length; k++) if (words[start + k] !== quote[k]) return false;
  return true;
}

/** Where `quote` starts in `words`, in order, else -1. */
function findSequence(words: readonly string[], quote: readonly string[]): number {
  const first = quote[0];
  for (let i = 0; i + quote.length <= words.length; i++) if (words[i] === first && sequenceAt(words, i, quote)) return i;
  return -1;
}

/** How many of `quote`'s words (as a multiset) the window of its length from `start` holds. */
function hitsAt(words: readonly string[], start: number, quote: readonly string[]): number {
  const want = new Map<string, number>();
  for (const w of quote) want.set(w, (want.get(w) ?? 0) + 1);
  let hits = 0;
  for (let k = start; k < start + quote.length && k < words.length; k++) {
    const left = want.get(words[k]!);
    if (left) {
      hits++;
      want.set(words[k]!, left - 1);
    }
  }
  return hits;
}

/**
 * THE TRANSCRIPT, read only where a quote needs it (final audit G1: checking every quote against the whole of a long
 * transcript cost the Worker tens of milliseconds after the paid call). A segment is folded once, when a window near a
 * quote's time first takes it; the whole is folded (once) and indexed by word only for quotes with no time.
 */
class TranscriptIndex {
  private readonly segs: readonly Segment[];
  private readonly folded: (string[] | undefined)[];
  private wholeOf: { words: string[]; times: number[]; postings: Map<string, number[]> } | null = null;
  /** Where each segment's words start in the whole's arrays (once built), so a window is a slice, not a copy. */
  private segStart: Int32Array | null = null;

  constructor(segments: readonly Segment[], private readonly meter: QuoteMeter) {
    // A transcript comes in time order; one that doesn't is put in it once.
    let ordered = true;
    for (let i = 1; i < segments.length; i++) if (segments[i]![0] < segments[i - 1]![0]) ordered = false;
    this.segs = ordered ? segments : [...segments].sort((a, b) => a[0] - b[0]);
    this.folded = new Array(this.segs.length);
  }

  private seg(i: number): string[] {
    let w = this.folded[i];
    if (!w) {
      const raw = this.segs[i]![1];
      this.meter.foldedChars += raw.length;
      w = foldTokens(raw);
      this.folded[i] = w;
    }
    return w;
  }

  /** The first segment starting at or after `t`. */
  private lower(t: number): number {
    let lo = 0;
    let hi = this.segs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.segs[mid]![0] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The words within NEAR_SECONDS of `at`, each with its segment's time. */
  near(at: number): { words: string[]; times: number[] } {
    const from = this.lower(at - NEAR_SECONDS);
    if (this.wholeOf && this.segStart) {
      let to = from;
      while (to < this.segs.length && this.segs[to]![0] <= at + NEAR_SECONDS) to++;
      const a = this.segStart[from]!;
      const b = this.segStart[to]!;
      return { words: this.wholeOf.words.slice(a, b), times: this.wholeOf.times.slice(a, b) };
    }
    const words: string[] = [];
    const times: number[] = [];
    for (let i = from; i < this.segs.length && this.segs[i]![0] <= at + NEAR_SECONDS; i++) {
      for (const w of this.seg(i)) {
        words.push(w);
        times.push(this.segs[i]![0]);
      }
    }
    return { words, times };
  }

  /**
   * Every word once, with the places of the words `needed` (the time-less quotes' words): built once, the first time
   * a quote with no time needs it, from the segments' own folds (shared with the windows near a quote's time).
   */
  whole(needed: ReadonlySet<string>): { words: string[]; times: number[]; postings: Map<string, number[]> } {
    if (this.wholeOf) return this.wholeOf;
    const words: string[] = [];
    const times: number[] = [];
    const postings = new Map<string, number[]>();
    const segStart = new Int32Array(this.segs.length + 1);
    for (let i = 0; i < this.segs.length; i++) {
      segStart[i] = words.length;
      const at = this.segs[i]![0];
      for (const w of this.seg(i)) {
        if (needed.has(w)) {
          let list = postings.get(w);
          if (!list) postings.set(w, (list = []));
          list.push(words.length);
        }
        words.push(w);
        times.push(at);
      }
    }
    segStart[this.segs.length] = words.length;
    this.segStart = segStart;
    this.wholeOf = { words, times, postings };
    return this.wholeOf;
  }

  /** A quote near its time: its words in order, else QUOTE_OVERLAP_MIN of them in a window of its length. */
  findNear(quote: readonly string[], at: number): number | null {
    const win = this.near(at);
    this.meter.scannedWords += win.words.length;
    const e = findSequence(win.words, quote);
    if (e >= 0) return win.times[e]!;
    const j = overlaps(quote, win.words);
    return j >= 0 ? win.times[j]! : null;
  }

  /**
   * A quote with no time: its words in order anywhere (from the places of its rarest word), and — when the transcript
   * is short enough — QUOTE_OVERLAP_MIN of them in a window (from the places of its few rarest words), at most
   * CANDIDATES_MAX windows tried.
   */
  findAnywhere(quote: readonly string[], needed: ReadonlySet<string>): number | null {
    const { words, times, postings } = this.whole(needed);
    const distinct = [...new Set(quote)].sort((a, b) => (postings.get(a)?.length ?? 0) - (postings.get(b)?.length ?? 0));
    const rarest = distinct.find((w) => postings.has(w));
    if (rarest === undefined) return null;
    const k = quote.indexOf(rarest);
    let tried = 0;
    for (const p of postings.get(rarest)!) {
      if (++tried > CANDIDATES_MAX) break;
      this.meter.scannedWords += quote.length;
      if (sequenceAt(words, p - k, quote)) return times[p - k]!;
    }
    if (words.length > WHOLE_SEARCH_MAX_WORDS) return null;
    const need = Math.ceil(quote.length * QUOTE_OVERLAP_MIN);
    const missing = quote.length - need;
    const seen = new Set<number>();
    tried = 0;
    for (const w of distinct.filter((x) => postings.has(x)).slice(0, missing + 1)) {
      for (const p of postings.get(w)!) {
        for (let s = Math.max(0, p - quote.length + 1); s <= p; s++) {
          if (seen.has(s)) continue;
          seen.add(s);
          if (++tried > CANDIDATES_MAX) return null;
          this.meter.scannedWords += quote.length;
          if (hitsAt(words, s, quote) >= need) return times[s]!;
        }
      }
    }
    return null;
  }
}

/**
 * Every quote of the reading checked against the words: `verified` (in a caption, title, chapter or transcript — text
 * the reader didn't write — as words, or near its time in the transcript with QUOTE_OVERLAP_MIN of its words),
 * `in_speech` (found only in the reader's own transcription), `on_screen` (text the reader says the video shows, which
 * no source here holds: unchecked, never proof), `not_found`. A field whose quotes were all not found reads as inferred.
 */
export function verifyQuotes(extraction: Extraction, sources: QuoteSources): { extraction: Extraction; results: QuoteResult[] } {
  if (!extraction.moves.some((m) => m.quotes?.length)) return { extraction, results: [] };
  const meter = sources.meter ?? { foldedChars: 0, scannedWords: 0 };
  const fixed = [sources.caption, sources.title ?? "", ...(sources.chapters ?? [])].map(foldWords).filter(Boolean).map(pad);
  let index: TranscriptIndex | null | undefined;
  const transcriptOf = (): TranscriptIndex | null => {
    if (index !== undefined) return index;
    const segs = typeof sources.transcript === "function" ? sources.transcript() : sources.transcript;
    index = segs?.length ? new TranscriptIndex(segs, meter) : null;
    // A time-less quote needs the whole once: built first, every window is then a slice of it.
    if (index && needed.size) index.whole(needed);
    return index;
  };
  const speech = sources.speech ? pad(foldWords(sources.speech)) : "";
  const speechWords = speech ? speech.trim().split(" ") : [];
  const results: QuoteResult[] = [];
  // The words the time-less quotes need indexed: the whole transcript's index holds only those.
  const needed = new Set<string>();
  for (const m of extraction.moves) for (const q of m.quotes ?? []) if (q.at === undefined) for (const w of foldWords(q.text).split(" ")) if (w) needed.add(w);

  const moves = extraction.moves.map((m, move) => {
    if (!m.quotes?.length) return m;
    const found = new Map<string, boolean>();
    const quotes = m.quotes.map((q, quote) => {
      const quoted = foldWords(q.text);
      const words = quoted ? quoted.split(" ") : [];
      let check: QuoteCheck = "not_found";
      let at: number | null = q.at ?? null;
      if (words.length) {
        if (fixed.some((f) => hasWords(f, quoted) >= 0)) check = "verified";
        else {
          const transcript = transcriptOf();
          const where = transcript ? (q.at !== undefined ? transcript.findNear(words, q.at) : transcript.findAnywhere(words, needed)) : null;
          if (where !== null) {
            check = "verified";
            at = where;
          }
        }
        if (check === "not_found" && speech && (hasWords(speech, quoted) >= 0 || overlaps(words, speechWords) >= 0)) check = "in_speech";
      }
      // Text the video shows: no source here holds it, so it is neither proof nor a reader's invention (G7).
      if (check === "not_found" && q.from === "screen" && words.length) check = "on_screen";
      results.push({ move, quote, check, at });
      // Words the app checked (or the reader heard) back a field; an on-screen quote, unchecked, does not — a field it
      // alone supports is the reader's guess (audit 2026-11-06, I9).
      found.set(q.field, (found.get(q.field) ?? false) || (check !== "not_found" && check !== "on_screen"));
      return { ...q, check };
    });
    const evidence = { ...m.evidence } as Record<string, string | undefined>;
    for (const [field, any] of found) if (!any && EVIDENCE_FIELDS.has(field) && evidence[field] === "stated") evidence[field] = "inferred";
    return { ...m, quotes, evidence: evidence as typeof m.evidence };
  });
  return { extraction: { ...extraction, moves }, results };
}
