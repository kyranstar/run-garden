import type { PlannedStage } from "@rg/domain";

/**
 * Stage flattening and duration derivation — the fallback estimator used when
 * COROS does not supply a native duration estimate.
 */

export interface PaceResolutionContext {
  /** COROS pace zones, seconds/km, by zone number (1 = easiest). */
  paceZones?: Record<number, { low: number; high: number }>;
  /** Median observed pace (sec/km) for a workout category, from history. */
  historicalPaceForCategory?: number;
  /** Conservative configured pace when nothing else is known. */
  defaultPaceSecPerKm: number;
  /** Assumed seconds for open/lap-button stages by kind. */
  openStageDefaults?: Partial<Record<PlannedStage["kind"], number>>;
}

export const DEFAULT_OPEN_STAGE_SECONDS: Record<string, number> = {
  warmup: 10 * 60,
  cooldown: 10 * 60,
  work: 10 * 60,
  recovery: 2 * 60,
  rest: 60,
  open: 10 * 60,
};

export interface DerivedStageDuration {
  seconds: number;
  assumptions: string[];
}

/**
 * Expand nested repeats into a linear list of leaf stages.
 * Children reference their repeat container via parentStageId.
 */
export function flattenStages(stages: PlannedStage[]): PlannedStage[] {
  const byParent = new Map<string | null, PlannedStage[]>();
  for (const s of stages) {
    const key = s.parentStageId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(s);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);

  const out: PlannedStage[] = [];
  const expand = (parent: string | null, multiplier: number, depth: number): void => {
    if (depth > 6) throw new Error("Repeat nesting too deep (possible cycle)");
    for (const s of byParent.get(parent) ?? []) {
      if (s.kind === "repeat") {
        const count = Math.max(1, s.repeatCount ?? 1);
        for (let i = 0; i < count * multiplier; i++) expand(s.id, 1, depth + 1);
      } else {
        for (let i = 0; i < multiplier; i++) out.push(s);
      }
    }
  };
  expand(null, 1, 0);
  return out;
}

function resolvePace(stage: PlannedStage, ctx: PaceResolutionContext): { secPerKm: number; assumption?: string } {
  if (stage.targetType === "pace" && (stage.targetLow || stage.targetHigh)) {
    const lo = stage.targetLow ?? stage.targetHigh!;
    const hi = stage.targetHigh ?? stage.targetLow!;
    return { secPerKm: (lo + hi) / 2 };
  }
  if (stage.paceZone !== undefined && ctx.paceZones?.[stage.paceZone]) {
    const z = ctx.paceZones[stage.paceZone]!;
    return {
      secPerKm: (z.low + z.high) / 2,
      assumption: `Used pace zone ${stage.paceZone} midpoint for ${stage.kind} stage`,
    };
  }
  if (ctx.historicalPaceForCategory) {
    return {
      secPerKm: ctx.historicalPaceForCategory,
      assumption: `Used your median pace from comparable runs for ${stage.kind} stage`,
    };
  }
  return {
    secPerKm: ctx.defaultPaceSecPerKm,
    assumption: `Used conservative default pace for ${stage.kind} stage`,
  };
}

export function deriveStageSeconds(stage: PlannedStage, ctx: PaceResolutionContext): DerivedStageDuration {
  const assumptions: string[] = [];
  switch (stage.durationType) {
    case "time":
      return { seconds: stage.durationSeconds ?? 0, assumptions };
    case "distance": {
      const meters = stage.distanceMeters ?? 0;
      if (meters === 0) return { seconds: 0, assumptions };
      const { secPerKm, assumption } = resolvePace(stage, ctx);
      if (assumption) assumptions.push(assumption);
      return { seconds: (meters / 1000) * secPerKm, assumptions };
    }
    case "open":
    case "lap_button": {
      const fallback =
        ctx.openStageDefaults?.[stage.kind] ??
        DEFAULT_OPEN_STAGE_SECONDS[stage.kind] ??
        10 * 60;
      assumptions.push(`Assumed ${Math.round(fallback / 60)} min for open ${stage.kind} stage`);
      return { seconds: fallback, assumptions };
    }
    case "none":
      return { seconds: stage.durationSeconds ?? 0, assumptions };
  }
}

export function deriveWorkoutSeconds(
  stages: PlannedStage[],
  ctx: PaceResolutionContext,
): DerivedStageDuration {
  const flat = flattenStages(stages);
  let total = 0;
  const assumptions = new Set<string>();
  for (const s of flat) {
    const d = deriveStageSeconds(s, ctx);
    total += d.seconds;
    for (const a of d.assumptions) assumptions.add(a);
  }
  return { seconds: Math.round(total), assumptions: [...assumptions] };
}

/** Compact human summary like "15 min easy · 5 × 5 min threshold / 2 min jog · 10 min cooldown". */
export function summarizeStages(stages: PlannedStage[]): string {
  const byParent = new Map<string | null, PlannedStage[]>();
  for (const s of stages) {
    const key = s.parentStageId ?? null;
    (byParent.get(key) ?? byParent.set(key, []).get(key)!).push(s);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.order - b.order);

  const fmt = (s: PlannedStage): string => {
    const amount =
      s.durationType === "time" && s.durationSeconds
        ? `${Math.round(s.durationSeconds / 60)} min`
        : s.durationType === "distance" && s.distanceMeters
          ? s.distanceMeters >= 1000
            ? `${(s.distanceMeters / 1000).toFixed(s.distanceMeters % 1000 === 0 ? 0 : 1)} km`
            : `${Math.round(s.distanceMeters)} m`
          : "open";
    const label = s.label ?? (s.kind === "work" ? "" : s.kind);
    return [amount, label].filter(Boolean).join(" ");
  };

  const parts: string[] = [];
  for (const s of byParent.get(null) ?? []) {
    if (s.kind === "repeat") {
      const children = byParent.get(s.id) ?? [];
      const inner = children.map(fmt).join(" / ");
      parts.push(`${s.repeatCount ?? 1} × ${inner}`);
    } else {
      parts.push(fmt(s));
    }
  }
  return parts.join(" · ");
}
