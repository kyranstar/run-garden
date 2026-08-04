/**
 * The three disciplines the garden and the insights dashboard both speak.
 *
 * Running is not the default that everything else is measured against — it is
 * one of three. What separates them for analytics is narrow and physical:
 * a run has pace and distance, a lift and a yoga session do not. Metrics built
 * on pace are therefore run-only, and every other metric applies to all three.
 */
export type Discipline = "run" | "strength" | "yoga";

export const DISCIPLINES: readonly Discipline[] = ["run", "strength", "yoga"] as const;

export function disciplineLabel(d: Discipline): string {
  return d === "run" ? "Running" : d === "strength" ? "Strength" : "Yoga";
}

/**
 * The right noun for a session in this discipline. Copy must never call a lift
 * or a yoga session a "run".
 */
export function sessionNoun(d: Discipline, plural = false): string {
  const singular = d === "run" ? "run" : d === "strength" ? "lift" : "yoga session";
  return plural ? `${singular}s` : singular;
}

/**
 * Metrics that depend on pace or distance, and so are meaningful for runs only.
 * These are omitted for other disciplines rather than rendered empty — an empty
 * card implies the data is missing, when in fact the question does not apply.
 */
export const RUN_ONLY_METRICS: readonly string[] = [
  "aerobicEfficiency",
  "decoupling",
  "lowIntensityShare",
  "easyDiscipline",
  "hrZones",
  // Compares the halves of a session by pace. A lift has no pace to fade from.
  "pacing",
] as const;

export function supportsMetric(d: Discipline, metric: string): boolean {
  return d === "run" || !RUN_ONLY_METRICS.includes(metric);
}
