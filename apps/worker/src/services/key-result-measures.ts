/**
 * KEY RESULTS MEASURED FROM LOGGED DATA (programme spec §3.6 and its Amendment A; principles §5.2, §2.9 honesty).
 *
 * Every measure reads only what it needs, scoped to the account, in its window (today and the `windowDays − 1` days
 * before it, by the athlete's local date), and answers `KeyResultProgress`: the current value, the series, how many
 * points, and how far the current value can be trusted (`evidence`). Many measures are read together
 * (`measureKeyResults`): one read per source for all of them, each reaching its rows through the window itself (a
 * subquery) or one bound JSON list — so an objective's progress costs the same few statements however many key
 * results it holds and however many sessions its windows hold.
 *
 * RULES
 * - hold_max: the longest done set (`performed_sets.seconds`) of the moves, app and watch sessions alike — a set held
 *   a side at a time (a row per side under one set number) at its shorter side, as history reads it. best_set:
 *   per done, loaded set — `e1rm` = kg × (1 + reps / 30) (Epley; a single is its own load; a set of more than 12 reps
 *   is no estimate and is left out), `load_at_reps` = the heaviest kg lifted for at least `reps`, `reps_at_load` = the
 *   most reps at `loadKg` or more (within 0.05 kg). Logs use `load_kg`, so sets typed in lb and kg compare. One point
 *   per day: the day's best.
 * - CAPACITY. The player stops a timed hold at its prescription and a set done exactly as prescribed is no max, so a
 *   set shows capacity only when its item was a test or the logged value went past the prescription ON THE MEASURE'S
 *   OWN DIMENSION:
 *     - a test is an item with `dose.max` or a key-result `test` marker. A test hold logged within a second of its
 *       window (`holdSec`) stays capped — the timer stopped it; shorter is a true max (the athlete stopped), longer by
 *       two seconds or more beat the window. A test set (reps or load) is capacity;
 *     - otherwise: a hold at least two seconds past `holdSec` (a watch lap rounds by up to a second); for `e1rm`, more
 *       reps than prescribed or more load (by more than 0.05 kg); for `load_at_reps`, more load only; for
 *       `reps_at_load`, more reps only.
 *   The prescription is the session's document — its build's (`session_builds.workout_doc`), else its planned row's
 *   (`planned_workouts.workout_doc`) — and for a move the document does not hold, the build's own steps
 *   (`payload.build.steps`: a timed step's seconds, a set step's target reps and weight), else the slot it was swapped
 *   into mid-session: a document build's ⇄ options (`payload.build.fromDoc.slots`: a planned alternate or a library
 *   offer) carry the slot's `max` and the option's own timed seconds — a real max on the swapped move counts. A move
 *   offered in more than one slot is judged by the slot the session saved it in (`moves_done[].slotKey`: the recorder
 *   names the slot each move was played in); a session saved before it did, by the slot at the set's place among the
 *   session's moves (its entry: the moves in the order the build first plays them — a guess, as an entry with no done
 *   set is dropped at save and a swap after a slot's first set adds an entry), when one is there; else by every slot
 *   offering it, a slot to max winning (`max` makes it a test). An app session's build is
 *   its `build_id`; a watch session's is its workout's latest locked build (the one sent). SQLite reads just the
 *   moves' items and steps out of the documents and payloads; the Worker never parses either whole. A set whose
 *   prescription is unknown is not capacity — nothing says it was a max. `current` is the best of every set (each is
 *   at least what the athlete can do); evidence is `capped` when no capacity set reaches it, else `measured` (three or
 *   more days with capacity) or `sparse`.
 * - One physical session counts once: an activity's sessions go through `sessionPerActivity` (the athlete's own
 *   record over the watch's copy); a session still being written (`PENDING_HASH`) is not there yet.
 * - run_best: COROS runs (`sport = run`) at least `distanceM` long and at most 10 % longer, each one's time
 *   (`duration_seconds`) scaled to exactly `distanceM`; a longer run is skipped (its pace over the distance is not
 *   its pace at it). A point per run; the current is the fastest. Each point is labelled from the planned workout it
 *   completed (`workout_completion_matches`): a run item at race effort in its document makes it a `race` on a race
 *   day (a profile event of kind race, or the race hub's race date) and, on any other day, a `test` (a time trial) —
 *   but only when a race-effort item covers the distance (within 1 %); a run on a race day with no document is the
 *   race; the rest is `training`.
 * - pace_at_hr: runs at least `minDurationSec` long whose average heart rate is in [hrLow, hrHigh], their pace
 *   (`avg_pace_sec_per_km`, else time over distance) per run; the current is the median of the latest three.
 * - threshold_pace: the watch's threshold pace per day (`daily_health`); predicted_time: the race hub's prediction
 *   (`racePrediction`, its fast edge — Riegel from the hour at threshold) for `distanceM` from each day's threshold
 *   pace. The current is the latest day's.
 * - checkin and test: not measured until Stage 4 adds the questions and the tests.
 * - Runs, threshold days: three or more points are `measured`, one or two `sparse`, none `none` with a `missing` note.
 */
import { and, asc, eq, exists, gt, gte, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  activities,
  athleteProfiles,
  dailyHealth,
  performedSessions,
  performedSets,
  plannedWorkouts,
  sessionBuilds,
  workoutCompletionMatches,
} from "@rg/database";
import {
  addDays,
  canonicalUnitOf,
  displayValue,
  profileEventSchema,
  racePrediction,
  SAME_WEIGHT_KG,
  toKg,
  type CanonicalUnit,
  type KeyResultEvidence,
  type KeyResultMeasure,
  type KeyResultPoint,
  type KeyResultProgress,
  type KeyResultUnit,
} from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import type { Db } from "./db.js";
import { sessionPerActivity } from "./logged-sets.js";
import { PENDING_HASH } from "./watch-sets.js";

/** Points that show capacity (or runs, or days) before a current value is `measured` rather than `sparse`. */
export const MEASURED_MIN_POINTS = 3;
/** How much longer than the distance a run may be and still be scaled to it. */
export const RUN_OVER_DISTANCE_MAX = 0.1;
/** A hold within this many seconds of its window is where the timer (or a rounded watch lap) left it. */
export const HOLD_WINDOW_SEC = 1;
/** Epley's estimate holds up to this many reps; a longer set is left out of e1RM. */
export const E1RM_MAX_REPS = 12;
/** How far short of the distance a race-effort item may be and still cover it (a typed distance's rounding). */
const COVER_TOLERANCE = 0.01;
/** The latest runs whose median pace is pace_at_hr's current value. */
const CURRENT_PACE_RUNS = 3;
/** Paces outside this (s/km) are a broken record, not a run. */
const PACE_BOUNDS = { fast: 120, slow: 1800 } as const;
/** Days a race event spreads over at most when labelling runs (a stage race, a ski week). */
const MAX_EVENT_DAYS = 21;

export interface MeasureContext {
  /** The athlete's today (LocalDate): every window ends on it. */
  today: string;
  /** The race hub's race date (the user's preferences), for run_best's labels; the caller has read it already. */
  raceDate?: string | null;
}

export interface MeasureRequest {
  measure: KeyResultMeasure;
  /** The key result's unit, for `display`; the canonical unit when absent. */
  unit?: KeyResultUnit;
}

// ── The library's ids ───────────────────────────────────────────────────────────────────────────────────────────────

let movesById: Map<string, ExerciseRecord> | null = null;
/** The library move an id names now — its own id or one it had (`legacyIds`) — or undefined. */
export function libraryMove(id: string): ExerciseRecord | undefined {
  if (movesById === null) {
    movesById = new Map();
    for (const e of EXERCISES) for (const legacy of e.legacyIds) if (!movesById.has(legacy)) movesById.set(legacy, e);
    for (const e of EXERCISES) movesById.set(e.id, e);
  }
  return movesById.get(id);
}
const canonicalId = (id: string): string => libraryMove(id)?.id ?? id;

/** Every id a logged set (or a document's item) of these moves may carry: each move's id and the ids it had. */
function loggedIdsOf(libraryIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of libraryIds) {
    const move = libraryMove(id);
    out.add(id);
    if (move) {
      out.add(move.id);
      for (const legacy of move.legacyIds) out.add(legacy);
    }
  }
  return [...out].sort();
}

// ── Shared ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const DECIMALS: Record<CanonicalUnit, number> = { s: 0, kg: 1, reps: 0, "s/km": 0, score: 1 };
const rounded = (unit: CanonicalUnit, v: number): number => Math.round(v * 10 ** DECIMALS[unit]) / 10 ** DECIMALS[unit];
const windowStart = (today: string, windowDays: number): string => addDays(today, -(windowDays - 1));

/** A list bound as ONE JSON text and read back as rows: an IN list of any length under D1's 100-variable cap. */
const jsonList = (values: readonly string[]): SQL => sql`(select value from json_each(${JSON.stringify(values)}))`;

/** A JSON array column read by SQLite; null when absent, [] when unreadable. */
function parsedList<T>(text: string | null | undefined, ok: (x: unknown) => x is T): T[] | null {
  if (text === null || text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter(ok) : [];
  } catch {
    return [];
  }
}

/** A local date from an activity's wall-clock start, else its UTC start. */
const LOCAL_DATE = sql<string>`substr(coalesce(${activities.startTimeLocal}, ${activities.startTime}), 1, 10)`;

interface Measured {
  points: Array<Omit<KeyResultPoint, "display">>;
  current: number | null;
  evidence: KeyResultEvidence;
  missing?: string;
}

const none = (missing: string): Measured => ({ points: [], current: null, evidence: "none", missing });
const byCount = (n: number): KeyResultEvidence => (n >= MEASURED_MIN_POINTS ? "measured" : "sparse");

function finish(request: MeasureRequest, m: Measured): KeyResultProgress {
  const canonical = canonicalUnitOf(request.measure);
  const unit: KeyResultUnit = request.unit ?? canonical;
  const series: KeyResultPoint[] = m.points.map((p) => ({ ...p, display: displayValue(p.value, canonical, unit) }));
  return {
    unit: canonical,
    current: m.current,
    series,
    lastMeasuredAt: series.length > 0 ? series[series.length - 1]!.date : null,
    sampleSize: series.length,
    evidence: m.evidence,
    ...(m.missing !== undefined ? { missing: m.missing } : {}),
    display: { unit, current: m.current === null ? null : displayValue(m.current, canonical, unit) },
  };
}

/** A progress for a key result whose stored measure can no longer be read. */
export function unreadableProgress(unit: KeyResultUnit): KeyResultProgress {
  return {
    unit: "score",
    current: null,
    series: [],
    lastMeasuredAt: null,
    sampleSize: 0,
    evidence: "none",
    missing: "This key result's measure can no longer be read.",
    display: { unit, current: null },
  };
}

// ── Strength: the sets, and what prescribed them ────────────────────────────────────────────────────────────────────

interface LoggedSet {
  date: string;
  /** The library's id now. */
  exerciseId: string;
  reps: number | null;
  seconds: number | null;
  kg: number | null;
  /** The hold shows capacity (see the module comment). */
  holdCapacity: boolean;
  /** Its item was a test. */
  test: boolean;
  /** More reps than prescribed. */
  repsBeyond: boolean;
  /** More load than prescribed (by more than 0.05 kg). */
  loadBeyond: boolean;
}

/** A document's item for one of the moves, as SQLite reads it: [libraryId, test (0|1), holdSec, reps (or range max), kg (bodyweight 0)]. */
type CompactItem = [string, number, number | null, number | null, number | null];
/** A build step, as SQLite reads it: [exerciseId, kind, seconds, target reps, target weight v, u]. */
type CompactStep = [string | null, string | null, number | null, number | null, number | null, string | null];

/**
 * A document build's ⇄ option for one of the moves, as SQLite reads it: [move id, its slot's max (0|1), its timed
 * seconds, its slot's key].
 */
type CompactOption = [string, number, number | null, string];
/** A build's logged steps in play order, as SQLite reads them: [slot key, move id]. */
type CompactPlace = [string, string];
/** A move's build slot as the session saved it (`moves_done`), as SQLite reads it: [move id, slot key]. */
type CompactSlot = [string, string];

const isItem = (x: unknown): x is CompactItem => Array.isArray(x) && x.length === 5 && typeof x[0] === "string";
const isStep = (x: unknown): x is CompactStep => Array.isArray(x) && x.length === 6;
const isOption = (x: unknown): x is CompactOption => Array.isArray(x) && x.length === 4 && typeof x[0] === "string";
const isPlace = (x: unknown): x is CompactPlace => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && typeof x[1] === "string";
const isSlot = (x: unknown): x is CompactSlot => Array.isArray(x) && x.length === 2 && typeof x[0] === "string" && typeof x[1] === "string";

interface Prescribed {
  /** The moves' items in the session's document; null when the session has no document. */
  items: CompactItem[] | null;
  steps: CompactStep[];
  /** The moves among the build's ⇄ options (a document build's slots), with their slot's prescription. */
  options: CompactOption[];
  /** Each slot's place among the session's moves (an entry index), read from the build's logged steps. */
  places: Map<string, number>;
}

/**
 * Each slot's place among a session's moves: the moves in the order the build first plays them, as the recorder
 * numbers its entries (one entry a move) — so the entry a set was saved under says which slot it was played in.
 */
function placesOf(steps: readonly CompactPlace[]): Map<string, number> {
  const moves: string[] = [];
  const out = new Map<string, number>();
  for (const [slotKey, move] of steps) {
    if (!moves.includes(move)) moves.push(move);
    if (!out.has(slotKey)) out.set(slotKey, moves.indexOf(move));
  }
  return out;
}

/** What a session asked of one move: whether it was a test, and the most it prescribed (undefined where it said nothing). */
interface Prescription {
  test: boolean;
  holdSec?: number;
  reps?: number;
  kg?: number;
}

/**
 * The exercise items for these moves in a stored document column, read by SQLite. Null when the column holds no
 * readable v1 document; `[]` when it holds one without these moves.
 */
function documentItems(doc: SQLiteColumn, moves: SQL): SQL<string | null> {
  return sql<string | null>`case when json_valid(${doc}) and json_extract(${doc}, '$.version') = 1 then (
    select json_group_array(json_array(
      json_extract(di.value, '$.libraryId'),
      coalesce(json_extract(di.value, '$.dose.max'), 0) or json_type(di.value, '$.test') is not null,
      json_extract(di.value, '$.dose.holdSec'),
      coalesce(json_extract(di.value, '$.dose.reps.max'), json_extract(di.value, '$.dose.reps')),
      case when json_extract(di.value, '$.dose.load') = 'bodyweight' then 0 else json_extract(di.value, '$.dose.load.kg') end))
    from json_each(${doc}, '$.parts') dp, json_each(dp.value, '$.items') di
    where json_extract(di.value, '$.kind') = 'exercise' and json_extract(di.value, '$.libraryId') in ${moves}
  ) end`;
}

/** A stored build's timed and set steps for these moves, read by SQLite (the payload is 100+ KB of JSON). */
function buildSteps(moves: SQL): SQL<string | null> {
  return sql<string | null>`case when json_valid(${sessionBuilds.payload}) then (
    select json_group_array(json_array(
      json_extract(st.value, '$.exerciseId'), json_extract(st.value, '$.kind'), json_extract(st.value, '$.seconds'),
      json_extract(st.value, '$.target.reps'), json_extract(st.value, '$.target.w.v'), json_extract(st.value, '$.target.w.u')))
    from json_each(${sessionBuilds.payload}, '$.build.steps') st
    where json_extract(st.value, '$.kind') in ('timed', 'set') and json_extract(st.value, '$.exerciseId') in ${moves}
  ) end`;
}

/**
 * A document build's ⇄ options for these moves — the planned alternates and library offers each slot carried — with
 * the slot's `max` and the option's own timed steps' longest window, read by SQLite.
 */
function slotOptions(moves: SQL): SQL<string | null> {
  return sql<string | null>`case when json_valid(${sessionBuilds.payload}) and json_type(${sessionBuilds.payload}, '$.build.fromDoc.slots') = 'object' then (
    select json_group_array(json_array(
      json_extract(op.value, '$.id'),
      coalesce(json_extract(sl.value, '$.max'), 0),
      (select max(json_extract(st.value, '$.seconds')) from json_each(op.value, '$.steps') st where json_extract(st.value, '$.kind') = 'timed'),
      sl.key))
    from json_each(${sessionBuilds.payload}, '$.build.fromDoc.slots') sl, json_each(sl.value) grp, json_each(grp.value) op
    where grp.key in ('alternates', 'offers') and json_extract(op.value, '$.id') in ${moves}
  ) end`;
}

/** The build slots a session saved these moves in (`moves_done[].slotKey`) — [move id, slot key] — read by SQLite. */
function savedSlots(moves: SQL): SQL<string | null> {
  return sql<string | null>`case when json_valid(${performedSessions.movesDone}) then (
    select json_group_array(json_array(json_extract(m.value, '$.exerciseId'), json_extract(m.value, '$.slotKey')))
    from json_each(${performedSessions.movesDone}) m
    where m.type = 'object' and json_type(m.value, '$.slotKey') = 'text' and json_extract(m.value, '$.exerciseId') in ${moves}
  ) end`;
}

/** A document build's logged steps in play order — [slot key, move id] — for the slots' places (`placesOf`). */
function loggedPlaces(): SQL<string | null> {
  return sql<string | null>`case when json_valid(${sessionBuilds.payload}) and json_type(${sessionBuilds.payload}, '$.build.fromDoc.slots') = 'object' then (
    select json_group_array(json_array(json_extract(st.value, '$.slotKey'), json_extract(st.value, '$.exerciseId')))
    from json_each(${sessionBuilds.payload}, '$.build.steps') st
    where json_extract(st.value, '$.log') = 1 and json_extract(st.value, '$.exerciseId') is not null
  ) end`;
}

const maxOf = (xs: readonly (number | null | undefined)[]): number | undefined => {
  const vs = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return vs.length > 0 ? Math.max(...vs) : undefined;
};

/**
 * What the session asked of this move: its document's items for it, else its build's steps, else the slot it was
 * swapped into (a document build's ⇄ option: the slot's max, the option's window) — the slot the session saved it in
 * (`slot`), else the one at its entry's place; null when none says.
 */
function prescriptionFor(p: Prescribed | undefined, exerciseId: string, entryIndex: number, slot: string | undefined): Prescription | null {
  if (!p) return null;
  const items = (p.items ?? []).filter((i) => canonicalId(i[0]) === exerciseId);
  if (items.length > 0) {
    const tests = items.filter((i) => i[1] === 1);
    if (tests.length > 0) return { test: true, holdSec: maxOf(tests.map((i) => i[2])) };
    return { test: false, holdSec: maxOf(items.map((i) => i[2])), reps: maxOf(items.map((i) => i[3])), kg: maxOf(items.map((i) => i[4])) };
  }
  const steps = p.steps.filter((s) => typeof s[0] === "string" && canonicalId(s[0]) === exerciseId);
  if (steps.length === 0) {
    const offered = p.options.filter((o) => canonicalId(o[0]) === exerciseId);
    if (offered.length === 0) return null;
    // The slot it was played in, as the session saved it; a session saved before it said: the slot at the set's place,
    // when one is. Else (or when that slot does not offer it) every slot offering it, a slot to max winning.
    const placed = slot !== undefined ? offered.filter((o) => o[3] === slot) : offered.filter((o) => p.places.get(o[3]) === entryIndex);
    const options = placed.length > 0 ? placed : offered;
    const tests = options.filter((o) => o[1] === 1);
    return { test: tests.length > 0, holdSec: maxOf((tests.length > 0 ? tests : options).map((o) => o[2])) };
  }
  const weight = (s: CompactStep): number | undefined =>
    typeof s[4] === "number" && (s[5] === "kg" || s[5] === "lb") ? toKg({ v: s[4], u: s[5] }) : undefined;
  return {
    test: false,
    holdSec: maxOf(steps.filter((s) => s[1] === "timed").map((s) => s[2])),
    reps: maxOf(steps.filter((s) => s[1] === "set").map((s) => s[3])),
    kg: maxOf(steps.filter((s) => s[1] === "set").map(weight)),
  };
}

function holdShowsCapacity(seconds: number | null, p: Prescription | null): boolean {
  if (!p || seconds === null) return false;
  // A test: at its window the timer stopped it; short of it, the athlete did; well past it, they beat it.
  if (p.test) return p.holdSec === undefined || Math.abs(seconds - p.holdSec) > HOLD_WINDOW_SEC;
  return p.holdSec !== undefined && seconds > p.holdSec + HOLD_WINDOW_SEC;
}

/** The done sets of these moves in [from, to], one physical session once, each judged against its prescription. */
async function loggedSets(db: Db, userId: string, from: string, to: string, exerciseIds: readonly string[]): Promise<LoggedSet[]> {
  const inWindow = and(
    eq(performedSessions.userId, userId),
    gte(performedSessions.localDate, from),
    lte(performedSessions.localDate, to),
    // Mid-write: not there yet.
    ne(performedSessions.payloadHash, PENDING_HASH),
  );
  const moves = jsonList(exerciseIds);
  /** The session (of the window) logged a done set of these moves. */
  const loggedTheMoves = exists(
    db
      .select({ one: sql`1` })
      .from(performedSets)
      .where(and(eq(performedSets.performedSessionId, performedSessions.id), eq(performedSets.done, true), inArray(performedSets.exerciseId, moves))),
  );
  const [sessionRows, setRows, buildRows, plannedRows] = await Promise.all([
    db
      .select({
        id: performedSessions.id,
        activityId: performedSessions.activityId,
        workoutId: performedSessions.workoutId,
        buildId: performedSessions.buildId,
        source: performedSessions.source,
        localDate: performedSessions.localDate,
        createdAt: performedSessions.createdAt,
        slots: savedSlots(moves),
      })
      .from(performedSessions)
      .where(inWindow),
    db
      .select({
        sessionId: performedSets.performedSessionId,
        entryIndex: performedSets.entryIndex,
        setIndex: performedSets.setIndex,
        side: performedSets.side,
        exerciseId: performedSets.exerciseId,
        reps: performedSets.reps,
        seconds: performedSets.seconds,
        kg: performedSets.loadKg,
      })
      .from(performedSets)
      .where(
        and(
          inArray(performedSets.exerciseId, moves),
          eq(performedSets.done, true),
          inArray(performedSets.performedSessionId, db.select({ id: performedSessions.id }).from(performedSessions).where(inWindow)),
        ),
      ),
    // The builds those sessions played: an app session's own, a watch session's workout's locked ones.
    db
      .select({
        id: sessionBuilds.id,
        workoutId: sessionBuilds.workoutId,
        version: sessionBuilds.version,
        lockedAt: sessionBuilds.lockedAt,
        items: documentItems(sessionBuilds.workoutDoc, moves),
        steps: buildSteps(moves),
        options: slotOptions(moves),
        places: loggedPlaces(),
      })
      .from(sessionBuilds)
      .where(
        and(
          eq(sessionBuilds.userId, userId),
          or(
            inArray(
              sessionBuilds.id,
              db
                .select({ id: performedSessions.buildId })
                .from(performedSessions)
                .where(and(inWindow, isNotNull(performedSessions.buildId), loggedTheMoves)),
            ),
            and(
              isNotNull(sessionBuilds.lockedAt),
              inArray(
                sessionBuilds.workoutId,
                db
                  .select({ id: performedSessions.workoutId })
                  .from(performedSessions)
                  .where(and(inWindow, isNull(performedSessions.buildId), isNotNull(performedSessions.workoutId), loggedTheMoves)),
              ),
            ),
          ),
        ),
      ),
    db
      .select({ id: plannedWorkouts.id, items: documentItems(plannedWorkouts.workoutDoc, moves) })
      .from(plannedWorkouts)
      .where(
        and(
          eq(plannedWorkouts.userId, userId),
          isNotNull(plannedWorkouts.workoutDoc),
          inArray(
            plannedWorkouts.id,
            db
              .select({ id: performedSessions.workoutId })
              .from(performedSessions)
              .where(and(inWindow, isNotNull(performedSessions.workoutId), loggedTheMoves)),
          ),
        ),
      ),
  ]);

  // One physical session once: the activity's own record over the watch's copy (the feed's rule).
  const chosen = new Map(
    [...sessionPerActivity(sessionRows).values(), ...sessionRows.filter((s) => !s.activityId)].map((s) => [s.id, s]),
  );
  const builds = new Map(buildRows.map((b) => [b.id, b]));
  // A watch session played what was sent: its workout's latest locked build.
  const sent = new Map<string, (typeof buildRows)[number]>();
  for (const b of buildRows) {
    if (b.lockedAt === null) continue;
    const held = sent.get(b.workoutId);
    if (!held || b.version > held.version) sent.set(b.workoutId, b);
  }
  const plannedItems = new Map(plannedRows.map((r) => [r.id, parsedList(r.items, isItem)]));
  const prescribed = new Map<string, Prescribed>();
  const prescribedFor = (sessionId: string): Prescribed => {
    const held = prescribed.get(sessionId);
    if (held) return held;
    const s = chosen.get(sessionId)!;
    const b = s.buildId !== null ? builds.get(s.buildId) : s.workoutId !== null ? sent.get(s.workoutId) : undefined;
    const items = parsedList(b?.items, isItem) ?? (s.workoutId !== null ? (plannedItems.get(s.workoutId) ?? null) : null);
    const p = {
      items,
      steps: parsedList(b?.steps, isStep) ?? [],
      options: parsedList(b?.options, isOption) ?? [],
      places: placesOf(parsedList(b?.places, isPlace) ?? []),
    };
    prescribed.set(sessionId, p);
    return p;
  };
  /** The build slot the session saved the move in (an app save names one; an older save, or a watch session, none). */
  const slots = new Map<string, Map<string, string>>();
  const slotOf = (sessionId: string, exerciseId: string): string | undefined => {
    let held = slots.get(sessionId);
    if (!held) {
      held = new Map((parsedList(chosen.get(sessionId)!.slots, isSlot) ?? []).map(([move, slotKey]) => [canonicalId(move), slotKey]));
      slots.set(sessionId, held);
    }
    return held.get(exerciseId);
  };

  // A set held a side at a time is a row per side under one set number: one set, at its shorter side (as history reads
  // it — the per-side rows never make a longer hold than both sides held), and only with both sides there: one side
  // alone (the other skipped) measures nothing.
  const sets = new Map<string, (typeof setRows)[number]>();
  const sides = new Map<string, Set<string>>();
  for (const r of setRows) {
    const key = r.side === null ? `${r.sessionId}|${r.entryIndex}|${r.setIndex}|${sets.size}` : `${r.sessionId}|${r.entryIndex}|${r.setIndex}`;
    const held = sets.get(key);
    const seconds = !held || held.seconds === null ? r.seconds : r.seconds === null ? held.seconds : Math.min(held.seconds, r.seconds);
    sets.set(key, { ...(held ?? r), seconds });
    if (r.side !== null) sides.set(key, (sides.get(key) ?? new Set()).add(r.side));
  }
  for (const [key, held] of sides) if (held.size < 2) sets.set(key, { ...sets.get(key)!, seconds: null });
  return [...sets.values()]
    .filter((r) => chosen.has(r.sessionId))
    .map((r) => {
      const exerciseId = canonicalId(r.exerciseId);
      const p = prescriptionFor(prescribedFor(r.sessionId), exerciseId, r.entryIndex, slotOf(r.sessionId, exerciseId));
      return {
        date: chosen.get(r.sessionId)!.localDate,
        exerciseId,
        reps: r.reps,
        seconds: r.seconds,
        kg: r.kg,
        holdCapacity: holdShowsCapacity(r.seconds, p),
        test: p?.test ?? false,
        repsBeyond: p !== null && r.reps !== null && p.reps !== undefined && r.reps > p.reps,
        loadBeyond: p !== null && r.kg !== null && p.kg !== undefined && r.kg > p.kg + SAME_WEIGHT_KG,
      };
    });
}

type StrengthMeasure = Extract<KeyResultMeasure, { kind: "hold_max" | "best_set" }>;

/** A set's value for the measure; null when the set says nothing about it. */
function setValue(m: StrengthMeasure, s: LoggedSet): number | null {
  if (m.kind === "hold_max") return s.seconds !== null && s.seconds > 0 ? s.seconds : null;
  const kg = s.kg ?? 0;
  const reps = s.reps ?? 0;
  if (reps < 1) return null;
  switch (m.metric) {
    case "e1rm":
      if (kg <= 0 || reps > E1RM_MAX_REPS) return null;
      return reps === 1 ? kg : kg * (1 + reps / 30);
    case "load_at_reps":
      return kg > 0 && reps >= (m.reps ?? 1) ? kg : null;
    case "reps_at_load":
      return kg >= (m.loadKg ?? 0) - SAME_WEIGHT_KG ? reps : null;
  }
}

/** The set shows capacity for this measure: a test, or past the prescription on the measure's own dimension. */
function showsCapacity(m: StrengthMeasure, s: LoggedSet): boolean {
  if (m.kind === "hold_max") return s.holdCapacity;
  switch (m.metric) {
    case "e1rm":
      return s.test || s.repsBeyond || s.loadBeyond;
    case "load_at_reps":
      return s.test || s.loadBeyond;
    case "reps_at_load":
      return s.test || s.repsBeyond;
  }
}

function measureStrength(m: StrengthMeasure, sets: readonly LoggedSet[], today: string): Measured {
  const from = windowStart(today, m.windowDays);
  const ids = new Set(m.libraryIds.map(canonicalId));
  const days = new Map<string, { best: number; capacity: number }>();
  for (const s of sets) {
    if (s.date < from || s.date > today || !ids.has(s.exerciseId)) continue;
    const value = setValue(m, s);
    if (value === null) continue;
    const day = days.get(s.date) ?? { best: -Infinity, capacity: -Infinity };
    day.best = Math.max(day.best, value);
    if (showsCapacity(m, s)) day.capacity = Math.max(day.capacity, value);
    days.set(s.date, day);
  }
  if (days.size === 0) return none(`No logged sets of these moves in the last ${m.windowDays} days.`);
  const unit = canonicalUnitOf(m);
  const ordered = [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
  const points = ordered.map(([date, d]) => ({
    date,
    value: rounded(unit, d.best),
    ...(d.capacity < d.best ? { capped: true as const } : {}),
  }));
  const best = Math.max(...ordered.map(([, d]) => d.best));
  const bestCapacity = Math.max(...ordered.map(([, d]) => d.capacity));
  const capacityDays = ordered.filter(([, d]) => d.capacity > -Infinity).length;
  return {
    points,
    current: rounded(unit, best),
    // Capped when no set that showed capacity reaches the best: the athlete can do at least this; a test would tell.
    evidence: bestCapacity < best ? "capped" : byCount(capacityDays),
  };
}

// ── Runs ────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface RunRow {
  id: string;
  date: string;
  start: string;
  durationSec: number;
  distanceM: number | null;
  hr: number | null;
  pace: number | null;
}

async function runsBetween(db: Db, userId: string, from: string, to: string): Promise<RunRow[]> {
  const rows = await db
    .select({
      id: activities.id,
      date: LOCAL_DATE,
      start: activities.startTime,
      durationSec: activities.durationSeconds,
      distanceM: activities.distanceMeters,
      hr: activities.avgHeartRate,
      pace: activities.avgPaceSecPerKm,
    })
    .from(activities)
    .where(
      and(
        eq(activities.userId, userId),
        eq(activities.sport, "run"),
        // The index's bound (UTC start), a day early for zones behind UTC; the local date decides.
        gte(activities.startTime, addDays(from, -1)),
        gte(LOCAL_DATE, from),
        lte(LOCAL_DATE, to),
      ),
    )
    .orderBy(asc(activities.startTime), asc(activities.id));
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
}

/** Days of the profile's race events (start to end, at most MAX_EVENT_DAYS) and the race hub's race date. */
export async function raceDaysOf(db: Db, userId: string, raceDate: string | null | undefined): Promise<Set<string>> {
  const [row] = await db
    .select({ events: sql<string | null>`${athleteProfiles.events}` })
    .from(athleteProfiles)
    .where(eq(athleteProfiles.userId, userId))
    .limit(1);
  const days = new Set<string>();
  if (raceDate) days.add(raceDate);
  let events: unknown = null;
  try {
    events = row?.events ? JSON.parse(row.events) : null;
  } catch {
    events = null;
  }
  for (const raw of Array.isArray(events) ? events : []) {
    const e = profileEventSchema.safeParse(raw);
    if (!e.success || e.data.kind !== "race") continue;
    const end = e.data.end ?? e.data.start;
    for (let d = e.data.start, n = 0; d <= end && n < MAX_EVENT_DAYS; d = addDays(d, 1), n += 1) days.add(d);
  }
  return days;
}

/** What the planned workout a run completed says of it: whether it had a document, and the distances of that
 * document's race-effort run items (0 where one has none). */
interface RunFacts {
  hasDoc: boolean;
  raceDistances: number[];
}

/** The distances of a stored document's race-effort run items, read by SQLite; null when it holds no readable v1 document. */
const RACE_DISTANCES = sql<string | null>`case when json_valid(${plannedWorkouts.workoutDoc}) and json_extract(${plannedWorkouts.workoutDoc}, '$.version') = 1 then (
  select json_group_array(coalesce(json_extract(ri.value, '$.target.distanceM'), 0))
  from json_each(${plannedWorkouts.workoutDoc}, '$.parts') rp, json_each(rp.value, '$.items') ri
  where json_extract(ri.value, '$.kind') = 'run' and json_extract(ri.value, '$.effort') = 'race'
) end`;

/** Each matched run's facts; a run with no match has none. */
async function runFacts(db: Db, userId: string, runs: readonly RunRow[]): Promise<Map<string, RunFacts>> {
  // The planned workouts these runs completed, scoped to this account: a match can only point at its own workouts.
  const docs = await db
    .select({ activityId: workoutCompletionMatches.activityId, races: RACE_DISTANCES })
    .from(workoutCompletionMatches)
    .innerJoin(plannedWorkouts, eq(plannedWorkouts.id, workoutCompletionMatches.workoutId))
    .where(
      and(
        inArray(workoutCompletionMatches.activityId, jsonList(runs.map((r) => r.id))),
        isNull(workoutCompletionMatches.undoneAt),
        eq(plannedWorkouts.userId, userId),
        isNotNull(plannedWorkouts.workoutDoc),
      ),
    );
  return new Map(
    docs.map((d) => {
      const races = parsedList(d.races, (x): x is number => typeof x === "number");
      return [d.activityId, { hasDoc: races !== null, raceDistances: races ?? [] }];
    }),
  );
}

function labelOf(f: RunFacts | undefined, raceDay: boolean, distanceM: number): NonNullable<KeyResultPoint["label"]> {
  const races = f?.raceDistances ?? [];
  if (races.length > 0) {
    if (raceDay) return "race";
    // A time trial only when a race-effort stretch covers the distance: a 5K effort inside a 10K run is no 10K test.
    return races.some((d) => d >= distanceM * (1 - COVER_TOLERANCE)) ? "test" : "training";
  }
  return !f?.hasDoc && raceDay ? "race" : "training";
}

const qualifiesFor = (m: Extract<KeyResultMeasure, { kind: "run_best" }>, r: RunRow): boolean =>
  r.distanceM !== null && r.distanceM >= m.distanceM && r.distanceM <= m.distanceM * (1 + RUN_OVER_DISTANCE_MAX) && r.durationSec > 0;

function measureRunBest(
  m: Extract<KeyResultMeasure, { kind: "run_best" }>,
  runs: readonly RunRow[],
  labels: { facts: ReadonlyMap<string, RunFacts>; raceDays: ReadonlySet<string> },
  today: string,
): Measured {
  const from = windowStart(today, m.windowDays);
  const points = runs
    .filter((r) => r.date >= from && qualifiesFor(m, r))
    .map((r) => ({
      date: r.date,
      value: Math.round((r.durationSec * m.distanceM) / r.distanceM!),
      label: labelOf(labels.facts.get(r.id), labels.raceDays.has(r.date), m.distanceM),
    }));
  if (points.length === 0) return none(`No run of this distance (or up to 10 % longer) in the last ${m.windowDays} days.`);
  return { points, current: Math.min(...points.map((p) => p.value)), evidence: byCount(points.length) };
}

function paceOf(r: RunRow): number | null {
  const pace = r.pace !== null && r.pace > 0 ? r.pace : r.distanceM !== null && r.distanceM > 0 ? r.durationSec / (r.distanceM / 1000) : null;
  return pace !== null && pace >= PACE_BOUNDS.fast && pace <= PACE_BOUNDS.slow ? pace : null;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function measurePaceAtHr(m: Extract<KeyResultMeasure, { kind: "pace_at_hr" }>, runs: readonly RunRow[], today: string): Measured {
  const from = windowStart(today, m.windowDays);
  const points: Array<{ date: string; value: number }> = [];
  for (const r of runs) {
    if (r.date < from || r.durationSec < m.minDurationSec || r.hr === null || r.hr < m.hrLow || r.hr > m.hrHigh) continue;
    const pace = paceOf(r);
    if (pace !== null) points.push({ date: r.date, value: Math.round(pace) });
  }
  if (points.length === 0) {
    return none(`No run long enough with its average heart rate in this range in the last ${m.windowDays} days.`);
  }
  const latest = points.slice(-CURRENT_PACE_RUNS).map((p) => p.value);
  return { points, current: Math.round(median(latest)), evidence: byCount(points.length) };
}

// ── Threshold pace ──────────────────────────────────────────────────────────────────────────────────────────────────

async function thresholdDays(db: Db, userId: string, from: string, to: string): Promise<Array<{ date: string; pace: number }>> {
  const rows = await db
    .select({ date: dailyHealth.date, pace: dailyHealth.thresholdPaceSecPerKm })
    .from(dailyHealth)
    .where(and(eq(dailyHealth.userId, userId), gte(dailyHealth.date, from), lte(dailyHealth.date, to), gt(dailyHealth.thresholdPaceSecPerKm, 0)))
    .orderBy(asc(dailyHealth.date));
  return rows.filter((r): r is { date: string; pace: number } => r.pace !== null);
}

function measureThreshold(
  m: Extract<KeyResultMeasure, { kind: "threshold_pace" | "predicted_time" }>,
  days: ReadonlyArray<{ date: string; pace: number }>,
  today: string,
): Measured {
  const from = windowStart(today, m.windowDays);
  const points: Array<{ date: string; value: number }> = [];
  for (const d of days) {
    if (d.date < from) continue;
    if (m.kind === "threshold_pace") {
      points.push({ date: d.date, value: Math.round(d.pace) });
      continue;
    }
    const prediction = racePrediction(d.pace, m.distanceM / 1000);
    if (prediction) points.push({ date: d.date, value: prediction.fastSeconds });
  }
  if (points.length === 0) return none(`No threshold pace from the watch in the last ${m.windowDays} days.`);
  return { points, current: points[points.length - 1]!.value, evidence: byCount(points.length) };
}

// ── Entry points ────────────────────────────────────────────────────────────────────────────────────────────────────

const earliest = (today: string, ms: ReadonlyArray<{ windowDays: number }>): string =>
  ms.map((m) => windowStart(today, m.windowDays)).sort()[0]!;

/** Measure many key results with one read per source for all of them. Answers in the order asked. */
export async function measureKeyResults(
  db: Db,
  userId: string,
  requests: readonly MeasureRequest[],
  ctx: MeasureContext,
): Promise<KeyResultProgress[]> {
  const today = ctx.today;
  const measures = requests.map((r) => r.measure);
  const strength = measures.filter((m): m is StrengthMeasure => m.kind === "hold_max" || m.kind === "best_set");
  const running = measures.filter((m): m is Extract<KeyResultMeasure, { kind: "run_best" | "pace_at_hr" }> => m.kind === "run_best" || m.kind === "pace_at_hr");
  const threshold = measures.filter(
    (m): m is Extract<KeyResultMeasure, { kind: "threshold_pace" | "predicted_time" }> => m.kind === "threshold_pace" || m.kind === "predicted_time",
  );
  const bests = running.filter((m): m is Extract<KeyResultMeasure, { kind: "run_best" }> => m.kind === "run_best");

  const [sets, runs, days] = await Promise.all([
    strength.length > 0 ? loggedSets(db, userId, earliest(today, strength), today, loggedIdsOf(strength.flatMap((m) => m.libraryIds))) : [],
    running.length > 0 ? runsBetween(db, userId, earliest(today, running), today) : [],
    threshold.length > 0 ? thresholdDays(db, userId, earliest(today, threshold), today) : [],
  ]);

  let labels = { facts: new Map<string, RunFacts>(), raceDays: new Set<string>() };
  if (bests.length > 0) {
    const candidates = runs.filter((r) => bests.some((m) => r.date >= windowStart(today, m.windowDays) && qualifiesFor(m, r)));
    if (candidates.length > 0) {
      const [facts, raceDays] = await Promise.all([runFacts(db, userId, candidates), raceDaysOf(db, userId, ctx.raceDate)]);
      labels = { facts, raceDays };
    }
  }

  return requests.map((request) => {
    const m = request.measure;
    switch (m.kind) {
      case "hold_max":
      case "best_set":
        return finish(request, measureStrength(m, sets, today));
      case "run_best":
        return finish(request, measureRunBest(m, runs, labels, today));
      case "pace_at_hr":
        return finish(request, measurePaceAtHr(m, runs, today));
      case "threshold_pace":
      case "predicted_time":
        return finish(request, measureThreshold(m, days, today));
      case "checkin":
        return finish(request, none("Check-in answers are not measured yet."));
      case "test":
        return finish(request, none("Test results are not measured yet."));
    }
  });
}

/** One key result's progress (`measureKeyResults` for one). */
export async function measureKeyResult(
  db: Db,
  userId: string,
  measure: KeyResultMeasure,
  ctx: MeasureContext & { unit?: KeyResultUnit },
): Promise<KeyResultProgress> {
  const [progress] = await measureKeyResults(db, userId, [{ measure, unit: ctx.unit }], ctx);
  return progress!;
}
