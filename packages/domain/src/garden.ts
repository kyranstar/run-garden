import { z } from "zod";
import type { LocalDate } from "./time.js";

export const GARDEN_SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type GardenSeason = (typeof GARDEN_SEASONS)[number];

export const GARDEN_WEATHER_STATES = [
  "fresh_rain",
  "clear_sun",
  "light_clouds",
  "dry_spell",
  "mild_drought",
  "recovery_rain",
  "seasonal_breeze",
  "soft_sun",
] as const;
export type GardenWeatherState = (typeof GARDEN_WEATHER_STATES)[number];

export const PLANT_CATEGORIES = [
  "groundcover",
  "grass",
  "fern",
  "flower",
  "shrub",
  "vine",
  "tree",
  "fungus",
] as const;
export type PlantCategory = (typeof PLANT_CATEGORIES)[number];

export const PLANT_STATES = [
  "seed",
  "growing",
  "mature",
  "flowering",
  "thirsty",
  "wilted",
  "dormant",
  "dead",
] as const;
export type PlantState = (typeof PLANT_STATES)[number];

export interface GardenPosition {
  /** 0..1 across the scene, stable forever once assigned */
  x: number;
  /** 0..1 depth; larger = nearer the viewer */
  y: number;
  /** region index; the garden expands into new regions over time */
  region: number;
}

export interface GardenState {
  moisture: number; // 0..1
  soilHealth: number; // 0..1
  biodiversity: number; // 0..1 derived from living species variety
  canopy: number; // 0..1 derived from mature trees
  floweringDensity: number; // 0..1
  droughtDays: number;
  daysSinceCompletedRun: number;
  weatherState: GardenWeatherState;
  season: GardenSeason;
  lastSimulatedDate: LocalDate;
  restMode: boolean;
  /** Regions currently unlocked (scene grows outward, plants never shrink away). */
  unlockedRegions: number;
}

export interface GardenPlant {
  id: string;
  speciesId: string;
  category: PlantCategory;
  plantedAt: LocalDate;
  sourceWorkoutId?: string;
  health: number; // 0..1
  hydration: number; // 0..1
  maturity: number; // 0..1
  bloomProgress: number; // 0..1
  state: PlantState;
  position: GardenPosition;
  hostPlantId?: string; // vines climb a host tree; fungi grow on dead wood
  diedAt?: LocalDate;
  /** Dead plants become habitat instead of disappearing. */
  habitatRole?: "nurse_log" | "perch" | "mushroom_host" | null;
}

export const GARDEN_EVENT_KINDS = [
  "run_completed",
  "rest_observed",
  "missed_run",
  "daily_tick",
  "plant_added",
  "plant_state_changed",
  "plant_died",
  "species_unlocked",
  "wildlife_arrived",
  "wildlife_departed",
  "region_unlocked",
  "rest_mode_started",
  "rest_mode_ended",
  "weather_changed",
] as const;
export type GardenEventKind = (typeof GARDEN_EVENT_KINDS)[number];

export const gardenEventSchema = z.object({
  id: z.string(),
  kind: z.enum(GARDEN_EVENT_KINDS),
  date: z.string(),
  /** Deterministic ordering within a date. */
  seq: z.number().int(),
  workoutId: z.string().optional(),
  activityId: z.string().optional(),
  workoutCategory: z.string().optional(),
  plantId: z.string().optional(),
  speciesId: z.string().optional(),
  wildlifeId: z.string().optional(),
  detail: z.string().optional(),
  simulationVersion: z.number().int(),
});
export type GardenEvent = z.infer<typeof gardenEventSchema>;

export const WILDLIFE_KINDS = ["birds", "bees", "butterflies", "fireflies"] as const;
export type WildlifeKind = (typeof WILDLIFE_KINDS)[number];

export interface GardenWildlife {
  kind: WildlifeKind;
  present: boolean;
  since?: LocalDate;
}

/** Words used in primary UI instead of raw numbers. */
export type GardenConditionWord =
  | "flourishing"
  | "growing"
  | "well_watered"
  | "a_little_dry"
  | "recovering"
  | "dormant"
  | "in_drought";

export const GARDEN_CONDITION_LABELS: Record<GardenConditionWord, string> = {
  flourishing: "Flourishing",
  growing: "Growing",
  well_watered: "Well watered",
  a_little_dry: "A little dry",
  recovering: "Recovering",
  dormant: "Dormant",
  in_drought: "In drought",
};
