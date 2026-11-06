/**
 * READ IT AGAIN (design 2026-11-05 §6.6; phase 5a): an old post read again under the current prompt, at the owner's tap.
 *
 * A post's links, their provenance, the corrections made to it and the coach's memory of its notes are all keyed by a
 * move's POSITION in the post's reading. So a re-read of a post that already has links is never stored as it came: it
 * is lined up with them first (`alignReading`) — each linked move found again goes back to its link's position, the
 * approved corrections to the reading are applied again on top, the notes Save put in the coach's memory are kept, and
 * moves the earlier reading never had come after the rest (matching then adds their links, as for any post). A linked
 * move the new reading doesn't hold keeps the earlier reading whole: two readings' moves are never mixed (an earlier
 * one's may not even parse under today's schema), and nothing the owner has is rewritten (ruling, phase 5a ledger).
 */
import { extractionSchema, normalizeMoveName, type Extraction } from "@rg/saves";

/** One of the post's links as the re-read finds it: its place, its move and that move's name now. */
export interface KeptRow {
  position: number;
  moveId: string;
  moveKind: "library" | "personal";
  status: string;
  /** The move's name now (the library's, or the record's: the owner may have renamed it). */
  name: string | null;
}

/** An approved correction to the post's reading of the move at `position` (import_corrections, target `reading`). */
export interface ReadingFix {
  position: number;
  field: "useWhen" | "skipWhen" | "why";
  after: unknown;
}

export type Aligned =
  | { ok: true; extraction: Extraction; kept: number[]; added: number[] }
  | { ok: false; why: "missing"; missing: string[] }
  | { ok: false; why: "invalid" };

/** The least share of words two names hold in common for one to be found as the other (the matcher's own floor). */
export const CLOSE_NAME_MIN = 0.6;

const words = (name: string): Set<string> =>
  new Set(normalizeMoveName(name).split(" ").map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean));
const overlap = (a: Set<string>, b: Set<string>): number => {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared === 0 ? 0 : shared / (a.size + b.size - shared);
};

/** The earlier reading's name and aliases at a place, as kept (any shape). */
function earlierNames(earlier: unknown, position: number): string[] {
  const moves = earlier && typeof earlier === "object" ? (earlier as { moves?: unknown }).moves : null;
  const m = Array.isArray(moves) ? moves[position] : null;
  if (!m || typeof m !== "object") return [];
  const o = m as { name?: unknown; aliases?: unknown };
  return [o.name, ...(Array.isArray(o.aliases) ? o.aliases : [])].filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

/**
 * The new reading lined up with the post's links (`rows`, any status: a row the owner left out holds its place too).
 * Each row is found by the earlier reading's name or aliases there, or its move's name now — exactly (normalised), else
 * by the closest name sharing at least CLOSE_NAME_MIN of its words. `kept`: the positions lined up; `added`: the rest,
 * which matching links as new. `ok: false` keeps the earlier reading: a linked move not found (`missing`, by name), a
 * place below the last link with no move left to fill it, or a result that wouldn't parse.
 */
export function alignReading(
  fresh: Extraction,
  o: { earlier: unknown; rows: readonly KeptRow[]; fixes: readonly ReadingFix[]; keepInsights: boolean },
): Aligned {
  if (o.rows.length === 0) return { ok: true, extraction: fresh, kept: [], added: fresh.moves.map((_, i) => i) };
  const rows = [...o.rows].sort((a, b) => a.position - b.position);
  const freshKeys = fresh.moves.map((m) => new Set([m.name, ...m.aliases].map(normalizeMoveName).filter(Boolean)));
  const freshWords = fresh.moves.map((m) => [m.name, ...m.aliases].map(words));
  const rowNames = rows.map((r) => [...earlierNames(o.earlier, r.position), ...(r.name ? [r.name] : [])]);
  const at = new Map<number, number>(); // row position → fresh index
  const taken = new Set<number>();

  // Exact names first, for every row, so a close name never takes a move another row names exactly.
  rows.forEach((r, i) => {
    const keys = rowNames[i]!.map(normalizeMoveName).filter(Boolean);
    const j = freshKeys.findIndex((k, jj) => !taken.has(jj) && keys.some((x) => k.has(x)));
    if (j >= 0) {
      at.set(r.position, j);
      taken.add(j);
    }
  });
  rows.forEach((r, i) => {
    if (at.has(r.position)) return;
    const mine = rowNames[i]!.map(words).filter((w) => w.size > 0);
    let best = -1;
    let score = 0;
    freshWords.forEach((ws, j) => {
      if (taken.has(j)) return;
      for (const w of ws) {
        for (const m of mine) {
          const s = overlap(w, m);
          if (s >= CLOSE_NAME_MIN && s > score) {
            score = s;
            best = j;
          }
        }
      }
    });
    if (best >= 0) {
      at.set(r.position, best);
      taken.add(best);
    }
  });
  const missing = rows.flatMap((r, i) => (at.has(r.position) ? [] : [rowNames[i]![0] ?? r.name ?? "a move"]));
  if (missing.length) return { ok: false, why: "missing", missing };

  // The places: every row's, a gap below the last row filled by the next new move, then the rest after.
  const rest = fresh.moves.map((_, j) => j).filter((j) => !taken.has(j));
  const last = rows.at(-1)!.position;
  const order: number[] = []; // final position → fresh index
  for (let p = 0; p <= last; p++) {
    const j = at.get(p) ?? rest.shift();
    if (j === undefined) return { ok: false, why: "invalid" };
    order.push(j);
  }
  // Never more moves than the new reading itself: every place is one of its moves.
  order.push(...rest);
  const placeOf = new Map(order.map((j, p) => [j, p]));

  const moves = order.map((j) => ({ ...fresh.moves[j]! }));
  // The approved corrections to the reading, again on the new words — in the order made, so the latest of a field wins.
  for (const f of o.fixes) {
    if (!at.has(f.position) || !moves[f.position]) continue;
    (moves[f.position] as Record<string, unknown>)[f.field] = f.after;
  }
  const earlierInsights = o.earlier && typeof o.earlier === "object" ? (o.earlier as { insights?: unknown }).insights : undefined;
  const aligned = {
    ...fresh,
    moves,
    ...(fresh.routine ? { routine: { ...fresh.routine, order: fresh.routine.order.flatMap((j) => (placeOf.has(j) ? [placeOf.get(j)!] : [])) } } : {}),
    ...(fresh.dropped ? { dropped: fresh.dropped.flatMap((d) => (placeOf.has(d.move) ? [{ ...d, move: placeOf.get(d.move)! }] : [])) } : {}),
    insights: o.keepInsights && Array.isArray(earlierInsights) ? earlierInsights : fresh.insights,
  };
  const parsed = extractionSchema.safeParse(aligned);
  if (!parsed.success) return { ok: false, why: "invalid" };
  return { ok: true, extraction: parsed.data, kept: rows.map((r) => r.position), added: order.map((_, p) => p).filter((p) => !at.has(p)) };
}
