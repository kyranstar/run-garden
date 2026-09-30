import type { LocalDate, Weight, WeightUnit } from "@rg/domain";
import type {
  BlockId, CheckReading, DoseType, EngineData, ExerciseRecord, FormatId, HistoryEntry, HistorySession, HistorySet, Mode, Theme,
} from "@rg/exercise-library";

// The engine's inputs and outputs. The history shapes and EngineData come from the library (the condition
// profile contract reads them); everything here is plain data in, plain data out.

export type { BlockId, CheckReading, EngineData, ExerciseRecord, FormatId, HistoryEntry, HistorySession, HistorySet, LocalDate, Mode, Theme, Weight, WeightUnit };

/** The person's exercise preferences: ±1 ratings, exclusions ("not for me"), and pinned core lifts. */
export interface Prefs {
  ratings: Readonly<Record<string, number>>;
  excluded: readonly string[];
  pinned: readonly string[];
}

/** Where a session happens: its gear, and the implement weights available there (e.g. kettlebells). */
export interface EngineLocation {
  id: string;
  name?: string;
  equipment: readonly string[];
  /** Weights per implement id, e.g. `{ kettlebell: [{v: 10, u: "lb"}, …] }`. */
  implements?: Readonly<Record<string, readonly Weight[]>>;
}

/** A swap for one slot: the move the plan chose (`from`) and the move the person picked (`to`). */
export interface Swap {
  from?: string | null;
  to?: string | null;
}
export type Swaps = Readonly<Record<string, Swap | null | undefined>>;

export interface Rotation {
  family: string;
  from: string | null;
  to: string;
  date: LocalDate;
  why: string;
}

/** A training block: one core lift per family for N weeks. */
export interface Block {
  id: string;
  number: number;
  startedAt: LocalDate;
  weeks: number;
  core: Readonly<Record<string, string | null>>;
  rotations: readonly Rotation[];
}

/** One day's session request. `mode` and `theme` (a theme id) are overrides; the proposal decides otherwise. */
export interface EngineInput {
  today: LocalDate;
  mode?: Mode;
  theme?: string;
  minutes: number;
  location: EngineLocation;
  unit: WeightUnit;
  sessions: readonly HistorySession[];
  prefs: Prefs;
  /** Exercise ids the person saved themselves (from their private provenance); they come up a bit more. */
  savedIds: readonly string[];
  block: Block | null;
  /** Today's check per profile id. */
  checks: Readonly<Record<string, CheckReading>>;
  swaps: Swaps;
}

/** What the builder needs: the mode and theme already decided. */
export interface BuildInput extends Omit<EngineInput, "mode" | "theme" | "prefs" | "savedIds" | "checks" | "swaps"> {
  mode: Mode;
  theme: Theme | null;
  prefs?: Partial<Prefs>;
  savedIds?: readonly string[];
  checks?: Readonly<Record<string, CheckReading>>;
  swaps?: Swaps;
}

export type ProgAction = "start" | "up" | "down" | "hold" | "reps" | "more" | "tempo" | "graduate";

/** The next weight / reps / hold for one exercise, with a plain-language note. */
export interface Target {
  lo: number;
  hi: number;
  type: DoseType;
  w: Weight | null;
  reps: number | null;
  secs: number | null;
  graduate: string | null;
  /** Summary of the last logged session of this exercise. */
  last: string | null;
  lastDate: LocalDate | null;
  action: ProgAction;
  note: string;
}

export interface StepFormat {
  id: FormatId;
  group: string | null;
  round: number | null;
}

/** One step the player plays: a timed window, a self-paced set, or a rest. */
export interface Step {
  kind: "timed" | "set" | "rest";
  slotKey: string;
  block: BlockId;
  exerciseId: string | null;
  side: "Left" | "Right" | null;
  setIndex: number | null;
  setCount: number | null;
  seconds: number;
  prepGap: number;
  target: Partial<Target> | null;
  format: StepFormat;
  why: string[];
  isNew: boolean;
  log: boolean;
}

export interface Item {
  slotKey: string;
  block: BlockId;
  exercise: ExerciseRecord;
  format: FormatId;
  sets: number;
  group: string | null;
  coreFamily: string | null;
  target: Target | null;
  why: string[];
  isNew: boolean;
}

export interface Group {
  block: BlockId;
  format: FormatId;
  items: Item[];
  rounds?: number;
}

export interface Plan {
  mode: Mode;
  theme: Theme | null;
  minutes: number;
  seed: string;
  groups: Group[];
  items: Item[];
  steps: Step[];
  plannedSeconds: number;
  newMove: string | null;
}

/** A swap the player can make offline: the move, why, and the slot's steps if it were swapped in. */
export interface Alternative {
  id: string;
  name: string;
  reasons: string[];
  steps: Step[];
}

export interface BuildResult extends Plan {
  /** Top alternatives per slot key, computed once per build. */
  alternatives: Record<string, Alternative[]>;
}
