import type {
  GardenEvent,
  GardenPlant,
  GardenSeason,
  GardenWeatherState,
  LocalDate,
  WildlifeKind,
  WorkoutCategory,
} from "@rg/domain";

export const SIMULATION_VERSION = 1;

/** Tunable pacing constants. Defaults implement the product's decay curve. */
export interface GardenConfig {
  /** Days without a completed run before visible dryness. */
  drynessStartDays: number;
  /** Days without a completed run before mild drought (wilting, growth pause). */
  droughtStartDays: number;
  /** Days before dormancy, leaf fall, wildlife decline. */
  dormancyStartDays: number;
  /** Days before the weakest non-tree plants may start dying. */
  deathStartDays: number;
  /** Days before trees may die (mature trees die last). */
  treeDeathStartDays: number;
  /** Minimum days between individual plant deaths. */
  deathIntervalDays: number;
  /** Max scene regions the garden can expand into. */
  maxRegions: number;
  /** Living plants per region before expansion. */
  regionCapacity: number;
}

export const DEFAULT_GARDEN_CONFIG: GardenConfig = {
  drynessStartDays: 4,
  droughtStartDays: 14,
  dormancyStartDays: 30,
  deathStartDays: 60,
  treeDeathStartDays: 120,
  deathIntervalDays: 4,
  maxRegions: 6,
  regionCapacity: 14,
};

/** Engine-internal state: the domain GardenState plus long-term counters. */
export interface EngineGardenState {
  moisture: number;
  soilHealth: number;
  biodiversity: number;
  canopy: number;
  floweringDensity: number;
  droughtDays: number;
  daysSinceCompletedRun: number;
  weatherState: GardenWeatherState;
  season: GardenSeason;
  lastSimulatedDate: LocalDate;
  restMode: boolean;
  unlockedRegions: number;

  // Long-term counters driving unlocks (planned runs only).
  qualityRunCount: number;
  easyRunCount: number;
  longRunCount: number;
  recoveryRunCount: number;
  eveningRunCount: number;
  totalCompletedRuns: number;
  consecutiveConsistentWeeks: number;
  /** Consecutive completed-run days since the last drought ended. */
  comebackStreak: number;
  /** True while recovering from a drought (affects visuals + fungi unlock). */
  inComeback: boolean;
  lastPlantDeathDate: LocalDate | null;
  /** Garden birth date (never resets). */
  createdDate: LocalDate;
}

export interface GardenSnapshot {
  version: number;
  state: EngineGardenState;
  plants: GardenPlant[];
  unlockedSpeciesIds: string[];
  wildlife: Record<WildlifeKind, boolean>;
}

export interface CompletedRunInput {
  workoutId: string;
  activityId?: string;
  category: WorkoutCategory;
  window?: "morning" | "evening";
  /** True when this run was not part of the plan (modest rewards only). */
  unplanned?: boolean;
}

/** Everything that happened on one resolved calendar day. */
export interface GardenDayInput {
  date: LocalDate;
  completedRuns: CompletedRunInput[];
  /** A planned rest day that was correctly observed. */
  restObserved: boolean;
  /** Runs explicitly skipped or aged out, resolved on this date. */
  missedRuns: Array<{ workoutId: string }>;
  restModeActive: boolean;
  /** True when no plan covers this day (plan gap → no penalties). */
  planGap: boolean;
  /** On week-boundary days: previous week's plan adherence 0..1. */
  weekAdherence?: number;
}

export interface DayResult {
  snapshot: GardenSnapshot;
  events: GardenEvent[];
}
