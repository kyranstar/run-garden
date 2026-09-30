import { UNANSWERED, type Attrs, type CheckReading, type ConditionProfile } from "./conditions/types.js";
import type { EngineData } from "./engine-data.js";
import type { ExerciseRecord } from "./record.js";
import type { Mode } from "./vocab.js";

// Whether an exercise can appear: equipment, the mode's general limits, and every active condition
// profile's rules. The session engine's Lib delegates here; validation's coverage check uses the same rules.

/** This exercise's ratings for a profile, or undefined when it isn't rated (validation reports that). */
export const attrsOf = (ex: ExerciseRecord, profile: ConditionProfile): Attrs | undefined => ex.conditions?.[profile.id];

/** The calmest possible check for a profile: answers "is this allowed in this mode on a good day?". */
export const bestDay = (profile: ConditionProfile): CheckReading => ({ pre: profile.check.min, post: profile.check.min, feelingOff: false });

export function hasEquipment(ex: ExerciseRecord, equipment: readonly string[] | null | undefined): boolean {
  const have = new Set(equipment ?? []);
  const req = ex.equipment;
  return req.all.every(i => have.has(i)) && (!req.oneOf.length || req.oneOf.some(i => have.has(i)));
}

/**
 * The mode's general limits plus every active profile's `never`, `fitsMode` and `allowPattern`.
 * With `checks`, the day's readings apply (an unanswered profile reads as unanswered); without them, the
 * question is whether the move fits this mode at all, judged on each profile's calmest day.
 * An active profile with no rating on the record fails closed.
 */
export function fitsMode(data: EngineData, ex: ExerciseRecord, mode: Mode, checks?: Readonly<Record<string, CheckReading>>): boolean {
  const m = data.modes[mode];
  if (!m) return false;
  if (ex.difficulty > m.maxDifficulty) return false;
  if (!m.allowExternalLoad && ex.load === "external") return false;
  for (const p of data.profiles.active) {
    const a = attrsOf(ex, p);
    if (!a) return false;
    if (p.never(a) || !p.fitsMode(a, mode)) return false;
    const today = checks ? checks[p.id] ?? UNANSWERED : bestDay(p);
    if (!ex.patterns.every(pattern => p.allowPattern(pattern, mode, today))) return false;
  }
  return true;
}

export interface EligibleOptions {
  equipment: readonly string[] | null | undefined;
  mode: Mode;
  excluded?: readonly string[];
  checks?: Readonly<Record<string, CheckReading>>;
}

export const eligible = (data: EngineData, ex: ExerciseRecord, { equipment, mode, excluded = [], checks }: EligibleOptions): boolean =>
  hasEquipment(ex, equipment) && fitsMode(data, ex, mode, checks) && !excluded.includes(ex.id);

/** Safe on a flare day for every active profile (true when no profile is active). */
export function flareSafe(data: EngineData, ex: ExerciseRecord): boolean {
  return data.profiles.active.every(p => {
    const a = attrsOf(ex, p);
    return a != null && p.flareSafe(a);
  });
}

/** The core family a core-role exercise belongs to, by pattern. */
export function coreFamilyOf(data: EngineData, ex: ExerciseRecord | null | undefined): string | null {
  if (!ex || !ex.roles.includes("core")) return null;
  const fam = data.coreFamilies.find(f => f.patterns.some(p => ex.patterns.includes(p)));
  return fam ? fam.id : null;
}
