import type { Attrs } from "./conditions/types.js";
import type {
  Contraction, DoseType, EquipmentId, Laterality, Load, MuscleId, Pattern, Position, Purpose, Region, Role, Tag,
} from "./vocab.js";

// The exercise record (programme spec §5.1). Condition ratings and notes are keyed by profile id.

export interface Dose {
  type: DoseType;
  /** [low, high]: reps, seconds, breaths, or seconds under a weight (`carry`: walked with or held, the timed type that takes a load). */
  range: readonly [number, number];
  /** [min, max] working sets. */
  sets?: readonly [number, number];
  restSec?: number;
  /** Seconds one rep takes, or one breath on a breaths dose (a breath with a pause after it takes longer than a plain one). */
  secsPerRep?: number;
  /** Starting weight in kg when there's no history. */
  startKg?: number;
}

export interface ExerciseText {
  /** The card line: plain words, at most 90 characters. */
  summary: string;
  setup: readonly string[];
  steps: readonly string[];
  focus: readonly string[];
  mistakes: readonly string[];
  breathing: string;
  why: string;
  /** A note per condition profile, keyed by profile id. */
  conditions: Readonly<Record<string, string>>;
}

/**
 * A library move's place in the COROS strength catalog (Phase 3, spec §2). Only `exact` is ever pushed; `close` and
 * `generic` stay on record and the move goes to the watch as free text (spike outcome A).
 *
 * CURATING ONE. `exact` means the same movement with the same implement CLASS (`IMPLEMENT_CLASS`): kettlebell and
 * dumbbells are one class, a hand-held free weight; barbell, cable, machine and band are each their own. So a row done
 * with a kettlebell or dumbbells is exact to COROS's "One Arm Dumbbell Row" (the watch may name a dumbbell for a
 * kettlebell set — same lift, and `exact` is what lets a lap pair by T-code), while our kettlebell-or-dumbbell deadlift
 * is only `close` to COROS's "Deadlifts" (the barbell lift) and a band face pull only `close` to its cable one. A COROS
 * name that names no implement ("Goblet Squat") is judged on the movement alone. Audit 3-A W-5; the library's
 * coros-mapping test holds every exact key whose COROS name names an implement to this rule.
 */
export interface CorosMapping {
  /** The COROS catalog T-code ("T1041") — what `coros_exercises.name` and a lap's `exerciseNameKey` carry. */
  key: string;
  confidence: "exact" | "close" | "generic";
  method: "curated" | "computed";
}

export interface ExerciseEquipment {
  all: readonly EquipmentId[];
  oneOf: readonly EquipmentId[];
}

export interface ExerciseRecord {
  /** Permanent camelCase id; history, prefs and blocks key on it. */
  id: string;
  /** Renames keep history. */
  legacyIds: readonly string[];
  name: string;
  family: string;
  patterns: readonly Pattern[];
  regions: readonly Region[];
  roles: readonly Role[];
  equipment: ExerciseEquipment;
  position: Position;
  laterality: Laterality;
  load: Load;
  dose: Dose;
  /** 1–5. */
  difficulty: number;
  easier: readonly string[];
  harder: readonly string[];
  tags: readonly Tag[];
  /** How the muscles work (at least one). */
  contraction: readonly Contraction[];
  /** Muscles worked (primary at least one; no muscle in both lists). */
  muscles: { primary: readonly MuscleId[]; secondary: readonly MuscleId[] };
  /** What the move is for (at least one). */
  purposes: readonly Purpose[];
  /** Theme ids from themes.ts (may be empty). */
  themes: readonly string[];
  text: ExerciseText;
  /** Ratings per condition profile, keyed by profile id; each profile's attribute specs say what's inside. */
  conditions: Readonly<Record<string, Attrs>>;
  providers?: { coros?: CorosMapping };
}

/**
 * Whether a move's dose counts per side: a one-sided move's always does (its seconds run per side too); an alternating
 * move's does when it's counted (8 each way in one set), not on a clock, whose one window holds both sides.
 */
export const countsPerSide = (ex: Pick<ExerciseRecord, "laterality" | "dose">): boolean =>
  ex.laterality === "unilateral" || (ex.laterality === "alternating" && ex.dose.type !== "time" && ex.dose.type !== "carry");

/**
 * A move that belongs to one fixed practice (TRE's sequence, say): it plays where that practice's own documents put it.
 * Nothing picks it for another session: no block of the day's build takes its role, and the quick starts, suggestions and
 * ⇄ offers leave it out. Search still finds it, and the athlete or the coach can place it by hand.
 */
export const isPracticeMove = (ex: Pick<ExerciseRecord, "roles">): boolean => ex.roles.includes("practice");

/** A jump, hop, bound or landing (validation requires `contraction` on every record; a hand-made one without it isn't). */
export const isPlyometric = (ex: Pick<ExerciseRecord, "contraction">): boolean =>
  Array.isArray(ex.contraction) && ex.contraction.includes("plyometric");
