/**
 * Derivations of a workout document, and of what was actually performed. Nothing here is ever authored
 * (principles §3.1): minutes, balance of contraction types, exposure, discipline, category, mode, equipment,
 * condition maxima, watch steps.
 *
 * RULES
 * - Resolution: a library id resolves through `legacyIds` too. An item the library cannot resolve (and a free-text
 *   exercise) still counts its minutes and watch steps, but adds no balance, exposure, equipment or condition rating.
 * - Dose of an exercise item: sets = dose.sets, else the record's low set count, else 1. Per set the work is, in order:
 *   holdSec; breaths x 6 s; carryM x 1 s (a 1 m/s walk); reps x seconds-per-rep. When the dose gives none of these the
 *   record's own dose range midpoint stands in. Seconds-per-rep = the sum of the tempo's parts when given, else the
 *   record's `secsPerRep`, else 3. A rep range counts as its rounded midpoint. `perSide` (with no fixed `side`) doubles
 *   the work and the reps of every set. Rest between sets = (sets - 1) x (dose.restSec, else the record's, else 0).
 * - Parts: `rounds` multiplies every item (its sets, work, rests and watch steps); `restBetweenRoundsSec` is added
 *   (rounds - 1) times. A rest item adds its seconds to the minutes, to no balance, and is not a watch step.
 * - Run: duration, else distance at the middle of the pace band, else 6:00/km (rounded to whole seconds); an open
 *   segment counts a nominal 600 s. Run seconds are aerobic seconds, and any run item makes the run axis present.
 * - Minutes = round(total seconds / 60), at least 1 when there is any time.
 * - Balance (an item counts toward every contraction its record lists): isometric = work seconds; isotonic and eccentric
 *   = reps (rep-dosed items only); plyometric = contacts (reps x sets); `passive` counts toward no contraction. Work
 *   seconds of an item whose purposes include mobility or stretch are mobility seconds; the work seconds of a passive
 *   item with any other purpose are recovery seconds (`recoverySec`).
 * - Exposure: a region gets the item's sets (x rounds) for every region its record lists; a muscle gets the same sets
 *   x 1 (primary) or x 0.5 (secondary). `perSide` does not double sets here.
 * - Discipline uses the garden's axis names, "run" | "strength" | "yoga". Per item, work + rest seconds go to run (run
 *   items), strength (records with a strength, power, activation, conditioning or balance purpose; free exercises in a
 *   main, power, accessory, conditioning or activation part) or yoga (the rest). Dominant = run when run is at least
 *   half of all seconds (or the only axis present), else strength when it is at least yoga, else yoga. `disciplines` lists
 *   every axis present, dominant first, then by seconds.
 * - Category: race / tempo / threshold / interval / hills (never strides) make race / quality only when the run axis is dominant or those
 *   efforts are at least 25% of all seconds; otherwise the dominant discipline decides. Otherwise, for a run
 *   workout, long (a long effort, or 75 minutes or more of run) -> long; recovery effort (or a "recover" intent with only
 *   recovery / easy runs) -> recovery; else easy. A strength workout is strength, a yoga one yoga. (planned_workouts
 *   already uses easy / long / quality / recovery / race / strength / yoga, so these map one to one.)
 * - Watch steps count executions (the push's totalSets), not wire rows: sets x rounds x (perSide ? 2 : 1) per exercise or free-exercise item, rounds per run segment.
 * - Equipment: `all` = the union of the records' `all`; `oneOf` = each distinct one-of group not already satisfied by
 *   an `all` entry, members sorted.
 * - Condition maxima: for each profile, each attribute's highest rating among the resolved items (a flag counts 1 or 0).
 */
import type { WorkoutDoc, WorkoutItem } from "@rg/domain";
import type { ExerciseRecord, Mode } from "@rg/exercise-library";

export type WorkoutAxis = "run" | "strength" | "yoga";
export type WorkoutCategory = "easy" | "long" | "quality" | "recovery" | "race" | "strength" | "yoga";
type Effort = WorkoutDoc["intent"]["effort"];

export interface BalanceProfile {
  isometricSec: number;
  isotonicReps: number;
  eccentricReps: number;
  plyoContacts: number;
  aerobicSec: number;
  mobilitySec: number;
  /** Passive time that is neither mobility nor stretch: breathing, release, rest in a flow. */
  recoverySec: number;
}

export interface DocDerived {
  estimatedMinutes: number;
  balance: BalanceProfile;
  /** Region id -> weighted exposure, in working sets. */
  regionExposure: Record<string, number>;
  /** Muscle id -> weighted exposure (primary 1, secondary 0.5 per set). */
  muscleExposure: Record<string, number>;
  /** The dominant axis; the garden's name for lifting is "strength". */
  discipline: WorkoutAxis;
  /** Every axis present, dominant first. */
  disciplines: WorkoutAxis[];
  category: WorkoutCategory;
  mode: Mode;
  equipment: { all: string[]; oneOf: string[][] };
  /** Profile id -> attribute -> max rating among items. */
  conditionMax: Record<string, Record<string, number>>;
  watchStepCount: number;
}

export interface PerformedSet {
  reps: number | null;
  seconds: number | null;
  loadKg: number | null;
  done: boolean;
  flags: readonly string[];
}
export interface PerformedInput {
  entries: Array<{ exerciseId: string; perSide: boolean; sets: PerformedSet[] }>;
  movesDone: Array<{ exerciseId: string; seconds: number }>;
  activity?: { sport: string; durationSeconds: number; distanceMeters: number | null } | null;
}
export interface PerformedDerived {
  /** Work minutes only (rests were not recorded). */
  estimatedMinutes: number;
  balance: BalanceProfile;
  regionExposure: Record<string, number>;
  muscleExposure: Record<string, number>;
  discipline: WorkoutAxis;
  disciplines: WorkoutAxis[];
}

/** Whole minutes; any time at all is at least one. */
function minutesOf(sec: number): number {
  return sec > 0 ? Math.max(1, Math.round(sec / 60)) : 0;
}

export function modeOfEffort(e: Effort): Mode {
  return e === "recover" ? "recovery" : e === "maintain" ? "consistent" : "build";
}
export function effortOfMode(m: Mode): Effort {
  return m === "recovery" ? "recover" : m === "consistent" ? "maintain" : "develop";
}

const SECS_PER_BREATH = 6;
const DEFAULT_SECS_PER_REP = 3;
const DEFAULT_RUN_SECS_PER_KM = 360;
/** An open (lap-button) run segment counts a nominal 10 minutes. */
const OPEN_RUN_SECONDS = 600;
const LONG_RUN_SECONDS = 75 * 60;
const STRENGTH_PURPOSES = new Set(["strength", "power", "activation", "conditioning", "balance"]);
const STRENGTH_PART_PURPOSES = new Set(["main", "power", "accessory", "conditioning", "activation"]);
const QUALITY_EFFORTS = new Set(["tempo", "threshold", "interval", "hills"]);

/** Resolve a library id (current or legacy). */
export function makeLibraryIndex(library: readonly ExerciseRecord[]): (id: string) => ExerciseRecord | undefined {
  const byId = new Map<string, ExerciseRecord>();
  for (const e of library) for (const legacy of e.legacyIds) if (!byId.has(legacy)) byId.set(legacy, e);
  for (const e of library) byId.set(e.id, e);
  return (id) => byId.get(id);
}

interface Tally {
  totalSec: number;
  balance: BalanceProfile;
  region: Record<string, number>;
  muscle: Record<string, number>;
  axis: Record<WorkoutAxis, number>;
}
const newTally = (): Tally => ({
  totalSec: 0,
  balance: { isometricSec: 0, isotonicReps: 0, eccentricReps: 0, plyoContacts: 0, aerobicSec: 0, mobilitySec: 0, recoverySec: 0 },
  region: {},
  muscle: {},
  axis: { run: 0, strength: 0, yoga: 0 },
});
const bump = (m: Record<string, number>, k: string, by: number): void => {
  m[k] = (m[k] ?? 0) + by;
};

interface Work {
  /** Working sets (sets x rounds), for exposure. */
  sets: number;
  workSec: number;
  restSec: number;
  /** Total reps; null when the work is timed. */
  reps: number | null;
}

function addWork(t: Tally, rec: ExerciseRecord | undefined, w: Work, axis: WorkoutAxis): void {
  t.totalSec += w.workSec + w.restSec;
  t.axis[axis] += w.workSec + w.restSec;
  if (!rec) return;
  const b = t.balance;
  const c = rec.contraction;
  if (c.includes("isometric")) b.isometricSec += w.workSec;
  if (w.reps !== null) {
    if (c.includes("isotonic")) b.isotonicReps += w.reps;
    if (c.includes("eccentric")) b.eccentricReps += w.reps;
    if (c.includes("plyometric")) b.plyoContacts += w.reps;
  }
  if (rec.purposes.includes("mobility") || rec.purposes.includes("stretch")) b.mobilitySec += w.workSec;
  else if (c.includes("passive") && c.length === 1) b.recoverySec += w.workSec;
  for (const r of rec.regions) bump(t.region, r, w.sets);
  for (const m of rec.muscles.primary) bump(t.muscle, m, w.sets);
  for (const m of rec.muscles.secondary) bump(t.muscle, m, w.sets * 0.5);
}

function axisOfRecord(rec: ExerciseRecord): WorkoutAxis {
  return rec.purposes.some((p) => STRENGTH_PURPOSES.has(p)) ? "strength" : "yoga";
}

function dominance(t: Tally): { discipline: WorkoutAxis; disciplines: WorkoutAxis[] } {
  const { run, strength, yoga } = t.axis;
  const discipline: WorkoutAxis =
    run > 0 && (run * 2 >= t.totalSec || (strength === 0 && yoga === 0)) ? "run" : strength > 0 && strength >= yoga ? "strength" : "yoga";
  const order: WorkoutAxis[] = ["run", "strength", "yoga"];
  const rest = order.filter((a) => a !== discipline && t.axis[a] > 0).sort((a, b) => t.axis[b] - t.axis[a]);
  return { discipline, disciplines: [discipline, ...rest] };
}

function exposure(t: Tally): { regionExposure: Record<string, number>; muscleExposure: Record<string, number> } {
  return { regionExposure: t.region, muscleExposure: t.muscle };
}

function secondsOfRun(item: Extract<WorkoutItem, { kind: "run" }>): number {
  const { durationSec, distanceM, pace } = item.target;
  if (durationSec !== undefined) return durationSec;
  if (distanceM !== undefined) {
    const perKm = pace ? (pace.fastSecPerKm + pace.slowSecPerKm) / 2 : DEFAULT_RUN_SECS_PER_KM;
    return Math.round((distanceM / 1000) * perKm);
  }
  return OPEN_RUN_SECONDS;
}

type ExerciseDose = Extract<WorkoutItem, { kind: "exercise" }>["dose"];

function secsPerRep(rec: ExerciseRecord | undefined, dose: ExerciseDose): number {
  const t = dose.tempo;
  const tempo = t ? (t.eccentricSec ?? 0) + (t.pauseSec ?? 0) + (t.concentricSec ?? 0) : 0;
  return tempo > 0 ? tempo : (rec?.dose.secsPerRep ?? DEFAULT_SECS_PER_REP);
}

const mid = (r: readonly [number, number]): number => Math.round((r[0] + r[1]) / 2);

/** One exercise item's work for one round. */
function itemWork(rec: ExerciseRecord | undefined, dose: ExerciseDose, perSide: boolean, rounds: number): Work {
  const sets = dose.sets ?? rec?.dose.sets?.[0] ?? 1;
  const sides = perSide ? 2 : 1;
  let holdSec = dose.holdSec;
  let breaths = dose.breaths;
  let carryM = dose.carryM;
  let reps: number | undefined = typeof dose.reps === "number" ? dose.reps : dose.reps ? Math.round((dose.reps.min + dose.reps.max) / 2) : undefined;
  if (holdSec === undefined && breaths === undefined && carryM === undefined && reps === undefined && rec) {
    const r = rec.dose;
    if (r.type === "time") holdSec = mid(r.range);
    else if (r.type === "breaths") breaths = mid(r.range);
    else if (r.type === "carry") carryM = mid(r.range);
    else reps = mid(r.range);
  }
  let perSetSec: number;
  let repsPerSet: number | null = null;
  if (holdSec !== undefined) perSetSec = holdSec;
  else if (breaths !== undefined) perSetSec = breaths * SECS_PER_BREATH;
  else if (carryM !== undefined) perSetSec = carryM;
  else {
    repsPerSet = reps ?? 0;
    perSetSec = repsPerSet * secsPerRep(rec, dose);
  }
  const rest = dose.restSec ?? rec?.dose.restSec ?? 0;
  return {
    sets: sets * rounds,
    workSec: sets * rounds * sides * perSetSec,
    restSec: Math.max(sets - 1, 0) * rest * rounds,
    reps: repsPerSet === null ? null : sets * rounds * sides * repsPerSet,
  };
}

export function deriveDoc(doc: WorkoutDoc, library: readonly ExerciseRecord[]): DocDerived {
  const find = makeLibraryIndex(library);
  const t = newTally();
  let steps = 0;
  const efforts: string[] = [];
  const hardEfforts = new Set<string>();
  let hardSec = 0;
  let runSec = 0;
  let longestRun = { sec: -1, effort: "" };
  const all = new Set<string>();
  const groups = new Map<string, string[]>();
  const conditionMax: Record<string, Record<string, number>> = {};

  for (const part of doc.parts) {
    const rounds = part.rounds ?? 1;
    for (const item of part.items) {
      if (item.kind === "rest") {
        t.totalSec += item.seconds * rounds;
      } else if (item.kind === "run") {
        const sec = secondsOfRun(item) * rounds;
        t.totalSec += sec;
        t.axis.run += sec;
        t.balance.aerobicSec += sec;
        runSec += sec;
        steps += rounds;
        efforts.push(item.effort);
        if (QUALITY_EFFORTS.has(item.effort) || item.effort === "race") {
          hardEfforts.add(item.effort);
          hardSec += sec;
        }
        if (sec > longestRun.sec) longestRun = { sec, effort: item.effort };
      } else {
        const free = item.kind === "free_exercise";
        const rec = free ? undefined : find(item.libraryId);
        const perSide = item.dose.perSide === true && (free || item.side === undefined);
        const w = itemWork(rec, item.dose, perSide, rounds);
        const axis: WorkoutAxis = rec ? axisOfRecord(rec) : STRENGTH_PART_PURPOSES.has(part.purpose) ? "strength" : "yoga";
        addWork(t, rec, w, axis);
        steps += (item.dose.sets ?? rec?.dose.sets?.[0] ?? 1) * rounds * (perSide ? 2 : 1);
        if (rec) {
          for (const e of rec.equipment.all) all.add(e);
          if (rec.equipment.oneOf.length > 0) {
            const g = [...rec.equipment.oneOf].sort();
            groups.set(g.join("|"), g);
          }
          for (const [profile, attrs] of Object.entries(rec.conditions)) {
            const into = (conditionMax[profile] ??= {});
            for (const [k, v] of Object.entries(attrs)) {
              const n = typeof v === "boolean" ? (v ? 1 : 0) : v;
              into[k] = Math.max(into[k] ?? n, n);
            }
          }
        }
      }
    }
    if (rounds > 1) t.totalSec += (rounds - 1) * (part.restBetweenRoundsSec ?? 0);
  }

  const { discipline, disciplines } = dominance(t);
  const hasRun = runSec > 0;
  let category: WorkoutCategory;
  const hardCounts = hardEfforts.size > 0 && (discipline === "run" || hardSec * 4 >= t.totalSec);
  if (hardCounts && hardEfforts.has("race")) category = "race";
  else if (hardCounts) category = "quality";
  else if (discipline === "run" && hasRun) {
    if (efforts.includes("long") || runSec >= LONG_RUN_SECONDS) category = "long";
    else if (longestRun.effort === "recovery" || (doc.intent.effort === "recover" && efforts.every((e) => e === "recovery" || e === "easy"))) category = "recovery";
    else category = "easy";
  } else category = discipline === "yoga" ? "yoga" : "strength";

  const allList = [...all].sort();
  return {
    estimatedMinutes: minutesOf(t.totalSec),
    balance: t.balance,
    ...exposure(t),
    discipline,
    disciplines,
    category,
    mode: modeOfEffort(doc.intent.effort),
    equipment: { all: allList, oneOf: [...groups.values()].filter((g) => !g.some((e) => all.has(e))).sort((a, b) => a.join("|").localeCompare(b.join("|"))) },
    conditionMax,
    watchStepCount: steps,
  };
}

/**
 * The same balance / exposure / minutes / discipline rules over what was done. Only done sets count; a set's seconds
 * (else reps x seconds-per-rep) are its work; `perSide` entries count both sides per set. A timed move done in a flow
 * counts as one set of that many seconds. An activity adds aerobic seconds unless its sport is strength or yoga.
 * Flags and load are not read. Seconds-per-rep comes from the record (no tempo is logged); a sport other than strength / lift / yoga / mobility counts as aerobic run-axis work. Rests were not recorded, so `estimatedMinutes` is work only.
 */
export function derivePerformed(input: PerformedInput, library: readonly ExerciseRecord[]): PerformedDerived {
  const find = makeLibraryIndex(library);
  const t = newTally();
  for (const entry of input.entries) {
    const rec = find(entry.exerciseId);
    const sides = entry.perSide ? 2 : 1;
    for (const s of entry.sets) {
      if (!s.done) continue;
      const perSetSec = s.seconds ?? (s.reps ?? 0) * (rec?.dose.secsPerRep ?? DEFAULT_SECS_PER_REP);
      addWork(t, rec, { sets: 1, workSec: perSetSec * sides, restSec: 0, reps: s.reps !== null ? s.reps * sides : null }, rec ? axisOfRecord(rec) : "strength");
    }
  }
  for (const m of input.movesDone) {
    const rec = find(m.exerciseId);
    addWork(t, rec, { sets: 1, workSec: m.seconds, restSec: 0, reps: null }, rec ? axisOfRecord(rec) : "yoga");
  }
  const a = input.activity;
  if (a && a.durationSeconds > 0) {
    t.totalSec += a.durationSeconds;
    const sport = a.sport.toLowerCase();
    if (sport === "strength" || sport === "lift" || sport === "yoga" || sport === "mobility") t.axis[sport === "yoga" || sport === "mobility" ? "yoga" : "strength"] += a.durationSeconds;
    else {
      t.balance.aerobicSec += a.durationSeconds;
      t.axis.run += a.durationSeconds;
    }
  }
  const { discipline, disciplines } = dominance(t);
  return { estimatedMinutes: minutesOf(t.totalSec), balance: t.balance, ...exposure(t), discipline, disciplines };
}
