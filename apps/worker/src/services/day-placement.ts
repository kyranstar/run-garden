/**
 * WHERE IN THE DAY A SESSION SITS — the one answer to "what time?", shared by
 * the COROS importer and the coach's apply.
 *
 * Both used to answer it alone, and both answered it the same way: return the
 * athlete's window time (`weekdayMorningTime` and friends) and never look at
 * what else is already on the day. With one session a day that is right. With
 * two it books two calendar events on top of each other, and with buffers on
 * both sides the overlap is bigger than either session — live on ten upcoming
 * days, three sessions at 09:00 on 2026-08-25. The coach now adds a daily
 * session on top of an imported plan, so a day holding a plan run AND a coach
 * mobility filler is the normal case, not the exception.
 *
 * THREE RULES, in this order:
 *
 *  1. THE DAY HAS ONE APPOINTMENT AND THE REST ARE FILLERS. A long run and a
 *     ten-minute mobility flow are not two appointments of equal weight. The
 *     day's heaviest session keeps the window time the athlete chose; lighter
 *     ones move around it. `SESSION_RANK` is that weighting, and within a rank
 *     the longer session outranks the shorter one — so which session anchors
 *     the day never depends on the order rows came back from the database.
 *
 *  2. A TIME THE ATHLETE CHOSE IS NEVER MOVED. A `time_change` override is the
 *     athlete saying "this one, at this time"; those slots are reserved before
 *     anything else is placed, and everything else flows around them.
 *
 *  3. DETERMINISTIC, AND ONLY ON A DAY THAT ACTUALLY COLLIDES. The layout is a
 *     pure function of (the day's session set, the athlete's preferences), so
 *     re-importing the same day re-derives the same times — a placement that
 *     drifted by a few minutes per import would rewrite the athlete's Google
 *     Calendar every hour forever. And a day whose blocks already clear each
 *     other is left completely alone, including a day this function laid out
 *     earlier that has since lost a session: keeping a filler at 08:55 once the
 *     run beside it is gone is untidy, whereas re-shuffling every day of the
 *     window for tidiness is churn.
 */

import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { plannedWorkouts, scheduleOverrides } from "@rg/database";
import { isWeekend, type SchedulingPreferences } from "@rg/domain";
import { chunkIds, type Db } from "./db.js";

/**
 * The athlete's window for a session, ignoring everything else on the day —
 * the DESIRED start that `placeDaySessions` then honours or displaces.
 *
 * Long runs and races default to the morning; everything else follows the
 * user's default window. All of it is user-adjustable afterwards. This is the
 * function `import-plan.ts` and `coach-apply.ts` each used to carry a copy of;
 * the copies agreed, which is precisely why they were worth collapsing before
 * a third caller made them disagree.
 */
export function windowTimeFor(
  workout: { category: string; date: string },
  prefs: SchedulingPreferences,
): string {
  if (workout.category === "long" || workout.category === "race") {
    return isWeekend(workout.date) ? prefs.weekendMorningTime : prefs.weekdayMorningTime;
  }
  if (prefs.defaultWindow === "evening") return prefs.weekdayEveningTime;
  return isWeekend(workout.date) ? prefs.weekendMorningTime : prefs.weekdayMorningTime;
}

/**
 * How much of the day a session is allowed to claim, heaviest first. Not a
 * judgement about what matters in training — it is only about which session the
 * athlete plans their morning around, and a race or a long run is that session
 * on any day it appears. `rest` sorts last and is filtered out before it ever
 * gets here (a rest day has no calendar event to collide with).
 */
const SESSION_RANK: Record<string, number> = {
  race: 0,
  long: 1,
  quality: 2,
  easy: 3,
  recovery: 4,
  cross_training: 5,
  strength: 6,
  yoga: 7,
  unknown: 8,
  rest: 9,
};

/** The latest start this will ever displace a session to. A day stacked past
 * here is absurd (four-plus long sessions); the tail is left at 23:00 rather
 * than rolled into tomorrow, which would move a session to a different DAY. */
const LATEST_START_MINUTES = 23 * 60;

export interface PlaceableSession {
  /** Stable identity — a workout id. Used as the final sort tie-break. */
  key: string;
  category: string;
  /** The session itself, without buffers. */
  workoutSeconds: number;
  /** The time it holds right now. */
  currentTime: string;
  /** The athlete chose this time by hand; it is reserved, never moved. */
  pinned: boolean;
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

function fromMinutes(minutes: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Times read like times: displacement lands on a five-minute boundary. */
function roundUpToFive(minutes: number): number {
  return Math.ceil(minutes / 5) * 5;
}

/**
 * The calendar footprint of a session started at `startMinutes` — the SAME span
 * `computeBlock` gives the Google Calendar event, buffers included. Two sessions
 * whose footprints touch are two events the athlete cannot attend.
 */
function footprint(
  startMinutes: number,
  workoutSeconds: number,
  prefs: SchedulingPreferences,
): [number, number] {
  return [
    startMinutes - prefs.bufferBeforeMinutes,
    startMinutes + Math.ceil(workoutSeconds / 60) + prefs.bufferAfterMinutes,
  ];
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[1] && a[1] > b[0];
}

/** Do the day's sessions, at the times they hold RIGHT NOW, double-book the
 * athlete? The only trigger for re-placing a day. */
export function dayCollides(sessions: PlaceableSession[], prefs: SchedulingPreferences): boolean {
  const blocks = sessions.map((s) => footprint(toMinutes(s.currentTime), s.workoutSeconds, prefs));
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      if (overlaps(blocks[i]!, blocks[j]!)) return true;
    }
  }
  return false;
}

/**
 * Lay the day out: every session gets a start time whose footprint clears every
 * other, derived from nothing but this argument list and these preferences.
 *
 * Pinned slots are reserved first. Then each remaining session, heaviest first,
 * takes the earliest five-minute start at or after its own window time that
 * clears everything already placed — so the day's anchor gets the window time it
 * asked for and the fillers queue up behind it.
 */
export function placeDaySessions(
  date: string,
  sessions: PlaceableSession[],
  prefs: SchedulingPreferences,
): Map<string, string> {
  const placed: Array<[number, number]> = [];
  const out = new Map<string, string>();

  const pinned = [...sessions]
    .filter((s) => s.pinned)
    .sort((a, b) => toMinutes(a.currentTime) - toMinutes(b.currentTime) || a.key.localeCompare(b.key));
  for (const s of pinned) {
    placed.push(footprint(toMinutes(s.currentTime), s.workoutSeconds, prefs));
    out.set(s.key, s.currentTime);
  }

  const movable = [...sessions]
    .filter((s) => !s.pinned)
    .sort(
      (a, b) =>
        (SESSION_RANK[a.category] ?? 8) - (SESSION_RANK[b.category] ?? 8) ||
        b.workoutSeconds - a.workoutSeconds ||
        a.key.localeCompare(b.key),
    );
  for (const s of movable) {
    let start = toMinutes(windowTimeFor({ category: s.category, date }, prefs));
    // Bounded by the number of things it could possibly have to clear, so a
    // pathological day can never spin here.
    for (let guard = 0; guard <= placed.length; guard++) {
      const block = footprint(start, s.workoutSeconds, prefs);
      const hit = placed.find((p) => overlaps(block, p));
      if (!hit) break;
      const next = roundUpToFive(hit[1] + prefs.bufferBeforeMinutes);
      if (next > LATEST_START_MINUTES) {
        start = LATEST_START_MINUTES;
        break;
      }
      start = next;
    }
    placed.push(footprint(start, s.workoutSeconds, prefs));
    out.set(s.key, fromMinutes(start));
  }

  return out;
}

/** One row this pass moved (or would move), for stats and for tests. */
export interface RetimedRow {
  workoutId: string;
  date: string;
  title: string;
  from: string;
  to: string;
}

type WorkoutRow = typeof plannedWorkouts.$inferSelect;

/** The span the calendar mirror books for a row — `calendar-sync.ts`'s own
 * `source ?? fallback ?? 45min`, so placement and the event agree. */
function workoutSecondsOf(row: WorkoutRow): number {
  return row.sourceEstimatedDurationSeconds ?? row.fallbackEstimatedDurationSeconds ?? 45 * 60;
}

/**
 * Re-place every colliding day among `dates`, and report what moved.
 *
 * Scoped deliberately narrowly:
 *  - only dates on or after `from` (today) — a past day's times are history,
 *    and its event has already been and gone;
 *  - only live, `scheduled`, non-rest rows — an archived row has no event, a
 *    completed one is a story that already happened, and a rest day never
 *    books anything;
 *  - only days that collide, so a day the athlete already likes is untouched.
 */
export async function separateDayCollisions(
  db: Db,
  userId: string,
  dates: string[],
  prefs: SchedulingPreferences,
  opts: { from: string; now: string; dryRun?: boolean },
): Promise<RetimedRow[]> {
  const wanted = [...new Set(dates)].filter((d) => d >= opts.from).sort();
  if (wanted.length === 0) return [];

  // 80, not the default 90: a full 90-day import window binds one variable per
  // DATE, and this statement carries three more of its own (user, state,
  // category) against D1's ~100 ceiling. The margin is the point — the last
  // "too many SQL variables" in this repo froze the athlete's whole calendar.
  const DATE_BIND_CHUNK = 80;
  const rows: WorkoutRow[] = [];
  for (const batch of chunkIds(wanted, DATE_BIND_CHUNK)) {
    rows.push(
      ...(await db
        .select()
        .from(plannedWorkouts)
        .where(
          and(
            eq(plannedWorkouts.userId, userId),
            inArray(plannedWorkouts.effectiveDate, batch),
            isNull(plannedWorkouts.archivedAt),
            eq(plannedWorkouts.completionState, "scheduled"),
            ne(plannedWorkouts.category, "rest"),
          ),
        )),
    );
  }
  if (rows.length === 0) return [];

  // Rule 2: a `time_change` override is the athlete having picked this time of
  // day deliberately (`jobs.ts` writes that kind only when the DATE did not
  // change). A `user_move` is a day change carrying whatever time the row
  // already had, so it pins nothing — and re-placing a session on the day it
  // just moved to is exactly how it avoids landing on top of what lives there.
  const pinnedIds = new Set<string>();
  for (const batch of chunkIds(rows.map((r) => r.id), DATE_BIND_CHUNK)) {
    for (const o of await db
      .select({ workoutId: scheduleOverrides.workoutId })
      .from(scheduleOverrides)
      .where(
        and(inArray(scheduleOverrides.workoutId, batch), eq(scheduleOverrides.kind, "time_change")),
      )) {
      pinnedIds.add(o.workoutId);
    }
  }

  const byDate = new Map<string, WorkoutRow[]>();
  for (const r of rows) {
    const list = byDate.get(r.effectiveDate) ?? [];
    list.push(r);
    byDate.set(r.effectiveDate, list);
  }

  const retimed: RetimedRow[] = [];
  for (const date of [...byDate.keys()].sort()) {
    const dayRows = byDate.get(date)!;
    if (dayRows.length < 2) continue;
    const sessions: PlaceableSession[] = dayRows.map((r) => ({
      key: r.id,
      category: r.category,
      workoutSeconds: workoutSecondsOf(r),
      currentTime: r.effectiveTime,
      pinned: pinnedIds.has(r.id),
    }));
    if (!dayCollides(sessions, prefs)) continue;
    const placement = placeDaySessions(date, sessions, prefs);
    for (const r of dayRows) {
      const to = placement.get(r.id);
      if (to === undefined || to === r.effectiveTime) continue;
      retimed.push({ workoutId: r.id, date, title: r.title, from: r.effectiveTime, to });
      if (opts.dryRun) continue;
      await db
        .update(plannedWorkouts)
        .set({
          effectiveTime: to,
          // The mirror re-derives the event from the row; flipping a synced row
          // to pending is how every other in-place edit here asks for that.
          ...(r.calendarSyncState === "synced" ? { calendarSyncState: "pending" } : {}),
          updatedAt: opts.now,
        })
        .where(and(eq(plannedWorkouts.id, r.id), eq(plannedWorkouts.userId, userId)));
    }
  }
  return retimed;
}
