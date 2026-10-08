/**
 * What an activity row shows of its logged sets (Phase 2a+ Task 3, mocks §8):
 * the performed session linked to the activity, its done sets grouped by
 * exercise in the order done. Every source counts; when more than one session
 * names the activity, the athlete's own record (the app's save, then a watch
 * review, then an import) wins over the watch copy the ingest derived. A
 * session still being written (`PENDING_HASH`) is not there yet.
 *
 * This is the DTO boundary: exercise ids become words here and nowhere else
 * (`exerciseDisplayName`), and weights are put in the athlete's unit — a
 * weight already in that unit stays exactly as typed; a converted one is
 * rounded to the half unit (`weightInUnit`). The Activity feed reads the same
 * sets through `performedByActivity` (Phase 2d Task 2, ruling 2d-R4), which
 * keeps the athlete's own record exactly as typed and adds what the session
 * was: its source, mode, theme and check values.
 */
import { and, asc, eq, gt, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { conditionChecks, corosExercises, performedSessions, performedSets } from "@rg/database";
import { addDays, SESSION_MODES, weightInUnit, type SessionMode, type Weight, type WeightUnit } from "@rg/domain";
import { EXERCISES, isProfileId, profileById, THEMES, type ExerciseRecord } from "@rg/exercise-library";
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import { chunkIds, type Db } from "./db.js";
import { libraryIdsByKey } from "./coros-exercise-map.js";
import { COROS_EXERCISE_PREFIX, PENDING_HASH, WATCH_SOURCE } from "./watch-sets.js";

export interface LoggedSetDto {
  reps: number | null;
  seconds: number | null;
  /** In the athlete's weight unit (`performedByActivity`: the athlete's own record as typed); null for a bodyweight or timed set. */
  load: { v: number; u: WeightUnit } | null;
  side: "left" | "right" | null;
}

export interface LoggedExerciseDto {
  exerciseId: string;
  name: string;
  sets: LoggedSetDto[];
}

let libraryNames: Map<string, string> | null = null;

/** An exercise id as the athlete reads it: the library's name, COROS's English name for its key, or the key as sent. */
export function exerciseDisplayName(id: string): string {
  if (libraryNames === null) {
    libraryNames = new Map();
    for (const e of EXERCISES) {
      libraryNames.set(e.id, e.name);
      for (const legacy of e.legacyIds) if (!libraryNames.has(legacy)) libraryNames.set(legacy, e.name);
    }
  }
  const library = libraryNames.get(id);
  if (library) return library;
  if (id.startsWith(COROS_EXERCISE_PREFIX)) {
    const key = id.slice(COROS_EXERCISE_PREFIX.length);
    return COROS_EXERCISE_NAMES[key] ?? key;
  }
  return id;
}

/** Lower wins: the athlete's own record before the derived watch copy. */
const SOURCE_RANK: Record<string, number> = { app: 0, watch_review: 1, import: 2, [WATCH_SOURCE]: 3 };
const rank = (source: string): number => SOURCE_RANK[source] ?? 4;

/**
 * One session per activity: the athlete's own record (app, then watch review, then import) over the watch's derived
 * copy, the earliest written on a tie. Sessions naming no activity are not here. The feed and the Progress metrics
 * read one physical session once, through this one rule (Phase 2d Review Focus 3).
 */
export function sessionPerActivity<S extends { activityId: string | null; source: string; createdAt: string }>(
  sessions: readonly S[],
): Map<string, S> {
  const chosen = new Map<string, S>();
  for (const s of sessions) {
    if (!s.activityId) continue;
    const held = chosen.get(s.activityId);
    if (!held || rank(s.source) < rank(held.source) || (rank(s.source) === rank(held.source) && s.createdAt < held.createdAt)) {
      chosen.set(s.activityId, s);
    }
  }
  return chosen;
}

/** The session rows the feed needs: which one an activity shows, and what it was. */
async function sessionsOfActivities(db: Db, userId: string, activityIds: readonly string[]) {
  const sessions = (
    await Promise.all(
      chunkIds([...new Set(activityIds)]).map((ids) =>
        db
          .select({
            id: performedSessions.id,
            activityId: performedSessions.activityId,
            workoutId: performedSessions.workoutId,
            source: performedSessions.source,
            localDate: performedSessions.localDate,
            mode: performedSessions.mode,
            theme: performedSessions.theme,
            movesDone: performedSessions.movesDone,
            createdAt: performedSessions.createdAt,
          })
          .from(performedSessions)
          .where(
            and(
              eq(performedSessions.userId, userId),
              inArray(performedSessions.activityId, ids),
              // Mid-write: not there yet (PENDING_HASH).
              ne(performedSessions.payloadHash, PENDING_HASH),
            ),
          ),
      ),
    )
  ).flat();
  return sessionPerActivity(sessions);
}

/**
 * The done sets of these sessions (by activity), one row per exercise in the order each first appears, its sets in
 * the order done. A circuit (or a watch session, whose every round of a move is its own entry) repeats an exercise
 * across entries: those sets join the one row. `asTyped` says which sessions keep their weights exactly as typed;
 * the rest are put in `unit`.
 */
async function setsOfSessions(
  db: Db,
  activityBySession: ReadonlyMap<string, string>,
  unit: WeightUnit,
  asTyped: (sessionId: string) => boolean,
): Promise<Map<string, LoggedExerciseDto[]>> {
  const sets = (
    await Promise.all(
      chunkIds([...activityBySession.keys()]).map((ids) =>
        db
          .select()
          .from(performedSets)
          .where(and(inArray(performedSets.performedSessionId, ids), eq(performedSets.done, true)))
          .orderBy(asc(performedSets.performedSessionId), asc(performedSets.entryIndex), asc(performedSets.setIndex)),
      ),
    )
  ).flat();

  const out = new Map<string, LoggedExerciseDto[]>();
  const byExercise = new Map<string, Map<string, LoggedExerciseDto>>();
  for (const r of sets) {
    const activityId = activityBySession.get(r.performedSessionId)!;
    const list = out.get(activityId) ?? [];
    const rows = byExercise.get(activityId) ?? new Map<string, LoggedExerciseDto>();
    byExercise.set(activityId, rows);
    let exercise = rows.get(r.exerciseId);
    if (!exercise) {
      exercise = { exerciseId: r.exerciseId, name: exerciseDisplayName(r.exerciseId), sets: [] };
      rows.set(r.exerciseId, exercise);
      list.push(exercise);
    }
    const typed: Weight | null =
      r.loadValue !== null && r.loadValue > 0 && (r.loadUnit === "lb" || r.loadUnit === "kg")
        ? { v: r.loadValue, u: r.loadUnit }
        : null;
    exercise.sets.push({
      reps: r.reps,
      seconds: r.seconds,
      load: typed ? (asTyped(r.performedSessionId) ? typed : { v: weightInUnit(typed, unit), u: unit }) : null,
      side: r.side === "left" || r.side === "right" ? r.side : null,
    });
    out.set(activityId, list);
  }
  return out;
}

export async function loggedSetsByActivity(
  db: Db,
  userId: string,
  activityIds: readonly string[],
  unit: WeightUnit,
): Promise<Map<string, LoggedExerciseDto[]>> {
  const chosen = await sessionsOfActivities(db, userId, activityIds);
  const activityBySession = new Map([...chosen.values()].map((s) => [s.id, s.activityId!]));
  return setsOfSessions(db, activityBySession, unit, () => false);
}

// ── What a session was: the feed's row and expansion (Phase 2d Task 2, mocks §8) ─────────────────────────────

/** One profile's check values around a session, in the profile's own words (`check.label`). */
export interface SessionCheckDto {
  profileId: string;
  label: string;
  pre: number | null;
  post: number | null;
}

/** The performed session an activity shows (the one `sessionPerActivity` picks). */
export interface PerformedSummaryDto {
  source: "app" | "watch_review" | "import" | "watch";
  mode: SessionMode | null;
  /** The theme's name. */
  theme: string | null;
  checks: SessionCheckDto[];
  /** Moves played with no set logged (mobility, breathing, holds kept by time): how many, and their time. */
  played: { moves: number; seconds: number } | null;
}

export interface PerformedByActivity {
  /** Null when no set was logged (a session of played-only moves). */
  logged: LoggedExerciseDto[] | null;
  performed: PerformedSummaryDto;
}

/** A `condition_checks` row as the pairing reads it. */
export interface CheckRowLike {
  id: string;
  profileId: string;
  kind: string;
  value: number | null;
  feelingOff: boolean;
  localDate: string;
  at: string;
  performedSessionId: string | null;
  workoutId: string | null;
}

/**
 * Each session's readings per profile — the engine's own rule (`toHistory` in engine-inputs.ts): a session's own
 * `pre`/`post` rows, and the `pre` its session sheet recorded for the same slot and day before the save (the save
 * does not record it twice), for a profile the session has no `pre` of its own. Read in time order, the later row
 * wins. Daily checks are not a session's.
 */
export function readingsBySession(
  sessions: ReadonlyArray<{ id: string; workoutId: string | null; localDate: string }>,
  rows: readonly CheckRowLike[],
): Map<string, Map<string, { pre: number | null; post: number | null }>> {
  const ordered = [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const linked = new Map<string, CheckRowLike[]>();
  const bySlotDay = new Map<string, CheckRowLike[]>();
  const slotDay = (workoutId: string, date: string) => `${workoutId}\u0000${date}`;
  for (const c of ordered) {
    if (c.kind !== "pre" && c.kind !== "post") continue;
    if (c.performedSessionId !== null) linked.set(c.performedSessionId, [...(linked.get(c.performedSessionId) ?? []), c]);
    else if (c.workoutId !== null && c.kind === "pre") {
      const key = slotDay(c.workoutId, c.localDate);
      bySlotDay.set(key, [...(bySlotDay.get(key) ?? []), c]);
    }
  }
  const out = new Map<string, Map<string, { pre: number | null; post: number | null }>>();
  for (const s of sessions) {
    const own = linked.get(s.id) ?? [];
    const sheet = s.workoutId === null ? [] : (bySlotDay.get(slotDay(s.workoutId, s.localDate)) ?? []);
    const extra = sheet.filter((c) => !own.some((o) => o.kind === "pre" && o.profileId === c.profileId));
    const byProfile = new Map<string, { pre: number | null; post: number | null }>();
    for (const c of [...extra, ...own]) {
      const r = byProfile.get(c.profileId) ?? { pre: null, post: null };
      if (c.kind === "pre") r.pre = c.value;
      else r.post = c.value;
      byProfile.set(c.profileId, r);
    }
    out.set(s.id, byProfile);
  }
  return out;
}

const CHECK_COLUMNS = {
  id: conditionChecks.id,
  profileId: conditionChecks.profileId,
  kind: conditionChecks.kind,
  value: conditionChecks.value,
  feelingOff: conditionChecks.feelingOff,
  localDate: conditionChecks.localDate,
  at: conditionChecks.at,
  performedSessionId: conditionChecks.performedSessionId,
  workoutId: conditionChecks.workoutId,
};

/** The check rows these sessions may own: their own pre/post rows, and their slots' sheet pre-checks. */
export async function checkRowsOfSessions(
  db: Db,
  userId: string,
  sessions: ReadonlyArray<{ id: string; workoutId: string | null }>,
): Promise<CheckRowLike[]> {
  const ids = sessions.map((s) => s.id);
  const slots = [...new Set(sessions.map((s) => s.workoutId).filter((w): w is string => w !== null))];
  const [linked, sheet] = await Promise.all([
    Promise.all(
      chunkIds(ids).map((chunk) =>
        db
          .select(CHECK_COLUMNS)
          .from(conditionChecks)
          .where(
            and(
              eq(conditionChecks.userId, userId),
              inArray(conditionChecks.kind, ["pre", "post"]),
              inArray(conditionChecks.performedSessionId, chunk),
            ),
          ),
      ),
    ),
    Promise.all(
      chunkIds(slots).map((chunk) =>
        db
          .select(CHECK_COLUMNS)
          .from(conditionChecks)
          .where(
            and(
              eq(conditionChecks.userId, userId),
              eq(conditionChecks.kind, "pre"),
              isNull(conditionChecks.performedSessionId),
              inArray(conditionChecks.workoutId, chunk),
            ),
          ),
      ),
    ),
  ]);
  return [...linked.flat(), ...sheet.flat()];
}

let themeNames: Map<string, string> | null = null;
const themeName = (id: string | null): string | null =>
  id ? ((themeNames ??= new Map(THEMES.map((t) => [t.id, t.name]))).get(id) ?? null) : null;
const MODES: ReadonlySet<string> = new Set(SESSION_MODES);
const SOURCES: ReadonlySet<string> = new Set(["app", "watch_review", "import", WATCH_SOURCE]);

/**
 * What the Activity feed shows of each activity's performed session (Phase 2d Task 2): its logged sets — the
 * athlete's own record exactly as typed, the watch's derived copy in the athlete's unit as 2a+ shows it — and what
 * the session was: its source, mode, theme, check values (labelled by the profile registry; a profile it does not
 * know is left out) and the moves played without a set. Activities with no performed session are not here.
 */
export async function performedByActivity(
  db: Db,
  userId: string,
  activityIds: readonly string[],
  unit: WeightUnit,
): Promise<Map<string, PerformedByActivity>> {
  const chosen = [...(await sessionsOfActivities(db, userId, activityIds)).values()];
  if (chosen.length === 0) return new Map();
  const activityBySession = new Map(chosen.map((s) => [s.id, s.activityId!]));
  const own = new Set(chosen.filter((s) => s.source !== WATCH_SOURCE).map((s) => s.id));
  const [logged, checkRows] = await Promise.all([
    setsOfSessions(db, activityBySession, unit, (id) => own.has(id)),
    checkRowsOfSessions(db, userId, chosen),
  ]);
  const readings = readingsBySession(chosen, checkRows);
  const out = new Map<string, PerformedByActivity>();
  for (const s of chosen) {
    const sets = logged.get(s.activityId!) ?? null;
    const checks: SessionCheckDto[] = [...(readings.get(s.id) ?? new Map<string, { pre: number | null; post: number | null }>()).entries()]
      .filter(([profileId, r]) => isProfileId(profileId) && (r.pre !== null || r.post !== null))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([profileId, r]) => ({ profileId, label: profileById(profileId).check.label, pre: r.pre, post: r.post }));
    const loggedIds = new Set((sets ?? []).map((e) => e.exerciseId));
    const playedOnly = (Array.isArray(s.movesDone) ? s.movesDone : []).filter((m) => !loggedIds.has(m.exerciseId));
    out.set(s.activityId!, {
      logged: sets,
      performed: {
        source: (SOURCES.has(s.source) ? s.source : WATCH_SOURCE) as PerformedSummaryDto["source"],
        mode: s.mode !== null && MODES.has(s.mode) ? (s.mode as SessionMode) : null,
        theme: themeName(s.theme),
        checks,
        played:
          playedOnly.length > 0
            ? { moves: playedOnly.length, seconds: playedOnly.reduce((n, m) => n + Math.max(0, m.seconds), 0) }
            : null,
      },
    });
  }
  return out;
}

/**
 * A plan's exercises (by COROS originId) → the heaviest set logged for each,
 * per plan week, in kg (Phase 2a+, for `liftProgressions`' `actual`). A plan
 * exercise matches the logged sets of its COROS catalog key (`coros:<key>`,
 * what the watch logs) and of the library move that maps to it exactly (what
 * the app logs). Done, loaded sets only; dates are the sessions' local days,
 * week 1 starting on `weekOne`.
 */
export async function loggedTopKgByWeek(
  db: Db,
  userId: string,
  plan: { weekOne: string; weeks: number; originIds: readonly string[]; library?: readonly ExerciseRecord[] },
): Promise<Map<string, Map<number, number>>> {
  const out = new Map<string, Map<number, number>>();
  const origins = [...new Set(plan.originIds)];
  if (origins.length === 0 || plan.weeks <= 0) return out;
  const originsOf = new Map<string, string[]>();
  const claim = (exerciseId: string, originId: string) =>
    originsOf.set(exerciseId, [...(originsOf.get(exerciseId) ?? []), originId]);
  // The catalog row names the plan exercise's T-code: the watch logs `coros:<key>`, and the library move mapped to
  // that key is what the app (and, since Phase 3 Task 2, the watch for a mapped key) logs.
  const byKey = libraryIdsByKey(plan.library);
  for (const batch of chunkIds(origins)) {
    const rows = await db
      .select({ id: corosExercises.id, name: corosExercises.name })
      .from(corosExercises)
      .where(inArray(corosExercises.id, batch));
    for (const r of rows) {
      claim(`${COROS_EXERCISE_PREFIX}${r.name}`, r.id);
      const libraryId = byKey.get(r.name);
      if (libraryId) claim(libraryId, r.id);
    }
  }
  if (originsOf.size === 0) return out;

  const last = addDays(plan.weekOne, plan.weeks * 7 - 1);
  const rows = (
    await Promise.all(
      chunkIds([...originsOf.keys()]).map((ids) =>
        db
          .select({
            exerciseId: performedSets.exerciseId,
            localDate: performedSessions.localDate,
            kg: sql<number>`max(${performedSets.loadKg})`,
          })
          .from(performedSets)
          .innerJoin(performedSessions, eq(performedSessions.id, performedSets.performedSessionId))
          .where(
            and(
              eq(performedSessions.userId, userId),
              ne(performedSessions.payloadHash, PENDING_HASH),
              gte(performedSessions.localDate, plan.weekOne),
              lte(performedSessions.localDate, last),
              eq(performedSets.done, true),
              gt(performedSets.loadKg, 0),
              inArray(performedSets.exerciseId, ids),
            ),
          )
          .groupBy(performedSets.exerciseId, performedSessions.localDate),
      ),
    )
  ).flat();
  const start = Date.parse(`${plan.weekOne}T00:00:00Z`);
  for (const r of rows) {
    const week = Math.floor((Date.parse(`${r.localDate}T00:00:00Z`) - start) / (7 * 86_400_000)) + 1;
    for (const origin of originsOf.get(r.exerciseId) ?? []) {
      const weeks = out.get(origin) ?? new Map<number, number>();
      weeks.set(week, Math.max(weeks.get(week) ?? 0, r.kg));
      out.set(origin, weeks);
    }
  }
  for (const weeks of out.values()) {
    const sorted = [...weeks.entries()].sort((a, b) => a[0] - b[0]);
    weeks.clear();
    for (const [w, kg] of sorted) weeks.set(w, kg);
  }
  return out;
}
