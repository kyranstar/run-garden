import {
  isSelectorOp,
  type CoachAuthoredOp,
  type CoachOp,
  type CoachSelectorOp,
  type WorkoutSelector,
} from "./coach.js";
import { refusedOnAppBuilt, type GuardrailWorkout } from "./coach-guardrails.js";
import { addDays } from "./time.js";
import { appAuthoredRow } from "./watch-address.js";

/**
 * SELECTOR EXPANSION (spec: 2026-09-20-coach-plan-management-design.md §2).
 *
 * The coach could reason about a whole plan but only act on it one workout at
 * a time, through a handle it had to copy by hand, from a 14-day window. A
 * selector names workouts by PROPERTY instead, so "move all my lifting a week
 * later" stops depending on whether the coach can see and correctly transcribe
 * twelve ids.
 *
 * This function is the entire mechanism, and it is deliberately PURE: it takes
 * the calendar snapshot the guardrails already build and returns ordinary ops.
 * Everything downstream — `describeOps`, `validateOps`, `applyOps`, the card —
 * never learns that selectors exist, which is why a change this large touches
 * one seam.
 *
 * Three rules, each of which was a way to get this wrong:
 *
 *  1. ONE SNAPSHOT. Every selector resolves against the same pre-op calendar,
 *     never against the result of its predecessors. Resolve sequentially and a
 *     `moveEach` in op 1 silently changes what op 2's date range matches, so
 *     which ops the athlete gets depends on the order the model happened to
 *     write them in.
 *  2. A SELECTOR MAY NOT REACH WHAT AN OP MAY NOT TOUCH. Resolution applies
 *     the same targetability test the fatal rules enforce, so a selector can
 *     never resolve onto an op that `validateOps` would then reject. Without
 *     this, one completed session inside a date range would bin the whole
 *     proposal on `touch_resolved` — the exact failure the fatal/advisory
 *     split exists to prevent, reintroduced by the back door.
 *  3. EMPTY IS AN ERROR. A selector that matches nothing is reported, never
 *     silently dropped: an approve button over zero changes is worse than
 *     being told the coach misjudged what was there.
 */

export interface SelectorExpansion {
  /** Ordinary ops only — safe for every existing consumer. */
  ops: CoachOp[];
  /** Selectors that matched nothing, by their index in the authored list. */
  empty: { opIndex: number; detail: string }[];
}

/** The ordinary op each selector verb resolves into. */
const RESOLVES_TO = {
  moveEach: "move",
  skipEach: "skip",
  removeEach: "remove",
  restoreEach: "restore",
  adjustEach: "adjust",
} as const satisfies Record<CoachSelectorOp["kind"], CoachOp["kind"]>;

/**
 * A programme (or on-demand) session the verb's op may not touch (ruling 3-R13): an `adjustEach` over a week that
 * holds one SKIPS it — it is not the coach's to re-time — rather than resolving onto the fatal `app_built_session` and
 * binning every other session in the request (re-review NEW-1). Move, skip and remove stay legal on it. Only an op
 * that names such a row by its own handle is refused.
 */
function appBuiltRefuses(w: GuardrailWorkout, verb: CoachSelectorOp["kind"]): boolean {
  return refusedOnAppBuilt(RESOLVES_TO[verb]) && appAuthoredRow({ origin: w.origin ?? null });
}

/** Still on the calendar in the state the verb acts on — before asking whose session it is. */
function live(w: GuardrailWorkout, verb: CoachSelectorOp["kind"], today: string): boolean {
  if (w.date < today) return false;
  if (verb === "restoreEach") return w.completionState === "skipped";
  return w.completionState === "scheduled" || w.completionState === "planned";
}

/** What each verb is allowed to land on. */
function targetable(w: GuardrailWorkout, verb: CoachSelectorOp["kind"], today: string): boolean {
  return live(w, verb, today) && !appBuiltRefuses(w, verb);
}

function matches(w: GuardrailWorkout, sel: WorkoutSelector): boolean {
  if (sel.by === "ids") return sel.ids.includes(w.id);
  if (w.date < sel.from || w.date > sel.to) return false;
  if (sel.discipline && w.discipline !== sel.discipline) return false;
  if (sel.category && w.category !== sel.category) return false;
  if (sel.titleContains && !w.title.toLowerCase().includes(sel.titleContains.toLowerCase())) return false;
  return true;
}

/** Why nothing matched, in the terms the coach used to ask. */
function emptyDetail(sel: WorkoutSelector, verb: CoachSelectorOp["kind"], onlyAppBuilt: boolean): string {
  // Said plainly, so the repair round re-scopes instead of guessing at another range: the sessions ARE there.
  if (onlyAppBuilt) {
    return `the only sessions it reaches are programme sessions, which can be moved, skipped or removed but never re-timed`;
  }
  if (sel.by === "ids") {
    return `none of the ${sel.ids.length} named session${sel.ids.length === 1 ? "" : "s"} can still be changed`;
  }
  const what = sel.discipline
    ? `${sel.discipline} sessions`
    : sel.category
      ? `${sel.category} sessions`
      : sel.titleContains
        ? `sessions matching “${sel.titleContains}”`
        : "sessions";
  const state = verb === "restoreEach" ? "skipped " : "";
  return `there are no ${state}${what} between ${sel.from} and ${sel.to}`;
}

export function expandSelectors(
  ops: CoachAuthoredOp[],
  calendar: GuardrailWorkout[],
  today: string,
): SelectorExpansion {
  // Rule 1: taken once, read by every selector, never updated.
  const snapshot = [...calendar].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const out: CoachOp[] = [];
  const empty: { opIndex: number; detail: string }[] = [];

  ops.forEach((op, opIndex) => {
    if (!isSelectorOp(op)) {
      out.push(op);
      return;
    }
    const hits = snapshot.filter((w) => targetable(w, op.kind, today) && matches(w, op.select));
    const produced: CoachOp[] = [];
    for (const w of hits) {
      switch (op.kind) {
        case "moveEach": {
          const toDate = addDays(w.date, op.shiftDays);
          // Rule 2 again, on the OTHER side of the op. A negative shift pulls
          // the earliest sessions in the range into yesterday, and `past_date`
          // is fatal — so without this, one unmovable session binned every
          // other move in the request. Found by the survival harness, which
          // lost two plausible plans in 800 exactly this way.
          if (toDate < today) break;
          produced.push({
            kind: "move",
            workoutId: w.id,
            toDate,
            ...(op.toTime ? { toTime: op.toTime } : {}),
          });
          break;
        }
        case "skipEach":
          produced.push({ kind: "skip", workoutId: w.id, reason: op.reason ?? undefined });
          break;
        case "removeEach":
          produced.push({ kind: "remove", workoutId: w.id });
          break;
        case "restoreEach":
          produced.push({ kind: "restore", workoutId: w.id });
          break;
        case "adjustEach": {
          const raw =
            op.durationScale !== undefined
              ? w.durationMinutes * op.durationScale
              : w.durationMinutes + (op.durationDeltaMinutes ?? 0);
          // Clamp rather than refuse: a taper that would take a 20-minute
          // recovery run below the floor still wants the other eleven.
          const minutes = Math.min(360, Math.max(5, Math.round(raw)));
          // A duration that did not change is not a change. Writing it would
          // put a line in the manifest that reads "45 min → 45 min".
          if (minutes !== w.durationMinutes) {
            produced.push({ kind: "adjust", workoutId: w.id, durationMinutes: minutes });
          }
          break;
        }
      }
    }
    if (produced.length === 0) {
      const onlyAppBuilt = snapshot.some((w) => live(w, op.kind, today) && appBuiltRefuses(w, op.kind) && matches(w, op.select));
      empty.push({ opIndex, detail: emptyDetail(op.select, op.kind, onlyAppBuilt) });
    }
    out.push(...produced);
  });

  return { ops: out, empty };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "22 Sep" — the manifest heading's date form, no year, no weekday. */
function shortDate(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
}

/**
 * The intent behind a resolved list, for the card's heading. Twelve move
 * lines read as twelve unrelated edits without it.
 *
 * Computed, never narrated — the rule `coach-describe.ts` exists to enforce
 * (the model states no fact the system can compute) covers this line too.
 */
export function describeSelector(sel: WorkoutSelector): string {
  if (sel.by === "ids") {
    return `${sel.ids.length} chosen session${sel.ids.length === 1 ? "" : "s"}`;
  }
  const span =
    sel.from === sel.to
      ? shortDate(sel.from)
      : // "24 – 26 Sep" when the month is shared, "22 Sep – 1 Nov" when not.
        sel.from.slice(0, 7) === sel.to.slice(0, 7)
        ? `${Number(sel.from.slice(8))} – ${shortDate(sel.to)}`
        : `${shortDate(sel.from)} – ${shortDate(sel.to)}`;
  const what = sel.discipline
    ? `every ${sel.discipline} session`
    : sel.category
      ? `every ${sel.category} session`
      : sel.titleContains
        ? `every session matching “${sel.titleContains}”`
        : null;
  return what ? `${what}, ${span}` : `everything scheduled ${span}`;
}
