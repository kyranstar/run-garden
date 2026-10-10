/**
 * KEY RESULTS MEASURED FROM LOGGED DATA (programme spec §3.6 and its Amendment A; principles §5.2, §2.9 honesty).
 *
 * Every measure reads only what it needs, scoped to the account, in its window (today and the `windowDays − 1` days
 * before it, by the athlete's local date), and answers `KeyResultProgress`: the current value, the series, how many
 * points, and how far the current value can be trusted (`evidence`). Many measures are read together
 * (`measureKeyResults`): one read per source for all of them, so an objective's progress costs the same few
 * statements however many key results it holds.
 *
 * RULES
 * - hold_max: the longest done set (`performed_sets.seconds`) of the moves, app and watch sessions alike. best_set:
 *   per done, loaded set — `e1rm` = kg × (1 + reps / 30) (Epley; a single is its own load), `load_at_reps` = the
 *   heaviest kg lifted for at least `reps`, `reps_at_load` = the most reps at `loadKg` or more (within 0.05 kg). Logs
 *   use `load_kg`, so sets typed in lb and kg compare. One point per day: the day's best.
 * - CAPACITY. The player stops a timed hold at its prescription and a set done exactly as prescribed is no max, so a
 *   set shows capacity only when its item was a test (`dose.max` in the session's document) or the logged value went
 *   past the prescription (seconds past `holdSec`; reps past the reps, or load past the load by more than 0.05 kg).
 *   The prescription is the session's document — its build's (`session_builds.workout_doc`), else its planned row's
 *   (`planned_workouts.workout_doc`) — and for a move the document does not hold, the build's own steps
 *   (`payload.build.steps`: a timed step's seconds, a set step's target reps and weight). An app session's build is
 *   its `build_id`; a watch session's is its workout's latest locked build (the one sent). A set whose prescription
 *   is unknown is not capacity — nothing says it was a max. `current` is the best of every set (each is at least what
 *   the athlete can do); evidence is `capped` when no capacity set reaches it, else `measured` (three or more days
 *   with capacity) or `sparse`.
 * - One physical session counts once: an activity's sessions go through `sessionPerActivity` (the athlete's own
 *   record over the watch's copy); a session still being written (`PENDING_HASH`) is not there yet.
 * - run_best: COROS runs (`sport = run`) at least `distanceM` long and at most 10 % longer, each one's time
 *   (`duration_seconds`) scaled to exactly `distanceM`; a longer run is skipped (its pace over the distance is not
 *   its pace at it). A point per run; the current is the fastest. Each point is labelled from the planned workout it
 *   completed (`workout_completion_matches`): a run item at race effort in its document is a `race` on a race day (a
 *   profile event of kind race, or the race hub's race date) and a `test` (a time trial) on any other; a run on a race
 *   day with no document is the race; the rest is `training`.
 * - pace_at_hr: runs at least `minDurationSec` long whose average heart rate is in [hrLow, hrHigh], their pace
 *   (`avg_pace_sec_per_km`, else time over distance) per run; the current is the median of the latest three.
 * - threshold_pace: the watch's threshold pace per day (`daily_health`); predicted_time: the race hub's prediction
 *   (`racePrediction`, its fast edge — Riegel from the hour at threshold) for `distanceM` from each day's threshold
 *   pace. The current is the latest day's.
 * - checkin and test: not measured until Stage 4 adds the questions and the tests.
 * - Runs, threshold days: three or more points are `measured`, one or two `sparse`, none `none` with a `missing` note.
 */
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
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
  parseStoredWorkoutDoc,
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
  type WorkoutDoc,
} from "@rg/domain";
import { EXERCISES, type ExerciseRecord } from "@rg/exercise-library";
import { loadPreferences } from "./calendar-sync.js";
import { chunkIds, type Db } from "./db.js";
import { sessionPerActivity } from "./logged-sets.js";
import { PENDING_HASH } from "./watch-sets.js";

/** Points that show capacity (or runs, or days) before a current value is `measured` rather than `sparse`. */
export const MEASURED_MIN_POINTS = 3;
/** How much longer than the distance a run may be and still be scaled to it. */
export const RUN_OVER_DISTANCE_MAX = 0.1;
/** The latest runs whose median pace is pace_at_hr's current value. */
const CURRENT_PACE_RUNS = 3;
/** Paces outside this (s/km) are a broken record, not a run. */
const PACE_BOUNDS = { fast: 120, slow: 1800 } as const;
/** Days a race event spreads over at most when labelling runs (a stage race, a ski week). */
const MAX_EVENT_DAYS = 21;
/** IN-list chunk for the sets read: its window subquery binds four more. */
const SET_ID_CHUNK = 80;

export interface MeasureContext {
  /** The athlete's today (LocalDate): every window ends on it. */
  today: string;
  /** Race days for run_best's labels; read from the profile's race events and the race hub's date when absent. */
  raceDays?: readonly string[];
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

/** Every id a logged set of these moves may carry: each move's id and the ids it had. */
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
const unique = <T>(xs: readonly (T | null | undefined)[]): T[] => [...new Set(xs.filter((x): x is T => x !== null && x !== undefined))];
const flat = async <T>(parts: Array<Promise<T[]>>): Promise<T[]> => (await Promise.all(parts)).flat();

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
  /** The reps × load show capacity. */
  setCapacity: boolean;
}

interface SessionRow {
  id: string;
  activityId: string | null;
  workoutId: string | null;
  buildId: string | null;
  source: string;
  localDate: string;
  createdAt: string;
}

/** A build step, as the steps column below reads it: [exerciseId, kind, seconds, target reps, target weight v, u]. */
type CompactStep = [string | null, string | null, number | null, number | null, number | null, string | null];

interface Prescribed {
  doc: WorkoutDoc | null;
  steps: CompactStep[];
}

/** What a session asked of one move: a test, or the most it prescribed (undefined where it said nothing). */
interface Prescription {
  test: boolean;
  holdSec?: number;
  reps?: number;
  kg?: number;
}

/**
 * The timed and set steps of a stored build, read by SQLite (the payload is 100+ KB of JSON: the Worker never parses
 * it). A payload that is not JSON reads as no steps.
 */
const BUILD_STEPS = sql<string | null>`case when json_valid(${sessionBuilds.payload}) then (
  select json_group_array(json_array(
    json_extract(st.value, '$.exerciseId'), json_extract(st.value, '$.kind'), json_extract(st.value, '$.seconds'),
    json_extract(st.value, '$.target.reps'), json_extract(st.value, '$.target.w.v'), json_extract(st.value, '$.target.w.u')))
  from json_each(${sessionBuilds.payload}, '$.build.steps') st
  where json_extract(st.value, '$.kind') in ('timed', 'set')
) end`;

const buildColumns = {
  id: sessionBuilds.id,
  workoutId: sessionBuilds.workoutId,
  version: sessionBuilds.version,
  // Raw text: a damaged document must read as none, not throw in the driver's JSON decode.
  doc: sql<string | null>`${sessionBuilds.workoutDoc}`,
  steps: BUILD_STEPS,
};

function parseSteps(text: string | null): CompactStep[] {
  if (!text) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((s): s is CompactStep => Array.isArray(s) && s.length === 6) : [];
  } catch {
    return [];
  }
}

/** Each planned workout's document (rows without one are not read). */
async function plannedDocs(db: Db, userId: string, workoutIds: readonly string[]): Promise<Map<string, WorkoutDoc>> {
  const rows = await flat(
    chunkIds([...workoutIds]).map((ids) =>
      db
        .select({ id: plannedWorkouts.id, doc: sql<string | null>`${plannedWorkouts.workoutDoc}` })
        .from(plannedWorkouts)
        .where(and(eq(plannedWorkouts.userId, userId), inArray(plannedWorkouts.id, ids), isNotNull(plannedWorkouts.workoutDoc))),
    ),
  );
  const out = new Map<string, WorkoutDoc>();
  for (const r of rows) {
    const doc = parseStoredWorkoutDoc(r.doc);
    if (doc) out.set(r.id, doc);
  }
  return out;
}

/** What prescribed each session: its build's document and steps, else its planned row's document. */
async function prescribedBy(db: Db, userId: string, sessions: readonly SessionRow[]): Promise<Map<string, Prescribed>> {
  const buildIds = unique(sessions.map((s) => s.buildId));
  const sentWorkouts = unique(sessions.map((s) => (s.buildId === null ? s.workoutId : null)));
  const [byId, locked, planned] = await Promise.all([
    flat(
      chunkIds(buildIds).map((ids) =>
        db.select(buildColumns).from(sessionBuilds).where(and(eq(sessionBuilds.userId, userId), inArray(sessionBuilds.id, ids))),
      ),
    ),
    flat(
      chunkIds(sentWorkouts).map((ids) =>
        db
          .select(buildColumns)
          .from(sessionBuilds)
          .where(and(eq(sessionBuilds.userId, userId), inArray(sessionBuilds.workoutId, ids), isNotNull(sessionBuilds.lockedAt))),
      ),
    ),
    plannedDocs(db, userId, unique(sessions.map((s) => s.workoutId))),
  ]);
  const builds = new Map(byId.map((b) => [b.id, b]));
  // A watch session played what was sent: its workout's latest locked build.
  const sent = new Map<string, (typeof locked)[number]>();
  for (const b of locked) {
    const held = sent.get(b.workoutId);
    if (!held || b.version > held.version) sent.set(b.workoutId, b);
  }
  const out = new Map<string, Prescribed>();
  for (const s of sessions) {
    const b = s.buildId !== null ? builds.get(s.buildId) : s.workoutId !== null ? sent.get(s.workoutId) : undefined;
    const doc = parseStoredWorkoutDoc(b?.doc ?? null) ?? (s.workoutId !== null ? planned.get(s.workoutId) ?? null : null);
    out.set(s.id, { doc, steps: parseSteps(b?.steps ?? null) });
  }
  return out;
}

const maxOf = (xs: readonly (number | undefined)[]): number | undefined => {
  const vs = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  return vs.length > 0 ? Math.max(...vs) : undefined;
};

/** What the session asked of this move: its document's items for it, else its build's steps; null when neither says. */
function prescriptionFor(p: Prescribed | undefined, exerciseId: string): Prescription | null {
  if (!p) return null;
  const items = (p.doc?.parts ?? [])
    .flatMap((part) => part.items)
    .filter((i): i is Extract<typeof i, { kind: "exercise" }> => i.kind === "exercise" && canonicalId(i.libraryId) === exerciseId);
  if (items.length > 0) {
    if (items.some((i) => i.dose.max === true)) return { test: true };
    return {
      test: false,
      holdSec: maxOf(items.map((i) => i.dose.holdSec)),
      reps: maxOf(items.map((i) => (typeof i.dose.reps === "number" ? i.dose.reps : i.dose.reps?.max))),
      kg: maxOf(items.map((i) => (i.dose.load === "bodyweight" ? 0 : i.dose.load?.kg))),
    };
  }
  const steps = p.steps.filter((s) => typeof s[0] === "string" && canonicalId(s[0]) === exerciseId);
  if (steps.length === 0) return null;
  const weight = (s: CompactStep): number | undefined =>
    typeof s[4] === "number" && (s[5] === "kg" || s[5] === "lb") ? toKg({ v: s[4], u: s[5] }) : undefined;
  return {
    test: false,
    holdSec: maxOf(steps.filter((s) => s[1] === "timed").map((s) => s[2] ?? undefined)),
    reps: maxOf(steps.filter((s) => s[1] === "set").map((s) => s[3] ?? undefined)),
    kg: maxOf(steps.filter((s) => s[1] === "set").map(weight)),
  };
}

function holdShowsCapacity(seconds: number | null, p: Prescription | null): boolean {
  if (!p || seconds === null) return false;
  return p.test || (p.holdSec !== undefined && seconds > p.holdSec);
}

function setShowsCapacity(reps: number | null, kg: number | null, p: Prescription | null): boolean {
  if (!p) return false;
  if (p.test) return true;
  const moreReps = reps !== null && p.reps !== undefined && reps > p.reps;
  const moreLoad = kg !== null && p.kg !== undefined && kg > p.kg + SAME_WEIGHT_KG;
  return moreReps || moreLoad;
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
  const [sessionRows, setRows] = await Promise.all([
    db
      .select({
        id: performedSessions.id,
        activityId: performedSessions.activityId,
        workoutId: performedSessions.workoutId,
        buildId: performedSessions.buildId,
        source: performedSessions.source,
        localDate: performedSessions.localDate,
        createdAt: performedSessions.createdAt,
      })
      .from(performedSessions)
      .where(inWindow),
    flat(
      chunkIds([...exerciseIds], SET_ID_CHUNK).map((ids) =>
        db
          .select({
            sessionId: performedSets.performedSessionId,
            exerciseId: performedSets.exerciseId,
            reps: performedSets.reps,
            seconds: performedSets.seconds,
            kg: performedSets.loadKg,
          })
          .from(performedSets)
          .where(
            and(
              inArray(performedSets.exerciseId, ids),
              eq(performedSets.done, true),
              inArray(performedSets.performedSessionId, db.select({ id: performedSessions.id }).from(performedSessions).where(inWindow)),
            ),
          ),
      ),
    ),
  ]);
  // One physical session once: the activity's own record over the watch's copy (the feed's rule).
  const chosen = new Map<string, SessionRow>(
    [...sessionPerActivity(sessionRows).values(), ...sessionRows.filter((s) => !s.activityId)].map((s) => [s.id, s]),
  );
  const kept = setRows.filter((r) => chosen.has(r.sessionId));
  const prescribed = await prescribedBy(db, userId, unique(kept.map((r) => r.sessionId)).map((id) => chosen.get(id)!));
  return kept.map((r) => {
    const exerciseId = canonicalId(r.exerciseId);
    const p = prescriptionFor(prescribed.get(r.sessionId), exerciseId);
    return {
      date: chosen.get(r.sessionId)!.localDate,
      exerciseId,
      reps: r.reps,
      seconds: r.seconds,
      kg: r.kg,
      holdCapacity: holdShowsCapacity(r.seconds, p),
      setCapacity: setShowsCapacity(r.reps, r.kg, p),
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
      if (kg <= 0) return null;
      return reps === 1 ? kg : kg * (1 + reps / 30);
    case "load_at_reps":
      return kg > 0 && reps >= (m.reps ?? 1) ? kg : null;
    case "reps_at_load":
      return kg >= (m.loadKg ?? 0) - SAME_WEIGHT_KG ? reps : null;
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
    if (m.kind === "hold_max" ? s.holdCapacity : s.setCapacity) day.capacity = Math.max(day.capacity, value);
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
export async function raceDaysOf(db: Db, userId: string): Promise<string[]> {
  const [[row], prefs] = await Promise.all([
    db
      .select({ events: sql<string | null>`${athleteProfiles.events}` })
      .from(athleteProfiles)
      .where(eq(athleteProfiles.userId, userId))
      .limit(1),
    loadPreferences(db, userId),
  ]);
  const days = new Set<string>();
  if (prefs.raceDate) days.add(prefs.raceDate);
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
  return [...days];
}

const hasRaceEffort = (doc: WorkoutDoc): boolean => doc.parts.some((p) => p.items.some((i) => i.kind === "run" && i.effort === "race"));

/** race | test | training for each run, from the planned workout each one completed (see the module comment). */
async function runLabels(db: Db, userId: string, runs: readonly RunRow[], raceDays: ReadonlySet<string>): Promise<Map<string, KeyResultPoint["label"]>> {
  const matches = await flat(
    chunkIds(runs.map((r) => r.id)).map((ids) =>
      db
        .select({ activityId: workoutCompletionMatches.activityId, workoutId: workoutCompletionMatches.workoutId })
        .from(workoutCompletionMatches)
        .where(and(inArray(workoutCompletionMatches.activityId, ids), isNull(workoutCompletionMatches.undoneAt))),
    ),
  );
  const workoutOf = new Map(matches.map((m) => [m.activityId, m.workoutId]));
  // The planned rows are read scoped to this account: a match can only point at this account's workout.
  const docs = await plannedDocs(db, userId, unique(matches.map((m) => m.workoutId)));
  const out = new Map<string, KeyResultPoint["label"]>();
  for (const r of runs) {
    const workoutId = workoutOf.get(r.id);
    const doc = workoutId !== undefined ? docs.get(workoutId) : undefined;
    const raceDay = raceDays.has(r.date);
    if (doc && hasRaceEffort(doc)) out.set(r.id, raceDay ? "race" : "test");
    else out.set(r.id, !doc && raceDay ? "race" : "training");
  }
  return out;
}

const qualifiesFor = (m: Extract<KeyResultMeasure, { kind: "run_best" }>, r: RunRow): boolean =>
  r.distanceM !== null && r.distanceM >= m.distanceM && r.distanceM <= m.distanceM * (1 + RUN_OVER_DISTANCE_MAX) && r.durationSec > 0;

function measureRunBest(
  m: Extract<KeyResultMeasure, { kind: "run_best" }>,
  runs: readonly RunRow[],
  labels: ReadonlyMap<string, KeyResultPoint["label"]>,
  today: string,
): Measured {
  const from = windowStart(today, m.windowDays);
  const points = runs
    .filter((r) => r.date >= from && qualifiesFor(m, r))
    .map((r) => ({ date: r.date, value: Math.round((r.durationSec * m.distanceM) / r.distanceM!), label: labels.get(r.id) ?? ("training" as const) }));
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

  let labels = new Map<string, KeyResultPoint["label"]>();
  if (bests.length > 0) {
    const candidates = runs.filter((r) => bests.some((m) => r.date >= windowStart(today, m.windowDays) && qualifiesFor(m, r)));
    if (candidates.length > 0) {
      const raceDays = new Set(ctx.raceDays ?? (await raceDaysOf(db, userId)));
      labels = await runLabels(db, userId, candidates, raceDays);
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
