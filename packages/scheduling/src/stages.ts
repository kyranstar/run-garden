import { formatStageDistance, formatStageDuration, type PlannedStage } from "@rg/domain";

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
      assumptions.push(`Assumed ${formatStageDuration(fallback)} for open ${stage.kind} stage`);
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

/**
 * Compact human summary like "15 min Warm Up · 5 × 5 min / 2 min Rest ·
 * 10 min Cool Down" — the string stored in `planned_workouts.stage_summary`
 * for an IMPORTED workout, and the one the session sheet re-derives from a
 * row's own stage rows.
 *
 * BOTH amounts go through the @rg/domain formatters (`formatStageDuration`,
 * `formatStageDistance`), which is also what the coach's own prescription
 * renderer uses (`sessionPrescription`) — the stored summary and the sheet's
 * "Full structure" list sit one tap apart on the same screen, so when this said
 * "0 min Training" and that said "15s", a reader had two prescriptions for one
 * interval and no way to tell which to run. Same for "0.8km" against "800 m".
 *
 * A STAGE IS NAMED BY ITS LABEL, AND OTHERWISE BY ITS KIND — and the second half
 * came back on 2026-08-17 after being removed the same day.
 *
 * It was removed for a real reason: a coach-authored run's stage kinds came from
 * a POSITIONAL rule (`coach-apply.ts`: first of two or more is a "warmup"), so a
 * block whose only stated property was 15 minutes rendered "15 min warmup" here
 * and "15 min" on the card the athlete had just approved — a role nobody wrote,
 * on a session they had already agreed to.
 *
 * But that was the positional rule's bug, and the positional rule is gone:
 * `writeStages` now derives roles with `runBlockRoles`, the same and only
 * derivation the wire uses. Every non-`work` role it can produce requires a
 * stated intensity (`recovery` ⇐ "rest", `warmup`/`cooldown` ⇐ "easy"), and the
 * intensity IS the label — so for a coach row the fallback is now unreachable by
 * construction, and removing it bought nothing.
 *
 * What it DID cost was imported rows. An imported stage's `kind` comes from
 * COROS's own `exerciseType` (1 warm-up, 3 cool-down, 4 recovery) — the
 * provider's classification, not our inference — and its label is an i18n key
 * that `resolveLabel` drops when nothing resolves it. So dropping the fallback
 * turned the athlete's own strides session from "40 min · 1 min cooldown ·
 * 4 × 15s / 45s recovery" into "40 min · 1 min · 4 × 15s / 45s": two anonymous
 * stretches of time where the watch says what they are for.
 */
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
        ? formatStageDuration(s.durationSeconds)
        : s.durationType === "distance" && s.distanceMeters
          ? formatStageDistance(s.distanceMeters)
          : "open";
    const label = s.label ?? (s.kind === "work" || s.kind === "open" ? "" : s.kind);
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

/**
 * A `planned_workout_stages` row, as the database hands it back: `ord` instead
 * of `order`, and every optional column nullable rather than absent.
 */
export interface StoredStageRow {
  id: string;
  parentStageId?: string | null;
  ord: number;
  kind: string;
  repeatCount?: number | null;
  durationType: string;
  durationSeconds?: number | null;
  distanceMeters?: number | null;
  label?: string | null;
}

/**
 * The summary a workout's STORED stage rows say it has.
 *
 * `stage_summary` is derived text with no upstream of its own: it is whatever
 * `summarizeStages` produced from the stage rows at import time, so any reader
 * holding those rows can recompute it — and a reader that recomputes cannot be
 * shown wording from before a formatter fix while the stage list beside it
 * shows wording from after. The workout-detail route (which already loads the
 * rows, for the "Full structure" list) does exactly that.
 *
 * Same function, same string: the only difference from `summarizeStages` is
 * the row shape. The enum casts are honest — SQLite holds no enum constraint,
 * and the writer validated these values on the way in.
 */
export function summarizeStageRows(rows: readonly StoredStageRow[]): string {
  return summarizeStages(
    rows.map((r) => ({
      id: r.id,
      ...(r.parentStageId !== null && r.parentStageId !== undefined
        ? { parentStageId: r.parentStageId }
        : {}),
      order: r.ord,
      kind: r.kind as PlannedStage["kind"],
      ...(r.repeatCount !== null && r.repeatCount !== undefined
        ? { repeatCount: r.repeatCount }
        : {}),
      durationType: r.durationType as PlannedStage["durationType"],
      ...(r.durationSeconds !== null && r.durationSeconds !== undefined
        ? { durationSeconds: r.durationSeconds }
        : {}),
      ...(r.distanceMeters !== null && r.distanceMeters !== undefined
        ? { distanceMeters: r.distanceMeters }
        : {}),
      ...(r.label !== null && r.label !== undefined ? { label: r.label } : {}),
    })),
  );
}
