/**
 * Unlock gates: the single source of truth for whether a species is earned,
 * how to describe the requirement to a human, and how close the runner is.
 * `simulateDay` uses `gateSatisfied` to award species; the worker uses
 * `nextUnlocks` to build the "1 more week and butterflies arrive" nudges —
 * both read the same logic, so the nudge can never disagree with the award.
 */

import type { GardenPlant, WildlifeKind } from "@rg/domain";
import { SPECIES, type Species, type UnlockGate } from "./species.js";
import type { GardenSnapshot } from "./types.js";

export function livingPlants(plants: GardenPlant[]): GardenPlant[] {
  return plants.filter((p) => p.state !== "dead");
}

export function matureTreeCount(snapshot: GardenSnapshot): number {
  return livingPlants(snapshot.plants).filter((p) => p.category === "tree" && p.maturity >= 0.7)
    .length;
}

export function gateSatisfied(gate: UnlockGate, snapshot: GardenSnapshot): boolean {
  const s = snapshot.state;
  switch (gate.kind) {
    case "start":
      return true;
    case "quality_runs":
      return s.qualityRunCount >= gate.count;
    case "easy_runs":
      return s.easyRunCount >= gate.count;
    case "long_runs":
      return s.longRunCount >= gate.count;
    case "recovery_runs":
      return s.recoveryRunCount >= gate.count;
    case "consistent_weeks":
      return s.consecutiveConsistentWeeks >= gate.count;
    case "mature_trees":
      return matureTreeCount(snapshot) >= gate.count;
    case "comeback":
      return s.inComeback || s.comebackStreak > 0;
    case "dead_wood":
      return snapshot.plants.some((p) => p.state === "dead" && p.habitatRole);
    case "early_runs":
      return (s.earlyRunCount ?? 0) >= gate.count;
    case "distance_run":
      return (s.longestRunMeters ?? 0) >= gate.meters;
    case "total_runs":
      return s.totalCompletedRuns >= gate.count;
    case "comeback_streak":
      return (s.bestComebackStreak ?? 0) >= gate.count;
    case "strength_sessions":
      return s.strengthSessionCount >= gate.count;
    case "yoga_sessions":
      return s.yogaSessionCount >= gate.count;
    case "balanced_weeks":
      return s.balancedWeekCount >= gate.count;
  }
}

/** Human-readable requirement, phrased as an invitation rather than a chore. */
export function describeGate(gate: UnlockGate): string {
  switch (gate.kind) {
    case "start":
      return "Here from your first day";
    case "quality_runs":
      return `Complete ${gate.count} quality run${gate.count === 1 ? "" : "s"}`;
    case "easy_runs":
      return `Complete ${gate.count} easy run${gate.count === 1 ? "" : "s"}`;
    case "long_runs":
      return `Complete ${gate.count} long run${gate.count === 1 ? "" : "s"}`;
    case "recovery_runs":
      return `Complete ${gate.count} recovery run${gate.count === 1 ? "" : "s"}`;
    case "consistent_weeks":
      return `Stay consistent ${gate.count} week${gate.count === 1 ? "" : "s"} in a row`;
    case "mature_trees":
      return `Grow ${gate.count} tree${gate.count === 1 ? "" : "s"} to maturity`;
    case "comeback":
      return "Come back after a long break";
    case "dead_wood":
      return "Grows on fallen wood — old gardens earn this";
    case "early_runs":
      return `Start ${gate.count} run${gate.count === 1 ? "" : "s"} before 7 am`;
    case "distance_run":
      return gate.meters >= 21_000
        ? "Cover a half-marathon in one run"
        : `Run ${Math.round(gate.meters / 1000)} km in a single run`;
    case "total_runs":
      return `Complete ${gate.count} planned runs, lifetime`;
    case "comeback_streak":
      return `Run ${gate.count} days in a row after a long break`;
    case "strength_sessions":
      return `Complete ${gate.count} strength session${gate.count === 1 ? "" : "s"}`;
    case "yoga_sessions":
      return `Complete ${gate.count} yoga session${gate.count === 1 ? "" : "s"}`;
    case "balanced_weeks":
      return `${gate.count} balanced week${gate.count === 1 ? "" : "s"} — run, lift, and yoga in the same week`;
  }
}

/** Numeric progress toward a gate, or null for binary/emergent gates. */
export function gateProgress(
  gate: UnlockGate,
  snapshot: GardenSnapshot,
): { current: number; target: number } | null {
  const s = snapshot.state;
  switch (gate.kind) {
    case "quality_runs":
      return { current: s.qualityRunCount, target: gate.count };
    case "easy_runs":
      return { current: s.easyRunCount, target: gate.count };
    case "long_runs":
      return { current: s.longRunCount, target: gate.count };
    case "recovery_runs":
      return { current: s.recoveryRunCount, target: gate.count };
    case "consistent_weeks":
      return { current: s.consecutiveConsistentWeeks, target: gate.count };
    case "mature_trees":
      return { current: matureTreeCount(snapshot), target: gate.count };
    case "early_runs":
      return { current: s.earlyRunCount ?? 0, target: gate.count };
    case "distance_run":
      return { current: Math.round(s.longestRunMeters ?? 0), target: gate.meters };
    case "total_runs":
      return { current: s.totalCompletedRuns, target: gate.count };
    case "comeback_streak":
      return { current: s.bestComebackStreak ?? 0, target: gate.count };
    case "strength_sessions":
      return { current: s.strengthSessionCount, target: gate.count };
    case "yoga_sessions":
      return { current: s.yogaSessionCount, target: gate.count };
    case "balanced_weeks":
      return { current: s.balancedWeekCount, target: gate.count };
    default:
      return null;
  }
}

export interface SpeciesUnlockStatus {
  speciesId: string;
  name: string;
  category: Species["category"];
  rarity: Species["rarity"];
  unlocked: boolean;
  hint: string;
  /** Progress toward the gate, when it's countable. */
  progress: { current: number; target: number } | null;
}

/** Unlock status for the full catalog — the species codex. */
export function speciesCodex(snapshot: GardenSnapshot): SpeciesUnlockStatus[] {
  const unlocked = new Set(snapshot.unlockedSpeciesIds);
  return SPECIES.map((s) => ({
    speciesId: s.id,
    name: s.name,
    category: s.category,
    rarity: s.rarity,
    unlocked: unlocked.has(s.id),
    hint: describeGate(s.unlock),
    progress: unlocked.has(s.id) ? null : gateProgress(s.unlock, snapshot),
  }));
}

/**
 * The nearest locked species, sorted by least remaining progress (countable
 * gates first, ties broken toward commoner species so nudges feel reachable).
 */
export function nextUnlocks(snapshot: GardenSnapshot, limit = 3): SpeciesUnlockStatus[] {
  const rarityRank = { common: 0, uncommon: 1, rare: 2 } as const;
  return speciesCodex(snapshot)
    .filter((s) => !s.unlocked && s.progress !== null && s.progress.target > 0)
    .sort((a, b) => {
      const ra = 1 - Math.min(1, a.progress!.current / a.progress!.target);
      const rb = 1 - Math.min(1, b.progress!.current / b.progress!.target);
      return ra - rb || rarityRank[a.rarity] - rarityRank[b.rarity];
    })
    .slice(0, limit);
}

/** Why each wildlife visitor comes — hints for the codex's wildlife shelf. */
export const WILDLIFE_HINTS: Record<WildlifeKind, string> = {
  birds: "Grow two mature trees for them to perch in",
  bees: "Keep three flowering species, with one in bloom",
  butterflies: "Rich biodiversity — many species thriving at once",
  fireflies: "Ten evening runs, with a mature tree to glow around",
  squirrels: "A mature tree brings them down from the hills",
  rabbits: "Moist ground with grasses or groundcover",
  frogs: "Damp ferns near the ground",
  dragonflies: "A garden dense with open flowers",
  ladybugs: "At least one species in bloom",
};
