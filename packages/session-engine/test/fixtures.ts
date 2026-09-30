import {
  EXERCISES, defineExercises, makeEngineData,
  type CheckReading, type EngineData, type ExerciseInput, type HistoryEntry, type HistorySession, type Mode,
} from "@rg/exercise-library";

// Minimal valid exercise records and sessions for engine unit tests: the standalone tests/fixtures.js in the
// §4.3 shapes. `session()` accepts the standalone session fields (pre/post, `clenched` on entries, pass-1
// `plan.phase`) and normalises them the way the import will, so the ported tests read like the originals.

export const TEXT = {
  summary: "Summary.", setup: ["Set up."], steps: ["Step one.", "Step two."], focus: ["Focus."],
  mistakes: ["Mistake."], breathing: "Breathe.", why: "Because.", conditions: { tmj: "Teeth apart." },
};

/** TMJ ratings, as the standalone `jaw: {clench, neckLoad, faceDown}`. */
export const tmj = (clench: number, neckLoad = 0, faceDown = false) => ({ tmj: { clench, neckLoad, faceDown } });

type Overrides = Record<string, unknown>;

export function ex(id: string, overrides: Overrides = {}): ExerciseInput {
  return {
    id, legacyIds: [], name: overrides.name ?? id, family: id,
    patterns: ["mobility"], regions: ["hips"], roles: ["mobility"],
    equipment: { all: [], oneOf: [] }, position: "standing", laterality: "bilateral", load: "none",
    dose: { type: "time", range: [30, 60] }, conditions: tmj(0), difficulty: 1,
    easier: [], harder: [], text: TEXT, tags: [],
    ...overrides,
  } as unknown as ExerciseInput;
}

/** A loaded strength lift (kettlebell or dumbbells). */
export function lifted(id: string, overrides: Overrides = {}): ExerciseInput {
  return ex(id, {
    patterns: ["squat"], regions: ["quads"], roles: ["core", "accessory"],
    equipment: { all: [], oneOf: ["kettlebell", "dumbbells"] }, load: "external",
    dose: { type: "reps", range: [5, 8], sets: [2, 4], restSec: 60 },
    conditions: tmj(1), difficulty: 2,
    ...overrides,
  });
}

/** Engine data over a fixture library, with TMJ active and cared for (the standalone tool's world). */
export function dataWith(exercises: readonly ExerciseInput[], opts: { active?: string[]; care?: string[] } = {}): EngineData {
  return makeEngineData({ activeProfiles: opts.active ?? ["tmj"], careProfiles: opts.care ?? ["tmj"], exercises: defineExercises(exercises) });
}

/** Engine data over the real library, with TMJ active and cared for. */
export const realData = (): EngineData => makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });

/** A standalone-shaped logged entry: `clenched` becomes the "clenched" flag, `bilateral` becomes `perSide`. */
export interface LegacyEntry {
  id?: string;
  implement?: string | null;
  perSide?: boolean;
  bilateral?: boolean;
  format?: string | null;
  clenched?: boolean;
  flags?: string[];
  sets?: unknown;
  [k: string]: unknown;
}

export function entry(e: LegacyEntry | null): HistoryEntry {
  if (e == null) return e as unknown as HistoryEntry;   // damaged history stays damaged
  const { clenched, bilateral, flags, perSide, implement, format, sets, ...rest } = e;
  return {
    ...rest,
    id: e.id as string,
    implement: implement ?? null,
    perSide: Boolean(perSide ?? bilateral ?? false),
    format: (format ?? null) as HistoryEntry["format"],
    flags: flags ?? (clenched ? ["clenched"] : []),
    sets: sets as HistoryEntry["sets"],
  };
}

export interface LegacySession {
  id?: string;
  idSuffix?: string;
  startedAt?: string | null;
  seconds?: number;
  pre?: number | null;
  post?: number | null;
  feelingOff?: boolean;
  mode?: Mode | null;
  theme?: string | null;
  blockNumber?: number | null;
  plan?: { phase?: string };
  done?: unknown[];
  entries?: Array<LegacyEntry | null>;
  [k: string]: unknown;
}

/** A session on `date`: pre/post 1 and nothing done unless overridden (the standalone fixture's defaults). */
export function session(date: string, o: LegacySession = {}): HistorySession {
  return normalise({ id: `s-${date}-${o.idSuffix ?? ""}`, date, startedAt: `${date}T18:00:00`, seconds: 1800, pre: 1, post: 1, done: [], entries: [], ...o });
}

/** A standalone-shaped session (any fields may be missing or damaged) in the engine's one shape. */
export function normalise(raw: LegacySession & { date?: string }): HistorySession {
  const { pre, post, feelingOff, plan, entries, idSuffix: _suffix, ...rest } = raw;
  const checks: Record<string, CheckReading> = pre === undefined && post === undefined && !feelingOff ? {} : { tmj: { pre: pre ?? null, post: post ?? null, feelingOff: Boolean(feelingOff) } };
  return {
    ...rest,
    id: raw.id as string,
    date: raw.date as string,
    startedAt: raw.startedAt ?? null,
    mode: raw.mode ?? (plan && plan.phase === "flare" ? "recovery" : null),
    theme: raw.theme ?? null,
    blockNumber: typeof raw.blockNumber === "number" ? raw.blockNumber : null,
    checks,
    done: (raw.done ?? []) as HistorySession["done"],
    entries: Array.isArray(entries) ? entries.map(entry) : (entries as unknown as HistoryEntry[]),
  };
}
