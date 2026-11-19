/**
 * THE PLAN READ, FACTORED (DESIGN-2c §7.1): one query of a range's planned rows and one of their standing matches, read once
 * and mapped twice — to the LifeOS plan read's v1 (`GET /api/lifeos/plan`, the Mac's token, exactly as it answered before)
 * and to the phone's days (`GET /api/native/days`, the device's `training-v4`). So the two reads can't drift.
 *
 * Reads only: nothing here writes, settles, matches, builds, writes an outline or reads the garden. `completion_state` and
 * the rest are read as stored; reconcile resolves a past day within the hour, and the read says what it finds.
 *
 * What it costs (§2.1): the rows, with the plan's kind and name joined by the account and "under way" as a column (one
 * statement); the standing matches, each with its activity's start and source, held to the account's own activities (one
 * statement a chunk of `IN_ARRAY_CHUNK` ids); and, for the phone's days, the extras (one statement, bounded by
 * `start_time`) and the COROS connection's last read (one).
 */
import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { activities, plannedWorkouts, programs, providerConnections, workoutCompletionMatches } from "@rg/database";
import { addDays, humanizeWorkoutTitle, looksLikeCodeTitle, sportLabel } from "@rg/domain";
import { ATHLETE_SAID_DONE } from "./course-number.js";
import { unwrittenCourseOutline } from "./course-sessions.js";
import { chunkIds, type Db } from "./db.js";
import { extraSessionsOn } from "./garden-sync.js";
import { guardRefusal, underWayNow, underWaySql } from "./session-guard.js";
import { sessionContent, sessionKind, type SessionContent, type SessionKind } from "./session-kind.js";

const pw = plannedWorkouts;

/** A planned time, `HH:MM`. */
const TIME = /^\d{2}:\d{2}$/;

/** A planned row as both reads take it: no document, no JSON column it doesn't need. */
export interface PlanRow {
  id: string;
  title: string;
  sport: string;
  category: string;
  qualitySubtype: string | null;
  effectiveDate: string;
  effectiveTime: string;
  originalPlanDate: string;
  sourceEstimatedDurationSeconds: number | null;
  fallbackEstimatedDurationSeconds: number | null;
  completionState: string;
  sanctionedBy: string | null;
  origin: string | null;
  contentState: string | null;
  courseSession: number | null;
  /** The plan's kind and name, joined by the account (null: no plan of the account's by that id). */
  planKind: string | null;
  planName: string | null;
  /** 1 when the row holds a document. */
  hasDoc: number;
  /** The document's revision while the row holds one (`/today`'s rule), else null. */
  docRev: number | null;
  /** `underWaySql()`'s read: null for a row not started. */
  underWay: unknown;
  /** 1 when the row has a stage summary. */
  hasStages: number;
}

/**
 * The account's live planned rows dated `from`…`to` (not archived; rest rows included — both reads say a rest day): one
 * statement. The plan's kind and name are joined as `/today` joins them, by the account (`courseOf`'s read of the plan).
 */
export async function readPlanRows(db: Db, userId: string, from: string, to: string): Promise<PlanRow[]> {
  return db
    .select({
      id: pw.id,
      title: pw.title,
      sport: pw.sport,
      category: pw.category,
      qualitySubtype: pw.qualitySubtype,
      effectiveDate: pw.effectiveDate,
      effectiveTime: pw.effectiveTime,
      originalPlanDate: pw.originalPlanDate,
      sourceEstimatedDurationSeconds: pw.sourceEstimatedDurationSeconds,
      fallbackEstimatedDurationSeconds: pw.fallbackEstimatedDurationSeconds,
      completionState: pw.completionState,
      sanctionedBy: pw.sanctionedBy,
      origin: pw.origin,
      contentState: pw.contentState,
      courseSession: pw.courseSession,
      planKind: programs.kind,
      planName: programs.name,
      hasDoc: sql<number>`(${pw.workoutDoc} is not null)`,
      docRev: sql<number | null>`case when ${pw.workoutDoc} is not null then ${pw.workoutDocRev} end`,
      underWay: sql<unknown>`${underWaySql()}`,
      hasStages: sql<number>`(${pw.stageSummary} is not null)`,
    })
    .from(pw)
    .leftJoin(programs, and(eq(programs.id, pw.planId), eq(programs.userId, pw.userId)))
    .where(and(eq(pw.userId, userId), gte(pw.effectiveDate, from), lte(pw.effectiveDate, to), isNull(pw.archivedAt)))
    .all();
}

/** A workout's standing match, as the reads use it: its activity's start and source. */
export interface StandingMatch {
  startTime: string;
  source: string;
}

/**
 * The standing match of each of these workouts: its activity's start and source, held to the account's own activities.
 * Two standing matches on one workout (nothing forbids it): the earlier start, as the plan read has always said.
 */
export async function standingMatches(db: Db, userId: string, ids: readonly string[]): Promise<Map<string, StandingMatch>> {
  const out = new Map<string, StandingMatch>();
  for (const chunk of chunkIds([...ids])) {
    const matches = await db
      .select({ workoutId: workoutCompletionMatches.workoutId, startTime: activities.startTime, source: activities.source })
      .from(workoutCompletionMatches)
      .innerJoin(activities, and(eq(activities.id, workoutCompletionMatches.activityId), eq(activities.userId, userId)))
      .where(and(inArray(workoutCompletionMatches.workoutId, chunk), isNull(workoutCompletionMatches.undoneAt)))
      .all();
    for (const m of matches) {
      const seen = out.get(m.workoutId);
      if (seen === undefined || m.startTime < seen.startTime) out.set(m.workoutId, { startTime: m.startTime, source: m.source });
    }
  }
  return out;
}

/** The rows' standing matches: the training rows', never a rest row's. */
export const matchesOfRows = (db: Db, userId: string, rows: readonly PlanRow[]) =>
  standingMatches(db, userId, rows.filter((r) => r.category !== "rest").map((r) => r.id));

/** Timed sessions first, by time; then untimed ones; then by id — both reads' order (and `/today`'s). */
const byTime = (a: PlanRow, b: PlanRow): number => {
  const at = TIME.test(a.effectiveTime);
  const bt = TIME.test(b.effectiveTime);
  if (at !== bt) return at ? -1 : 1;
  return a.effectiveTime.localeCompare(b.effectiveTime) || a.id.localeCompare(b.id);
};

const timeOf = (r: PlanRow): string | null => (TIME.test(r.effectiveTime) ? r.effectiveTime : null);
const minutesOf = (r: PlanRow): number | null => {
  const seconds = r.sourceEstimatedDurationSeconds ?? r.fallbackEstimatedDurationSeconds;
  return seconds == null ? null : Math.round(seconds / 60);
};

/** Each day `from`…`to` in order, once: its rest row's word and its training rows, ordered. */
function eachDay<T>(rows: readonly PlanRow[], from: string, to: string, make: (date: string, rest: boolean, sessions: PlanRow[]) => T): T[] {
  const out: T[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const today = rows.filter((r) => r.effectiveDate === date);
    out.push(make(date, today.some((r) => r.category === "rest"), today.filter((r) => r.category !== "rest").sort(byTime)));
  }
  return out;
}

// ── The LifeOS plan read's v1 (`GET /api/lifeos/plan`), exactly as it was ─────────────────────────────────────────

export interface LifeosSession {
  id: string;
  title: string;
  sport: string;
  category: string;
  /** `HH:MM`, or null when the plan gives no time. */
  time: string | null;
  /** The planned duration, rounded; null when unknown. */
  minutes: number | null;
  /** scheduled | unresolved | completed | skipped | missed */
  state: string;
  /** When the matched activity started (ISO 8601), while the match stands. */
  doneAt: string | null;
}

export interface LifeosDay {
  date: string;
  /** A rest row is planned that day. */
  rest: boolean;
  sessions: LifeosSession[];
}

const v1Session = (r: PlanRow, matches: ReadonlyMap<string, StandingMatch>): LifeosSession => ({
  id: r.id,
  title: r.title,
  sport: r.sport,
  category: r.category,
  time: timeOf(r),
  minutes: minutesOf(r),
  state: r.completionState,
  doneAt: matches.get(r.id)?.startTime ?? null,
});

/** The plan read's days (v1). */
export function planDaysV1(rows: readonly PlanRow[], matches: ReadonlyMap<string, StandingMatch>, from: string, to: string): LifeosDay[] {
  return eachDay(rows, from, to, (date, rest, sessions) => ({ date, rest, sessions: sessions.map((r) => v1Session(r, matches)) }));
}

// ── The phone's days (`GET /api/native/days`, DESIGN-2c §2.1) ───────────────────────────────────────────────────

export interface DeviceSession {
  id: string;
  /** As stored: LifeOS's drafted blocks and Link's candidates match on it. */
  title: string;
  /** Present only when the web's humanized name differs (an opaque COROS code in words): display only. */
  label?: string;
  sport: string;
  category: string;
  time: string | null;
  minutes: number | null;
  /** `completion_state` as stored, a later word passed as sent. */
  state: string;
  doneAt: string | null;
  doneBy: "app" | "coros" | "said_done" | null;
  movedFrom: string | null;
  kind: SessionKind;
  planName: string | null;
  content: SessionContent;
  written: boolean;
  docRev: number | null;
  underWay: boolean;
  /** Advice only, like `written`: what the plan routes would take now, by the guard's own rule. The routes decide again. */
  can: { move: boolean; skip: boolean; unskip: boolean };
}

export interface DeviceExtra {
  id: string;
  sport: "run" | "strength" | "yoga";
  /** In words (`activityDisplayTitle`'s rule): an opaque code reads as the sport. */
  title: string;
  /** The local start, `HH:MM`; null for an activity with no local start time (it is dated by its UTC start). */
  time: string | null;
  seconds: number;
  /** A run's distance; null for any other sport. */
  distanceMeters: number | null;
  source: string;
}

export interface DeviceDay {
  date: string;
  tense: "past" | "today" | "ahead";
  rest: boolean;
  /** Null, or "capped" when the day held more than `DAY_SESSIONS_CAP` sessions or `DAY_EXTRAS_CAP` extras. */
  partial: "capped" | null;
  sessions: DeviceSession[];
  extras: DeviceExtra[];
}

/** A day's bounds (§2.1 `partial`): never reached on a real plan, and said when they apply. */
export const DAY_SESSIONS_CAP = 30;
export const DAY_EXTRAS_CAP = 20;

/** The states a session the phone may move or skip is in (Move's `from`, `stillAsSeen`'s planned states). */
const PLANNED = ["scheduled", "unresolved"];

/** A day's tense against the account's today — never the phone's clock. */
export const tenseOf = (date: string, today: string): DeviceDay["tense"] => (date < today ? "past" : date === today ? "today" : "ahead");

function deviceSession(r: PlanRow, match: StandingMatch | undefined, today: string): DeviceSession {
  const shown = humanizeWorkoutTitle(r.title, r.category, r.qualitySubtype);
  const kind = sessionKind(r);
  const underWay = underWayNow(r, r.underWay, today);
  const refused = guardRefusal(r, today) !== null;
  const planned = PLANNED.includes(r.completionState);
  const doneBy =
    r.completionState !== "completed"
      ? null
      : match
        ? match.source === "app"
          ? "app"
          : "coros"
        : r.sanctionedBy === ATHLETE_SAID_DONE
          ? "said_done"
          : null;
  return {
    id: r.id,
    title: r.title,
    ...(shown !== r.title ? { label: shown } : {}),
    sport: r.sport,
    category: r.category,
    time: timeOf(r),
    minutes: minutesOf(r),
    state: r.completionState,
    doneAt: match?.startTime ?? null,
    doneBy,
    movedFrom: r.originalPlanDate !== r.effectiveDate ? r.originalPlanDate : null,
    kind,
    planName: kind === "course" || kind === "programme" || kind === "watch_plan" ? r.planName : null,
    content: sessionContent(r),
    written: !unwrittenCourseOutline(r, r.planKind),
    docRev: r.docRev ?? null,
    underWay,
    can: {
      move: !refused && r.category !== "race" && planned,
      skip: !refused && planned,
      unskip: r.completionState === "skipped",
    },
  };
}

/** An activity as the phone's extras read it. */
export interface ExtraActivity {
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

/**
 * The account's activities that may be extras on `from`…`to`: bounded by `start_time` (indexed) from the day before `from`
 * to two days after `to`, so every activity whose local day is in the range is read whatever its zone; then dated in code
 * by run-garden's own rule (`extraSessionsOn`). One statement.
 */
export async function readExtraActivities(db: Db, userId: string, from: string, to: string): Promise<ExtraActivity[]> {
  return await db
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
    .where(and(eq(activities.userId, userId), gte(activities.startTime, addDays(from, -1)), lt(activities.startTime, addDays(to, 2))))
    .orderBy(asc(activities.startTime), asc(activities.id))
    .all();
}

/** An activity's local start, `HH:MM`, or null when it has no local start time. */
export const localTimeOf = (a: { startTimeLocal: string | null }): string | null => {
  const t = a.startTimeLocal?.slice(11, 16) ?? null;
  return t !== null && TIME.test(t) ? t : null;
};

/** An activity's title in words (misc.ts's `activityDisplayTitle`): an opaque code reads as the sport. */
export const activityTitle = (title: string | null, sport: string): string => (title && !looksLikeCodeTitle(title) ? title : sportLabel(sport));

const deviceExtra = (a: ExtraActivity & { sport: DeviceExtra["sport"] }): DeviceExtra => ({
  id: a.id,
  sport: a.sport,
  title: activityTitle(a.title, a.sport),
  time: localTimeOf(a),
  seconds: a.durationSeconds,
  distanceMeters: a.sport === "run" ? (a.distanceMeters ?? null) : null,
  source: a.source,
});

/**
 * The phone's days `from`…`to`: each day once, in order, with its tense against `today`, its sessions and its extras. An
 * extra is listed only on a day gone or today: a day ahead has none to list (a session can't be done ahead of its day).
 */
export function deviceDays(
  rows: readonly PlanRow[],
  matches: ReadonlyMap<string, StandingMatch>,
  acts: readonly ExtraActivity[],
  from: string,
  to: string,
  today: string,
): DeviceDay[] {
  return eachDay(rows, from, to, (date, rest, sessions) => {
    const tense = tenseOf(date, today);
    const extras = tense === "ahead" ? [] : extraSessionsOn(acts, date);
    const capped = sessions.length > DAY_SESSIONS_CAP || extras.length > DAY_EXTRAS_CAP;
    return {
      date,
      tense,
      rest,
      partial: capped ? "capped" : null,
      sessions: sessions.slice(0, DAY_SESSIONS_CAP).map((r) => deviceSession(r, matches.get(r.id), today)),
      extras: extras.slice(0, DAY_EXTRAS_CAP).map(deviceExtra),
    };
  });
}

/** The COROS connection's last read (`last_sync_at`), selected alone — never its tokens. Null when there is none. */
export async function corosReadAt(db: Db, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ lastSyncAt: providerConnections.lastSyncAt })
    .from(providerConnections)
    .where(and(eq(providerConnections.userId, userId), eq(providerConnections.provider, "coros")))
    .limit(1);
  return row?.lastSyncAt ?? null;
}
