/**
 * WHAT A RANGE OF DAYS DID FOR THE BODY — the one exposure computation, shared by the coach's `read_balance` (Stage 3
 * spec §4; principles §2.3, §2.4) and Growth's body map (`GET /api/growth/body`, the new shape §7).
 *
 * `derivePerformed` (@rg/workout, the same rules a document's balance is computed with) over every session and
 * activity in the range, summed: the contraction balance, the exposure by region and muscle (in working sets), each
 * session's working sets per move, and for each of the athlete's focus areas the last day it was trained and its working
 * sets (each set of a move that trains it, once). One physical session counts once (`sessionsOnce`); a session's
 * played-only moves count as played, once. A watch move counts as the library move its key maps to; one the library
 * has no record for is kept by COROS's own name, with the sessions that logged it — never dropped in silence.
 *
 * RUNS LOAD THE LEGS (audit I5): a run is no working set, so the regions are the sessions' alone; the runs in the range
 * are kept apart (`ranDays`, `lastRun`) for the caller to say what they loaded (`RUN_REGIONS`).
 *
 * Two statements: the athlete with the focus areas, then the range in one read (`readTagged`). With `derive: false`
 * (Growth's body map) the range's sets are read as one row a session's move — its working sets and its longest hold,
 * counted by SQLite — in place of a row a set: a busy season holds thousands of sets (the integrated review, I2).
 */
import { sql, type SQL } from "drizzle-orm";
import { athleteProfiles, performedSessions, performedSets } from "@rg/database";
import { focusAreaSchema, type FocusArea } from "@rg/domain";
import { EXERCISES, MUSCLE_REGION, REGIONS, type MuscleId, type Region } from "@rg/exercise-library";
import { derivePerformed, type BalanceProfile, type PerformedInput } from "@rg/workout";
import type { Db } from "./db.js";
import { watchMove } from "./logged-sets.js";
import { parsedArray, readAthlete, readTagged, type Athlete } from "./design-tools/read-common.js";
import {
  activitiesAround,
  activityRows,
  doneTerms,
  sessionRows,
  sessionsOnce,
  sessionsWhere,
  setRows,
  type SessionRow,
  type SetRow,
} from "./design-tools/read-sessions.js";

/** The statements one `readExposure` makes. */
export const EXPOSURE_STATEMENTS = 2;

const LIBRARY = new Set(EXERCISES.map((e) => e.id));
const BY_ID = new Map(EXERCISES.map((e) => [e.id, e]));

/**
 * WHAT A RUN WORKS — the one list (the new shape, the lead's ruling of 2026-10-18 and its amendment): the hips, the
 * glutes, the quads, the hamstrings, the calves, and the ankles and feet — which a run loads hardest of all — as the
 * library's region ids, head to foot. `read_balance` (its `fromRuns`, what it never calls untrained), Growth's body map
 * (whose calves are the lower leg: calves, ankles and feet) and Today's body check all read it from here.
 */
export const RUN_REGIONS = ["hips", "glutes", "quads", "hamstrings", "calves", "ankles", "feet"] as const satisfies readonly Region[];

/** What a library move names — its regions and muscles — read once a move (a focus area asks it of every set). */
const NAMES = new Map<string, ReadonlySet<string>>();
function namesOf(exerciseId: string): ReadonlySet<string> | null {
  const known = NAMES.get(exerciseId);
  if (known) return known;
  const rec = BY_ID.get(exerciseId);
  if (!rec) return null;
  const says = new Set<string>([...rec.regions, ...rec.muscles.primary, ...rec.muscles.secondary]);
  NAMES.set(exerciseId, says);
  return says;
}
/** The region a focus area's ref names: itself, or the region its muscle sits under. */
export const regionOf = (ref: string): string | undefined => ((REGIONS as readonly string[]).includes(ref) ? ref : MUSCLE_REGION[ref as MuscleId]);

export interface Exposure {
  athlete: Athlete;
  focus: FocusArea[];
  /** One per physical session, in the range. */
  sessions: SessionRow[];
  /** Every done set of the range's sessions, as logged (a watch key not yet read as its library move). */
  sets: SetRow[];
  /** Activities in the range no session logged: runs, and every other sport. */
  runs: number;
  other: number;
  /** Nothing logged at all: no session, no run, no other activity. */
  nothing: boolean;
  balance: BalanceProfile;
  /** Region → working sets of the moves that load it (sessions only). */
  regions: Map<string, number>;
  /** Muscle → working sets, a secondary muscle counting half. */
  muscles: Map<string, number>;
  /** Each session's working sets per library move (a move played without a set: one), by the session's day. */
  byMove: Array<{ exerciseId: string; date: string; sets: number }>;
  /**
   * With `derive: false`, in place of `sets`: each session's logged moves, one row each — the library move, its working
   * sets and its longest hold in seconds (a set held a side at a time at its shorter side; null with none held).
   */
  moves: Array<{ session: string; exerciseId: string; sets: number; held: number | null }>;
  /** Focus area id → the last day a session trained it and its working sets. */
  focusSeen: Map<string, { last: string | null; sets: number }>;
  /** Every run's day in the range (a session's own run too). */
  ranDays: string[];
  lastRun: string | null;
  /** Logged move ids the library does not know (not watch keys). */
  unknown: Set<string>;
  /** Watch moves the library has no record for: COROS's name → the sessions that logged it. */
  watchUnknown: Map<string, Set<string>>;
}

/**
 * The range's done sets as one row a session's move (`readTagged`'s `m`): its working sets — a set done a side at a
 * time (a row per side under one set number) is one — and its longest hold, each set at its shorter side.
 */
function movesTerm(scope: SQL): SQL {
  const ps = performedSessions;
  const x = performedSets;
  const ids = sql`(select ${ps.id} from ${ps} where ${scope})`;
  return sql`select 'm' as t, json_object('s', s, 'ex', ex, 'n', n, 'held', held) as j from (
      select s, ex, count(*) as n, max(held) as held from (
        select ${x.performedSessionId} as s, ${x.exerciseId} as ex, min(case when ${x.seconds} > 0 then ${x.seconds} end) as held
        from ${x} where ${x.done} = 1 and ${x.performedSessionId} in ${ids}
        group by ${x.performedSessionId}, ${x.exerciseId}, ${x.entryIndex}, ${x.setIndex}
      ) group by s, ex
    )`;
}

function moveRows(raw: Array<Record<string, unknown>> = []): Array<{ session: string; logged: string; sets: number; held: number | null }> {
  return raw.flatMap((r) =>
    typeof r.s === "string" && typeof r.ex === "string" && typeof r.n === "number"
      ? [{ session: r.s, logged: r.ex, sets: r.n, held: typeof r.held === "number" && r.held > 0 ? r.held : null }]
      : [],
  );
}

/** A logged move as the balance counts it: a watch key the library maps is that library move. */
export const asLibrary = (id: string): string => {
  const w = watchMove(id);
  return w && "libraryId" in w ? w.libraryId : id;
};

/**
 * What `from`..`to` (the athlete's local dates, both included) did for the body. The range may be given from the
 * athlete's today (`(today) => range`): it is read in the first statement.
 *
 * `derive: false` reads only what Growth's body map shows — each session's working sets per move, the sets themselves
 * and the runs — and skips the balance (`derivePerformed` a session: the contraction balance, region and muscle
 * exposure, the focus areas' sets), which it never shows: over a busy season that was most of the read's CPU (the new
 * shape's integrated review, I2). Those come back empty.
 */
export async function readExposure(
  db: Db,
  userId: string,
  now: Date,
  range: { from: string; to: string } | ((today: string) => { from: string; to: string }),
  opts: { derive?: boolean } = {},
): Promise<Exposure> {
  const derive = opts.derive !== false;
  const { athlete, extra } = await readAthlete(db, userId, now, {
    focus: sql`(select ${athleteProfiles.focusAreas} from ${athleteProfiles} where ${athleteProfiles.userId} = ${userId})`,
  });
  const { from, to } = typeof range === "function" ? range(athlete.today) : range;
  const focus = parsedArray(typeof extra.focus === "string" ? extra.focus : null).flatMap((f) => {
    const parsed = focusAreaSchema.safeParse(f);
    return parsed.success ? [parsed.data] : [];
  });
  const scope = sessionsWhere(userId, sql`${performedSessions.localDate} between ${from} and ${to}`);
  const [sTerm, xTerm, , aTerm] = doneTerms(userId, scope, { activitiesWhere: activitiesAround(from, to) });
  const rows = await readTagged(db, [sTerm!, derive ? xTerm! : movesTerm(scope), aTerm!]);

  const all = sessionRows(rows.get("s"));
  const chosen = sessionsOnce(all);
  const sets = setRows(rows.get("x"));
  const movesOf = new Map<string, Array<{ session: string; exerciseId: string; logged: string; sets: number; held: number | null }>>();
  for (const m of moveRows(rows.get("m"))) {
    const row = { ...m, exerciseId: asLibrary(m.logged) };
    const list = movesOf.get(m.session);
    if (list) list.push(row);
    else movesOf.set(m.session, [row]);
  }
  const moves: Exposure["moves"] = [];
  // A session's own activity joins it whatever its date; the rest are the range's, by their local date.
  const acts = new Map(activityRows(rows.get("a"), athlete.tz).map((a) => [a.id, a]));
  const logged = new Set(all.map((s) => s.activityId).filter((id): id is string => id !== null));

  const balance: BalanceProfile = { isometricSec: 0, isotonicReps: 0, eccentricReps: 0, plyoContacts: 0, aerobicSec: 0, mobilitySec: 0, recoverySec: 0 };
  const regions = new Map<string, number>();
  const muscles = new Map<string, number>();
  const byMove: Exposure["byMove"] = [];
  const focusSeen = new Map<string, { last: string | null; sets: number }>(focus.map((f) => [f.id, { last: null, sets: 0 }]));
  const unknown = new Set<string>();
  const watchUnknown = new Map<string, Set<string>>();
  const noteUnknown = (id: string, sessionId: string): void => {
    if (LIBRARY.has(id)) return;
    const w = watchMove(id);
    if (w && "key" in w) {
      const name = w.corosName ?? w.key;
      watchUnknown.set(name, (watchUnknown.get(name) ?? new Set()).add(sessionId));
    } else unknown.add(id);
  };
  const add = (input: PerformedInput) => {
    const d = derivePerformed(input, EXERCISES);
    for (const k of Object.keys(balance) as Array<keyof BalanceProfile>) balance[k] += d.balance[k];
    for (const [k, v] of Object.entries(d.regionExposure)) regions.set(k, (regions.get(k) ?? 0) + v);
    for (const [k, v] of Object.entries(d.muscleExposure)) muscles.set(k, (muscles.get(k) ?? 0) + v);
  };
  /**
   * A focus area's sets: every working set of a move that trains it, once — a move counts when any of the area's refs
   * is one of its regions or muscles, however many of them it names (an area of a region and that region's muscles
   * never counts a set twice).
   */
  const trains = (exerciseId: string, f: FocusArea): boolean => {
    const says = namesOf(exerciseId);
    return says !== null && f.refs.some((ref) => says.has(ref));
  };
  const countFocus = (exerciseId: string, workingSets: number, date: string) => {
    for (const f of focus) {
      if (!trains(exerciseId, f)) continue;
      const seen = focusSeen.get(f.id)!;
      seen.sets += workingSets;
      if (!seen.last || date > seen.last) seen.last = date;
    }
  };

  // Each session's sets, grouped once: a season holds thousands of sets, and filtering them for every session was most
  // of the read's CPU (the integrated review, I2).
  const setsOf = new Map<string, SetRow[]>();
  for (const x of sets) {
    const list = setsOf.get(x.session);
    if (list) list.push(x);
    else setsOf.set(x.session, [x]);
  }
  for (const s of chosen) {
    if (!derive) {
      // One row a move, its sets counted by SQLite; a move played without a set as before.
      const mine = movesOf.get(s.id) ?? [];
      for (const m of mine) {
        noteUnknown(m.logged, s.id);
        byMove.push({ exerciseId: m.exerciseId, date: s.date, sets: m.sets });
        moves.push({ session: s.id, exerciseId: m.exerciseId, sets: m.sets, held: m.held });
      }
      const loggedIds = new Set(mine.map((m) => m.exerciseId));
      for (const m of s.movesDone) {
        const exerciseId = asLibrary(m.exerciseId);
        if (loggedIds.has(exerciseId)) continue;
        noteUnknown(m.exerciseId, s.id);
        byMove.push({ exerciseId, date: s.date, sets: 1 });
      }
      continue;
    }
    const mine = (setsOf.get(s.id) ?? []).map((x) => ({ ...x, exerciseId: asLibrary(x.exerciseId), logged: x.exerciseId }));
    const entries = new Map<string, PerformedInput["entries"][number]>();
    /** Working sets per move: a set done a side at a time (a row per side) is one set. */
    const working = new Map<string, Set<string>>();
    for (const x of mine) {
      noteUnknown(x.logged, s.id);
      const key = `${x.entry}:${x.exerciseId}:${x.perSide}`;
      const e = entries.get(key) ?? { exerciseId: x.exerciseId, perSide: x.perSide, sets: [] };
      e.sets.push({ reps: x.reps, seconds: x.seconds, loadKg: null, done: true, flags: x.flags });
      entries.set(key, e);
      working.set(x.exerciseId, (working.get(x.exerciseId) ?? new Set()).add(`${x.entry}:${x.index}`));
    }
    const loggedIds = new Set(mine.map((x) => x.exerciseId));
    const played = s.movesDone.map((m) => ({ ...m, exerciseId: asLibrary(m.exerciseId), logged: m.exerciseId })).filter((m) => !loggedIds.has(m.exerciseId));
    for (const m of played) noteUnknown(m.logged, s.id);
    const a = s.activityId ? acts.get(s.activityId) : undefined;
    if (derive) add({ entries: [...entries.values()], movesDone: played, activity: a ? { sport: a.sport, durationSeconds: a.seconds, distanceMeters: a.meters } : null });
    for (const [exerciseId, n] of working) {
      if (derive) countFocus(exerciseId, n.size, s.date);
      byMove.push({ exerciseId, date: s.date, sets: n.size });
    }
    for (const m of played) {
      if (derive) countFocus(m.exerciseId, 1, s.date);
      byMove.push({ exerciseId: m.exerciseId, date: s.date, sets: 1 });
    }
  }
  let runs = 0;
  let other = 0;
  for (const a of acts.values()) {
    if (logged.has(a.id) || a.date < from || a.date > to) continue;
    if (a.sport === "run") runs += 1;
    else other += 1;
    if (derive) add({ entries: [], movesDone: [], activity: { sport: a.sport, durationSeconds: a.seconds, distanceMeters: a.meters } });
  }
  // Every run in the range loaded the legs, a session's own run among them (by its date).
  const ranDays = [...acts.values()].filter((a) => a.sport === "run" && a.date >= from && a.date <= to).map((a) => a.date);
  const lastRun = ranDays.length ? ranDays.reduce((x, y) => (y > x ? y : x)) : null;
  return {
    athlete,
    focus,
    sessions: chosen,
    sets,
    runs,
    other,
    nothing: chosen.length === 0 && runs === 0 && other === 0,
    balance,
    regions,
    muscles,
    byMove,
    moves,
    focusSeen,
    ranDays,
    lastRun,
    unknown,
    watchUnknown,
  };
}
