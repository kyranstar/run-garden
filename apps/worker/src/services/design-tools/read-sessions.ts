/**
 * WHAT WAS DONE, ONE COMPACT LINE PER SESSION (Stage 3 spec §4 `read_history`; principles §2.5, §5.3) — shared by
 * read_history, read_day and get_workout.
 *
 * A logged session is one line: its day, source, minutes, mode and theme, each condition profile's check before and
 * after it (`readingsBySession`, the engine's own pairing: the profiles' step-down, hold and rotation guides turn on a
 * session's check rising), its moves with their done sets summarised ("gobletSquat 3 × 8 @ 35 lb, last set 6"), the
 * sets flagged ("; Clenched on 1 set"), the moves played without a set ("catCow 2 min"), and the athlete's note
 * (marked). A run is distance, time, pace, heart rate, load and the athlete's feel; another sport its minutes.
 *
 * One physical session counts once: an activity's sessions go through `sessionPerActivity` (the athlete's own record
 * over the watch's copy), and an activity a session logged is that session's (its heart rate and load join it), never
 * a line of its own. A session still being written (`PENDING_HASH`) is not there yet. Weights are in the athlete's
 * unit, distances and paces in theirs. A move id the library does not know (an import's own name) is marked; a watch
 * move reads as the library move its key maps to, else by COROS's own name (`moveLine`, fix wave 13, A2).
 *
 * The rows come from ONE statement (`readTagged`): the sessions in scope, their done sets, their checks, and the
 * activities — four terms; a caller may add a fifth.
 */
import { sql, type SQL } from "drizzle-orm";
import { activities, conditionChecks, performedSessions, performedSets } from "@rg/database";
import { addDays, type WeightUnit } from "@rg/domain";
import { EXERCISES, PROFILES, isProfileId, profileById, THEMES, type ExerciseRecord } from "@rg/exercise-library";
import { makeLibraryIndex } from "@rg/workout";
import { readingsBySession, sessionPerActivity, watchMove, type CheckRowLike } from "../logged-sets.js";
import { COROS_EXERCISE_PREFIX, PENDING_HASH } from "../watch-sets.js";
import { activityDateOf, dayWords, distanceWords, localTimeOf, minutesOf, paceWords, parsedArray, untrusted, weightWords, type Untrusted } from "./read-common.js";

const ps = performedSessions;
const pset = performedSets;
const cc = conditionChecks;
const act = activities;

/** An activity's date as SQL can tell it: the device's local start, else the UTC one — within a day of the local date. */
const ACTIVITY_DAY = sql`substr(coalesce(${act.startTimeLocal}, ${act.startTime}), 1, 10)`;

/**
 * The activities that may fall on local dates `from`..`to`: a day either side in SQL (a start with no local time is a
 * UTC instant), held to the athlete's own dates in `activityRows`.
 */
export function activitiesAround(from: string, to: string): SQL {
  return sql`${ACTIVITY_DAY} between ${addDays(from, -1)} and ${addDays(to, 1)}`;
}

/** The sessions of a scope that are there (not being written): a condition on `performed_sessions`. */
export function sessionsWhere(userId: string, where: SQL): SQL {
  return sql`${ps.userId} = ${userId} and ${ps.payloadHash} != ${PENDING_HASH} and (${where})`;
}

const telemetry = (path: string): SQL => sql`case when json_valid(${act.telemetry}) then json_extract(${act.telemetry}, ${sql.raw(`'${path}'`)}) end`;

/**
 * The terms `readTagged` reads what was done with: `s` sessions, `x` their done sets, `c` their checks (and any other
 * checks `moreChecks` names), `a` the activities `activitiesWhere` names.
 */
export function doneTerms(userId: string, scope: SQL, o: { activitiesWhere: SQL; moreChecks?: SQL }): SQL[] {
  const ids = sql`(select ${ps.id} from ${ps} where ${scope})`;
  const slots = sql`(select ${ps.workoutId} from ${ps} where ${scope} and ${ps.workoutId} is not null)`;
  return [
    sql`select 's' as t, json_object('id', ${ps.id}, 'activityId', ${ps.activityId}, 'workoutId', ${ps.workoutId}, 'source', ${ps.source},
        'date', ${ps.localDate}, 'startedAt', ${ps.startedAt}, 'seconds', ${ps.seconds}, 'mode', ${ps.mode}, 'theme', ${ps.theme},
        'movesDone', ${ps.movesDone}, 'note', ${ps.note}, 'createdAt', ${ps.createdAt}) as j
        from ${ps} where ${scope}`,
    sql`select 'x' as t, json_object('s', ${pset.performedSessionId}, 'e', ${pset.entryIndex}, 'i', ${pset.setIndex}, 'ex', ${pset.exerciseId},
        'r', ${pset.reps}, 'sec', ${pset.seconds}, 'v', ${pset.loadValue}, 'u', ${pset.loadUnit}, 'side', ${pset.side}, 'ps', ${pset.perSide},
        'f', ${pset.flags}) as j
        from ${pset} where ${pset.done} = 1 and ${pset.performedSessionId} in ${ids}`,
    sql`select 'c' as t, json_object('id', ${cc.id}, 'profileId', ${cc.profileId}, 'kind', ${cc.kind}, 'value', ${cc.value},
        'feelingOff', ${cc.feelingOff}, 'localDate', ${cc.localDate}, 'at', ${cc.at}, 'performedSessionId', ${cc.performedSessionId},
        'workoutId', ${cc.workoutId}) as j
        from ${cc} where ${cc.userId} = ${userId} and (
          (${cc.kind} in ('pre', 'post') and ${cc.performedSessionId} in ${ids})
          or (${cc.kind} = 'pre' and ${cc.performedSessionId} is null and ${cc.workoutId} in ${slots})
          ${o.moreChecks ? sql`or (${o.moreChecks})` : sql``})`,
    sql`select 'a' as t, json_object('id', ${act.id}, 'local', ${act.startTimeLocal}, 'start', ${act.startTime}, 'sport', ${act.sport},
        'sec', ${act.durationSeconds}, 'm', ${act.distanceMeters}, 'hr', ${act.avgHeartRate}, 'pace', ${act.avgPaceSecPerKm},
        'load', ${act.trainingLoad}, 'feel', ${telemetry("$.feelRating")}, 'note', ${telemetry("$.sportNote")}) as j
        from ${act} where ${act.userId} = ${userId} and (${o.activitiesWhere})`,
  ];
}

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface SessionRow {
  id: string;
  activityId: string | null;
  workoutId: string | null;
  source: string;
  date: string;
  startedAt: string | null;
  seconds: number;
  mode: string | null;
  theme: string | null;
  movesDone: Array<{ exerciseId: string; seconds: number }>;
  note: string | null;
  createdAt: string;
}

export interface SetRow {
  session: string;
  entry: number;
  index: number;
  exerciseId: string;
  reps: number | null;
  seconds: number | null;
  value: number | null;
  unit: string | null;
  side: string | null;
  perSide: boolean;
  flags: string[];
}

export interface ActivityRow {
  id: string;
  date: string;
  start: string;
  sport: string;
  seconds: number;
  meters: number | null;
  hr: number | null;
  pace: number | null;
  load: number | null;
  feel: number | null;
  note: string | null;
}

export function sessionRows(raw: Raw[] = []): SessionRow[] {
  return raw.flatMap((r) => {
    const id = str(r.id);
    const date = str(r.date);
    if (!id || !date) return [];
    const moves = parsedArray(r.movesDone).flatMap((m) => {
      const x = m as { exerciseId?: unknown; seconds?: unknown };
      return typeof x?.exerciseId === "string" ? [{ exerciseId: x.exerciseId, seconds: num(x.seconds) ?? 0 }] : [];
    });
    return [{
      id, date, activityId: str(r.activityId), workoutId: str(r.workoutId), source: str(r.source) ?? "app", startedAt: str(r.startedAt),
      seconds: num(r.seconds) ?? 0, mode: str(r.mode), theme: str(r.theme), movesDone: moves, note: str(r.note), createdAt: str(r.createdAt) ?? "",
    }];
  });
}

export function setRows(raw: Raw[] = []): SetRow[] {
  return raw.flatMap((r) => {
    const session = str(r.s);
    const exerciseId = str(r.ex);
    if (!session || !exerciseId) return [];
    return [{
      session, exerciseId, entry: num(r.e) ?? 0, index: num(r.i) ?? 0, reps: num(r.r), seconds: num(r.sec), value: num(r.v), unit: str(r.u),
      side: str(r.side), perSide: r.ps === 1 || r.ps === true, flags: parsedArray(r.f).filter((f): f is string => typeof f === "string"),
    }];
  });
}

export function checkRows(raw: Raw[] = []): CheckRowLike[] {
  return raw.flatMap((r) => {
    const id = str(r.id);
    const profileId = str(r.profileId);
    const kind = str(r.kind);
    const at = str(r.at);
    const localDate = str(r.localDate);
    if (!id || !profileId || !kind || !at || !localDate) return [];
    return [{
      id, profileId, kind, at, localDate, value: num(r.value), feelingOff: r.feelingOff === 1 || r.feelingOff === true,
      performedSessionId: str(r.performedSessionId), workoutId: str(r.workoutId),
    }];
  });
}

/** The activities, each on its local date in `tz`; with `range`, only those whose local date is in it. */
export function activityRows(raw: Raw[] = [], tz: string, range?: { from: string; to: string }): ActivityRow[] {
  return raw.flatMap((r) => {
    const id = str(r.id);
    const date = activityDateOf(tz, r.local, r.start);
    if (!id || !date || (range && (date < range.from || date > range.to))) return [];
    return [{
      id, date, start: str(r.start) ?? "", sport: (str(r.sport) ?? "other").toLowerCase(), seconds: num(r.sec) ?? 0, meters: num(r.m), hr: num(r.hr),
      pace: num(r.pace), load: num(r.load), feel: num(r.feel), note: str(r.note),
    }];
  });
}

/** One session per activity (the athlete's own record first), and every session that names no activity. */
export function sessionsOnce(sessions: readonly SessionRow[]): SessionRow[] {
  return [...sessionPerActivity(sessions).values(), ...sessions.filter((s) => !s.activityId)];
}

// ── Words ───────────────────────────────────────────────────────────────────────────────────────────────────────────


const THEME_NAME = new Map(THEMES.map((t) => [t.id, t.name]));
const FLAG_LABEL = new Map(Object.values(PROFILES).flatMap((p) => (p.setFlag ? [[p.setFlag.id, p.setFlag.label] as const] : [])));

/**
 * A move id the app's own code wrote — the library's (`library`, given: the account's, so one of the athlete's own moves
 * too, an archived or merged one; else the public library), or a COROS catalog key — or one from outside it.
 */
export const knownMove = (id: string, library: readonly ExerciseRecord[] = EXERCISES): boolean =>
  makeLibraryIndex(library)(id) !== undefined || (id.startsWith(COROS_EXERCISE_PREFIX) && /^[A-Za-z0-9]{1,20}$/.test(id.slice(COROS_EXERCISE_PREFIX.length)));

/**
 * A move and its words: plain for a move the app knows, marked for one it does not (an import's own name). A watch
 * move reads by name (fix wave 13, A2): the library move its key maps to, else its key with COROS's own name — never a
 * bare code the coach can't read.
 */
export function moveLine(id: string, words: string, library?: readonly ExerciseRecord[]): string | Untrusted {
  if (!knownMove(id, library)) return untrusted(`${id} ${words}`);
  const watch = watchMove(id);
  if (!watch) return `${id} ${words}`;
  if ("libraryId" in watch) return `${watch.libraryId} ${words}`;
  return `${id} (${watch.corosName ? `${watch.corosName}; ` : ""}watch move, not in the library) ${words}`;
}

interface OneSet {
  reps: number | null;
  seconds: number | null;
  load: string | null;
  flags: string[];
}

const valueOf = (s: OneSet): string => (s.reps !== null ? String(s.reps) : s.seconds !== null ? `${s.seconds} s` : "done");
const oneSet = (s: OneSet): string => `${valueOf(s)}${s.load ? ` @ ${s.load}` : ""}`;

/** "3 × 8 @ 35 lb", "3 × 8 @ 35 lb, last set 6", "8 @ 30 lb, 8 @ 35 lb, 6 @ 40 lb", "2 × 10 each side". */
export function setsWords(sets: readonly OneSet[], perSide: boolean): string {
  const each = perSide ? " each side" : "";
  const first = sets[0]!;
  const last = sets[sets.length - 1]!;
  const same = (a: OneSet, b: OneSet) => valueOf(a) === valueOf(b) && a.load === b.load;
  let words: string;
  if (sets.every((s) => same(s, first))) words = `${sets.length} × ${oneSet(first)}${each}`;
  else if (sets.length >= 2 && sets.slice(0, -1).every((s) => same(s, first)) && last.load === first.load) {
    words = `${sets.length} × ${oneSet(first)}${each}, last set ${valueOf(last)}`;
  } else {
    words = `${sets.slice(0, 8).map(oneSet).join(", ")}${sets.length > 8 ? `, … ${sets.length} sets` : ""}${each}`;
  }
  const counts = new Map<string, number>();
  for (const s of sets) for (const f of new Set(s.flags)) counts.set(f, (counts.get(f) ?? 0) + 1);
  for (const [f, n] of counts) words += `; ${FLAG_LABEL.get(f) ?? f} on ${n} set${n === 1 ? "" : "s"}`;
  return words;
}

/** A session's done sets, move by move in the order first done: one value per set (a set done a side at a time is its shorter side). */
export function movesOf(sets: readonly SetRow[], weightUnit: WeightUnit): Array<{ exerciseId: string; words: string }> {
  const byMove = new Map<string, Map<string, { order: number; rows: SetRow[] }>>();
  for (const r of [...sets].sort((a, b) => a.entry - b.entry || a.index - b.index)) {
    const move = byMove.get(r.exerciseId) ?? new Map<string, { order: number; rows: SetRow[] }>();
    byMove.set(r.exerciseId, move);
    const key = `${r.entry}:${r.index}`;
    const held = move.get(key) ?? { order: r.entry * 10_000 + r.index, rows: [] };
    held.rows.push(r);
    move.set(key, held);
  }
  return [...byMove.entries()].map(([exerciseId, groups]) => {
    let perSide = false;
    const oneSets = [...groups.values()].sort((a, b) => a.order - b.order).map(({ rows }) => {
      if (rows.some((r) => r.perSide || r.side !== null)) perSide = true;
      const min = (xs: Array<number | null>) => {
        const ns = xs.filter((x): x is number => x !== null);
        return ns.length ? Math.min(...ns) : null;
      };
      const loaded = rows.find((r) => r.value !== null && r.value > 0);
      return {
        reps: min(rows.map((r) => r.reps)),
        seconds: min(rows.map((r) => r.seconds)),
        load: loaded ? weightWords(loaded.value!, loaded.unit, weightUnit) : null,
        flags: rows.flatMap((r) => r.flags),
      };
    });
    return { exerciseId, words: setsWords(oneSets, perSide) };
  });
}

const playedWords = (seconds: number): string => (seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${Math.max(0, Math.round(seconds))} s`);

export interface DoneCtx {
  tz: string;
  units: "km" | "mi";
  weightUnit: WeightUnit;
  /** The athlete's today: with it, each line says its day ("Tue 12 May · yesterday"; fix wave 13, I6). */
  today?: string;
  /** The account's library (`all`), when the read has it: one of the athlete's own moves is then a move the app wrote. */
  library?: readonly ExerciseRecord[];
}

/** A line's kind, as the model filters by it: a logged session, a run, or another sport (its `sport` says which). */
export type DoneKind = "session" | "run" | "other";
export const DONE_KINDS = ["session", "run", "other"] as const satisfies readonly DoneKind[];

/** A line's `day`, when the caller knows today. */
const dayOf = (date: string, ctx: DoneCtx): { day?: string } => (ctx.today ? { day: dayWords(date, ctx.today) } : {});

export interface DoneEntry {
  /** For ordering, newest first, and for a page to start at: the day, the local time, the id. */
  key: string;
  kind: DoneKind;
  entry: Record<string, unknown>;
}

/**
 * Every line of what was done in the rows, newest first. Each line carries its id — a session's, or a run's or other
 * sport's activity id — so a design can say what it is based on. With `range`, activities outside it (by their local
 * date) are left out.
 */
export function doneEntries(
  raw: { sessions?: Raw[]; sets?: Raw[]; checks?: Raw[]; activities?: Raw[] },
  ctx: DoneCtx,
  range?: { from: string; to: string },
): DoneEntry[] {
  const all = sessionRows(raw.sessions);
  const chosen = sessionsOnce(all);
  const sets = setRows(raw.sets);
  const readings = readingsBySession(
    chosen.map((s) => ({ id: s.id, workoutId: s.workoutId, localDate: s.date })),
    checkRows(raw.checks),
  );
  // A session's own activity joins it whatever its date; the rest are the range's.
  const activitiesById = new Map(activityRows(raw.activities, ctx.tz).map((a) => [a.id, a]));
  const logged = new Set(all.map((s) => s.activityId).filter((id): id is string => id !== null));
  const out: DoneEntry[] = [];

  for (const s of chosen) {
    const mine = sets.filter((x) => x.session === s.id);
    const moves = movesOf(mine, ctx.weightUnit);
    const loggedIds = new Set(mine.map((x) => x.exerciseId));
    const played = s.movesDone.filter((m) => !loggedIds.has(m.exerciseId)).map((m) => moveLine(m.exerciseId, playedWords(m.seconds), ctx.library));
    const checks = [...(readings.get(s.id) ?? new Map<string, { pre: number | null; post: number | null }>()).entries()]
      .filter(([profileId, r]) => isProfileId(profileId) && (r.pre !== null || r.post !== null))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([profileId, r]) => ({ profile: profileById(profileId).label, before: r.pre, after: r.post }));
    const a = s.activityId ? activitiesById.get(s.activityId) : undefined;
    const entry: Record<string, unknown> = { id: s.id, date: s.date, ...dayOf(s.date, ctx), kind: "session", source: s.source, minutes: minutesOf(s.seconds) };
    if (s.mode) entry.mode = s.mode;
    if (s.theme) entry.theme = THEME_NAME.get(s.theme) ?? untrusted(s.theme);
    if (s.workoutId) entry.workoutId = s.workoutId;
    if (checks.length) entry.checks = checks;
    entry.moves = moves.map((m) => moveLine(m.exerciseId, m.words, ctx.library));
    if (played.length) entry.played = played;
    if (a?.hr) entry.hr = Math.round(a.hr);
    if (a?.load) entry.load = Math.round(a.load);
    if (s.note && s.note.trim()) entry.note = untrusted(s.note);
    out.push({ key: `${s.date} ${localTimeOf(ctx.tz, s.startedAt ?? s.createdAt) ?? ""} ${s.id}`, kind: "session", entry });
  }

  for (const a of activitiesById.values()) {
    if (logged.has(a.id) || (range && (a.date < range.from || a.date > range.to))) continue;
    const key = `${a.date} ${localTimeOf(ctx.tz, a.start) ?? ""} ${a.id}`;
    if (a.sport === "run") {
      const entry: Record<string, unknown> = { id: a.id, date: a.date, ...dayOf(a.date, ctx), kind: "run", minutes: minutesOf(a.seconds) };
      if (a.meters && a.meters > 0) entry.distance = distanceWords(a.meters, ctx.units);
      const pace = a.pace && a.pace > 0 ? a.pace : a.meters && a.meters > 0 && a.seconds > 0 ? a.seconds / (a.meters / 1000) : null;
      if (pace) entry.pace = paceWords(pace, ctx.units);
      if (a.hr) entry.hr = Math.round(a.hr);
      if (a.load) entry.load = Math.round(a.load);
      if (a.feel) entry.feel = `${a.feel} of 5`;
      if (a.note && a.note.trim()) entry.note = untrusted(a.note);
      out.push({ key, kind: "run", entry });
    } else {
      const entry: Record<string, unknown> = { id: a.id, date: a.date, ...dayOf(a.date, ctx), kind: "other", sport: a.sport, minutes: minutesOf(a.seconds) };
      if (a.hr) entry.hr = Math.round(a.hr);
      if (a.load) entry.load = Math.round(a.load);
      out.push({ key, kind: "other", entry });
    }
  }
  return out.sort((x, y) => (x.key < y.key ? 1 : x.key > y.key ? -1 : 0));
}
