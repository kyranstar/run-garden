import { EQUIPMENT } from "./equipment.js";
import type { ExerciseRecord } from "./record.js";
import { label } from "./vocab.js";

// One collator so the server and the offline Studio order names identically whatever the device's locale.
const byName = new Intl.Collator("en");

// Library search: the pure filter and ranking the library route and the Studio share (server and offline client rank
// identically). No storage in here: what depends on the athlete (condition fit, a place's gear) comes in through `ctx`.

export interface LibraryFilters {
  pattern?: string;
  region?: string;
  role?: string;
  /** A piece of gear the move uses (all or one-of). */
  equipment?: string;
  purpose?: string;
  tag?: string;
  theme?: string;
  /** A muscle the move works, primary or secondary. */
  muscle?: string;
  contraction?: string;
  position?: string;
  laterality?: string;
  maxDifficulty?: number;
}

export interface SearchContext {
  /** Condition fit for tie-breaks: lower is better (0 fits everything). Default: all equal. */
  fit?: (ex: ExerciseRecord) => number;
  /** An extra yes/no the caller owns (a place's gear, "safe on a flare day"). */
  accepts?: (ex: ExerciseRecord) => boolean;
  /** The athlete's own lean (their rating, a pin) for tie-breaks after the fit: higher first. Default: all equal. */
  boost?: (id: string) => number;
}

/** Whether a record passes every filter given (the text query is separate). */
export function matchesFilters(ex: ExerciseRecord, f: LibraryFilters): boolean {
  if (f.pattern && !ex.patterns.includes(f.pattern as never)) return false;
  if (f.region && !ex.regions.includes(f.region as never)) return false;
  if (f.role && !ex.roles.includes(f.role as never)) return false;
  if (f.equipment && ![...ex.equipment.all, ...ex.equipment.oneOf].includes(f.equipment as never)) return false;
  if (f.purpose && !ex.purposes.includes(f.purpose as never)) return false;
  if (f.tag && !ex.tags.includes(f.tag as never)) return false;
  if (f.theme && !ex.themes.includes(f.theme)) return false;
  if (f.muscle && ![...ex.muscles.primary, ...ex.muscles.secondary].includes(f.muscle as never)) return false;
  if (f.contraction && !ex.contraction.includes(f.contraction as never)) return false;
  if (f.position && ex.position !== f.position) return false;
  if (f.laterality && ex.laterality !== f.laterality) return false;
  if (f.maxDifficulty !== undefined && ex.difficulty > f.maxDifficulty) return false;
  return true;
}

/** Words of five or more letters forgive one typo (Stage 2 spec §4). */
const TYPO_MIN_LETTERS = 5;

/**
 * What a sore or tight area asks for: a stretch, passive work (release, massage, a relaxed hold) or recovery — what
 * eases it, never what loads it. "Sore calves" finds the calf stretches and the release, not the calf raises; "tight
 * calves" never a hop.
 */
const EASING: readonly string[] = ["stretch", "passive", "recovery"];

/**
 * Everyday words for the vocabulary's: a query word standing for another, or for any of a few. "achilles": the tendon
 * of the calves; "lower" (back): the library's "low back" (and still every word "lower" starts).
 */
const ALIASES: Readonly<Record<string, string | readonly string[]>> = {
  calf: "calves", ab: "core", abs: "core", ham: "hamstrings", hammies: "hamstrings", butt: "glutes", bum: "glutes",
  delts: "deltoids", shin: "tibialis", shins: "tibialis", tspine: "thoracic", achilles: "calves", lower: "low",
  sore: EASING, soreness: EASING, tight: EASING,
};
const hasAlias = (w: string): boolean => Object.prototype.hasOwnProperty.call(ALIASES, w);

/**
 * Where a word of the record says something, as a rank: lower is stronger. The class (tens) says which field: 0 the
 * name, a primary muscle or a region; 1 a tag, purpose, contraction, the gear, the card line or the id; 2 a secondary
 * muscle; 3 a typo only. The units say how central it is: a primary muscle's or a region's place in its list.
 */
const NAME = 0;
const STRONG = 0;
const CHIP = 10;
const SECONDARY = 20;
const TYPO = 30;
/** A list position past this counts as this. */
const MAX_EMPHASIS = 9;

/** Lowercase words: camelCase ids split ("gobletSquat" → goblet, squat), anything not a letter or digit separates. */
function wordsOf(s: string): string[] {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Whether two words are at most one edit apart: one letter changed, added or dropped, or two neighbours swapped
 * ("gobelt" → "goblet").
 */
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
 * Whether `q` appears in `text` at the start of a word ("arm" in "one arm", never in "warm"); `whole` also wants it to
 * end a word, a plural forgiven ("arm" in "both arms", not in "armpit").
 */
function atWordStart(text: string, q: string, whole = false): boolean {
  for (let i = text.indexOf(q); i >= 0; i = text.indexOf(q, i + 1)) {
    if (i > 0 && /[a-z0-9]/.test(text[i - 1]!)) continue;
    if (!whole || /^(e?s)?(?![a-z0-9])/.test(text.slice(i + q.length))) return true;
  }
  return false;
}

/** Every word a record says anything with, at its strongest rank. Cached per record. */
const haystacks = new WeakMap<ExerciseRecord, ReadonlyMap<string, number>>();
function wordsOfRecord(ex: ExerciseRecord): ReadonlyMap<string, number> {
  const cached = haystacks.get(ex);
  if (cached) return cached;
  const words = new Map<string, number>();
  const put = (texts: readonly string[], rank: number): void => {
    for (const w of texts.flatMap(wordsOf)) words.set(w, Math.min(words.get(w) ?? Infinity, rank));
  };
  const listed = (ids: readonly string[], base: number): void =>
    ids.forEach((id, i) => put([id, label(id)], base + Math.min(i, MAX_EMPHASIS)));
  put([ex.name], NAME);
  listed(ex.muscles.primary, STRONG);
  listed(ex.regions, STRONG);
  const gear = [...ex.equipment.all, ...ex.equipment.oneOf];
  put([ex.text.summary, ex.id, ex.family, ...ex.contraction, ...gear, ...gear.map(g => EQUIPMENT[g])], CHIP);
  for (const ids of [ex.tags, ex.purposes]) put([...ids, ...ids.map(label)], CHIP);
  listed(ex.muscles.secondary, SECONDARY);
  haystacks.set(ex, words);
  return words;
}

/** A singular keeps at least this many letters ("toes" is never "to"). */
const MIN_STEM = 3;

/**
 * A query word and its singular — or, for an everyday word, the vocabulary word it stands for instead. The plural is
 * forgiven only when the word left keeps three letters: a trailing "s" ("lunges" → "lunge", "toes" → "toe"), and "es"
 * only after s, x, z, ch or sh ("presses" → "press", "boxes" → "box").
 */
function variants(w: string): string[] {
  // Own keys only: a query word like "constructor" is no alias. (Not Object.hasOwn: older phones' browsers lack it.)
  const alias = hasAlias(w) ? ALIASES[w] : undefined;
  if (alias !== undefined) return typeof alias === "string" ? [alias] : [...alias];
  const out = [w];
  const es = w.slice(0, -2);
  if (w.endsWith("es") && es.length >= MIN_STEM && /(s|x|z|ch|sh)$/.test(es)) out.push(es);
  const s = w.slice(0, -1);
  if (w.endsWith("s") && s.length >= MIN_STEM) out.push(s);
  return out;
}

/** The strongest rank at which the record says this query word, or null. */
function rankOfWord(words: ReadonlyMap<string, number>, w: string): number | null {
  let best: number | null = null;
  const vs = variants(w);
  for (const [x, rank] of words) if (vs.some(v => x.startsWith(v)) && (best === null || rank < best)) best = rank;
  if (best !== null) return best;
  if (w.length < TYPO_MIN_LETTERS) return null;
  for (const x of words.keys()) if (vs.some(v => withinOneEdit(v, x))) return TYPO;
  return null;
}

/**
 * How well the record says every word of the query (the any-field tier): the weakest word decides; null when a word
 * is missing. Lower is better: see the ranks above.
 */
export function wordRank(ex: ExerciseRecord, query: string): number | null {
  const qs = wordsOf(query);
  if (qs.length === 0) return null;
  const words = wordsOfRecord(ex);
  let worst = 0;
  for (const w of qs) {
    const r = rankOfWord(words, w);
    if (r === null) return null;
    worst = Math.max(worst, r);
  }
  return worst;
}

export type TextTier = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * How the record meets the query (Stage 2 spec §4), best first: 0 the name is the query; 1 the name starts with it;
 * 2 a word of the name starts with it; 3 the name contains it; 4 the card line or a tag says it as whole words (a
 * plural forgiven); 5 every word of the query starts a word the record says anywhere — name, card line, id, tags, purposes,
 * contraction, muscles, regions, gear (ids and labels), in any order, plurals and everyday words ("calf", "abs"; "sore"
 * for what eases) forgiven, a word of five or more letters forgiving one typo (ranked inside the tier by `wordRank`);
 * null no match.
 * An empty query matches all (5).
 */
export function textTier(ex: ExerciseRecord, query: string): TextTier | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 5;
  const name = ex.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (atWordStart(name, q)) return 2;
  if (name.includes(q)) return 3;
  if (atWordStart(ex.text.summary.toLowerCase(), q, true) || ex.tags.some(t => atWordStart(t, q, true) || atWordStart(label(t).toLowerCase(), q, true))) return 4;
  return wordRank(ex, q) === null ? null : 5;
}

/**
 * The records that match the query and filters, best first: by `textTier`, inside the any-field tier by `wordRank`
 * (a primary muscle or region, then a tag, purpose or gear, then a secondary muscle, then a typo); ties by condition
 * fit for today, then the athlete's own lean (`boost`), then name (then id).
 */
export function searchLibrary(records: readonly ExerciseRecord[], query: string, filters: LibraryFilters = {}, ctx: SearchContext = {}): ExerciseRecord[] {
  const scored: Array<{ ex: ExerciseRecord; tier: number; rank: number; fit: number; boost: number }> = [];
  const q = query.trim();
  for (const ex of records) {
    const tier = textTier(ex, q);
    if (tier === null || !matchesFilters(ex, filters) || (ctx.accepts && !ctx.accepts(ex))) continue;
    const rank = tier === 5 && q !== "" ? wordRank(ex, q)! : 0;
    scored.push({ ex, tier, rank, fit: ctx.fit ? ctx.fit(ex) : 0, boost: ctx.boost ? ctx.boost(ex.id) : 0 });
  }
  scored.sort((a, b) =>
    a.tier - b.tier || a.rank - b.rank || a.fit - b.fit || b.boost - a.boost || byName.compare(a.ex.name, b.ex.name) || (a.ex.id < b.ex.id ? -1 : a.ex.id > b.ex.id ? 1 : 0));
  return scored.map(s => s.ex);
}
