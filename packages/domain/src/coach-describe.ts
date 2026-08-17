import {
  addOpDates,
  formatExercise,
  formatExerciseBlock,
  type CoachExerciseBlock,
  type CoachOp,
  type CoachRunBlock,
  type CoachSession,
} from "./coach.js";
import { isoWeekday } from "./time.js";

/**
 * THE MANIFEST: what a proposal actually does, computed from its ops.
 *
 * The rule this file exists to enforce is THE MODEL NEVER STATES A FACT THE
 * SYSTEM CAN COMPUTE. Live, 2026-08-17: a briefing described a ten-minute
 * mobility piece "on four days" while its one multi-date `add` carried a
 * primary `date` plus three more in `dates` — a claim only a careful reader
 * of raw JSON could check, because the proposal card rendered a title, one
 * evidence line, a flag and two buttons, and summarised three operations
 * with the single word "Mixed". Prose was the only place the manifest lived,
 * and prose counts drift. (The briefing was, that time, right; the review
 * that called it wrong by one had itself missed that `date` is a date. Two
 * readers, opposite errors, same cause: nobody could see the list.)
 *
 * So the briefing keeps the reasoning — why this, why now, what it costs —
 * and every enumerable fact comes from here instead. The wake prompt's
 * HONESTY block forbids the model from narrating any of it.
 *
 * Pure, total, and deliberately dumb: no dates are invented, nothing is
 * counted that the ops do not already say, and every op kind in the
 * discriminated union produces at least one line (the `never` check below
 * makes a new kind a compile error, and coach-describe.test.ts makes it a
 * test failure).
 */

export interface OpLine {
  /** ISO date this line concerns, or null for plan-level ops. */
  date: string | null;
  /** One-line human summary, e.g. "Ski legs — holds and eccentrics · 40 min" */
  summary: string;
  /** What changes, e.g. "6×600m at 10K pace → Easy 35 — legs back under you". */
  change: string | null;
  /** Session contents, already formatted, e.g. "Wall Sit 3×45s". Empty for non-session ops. */
  detail: string[];
  /** Which op produced this line, for grouping/keys. */
  kind: CoachOp["kind"];
}

/**
 * What the plan holds TODAY for a workout an op names by id.
 *
 * `ease`, `move` and `skip` carry a `workoutId` and nothing else about the
 * session they touch: the op says what a day BECOMES, never what it was, and
 * not even which day it is on. Both facts live in `planned_workouts`, so a
 * caller that has them (the coach panel already builds a workoutId → date
 * map for its calendar ghosts) can hand them over and get "6×600m at 10K
 * pace → Easy 35" on the right day instead of an undated "rewrites the
 * session already planned".
 *
 * Optional on purpose: `describeOps(ops)` alone is complete and honest — it
 * simply says less about the sessions whose previous state is not in the ops.
 */
export interface PlannedRef {
  /** The day it currently sits on. */
  date?: string;
  /** What it is today — its title, or the richer stageSummary. */
  summary?: string;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Thu 20 Aug" — for the few lines whose prose must name ANOTHER day than
 * their own (a swap's partner, a move's origin). Every other date reaches the
 * UI as `line.date`, which the UI formats however it likes. */
function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${WEEKDAYS[isoWeekday(iso) - 1]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function sessionSummary(s: CoachSession): string {
  return `${s.title} · ${s.durationMinutes} min`;
}

/** The block, exercise by exercise — or, for a circuit, as the one line that
 * says it is a circuit. Both come from the session-sheet formatters in
 * coach.ts, so the manifest and the sheet cannot disagree about what
 * "3×8/side @ 4s down" means. */
function blockDetail(b: CoachExerciseBlock): string[] {
  return b.rounds ? [formatExerciseBlock(b)] : b.exercises.map(formatExercise);
}

function runBlockDetail(b: CoachRunBlock): string {
  const work =
    b.kind === "duration"
      ? `${b.value} min`
      : b.value >= 1000
        ? `${Number((b.value / 1000).toFixed(2))} km`
        : `${b.value} m`;
  return b.intensity ? `${work} ${b.intensity}` : work;
}

function sessionDetail(s: CoachSession): string[] {
  const block = s.lift ?? s.mobility;
  if (block) return blockDetail(block);
  if (s.run) return s.run.blocks.map(runBlockDetail);
  return [];
}

function shapeWeekLine(
  wk: { weekStart: string; volumeTarget: string; keySessions: string[] },
  kind: OpLine["kind"],
): OpLine {
  return {
    date: wk.weekStart,
    summary: `Week of ${dayLabel(wk.weekStart)} — ${wk.volumeTarget}`,
    change: wk.keySessions.length > 0 ? `sketched: ${wk.keySessions.join(" · ")}` : null,
    detail: [],
    kind,
  };
}

function datedSessionLines(
  sessions: Array<{ date: string; session: CoachSession }>,
  kind: OpLine["kind"],
): OpLine[] {
  return sessions.map((s) => ({
    date: s.date,
    summary: sessionSummary(s.session),
    change: null,
    detail: sessionDetail(s.session),
    kind,
  }));
}

/**
 * One `OpLine` per thing that changes, chronological, plan-level last.
 *
 * A multi-date `add` expands to ONE LINE PER DATE — the expansion is the
 * whole point of the file, because "how many days" is exactly the fact prose
 * gets wrong, and `addOpDates` is the same reader `applyOps` uses to write
 * the sessions. What the manifest lists is therefore what approval creates.
 *
 * `planned` is optional context (see PlannedRef): without it the lines for
 * id-addressed ops say what the day becomes but not what it was.
 */
export function describeOps(ops: CoachOp[], planned?: ReadonlyMap<string, PlannedRef>): OpLine[] {
  const lines: OpLine[] = [];
  for (const op of ops) {
    switch (op.kind) {
      case "ease": {
        const was = planned?.get(op.workoutId);
        lines.push({
          date: was?.date ?? null,
          summary: sessionSummary(op.session),
          change: was?.summary
            ? `${was.summary} → ${op.session.title}`
            : "rewrites the session already on this day",
          detail: sessionDetail(op.session),
          kind: op.kind,
        });
        break;
      }
      case "move": {
        const from = planned?.get(op.workoutId);
        const what = from?.summary ?? "The session planned for this day";
        // Two days change, so two lines — the same shape the calendar's
        // outgoing/incoming ghosts already use.
        if (from?.date && from.date !== op.toDate) {
          lines.push({
            date: from.date,
            summary: what,
            change: `moves to ${dayLabel(op.toDate)}`,
            detail: [],
            kind: op.kind,
          });
        }
        lines.push({
          date: op.toDate,
          summary: what,
          change: from?.date ? `moves here from ${dayLabel(from.date)}` : "moves here from its planned day",
          detail: [],
          kind: op.kind,
        });
        break;
      }
      case "swap": {
        for (const [day, other] of [
          [op.dayA, op.dayB],
          [op.dayB, op.dayA],
        ] as const) {
          lines.push({
            date: day,
            summary: `Swaps days with ${dayLabel(other)}`,
            change: `this day's session and ${dayLabel(other)}'s trade places`,
            detail: [],
            kind: op.kind,
          });
        }
        break;
      }
      case "skip": {
        const was = planned?.get(op.workoutId);
        lines.push({
          date: was?.date ?? null,
          summary: was?.summary ? `${was.summary} — skipped` : "A planned session is skipped",
          change: `comes off the plan — ${op.reason}`,
          detail: [],
          kind: op.kind,
        });
        break;
      }
      case "add": {
        // THE EXPANSION. One session, N dates, N lines — `date` is a date
        // like any other, which is precisely what a prose count forgets.
        for (const date of addOpDates(op)) {
          lines.push({
            date,
            summary: sessionSummary(op.session),
            change: null,
            detail: sessionDetail(op.session),
            kind: op.kind,
          });
        }
        break;
      }
      case "reshapeWeek": {
        lines.push({
          date: op.weekStart,
          summary: `Week of ${dayLabel(op.weekStart)} rewritten`,
          change: "everything already planned that week comes off",
          detail: [],
          kind: op.kind,
        });
        lines.push(...datedSessionLines(op.sessions, op.kind));
        break;
      }
      case "firmUp": {
        lines.push({
          date: op.weekStart,
          summary: `Week of ${dayLabel(op.weekStart)} — sketch becomes real sessions`,
          change: null,
          detail: [],
          kind: op.kind,
        });
        lines.push(...datedSessionLines(op.sessions, op.kind));
        break;
      }
      case "extendPlan": {
        for (const wk of op.shapeWeeks) lines.push(shapeWeekLine(wk, op.kind));
        break;
      }
      case "windDown": {
        const first = op.sessions.map((s) => s.date).sort()[0] ?? null;
        lines.push({
          date: first,
          summary: "Wind-down",
          change: "what is still planned in these weeks comes off, replaced by the sessions below",
          detail: [],
          kind: op.kind,
        });
        lines.push(...datedSessionLines(op.sessions, op.kind));
        break;
      }
      case "createPlan": {
        lines.push({
          date: op.startDate,
          summary: `New plan: ${op.name} · ${dayLabel(op.startDate)} to ${dayLabel(op.endDate)}`,
          change: op.raceDate ? `race day ${dayLabel(op.raceDate)}` : null,
          detail: [],
          kind: op.kind,
        });
        lines.push(...datedSessionLines(op.firmSessions, op.kind));
        for (const wk of op.shapeWeeks) lines.push(shapeWeekLine(wk, op.kind));
        break;
      }
      case "retirePlan": {
        lines.push({
          date: null,
          summary: "Retires the coached plan",
          change: "its remaining sessions come off the calendar",
          detail: [],
          kind: op.kind,
        });
        break;
      }
      case "resolveRaceConflict": {
        lines.push({
          date: null,
          summary:
            op.keep === "settings"
              ? "Your race day stands"
              : "Your race day moves to the plan's race date",
          change:
            op.keep === "settings"
              ? "the plan's race-labelled session becomes a hard session"
              : "the date in your settings changes to match the plan",
          detail: [],
          kind: op.kind,
        });
        break;
      }
      default: {
        // A new op kind must arrive with a description. Compile error here,
        // test failure in coach-describe.test.ts — never a silent blank line
        // in the one place the athlete reads what they are approving.
        const never: never = op;
        throw new Error(`op kind has no description: ${JSON.stringify(never)}`);
      }
    }
  }
  // Chronological, undated last. Stable, so the coach's own op order breaks
  // every tie — including a day carrying several lines.
  return lines.sort((a, b) => {
    if (a.date === b.date) return 0;
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? -1 : 1;
  });
}
