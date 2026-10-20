/**
 * WHERE A SUGGESTION'S WORKOUTS WILL SIT ONCE APPROVED (fix wave 3B, B-I1; the lead's case from Part U's QA: a set's
 * line said "Sat 8 AM" and Approve put it at "Sat 10:30 AM"). The card's line carries the time the approve will use,
 * read from the same rules the approve's writes follow, in the same order:
 *
 *  1. The suggestion's open changes first, as the thread coach's applier makes them (coach-apply.ts): a skip takes the
 *     session off its day, a length gives it its new minutes, a move takes it to its new day and time (pinned when only
 *     the time changed, as jobs.ts pins a time change) — then each day they touched laid out again if it collides.
 *  2. Then each open workout, in the suggestion's order, as the Studio's own create and revise make it
 *     (doc-workouts.ts): a new one at the time `approveTimeOf` gives it — pinned when asked for or placed now, no pass;
 *     else at the athlete's window, its day then laid out again if it collides — under the row id its approve makes it
 *     with (`keyedRowId` of `approvalKey`), so a tie in the layout breaks the same way; a revision with its document's
 *     minutes, its day laid out again when its booked length changed.
 *
 * "Laid out again" is day-placement.ts `relaidDay`, the one rule `separateDayCollisions` writes by. Only days from today
 * on, and only scheduled sessions that aren't rest, as that pass reads them. The plan's rows come from ONE scalar
 * subquery (`dayRowsSql`) the manifest's read carries, so the card's read costs no statement more.
 */
import { sql, type SQL } from "drizzle-orm";
import type { SchedulingPreferences } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { deriveDoc } from "@rg/workout";
import { relaidDay, type PlaceableSession } from "./day-placement.js";
import { approveTimeOf } from "./design-time.js";
import type { DocWorkoutOp } from "./design-tools/propose.js";
import { keyedRowId } from "./doc-workouts.js";
import { isDocWorkoutOp, isPlanAdjustOp, type PlanAdjustOp } from "./proposal-kinds.js";
import { bookedSeconds } from "./session-build.js";

/** The key a new op's workout is made under (createDocWorkout's `clientId`): the approve's, and this read's. */
export const approvalKey = (proposalId: string, opId: string): string => `approve:${proposalId}:${opId}`;

/** A designed op still the athlete's to decide (no outcome yet, or refused: a refused op stays open). */
const open = (op: unknown): boolean => {
  const o = (op as { outcome?: { status?: string } } | null)?.outcome;
  return !o || o.status === "refused";
};

/** A row of the plan as `dayRowsSql` gives it. */
interface DayRow {
  id: string;
  date: string;
  time: string;
  category: string;
  source: number | null;
  fallback: number | null;
  block: number | null;
  state: string;
  pinned: number | boolean;
}

/**
 * The plan rows the placement reads, as one scalar subquery (JSON): every row on a day an open op lands on or touches,
 * and every row an open change or revision names — with whether a time change pins it. `null` when there are none.
 */
export function dayRowsSql(userId: string, ops: readonly unknown[]): SQL {
  const dates = new Set<string>();
  const ids = new Set<string>();
  for (const op of ops) {
    if (isDocWorkoutOp(op) && open(op)) {
      const w = op as DocWorkoutOp;
      dates.add(w.date);
      if (w.target.kind === "revise") ids.add(w.target.workoutId);
    } else if (isPlanAdjustOp(op) && open(op)) {
      const c = op as PlanAdjustOp;
      ids.add(c.op.workoutId);
      dates.add(c.date);
      if (c.op.kind === "move") dates.add(c.op.toDate);
    }
  }
  if (dates.size === 0 && ids.size === 0) return sql`null`;
  const list = (xs: Set<string>) => (xs.size > 0 ? sql.join([...xs].map((x) => sql`${x}`), sql`, `) : sql`null`);
  return sql`(select json_group_array(json_object('id', pw.id, 'date', pw.effective_date, 'time', pw.effective_time, 'category', pw.category,
      'source', pw.source_estimated_duration_seconds, 'fallback', pw.fallback_estimated_duration_seconds, 'block', pw.calendar_block_duration_seconds,
      'state', pw.completion_state,
      'pinned', exists (select 1 from schedule_overrides o where o.workout_id = pw.id and o.kind = 'time_change')))
    from planned_workouts pw where pw.user_id = ${userId} and pw.archived_at is null
      and (pw.effective_date in (${list(dates)}) or pw.id in (${list(ids)})))`;
}

interface Sim {
  date: string;
  session: PlaceableSession;
  block: number | null;
  source: number | null;
}

/**
 * The time each open workout of a suggestion will hold once the athlete approves it all now (see the module comment),
 * by op id. `rowsJson`: `dayRowsSql`'s column. An op the approve would refuse has none.
 */
export async function placedTimes(
  userId: string,
  proposalId: string,
  ops: readonly unknown[],
  rowsJson: unknown,
  at: { now: Date; today: string; prefs: SchedulingPreferences },
): Promise<Map<string, string>> {
  let rows: DayRow[] = [];
  try {
    const v = typeof rowsJson === "string" ? (JSON.parse(rowsJson) as unknown) : rowsJson;
    if (Array.isArray(v)) rows = v as DayRow[];
  } catch {
    // Nothing to read: every workout at the time its own rule gives it.
  }
  const sims = new Map<string, Sim>();
  for (const r of rows) {
    if (r.state !== "scheduled" || r.category === "rest") continue;
    sims.set(r.id, {
      date: r.date,
      block: r.block,
      source: r.source,
      session: { key: r.id, category: r.category, workoutSeconds: r.source ?? r.fallback ?? 45 * 60, currentTime: r.time, pinned: r.pinned === 1 || r.pinned === true },
    });
  }
  /** Lay `date` out again when it collides (and is today or later), as the pass after a write does. */
  const pass = (date: string) => {
    if (date < at.today) return;
    const day = [...sims.values()].filter((s) => s.date === date);
    const layout = relaidDay(date, day.map((s) => s.session), at.prefs);
    if (!layout) return;
    for (const s of day) s.session.currentTime = layout.get(s.session.key) ?? s.session.currentTime;
  };

  // 1. The changes, through the applier: then one pass over the days they touched.
  const touched = new Set<string>();
  for (const any of ops) {
    if (!isPlanAdjustOp(any) || !open(any)) continue;
    const c = (any as PlanAdjustOp).op;
    const s = sims.get(c.workoutId);
    if (!s) continue;
    if (c.kind === "skip" || c.kind === "remove") {
      sims.delete(c.workoutId);
    } else if (c.kind === "adjust" || c.kind === "ease") {
      // An ease is the session rewritten (the new shape §5): its length is the eased session's.
      s.source = null;
      // A length re-timed by the rule is the rule's (the card's), which the counts may leave off the coach's.
      s.session.workoutSeconds = (c.kind === "ease" ? c.session.durationMinutes : ((any as PlanAdjustOp).retime?.minutes ?? c.durationMinutes)) * 60;
      touched.add(s.date);
    } else if (c.kind === "restore") {
      // A restore's session is skipped until approved: not among the day's sessions here.
      continue;
    } else {
      const toTime = c.toTime ?? s.session.currentTime;
      // jobs.ts pins a time change, never a day's (a moved day carries its time; the pass may move it).
      s.session.pinned = s.session.pinned || (c.toDate === s.date && toTime !== s.session.currentTime);
      s.date = c.toDate;
      s.session.currentTime = toTime;
      touched.add(c.toDate);
    }
  }
  for (const d of [...touched].sort()) pass(d);

  // 2. The workouts, in the suggestion's order, as the Studio's create and revise make them.
  const out = new Map<string, string>();
  const keys = new Map<string, string>();
  for (const any of ops) {
    if (!isDocWorkoutOp(any) || !open(any)) continue;
    const op = any as DocWorkoutOp;
    const opId = op.by.runId;
    const derived = deriveDoc(op.doc, EXERCISES);
    const seconds = derived.estimatedMinutes * 60;
    if (op.target.kind === "new") {
      if (op.date < at.today) continue;
      const placed = approveTimeOf(op.target, derived.category, at);
      if ("refused" in placed) continue;
      const key = await keyedRowId(userId, approvalKey(proposalId, opId));
      keys.set(opId, key);
      sims.set(key, {
        date: op.date,
        block: bookedSeconds(seconds),
        source: null,
        session: { key, category: derived.category, workoutSeconds: seconds, currentTime: placed.time, pinned: placed.pinned },
      });
      // A time asked for stands, and no pass runs; the window gives way to what the day holds.
      if (!placed.pinned) pass(op.date);
    } else {
      const s = sims.get(op.target.workoutId);
      if (!s) continue;
      keys.set(opId, op.target.workoutId);
      const booked = bookedSeconds(seconds);
      s.session.category = derived.category;
      s.session.workoutSeconds = s.source ?? seconds;
      if (booked !== s.block) {
        s.block = booked;
        pass(s.date);
      }
    }
  }
  for (const [opId, key] of keys) {
    const s = sims.get(key);
    if (s) out.set(opId, s.session.currentTime);
  }
  return out;
}
