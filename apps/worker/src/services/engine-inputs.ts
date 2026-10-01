/**
 * THE SESSION ENGINE'S INPUTS, FROM THE DATABASE (Phase 2 spec §2a "Build API" → Inputs; programme spec §7.2).
 *
 *   history       every `performed_sessions` row of the user, any source, with its done sets and its checks,
 *                 mapped through the engine's one mapping (`historyFromPerformed`, ruling P1-R3), oldest first
 *   program state the program's latest `program_blocks` row as the engine's `Block`
 *   prefs         `exercise_prefs` (ratings, "not for me", pins); saved ids from `exercise_provenance`
 *   place         the override, else the program's default place, else the account's default, else the first;
 *                 implement weights parsed from the typed list (`parseWeightList`)
 *   unit          `prefs.weightUnit`
 *   profiles      active `user_conditions`; care = the program's `careProfiles` ∩ active
 *
 * Every list comes back in a fixed order, so the same rows always make the same inputs (and the same inputs hash).
 * Reads only, apart from `saveProgramState` — a no-op while a restore is replacing the account (ruling B2).
 */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import {
  conditionChecks,
  exercisePrefs,
  exerciseProvenance,
  locations as locationsTable,
  performedSessions,
  performedSets,
  programBlocks,
  programs,
  userConditions,
} from "@rg/database";
import {
  adaptiveConfigSchema,
  coreBlockIntentSchema,
  newId,
  parseWeightList,
  SESSION_FORMATS,
  SESSION_MODES,
  type AdaptiveConfig,
  type ConditionCheck,
  type PerformedEntry,
  type PerformedSessionWire,
  type UserPreferences,
  type Weight,
  type WeightUnit,
} from "@rg/domain";
import { isProfileId, LOCATION_PRESETS } from "@rg/exercise-library";
import { historyFromPerformed, type Block, type EngineLocation, type HistorySession, type Prefs } from "@rg/session-engine";
import { restoreInProgress } from "./account-state.js";
import { loadPreferences } from "./calendar-sync.js";
import { chunkIds, type Db } from "./db.js";

type SessionRow = typeof performedSessions.$inferSelect;
type SetRow = typeof performedSets.$inferSelect;
type CheckRow = typeof conditionChecks.$inferSelect;
type LocationRow = typeof locationsTable.$inferSelect;

const MODES: ReadonlySet<string> = new Set(SESSION_MODES);
const FORMATS: ReadonlySet<string> = new Set(SESSION_FORMATS);

const modeOf = (v: string | null): PerformedSessionWire["mode"] =>
  v !== null && MODES.has(v) ? (v as PerformedSessionWire["mode"]) : null;
const formatOf = (v: string | null): PerformedEntry["format"] =>
  v !== null && FORMATS.has(v) ? (v as PerformedEntry["format"]) : null;
const sideOf = (v: string | null): "left" | "right" | null => (v === "left" || v === "right" ? v : null);
/** A weight exactly as it was typed; anything else on a row is no weight. */
const loadOf = (value: number | null, unit: string | null): Weight | null =>
  value !== null && value > 0 && (unit === "lb" || unit === "kg") ? { v: value, u: unit } : null;

/** A session's rows → the wire shape `historyFromPerformed` reads. */
function toWire(s: SessionRow, sets: readonly SetRow[], checks: readonly CheckRow[]): PerformedSessionWire {
  const entries: PerformedEntry[] = [];
  let current: { index: number; entry: PerformedEntry } | null = null;
  for (const r of sets) {
    if (!current || current.index !== r.entryIndex) {
      current = {
        index: r.entryIndex,
        entry: { exerciseId: r.exerciseId, implement: r.implement, format: formatOf(r.format), perSide: r.perSide, sets: [] },
      };
      entries.push(current.entry);
    }
    current.entry.sets.push({
      setIndex: r.setIndex,
      side: sideOf(r.side),
      reps: r.reps,
      seconds: r.seconds,
      load: loadOf(r.loadValue, r.loadUnit),
      done: r.done,
      flags: [...r.flags],
    });
  }
  return {
    id: s.id,
    source: s.source as PerformedSessionWire["source"],
    sourceRef: s.sourceRef,
    workoutId: s.workoutId,
    buildId: s.buildId,
    localDate: s.localDate,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    seconds: s.seconds,
    plannedSeconds: s.plannedSeconds,
    minutes: s.minutes,
    mode: modeOf(s.mode),
    theme: s.theme,
    locationId: s.locationId,
    blockRef: s.blockRef,
    blockNumber: s.blockNumber,
    completed: s.completed,
    stepsTotal: s.stepsTotal,
    stepsDone: s.stepsDone,
    movesDone: s.movesDone ?? [],
    note: s.note,
    newMove: s.newMove,
    entries,
    checks: checks.map(
      (c): ConditionCheck => ({
        profileId: c.profileId,
        kind: c.kind as ConditionCheck["kind"],
        value: c.value,
        feelingOff: c.feelingOff,
        at: c.at,
      }),
    ),
    review: { ratings: {}, excluded: {}, graduations: [] },
  };
}

/**
 * Every performed session of the user (app, watch review, import), oldest first, as the engine's history.
 * A session's checks are its own `pre`/`post` rows, plus a `pre` the session sheet recorded for the same slot and
 * day before the session was saved (the save does not record it twice). Exercise ids pass through as stored:
 * one the library no longer has is ignored by the engine, never an error.
 */
export async function loadHistory(db: Db, userId: string): Promise<HistorySession[]> {
  const sessions = await db
    .select()
    .from(performedSessions)
    .where(eq(performedSessions.userId, userId))
    .orderBy(asc(performedSessions.localDate), asc(performedSessions.startedAt), asc(performedSessions.id));
  if (sessions.length === 0) return [];

  const setsBySession = new Map<string, SetRow[]>();
  for (const batch of chunkIds(sessions.map((s) => s.id))) {
    const rows = await db
      .select()
      .from(performedSets)
      .where(inArray(performedSets.performedSessionId, batch))
      .orderBy(asc(performedSets.performedSessionId), asc(performedSets.entryIndex), asc(performedSets.setIndex));
    for (const r of rows) {
      const list = setsBySession.get(r.performedSessionId);
      if (list) list.push(r);
      else setsBySession.set(r.performedSessionId, [r]);
    }
  }

  const checks = await db
    .select()
    .from(conditionChecks)
    .where(and(eq(conditionChecks.userId, userId), inArray(conditionChecks.kind, ["pre", "post"])))
    .orderBy(asc(conditionChecks.at), asc(conditionChecks.id));
  const linked = new Map<string, CheckRow[]>();
  const bySlotDay = new Map<string, CheckRow[]>();
  const slotDay = (workoutId: string, date: string) => `${workoutId}\u0000${date}`;
  for (const c of checks) {
    if (c.performedSessionId !== null) {
      linked.set(c.performedSessionId, [...(linked.get(c.performedSessionId) ?? []), c]);
    } else if (c.workoutId !== null && c.kind === "pre") {
      const key = slotDay(c.workoutId, c.localDate);
      bySlotDay.set(key, [...(bySlotDay.get(key) ?? []), c]);
    }
  }

  return sessions.map((s) => {
    const own = linked.get(s.id) ?? [];
    // The slot's pre-check, for a profile the session has no pre of its own.
    const sheet = s.workoutId === null ? [] : (bySlotDay.get(slotDay(s.workoutId, s.localDate)) ?? []);
    const extra = sheet.filter((c) => !own.some((o) => o.kind === "pre" && o.profileId === c.profileId));
    return historyFromPerformed(toWire(s, setsBySession.get(s.id) ?? [], [...extra, ...own]));
  });
}

/** The program's latest block (by number) as the engine's `Block`; null before the first. */
export async function loadProgramState(db: Db, programId: string): Promise<Block | null> {
  const [row] = await db
    .select()
    .from(programBlocks)
    .where(eq(programBlocks.programId, programId))
    .orderBy(desc(programBlocks.number))
    .limit(1);
  if (!row || row.kind !== "core_block") return null;
  // A damaged intent is an error, not a fresh start: a new block 1 would be written over the program's history.
  const intent = coreBlockIntentSchema.parse(row.intent);
  return { id: row.id, number: row.number, startedAt: row.startDate, weeks: row.weeks, core: intent.core, rotations: intent.rotations };
}

/**
 * Persist a block the engine started or changed: the same number updates that row's intent (core lifts and
 * rotations); a new number is a new row with an id of its own (the engine's `b<n>` is only unique within one
 * program). Returns the row's id — the `blockRef` a build and a performed session carry. A no-op while a restore
 * is replacing the program's account (returns the id it would have used, or the block's own).
 */
export async function saveProgramState(db: Db, programId: string, block: Block, now: string): Promise<string> {
  const [program] = await db.select({ userId: programs.userId }).from(programs).where(eq(programs.id, programId)).limit(1);
  if (!program) throw new Error("program_not_found");
  const [existing] = await db
    .select({ id: programBlocks.id })
    .from(programBlocks)
    .where(and(eq(programBlocks.programId, programId), eq(programBlocks.number, block.number)))
    .limit(1);
  if (await restoreInProgress(db, program.userId)) return existing?.id ?? block.id;
  const intent = coreBlockIntentSchema.parse({ core: block.core, rotations: block.rotations });
  if (existing) {
    await db
      .update(programBlocks)
      .set({ intent, weeks: block.weeks, updatedAt: now })
      .where(eq(programBlocks.id, existing.id));
    return existing.id;
  }
  const id = newId();
  await db.insert(programBlocks).values({
    id,
    programId,
    number: block.number,
    kind: "core_block",
    startDate: block.startedAt,
    weeks: block.weeks,
    intent,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export interface EngineContext {
  prefs: Prefs;
  savedIds: string[];
  /** The place this session happens. */
  location: EngineLocation;
  /** Every place, the account's default first: the engine judges a block with its first place's gear. */
  locations: EngineLocation[];
  unit: WeightUnit;
  activeProfiles: string[];
  careProfiles: string[];
  /** The program's settings (defaults filled; a stored config that does not parse reads as the defaults). */
  config: AdaptiveConfig;
}

/** The library's Home preset: where sessions happen for an account that has set up no place yet. */
function presetHome(): EngineLocation {
  const home = LOCATION_PRESETS.find((l) => l.id === "home")!;
  return { id: home.id, name: home.name, equipment: [...home.equipment], implements: {} };
}

/** A stored implement list: the typed text ("8, 12, 16 kg"), or weights already parsed. */
function implementWeights(value: unknown, unit: WeightUnit): Weight[] {
  if (typeof value === "string") return parseWeightList(value, unit);
  if (Array.isArray(value)) {
    return value.filter(
      (w): w is Weight =>
        typeof w === "object" && w !== null && typeof (w as Weight).v === "number" && (w as Weight).v > 0 &&
        ((w as Weight).u === "lb" || (w as Weight).u === "kg"),
    );
  }
  return [];
}

function toEngineLocation(row: LocationRow, unit: WeightUnit): EngineLocation {
  const implementsTyped = row.implements ?? {};
  return {
    id: row.id,
    name: row.name,
    equipment: [...row.equipment],
    implements: Object.fromEntries(
      Object.keys(implementsTyped)
        .sort()
        .map((k) => [k, implementWeights(implementsTyped[k], unit)]),
    ),
  };
}

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** Prefs, saved ids, the place, the unit and the profiles for one build of `programId` (this user's). */
export async function loadEngineContext(
  db: Db,
  userId: string,
  programId: string,
  opts: { locationId?: string; prefs?: UserPreferences },
): Promise<EngineContext> {
  const [program] = await db
    .select({ config: programs.config })
    .from(programs)
    .where(and(eq(programs.id, programId), eq(programs.userId, userId)))
    .limit(1);
  if (!program) throw new Error("program_not_found");
  const parsed = adaptiveConfigSchema.safeParse(program.config);
  if (!parsed.success) console.error(`program ${programId}: stored config does not parse; building with the defaults`);
  const config = parsed.success ? parsed.data : adaptiveConfigSchema.parse({});

  const [conditionRows, prefRows, savedRows, placeRows, userPrefs] = await Promise.all([
    db
      .select({ profileId: userConditions.profileId })
      .from(userConditions)
      .where(and(eq(userConditions.userId, userId), eq(userConditions.active, true))),
    db.select().from(exercisePrefs).where(eq(exercisePrefs.userId, userId)),
    db.select({ exerciseId: exerciseProvenance.exerciseId }).from(exerciseProvenance).where(eq(exerciseProvenance.userId, userId)),
    db
      .select()
      .from(locationsTable)
      .where(eq(locationsTable.userId, userId))
      .orderBy(asc(locationsTable.createdAt), asc(locationsTable.id)),
    opts.prefs ? Promise.resolve(opts.prefs) : loadPreferences(db, userId),
  ]);
  const unit = userPrefs.weightUnit;

  // A profile id the library does not know cannot be planned with; it reads as inactive.
  const activeProfiles = sortedUnique(conditionRows.map((r) => r.profileId).filter(isProfileId));
  const careProfiles = config.careProfiles.filter((id) => activeProfiles.includes(id));

  const byExercise = [...prefRows].sort((a, b) => a.exerciseId.localeCompare(b.exerciseId));
  const prefs: Prefs = {
    ratings: Object.fromEntries(byExercise.filter((r) => r.rating !== null && r.rating !== 0).map((r) => [r.exerciseId, r.rating!])),
    excluded: byExercise.filter((r) => r.excluded).map((r) => r.exerciseId),
    pinned: byExercise.filter((r) => r.pinned).map((r) => r.exerciseId),
  };
  const savedIds = sortedUnique(savedRows.map((r) => r.exerciseId));

  const places = placeRows.map((r) => toEngineLocation(r, unit));
  if (places.length === 0) {
    const home = presetHome();
    return { prefs, savedIds, location: home, locations: [home], unit, activeProfiles, careProfiles, config };
  }
  const defaultRow = placeRows.find((r) => r.isDefault) ?? placeRows[0]!;
  const ordered = [places.find((p) => p.id === defaultRow.id)!, ...places.filter((p) => p.id !== defaultRow.id)];
  const pick = (id: string | null | undefined) => (id ? ordered.find((p) => p.id === id) : undefined);
  const location = pick(opts.locationId) ?? pick(config.defaultLocationId) ?? ordered[0]!;
  return { prefs, savedIds, location, locations: ordered, unit, activeProfiles, careProfiles, config };
}
