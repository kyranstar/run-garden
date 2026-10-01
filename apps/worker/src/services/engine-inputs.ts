/**
 * THE SESSION ENGINE'S INPUTS, FROM THE DATABASE (Phase 2 spec §2a "Build API" → Inputs; programme spec §7.2).
 *
 *   history       every `performed_sessions` row of the user, any source, with its done sets and its checks,
 *                 mapped through the engine's one mapping (`historyFromPerformed`, ruling P1-R3), oldest first —
 *                 for a build, only what it reads: the sessions `Hist.trim` keeps and `Hist.summarize` of the rest,
 *                 both in SQL (`loadBuildHistory`, ruling 2a-R6)
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
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
import {
  Hist,
  historyFromPerformed,
  type Block,
  type EngineLocation,
  type HistorySession,
  type HistorySummary,
  type MoveSummary,
  type Prefs,
} from "@rg/session-engine";
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

/** Sets grouped by session, in the order read. */
function bySession(rows: readonly SetRow[]): Map<string, SetRow[]> {
  const out = new Map<string, SetRow[]>();
  for (const r of rows) {
    const list = out.get(r.performedSessionId);
    if (list) list.push(r);
    else out.set(r.performedSessionId, [r]);
  }
  return out;
}

/**
 * Session rows (oldest first) with their sets and the check rows that may belong to them → the engine's history.
 * A session's checks are its own `pre`/`post` rows, plus a `pre` the session sheet recorded for the same slot and day
 * before the session was saved (the save does not record it twice).
 */
function toHistory(sessions: readonly SessionRow[], sets: Map<string, SetRow[]>, checks: readonly CheckRow[]): HistorySession[] {
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
    return historyFromPerformed(toWire(s, sets.get(s.id) ?? [], [...extra, ...own]));
  });
}

/**
 * Every performed session of the user (app, watch review, import), oldest first, as the engine's history.
 * Exercise ids pass through as stored: one the library no longer has is ignored by the engine, never an error.
 * A build reads `loadBuildHistory` instead; this is the whole history (for what needs all of it, and for tests).
 */
export async function loadHistory(db: Db, userId: string): Promise<HistorySession[]> {
  const sessions = await db
    .select()
    .from(performedSessions)
    .where(eq(performedSessions.userId, userId))
    .orderBy(asc(performedSessions.localDate), asc(performedSessions.startedAt), asc(performedSessions.id));
  if (sessions.length === 0) return [];

  const sets: SetRow[] = [];
  for (const batch of chunkIds(sessions.map((s) => s.id))) {
    sets.push(
      ...(await db
        .select()
        .from(performedSets)
        .where(inArray(performedSets.performedSessionId, batch))
        .orderBy(asc(performedSets.performedSessionId), asc(performedSets.entryIndex), asc(performedSets.setIndex))),
    );
  }
  const checks = await db
    .select()
    .from(conditionChecks)
    .where(and(eq(conditionChecks.userId, userId), inArray(conditionChecks.kind, ["pre", "post"])))
    .orderBy(asc(conditionChecks.at), asc(conditionChecks.id));
  return toHistory(sessions, bySession(sets), checks);
}

/** What a build reads of the history: the sessions it reads one by one, and the all-time facts of the rest. */
export interface BuildHistory {
  sessions: HistorySession[];
  summary: HistorySummary;
}

// ── The build's history in SQL (ruling 2a-R6) ─────────────────────────────────────────────────────────────────
//
// The engine says what a build reads (`Hist.trim`, `Hist.summarize`); one query computes both in the database —
// which sessions to read, and the all-time facts per move — and the held sessions are then read by id, so a build
// request maps a few dozen sessions and one row per move however long the history grows, instead of every session
// and set. The SQL mirrors `toWire` + `historyFromPerformed`: an entry is the sets with one entry index, named by its
// first set's exercise id and format, and it counts only with a done set; its flags are every set's; the moves a
// session touched are its entries' ids and `moves_done`. A session's start (`w`) is its start time, else its date.
//
// Order: SQLite compares start times by bytes, the engine by `localeCompare`. On ISO times the two disagree only
// between two times equal to the second and written differently (".000Z" against "+00:00"); each "newest N" below
// keeps a few more sessions than the engine needs, so the engine still finds its own among them (extra sessions
// never change a build), and a move's first session is the earliest by bytes — on such a tie both sessions share
// their date, which is all the engine reads of it.

const RECENT_SLACK = 2;
const ENTRY_SLACK = 1;
/** Ids per `IN (…)` list, under D1's bound-variable cap with room for the other parameters. */
const ID_CHUNK = 90;

/** A session's start, as the engine orders sessions: its start time, else its date. */
const startOf = (alias: string) => sql.raw(`COALESCE(NULLIF(${alias}.started_at, ''), ${alias}.local_date)`);
/** Newest first in the engine's order (start, then the history's own order on a tie: date, start time, id). */
const NEWEST = sql.raw(`COALESCE(NULLIF(started_at, ''), local_date) DESC, local_date DESC, started_at DESC, id DESC`);

interface HistoryRow {
  kind: "held" | "move" | "logged" | "flag";
  /** The raw exercise id (a held row: the session id). */
  raw: string;
  a: string | null;
  b: string | null;
  n: number | null;
}

/**
 * Every fact a build reads of the whole history, as rows: `held` (a session `Hist.trim` keeps, or one more; `a` its
 * slot, `n` its place in the history's order), and per raw exercise id `move` (`a` its first session's start and
 * date, joined by char(1); `b` its last date on or before the day), `logged` (`n`) and `flag` (`a` the flag, `n`
 * entries).
 */
function historyRows(db: Db, userId: string, date: string, from: string): Promise<HistoryRow[]> {
  return db.all(sql`
    WITH e AS (
      -- Logged entries (with a done set). With exactly one MIN() in a query, SQLite takes the bare columns from the
      -- row holding the minimum: the entry's first set.
      SELECT ps.performed_session_id AS sid, ps.entry_index AS ei, ps.exercise_id AS ex, ps.format AS fmt,
             ${startOf("p")} AS w, p.local_date AS local_date, p.started_at AS started_at, MIN(ps.set_index) AS first_set
      FROM performed_sessions p JOIN performed_sets ps ON ps.performed_session_id = p.id
      WHERE p.user_id = ${userId}
      GROUP BY ps.performed_session_id, ps.entry_index
      HAVING SUM(ps.done) > 0
    ),
    ranked AS (
      -- Each move's progression entries, newest first as the engine orders them.
      SELECT sid, ROW_NUMBER() OVER (PARTITION BY ex ORDER BY w DESC, local_date, started_at, sid, ei) AS rn
      FROM e WHERE ex <> '' AND (fmt IS NULL OR fmt NOT IN ('ladder', 'circuit'))
    ),
    held AS (
      SELECT id FROM performed_sessions WHERE user_id = ${userId} AND local_date >= ${from}
      UNION SELECT id FROM (
        SELECT id FROM performed_sessions WHERE user_id = ${userId} AND local_date <= ${date}
        ORDER BY ${NEWEST} LIMIT ${Hist.TRIM.recentSessions + RECENT_SLACK}
      )
      UNION SELECT id FROM (
        SELECT id FROM performed_sessions WHERE user_id = ${userId} AND local_date < ${date} AND COALESCE(theme, '') <> ''
        ORDER BY ${NEWEST} LIMIT ${1 + RECENT_SLACK}
      )
      UNION SELECT sid FROM ranked WHERE rn <= ${Hist.TRIM.progressionEntries + ENTRY_SLACK}
    ),
    touched AS (
      -- The moves each session touched (a move both logged and done twice: the minimum and maximum below don't mind).
      SELECT sid, ex AS raw FROM e WHERE ex <> ''
      UNION ALL
      SELECT p.id, t.atom FROM performed_sessions p, json_tree(p.moves_done) t
      WHERE p.user_id = ${userId} AND t.key = 'exerciseId' AND COALESCE(t.atom, '') <> ''
    ),
    touched_on AS (
      SELECT t.raw, ${startOf("p")} AS w, p.local_date AS local_date FROM touched t JOIN performed_sessions p ON p.id = t.sid
    )
    SELECT 'held' AS kind, p.id AS raw, p.workout_id AS a, NULL AS b,
           ROW_NUMBER() OVER (ORDER BY p.local_date, p.started_at, p.id) AS n
    FROM held h JOIN performed_sessions p ON p.id = h.id
    UNION ALL
    -- The first session as (start, date) — char(1) sorts below any character of either — and the last date.
    SELECT 'move', raw, MIN(w || char(1) || local_date), MAX(CASE WHEN local_date <= ${date} THEN local_date END), NULL
    FROM touched_on GROUP BY raw
    UNION ALL
    SELECT 'logged', ex, NULL, NULL, COUNT(*) FROM e WHERE ex <> '' AND local_date <= ${date} GROUP BY ex
    UNION ALL
    SELECT 'flag', ex, flag, NULL, COUNT(*) FROM (
      SELECT DISTINCT e.sid, e.ei, e.ex, e.local_date, j.value AS flag
      FROM e JOIN performed_sets ps ON ps.performed_session_id = e.sid AND ps.entry_index = e.ei AND ps.flags <> '[]',
           json_each(ps.flags) j
    ) WHERE ex <> '' AND local_date <= ${date} GROUP BY ex, flag
  `) as Promise<HistoryRow[]>;
}

/** The facts rows → `HistorySummary`, keys sorted (it is part of the inputs hash). */
function toSummary(rows: readonly HistoryRow[], asOf: string): HistorySummary {
  type Move = { first: MoveSummary["first"] | null; last: string | null; logged: number; flags: Record<string, number> };
  const moves = new Map<string, Move>();
  const at = (raw: string): Move => {
    let m = moves.get(raw);
    if (!m) {
      m = { first: null, last: null, logged: 0, flags: {} };
      moves.set(raw, m);
    }
    return m;
  };
  for (const r of rows) {
    if (r.kind === "held") continue;
    const m = at(r.raw);
    if (r.kind === "move") {
      const [when, date] = r.a!.split("\u0001") as [string, string];
      m.first = { when, date };
      m.last = r.b;
    } else if (r.kind === "logged") m.logged = Number(r.n);
    else m.flags[String(r.a)] = Number(r.n);
  }
  const out: Record<string, MoveSummary> = {};
  for (const raw of [...moves.keys()].sort()) {
    const m = moves.get(raw)!;
    if (!m.first) continue;   // every move a session touched has a first session
    const flags: Record<string, number> = {};
    for (const k of Object.keys(m.flags).sort()) flags[k] = m.flags[k]!;
    out[raw] = { first: m.first, last: m.last, logged: m.logged, flags };
  }
  return { asOf, moves: out };
}

/** One query per chunk of ids, results in chunk order. */
async function byChunks<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const parts = await Promise.all(chunkIds([...ids], ID_CHUNK).map(read));
  return parts.flat();
}

/**
 * What a build on `date` reads of the user's history (ruling 2a-R6): the sessions `Hist.trim` keeps (the recent ones,
 * the running block's, the last themed one, those holding each move's newest entries; and a few more), mapped exactly
 * as `loadHistory` maps them, and `Hist.summarize` of the whole history — computed in one query. Then the held
 * sessions, their sets and their checks by id: five queries and a bounded number of rows (about the window's sessions
 * plus two per move ever logged) however long the history. The engine plans exactly what it plans from the whole
 * history (build-history.test.ts; the engine's differential).
 */
export async function loadBuildHistory(
  db: Db,
  userId: string,
  date: string,
  block: Pick<Block, "startedAt" | "weeks" | "rotations"> | null,
): Promise<BuildHistory> {
  const rows = await historyRows(db, userId, date, Hist.TRIM.windowFrom(date, block));
  const summary = toSummary(rows, date);
  const held = rows.filter((r) => r.kind === "held").sort((x, y) => Number(x.n) - Number(y.n));
  if (held.length === 0) return { sessions: [], summary };
  const ids = held.map((r) => r.raw);
  const slots = [...new Set(held.map((r) => r.a).filter((w): w is string => w !== null))];
  const [sessionRows, sets, linked, sheet] = await Promise.all([
    byChunks(ids, (chunk) => db.select().from(performedSessions).where(and(eq(performedSessions.userId, userId), inArray(performedSessions.id, chunk)))),
    byChunks(ids, (chunk) =>
      db
        .select()
        .from(performedSets)
        .where(inArray(performedSets.performedSessionId, chunk))
        .orderBy(asc(performedSets.performedSessionId), asc(performedSets.entryIndex), asc(performedSets.setIndex)),
    ),
    // A session's own checks, and a slot's pre-check recorded before its save (each kept in the order loadHistory
    // reads them: within one session or one slot, by time).
    byChunks(ids, (chunk) =>
      db
        .select()
        .from(conditionChecks)
        .where(and(eq(conditionChecks.userId, userId), inArray(conditionChecks.kind, ["pre", "post"]), inArray(conditionChecks.performedSessionId, chunk)))
        .orderBy(asc(conditionChecks.at), asc(conditionChecks.id)),
    ),
    byChunks(slots, (chunk) =>
      db
        .select()
        .from(conditionChecks)
        .where(
          and(
            eq(conditionChecks.userId, userId),
            eq(conditionChecks.kind, "pre"),
            isNull(conditionChecks.performedSessionId),
            inArray(conditionChecks.workoutId, chunk),
          ),
        )
        .orderBy(asc(conditionChecks.at), asc(conditionChecks.id)),
    ),
  ]);
  const place = new Map(ids.map((id, i) => [id, i]));
  const sessions = [...sessionRows].sort((x, y) => place.get(x.id)! - place.get(y.id)!);
  return { sessions: toHistory(sessions, bySession(sets), [...linked, ...sheet]), summary };
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
