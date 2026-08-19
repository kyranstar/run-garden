import {
  addOpDates,
  formatExercise,
  formatExerciseBlock,
  type CoachExerciseBlock,
  type CoachOp,
  type CoachRunBlock,
  type CoachSession,
} from "./coach.js";
import { formatStageDistance, formatStageDuration } from "./duration.js";
import { isoWeekday } from "./time.js";
import { sessionWatchCoverage, type WatchCoverageView } from "./watch-coverage.js";

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
  /** One-line human summary of the NEW state, e.g. "Easy 35 · 35 min". */
  summary: string;
  /** What this replaced — rendered struck-through after "was". Only ever a
   * REAL difference: when before and after read the same, this is null
   * rather than an X → X (the deployed defect this field replaced). */
  was: string | null;
  /** A sentence for what `was` can't say (a skip's reason, a plan-level
   * consequence). Never a restatement of `summary` or `was`. */
  change: string | null;
  /** Session contents, already formatted, e.g. "Wall Sit 3×45s". Empty for non-session ops. */
  detail: string[];
  /**
   * What the athlete's COROS watch will show for this session — present on
   * every line built from a `CoachSession`, absent on the lines that describe
   * a move, a skip, a plan boundary or a week sketch (there is no session
   * there to carry).
   *
   * This is the manifest's job, not the sheet's. The manifest is what the
   * athlete reads BEFORE approving, and until now it did not mention the
   * watch at all — so a proposal that added three mobility sessions read
   * exactly like one that added three runs, and the difference (none of the
   * three will ever appear on the watch) surfaced only later, one tap deep in
   * a session sheet, as a sentence with no reason in it.
   *
   * `coverage: "full"` lines carry the field too; the UI renders only what is
   * not full, so a plain running week says nothing new.
   */
  watch?: WatchCoverageView;
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
  /** Its planned length — the fallback delta when the wording is identical
   * (an ease that shortens a run without renaming it). */
  durationMinutes?: number;
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
  // Both amounts through the shared formatters (`value` is MINUTES for a
  // duration block, whole METRES for a distance one) so the manifest, the
  // stored stage summary and the sheet's stage list have one vocabulary. The
  // distance formatter used to be spelled out here, differently from the two
  // spellings downstream — see `formatStageDistance`.
  const work =
    b.kind === "duration" ? formatStageDuration(b.value * 60) : formatStageDistance(b.value);
  return b.intensity ? `${work} ${b.intensity}` : work;
}

/**
 * WHAT THE SESSION PRESCRIBES, line by line — the one renderer, for every
 * reader (2026-08-17).
 *
 * There were three of these, and a person could see all three within one tap:
 * this function (the approval card's manifest), `coach-apply.ts`'s private
 * `stageSummary` (which writes the stored `planned_workouts.stage_summary`
 * that Today, the week list and the coach's own dossier all read), and
 * `summarizeStages` in @rg/scheduling (which the session sheet re-derives from
 * the row's stage rows). They disagreed about distances, about a role label
 * nobody wrote, and — before `formatStageDuration` — about every stage under a
 * minute.
 *
 * So the manifest's rendering became the function, and the other two call it
 * or reduce to it: `sessionSummaryLine` IS the stored column, and
 * `summarizeStages` renders stage rows with the same two amount formatters and
 * no invented words. `intent-cross-surface.test.ts` holds all five readers to
 * one string, fixture by fixture.
 */
export function sessionPrescription(s: CoachSession): string[] {
  const block = s.lift ?? s.mobility;
  if (block) return blockDetail(block);
  if (s.run) return s.run.blocks.map(runBlockDetail);
  return [];
}

/**
 * The same prescription as ONE line — `planned_workouts.stage_summary`, and
 * therefore Today's card, the week list, and the `contains:` text the coach's
 * dossier quotes back to the model.
 *
 * A session with no body at all (a rest day, "gym, movements on the day") has
 * no prescription to state, and the title is the whole story: an empty
 * exercise list and an absent one parse alike (coach.ts), so they must read
 * alike too.
 */
export function sessionSummaryLine(s: CoachSession): string {
  const lines = sessionPrescription(s);
  return lines.length > 0 ? lines.join(" · ") : s.title;
}

function shapeWeekLine(
  wk: { weekStart: string; volumeTarget: string; keySessions: string[] },
  kind: OpLine["kind"],
): OpLine {
  return {
    date: wk.weekStart,
    summary: `Week of ${dayLabel(wk.weekStart)} — ${wk.volumeTarget}`,
    was: null,
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
    was: null,
    change: null,
    detail: sessionPrescription(s.session),
    watch: sessionWatchCoverage(s.session),
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
        // The "was" clause carries only a REAL difference: wording when it
        // changed (with the old length when that changed too), the old
        // length alone when only the length moved — and nothing at all when
        // before and after read the same. Never an X → X.
        const differsInWording = was?.summary != null && was.summary !== op.session.title;
        const differsInLength =
          was?.durationMinutes != null && was.durationMinutes !== op.session.durationMinutes;
        lines.push({
          date: was?.date ?? null,
          summary: sessionSummary(op.session),
          was: differsInWording
            ? `${was!.summary}${differsInLength ? ` · ${was!.durationMinutes} min` : ""}`
            : differsInLength
              ? `${was!.durationMinutes} min`
              : null,
          change: was ? null : "rewrites the session already on this day",
          detail: sessionPrescription(op.session),
          watch: sessionWatchCoverage(op.session),
          kind: op.kind,
        });
        break;
      }
      case "move": {
        const from = planned?.get(op.workoutId);
        const what = from?.summary ?? "The session planned for this day";
        // ONE line, under the destination — the day it lands on is the day
        // header's job, so the line says only where it came from (the old
        // two-line form repeated the destination the header already named).
        lines.push({
          date: op.toDate,
          summary: what,
          was: from?.date && from.date !== op.toDate ? dayLabel(from.date) : null,
          change: from?.date ? null : "moved from its planned day",
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
          was: null,
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
          was: null,
          // `reason` is optional (a skip with no stated reason is still a
          // skip), so the line must read as a sentence without one.
          change: op.reason ? `comes off the plan — ${op.reason}` : "comes off the plan",
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
          was: null,
            change: null,
            detail: sessionPrescription(op.session),
            watch: sessionWatchCoverage(op.session),
            kind: op.kind,
          });
        }
        break;
      }
      case "reshapeWeek": {
        lines.push({
          date: op.weekStart,
          summary: `Week of ${dayLabel(op.weekStart)} rewritten`,
          was: null,
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
          was: null,
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
          was: null,
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
          was: null,
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
          was: null,
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
          was: null,
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
