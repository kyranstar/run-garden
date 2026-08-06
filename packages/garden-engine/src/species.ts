import type { PlantCategory } from "@rg/domain";

/**
 * The species catalog. Every entry is meaningfully distinct in the renderer
 * (silhouette + palette + form parameters), not a recolor of one shape.
 * Unlock gates reference counters tracked by the simulation.
 */

export type SpeciesRarity = "common" | "uncommon" | "rare";

export type UnlockGate =
  | { kind: "start" } // available from the first garden day
  | { kind: "quality_runs"; count: number }
  | { kind: "easy_runs"; count: number }
  | { kind: "long_runs"; count: number }
  | { kind: "recovery_runs"; count: number }
  | { kind: "consistent_weeks"; count: number }
  | { kind: "mature_trees"; count: number }
  | { kind: "comeback" } // strong recovery after a drought
  | { kind: "dead_wood" } // requires a nurse log / dead plant in the garden
  // Achievement gates — named milestones shown as locked cards in the codex.
  | { kind: "early_runs"; count: number } // runs started before 07:00
  | { kind: "distance_run"; meters: number } // a single run of at least N meters
  | { kind: "total_runs"; count: number } // lifetime completed planned runs
  | { kind: "comeback_streak"; count: number } // N straight days back after a break
  // Discipline gates — strength, yoga, and cross-discipline balance.
  | { kind: "strength_sessions"; count: number }
  | { kind: "yoga_sessions"; count: number }
  | { kind: "balanced_weeks"; count: number }
  // Ground gates — species exclusive to carved grounds (Bundle 3).
  | { kind: "ground"; ground: "stream" | "terrace" | "glade" }
  | { kind: "races"; count: number } // planned races finished
  | { kind: "evening_runs"; count: number } // planned evening runs
  | { kind: "coached_blocks"; count: number }; // coached plans seen through

export interface Species {
  id: string;
  name: string;
  category: PlantCategory;
  rarity: SpeciesRarity;
  unlock: UnlockGate;
  /** Days of watered growth from seed to mature. */
  growthDays: number;
  /** Visual footprint radius in scene units (0..1 scale ≈ fraction of scene width). */
  spacing: number;
  /** Depth band the species prefers: 0 = far background, 1 = near foreground. */
  depthBand: [number, number];
  /** Whether the species has a distinct flowering state. */
  flowers: boolean;
  /** Vines need a host tree; fungi prefer dead wood or shade. */
  needsHost?: "tree" | "dead_wood";
  /** Aquatic placement: "channel" anchors ON the stream, "bank" at its edge.
   * The plants-never-in-water rule exempts exactly these. */
  aquatic?: "channel" | "bank";
  /** Renderer archetype — the renderer has distinct art per archetype+species. */
  archetype:
    | "tree_round"
    | "tree_birch"
    | "tree_weeping"
    | "tree_conifer"
    | "tree_fan"
    | "tree_blossom"
    | "flower_cup"
    | "flower_daisy"
    | "flower_spike"
    | "flower_cluster"
    | "fern"
    | "hosta"
    | "grass_tuft"
    | "vine"
    | "groundcover_patch"
    | "moss"
    | "mushroom"
    | "shelf_fungus"
    | "shrub_round"
    | "shrub_spike"
    | "water_lily";
  palette: { primary: string; secondary: string; accent?: string };
}

export const SPECIES: Species[] = [
  // ── Trees ────────────────────────────────────────────────────────────────
  { id: "birch", name: "Paper birch", category: "tree", rarity: "common", unlock: { kind: "long_runs", count: 1 }, growthDays: 40, spacing: 0.09, depthBand: [0.1, 0.45], flowers: false, archetype: "tree_birch", palette: { primary: "#7da26b", secondary: "#e8e4da", accent: "#4c4a44" } },
  { id: "maple", name: "Field maple", category: "tree", rarity: "common", unlock: { kind: "long_runs", count: 2 }, growthDays: 48, spacing: 0.1, depthBand: [0.1, 0.45], flowers: false, archetype: "tree_round", palette: { primary: "#6f9a58", secondary: "#8a6248" } },
  { id: "cherry", name: "Mountain cherry", category: "tree", rarity: "uncommon", unlock: { kind: "long_runs", count: 4 }, growthDays: 55, spacing: 0.1, depthBand: [0.12, 0.5], flowers: true, archetype: "tree_blossom", palette: { primary: "#87a06d", secondary: "#7a5a49", accent: "#e9b7c8" } },
  { id: "ginkgo", name: "Ginkgo", category: "tree", rarity: "uncommon", unlock: { kind: "long_runs", count: 6 }, growthDays: 60, spacing: 0.09, depthBand: [0.1, 0.45], flowers: false, archetype: "tree_fan", palette: { primary: "#9fb26a", secondary: "#6d6a5a" } },
  { id: "willow", name: "Creek willow", category: "tree", rarity: "uncommon", unlock: { kind: "long_runs", count: 8 }, growthDays: 65, spacing: 0.12, depthBand: [0.08, 0.4], flowers: false, archetype: "tree_weeping", palette: { primary: "#7fa173", secondary: "#71614e" } },
  { id: "pine", name: "Shore pine", category: "tree", rarity: "common", unlock: { kind: "long_runs", count: 3 }, growthDays: 70, spacing: 0.09, depthBand: [0.05, 0.35], flowers: false, archetype: "tree_conifer", palette: { primary: "#4e7a5a", secondary: "#5d4f41" } },
  { id: "dogwood", name: "Dogwood", category: "tree", rarity: "rare", unlock: { kind: "long_runs", count: 10 }, growthDays: 58, spacing: 0.09, depthBand: [0.15, 0.5], flowers: true, archetype: "tree_blossom", palette: { primary: "#7d9c66", secondary: "#6d5544", accent: "#f0e7d8" } },
  { id: "magnolia", name: "Star magnolia", category: "tree", rarity: "rare", unlock: { kind: "long_runs", count: 12 }, growthDays: 62, spacing: 0.11, depthBand: [0.12, 0.48], flowers: true, archetype: "tree_blossom", palette: { primary: "#83a070", secondary: "#7b6152", accent: "#efd9e8" } },

  // ── Flowers ──────────────────────────────────────────────────────────────
  { id: "poppy", name: "Field poppy", category: "flower", rarity: "common", unlock: { kind: "quality_runs", count: 1 }, growthDays: 10, spacing: 0.035, depthBand: [0.45, 0.85], flowers: true, archetype: "flower_cup", palette: { primary: "#5c7d4e", secondary: "#d76a52", accent: "#3d3b33" } },
  { id: "iris", name: "Meadow iris", category: "flower", rarity: "common", unlock: { kind: "quality_runs", count: 2 }, growthDays: 12, spacing: 0.035, depthBand: [0.4, 0.8], flowers: true, archetype: "flower_spike", palette: { primary: "#5f7f55", secondary: "#8a7fc0" } },
  { id: "aster", name: "Wood aster", category: "flower", rarity: "common", unlock: { kind: "quality_runs", count: 4 }, growthDays: 11, spacing: 0.03, depthBand: [0.45, 0.85], flowers: true, archetype: "flower_daisy", palette: { primary: "#61815a", secondary: "#b7a4d6", accent: "#e0c46a" } },
  { id: "coneflower", name: "Coneflower", category: "flower", rarity: "uncommon", unlock: { kind: "quality_runs", count: 6 }, growthDays: 14, spacing: 0.035, depthBand: [0.45, 0.85], flowers: true, archetype: "flower_daisy", palette: { primary: "#5e7d51", secondary: "#c98bb0", accent: "#8a5a3a" } },
  { id: "cosmos", name: "Cosmos", category: "flower", rarity: "uncommon", unlock: { kind: "quality_runs", count: 8 }, growthDays: 12, spacing: 0.033, depthBand: [0.45, 0.85], flowers: true, archetype: "flower_daisy", palette: { primary: "#6a8a5c", secondary: "#e3a8b8", accent: "#e8d27a" } },
  { id: "tulip", name: "Wild tulip", category: "flower", rarity: "uncommon", unlock: { kind: "quality_runs", count: 10 }, growthDays: 13, spacing: 0.03, depthBand: [0.5, 0.85], flowers: true, archetype: "flower_cup", palette: { primary: "#5f8054", secondary: "#e0b04e" } },
  { id: "dahlia", name: "Garden dahlia", category: "flower", rarity: "rare", unlock: { kind: "quality_runs", count: 14 }, growthDays: 16, spacing: 0.04, depthBand: [0.45, 0.8], flowers: true, archetype: "flower_cluster", palette: { primary: "#587a4f", secondary: "#d98a68", accent: "#b45a6a" } },
  { id: "wildflower_mix", name: "Wildflower cluster", category: "flower", rarity: "common", unlock: { kind: "quality_runs", count: 3 }, growthDays: 9, spacing: 0.045, depthBand: [0.5, 0.9], flowers: true, archetype: "flower_cluster", palette: { primary: "#66865c", secondary: "#d1b2d8", accent: "#e2c76e" } },

  // ── Ferns & shade plants ─────────────────────────────────────────────────
  { id: "maidenhair", name: "Maidenhair fern", category: "fern", rarity: "uncommon", unlock: { kind: "easy_runs", count: 6 }, growthDays: 14, spacing: 0.04, depthBand: [0.3, 0.7], flowers: false, archetype: "fern", palette: { primary: "#6f9463", secondary: "#3f4d3a" } },
  { id: "sword_fern", name: "Sword fern", category: "fern", rarity: "common", unlock: { kind: "easy_runs", count: 3 }, growthDays: 12, spacing: 0.045, depthBand: [0.3, 0.7], flowers: false, archetype: "fern", palette: { primary: "#54764a", secondary: "#43593c" } },
  { id: "hosta", name: "Hosta", category: "fern", rarity: "common", unlock: { kind: "easy_runs", count: 8 }, growthDays: 13, spacing: 0.04, depthBand: [0.35, 0.75], flowers: false, archetype: "hosta", palette: { primary: "#7d9a6a", secondary: "#a9bd8a" } },
  { id: "woodland_grass", name: "Woodland grass", category: "grass", rarity: "common", unlock: { kind: "easy_runs", count: 1 }, growthDays: 7, spacing: 0.035, depthBand: [0.35, 0.9], flowers: false, archetype: "grass_tuft", palette: { primary: "#7fa065", secondary: "#9db877" } },

  // ── Vines ────────────────────────────────────────────────────────────────
  { id: "ivy", name: "English ivy", category: "vine", rarity: "common", unlock: { kind: "consistent_weeks", count: 4 }, growthDays: 20, spacing: 0.02, depthBand: [0.1, 0.5], flowers: false, needsHost: "tree", archetype: "vine", palette: { primary: "#4e6f45", secondary: "#3c5738" } },
  { id: "clematis", name: "Clematis", category: "vine", rarity: "uncommon", unlock: { kind: "consistent_weeks", count: 6 }, growthDays: 24, spacing: 0.02, depthBand: [0.1, 0.5], flowers: true, needsHost: "tree", archetype: "vine", palette: { primary: "#5a7a50", secondary: "#9b7fc4" } },
  { id: "wisteria_vine", name: "River wisteria", category: "vine", rarity: "rare", unlock: { kind: "consistent_weeks", count: 10 }, growthDays: 30, spacing: 0.025, depthBand: [0.1, 0.45], flowers: true, needsHost: "tree", archetype: "vine", palette: { primary: "#6d8a5f", secondary: "#b0a3d4" } },
  { id: "flowering_creeper", name: "Flowering creeper", category: "vine", rarity: "uncommon", unlock: { kind: "consistent_weeks", count: 8 }, growthDays: 22, spacing: 0.02, depthBand: [0.15, 0.55], flowers: true, needsHost: "tree", archetype: "vine", palette: { primary: "#587a4e", secondary: "#e0a86a" } },

  // ── Groundcover ──────────────────────────────────────────────────────────
  { id: "clover", name: "White clover", category: "groundcover", rarity: "common", unlock: { kind: "start" }, growthDays: 5, spacing: 0.05, depthBand: [0.55, 0.95], flowers: false, archetype: "groundcover_patch", palette: { primary: "#79a266", secondary: "#eef2e2" } },
  { id: "moss", name: "Cushion moss", category: "groundcover", rarity: "common", unlock: { kind: "recovery_runs", count: 2 }, growthDays: 8, spacing: 0.04, depthBand: [0.5, 0.95], flowers: false, archetype: "moss", palette: { primary: "#6d9257", secondary: "#87a86b" } },
  { id: "thyme", name: "Creeping thyme", category: "groundcover", rarity: "common", unlock: { kind: "easy_runs", count: 5 }, growthDays: 7, spacing: 0.045, depthBand: [0.55, 0.95], flowers: true, archetype: "groundcover_patch", palette: { primary: "#7c9a6d", secondary: "#c39ac9" } },
  { id: "meadow_grass", name: "Meadow grass", category: "grass", rarity: "common", unlock: { kind: "start" }, growthDays: 4, spacing: 0.04, depthBand: [0.45, 0.95], flowers: false, archetype: "grass_tuft", palette: { primary: "#8aa96e", secondary: "#a6c07f" } },

  // ── Shrubs ───────────────────────────────────────────────────────────────
  { id: "lavender", name: "Lavender", category: "shrub", rarity: "common", unlock: { kind: "quality_runs", count: 5 }, growthDays: 18, spacing: 0.05, depthBand: [0.4, 0.75], flowers: true, archetype: "shrub_spike", palette: { primary: "#7b937a", secondary: "#a293c9" } },
  { id: "hydrangea", name: "Hydrangea", category: "shrub", rarity: "uncommon", unlock: { kind: "quality_runs", count: 9 }, growthDays: 22, spacing: 0.06, depthBand: [0.35, 0.7], flowers: true, archetype: "shrub_round", palette: { primary: "#6e8c60", secondary: "#a9bede" } },
  { id: "azalea", name: "Azalea", category: "shrub", rarity: "uncommon", unlock: { kind: "quality_runs", count: 12 }, growthDays: 20, spacing: 0.055, depthBand: [0.35, 0.7], flowers: true, archetype: "shrub_round", palette: { primary: "#69885c", secondary: "#d987a0" } },

  // ── Achievement species ──────────────────────────────────────────────────
  // Earned by named running milestones; appear as locked cards in the codex.
  { id: "sunrise_poppy", name: "Sunrise poppy", category: "flower", rarity: "rare", unlock: { kind: "early_runs", count: 5 }, growthDays: 12, spacing: 0.035, depthBand: [0.45, 0.85], flowers: true, archetype: "flower_cup", palette: { primary: "#6a8a58", secondary: "#e8a06a", accent: "#f2c14e" } },
  { id: "milestone_oak", name: "Milestone oak", category: "tree", rarity: "rare", unlock: { kind: "distance_run", meters: 10_000 }, growthDays: 60, spacing: 0.11, depthBand: [0.1, 0.45], flowers: false, archetype: "tree_round", palette: { primary: "#5e8050", secondary: "#7a5c40", accent: "#caa25a" } },
  { id: "horizon_cedar", name: "Horizon cedar", category: "tree", rarity: "rare", unlock: { kind: "distance_run", meters: 21_097 }, growthDays: 75, spacing: 0.1, depthBand: [0.05, 0.35], flowers: false, archetype: "tree_conifer", palette: { primary: "#3f6e57", secondary: "#63513f", accent: "#8fb7a0" } },
  { id: "century_rose", name: "Century rose", category: "shrub", rarity: "rare", unlock: { kind: "total_runs", count: 50 }, growthDays: 26, spacing: 0.055, depthBand: [0.35, 0.7], flowers: true, archetype: "shrub_round", palette: { primary: "#5f7f55", secondary: "#c95a6e", accent: "#e8b7c0" } },
  { id: "phoenix_fern", name: "Phoenix fern", category: "fern", rarity: "rare", unlock: { kind: "comeback_streak", count: 3 }, growthDays: 14, spacing: 0.045, depthBand: [0.3, 0.7], flowers: false, archetype: "fern", palette: { primary: "#8a6a3f", secondary: "#c9803f", accent: "#e0a45a" } },

  // ── Fungi ────────────────────────────────────────────────────────────────
  { id: "mushroom_cluster", name: "Mushroom cluster", category: "fungus", rarity: "common", unlock: { kind: "comeback" }, growthDays: 3, spacing: 0.03, depthBand: [0.5, 0.9], flowers: false, archetype: "mushroom", palette: { primary: "#c9a878", secondary: "#e6d9c2" } },
  { id: "shelf_fungus", name: "Shelf fungus", category: "fungus", rarity: "uncommon", unlock: { kind: "dead_wood" }, growthDays: 5, spacing: 0.025, depthBand: [0.4, 0.85], flowers: false, needsHost: "dead_wood", archetype: "shelf_fungus", palette: { primary: "#c2a06a", secondary: "#8a6f4d" } },
  { id: "mossy_log_moss", name: "Log moss", category: "fungus", rarity: "uncommon", unlock: { kind: "dead_wood" }, growthDays: 6, spacing: 0.025, depthBand: [0.4, 0.85], flowers: false, needsHost: "dead_wood", archetype: "moss", palette: { primary: "#5f8a50", secondary: "#7da868" } },

  // ── Strength species ────────────────────────────────────────────────────
  { id: "stonecrop", name: "Stonecrop", category: "groundcover", rarity: "common", unlock: { kind: "strength_sessions", count: 5 }, growthDays: 7, spacing: 0.045, depthBand: [0.55, 0.95], flowers: true, archetype: "groundcover_patch", palette: { primary: "#b5652f", secondary: "#8a4a22", accent: "#d99a3d" } },
  { id: "ironwood", name: "Ironwood", category: "tree", rarity: "uncommon", unlock: { kind: "strength_sessions", count: 12 }, growthDays: 60, spacing: 0.11, depthBand: [0.1, 0.45], flowers: false, archetype: "tree_round", palette: { primary: "#6b6234", secondary: "#5a3d28" } },
  { id: "terrace_fern", name: "Terrace fern", category: "fern", rarity: "rare", unlock: { kind: "strength_sessions", count: 20 }, growthDays: 14, spacing: 0.045, depthBand: [0.3, 0.7], flowers: false, archetype: "fern", palette: { primary: "#7a7038", secondary: "#4a4522" } },

  // ── Yoga species ─────────────────────────────────────────────────────────
  { id: "moon_lotus", name: "Moon lotus", category: "flower", rarity: "common", unlock: { kind: "yoga_sessions", count: 5 }, growthDays: 10, spacing: 0.035, depthBand: [0.45, 0.85], flowers: true, archetype: "flower_cup", palette: { primary: "#8f6fae", secondary: "#6d4f8a", accent: "#f2ede0" } },
  { id: "meditation_moss", name: "Meditation moss", category: "fungus", rarity: "uncommon", unlock: { kind: "yoga_sessions", count: 10 }, growthDays: 6, spacing: 0.025, depthBand: [0.4, 0.85], flowers: false, archetype: "moss", palette: { primary: "#8a7f96", secondary: "#a89fb5" } },
  { id: "lavender_drift", name: "Lavender drift", category: "flower", rarity: "rare", unlock: { kind: "yoga_sessions", count: 15 }, growthDays: 12, spacing: 0.035, depthBand: [0.4, 0.8], flowers: true, archetype: "flower_spike", palette: { primary: "#7c9483", secondary: "#9c8fc0" } },

  // ── Balance species ──────────────────────────────────────────────────────
  { id: "harmony_willow", name: "Harmony willow", category: "tree", rarity: "rare", unlock: { kind: "balanced_weeks", count: 3 }, growthDays: 65, spacing: 0.12, depthBand: [0.08, 0.4], flowers: false, archetype: "tree_weeping", palette: { primary: "#8fae9a", secondary: "#6f6353" } },

  // ── Ground species — exclusive to carved grounds (Bundle 3) ─────────────
  { id: "waterlily", name: "White waterlily", category: "flower", rarity: "rare", unlock: { kind: "ground", ground: "stream" }, growthDays: 14, spacing: 0.04, depthBand: [0.3, 0.8], flowers: true, aquatic: "channel", archetype: "water_lily", palette: { primary: "#6f8f7d", secondary: "#e8dbe8", accent: "#f2ede0" } },
  { id: "cattail", name: "Cattail", category: "flower", rarity: "common", unlock: { kind: "ground", ground: "stream" }, growthDays: 10, spacing: 0.035, depthBand: [0.3, 0.8], flowers: false, aquatic: "bank", archetype: "flower_spike", palette: { primary: "#7a8f5f", secondary: "#6b4a32" } },
  { id: "river_reed", name: "River reed", category: "grass", rarity: "common", unlock: { kind: "ground", ground: "stream" }, growthDays: 8, spacing: 0.035, depthBand: [0.3, 0.85], flowers: false, aquatic: "bank", archetype: "grass_tuft", palette: { primary: "#8fa06b", secondary: "#b5a878" } },
  { id: "mountain_sage", name: "Mountain sage", category: "shrub", rarity: "uncommon", unlock: { kind: "ground", ground: "terrace" }, growthDays: 20, spacing: 0.05, depthBand: [0.35, 0.7], flowers: true, archetype: "shrub_spike", palette: { primary: "#7c8f72", secondary: "#b5652f", accent: "#d99a3d" } },
  { id: "glade_harebell", name: "Glade harebell", category: "flower", rarity: "uncommon", unlock: { kind: "ground", ground: "glade" }, growthDays: 12, spacing: 0.033, depthBand: [0.4, 0.8], flowers: true, archetype: "flower_cup", palette: { primary: "#7c9483", secondary: "#8f6fae" } },

  // ── Achievement species (Bundle 3) ──────────────────────────────────────
  { id: "victory_laurel", name: "Victory laurel", category: "shrub", rarity: "rare", unlock: { kind: "races", count: 1 }, growthDays: 24, spacing: 0.055, depthBand: [0.35, 0.7], flowers: true, archetype: "shrub_round", palette: { primary: "#5f7f55", secondary: "#caa25a", accent: "#8a6248" } },
  { id: "summit_sequoia", name: "Summit sequoia", category: "tree", rarity: "rare", unlock: { kind: "distance_run", meters: 42_195 }, growthDays: 80, spacing: 0.11, depthBand: [0.05, 0.35], flowers: false, archetype: "tree_conifer", palette: { primary: "#3f6e57", secondary: "#5a3d28", accent: "#8fb7a0" } },
  { id: "old_beech", name: "Old-growth beech", category: "tree", rarity: "rare", unlock: { kind: "mature_trees", count: 3 }, growthDays: 70, spacing: 0.12, depthBand: [0.08, 0.42], flowers: false, archetype: "tree_round", palette: { primary: "#6f9a58", secondary: "#8a6248", accent: "#caa25a" } },
  { id: "moonflower", name: "Moonflower", category: "flower", rarity: "rare", unlock: { kind: "evening_runs", count: 10 }, growthDays: 12, spacing: 0.035, depthBand: [0.45, 0.85], flowers: true, archetype: "flower_cup", palette: { primary: "#5f8054", secondary: "#f2ede0", accent: "#c9d4e8" } },

  // ── Coached-block species (fairness spec §4) ────────────────────────────
  { id: "keystone_pine", name: "Keystone pine", category: "tree", rarity: "rare", unlock: { kind: "coached_blocks", count: 1 }, growthDays: 70, spacing: 0.1, depthBand: [0.08, 0.4], flowers: false, archetype: "tree_conifer", palette: { primary: "#4a6e52", secondary: "#6b4a32", accent: "#caa25a" } },
  { id: "keystone_grove", name: "Keystone grove", category: "tree", rarity: "rare", unlock: { kind: "coached_blocks", count: 3 }, growthDays: 75, spacing: 0.12, depthBand: [0.08, 0.42], flowers: false, archetype: "tree_round", palette: { primary: "#5a7d56", secondary: "#7a5c40", accent: "#8fb7a0" } },
];

export const SPECIES_BY_ID = new Map(SPECIES.map((s) => [s.id, s]));

export function speciesOrThrow(id: string): Species {
  const s = SPECIES_BY_ID.get(id);
  if (!s) throw new Error(`Unknown species: ${id}`);
  return s;
}
