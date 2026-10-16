/**
 * THE OBJECTIVES BOARD'S ONE READ (Stage 3 Task 11; spec §11; principles §2.10, §5.2) — `GET /api/objectives/board`.
 *
 * Every objective the athlete keeps (any status but dropped, as read_objectives keeps them), in board order, each with:
 *  - its key results measured from logged data — the same `measureKeyResults` the progress route calls, with the same
 *    measures, so a key result's progress here is exactly that route's;
 *  - each key result's BEST EVER: the same call is also asked each measure over every logged day (`BEST_EVER_DAYS`).
 *    One call for both: `measureKeyResults` reads each source once, from the earliest window asked, and every measure
 *    keeps only its own window's points — so the windowed answers are unchanged and the best costs no statement. A best
 *    needs two points ever: one alone has nothing to beat;
 *  - the workouts that served it: done workouts (a session logged from it, or matched and completed) whose document
 *    names it (`intent.objectiveIds`), never archived, newest first, OBJECTIVE_SERVED_SHOWN at most;
 *  - the streak of weeks one was done in (`weekStreak`);
 *  - the coach's one line: the latest coach-written workout naming it (by its day, upcoming ones too), its summary. No
 *    objective holds a note of its own; a coach-written document's `intent.summary` is the coach's own sentence about
 *    what that workout is for.
 *
 * BUDGET — OBJECTIVE_BOARD_STATEMENTS at most, however many objectives and key results: the preferences (the athlete's
 * today and race date), the objectives and their key results (two, together), the measures (eight at most: four for
 * strength sets and what prescribed them, the runs, the matched runs' documents, the race days, the threshold days),
 * and one read of the workouts naming any of them over the streak's weeks. Every list is bound as one JSON text.
 */
import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { plannedWorkouts } from "@rg/database";
import {
  addDays,
  DOC_SOURCES,
  OBJECTIVE_SERVED_SHOWN,
  OBJECTIVE_STREAK_WEEKS,
  startOfIsoWeek,
  todayInZone,
  type KeyResultBest,
  type KeyResultDto,
  type KeyResultMeasure,
  type KeyResultProgress,
  type ObjectiveBoardCard,
  type ObjectiveBoardDto,
  type ObjectiveServedWorkout,
} from "@rg/domain";
import { loadPreferences } from "./calendar-sync.js";
import type { Db } from "./db.js";
import { measureKeyResults, unreadableProgress, type MeasureRequest } from "./key-result-measures.js";
import { listObjectives } from "./objectives.js";
import { PENDING_HASH } from "./watch-sets.js";

/** The most statements the board's read makes (the route adds its session's). */
export const OBJECTIVE_BOARD_STATEMENTS = 12;
/** "Every logged day": the window each measure is also asked over for its best ever. */
export const BEST_EVER_DAYS = 36_500;
/** How far ahead the coach's latest workout is looked for. */
export const NOTE_HORIZON_DAYS = 14;
/** The workouts read for the board, at most: the streak's weeks hold far fewer. */
const WORKOUT_ROWS_MAX = 500;

/**
 * Weeks in a row (Monday to Sunday) holding a done day, counted back from this week — or from last week while this one
 * has none yet: a week under way never ends a streak. Days after today count for nothing; OBJECTIVE_STREAK_WEEKS at most.
 */
export function weekStreak(doneDates: readonly string[], today: string): number {
  const weeks = new Set(doneDates.filter((d) => d <= today).map(startOfIsoWeek));
  let week = startOfIsoWeek(today);
  if (!weeks.has(week)) week = addDays(week, -7);
  let n = 0;
  while (n < OBJECTIVE_STREAK_WEEKS && weeks.has(week)) {
    n += 1;
    week = addDays(week, -7);
  }
  return n;
}

/** The best point of a series, by the key result's direction (the earliest of equals); null with fewer than two. */
function bestOf(p: KeyResultProgress, direction: KeyResultDto["direction"]): KeyResultBest | null {
  if (p.series.length < 2) return null;
  let best = p.series[0]!;
  for (const pt of p.series) if (direction === "up" ? pt.value > best.value : pt.value < best.value) best = pt;
  return { date: best.date, value: best.value, display: best.display };
}

/** The measure over every logged day; null for one with no window (a check-in, a test: nothing is measured yet). */
const everOf = (m: KeyResultMeasure): KeyResultMeasure | null => ("windowDays" in m ? { ...m, windowDays: BEST_EVER_DAYS } : null);

const isSource = (v: unknown): v is (typeof DOC_SOURCES)[number] => typeof v === "string" && (DOC_SOURCES as readonly string[]).includes(v);

function parsedIds(text: string | null): string[] {
  if (text === null) return [];
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

interface WorkoutRow {
  id: string;
  date: string;
  title: string;
  completion: string;
  source: string | null;
  objectiveIds: string | null;
  summary: string | null;
  loggedOn: string | null;
}

/** The account's workouts in [from, to] whose document names any of `ids`, never archived; latest day first. */
async function workoutsNaming(db: Db, userId: string, ids: readonly string[], from: string, to: string): Promise<WorkoutRow[]> {
  const pw = plannedWorkouts;
  return db
    .select({
      id: pw.id,
      date: pw.effectiveDate,
      title: pw.title,
      completion: pw.completionState,
      source: sql<string | null>`json_extract(${pw.workoutDoc}, '$.source.kind')`,
      objectiveIds: sql<string | null>`json_extract(${pw.workoutDoc}, '$.intent.objectiveIds')`,
      summary: sql<string | null>`json_extract(${pw.workoutDoc}, '$.intent.summary')`,
      // The day a session was logged from it (one still being written is not there yet). Spelled out with an alias: a
      // column in a select list renders unqualified, and inside this subquery "id" would be the session's own.
      loggedOn: sql<string | null>`(select max(ls.local_date) from performed_sessions ls
        where ls.user_id = ${userId} and ls.workout_id = planned_workouts.id and ls.payload_hash != ${PENDING_HASH})`,
    })
    .from(pw)
    .where(
      and(
        eq(pw.userId, userId),
        isNull(pw.archivedAt),
        gte(pw.effectiveDate, from),
        lte(pw.effectiveDate, to),
        isNotNull(pw.workoutDoc),
        sql`json_valid(${pw.workoutDoc}) and json_type(${pw.workoutDoc}, '$.intent.objectiveIds') = 'array'
          and exists (select 1 from json_each(${pw.workoutDoc}, '$.intent.objectiveIds') o
            where o.value in (select value from json_each(${JSON.stringify(ids)})))`,
      ),
    )
    .orderBy(desc(pw.effectiveDate), desc(pw.effectiveTime), asc(pw.id))
    .limit(WORKOUT_ROWS_MAX);
}

/** The board, on the athlete's today (or `opts.today`). */
export async function objectiveBoard(db: Db, userId: string, opts: { today?: string } = {}): Promise<ObjectiveBoardDto> {
  const [prefs, all] = await Promise.all([loadPreferences(db, userId), listObjectives(db, userId)]);
  const today = opts.today ?? todayInZone(prefs.timezone);
  const objectives = all.filter((o) => o.status !== "dropped");
  if (objectives.length === 0) return { today, objectives: [] };

  // Each measurable key result asked twice in one call: over its window, and over every logged day.
  const krs = objectives.flatMap((o) => o.keyResults);
  const requests: MeasureRequest[] = [];
  const at = new Map<string, { window: number; ever: number | null }>();
  for (const k of krs) {
    if (k.measure === null) continue;
    const window = requests.push({ measure: k.measure, unit: k.unit }) - 1;
    const ever = everOf(k.measure);
    at.set(k.id, { window, ever: ever ? requests.push({ measure: ever, unit: k.unit }) - 1 : null });
  }
  const weekFrom = addDays(startOfIsoWeek(today), -7 * OBJECTIVE_STREAK_WEEKS);
  const [measured, rows] = await Promise.all([
    requests.length > 0 ? measureKeyResults(db, userId, requests, { today, raceDate: prefs.raceDate }) : Promise.resolve([]),
    workoutsNaming(
      db,
      userId,
      objectives.map((o) => o.id),
      weekFrom,
      addDays(today, NOTE_HORIZON_DAYS),
    ),
  ]);

  const naming = new Map<string, WorkoutRow[]>();
  for (const r of rows) for (const id of new Set(parsedIds(r.objectiveIds))) naming.set(id, [...(naming.get(id) ?? []), r]);

  const cards: ObjectiveBoardCard[] = objectives.map((objective) => {
    const mine = naming.get(objective.id) ?? [];
    // Done on the day its session was logged (an upcoming one played early counts that day), else on its own day.
    const done = mine
      .filter((r) => r.loggedOn !== null || r.completion === "completed")
      .map((r) => ({ r, on: r.loggedOn ?? r.date }))
      .filter((d) => d.on <= today)
      .sort((a, b) => b.on.localeCompare(a.on) || b.r.date.localeCompare(a.r.date) || a.r.id.localeCompare(b.r.id));
    const served: ObjectiveServedWorkout[] = done.slice(0, OBJECTIVE_SERVED_SHOWN).map(({ r, on }) => ({
      workoutId: r.id,
      date: on,
      title: r.title,
      source: isSource(r.source) ? r.source : null,
    }));
    // Rows come latest day first: the first coach-written one is the coach's latest.
    const coach = mine.find((r) => r.source === "coach" && typeof r.summary === "string" && r.summary.trim() !== "");
    return {
      objective,
      keyResults: objective.keyResults.map((keyResult) => {
        const i = at.get(keyResult.id);
        const progress = i ? measured[i.window]! : unreadableProgress(keyResult.unit);
        const ever = i && i.ever !== null ? measured[i.ever]! : null;
        return { keyResult, progress, best: ever ? bestOf(ever, keyResult.direction) : null };
      }),
      served,
      streakWeeks: weekStreak(
        done.map((d) => d.on),
        today,
      ),
      note: coach ? { text: coach.summary!.trim(), workoutId: coach.id, date: coach.date } : null,
    };
  });
  return { today, objectives: cards };
}
