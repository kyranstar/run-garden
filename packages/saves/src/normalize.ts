import { asciiFold } from "./ids.js";

const STOP = new Set(["the", "a", "an", "with", "your"]);

const singular = (w: string): string => {
  if (w.length > 3 && w.endsWith("es") && /(?:ch|sh|x|s|z)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
};

/** A move name in a form that spellings of the same move share. */
export function normalizeMoveName(name: string): string {
  return asciiFold(name)
    .toLowerCase()
    .replace(/[/\-_]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map(singular)
    .join(" ");
}

export interface NearMove { name: string; load: string | null; doseType: string | null }
export interface NearCandidate extends NearMove { id: string }

/** False only when both loads are present and differ, or both dose types are present and differ. */
export function sameMoveType(a: NearMove, b: NearMove): boolean {
  if (a.load !== null && b.load !== null && a.load !== b.load) return false;
  if (a.doseType !== null && b.doseType !== null && a.doseType !== b.doseType) return false;
  return true;
}

const wordSet = (name: string): Set<string> =>
  new Set(normalizeMoveName(name).split(" ").map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean));

/** The pool's nearest move to this one by name (most shared words; ties keep pool order), or null. */
export function nearDuplicateOf(move: NearMove, pool: readonly NearCandidate[]): NearCandidate | null {
  const norm = normalizeMoveName(move.name);
  const a = wordSet(move.name);
  let best: NearCandidate | null = null;
  let bestS = -1;
  for (const c of pool) {
    const b = wordSet(c.name);
    let s = 0;
    for (const w of a) if (b.has(w)) s++;
    const near =
      normalizeMoveName(c.name) === norm ||
      (s >= 2 && Math.max(a.size, b.size) - s <= 2 && Math.min(a.size, b.size) - s <= 1);
    if (near && s > bestS) { best = c; bestS = s; }
  }
  return best;
}
