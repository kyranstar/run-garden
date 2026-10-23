import { UNANSWERED, type Attrs, type CheckReading, type ConditionProfile } from "./conditions/types.js";
import type { EngineData } from "./engine-data.js";
import { isPlyometric, type ExerciseRecord } from "./record.js";
import type { Theme } from "./themes.js";
import { MODE_IDS, type Mode } from "./vocab.js";

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
 * The mode's general limits plus every active profile's `never`, `fitsMode`, `allowPattern` and `allowRecord`.
 * With `checks`, the day's readings apply (an unanswered profile reads as unanswered); without them, the
 * question is whether the move fits this mode at all, judged on each profile's calmest day.
 * A recovery day whose reading is a profile's flare takes only that profile's flare-safe moves: a flare is a recovery
 * day, and the strictest one (a mode chosen above recovery on a flare day keeps that mode's own caps).
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
    if (p.never(a) || !p.fitsMode(a, mode, ex)) return false;
    const today = checks ? checks[p.id] ?? UNANSWERED : bestDay(p);
    if (mode === "recovery" && p.flare(today) && !p.flareSafe(a)) return false;
    if (!ex.patterns.every(pattern => p.allowPattern(pattern, mode, today))) return false;
    if (p.allowRecord && !p.allowRecord(ex, mode, today)) return false;
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

/** A profile's flare day: its highest check, the day its flare-safe rules exist for (a flare day is a recovery day). */
export const flareDay = (profile: ConditionProfile): CheckReading => ({ pre: profile.check.max, post: null, feelingOff: false });

/**
 * One profile's flare-safe verdict on a whole record: its ratings are flare-safe and its record rule allows it in
 * recovery on a flare day (so a low-clench jump is never "safe"). The one verdict eligibility and the library share.
 */
export function recordFlareSafe(profile: ConditionProfile, ex: ExerciseRecord): boolean {
  const a = attrsOf(ex, profile);
  return a != null && profile.flareSafe(a) && (profile.allowRecord?.(ex, "recovery", flareDay(profile)) ?? true);
}

/** Safe on a flare day for every active profile (true when no profile is active). */
export function flareSafe(data: EngineData, ex: ExerciseRecord): boolean {
  return data.profiles.active.every(p => recordFlareSafe(p, ex));
}

/** A theme that emphasises plyometric work: the only days the programme places a plyometric move. */
export const plyometricDay = (theme: Pick<Theme, "emphasis"> | null | undefined): boolean =>
  ((theme?.emphasis.contractions ?? {}).plyometric ?? 0) > 0;

/**
 * A plyometric move is on the athlete's frontier when it has no easier variant or any easier variant has been done:
 * a never-jumped athlete starts at the bottom rungs, and each move done unlocks the next. Other moves always are.
 */
export const onFrontier = (ex: ExerciseRecord, done: (id: string) => boolean): boolean =>
  !isPlyometric(ex) || ex.easier.length === 0 || ex.easier.some(id => done(id));

/** What a move's history says for the ladder: the last day it was done, how often it was logged, and with which flags. */
export interface MoveTally {
  lastDate: string | null;
  /** Logged entries (any format). */
  logged: number;
  /** Logged entries carrying each flag. */
  flags: Readonly<Record<string, number>>;
}

/**
 * Whether a move was DONE CLEANLY — the one rule for what unlocks the next rung (`onFrontier`'s `done`): done, and
 * either never logged (no flag could be set) or logged at least once without each active profile's set flag. A rung
 * only ever done with a profile's flag on it (clenched) unlocks nothing. The engine's ladder reads it per move from its
 * history stats; anyone building a validator's `DayContext.done` must use it too (per move, legacy ids merged into the
 * move they now are), so the Studio, the coach and the engine agree on the frontier. Resting a flagged rung is the
 * engine's own rule (`restingBy`), not this one.
 */
export function isDoneCleanly(tally: MoveTally | null | undefined, profiles: readonly ConditionProfile[]): boolean {
  if (!tally || !tally.lastDate) return false;
  return tally.logged === 0 || profiles.every(p => !p.setFlag || (tally.flags[p.setFlag.id] || 0) < tally.logged);
}

/** The core family a core-role exercise belongs to, by pattern. */
export function coreFamilyOf(data: EngineData, ex: ExerciseRecord | null | undefined): string | null {
  if (!ex || !ex.roles.includes("core")) return null;
  const fam = data.coreFamilies.find(f => f.patterns.some(p => ex.patterns.includes(p)));
  return fam ? fam.id : null;
}

// ── Today's fit ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** How a move fits today: fits (safe even on a flare day) · care (allowed today, within the profile's limits) · not. */
export type FitState = "fits" | "care" | "not";
/** Lower is better: the worst profile decides, and a search ranks by it. */
export const FIT_RANK: Readonly<Record<FitState, number>> = { fits: 0, care: 1, not: 2 };

function allowedIn(rec: ExerciseRecord, p: ConditionProfile, modes: readonly Mode[], r: CheckReading): boolean {
  const a = attrsOf(rec, p)!;
  return modes.some(
    (m) => p.fitsMode(a, m, rec) && rec.patterns.every((pt) => p.allowPattern(pt, m, r)) && (p.allowRecord?.(rec, m, r) ?? true),
  );
}

function profileFit(rec: ExerciseRecord, p: ConditionProfile, r: CheckReading): { state: FitState; reason: string } {
  const a = attrsOf(rec, p);
  // An unrated move fails closed, as everywhere else in the library.
  if (!a || p.never(a)) return { state: "not", reason: `${p.label} rules this move out.` };
  // A flare day, or feeling off, is a recovery day; a flare day's recovery takes flare-safe moves only (as `fitsMode`).
  const easy = p.flare(r) || r.feelingOff;
  if (allowedIn(rec, p, easy ? ["recovery"] : MODE_IDS, r) && (!p.flare(r) || recordFlareSafe(p, rec))) {
    return recordFlareSafe(p, rec)
      ? { state: "fits", reason: `Safe for ${p.label}, even on a flare day.` }
      : { state: "care", reason: `Fine today, within ${p.label} limits.` };
  }
  const own = p.recordReason?.(rec, "build", r) ?? null;
  if (own) return { state: "not", reason: own };
  const check = p.check.label.toLowerCase();
  if (r.feelingOff) return { state: "not", reason: "Not while you're feeling off." };
  if (r.pre === null) return { state: "not", reason: `Needs today's ${check} check.` };
  return { state: "not", reason: `Not with ${check} at ${r.pre} today.` };
}

/**
 * A move against every switched-on condition profile for TODAY's reading — the one rule the Studio's list and the
 * coach's library search share: the worst profile decides, with the reason in plain words (the profile's own where it
 * has them). Null with no profile on: nothing to say. A profile with no reading today is unanswered.
 */
export function fitToday(
  rec: ExerciseRecord,
  profiles: readonly ConditionProfile[],
  readings: Readonly<Record<string, CheckReading>>,
): { state: FitState; reason: string } | null {
  let worst: { state: FitState; reason: string } | null = null;
  for (const p of profiles) {
    const f = profileFit(rec, p, readings[p.id] ?? UNANSWERED);
    if (!worst || FIT_RANK[f.state] > FIT_RANK[worst.state]) worst = f;
  }
  return worst;
}
