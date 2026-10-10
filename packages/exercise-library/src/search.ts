import type { ExerciseRecord } from "./record.js";

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

/** 0 exact name, 1 name prefix, 2 name/summary/tag/id/family contains, null no match. An empty query matches all (3). */
export function textTier(ex: ExerciseRecord, query: string): 0 | 1 | 2 | 3 | null {
  const q = query.trim().toLowerCase();
  if (q === "") return 3;
  const name = ex.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if ([name, ex.id, ex.family, ex.text.summary, ...ex.tags].some(s => s.toLowerCase().includes(q))) return 2;
  return null;
}

/**
 * The records that match the query and filters, best first: exact name, name prefix, contains (name, summary, tags),
 * then everything else that matched; ties by condition fit, then name (then id).
 */
export function searchLibrary(records: readonly ExerciseRecord[], query: string, filters: LibraryFilters = {}, ctx: SearchContext = {}): ExerciseRecord[] {
  const scored: Array<{ ex: ExerciseRecord; tier: number; fit: number }> = [];
  for (const ex of records) {
    const tier = textTier(ex, query);
    if (tier === null || !matchesFilters(ex, filters) || (ctx.accepts && !ctx.accepts(ex))) continue;
    scored.push({ ex, tier, fit: ctx.fit ? ctx.fit(ex) : 0 });
  }
  scored.sort((a, b) => a.tier - b.tier || a.fit - b.fit || byName.compare(a.ex.name, b.ex.name) || (a.ex.id < b.ex.id ? -1 : a.ex.id > b.ex.id ? 1 : 0));
  return scored.map(s => s.ex);
}
