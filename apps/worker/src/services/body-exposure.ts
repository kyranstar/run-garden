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
 * Two statements: the athlete with the focus areas, then the range in one read (`readTagged`).
 */
import { sql } from "drizzle-orm";
import { athleteProfiles, performedSessions } from "@rg/database";
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

/** The regions a run loads (the library's own region ids). */
export const RUN_REGIONS = ["calves", "hamstrings", "quads", "hips", "ankles", "feet"] as const satisfies readonly Region[];
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

/** A logged move as the balance counts it: a watch key the library maps is that library move. */
export const asLibrary = (id: string): string => {
  const w = watchMove(id);
  return w && "libraryId" in w ? w.libraryId : id;
};

/**
 * What `from`..`to` (the athlete's local dates, both included) did for the body. The range may be given from the
 * athlete's today (`(today) => range`): it is read in the first statement.
 */
export async function readExposure(
  db: Db,
  userId: string,
  now: Date,
  range: { from: string; to: string } | ((today: string) => { from: string; to: string }),
): Promise<Exposure> {
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
  const rows = await readTagged(db, [sTerm!, xTerm!, aTerm!]);

  const all = sessionRows(rows.get("s"));
  const chosen = sessionsOnce(all);
  const sets = setRows(rows.get("x"));
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
    const rec = BY_ID.get(exerciseId);
    if (!rec) return false;
    const says = new Set<string>([...rec.regions, ...rec.muscles.primary, ...rec.muscles.secondary]);
    return f.refs.some((ref) => says.has(ref));
  };
  const countFocus = (exerciseId: string, workingSets: number, date: string) => {
    for (const f of focus) {
      if (!trains(exerciseId, f)) continue;
      const seen = focusSeen.get(f.id)!;
      seen.sets += workingSets;
      if (!seen.last || date > seen.last) seen.last = date;
    }
  };

  for (const s of chosen) {
    const mine = sets.filter((x) => x.session === s.id).map((x) => ({ ...x, exerciseId: asLibrary(x.exerciseId), logged: x.exerciseId }));
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
    add({ entries: [...entries.values()], movesDone: played, activity: a ? { sport: a.sport, durationSeconds: a.seconds, distanceMeters: a.meters } : null });
    for (const [exerciseId, n] of working) {
      countFocus(exerciseId, n.size, s.date);
      byMove.push({ exerciseId, date: s.date, sets: n.size });
    }
    for (const m of played) {
      countFocus(m.exerciseId, 1, s.date);
      byMove.push({ exerciseId: m.exerciseId, date: s.date, sets: 1 });
    }
  }
  let runs = 0;
  let other = 0;
  for (const a of acts.values()) {
    if (logged.has(a.id) || a.date < from || a.date > to) continue;
    if (a.sport === "run") runs += 1;
    else other += 1;
    add({ entries: [], movesDone: [], activity: { sport: a.sport, durationSeconds: a.seconds, distanceMeters: a.meters } });
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
    focusSeen,
    ranDays,
    lastRun,
    unknown,
    watchUnknown,
  };
}
