// How the player says a move's dose: which unit, and whether it's per side. Plain logic, kept out of the screen.

/** The slice of a move these read. */
interface DoseWordsMove {
  laterality: string;
  dose: { type: string };
}

/** A counted set of a move done on both sides, a side at a time or alternating, says so. */
export const eachSide = (ex: DoseWordsMove | undefined): string => (ex && ex.laterality !== "bilateral" ? " each side" : "");

/** A timer runs per side only for a one-sided move: an alternating move's one window holds both sides. */
export const eachSideOnTimer = (ex: DoseWordsMove | undefined): string => (ex?.laterality === "unilateral" ? " each side" : "");

/**
 * The unit of a set's number. A set's target can say reps of a move the library times (a coach's "slow reps" of a hold):
 * then the number is reps, never "8–12 s". Otherwise seconds for a hold or a carry, breaths for a breathing drill, else reps.
 */
export function setMetric(ex: DoseWordsMove | undefined, target?: { reps?: number | null; type?: string } | null): "s" | "breaths" | "reps" {
  const type = ex?.dose.type;
  if (type === "time" || type === "carry") return target?.reps != null || target?.type === "reps" ? "reps" : "s";
  return type === "breaths" ? "breaths" : "reps";
}
