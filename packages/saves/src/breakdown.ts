import { isPlyometric, type ExerciseRecord, type Region } from "@rg/exercise-library";

export type MoveGroup = "jump" | "hip" | "neck" | "upper back" | "shoulder" | "core" | "leg" | "other";

/** Exhaustive over the library's regions: a new region fails typecheck until it is placed. */
const REGION_GROUP: Record<Region, MoveGroup> = {
  jaw: "neck", neck: "neck", "upper-back": "upper back", thoracic: "upper back", shoulders: "shoulder",
  chest: "other", lats: "other", arms: "other", core: "core", "low-back": "other", hips: "hip", glutes: "hip",
  hamstrings: "leg", quads: "leg", calves: "leg", ankles: "leg", feet: "leg", "full-body": "other",
};

export function moveGroup(m: Pick<ExerciseRecord, "regions" | "contraction">): MoveGroup {
  if (isPlyometric(m)) return "jump";
  const first = m.regions[0];
  return first === undefined ? "other" : (REGION_GROUP[first] ?? "other");
}

/** "From your saves: 4 new moves (2 hip, 1 neck, 1 jump), 3 you already had." */
export function batchNotice(newMoves: Pick<ExerciseRecord, "regions" | "contraction">[], linked: number): string {
  const n = newMoves.length;
  const had = linked === 1 ? "1 move you already had" : `${linked} moves you already had`;
  if (n === 0) return `From your saves: ${had}.`;
  const counts = new Map<MoveGroup, number>();
  for (const m of newMoves) counts.set(moveGroup(m), (counts.get(moveGroup(m)) ?? 0) + 1);
  // Biggest group first; ties keep the order they first appeared in (Array.sort is stable).
  const breakdown = [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([g, c]) => (n === 1 ? g : `${c} ${g}`))
    .join(", ");
  const head = `${n} new ${n === 1 ? "move" : "moves"} (${breakdown})`;
  return linked > 0 ? `From your saves: ${head}, ${linked} you already had.` : `From your saves: ${head}.`;
}
