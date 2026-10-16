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
 * Small words ("a", "for", "the") never count. Filters and the caller's own yes/no (`ctx.accepts`) hold for every hit.
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
const THEME_NAME = new Map(THEMES.map((t) => [t.id, t.name]));

/** The words the Studio's index leaves out: roles, patterns and themes (ids, labels, a theme's name). Cached. */
const extraCache = new WeakMap<ExerciseRecord, readonly string[]>();
function extraWords(ex: ExerciseRecord): readonly string[] {
  const cached = extraCache.get(ex);
  if (cached) return cached;
  const texts = [...ex.roles, ...ex.roles.map(label), ...ex.patterns, ...ex.patterns.map(label), ...ex.themes, ...ex.themes.map((t) => THEME_NAME.get(t) ?? t)];
  const words = [...new Set(texts.flatMap(wordsOfId))];
  extraCache.set(ex, words);
  return words;
}

/** A query word and its singular ("stretches" → "stretch"), for the extra words. */
const forms = (w: string): string[] => [w, ...(w.endsWith("es") && w.length >= 5 ? [w.slice(0, -2)] : []), ...(w.endsWith("s") && w.length >= 4 ? [w.slice(0, -1)] : [])];

/** How strongly the record says one word (lower is stronger; the Studio's ranks, a role, pattern or theme as a tag's);
 * null when it doesn't say it. */
const EXTRA_RANK = 10;
function rankOf(ex: ExerciseRecord, w: string): number | null {
  const studio = wordRank(ex, w);
  if (studio !== null) return studio;
  const fs = forms(w);
  return extraWords(ex).some((x) => fs.some((f) => x.startsWith(f))) ? EXTRA_RANK : null;
}

// ── The search ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AgentHit {
  record: ExerciseRecord;
  /** Only on a move with some of the words: the ones it has, in the query's order. */
  matched?: string[];
}

export interface AgentSearch {
  hits: AgentHit[];
  /** The query's words that counted. */
  words: string[];
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
  const words = queryWords(query);
  const cleaned = words.join(" ");
  const studio = searchLibrary(records, cleaned, filters, ctx);
  const hits: AgentHit[] = studio.map((record) => ({ record }));
  if (words.length > 0) {
    const taken = new Set(studio.map((e) => e.id));
    const fit = ctx.fit ?? (() => 0);
    const boost = ctx.boost ?? (() => 0);
    const scored: Array<{ ex: ExerciseRecord; said: string[]; rank: number; fit: number; boost: number }> = [];
    for (const ex of records) {
      if (taken.has(ex.id) || !matchesFilters(ex, filters) || (ctx.accepts && !ctx.accepts(ex))) continue;
      let rank = 0;
      const said: string[] = [];
      for (const w of words) {
        const r = rankOf(ex, w);
        if (r === null) continue;
        said.push(w);
        rank += r;
      }
      if (said.length === 0) continue;
      scored.push({ ex, said, rank, fit: fit(ex), boost: boost(ex.id) });
    }
    scored.sort(
      (a, b) =>
        b.said.length - a.said.length || a.rank - b.rank || a.fit - b.fit || b.boost - a.boost || byName.compare(a.ex.name, b.ex.name) || (a.ex.id < b.ex.id ? -1 : a.ex.id > b.ex.id ? 1 : 0),
    );
    for (const s of scored) hits.push(s.said.length === words.length ? { record: s.ex } : { record: s.ex, matched: s.said });
  }
  const allWords = hits.filter((h) => !h.matched).length;
  if (hits.length > 0) return { hits, words, allWords, empty: [], turnedAway: 0 };

  // Nothing: was it the caller's yes/no, or the words and filters themselves?
  const unchecked = ctx.accepts ? agentSearch(records, query, filters, { ...ctx, accepts: undefined }).hits.length : 0;
  if (unchecked > 0) return { hits, words, allWords: 0, empty: [], turnedAway: unchecked };
  return { hits, words, allWords: 0, empty: whyEmpty(records, words, filters), turnedAway: 0 };
}

/** A gear's name in a sentence: "a barbell", "machines", "dumbbells". */
function gearWords(id: string): string {
  const name = (EQUIPMENT[id as EquipmentId] ?? id).toLowerCase();
  return name.endsWith("s") ? name : `${/^[aeiou]/.test(name) ? "an" : "a"} ${name}`;
}

/** "a, b or c". */
const either = (xs: readonly string[]): string => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

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
  const fs = forms(w);
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
  for (const w of words) {
    if (records.some((ex) => rankOf(ex, w) !== null)) continue;
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
