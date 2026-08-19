import { addDays, type GardenSeason, type LocalDate } from "@rg/domain";
import { roll, type CompletedRunInput } from "@rg/garden-engine";

/**
 * Rare visitors — the garden's variable reward, made deterministic. Whether a
 * visitor appears on a date is a pure function of (date, season, the resolved
 * day inputs), using the same seeded-roll pattern as the daily weather flavor
 * (`wx:{date}`). Eligibility is deliberately strict — visitors mark real
 * training patterns, not mere presence — and even an eligible day usually
 * passes quietly.
 */

export type VisitorKind = "deer" | "heron" | "owl" | "fox" | "luna_moth";

export const VISITOR_HINTS: Record<VisitorKind, string> = {
  deer: "Deer pass through after a week that held a long run and steady running.",
  heron: "The heron only visits a true recovery week — one that follows hard training.",
  owl: "Owls come on the nights after you run past dark.",
  fox: "The fox slips by at dusk in autumn, drawn by quality work.",
  luna_moth: "The luna moth drifts in at first light, after a week of settled nights on a tended garden.",
};

/** How the visitor is announced on the page, keyed by kind. */
export const VISITOR_LINES: Record<VisitorKind, string> = {
  deer: "A deer passed through at dawn.",
  heron: "A heron waded through the wet meadow.",
  owl: "An owl kept watch last night.",
  fox: "A fox slipped along the hedge at dusk.",
  luna_moth: "A luna moth rested on a leaf at first light.",
};

export interface VisitorDayRuns {
  date: LocalDate;
  runs: CompletedRunInput[];
  /** The night into this date settled the body (sleep/recovery 0020). */
  dew?: boolean;
}

const HARD_CATEGORIES = new Set(["quality", "long", "race"]);

function isRun(r: CompletedRunInput): boolean {
  return (r.discipline ?? "run") === "run";
}

/**
 * Which visitor (if any) shows on `date`. `days` are the resolved day inputs
 * for roughly the four weeks before `date` (any order; only `date` and the
 * completed runs are read).
 */
export function visitorForDate(
  date: LocalDate,
  season: GardenSeason,
  days: VisitorDayRuns[],
): VisitorKind | null {
  const runsBetween = (fromExclusive: LocalDate, toInclusive: LocalDate): CompletedRunInput[] =>
    days
      .filter((d) => d.date > fromExclusive && d.date <= toInclusive)
      .flatMap((d) => d.runs.filter(isRun));

  const last7 = runsBetween(addDays(date, -7), date);
  const last3 = runsBetween(addDays(date, -3), date);

  const eligible: VisitorKind[] = [];

  // Deer: a week that held a long run plus steady running.
  if (last7.some((r) => r.category === "long") && last7.length >= 3) eligible.push("deer");

  // Heron: a genuine recovery week — running but nothing hard — that follows
  // at least two hard weeks out of the previous three.
  const recoveryShaped = last7.length >= 2 && !last7.some((r) => HARD_CATEGORIES.has(r.category));
  if (recoveryShaped) {
    const hardWeeks = [1, 2, 3].filter((k) => {
      const wk = runsBetween(addDays(date, -7 * (k + 1)), addDays(date, -7 * k));
      return wk.filter((r) => HARD_CATEGORIES.has(r.category)).length >= 2;
    }).length;
    if (hardWeeks >= 2) eligible.push("heron");
  }

  // Owl: an after-dark run in the last three days.
  if (last3.some((r) => r.window === "evening" || (r.startHourLocal ?? 0) >= 20)) {
    eligible.push("owl");
  }

  // Fox: autumn dusk, drawn by recent quality work.
  if (season === "autumn" && last3.some((r) => r.category === "quality")) eligible.push("fox");

  // Luna moth: a week of settled nights on a garden that is also trained —
  // the sleep/recovery reward (0020). Same compound rule as everything in
  // option C: the moth never visits a well-slept couch.
  const nights7 = days.filter((d) => d.date > addDays(date, -7) && d.date <= date);
  const settled7 = nights7.filter((d) => d.dew === true).length;
  if (settled7 >= 5 && last7.length >= 2) eligible.push("luna_moth");

  if (eligible.length === 0) return null;
  // Most eligible days pass quietly — scarcity is the point.
  if (roll(`visitor:${date}`) >= 0.45) return null;
  return eligible[Math.floor(roll(`visitor:kind:${date}`) * eligible.length)] ?? null;
}
