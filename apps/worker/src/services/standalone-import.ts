/**
 * IMPORTING THE STANDALONE TOOL'S BACKUP (Phase 2 spec §2c "Standalone import"; plan Task 4, Review Focus 1–2).
 *
 *  1. The file must be a backup (`app: "tmj_tool"`, `version: 2`) or nothing is read. Each session is then checked on
 *     its own — both the tool's version-2 sessions and its pass-1 ones — and normalised to the save wire
 *     (`performedSessionSaveSchema`, so an import lands exactly as an app session would): a pass-1 flare day is a
 *     recovery session, `bilateral` is per side, `clenched` is the profile's flag, a renamed move answers to its
 *     library id through `legacyIds`, the before/after numbers are the profile's checks, and a start with no zone is
 *     the athlete's clock. A session that does not survive this is reported (index, id, why — never its text) and
 *     skipped, never half-imported.
 *  2. Sessions merge by `(user, 'import', source_ref = the tool's session id)`: one already imported is left as it is,
 *     so importing a later backup adds only the sessions that are new (Review Focus 1). Each new one writes
 *     `performed_sessions`, `performed_sets` (weights as typed + kg), its `condition_checks`, and an `activities` row
 *     (`source = 'import'`, strength when it holds a core lift else yoga — §9.2 — and never matched: the matcher and
 *     the save leave `import` rows alone).
 *  3. The first import only (no first-import marker yet: a `provider_cursor_state` row the first import writes, in
 *     its own transaction, whatever it brought) also brings the tool's settings. The PROGRAM (ruling 2d-R5, Audit C
 *     C-1): the import never makes a second adaptive program. An account with none gets the tool's (named by the
 *     profile's care label, config from the tool's settings) and its current block — `created`; an account whose one
 *     active adaptive program has no block yet and no session done on its slots takes the tool's block into that
 *     program — same program, its row (name, config, source) untouched, no slot placed — `adopted`; any other account
 *     keeps its programs and blocks exactly as they are — `kept`. Then the places (when the account has none of its
 *     own), the move preferences (never over a row the account already has), the condition switched on since the
 *     first session's day (unless the account already set it), the weight unit (ruling 2d-R6: only when the account
 *     is still on the default AND none of its places keeps a weight list typed with no unit, which means the unit in
 *     force) and the wishlist (merged into theirs). Later imports never touch them, so nothing the athlete changed
 *     here is overwritten.
 *  4. Everything lands as ONE transaction, under a per-account lock (a second import at once is `busy`), refused while
 *     a restore is replacing the account. A dry run reads only and answers the summary the import would.
 *
 * The summary carries the ORACLE numbers — the tool's own Stats over the backup's sessions in the tool's own shape,
 * and its Records counted as its Progress tab lists them (session count, sessions and volume per week for the last
 * eight weeks in whole kilos and in the tool's unit, the best and the latest set per core lift, records, before/after
 * pairs, block number and week) — for the owner to hold against the tool's Progress tab (Audit 2c-A MINOR-1).
 *
 * Imported history never enters the garden (spec P8; ruling 2d-R3): every garden read leaves `source = 'import'` rows
 * out (garden-sync's `gardenSees`), so an import changes no past garden. Never writes to COROS.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  activities,
  conditionChecks,
  exercisePrefs,
  locations,
  performedSessions,
  performedSets,
  plannedWorkouts,
  programBlocks,
  programs,
  providerCursorState,
  userConditions,
  userPreferences,
} from "@rg/database";
import {
  adaptiveConfigSchema,
  canonicalJson,
  coreBlockIntentSchema,
  DEFAULT_USER_PREFERENCES,
  isLocalDate,
  newId,
  parseStandaloneSession,
  parseWeightList,
  performedSessionSaveSchema,
  SESSION_FORMATS,
  SESSION_MODES,
  standaloneBackupSchema,
  standaloneBlockSchema,
  standaloneLocationSchema,
  standalonePrefsSchema,
  standaloneSettingsSchema,
  standaloneWishlistSchema,
  toKg,
  userPreferencesSchema,
  weightListProblem,
  withWeightUnit,
  type AdaptiveConfig,
  type PerformedSessionWire,
  type StandaloneSession,
  type Weight,
  type WeightUnit,
} from "@rg/domain";
import {
  CORE_FAMILIES,
  EQUIPMENT_IDS,
  EXERCISES,
  LOAD_IMPLEMENTS,
  makeEngineData,
  profileById,
  THEMES,
  type ExerciseRecord,
} from "@rg/exercise-library";
import { Blocks, historyFromPerformed, Lib, Records } from "@rg/session-engine";
import type { ZodIssue } from "zod";
import { sha256Hex } from "../auth/crypto.js";
import { restoreInProgress } from "./account-state.js";
import { loadPreferences } from "./calendar-sync.js";
import { chunkIds, insertBatches, runAtomically, type AtomicStatement, type Db } from "./db.js";
import { claimUserLock, releaseUserLock } from "./locks.js";
import { RestoreInProgressError } from "./programs.js";
import { Stats, type LiftPoint, type ToolSession } from "./standalone-stats.js";

/** The condition the standalone tool is about: its checks, its flag and its care. */
const PROFILE_ID = "tmj";
const SOURCE = "import";
const LOCK = "standalone_import";
/** `programs.source.app` of the program the first import makes, and the provider of the first-import marker. */
const APP = "tmj_tool";
/** The backup version this importer reads. */
const BACKUP_VERSION = 2;

/** Why a file is refused beyond "not a backup": one the tool wrote in a newer format than this importer reads. */
export type InvalidBackupReason = "newer_version";

export class InvalidBackupError extends Error {
  constructor(
    public readonly issues: ReadonlyArray<Pick<ZodIssue, "message" | "path">>,
    public readonly reason: InvalidBackupReason | null = null,
  ) {
    super("invalid_backup");
  }
}

/** The file as a backup, or `InvalidBackupError` — saying so when the tool wrote it in a newer format (Audit C M-3). */
function envelopeOf(raw: unknown) {
  const envelope = standaloneBackupSchema.safeParse(raw);
  if (envelope.success) return envelope.data;
  const { app, version } = (raw !== null && typeof raw === "object" ? raw : {}) as { app?: unknown; version?: unknown };
  const newer = app === APP && typeof version === "number" && version > BACKUP_VERSION;
  throw new InvalidBackupError(envelope.error.issues, newer ? "newer_version" : null);
}

export class ImportBusyError extends Error {
  constructor() {
    super("busy");
  }
}

// ── Normalising one session ──────────────────────────────────────────────────────────────────────────────────────

/** What normalising reads: the library (for renamed ids and core lifts), the athlete's zone and weight unit. */
export interface StandaloneContext {
  timezone: string;
  /** The unit of a weight the tool kept as a bare number. */
  unit: WeightUnit;
  /** A library id for a tool id (a renamed move answers to its old id); an id the library lacks passes through. */
  canonical(id: string): string;
  /** A move the library knows. */
  known(id: string): boolean;
  /** A move that is a core lift (§9.2: a session holding one is strength). */
  isCoreLift(id: string): boolean;
  /** The profile's flag for "clenched". */
  flag: string;
  exercises: readonly ExerciseRecord[];
}

export function standaloneContext(o: { exercises?: readonly ExerciseRecord[]; timezone: string; unit: WeightUnit }): StandaloneContext {
  const exercises = o.exercises ?? EXERCISES;
  const byId = new Map(exercises.map((e) => [e.id, e]));
  const legacy = new Map<string, string>();
  for (const e of exercises) for (const old of e.legacyIds) if (!byId.has(old)) legacy.set(old, e.id);
  const data = makeEngineData({ activeProfiles: [], careProfiles: [], exercises });
  const canonical = (id: string) => (byId.has(id) ? id : legacy.get(id) ?? id);
  return {
    timezone: o.timezone,
    unit: o.unit,
    canonical,
    known: (id) => byId.has(canonical(id)),
    isCoreLift: (id) => Lib.coreFamilyOf(data, byId.get(canonical(id)) ?? null) !== null,
    flag: profileById(PROFILE_ID).setFlag?.id ?? "clenched",
    exercises,
  };
}

/** An instant as activities and checks keep it ("2026-09-28T18:00:00Z"); a time with no zone is the athlete's clock. */
function instantOf(text: string | null | undefined, timezone: string): string | null {
  if (!text) return null;
  const zoned = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(text.trim());
  const dt = zoned ? DateTime.fromISO(text.trim(), { setZone: true }) : DateTime.fromISO(text.trim(), { zone: timezone });
  return dt.isValid ? dt.toUTC().toISO({ suppressMilliseconds: true }) : null;
}

const plus = (instant: string, seconds: number): string =>
  DateTime.fromISO(instant, { zone: "utc" }).plus({ seconds }).toUTC().toISO({ suppressMilliseconds: true })!;

const whole = (n: number | null | undefined): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : null);

function weightOf(w: unknown, unit: WeightUnit): Weight | null {
  if (typeof w === "number") return w > 0 ? { v: Number(w.toFixed(2)), u: unit } : null;
  if (w && typeof w === "object") {
    const { v, u } = w as { v?: unknown; u?: unknown };
    if (typeof v === "number" && v > 0 && (u === "lb" || u === "kg")) return { v: Number(v.toFixed(2)), u };
  }
  return null;
}

const MODES: ReadonlySet<string> = new Set(SESSION_MODES);
const FORMATS: ReadonlySet<string> = new Set(SESSION_FORMATS);

/** A session normalised: Run Garden's wire, and the tool's own session as checked (what the oracle reads). */
export type Normalized = { ok: true; session: PerformedSessionWire; strength: boolean; tool: StandaloneSession } | { ok: false; reason: string };

/** The first problem as a short reason: where, and what — never a value from the file. */
const reasonOf = (issues: ReadonlyArray<Pick<ZodIssue, "message" | "path">>): string => {
  const i = issues[0];
  return i ? `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}` : "invalid";
};

/** One session from the tool → the save wire (validated), with `performedId` as its id. */
export function normalizeStandaloneSession(raw: unknown, performedId: string, ctx: StandaloneContext): Normalized {
  const parsed = parseStandaloneSession(raw);
  if (!parsed.success) return { ok: false, reason: reasonOf(parsed.error.issues) };
  const s: StandaloneSession = parsed.data;
  const startedAt = instantOf(s.startedAt, ctx.timezone);
  const seconds = whole(s.seconds) ?? 0;
  const endedAt = instantOf(s.endedAt, ctx.timezone) ?? (startedAt ? plus(startedAt, seconds) : null);
  const noon = instantOf(`${s.date}T12:00:00`, ctx.timezone)!;
  const mode = s.kind === "v2" ? (s.mode && MODES.has(s.mode) ? s.mode : null) : s.plan?.phase === "flare" ? "recovery" : null;

  const entries = s.entries.flatMap((e) => {
    const sets = e.sets.flatMap((set) => {
      if (!set) return [];
      const load = weightOf(set.w, ctx.unit);
      const reps = whole(set.reps);
      const secs = whole(set.secs);
      if (!load && reps === null && secs === null) return [];
      return [{ load, reps, seconds: secs, done: set.done !== false }];
    });
    if (sets.length === 0) return [];
    const implement = typeof e.implement === "string" && e.implement.trim() !== "" ? e.implement.trim().toLowerCase() : null;
    return [
      {
        exerciseId: ctx.canonical(e.id),
        implement,
        format: e.format && FORMATS.has(e.format) ? (e.format as PerformedSessionWire["entries"][number]["format"]) : null,
        perSide: e.perSide ?? e.bilateral ?? false,
        sets: sets.map((set, i) => ({ setIndex: i, side: null, ...set, flags: e.clenched ? [ctx.flag] : [] })),
      },
    ];
  });

  const checks: Array<{ profileId: string; kind: "pre" | "post"; value: number | null; feelingOff: boolean; at: string }> = [];
  const pre = whole(s.pre);
  const post = whole(s.post);
  const feelingOff = s.feelingOff === true;
  if (pre !== null || feelingOff) checks.push({ profileId: PROFILE_ID, kind: "pre", value: pre, feelingOff, at: startedAt ?? endedAt ?? noon });
  if (post !== null) checks.push({ profileId: PROFILE_ID, kind: "post", value: post, feelingOff: false, at: endedAt ?? startedAt ?? noon });

  const v2 = s.kind === "v2" ? s : null;
  const wire = performedSessionSaveSchema.safeParse({
    id: performedId,
    source: SOURCE,
    sourceRef: s.id,
    workoutId: null,
    buildId: null,
    localDate: s.date,
    startedAt,
    endedAt,
    seconds,
    plannedSeconds: whole(v2?.plannedSeconds),
    minutes: whole(v2?.minutes),
    mode,
    theme: v2?.theme ? v2.theme : null,
    locationId: null,
    blockRef: null,
    blockNumber: whole(v2?.blockNumber),
    completed: v2?.completed ?? true,
    stepsTotal: whole(v2?.stepsTotal),
    stepsDone: whole(v2?.stepsDone),
    movesDone: s.done.map((d) => ({ exerciseId: ctx.canonical(d.id), seconds: whole(d.secs) ?? 0 })),
    note: s.note ? s.note : null,
    newMove: v2?.newMove ? ctx.canonical(v2.newMove) : null,
    entries,
    checks,
  });
  if (!wire.success) return { ok: false, reason: reasonOf(wire.error.issues) };
  return { ok: true, session: wire.data, strength: entries.some((e) => ctx.isCoreLift(e.exerciseId)), tool: s };
}

// ── The summary ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImportSummary {
  dryRun: boolean;
  /** This import brings the tool's settings (no earlier import has). */
  firstImport: boolean;
  sessions: {
    /** Sessions in the file. */
    total: number;
    /** New sessions this import adds. */
    added: number;
    alreadyImported: number;
    /** The first and last day of the file's readable sessions. */
    firstDate: string | null;
    lastDate: string | null;
    /** The first and last day of the sessions this import adds (null when it adds none). */
    addedFirstDate: string | null;
    addedLastDate: string | null;
    /** Sessions skipped, by their place in the file: the tool's id when it has one, and why. */
    invalid: Array<{ index: number; id: string | null; reason: string }>;
  };
  /** Move ids in the sessions the library does not know (kept as they are; the engine ignores them). */
  unknownMoves: number;
  /**
   * What the import does to the account's adaptive program (ruling 2d-R5): `created` — the tool's program (this
   * name, the file's block); `adopted` — the file's block goes into the athlete's program (its name), which keeps
   * its own settings and slots; `kept` — the program stays exactly as it is (named when the account has exactly one
   * active adaptive program). A later import always keeps.
   */
  program: { outcome: ProgramOutcome; name: string | null };
  /** The weight unit before and after the import (ruling 2d-R6): the tool's only on a first import that may take it. */
  weightUnit: { before: WeightUnit; after: WeightUnit };
  /** The file's places the import writes, by name (none when the account has its own, or on a later import). */
  places: string[];
  /** Move ratings the import writes (never over a move the account already has a preference for). */
  ratings: number;
  block: { number: number; week: number; weeks: number } | null;
  /** Things in the file the import could not use (gear, wishlist items or rated moves the library does not have). */
  dropped: string[];
  /** What the import writes (a dry run: would write). */
  written: { sessions: number; sets: number; checks: number; activities: number; program: number; block: number; places: number; prefs: number; condition: number; preferences: number };
  oracle: Oracle;
}

/**
 * The standalone tool's own numbers over the file's sessions, as its Progress tab shows them (Audit 2c-A MINOR-1), for
 * the owner to hold side by side with that tab.
 */
export interface Oracle {
  /** The unit the tool's Progress tab shows weights in: the tool's own setting (the account's when the file has none). */
  unit: WeightUnit;
  sessionCount: number;
  /** The last eight weeks, oldest first, by their Mondays. */
  sessionsPerWeek: Array<{ week: string; sessions: number }>;
  /** The same weeks: whole kilos as the tool keeps them, and the whole number in `unit` its Progress tab shows. */
  weeklyVolume: Array<{ week: string; kg: number; inUnit: number }>;
  /**
   * The block's core lifts: the best set in the history (Run Garden's records engine), and `latest`, the number on
   * the tool's lift tile — the last session's top set, weight as typed.
   */
  bestByCoreLift: Array<{
    family: string;
    exerciseId: string;
    name: string;
    best: { w: Weight | null; reps: number | null; secs: number | null } | null;
    latest: { date: string; w: Weight | null; reps: number | null; secs: number | null } | null;
  }>;
  /** Records as the Progress tab lists them: new bests (never a first time) and milestones. */
  records: number;
  /** Sessions with both a before and an after number. */
  prePostPairs: number;
  block: { number: number; week: number } | null;
}

export interface ImportCtx {
  today: string;
  now: string;
  timezone: string;
  dryRun: boolean;
  /** The library (tests pass one with renamed moves); the app's own by default. */
  exercises?: readonly ExerciseRecord[];
}

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;

const KNOWN_GEAR: ReadonlySet<string> = new Set(EQUIPMENT_IDS);

interface PrefRow {
  rating: 1 | -1 | null;
  excluded: boolean;
  pinned: boolean;
  introducedOn: string | null;
}

export type ProgramOutcome = "created" | "adopted" | "kept";

/** The program the first import made, if one exists (the route places its slots after the import). */
export async function importedProgramId(db: Db, userId: string): Promise<string | null> {
  const rows = await db.select({ id: programs.id, source: programs.source }).from(programs).where(and(eq(programs.userId, userId), eq(programs.kind, "adaptive")));
  return rows.find((r) => (r.source as { app?: unknown } | null)?.app === APP)?.id ?? null;
}

/** The first-import marker's row id: written by the first import, whatever it did to the program. */
const markerId = (userId: string) => `${userId}:${APP}:first_import`;

/** Has a first import already brought the tool's settings into this account? */
async function firstImportDone(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: providerCursorState.id }).from(providerCursorState).where(eq(providerCursorState.id, markerId(userId))).limit(1);
  return !!row;
}

/**
 * Ruling 2d-R5: what a first import does to the program. `adoptInto` is the athlete's program that takes the file's
 * block. Never a second adaptive program: an account with any (a retired one too) is `kept` unless its ONE active
 * program has no block and no session done on its slots yet.
 */
async function programPlan(
  db: Db,
  userId: string,
  o: { first: boolean; hasBlock: boolean; careLabel: string },
): Promise<{ outcome: ProgramOutcome; name: string | null; adoptInto: string | null }> {
  const rows = await db
    .select({ id: programs.id, name: programs.name, status: programs.status, archivedAt: programs.archivedAt })
    .from(programs)
    .where(and(eq(programs.userId, userId), eq(programs.kind, "adaptive")))
    .orderBy(asc(programs.createdAt), asc(programs.id));
  if (rows.length === 0) return o.first ? { outcome: "created", name: o.careLabel, adoptInto: null } : { outcome: "kept", name: null, adoptInto: null };
  const active = rows.filter((r) => r.status === "active" && r.archivedAt === null);
  const only = active.length === 1 ? active[0]! : null;
  const kept = { outcome: "kept" as const, name: only?.name ?? null, adoptInto: null };
  if (!o.first || !o.hasBlock || !only) return kept;
  const [block] = await db.select({ id: programBlocks.id }).from(programBlocks).where(eq(programBlocks.programId, only.id)).limit(1);
  if (block) return kept;
  const [done] = await db
    .select({ id: performedSessions.id })
    .from(performedSessions)
    .innerJoin(plannedWorkouts, eq(performedSessions.workoutId, plannedWorkouts.id))
    .where(and(eq(performedSessions.userId, userId), eq(plannedWorkouts.planId, only.id)))
    .limit(1);
  if (done) return kept;
  return { outcome: "adopted", name: only.name, adoptInto: only.id };
}

/** A stored weight list whose meaning depends on the unit in force: a weight in it has no unit after it (2d-R6). */
function meansTheUnitInForce(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return JSON.stringify(parseWeightList(value, "lb")) !== JSON.stringify(parseWeightList(value, "kg"));
}

/** Everything read from the file and the account, decided before anything is written. */
interface Plan {
  summary: ImportSummary;
  statements: (db: Db) => Promise<AtomicStatement[]>;
}

async function alreadyImported(db: Db, userId: string, refs: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const chunk of chunkIds([...refs])) {
    const rows = await db
      .select({ ref: performedSessions.sourceRef })
      .from(performedSessions)
      .where(and(eq(performedSessions.userId, userId), eq(performedSessions.source, SOURCE), inArray(performedSessions.sourceRef, chunk)));
    for (const r of rows) if (r.ref) out.add(r.ref);
  }
  return out;
}

async function plan(db: Db, userId: string, raw: unknown, ctx: ImportCtx): Promise<Plan> {
  const file = envelopeOf(raw);
  const account = await loadPreferences(db, userId);
  const settingsParsed = standaloneSettingsSchema.safeParse(file.settings ?? {});
  const settings = settingsParsed.success ? settingsParsed.data : {};
  const unit: WeightUnit = settings.unit ?? account.weightUnit;
  const sc = standaloneContext({ exercises: ctx.exercises ?? EXERCISES, timezone: ctx.timezone, unit });
  const dropped = new Set<string>();

  // Sessions: each on its own.
  const invalid: ImportSummary["sessions"]["invalid"] = [];
  const valid: Array<{ wire: PerformedSessionWire; strength: boolean; tool: StandaloneSession }> = [];
  const seen = new Set<string>();
  file.sessions.forEach((rawSession, index) => {
    const out = normalizeStandaloneSession(rawSession, newId(), sc);
    const id = typeof (rawSession as { id?: unknown } | null)?.id === "string" ? String((rawSession as { id: string }).id).slice(0, 200) : null;
    if (!out.ok) return invalid.push({ index, id, reason: out.reason });
    if (seen.has(out.session.sourceRef!)) return invalid.push({ index, id, reason: "the same session id again" });
    seen.add(out.session.sourceRef!);
    valid.push({ wire: out.session, strength: out.strength, tool: out.tool });
  });
  const imported = await alreadyImported(db, userId, valid.map((v) => v.wire.sourceRef!));
  const fresh = valid.filter((v) => !imported.has(v.wire.sourceRef!));
  const dates = valid.map((v) => v.wire.localDate).sort();
  const freshDates = fresh.map((v) => v.wire.localDate).sort();
  const unknown = new Set(valid.flatMap((v) => [...v.wire.entries.map((e) => e.exerciseId), ...v.wire.movesDone.map((m) => m.exerciseId)]).values());
  const unknownMoves = [...unknown].filter((id) => !sc.known(id)).length;

  // The block, as the oracle reads it and as the first import writes it.
  const blockParsed = file.block === null || file.block === undefined ? null : standaloneBlockSchema.safeParse(file.block);
  const block = blockParsed?.success
    ? (() => {
        const intent = coreBlockIntentSchema.safeParse({
          core: Object.fromEntries(Object.entries(blockParsed.data.core).map(([f, id]) => [f, id === null ? null : sc.canonical(id)])),
          rotations: blockParsed.data.rotations.map((r) => ({ family: r.family, from: r.from === null ? null : sc.canonical(r.from), to: sc.canonical(r.to), date: r.date, why: r.why })),
        });
        return intent.success ? { number: blockParsed.data.number, startedAt: blockParsed.data.startedAt, weeks: blockParsed.data.weeks, intent: intent.data } : null;
      })()
    : null;
  if (blockParsed && !block) dropped.add("block");

  // The oracle: the tool's own numbers over every session the import reads, in the tool's own shape and file order
  // (Stats reads what Run Garden's sessions no longer carry: how each entry was logged), shown in the tool's unit.
  const wires = valid.map((v) => v.wire);
  const toolSessions = valid.map((v) => v.tool as unknown as ToolSession);
  const weeks = Stats.weekly(toolSessions, 8, ctx.today, unit);
  const data = makeEngineData({ activeProfiles: [PROFILE_ID], careProfiles: [], exercises: sc.exercises });
  const history = wires.map(historyFromPerformed);
  const goal = clampInt(settings.weeklyGoal, 1, 7, 4);
  const coreIds = block ? CORE_FAMILIES.flatMap((f) => (block.intent.core[f.id] ? [{ family: f.id, id: block.intent.core[f.id]! }] : [])) : [];
  const base = Records.baseline(data, history, { ids: coreIds.map((c) => c.id), date: ctx.today, weeklyGoal: goal });
  const lifts = Stats.lifts(toolSessions, unit);
  /** The lift tile's number: the last point of the move's series (a renamed move's old id is the same move). */
  const latestOf = (id: string): Oracle["bestByCoreLift"][number]["latest"] => {
    const last = lifts
      .filter((l) => sc.canonical(l.id) === id)
      .map((l) => l.points[l.points.length - 1]!)
      .reduce<LiftPoint | null>((a, p) => (a === null || p.date >= a.date ? p : a), null);
    return last ? { date: last.date, w: last.top, reps: last.reps, secs: last.secs } : null;
  };
  const progress = Records.compute(data, history, { weeklyGoal: goal });
  const blockWeek = block ? Blocks.weekOf({ startedAt: block.startedAt }, ctx.today) : null;
  const oracle: Oracle = {
    unit,
    sessionCount: wires.length,
    sessionsPerWeek: weeks.map((w) => ({ week: w.week, sessions: w.sessions })),
    weeklyVolume: weeks.map((w) => ({ week: w.week, kg: w.volumeKg, inUnit: Stats.volumeInUnit(w.volumeKg, unit) })),
    bestByCoreLift: coreIds.map(({ family, id }) => {
      const b = base.bests[id];
      return {
        family,
        exerciseId: id,
        name: Lib.get(data, id)?.name ?? id,
        best: b && (b.w !== null || b.reps !== null || b.secs !== null) ? { w: b.w, reps: b.reps, secs: b.secs } : null,
        latest: latestOf(id),
      };
    }),
    // As the Progress tab lists them: first times are not shown there; milestones are.
    records: progress.records.filter((r) => r.kind !== "first").length + progress.milestones.length,
    prePostPairs: toolSessions.filter((s) => s.pre != null && s.post != null).length,
    block: block && blockWeek !== null ? { number: block.number, week: blockWeek } : null,
  };

  // The tool's places, preferences and wishlist, read whether or not they are written.
  const placeSeen = new Set<string>();
  const placesIn = (Array.isArray(file.locations) ? file.locations : []).flatMap((l) => {
    const p = standaloneLocationSchema.safeParse(l);
    // A place the file names twice keeps its first entry.
    if (!p.success || placeSeen.has(p.data.id)) {
      dropped.add("place");
      return [];
    }
    placeSeen.add(p.data.id);
    const equipment = [...new Set(p.data.equipment)].filter((g) => {
      if (KNOWN_GEAR.has(g)) return true;
      dropped.add(g);
      return false;
    });
    const lists: Record<string, string> = {};
    for (const gear of LOAD_IMPLEMENTS) {
      const text = (p.data as Record<string, unknown>)[gear] as { weights?: unknown } | undefined;
      const typed = typeof text?.weights === "string" ? text.weights.trim() : "";
      if (typed === "" || !equipment.includes(gear)) continue;
      // A list the tool kept with no unit meant the tool's (Audit 2c-A MINOR-4).
      if (weightListProblem(typed) === null) lists[gear] = withWeightUnit(typed, unit);
      else dropped.add(`${gear} weights`);
    }
    return [{ sourceId: p.data.id, name: p.data.name, equipment, lists }];
  });
  const prefsParsed = standalonePrefsSchema.safeParse(file.prefs ?? {});
  const filePrefs = prefsParsed.success ? prefsParsed.data : { ratings: {}, excluded: [], pinned: [], introduced: {} };
  const libraryId = (id: string): string | null => {
    const c = sc.canonical(id);
    if (sc.known(c)) return c;
    dropped.add(id);
    return null;
  };
  const prefRows = new Map<string, PrefRow>();
  const prefOf = (id: string) => {
    let row = prefRows.get(id);
    if (!row) prefRows.set(id, (row = { rating: null, excluded: false, pinned: false, introducedOn: null }));
    return row;
  };
  for (const [raw, v] of Object.entries(filePrefs.ratings)) {
    const id = libraryId(raw);
    if (!id || v === 0) continue;
    prefOf(id).rating = v > 0 ? 1 : -1;
  }
  for (const raw of filePrefs.excluded) {
    const id = libraryId(raw);
    if (id) prefOf(id).excluded = true;
  }
  for (const raw of filePrefs.pinned) {
    const id = libraryId(raw);
    if (id) prefOf(id).pinned = true;
  }
  const introduced = new Map<string, string>();
  for (const [raw, date] of Object.entries(filePrefs.introduced)) {
    const id = libraryId(raw);
    if (id && isLocalDate(date)) introduced.set(id, date);
  }
  for (const w of [...wires].sort((a, b) => a.localDate.localeCompare(b.localDate))) {
    if (w.newMove && sc.known(w.newMove) && !introduced.has(w.newMove)) introduced.set(w.newMove, w.localDate);
  }
  for (const [id, date] of introduced) prefOf(id).introducedOn = date;
  const wishParsed = standaloneWishlistSchema.safeParse(file.wishlist ?? []);
  const wishlist = [...new Set(wishParsed.success ? wishParsed.data : [])].filter((g) => {
    if (KNOWN_GEAR.has(g)) return true;
    dropped.add(g);
    return false;
  });

  // What the first import would write, against what the account already has.
  const firstImport = !(await firstImportDone(db, userId));
  const careLabel = profileById(PROFILE_ID).care?.block.label ?? profileById(PROFILE_ID).label;
  const program = await programPlan(db, userId, { first: firstImport, hasBlock: !!block, careLabel });
  let placesToWrite: typeof placesIn = [];
  let prefsToWrite: Array<[string, PrefRow]> = [];
  let conditionToWrite = false;
  let unitAfter: WeightUnit = account.weightUnit;
  if (firstImport) {
    const own = await db.select({ implements: locations.implements }).from(locations).where(eq(locations.userId, userId));
    placesToWrite = own.length ? [] : placesIn;
    // Ruling 2d-R6: the tool's unit only for an account that never chose one here (a unit other than the default is
    // a choice: nothing else writes one) and whose places hold no list that a change of unit would re-read.
    const chosen = account.weightUnit !== DEFAULT_USER_PREFERENCES.weightUnit;
    const bare = own.some((p) => Object.values(p.implements ?? {}).some(meansTheUnitInForce));
    if (!chosen && !bare) unitAfter = unit;
    const ids = [...prefRows.keys()].sort();
    const have = new Set<string>();
    for (const chunk of chunkIds(ids)) {
      for (const r of await db.select({ id: exercisePrefs.exerciseId }).from(exercisePrefs).where(and(eq(exercisePrefs.userId, userId), inArray(exercisePrefs.exerciseId, chunk)))) {
        have.add(r.id);
      }
    }
    prefsToWrite = ids.filter((id) => !have.has(id)).map((id) => [id, prefRows.get(id)!]);
    const [cond] = await db.select({ id: userConditions.id }).from(userConditions).where(and(eq(userConditions.userId, userId), eq(userConditions.profileId, PROFILE_ID))).limit(1);
    conditionToWrite = !cond;
  }

  const setsCount = fresh.reduce((n, v) => n + v.wire.entries.reduce((m, e) => m + e.sets.length, 0), 0);
  const checksCount = fresh.reduce((n, v) => n + v.wire.checks.length, 0);
  const summary: ImportSummary = {
    dryRun: ctx.dryRun,
    firstImport,
    sessions: {
      total: file.sessions.length, added: fresh.length, alreadyImported: valid.length - fresh.length,
      firstDate: dates[0] ?? null, lastDate: dates[dates.length - 1] ?? null,
      addedFirstDate: freshDates[0] ?? null, addedLastDate: freshDates[freshDates.length - 1] ?? null, invalid,
    },
    unknownMoves,
    program: { outcome: program.outcome, name: program.name },
    weightUnit: { before: account.weightUnit, after: unitAfter },
    places: placesToWrite.map((p) => p.name),
    ratings: prefsToWrite.filter(([, p]) => p.rating !== null).length,
    block: block && blockWeek !== null ? { number: block.number, week: blockWeek, weeks: block.weeks } : null,
    dropped: [...dropped].sort(),
    written: {
      sessions: fresh.length,
      sets: setsCount,
      checks: checksCount,
      activities: fresh.length,
      program: program.outcome === "created" ? 1 : 0,
      block: block && program.outcome !== "kept" ? 1 : 0,
      places: placesToWrite.length,
      prefs: prefsToWrite.length,
      condition: firstImport && conditionToWrite ? 1 : 0,
      preferences: firstImport ? 1 : 0,
    },
    oracle,
  };

  const themeName = new Map(THEMES.map((t) => [t.id, t.name]));
  const statements = async (wdb: Db): Promise<AtomicStatement[]> => {
    const out: AtomicStatement[] = [];
    const now = ctx.now;
    if (firstImport) {
      const placeIds = new Map(placesToWrite.map((p) => [p.sourceId, newId()]));
      const defaultSource = placesToWrite.find((p) => p.sourceId === settings.location)?.sourceId ?? placesToWrite[0]?.sourceId ?? null;
      // The program the file's block goes into: the one made here, or the athlete's (its row untouched); none when kept.
      let programId: string | null = program.adoptInto;
      if (program.outcome === "created") {
        const config: AdaptiveConfig = adaptiveConfigSchema.parse({
          weeklyGoal: goal,
          blockWeeks: clampInt(settings.blockWeeks, 4, 6, 5),
          defaultMinutes: clampInt(settings.defaultMinutes, 10, 90, 30),
          defaultLocationId: defaultSource ? placeIds.get(defaultSource)! : null,
          careProfiles: [PROFILE_ID],
        });
        programId = newId();
        out.push(
          wdb.insert(programs).values({
            id: programId, userId, kind: "adaptive", name: careLabel, status: "active", disciplines: ["yoga", "strength"],
            startDate: null, endDate: null, raceDate: null, source: { app: APP, importedAt: now }, config,
            createdAt: now, updatedAt: now, archivedAt: null,
          }),
        );
      }
      if (block && programId) {
        out.push(
          wdb.insert(programBlocks).values({
            id: newId(), programId, number: block.number, kind: "core_block", startDate: block.startedAt, weeks: block.weeks,
            intent: block.intent, createdAt: now, updatedAt: now,
          }),
        );
      }
      const placeRows = placesToWrite.map((p) => ({
        id: placeIds.get(p.sourceId)!, userId, name: p.name, equipment: p.equipment, implements: p.lists,
        isDefault: p.sourceId === defaultSource, createdAt: now, updatedAt: now,
      }));
      for (const batch of insertBatches(placeRows)) out.push(wdb.insert(locations).values(batch));
      const rows = prefsToWrite.map(([exerciseId, p]) => ({
        id: `${userId}:${exerciseId}`, userId, exerciseId, rating: p.rating, excluded: p.excluded, pinned: p.pinned,
        introducedOn: p.introducedOn, updatedAt: now,
      }));
      for (const batch of insertBatches(rows)) out.push(wdb.insert(exercisePrefs).values(batch).onConflictDoNothing());
      if (conditionToWrite) {
        out.push(
          wdb
            .insert(userConditions)
            .values({ id: `${userId}:${PROFILE_ID}`, userId, profileId: PROFILE_ID, active: true, since: dates[0] ?? ctx.today, settings: {} })
            .onConflictDoNothing(),
        );
      }
      // Never over what the athlete set here (Audit 2c-A MINOR-2, ruling 2d-R6): the unit decided above; the wishlist
      // is theirs plus the file's new gear.
      const next = userPreferencesSchema.parse({
        ...account,
        weightUnit: unitAfter,
        equipmentWishlist: [...new Set([...account.equipmentWishlist, ...wishlist])],
      });
      out.push(
        wdb
          .insert(userPreferences)
          .values({ userId, prefs: next as unknown as Record<string, unknown>, updatedAt: now })
          .onConflictDoUpdate({ target: userPreferences.userId, set: { prefs: next as unknown as Record<string, unknown>, updatedAt: now } }),
      );
      // The first import happened: every later one brings sessions only.
      out.push(
        wdb
          .insert(providerCursorState)
          .values({ id: markerId(userId), userId, provider: APP, cursorKey: "first_import", value: now, updatedAt: now })
          .onConflictDoNothing(),
      );
    }

    // The sessions.
    const sessionRows: Array<typeof performedSessions.$inferInsert> = [];
    const setRows: Array<typeof performedSets.$inferInsert> = [];
    const checkRows: Array<typeof conditionChecks.$inferInsert> = [];
    const activityRows: Array<typeof activities.$inferInsert> = [];
    for (const { wire: p, strength } of fresh) {
      const hash = await sha256Hex(canonicalJson(p));
      sessionRows.push({
        id: p.id, userId, workoutId: null, activityId: p.id, buildId: null, source: SOURCE, sourceRef: p.sourceRef,
        localDate: p.localDate, startedAt: p.startedAt, endedAt: p.endedAt, seconds: p.seconds, plannedSeconds: p.plannedSeconds,
        minutes: p.minutes, mode: p.mode, theme: p.theme, locationId: null, blockRef: null, blockNumber: p.blockNumber,
        completed: p.completed, stepsTotal: p.stepsTotal, stepsDone: p.stepsDone, movesDone: p.movesDone, note: p.note,
        newMove: p.newMove, payloadHash: hash, createdAt: now, updatedAt: now,
      });
      p.entries.forEach((e, entryIndex) =>
        e.sets.forEach((s, i) =>
          setRows.push({
            id: `${p.id}:${entryIndex}:${i}`, performedSessionId: p.id, entryIndex, exerciseId: e.exerciseId, implement: e.implement,
            format: e.format, perSide: e.perSide, setIndex: s.setIndex, side: s.side, reps: s.reps, seconds: s.seconds,
            loadValue: s.load?.v ?? null, loadUnit: s.load?.u ?? null, loadKg: s.load ? toKg(s.load) : null, done: s.done, flags: [...s.flags],
          }),
        ),
      );
      for (const c of p.checks) {
        checkRows.push({
          id: newId(), userId, profileId: c.profileId, kind: c.kind, value: c.value, feelingOff: c.feelingOff, localDate: p.localDate,
          at: c.at, performedSessionId: p.id, workoutId: null,
        });
      }
      const start = p.startedAt ?? instantOf(`${p.localDate}T12:00:00`, ctx.timezone)!;
      const startLocal = DateTime.fromISO(start, { zone: "utc" }).setZone(ctx.timezone).toFormat("yyyy-LL-dd'T'HH:mm:ss");
      const theme = p.theme ? themeName.get(p.theme) : undefined;
      activityRows.push({
        id: p.id, userId, corosActivityId: null, source: SOURCE, startTime: start, startTimeLocal: startLocal, timezone: ctx.timezone,
        sport: strength ? "strength" : "yoga", durationSeconds: p.seconds,
        elapsedSeconds: p.startedAt && p.endedAt ? Math.max(0, Math.round(DateTime.fromISO(p.endedAt).diff(DateTime.fromISO(p.startedAt), "seconds").seconds)) : null,
        distanceMeters: null, avgHeartRate: null, maxHeartRate: null, avgPaceSecPerKm: null, elevationGainMeters: null,
        trainingLoad: null, deviceName: null, title: theme ? `${careLabel} · ${theme}` : careLabel, telemetry: null,
        completionMatchId: null, sourceMergeConfidence: 1, createdAt: now, updatedAt: now,
      });
    }
    for (const batch of insertBatches(sessionRows)) out.push(wdb.insert(performedSessions).values(batch));
    for (const batch of insertBatches(setRows)) out.push(wdb.insert(performedSets).values(batch));
    for (const batch of insertBatches(checkRows)) out.push(wdb.insert(conditionChecks).values(batch));
    for (const batch of insertBatches(activityRows)) out.push(wdb.insert(activities).values(batch));
    return out;
  };
  return { summary, statements };
}

/**
 * Import (or, with `dryRun`, only read) a standalone backup into this account. Throws `InvalidBackupError` for a file
 * that is not one, `RestoreInProgressError` while a restore is replacing the account, `ImportBusyError` while another
 * import of this account is writing.
 */
export async function importStandalone(db: Db, userId: string, raw: unknown, ctx: ImportCtx): Promise<ImportSummary> {
  if (ctx.dryRun) return (await plan(db, userId, raw, ctx)).summary;
  if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
  // The file is read once (the CPU a Worker has is short): a re-import with nothing new answers without the lock and
  // without a write; anything else is planned under the lock, so an import that finished meanwhile is seen.
  if (!(await mayWrite(db, userId, raw))) return (await plan(db, userId, raw, ctx)).summary;
  const token = await claimUserLock(db, userId, LOCK, 5);
  if (!token) throw new ImportBusyError();
  try {
    const locked = await plan(db, userId, raw, ctx);
    if (Object.values(locked.summary.written).every((n) => n === 0)) return locked.summary;
    if (await restoreInProgress(db, userId)) throw new RestoreInProgressError();
    await runAtomically(db, await locked.statements(db));
    return locked.summary;
  } finally {
    await releaseUserLock(db, userId, LOCK, token);
  }
}

/** Cheaply: could this file write anything — a first import, or a session id not imported yet? A file that is not a
 * backup is refused here, before the lock. */
async function mayWrite(db: Db, userId: string, raw: unknown): Promise<boolean> {
  const file = envelopeOf(raw);
  if (!(await firstImportDone(db, userId))) return true;
  const refs = [...new Set(file.sessions.flatMap((s) => {
    const id = (s as { id?: unknown } | null)?.id;
    return typeof id === "string" && id.length > 0 ? [id] : [];
  }))];
  const have = await alreadyImported(db, userId, refs);
  return refs.some((r) => !have.has(r));
}
