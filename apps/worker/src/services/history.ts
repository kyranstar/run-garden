/**
 * THE PHONE'S HISTORY (DESIGN-2c §2.2): what was done, newest first, a page of whole days at a time, back one year on the
 * account's clock — the account's activities (app sessions, COROS runs on the plan and off it, the standalone tool's
 * imports) and the sessions the athlete said were done (Mark done: completed, `athlete_said_done`, no standing match).
 *
 * A READ: nothing here writes, settles, matches or reads the garden. What a row carries is display only — a block's answer
 * never comes from here (Q-168: the phone's own saved snapshot answers it).
 *
 * Never in a row: heart rate, pace, laps, elevation, training load, cadence, power, routes or location, telemetry, the
 * watch's feel rating, the device's name, and the body-check readings (`recordedByActivity` reads no check row at all).
 *
 * PAGES HOLD WHOLE DAYS. Rows are dated by run-garden's one rule (`activityDate`: the local start's day, else the UTC
 * start's), so a day's activities can lie a day either side of it in `start_time`: the page reads a bounded window of the
 * newest activities (`HISTORY_READ_ROWS`, by `start_time`, from the day before the year's first to the day after `before`,
 * and only those dated within the year and before `before`, in the statement itself) and of the said-done rows, and takes
 * only days it read whole — a day newer than two days past the oldest activity read
 * (and than the oldest said-done day read), when either read was cut. Then the newest of those days, each whole, until the
 * rows reach `limit`; a single day over `HISTORY_DAY_CAP` rows is cut there and the page says `capped`.
 *
 * WHAT IT COSTS: the page of activities and the said-done rows (two statements), the matched workouts (one a chunk of 90,
 * held to the account), the performed sessions and their sets (two; the account's library when a set names one of the
 * athlete's own moves), the build item counts (one), beside the route's gate, restore check, preferences and `corosReadAt`:
 * about 11, pinned at ≤ 15 (native-history.test.ts).
 */
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { activities, plannedWorkouts, sessionBuilds, workoutCompletionMatches } from "@rg/database";
import { addDays, humanizeWorkoutTitle, type WeightUnit } from "@rg/domain";
import { ATHLETE_SAID_DONE } from "./course-number.js";
import { chunkIds, type Db } from "./db.js";
import { activityDate, isExtraSession } from "./garden-sync.js";
import { recordedByActivity, type LoggedExerciseDto } from "./logged-sets.js";
import { activityTitle, localTimeOf } from "./plan-days.js";

/** A page holds at most this many rows (the phone asks 1–30). */
export const HISTORY_LIMIT_MAX = 30;
/** The phone's History reaches back this many days from the account's today; the laptop keeps all of it. */
export const HISTORY_DAYS = 365;
/** A single day over this many rows is cut here, and the page says `capped` (a bound, never reached). */
export const HISTORY_DAY_CAP = 60;
/** How many of the newest activities (and said-done rows) a page reads, at most: whole days of `limit` rows, and a margin. */
export const HISTORY_READ_ROWS = HISTORY_LIMIT_MAX + HISTORY_DAY_CAP + 40;

/** The workout a row completed (or, said done, is): its id, its title as stored, the words when they differ, and its day. */
export interface HistoryPlanned {
  workoutId: string;
  title: string;
  label?: string;
  category: string;
  date: string;
}

export interface HistoryRow {
  /** The activity's id, or `said:<workoutId>` for a session said done. */
  id: string;
  date: string;
  /** The local start, `HH:MM`; null when there is none (an activity dated by its UTC start, a session said done). */
  time: string | null;
  /** app | coros | import (an activity's own), or said_done. */
  source: string;
  sport: string;
  /** In words: an opaque code reads as the sport (an activity), or the planned title's words (said done). */
  title: string;
  seconds: number | null;
  /** A run's distance; null for any other sport. */
  distanceMeters: number | null;
  planned: HistoryPlanned | null;
  /** A run, lift or yoga session that completed no planned workout (`isExtraSession`): done work, never a session's answer. */
  extra: boolean;
  /** For a session played in run-garden's player: the moves it reached, and its build's (null when the build isn't kept). */
  moves: { done: number; planned: number | null } | null;
  /** Its logged sets in the athlete's own unit; null for none. */
  sets: LoggedExerciseDto[] | null;
  note: string | null;
}

export interface HistoryPage {
  rows: HistoryRow[];
  /** The `before` of the next page (its rows are dated strictly before it); null when nothing older is within the year. */
  next: string | null;
  capped: boolean;
}

interface ActRow {
  id: string;
  source: string;
  sport: string;
  startTime: string;
  startTimeLocal: string | null;
  completionMatchId: string | null;
  title: string | null;
  durationSeconds: number;
  distanceMeters: number | null;
}

interface SaidRow {
  id: string;
  title: string;
  sport: string;
  category: string;
  qualitySubtype: string | null;
  effectiveDate: string;
}

type Entry = { kind: "activity"; date: string; a: ActRow } | { kind: "said"; date: string; w: SaidRow };

const plannedOf = (w: { id: string; title: string; category: string; qualitySubtype: string | null; effectiveDate: string }): HistoryPlanned => {
  const shown = humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype);
  return { workoutId: w.id, title: w.title, ...(shown !== w.title ? { label: shown } : {}), category: w.category, date: w.effectiveDate };
};

/** A page of the account's history: rows dated `earliest` ≤ date < `before`, whole days, newest first. */
export async function historyPage(
  db: Db,
  userId: string,
  opts: { before: string; limit: number; earliest: string; unit: WeightUnit },
): Promise<HistoryPage> {
  const { before, limit, earliest } = opts;
  const pw = plannedWorkouts;
  const [acts, said] = await Promise.all([
    db
      .select({
        id: activities.id,
        source: activities.source,
        sport: activities.sport,
        startTime: activities.startTime,
        startTimeLocal: activities.startTimeLocal,
        completionMatchId: activities.completionMatchId,
        title: activities.title,
        durationSeconds: activities.durationSeconds,
        distanceMeters: activities.distanceMeters,
      })
      .from(activities)
      .where(
        and(
          eq(activities.userId, userId),
          // The index's bound: every activity whose day can be in the page, whatever its zone…
          gte(activities.startTime, addDays(earliest, -1)),
          lt(activities.startTime, addDays(before, 1)),
          // …and only those dated in it (`activityDate`'s rule, in SQL), so a crowded day at or after `before` never spends
          // the read (review MINOR-1: it could leave no older day read, and `next` pointed forward).
          sql`coalesce(substr(${activities.startTimeLocal}, 1, 10), substr(${activities.startTime}, 1, 10)) >= ${earliest}`,
          sql`coalesce(substr(${activities.startTimeLocal}, 1, 10), substr(${activities.startTime}, 1, 10)) < ${before}`,
        ),
      )
      .orderBy(desc(activities.startTime), desc(activities.id))
      .limit(HISTORY_READ_ROWS)
      .all(),
    db
      .select({ id: pw.id, title: pw.title, sport: pw.sport, category: pw.category, qualitySubtype: pw.qualitySubtype, effectiveDate: pw.effectiveDate })
      .from(pw)
      .where(
        and(
          eq(pw.userId, userId),
          eq(pw.completionState, "completed"),
          eq(pw.sanctionedBy, ATHLETE_SAID_DONE),
          isNull(pw.archivedAt),
          gte(pw.effectiveDate, earliest),
          lt(pw.effectiveDate, before),
          sql`not exists (select 1 from ${workoutCompletionMatches} where ${workoutCompletionMatches.workoutId} = ${pw.id} and ${workoutCompletionMatches.undoneAt} is null)`,
        ),
      )
      .orderBy(desc(pw.effectiveDate), desc(pw.id))
      .limit(HISTORY_READ_ROWS)
      .all(),
  ]);

  // The days read whole: past the margin of a read that was cut.
  let safeFrom = earliest;
  // An activity the read left out started no later than the last one read, so its local day is no later than that start's
  // at UTC + 14 (the farthest zone ahead): every day after that one was read whole.
  if (acts.length === HISTORY_READ_ROWS) safeFrom = maxDate(safeFrom, addDays(new Date(Date.parse(acts.at(-1)!.startTime) + 14 * 3_600_000).toISOString().slice(0, 10), 1));
  if (said.length === HISTORY_READ_ROWS) safeFrom = maxDate(safeFrom, addDays(said.at(-1)!.effectiveDate, 1));
  const truncated = safeFrom > earliest;

  const entries: Entry[] = [
    ...acts.map((a): Entry => ({ kind: "activity", date: activityDate(a), a })),
    ...said.map((w): Entry => ({ kind: "said", date: w.effectiveDate, w })),
  ].filter((e) => e.date >= earliest && e.date < before);
  const byDay = new Map<string, Entry[]>();
  for (const e of entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const dates = [...byDay.keys()].sort().reverse();

  const taken: Entry[] = [];
  const held: { capped: boolean; lastDay: string | null } = { capped: false, lastDay: null };
  const take = (date: string) => {
    const day = byDay.get(date)!;
    if (day.length > HISTORY_DAY_CAP) held.capped = true;
    taken.push(...day.slice(0, HISTORY_DAY_CAP));
    held.lastDay = date;
  };
  for (const date of dates) {
    if (date < safeFrom) break;
    take(date);
    if (taken.length >= limit) break;
  }
  // A window read so full that no day of it is surely whole (never on a real account): its newest day, cut and said so.
  if (taken.length === 0 && truncated && dates.length > 0) {
    take(dates[0]!);
    held.capped = true;
  }
  const { lastDay } = held;
  let next: string | null = null;
  // Full: the next page starts before the last day taken, when anything older may remain. Not full but a read was cut:
  // the next starts before the days read whole (or before the one day taken from a window with none).
  if (lastDay !== null && taken.length >= limit) next = dates.some((d) => d < lastDay) || truncated ? lastDay : null;
  else if (truncated) next = lastDay !== null && lastDay < safeFrom ? lastDay : safeFrom;
  // The pager's invariant: the next page starts strictly before this one (never forward, so *Show more* can't loop).
  if (next !== null && next >= before) next = lastDay !== null && lastDay < before ? lastDay : null;
  if (next !== null && next <= earliest) next = null;

  return { rows: await rowsOf(db, userId, taken, opts.unit), next, capped: held.capped };
}

const maxDate = (a: string, b: string): string => (a > b ? a : b);

/** Each taken entry as the phone's row: the activity's matched workout, its recorded session and its build's size. */
async function rowsOf(db: Db, userId: string, taken: readonly Entry[], unit: WeightUnit): Promise<HistoryRow[]> {
  const acts = taken.flatMap((e) => (e.kind === "activity" ? [e.a] : []));
  const matchIds = [...new Set(acts.map((a) => a.completionMatchId).filter((m): m is string => m !== null))];
  const pw = plannedWorkouts;
  const [matched, recorded] = await Promise.all([
    Promise.all(
      chunkIds(matchIds).map((ids) =>
        db
          .select({ matchId: workoutCompletionMatches.id, id: pw.id, title: pw.title, category: pw.category, qualitySubtype: pw.qualitySubtype, effectiveDate: pw.effectiveDate })
          .from(workoutCompletionMatches)
          // The workout held to the account: an activity names a match, and the match a workout, by id alone.
          .innerJoin(pw, and(eq(pw.id, workoutCompletionMatches.workoutId), eq(pw.userId, userId)))
          .where(inArray(workoutCompletionMatches.id, ids))
          .all(),
      ),
    ).then((chunks) => new Map(chunks.flat().map((m) => [m.matchId, m]))),
    recordedByActivity(db, userId, acts.map((a) => a.id), unit),
  ]);
  // The size of each played session's build, read in SQL (body-check.ts's path): never the build's whole payload.
  const buildIds = [...new Set([...recorded.values()].filter((s) => s.source === "app" && s.buildId).map((s) => s.buildId!))];
  const sizes = new Map<string, number | null>();
  for (const ids of chunkIds(buildIds)) {
    const rows = await db
      .select({ id: sessionBuilds.id, items: sql<number | null>`json_array_length(json_extract(${sessionBuilds.payload}, '$.build.items'))` })
      .from(sessionBuilds)
      .where(and(eq(sessionBuilds.userId, userId), inArray(sessionBuilds.id, ids)))
      .all();
    for (const r of rows) sizes.set(r.id, r.items ?? null);
  }

  // Newest first within a day: activities by start, latest first, then the sessions said done.
  const ordered = [...taken].sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? 1 : -1;
    if (x.kind !== y.kind) return x.kind === "activity" ? -1 : 1;
    if (x.kind === "activity" && y.kind === "activity") return y.a.startTime.localeCompare(x.a.startTime) || y.a.id.localeCompare(x.a.id);
    return (y as { w: SaidRow }).w.id.localeCompare((x as { w: SaidRow }).w.id);
  });
  return ordered.map((e): HistoryRow => {
    if (e.kind === "said") {
      const planned = plannedOf(e.w);
      return {
        id: `said:${e.w.id}`,
        date: e.date,
        time: null,
        source: "said_done",
        sport: e.w.sport,
        title: planned.label ?? planned.title,
        seconds: null,
        distanceMeters: null,
        planned,
        extra: false,
        moves: null,
        sets: null,
        note: null,
      };
    }
    const { a } = e;
    const match = a.completionMatchId ? matched.get(a.completionMatchId) : undefined;
    const session = recorded.get(a.id);
    return {
      id: a.id,
      date: e.date,
      time: localTimeOf(a),
      source: a.source,
      sport: a.sport,
      title: activityTitle(a.title, a.sport),
      seconds: a.durationSeconds,
      distanceMeters: a.sport === "run" ? (a.distanceMeters ?? null) : null,
      planned: match ? plannedOf(match) : null,
      extra: isExtraSession(a),
      moves: session && session.source === "app" ? { done: session.movesDone, planned: session.buildId ? (sizes.get(session.buildId) ?? null) : null } : null,
      sets: session?.logged ?? null,
      note: session?.note ?? null,
    };
  });
}
