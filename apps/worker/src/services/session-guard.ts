import { and, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { corosWriteJobs, plannedWorkouts, sessionBuilds } from "@rg/database";
import { addDays, isLocalDate } from "@rg/domain";
import { chunkIds, type Db } from "./db.js";
import { PROVISIONAL_KIND, PROVISIONAL_KIND_PATH, pushJobId, SETTLED_PUSH, UNSTARTED_AT_PATH } from "./session-build.js";

/**
 * THE SESSION GUARD: what the athlete's plan routes and the coach refuse, so a finished session's credit stays where it landed
 * and a session under way isn't moved out from under the device playing it. It is a server rule because old cached clients and
 * direct calls reach these routes too. Held to it, each at its read and in its write: the athlete's move, skip and remove;
 * the coach's ops, the designer's and the thread's (the applier's own read, `stillOpen` on each write); a plan's bulk archives;
 * the swap; sync-note Undo; the Calendar's drag (its event put back); the day's placement (a started session pinned); a Start
 * (its write held to the row still on the plan and on the day it checked); and the COROS read: a done or started session keeps
 * its day — as the import read it, and in the write, where each re-date of a session (its slot or its row following the copy's
 * move, `followCopy` in import-plan.ts) is a statement of its own held to the row still neither started nor done. Not held to
 * it: reconcile and the sweep (they resolve, never move), the retries (a row's own date), restore and repairs.
 *
 * A STARTED SESSION'S MOVE IN COROS IS OWED, NOT CONSUMED: the row keeps the date the read last verified and the athlete is
 * told once ("Changed in COROS — Run Garden kept its version"); once it is no longer started (Unstart) the next read follows
 * the copy, as for any session. A done one's is consumed (its day never follows). What that costs, while a follow is owed:
 * the row's watch address still names the old day, so a delete of the copy then (Keep off; a remove once the session is past
 * its days) is refused by the delete's own check (`stamp_mismatch`) and the copy stays, nothing else deleted. A save dated the
 * copy's new day is refused (422), but no client makes one: the player dates its save by its build (`beginPlayer`), a build
 * is made for the row's own day, and a watch review needs a match the row on its old day doesn't give.
 *
 * WHAT IS ATOMIC, and only this: a guarded move, a re-time, an ease, a plan's archive slice (its way off the watch included)
 * and a day's placement are each one D1 batch. Skip and remove are one guarded statement (the row's write, held to the row as
 * read); their tails run after it, each on its own — remove's queued writes settled, its suppression, its intent, the copy's
 * way off the watch; skip's way off. A fault in a tail never reaches a protected session (the guarded write already refused
 * one), but it is NOT recovered: a retry finds the row skipped or removed and does nothing, and the next sync doesn't finish
 * it (RC boundary 5, the probe in the migration's rc/ folder: the copy can stay on the watch, and a remove without its
 * suppression can be un-archived by the next COROS read).
 *
 * COMPLETED: moving the row re-dates a credit the garden already walked. Moved ahead the walk credits it again; moved back a
 * later replay loses it (the owner's garden is not rebuilt to repair either).
 *
 * UNDER WAY: `content_state = 'started'`, and today is still within the days a save of it would be filed under: its started
 * builds' dates and the day after each, plus the row's own day when a sent copy moved (session-save.ts takes the same days). The
 * server can't tell running from abandoned, so the words say so. There is no lower bound: a row started on a day still ahead of
 * today (the account's zone changed since) is under way too. Past those days nothing refuses: the save still lands, but
 * reconcile is already asking about the session and the API has to offer a way on.
 */

/** Done: it stays as it is. Not "on the day it was done": a match may be a day off its slot, or made by hand. */
export const COMPLETED_WORDS = "This session is done, so it stays as it is on your plan.";
export const UNDER_WAY_WORDS = "This session was started and may still be running on another device, so it stays as it is.";

export interface GuardRefusal {
  error: "session_completed" | "session_under_way";
  why: string;
}

/** A constant of this module's as an SQL string literal: never a bound value (a read riding a statement near D1's 100 binds). */
const literal = (v: string): SQL => sql.raw(`'${v.replace(/'/g, "''")}'`);

/**
 * What decides "under way", as a column of a read of `planned_workouts`, so it costs no statement of its own and binds no value
 * (every constant in it is a literal): null for a row not started, otherwise its started builds' days and whether it holds a
 * live sent copy (`sentBuildIdOf`'s rule, a provisional copy's record as `provisionalRecord` says it).
 */
export const underWaySql = (): SQL => {
  const pw = plannedWorkouts;
  const b = sessionBuilds;
  const j = corosWriteJobs;
  const settled = sql.join(SETTLED_PUSH.map(literal), sql`, `);
  return sql`case when ${pw.contentState} = 'started' then json_object(
    'days', (select json_group_array(json_extract(${b.payload}, '$.build.date')) from ${b}
      where ${b.workoutId} = ${pw.id} and ${b.userId} = ${pw.userId}
        and (${b.lockedAt} is not null or json_extract(${b.payload}, ${literal(UNSTARTED_AT_PATH)}) is not null)),
    'sent', exists(select 1 from ${b} join ${j} on ${j.id} = ${literal(pushJobId(""))} || ${b.id}
      where ${b.workoutId} = ${pw.id}
        and (${b.lockedAt} is not null or (${b.version} < 0 and json_extract(${b.payload}, ${literal(PROVISIONAL_KIND_PATH)}) = ${literal(PROVISIONAL_KIND)}))
        and ${j.kind} = 'program_session_push' and ${j.status} not in (${settled}))
  ) end`;
};

const parsed = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

/** Whether the row is under way today, from `underWaySql`'s read. */
export function underWayNow(row: { contentState: string | null; effectiveDate: string }, read: unknown, today: string): boolean {
  if (row.contentState !== "started") return false;
  const r = parsed(read) as { days?: unknown; sent?: unknown } | null;
  const list = parsed(r?.days);
  const days = Array.isArray(list) ? list.filter((d): d is string => typeof d === "string" && isLocalDate(d)) : [];
  const own = days.length === 0 || r?.sent === 1 || r?.sent === true;
  return [...days, ...(own ? [row.effectiveDate] : [])].some((d) => today <= addDays(d, 1));
}

/** The row as the guard reads it: `undefined` for one that isn't this athlete's. */
export async function readGuarded(db: Db, userId: string, workoutId: string) {
  const pw = plannedWorkouts;
  const [row] = await db
    .select({ id: pw.id, origin: pw.origin, archivedAt: pw.archivedAt, effectiveDate: pw.effectiveDate, completionState: pw.completionState, contentState: pw.contentState, underWay: sql<unknown>`${underWaySql()}` })
    .from(pw)
    .where(and(eq(pw.id, workoutId), eq(pw.userId, userId)))
    .limit(1);
  return row;
}
/** What the guard judges: the row's state, and `underWaySql`'s read (null when the row isn't started, or wasn't read with it). */
type Guarded = Pick<NonNullable<Awaited<ReturnType<typeof readGuarded>>>, "effectiveDate" | "completionState" | "contentState" | "underWay">;

/** Why the athlete's own move, skip or remove can't touch this row today; null when it can. */
export function guardRefusal(row: Guarded, today: string): GuardRefusal | null {
  if (row.completionState === "completed") return { error: "session_completed", why: COMPLETED_WORDS };
  if (underWayNow(row, row.underWay, today)) return { error: "session_under_way", why: UNDER_WAY_WORDS };
  return null;
}

/** A guarded write lost to a save or a Start that landed since the guard's read: why, as the row stands now. */
export async function refusalNow(db: Db, userId: string, id: string, today: string): Promise<GuardRefusal | { error: "session_changed"; why: string }> {
  const row = await readGuarded(db, userId, id);
  return (row && guardRefusal(row, today)) ?? { error: "session_changed", why: "This session changed just now. Try again." };
}

/** Of these sessions, the ones the guard refuses today (one statement a `chunkIds` chunk; none for no ids). */
export async function guardedNow(db: Db, userId: string, ids: readonly string[], today: string): Promise<Set<string>> {
  const pw = plannedWorkouts;
  const out = new Set<string>();
  for (const chunk of chunkIds([...new Set(ids)])) {
    const rows = await db
      .select({ id: pw.id, effectiveDate: pw.effectiveDate, completionState: pw.completionState, contentState: pw.contentState, underWay: sql<unknown>`${underWaySql()}` })
      .from(pw)
      .where(and(eq(pw.userId, userId), inArray(pw.id, chunk)));
    for (const r of rows) if (guardRefusal(r, today)) out.add(r.id);
  }
  return out;
}

/**
 * The same rule in the write's own WHERE, for what the read let through: a save or a Start landing between the read and the write
 * loses nothing. A row read as started and past its days stays writable.
 */
export function stillOpen(row: Pick<Guarded, "contentState">): SQL {
  const pw = plannedWorkouts;
  return and(ne(pw.completionState, "completed"), row.contentState === "started" ? undefined : or(isNull(pw.contentState), ne(pw.contentState, "started")))!;
}
