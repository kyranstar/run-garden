import { DEFAULT_GARDEN_CONFIG, type GardenConfig, type GardenSnapshot } from "./types.js";

/**
 * The garden's short-range forecast: how many days until the next *visible*
 * deterioration stage if no run lands, and which plant the simulation would
 * send dormant first once drought holds. Mirrors the thresholds and the
 * dormancy pick in simulate.ts exactly — a forecast that disagrees with the
 * sim would be worse than none. Pure display; never persisted.
 */

export type ForecastStage = "dry" | "drought" | "dormancy";

export interface GardenForecast {
  /** Next stage ahead, or null in rest mode / past dormancy. */
  next: { stage: ForecastStage; inDays: number } | null;
  /** Deterministic first dormancy pick while drought holds (lowest hydration,
   * id tiebreak, non-tree, living, not already dormant — same ordering as
   * applyDailyDecay). */
  victim: { plantId: string; speciesId: string } | null;
  /** The garden is currently drinking recovery rain. */
  recovering: boolean;
}

export function gardenForecast(
  snapshot: GardenSnapshot,
  daysAhead = 0,
  cfg: GardenConfig = DEFAULT_GARDEN_CONFIG,
): GardenForecast {
  const state = snapshot.state;
  const recovering = state.inComeback && !state.restMode;
  if (state.restMode) return { next: null, victim: null, recovering: false };

  const d = state.daysSinceCompletedRun + Math.max(0, Math.floor(daysAhead));

  const candidates = snapshot.plants
    // audit#2 #21: mirror the sim's pick exactly — applyDailyDecay skips
    // plants that are ALREADY dormant, so a dormant plant must never be
    // named as the one "going dormant soon" (the mirror contract above).
    .filter((p) => p.state !== "dead" && p.state !== "dormant" && p.category !== "tree")
    .sort((a, b) => a.hydration - b.hydration || a.id.localeCompare(b.id));
  const first = candidates[0];
  const victim = first ? { plantId: first.id, speciesId: first.speciesId } : null;

  if (d < cfg.drynessStartDays) {
    return { next: { stage: "dry", inDays: cfg.drynessStartDays - d }, victim: null, recovering };
  }
  if (d < cfg.droughtStartDays) {
    return { next: { stage: "drought", inDays: cfg.droughtStartDays - d }, victim: null, recovering };
  }
  if (d < cfg.dormancyStartDays) {
    return { next: { stage: "dormancy", inDays: cfg.dormancyStartDays - d }, victim, recovering };
  }
  return { next: null, victim, recovering };
}
