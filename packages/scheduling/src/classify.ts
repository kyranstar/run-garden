import type { PlannedStage, QualitySubtype, WorkoutCategory } from "@rg/domain";

export interface ClassifiableWorkout {
  title: string;
  sport?: string;
  stages?: PlannedStage[];
  /** total planned seconds when known (native estimate or derived) */
  plannedDurationSeconds?: number;
  plannedDistanceMeters?: number;
  /** provider-native type hint when the source exposes one */
  sourceTypeHint?: string;
}

export interface Classification {
  category: WorkoutCategory;
  qualitySubtype?: QualitySubtype;
  /** which signal decided: structure beats title beats defaults */
  basis: "structure" | "title" | "hint" | "default";
}

const TITLE_RULES: Array<{ re: RegExp; category: WorkoutCategory; sub?: QualitySubtype }> = [
  { re: /\brace\b|\btime trial\b|\bparkrun\b/i, category: "race" },
  { re: /\brest\b|\bday off\b/i, category: "rest" },
  { re: /\brecovery\b|\bregeneration\b|\bshakeout\b/i, category: "recovery" },
  { re: /\blong\b|\blsd\b/i, category: "long" },
  { re: /\bthreshold\b|\blt2?\b|\blactate\b/i, category: "quality", sub: "threshold" },
  { re: /\btempo\b|\bsteady state\b/i, category: "quality", sub: "tempo" },
  { re: /\bvo2\b|\bv02\b|\bmax aerobic\b/i, category: "quality", sub: "vo2" },
  { re: /\bhill\b|\bhills\b|\bincline\b/i, category: "quality", sub: "hills" },
  { re: /\binterval\b|\brepeats?\b|\bfartlek\b|\bspeed\b|\btrack\b|\d+\s*[x×]\s*\d+/i, category: "quality", sub: "intervals" },
  { re: /\bstrength\b|\bcore\b|\bgym\b|\bweights\b/i, category: "strength" },
  { re: /\bbike\b|\bcycle\b|\bswim\b|\brow\b|\belliptical\b|\bcross[- ]?train/i, category: "cross_training" },
  { re: /\beasy\b|\baerobic\b|\bbase\b|\bconversational\b/i, category: "easy" },
  { re: /\byoga\b|\bmobility\b|\bstretch/i, category: "yoga" },
];

const NON_RUN_SPORTS = new Set(["bike", "cycling", "swim", "swimming", "rowing", "elliptical"]);
const STRENGTH_SPORTS = new Set(["strength", "gym", "gym_cardio", "training"]);
const YOGA_SPORTS = new Set(["yoga"]);

/** Intensity heuristics on normalized stages. */
function analyzeStructure(stages: PlannedStage[]): {
  hasWorkIntervals: boolean;
  workBoutSeconds: number[];
  hardZones: boolean;
  steadyBlockSeconds: number;
} {
  const work = stages.filter((s) => s.kind === "work");
  const hardZones = work.some(
    (s) =>
      (s.paceZone !== undefined && s.paceZone >= 4) ||
      (s.hrZone !== undefined && s.hrZone >= 4) ||
      (s.targetType === "effort" && (s.targetLow ?? 0) >= 4),
  );
  const workBoutSeconds = work
    .map((s) => s.durationSeconds ?? 0)
    .filter((d) => d > 0);
  const steady = work.length === 1 ? work[0] : undefined;
  return {
    hasWorkIntervals: work.length > 0,
    workBoutSeconds,
    hardZones,
    steadyBlockSeconds: steady?.durationSeconds ?? 0,
  };
}

export function classifyWorkout(w: ClassifiableWorkout): Classification {
  const sport = (w.sport ?? "run").toLowerCase();
  if (NON_RUN_SPORTS.has(sport)) return { category: "cross_training", basis: "hint" };
  if (STRENGTH_SPORTS.has(sport)) return { category: "strength", basis: "hint" };
  if (YOGA_SPORTS.has(sport)) return { category: "yoga", basis: "hint" };

  const titleMatch = TITLE_RULES.find((r) => r.re.test(w.title));

  // Rest days rarely carry structure; decide before structure analysis.
  if (titleMatch?.category === "rest") return { category: "rest", basis: "title" };
  if (titleMatch?.category === "race") return { category: "race", basis: "title" };

  const stages = w.stages ?? [];
  if (stages.length > 0) {
    const a = analyzeStructure(stages);
    const repeatCount = stages.filter((s) => s.kind === "repeat").length;
    if (a.hasWorkIntervals && (a.hardZones || repeatCount > 0)) {
      // Structured quality session; refine the subtype.
      const bouts = a.workBoutSeconds;
      const maxBout = bouts.length ? Math.max(...bouts) : 0;
      let sub: QualitySubtype = "intervals";
      if (titleMatch?.category === "quality" && titleMatch.sub) sub = titleMatch.sub;
      else if (repeatCount === 0 && a.steadyBlockSeconds >= 15 * 60) sub = "tempo";
      else if (maxBout > 0 && maxBout <= 4 * 60) sub = "vo2";
      else if (maxBout >= 5 * 60 && maxBout <= 20 * 60) sub = "threshold";
      return { category: "quality", qualitySubtype: sub, basis: "structure" };
    }
  }

  // Long by magnitude (structure/estimate) even when the title doesn't say so.
  const dur = w.plannedDurationSeconds ?? 0;
  const dist = w.plannedDistanceMeters ?? 0;
  if (titleMatch?.category === "long" || dur >= 90 * 60 || dist >= 16_000) {
    return { category: "long", basis: titleMatch?.category === "long" ? "title" : "structure" };
  }

  if (titleMatch) {
    return {
      category: titleMatch.category,
      ...(titleMatch.sub ? { qualitySubtype: titleMatch.sub } : {}),
      basis: "title",
    };
  }

  if (stages.length === 0 && dur === 0 && dist === 0) return { category: "unknown", basis: "default" };
  return { category: "easy", basis: "default" };
}
