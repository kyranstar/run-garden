import type {
  GardenEvent,
  GardenPlant,
  GardenSeason,
  GardenWeatherState,
  LocalDate,
  WildlifeKind,
  WorkoutCategory,
} from "@rg/domain";

export const SIMULATION_VERSION = 3;

/** The three disciplines the garden listens to; each drives its own axis. */
export type Discipline = "run" | "strength" | "yoga";

/** What kind of ground an expansion carved — chosen by the training that led the block. */
export type GroundKind = "meadow" | "stream" | "terrace" | "glade";

export interface EarnedGround {
  /** 0-based region index into layout.ts REGION_BANDS. */
  region: number;
  kind: GroundKind;
  earnedDate: LocalDate;
}

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
  /** Water axis clock: days since the last completed run. */
  daysSinceCompletedRun: number;
  /** Earth axis clock: days since the last strength session. */
  daysSinceStrength: number;
  /** Life axis clock: days since the last yoga session. */
  daysSinceYoga: number;
  /** Whether a strength/yoga session has EVER been recorded. Optional so
   * persisted pre-tri-discipline snapshots stay valid; absent means false.
   * Without these, a migrated garden's clock starts at zero and the UI
   * fabricates "lifted 1 d ago" for someone who never lifted. */
  hasStrength?: boolean;
  hasYoga?: boolean;
  weatherState: GardenWeatherState;
  season: GardenSeason;
  lastSimulatedDate: LocalDate;
  restMode: boolean;
  unlockedRegions: number;
  /** Grounds earned by expansion (region 0, the first meadow, is implicit).
   * Optional so persisted pre-v3 snapshots stay readable. */
  grounds?: EarnedGround[];
  /** Counter watermarks at the last expansion — the "since then" baseline
   * that decides what kind of ground the next expansion carves. */
  countersAtExpansion?: { long: number; strength: number; yoga: number; balanced: number };

  // Long-term counters driving unlocks (planned runs only).
  qualityRunCount: number;
  easyRunCount: number;
  longRunCount: number;
  recoveryRunCount: number;
  eveningRunCount: number;
  /** Runs started before 07:00 local (any run, planned or not). */
  earlyRunCount: number;
  /** Longest single run ever, in meters (any run, planned or not). */
  longestRunMeters: number;
  totalCompletedRuns: number;
  consecutiveConsistentWeeks: number;
  /** Consecutive completed-run days since the last drought ended. */
  comebackStreak: number;
  /** Best comeback streak ever reached (survives the streak's own reset). */
  bestComebackStreak: number;
  /** True while recovering from a drought (affects visuals + fungi unlock). */
  inComeback: boolean;
  lastPlantDeathDate: LocalDate | null;

  /** Strength sessions ever completed (planned or not). */
  strengthSessionCount: number;
  /** Yoga sessions ever completed (planned or not). */
  yogaSessionCount: number;
  /** Mon–Sun weeks that held at least one run, one lift and one yoga session. */
  balancedWeekCount: number;
  /** Discipline flags for the in-progress Mon–Sun week. */
  weekDisciplines: { weekStart: LocalDate; run: boolean; strength: boolean; yoga: boolean };
  /**
   * Yoga's standing contribution to the life axis. `biodiversity` and
   * `floweringDensity` are recomputed from the living plants every day, so the
   * yoga-earned part is held separately and re-applied on top of that baseline
   * (see `recomputeDerived`); neglect fades it back to zero, never below the
   * variety the garden actually has. Bounded by static reservoirs (0.5 / 0.35)
   * so credit already earned is never clawed back as the garden grows.
   */
  lifeBonusBiodiversity: number;
  lifeBonusFlowering: number;

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
  /**
   * Which discipline this session belongs to. Absent falls back to the
   * category, so stored inputs from before the tri-discipline engine replay
   * unchanged for runs and correctly for strength/yoga workouts.
   */
  discipline?: Discipline;
  window?: "morning" | "evening";
  /** True when this run was not part of the plan (modest rewards only). */
  unplanned?: boolean;
  /** Distance in meters, when known — drives distance-milestone unlocks. */
  distanceMeters?: number;
  /** Local start hour 0–23, when known — drives the early-bird unlock. */
  startHourLocal?: number;
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
