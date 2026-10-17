import { EQUIPMENT } from "./equipment.js";
import type { ExerciseRecord } from "./record.js";
import { matchesFilters, searchLibrary, wordRank, type LibraryFilters, type SearchContext } from "./search.js";
import { THEMES } from "./themes.js";
import { CONTRACTIONS, EQUIPMENT_IDS, label, LATERALITY, MUSCLES, PATTERNS, POSITIONS, PURPOSES, REGIONS, ROLES, TAGS, type EquipmentId } from "./vocab.js";

/**
 * THE COACH'S SEARCH (Task 13 fix wave; audit (b) I2, F2). The Studio's `searchLibrary` is a typeahead: every word the
 * athlete types narrows the list, which is right for a person and wrong for an agent that writes lists of what it wants
 * ("hamstring calf stretch" found nothing while each word found dozens). This search, beside the Studio's (which stays
 * as it is):
 *  1. the moves with every word, in the Studio's own order (`searchLibrary`);
 *  2. then the moves with every word once roles, patterns and themes count as words too ("downshift" is a role);
 *  3. then, for a query of more than one word, the moves with SOME of the words — most words first, each naming the
 *     words it has (`matched`), so the coach sees what it got and what it didn't.
 * Small words ("a", "for", "the") never count, and at most MAX_QUERY_WORDS do (the rest are said back, `dropped`); the
 * some-words tier looks each word up once in an index of the library's words (round 2, C1: a turn of searches runs in
 * one request's CPU). Filters and the caller's own yes/no (`ctx.accepts`) hold for every hit.
 *
 * A zero is teachable (`empty`): a word no move says, a filter value no move in the library uses (and, for gear, the
 * gear the moves do use), or filters that each find moves but none together. Moves the caller's yes/no turned away are
 * counted apart (`turnedAway`), never reported as missing from the library.
 *
 * The coach is offered only the filter values some move uses (`offeredValues`); a value the vocabulary keeps but no move
 * uses still reads (an older call, a guess), and answers teachably. `libraryLine` says, from the library itself, how
 * many moves there are and what no move uses, so the coach never promises what the library can't give.
 */

/** The vocabulary filters, each with every value the vocabulary allows. */
export const FACET_VALUES = {
  pattern: PATTERNS,
  region: REGIONS,
  role: ROLES,
  equipment: EQUIPMENT_IDS,
  purpose: PURPOSES,
  tag: TAGS,
  theme: THEMES.map((t) => t.id),
  muscle: MUSCLES,
  contraction: CONTRACTIONS,
  position: POSITIONS,
  laterality: LATERALITY,
} as const satisfies Record<string, readonly string[]>;
export type SearchFacet = keyof typeof FACET_VALUES;
const FACETS = Object.keys(FACET_VALUES) as SearchFacet[];

/** The values a record has for each facet (what `matchesFilters` reads). */
const VALUES_OF: Readonly<Record<SearchFacet, (ex: ExerciseRecord) => readonly string[]>> = {
  pattern: (e) => e.patterns,
  region: (e) => e.regions,
  role: (e) => e.roles,
  equipment: (e) => [...e.equipment.all, ...e.equipment.oneOf],
  purpose: (e) => e.purposes,
  tag: (e) => e.tags,
  theme: (e) => e.themes,
  muscle: (e) => [...e.muscles.primary, ...e.muscles.secondary],
  contraction: (e) => e.contraction,
  position: (e) => [e.position],
  laterality: (e) => [e.laterality],
};

const usedCache = new WeakMap<readonly ExerciseRecord[], Record<SearchFacet, string[]>>();

/** Each facet's values that some record uses, in the vocabulary's order. */
export function usedValues(records: readonly ExerciseRecord[]): Record<SearchFacet, string[]> {
  const cached = usedCache.get(records);
  if (cached) return cached;
  const out = {} as Record<SearchFacet, string[]>;
  for (const facet of FACETS) {
    const seen = new Set(records.flatMap(VALUES_OF[facet]));
    out[facet] = (FACET_VALUES[facet] as readonly string[]).filter((v) => seen.has(v));
  }
  usedCache.set(records, out);
  return out;
}

/** The values the coach is offered for a facet: those some move uses (never a value that can only answer nothing). */
export const offeredValues = (records: readonly ExerciseRecord[], facet: SearchFacet): string[] => usedValues(records)[facet];

// ── Words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Words that say nothing about a move: never counted, never required. */
const SMALL_WORDS = new Set(["a", "an", "and", "or", "the", "for", "with", "without", "to", "of", "in", "on", "at", "my", "some", "any", "into", "from", "by", "no", "not", "me", "i"]);

/**
 * The most query words that count (fix wave 13, round 2, C1): a search's work grows with its words, and a turn of
 * searches runs inside one request's 10 ms of CPU. The rest are said back (`dropped`), never searched.
 */
export const MAX_QUERY_WORDS = 8;

/** The query's words as the coach meant them: lowercase, camelCase split, "lower back" the library's "low back", each
 * once, small words left out. */
export function queryWords(query: string): string[] {
  const words = query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\blower back\b/g, "low back")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !SMALL_WORDS.has(w));
  return [...new Set(words)];
}

const wordsOfId = (s: string): string[] => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
/** A text's words, once per text: the library's ids, labels and gear names repeat across its records. */
const textWords = new Map<string, string[]>();
const wordsOfText = (s: string): string[] => {
  let words = textWords.get(s);
  if (!words) {
    words = wordsOfId(s);
    textWords.set(s, words);
  }
  return words;
};
const THEME_NAME = new Map(THEMES.map((t) => [t.id, t.name]));

// ── The word index (round 2, C1) ────────────────────────────────────────────────────────────────────────────────────
//
// The some-words tier asked the Studio's typo-forgiving `wordRank` for every record and every word: 175 records × 8
// words of word-by-word scans and one-edit tests (1.3–1.7 ms a search). It now looks a word up once in an index of the
// library's words, built once per records array (per isolate for the shipped library): each distinct word, the records
// that say it and how strongly. A word matches a record's word by its start, a plural by its singular (the Studio's
// rule); one that matches none is tried as a one-letter typo against the index's words; only then — for the Studio's
// everyday words ("sore", "abs") — is `wordRank` asked, record by record, for at most MAX_STUDIO_FALLBACK words.

/** Where a word says something, as a rank (the Studio's classes): lower is stronger. */
const NAME = 0;
const CHIP = 10;
const SECONDARY = 20;
const TYPO = 30;
/** A list position past this counts as this (the Studio's emphasis). */
const MAX_EMPHASIS = 9;
/** The words per search the Studio's own `wordRank` is still asked about, record by record, at most. */
const MAX_STUDIO_FALLBACK = 2;
/** Words of five or more letters forgive one typo (the Studio's rule). */
const TYPO_MIN_LETTERS = 5;

interface WordIndex {
  /** Each distinct word → the records (by position) that say it, and how strongly. */
  postings: Map<string, Map<number, number>>;
  /** The index's words, for the prefix and typo scans. */
  words: string[];
}

/** Every word a record says, at its strongest rank: the Studio's fields, and roles, patterns and themes beside them.
 * Once per record. */
const recordCache = new WeakMap<ExerciseRecord, Map<string, number>>();
function recordWords(ex: ExerciseRecord): Map<string, number> {
  const cached = recordCache.get(ex);
  if (cached) return cached;
  const out = new Map<string, number>();
  recordCache.set(ex, out);
  const put = (texts: readonly string[], rank: number): void => {
    for (const t of texts) {
      for (const w of wordsOfText(t)) {
        const held = out.get(w);
        if (held === undefined || rank < held) out.set(w, rank);
      }
    }
  };
  const listed = (ids: readonly string[], base: number): void => ids.forEach((id, i) => put([id, label(id)], base + Math.min(i, MAX_EMPHASIS)));
  put([ex.name], NAME);
  listed(ex.muscles.primary, NAME);
  listed(ex.regions, NAME);
  const gear = [...ex.equipment.all, ...ex.equipment.oneOf];
  put([ex.text.summary, ex.id, ex.family, ...ex.contraction, ...gear, ...gear.map((g) => EQUIPMENT[g])], CHIP);
  for (const ids of [ex.tags, ex.purposes]) put([...ids, ...ids.map(label)], CHIP);
  listed(ex.muscles.secondary, SECONDARY);
  // What the Studio's index leaves out: roles, patterns and themes (ids, labels, a theme's name).
  put([...ex.roles, ...ex.roles.map(label), ...ex.patterns, ...ex.patterns.map(label), ...ex.themes, ...ex.themes.map((t) => THEME_NAME.get(t) ?? t)], CHIP);
  return out;
}

const indexCache = new WeakMap<readonly ExerciseRecord[], WordIndex>();

/** The records' word index, built once per records array. */
function indexOf(records: readonly ExerciseRecord[]): WordIndex {
  const cached = indexCache.get(records);
  if (cached) return cached;
  const postings = new Map<string, Map<number, number>>();
  records.forEach((ex, i) => {
    for (const [w, rank] of recordWords(ex)) {
      const p = postings.get(w) ?? new Map<number, number>();
      p.set(i, rank);
      postings.set(w, p);
    }
  });
  const index = { postings, words: [...postings.keys()] };
  indexCache.set(records, index);
  return index;
}

/** A query word and its singular, by the Studio's rule: "lunges" → "lunge", "presses" → "press"; never a stem under
 * three letters ("toes" is never "to"). */
function variants(w: string): string[] {
  const out = [w];
  const es = w.slice(0, -2);
  if (w.endsWith("es") && es.length >= 3 && /(s|x|z|ch|sh)$/.test(es)) out.push(es);
  const s = w.slice(0, -1);
  if (w.endsWith("s") && s.length >= 3) out.push(s);
  return out;
}

/** Whether two words are at most one edit apart: one letter changed, added or dropped, or two neighbours swapped. */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/**
 * The records that say one query word, and how strongly (by position in `records`): by the start of a word they say (a
 * plural by its singular); else as a one-letter typo of one; else, while `fallback` allows, by the Studio's own
 * `wordRank` (its everyday words: "sore" for what eases, "abs" for the core).
 */
function recordsSaying(records: readonly ExerciseRecord[], index: WordIndex, w: string, fallback: { left: number }): Map<number, number> {
  const out = new Map<number, number>();
  const take = (x: string, floor = 0): void => {
    for (const [i, rank] of index.postings.get(x)!) out.set(i, Math.min(out.get(i) ?? Infinity, Math.max(rank, floor)));
  };
  const vs = variants(w);
  for (const x of index.words) if (vs.some((v) => x.startsWith(v))) take(x);
  if (out.size > 0) return out;
  if (w.length >= TYPO_MIN_LETTERS) for (const x of index.words) if (vs.some((v) => withinOneEdit(v, x))) take(x, TYPO);
  if (out.size > 0 || fallback.left <= 0) return out;
  fallback.left -= 1;
  records.forEach((ex, i) => {
    const rank = wordRank(ex, w);
    if (rank !== null) out.set(i, rank);
  });
  return out;
}

// ── The search ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AgentHit {
  record: ExerciseRecord;
  /** Only on a move with some of the words: the ones it has, in the query's order. */
  matched?: string[];
}

export interface AgentSearch {
  hits: AgentHit[];
  /** The query's words that counted (at most MAX_QUERY_WORDS). */
  words: string[];
  /** The query's words past MAX_QUERY_WORDS: left out, never searched. */
  dropped: string[];
  /** How many hits have every word (they come first). */
  allWords: number;
  /** With no hit: what emptied it, in plain words. */
  empty: string[];
  /** Moves the words and filters found that the caller's own yes/no (`ctx.accepts`) turned away. */
  turnedAway: number;
}

const byName = new Intl.Collator("en");

/** The coach's search: every word first, then some of the words (see the module comment). */
export function agentSearch(records: readonly ExerciseRecord[], query: string, filters: LibraryFilters = {}, ctx: SearchContext = {}): AgentSearch {
  const all = queryWords(query);
  const words = all.slice(0, MAX_QUERY_WORDS);
  const dropped = all.slice(MAX_QUERY_WORDS);
  const cleaned = words.join(" ");
  const studio = searchLibrary(records, cleaned, filters, ctx);
  const hits: AgentHit[] = studio.map((record) => ({ record }));
  if (words.length > 0) {
    const taken = new Set(studio.map((e) => e.id));
    const fit = ctx.fit ?? (() => 0);
    const boost = ctx.boost ?? (() => 0);
    // Each word looked up once in the index (see "The word index"), never record by record.
    const index = indexOf(records);
    const fallback = { left: MAX_STUDIO_FALLBACK };
    const saying = words.map((w) => recordsSaying(records, index, w, fallback));
    const scored: Array<{ ex: ExerciseRecord; said: string[]; rank: number; fit: number; boost: number }> = [];
    records.forEach((ex, i) => {
      if (taken.has(ex.id)) return;
      let rank = 0;
      const said: string[] = [];
      words.forEach((w, k) => {
        const r = saying[k]!.get(i);
        if (r === undefined) return;
        said.push(w);
        rank += r;
      });
      if (said.length === 0 || !matchesFilters(ex, filters) || (ctx.accepts && !ctx.accepts(ex))) return;
      scored.push({ ex, said, rank, fit: fit(ex), boost: boost(ex.id) });
    });
    scored.sort(
      (a, b) =>
        b.said.length - a.said.length || a.rank - b.rank || a.fit - b.fit || b.boost - a.boost || byName.compare(a.ex.name, b.ex.name) || (a.ex.id < b.ex.id ? -1 : a.ex.id > b.ex.id ? 1 : 0),
    );
    for (const s of scored) hits.push(s.said.length === words.length ? { record: s.ex } : { record: s.ex, matched: s.said });
  }
  const allWords = hits.filter((h) => !h.matched).length;
  if (hits.length > 0) return { hits, words, dropped, allWords, empty: [], turnedAway: 0 };

  // Nothing: was it the caller's yes/no, or the words and filters themselves?
  const unchecked = ctx.accepts ? agentSearch(records, query, filters, { ...ctx, accepts: undefined }).hits.length : 0;
  if (unchecked > 0) return { hits, words, dropped, allWords: 0, empty: [], turnedAway: unchecked };
  return { hits, words, dropped, allWords: 0, empty: whyEmpty(records, words, filters), turnedAway: 0 };
}

/** A gear's name in a sentence: "a barbell", "machines", "dumbbells". */
function gearWords(id: string): string {
  const name = (EQUIPMENT[id as EquipmentId] ?? id).toLowerCase();
  return name.endsWith("s") ? name : `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;
}

/** "a, b or c". */
const either = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** What no move doing `values` of a facet would be, after "no move in the library" / "none". */
function facetPhrase(facet: SearchFacet, values: readonly string[]): string {
  switch (facet) {
    case "equipment":
      return `uses ${either(values.map(gearWords))}`;
    case "pattern":
      return `is ${either(values.map((v) => `${label(v).toLowerCase()} (${v})`))}`;
    case "region":
      return `trains the ${either(values)}`;
    case "role":
      return `has the role ${either(values)}`;
    case "purpose":
      return `is for ${either(values)}`;
    case "tag":
      return `is tagged ${either(values)}`;
    case "theme":
      return `belongs to the theme ${either(values)}`;
    case "muscle":
      return `works the ${either(values)}`;
    case "contraction":
      return `is ${either(values)} work`;
    case "position":
      return `is done ${either(values)}`;
    case "laterality":
      return `is ${either(values)}`;
  }
}

/** The facet value no move uses that a word names ("barbell", "machines"), if any: a word naming gear or a pattern the
 * library lacks is answered as that, not as an unknown word. */
function deadValueNamed(used: Record<SearchFacet, string[]>, w: string): { facet: SearchFacet; value: string } | null {
  const fs = variants(w);
  for (const facet of LINE_FACETS) {
    for (const value of FACET_VALUES[facet] as readonly string[]) {
      if (used[facet].includes(value)) continue;
      const names = [...wordsOfId(value), ...wordsOfId(facet === "equipment" ? (EQUIPMENT[value as EquipmentId] ?? value) : label(value))];
      if (fs.some((f) => names.includes(f))) return { facet, value };
    }
  }
  return null;
}

function whyEmpty(records: readonly ExerciseRecord[], words: readonly string[], filters: LibraryFilters): string[] {
  const out: string[] = [];
  const used = usedValues(records);
  const index = indexOf(records);
  // Only on a zero, and every word is asked about: a word the Studio forgives is never called unknown.
  const fallback = { left: words.length };
  for (const w of words) {
    if (recordsSaying(records, index, w, fallback).size > 0) continue;
    const dead = deadValueNamed(used, w);
    out.push(dead ? `no move in the library ${facetPhrase(dead.facet, [dead.value])} ("${w}")` : `no move says "${w}"`);
  }
  for (const facet of FACETS) {
    const v = filters[facet];
    if (v === undefined) continue;
    if (!used[facet].includes(v)) {
      const instead = facet === "equipment" ? ` — the library's moves use: ${used.equipment.map((g) => (EQUIPMENT[g as EquipmentId] ?? g).toLowerCase()).join(", ")}` : "";
      out.push(`no move in the library ${facetPhrase(facet, [v])}${instead}`);
    }
  }
  if (filters.maxDifficulty !== undefined && !records.some((ex) => ex.difficulty <= filters.maxDifficulty!)) out.push(`no move is that easy (difficulty ${filters.maxDifficulty} or less)`);
  if (out.length === 0) out.push("each word and filter finds moves on its own, but none has them all: drop a filter, or search by one word at a time");
  return out;
}

/** What no move in the library does, said from the library itself (it stays true as moves are added): the gear, the
 * patterns, the purposes and the positions no move uses. */
const LINE_FACETS: readonly SearchFacet[] = ["equipment", "pattern", "purpose", "position"];

export function libraryLine(records: readonly ExerciseRecord[]): string {
  const used = usedValues(records);
  const none = LINE_FACETS.flatMap((facet) => {
    const missing = (FACET_VALUES[facet] as readonly string[]).filter((v) => !used[facet].includes(v));
    return missing.length ? [`none ${facetPhrase(facet, missing)}`] : [];
  });
  return `library: ${records.length} moves${none.length ? `; ${none.join("; ")}` : ""}`;
}
