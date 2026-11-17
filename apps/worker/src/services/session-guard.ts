import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { auditEvents, corosWriteJobs, plannedWorkouts, sessionBuilds } from "@rg/database";
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
/** A move made against a stale view (Move's `from`): the session was moved elsewhere since — on the laptop, by the coach or COROS. */
export const MOVED_SINCE_WORDS = "This session was moved since this change was made, so it stays where it is now.";

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

/**
 * WHERE A CLIENT LAST SAW A SESSION (Move's optional `from`, stage 2 DESIGN §5.3): its day, and its time as the reads give
 * one — `HH:MM`, or null when the row holds none (`/api/native/today` and the plan read say null for any other value).
 */
export interface SeenAt {
  date: string;
  time: string | null;
}

/** A move made from a stale view of a session removed since, or not on the plan at all. */
export const GONE_WORDS = "This session is no longer on your plan.";
/** …of a session set aside since (skipped, or missed): it stays where it is, as it is. */
export const SET_ASIDE_WORDS = "This session was set aside since this change was made, so it stays as it is now.";

/** The states a session the client saw on its plan can still be moved from (a move of an unresolved one schedules it). */
const PLANNED_STATES = ["scheduled", "unresolved"] as const;

/** The row still stands at the client's slot: its day, and its time ("no time" is the reads' rule, `/^\d{2}:\d{2}$/`, as a GLOB). */
export function stillAt(seen: SeenAt): SQL {
  const pw = plannedWorkouts;
  const time = seen.time === null ? sql`${pw.effectiveTime} not glob '[0-9][0-9]:[0-9][0-9]'` : eq(pw.effectiveTime, seen.time);
  return and(eq(pw.effectiveDate, seen.date), time)!;
}

/**
 * THE ROW STILL STANDS AS THE CLIENT SAW IT, as an SQL condition for a guarded write, beside `stillOpen`: on the plan (not
 * removed), still planned (not skipped or missed since), and at its slot (`stillAt`). So a move made against a stale view —
 * an edit kept offline for hours while the laptop, the coach or COROS moved, removed or set the session aside — is refused in
 * the write itself, never an overwrite of the newer choice, and the client is never told a move landed that run-garden
 * doesn't show (review RG m1: the slot alone let a removed or skipped row be re-dated). Every constant is a literal but the
 * two states, the date and the time: four binds.
 */
export function stillAsSeen(seen: SeenAt): SQL {
  const pw = plannedWorkouts;
  return and(isNull(pw.archivedAt), inArray(pw.completionState, [...PLANNED_STATES]), stillAt(seen))!;
}

export type SeenRefusal =
  | { status: 404; body: { error: "not_found"; why: string } }
  | { status: 409; body: { error: "session_changed"; why: string } };

/** A resent move whose first answer was lost: it landed, and nothing has changed the session since (kit v0.14). */
export interface AlreadyMoved {
  taken: { corosSyncState: string; jobId?: string };
}

/**
 * HOW A GUARDED MOVE MADE FROM `seen` TO `to` LOST, as the row stands now, when the guard's own refusals (done, under way:
 * `refusalNow`, asked first) don't say:
 *
 *  - ALREADY TAKEN (`{taken}`): the phone's resend of a move whose answer was lost. The row is on the plan, still planned
 *    (scheduled — or unresolved, its new day passed since with nothing done: the move still landed; review RG r2-m2), at
 *    exactly `to`, and the LAST move written to it (its latest `workout_moved` audit) is this route's from exactly `seen` to
 *    exactly `to` (`MoveRequest.seen`). A row that sits at `to` after any other change — the laptop's own move there, or a
 *    move away and back — has a later audit, or one with no `seen`, and is not this edit's success. The caller answers 200
 *    as the first answer was, writing nothing.
 *  - removed (or gone): 404 `not_found`; set aside (skipped, missed): 409 `session_changed`, set aside; moved: 409
 *    `session_changed`, moved since.
 *
 * Null when it still stands as seen: the race was something else. One read, and a second (the latest move audit, newest
 * first by its time index) only when the row stands at `to`.
 */
export async function lostMoveAnswer(db: Db, userId: string, id: string, seen: SeenAt, to: { toDate: string; toTime: string }): Promise<AlreadyMoved | SeenRefusal | null> {
  const pw = plannedWorkouts;
  const [row] = await db
    .select({
      archivedAt: pw.archivedAt,
      completionState: pw.completionState,
      effectiveDate: pw.effectiveDate,
      effectiveTime: pw.effectiveTime,
      corosSyncState: pw.corosSyncState,
      at: sql<number>`case when ${stillAt(seen)} then 1 else 0 end`,
    })
    .from(pw)
    .where(and(eq(pw.id, id), eq(pw.userId, userId)))
    .limit(1);
  if (!row || row.archivedAt !== null) return { status: 404, body: { error: "not_found", why: GONE_WORDS } };
  if (!(PLANNED_STATES as readonly string[]).includes(row.completionState)) return { status: 409, body: { error: "session_changed", why: SET_ASIDE_WORDS } };
  if (Number(row.at)) return null;
  if (row.effectiveDate === to.toDate && row.effectiveTime === to.toTime) {
    const [last] = await db
      .select({ detail: auditEvents.detail })
      .from(auditEvents)
      .where(and(eq(auditEvents.userId, userId), eq(auditEvents.kind, "workout_moved"), sql`json_extract(${auditEvents.detail}, '$.workoutId') = ${id}`))
      .orderBy(desc(auditEvents.createdAt), sql`rowid desc`)
      .limit(1);
    const d = (last?.detail ?? null) as { source?: unknown; toDate?: unknown; toTime?: unknown; jobId?: unknown; seen?: { date?: unknown; time?: unknown } } | null;
    if (d && d.source === "app" && d.toDate === to.toDate && d.toTime === to.toTime && d.seen?.date === seen.date && (d.seen.time ?? null) === seen.time) {
      return { taken: { corosSyncState: row.corosSyncState, ...(typeof d.jobId === "string" ? { jobId: d.jobId } : {}) } };
    }
  }
  return { status: 409, body: { error: "session_changed", why: MOVED_SINCE_WORDS } };
}
