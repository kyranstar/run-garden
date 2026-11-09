import { and, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { corosWriteJobs, plannedWorkouts, sessionBuilds } from "@rg/database";
import { addDays, isLocalDate } from "@rg/domain";
import { chunkIds, type Db } from "./db.js";
import { provisionalRecord, pushJobId, SETTLED_PUSH, UNSTARTED_AT_PATH } from "./session-build.js";

/**
 * THE SESSION GUARD: what the athlete's plan routes and the coach refuse, so a finished session's credit stays where it landed
 * and a session under way isn't moved out from under the device playing it. It is a server rule because old cached clients and
 * direct calls reach these routes too. Reconcile, the sweep, the retries, sync-note Undo, placement, restore, repairs, the
 * Calendar and the COROS read sit below the routes, in `applyMove` and `removeFromPlan`, and aren't held to it.
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

export const COMPLETED_WORDS = "This session is done, so it stays on the day it was done.";
export const UNDER_WAY_WORDS = "This session was started and may still be running on another device, so it stays as it is.";

export interface GuardRefusal {
  error: "session_completed" | "session_under_way";
  why: string;
}

/**
 * What decides "under way", as a column of a read of `planned_workouts`, so it costs no statement of its own: null for a row not
 * started, otherwise its started builds' days and whether it holds a live sent copy (`sentBuildIdOf`'s rule).
 */
export const underWaySql = (): SQL => {
  const pw = plannedWorkouts;
  const b = sessionBuilds;
  const j = corosWriteJobs;
  const live = sql.join(SETTLED_PUSH.map((s) => sql`${s}`), sql`, `);
  return sql`case when ${pw.contentState} = 'started' then json_object(
    'days', (select json_group_array(json_extract(${b.payload}, '$.build.date')) from ${b}
      where ${b.workoutId} = ${pw.id} and ${b.userId} = ${pw.userId}
        and (${b.lockedAt} is not null or json_extract(${b.payload}, ${UNSTARTED_AT_PATH}) is not null)),
    'sent', exists(select 1 from ${b} join ${j} on ${j.id} = ${pushJobId("")} || ${b.id}
      where ${b.workoutId} = ${pw.id} and (${b.lockedAt} is not null or ${provisionalRecord()})
        and ${j.kind} = 'program_session_push' and ${j.status} not in (${live}))
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
