/**
 * THE OBJECTIVES BOARD (Stage 3 spec §11; principles §2.10, §5.2): what `GET /api/objectives/board` answers, in one
 * read. Every objective the athlete keeps (any status but dropped), in board order, each with:
 *  - its key results measured from logged data, exactly as `GET /api/objectives/:id/progress` measures them;
 *  - each key result's best ever measurement (every logged point, not only its window's);
 *  - the workouts that served it recently: done workouts whose document names it (`intent.objectiveIds`), newest first;
 *  - the streak of weeks in which one was done;
 *  - the coach's one line about it: the latest coach-written workout naming it, its summary.
 *
 * The athlete's words (titles, whys, labels) and the coach's line are data, shown as text.
 */
import type { KeyResultDto, KeyResultProgress, ObjectiveDto } from "./profile.js";
import type { DOC_SOURCES } from "./workout-doc.js";

/** A key result's best measurement over everything logged: its day, in the canonical unit and in the key result's. */
export interface KeyResultBest {
  date: string;
  value: number;
  display: number;
}

/** A done workout that served an objective. */
export interface ObjectiveServedWorkout {
  workoutId: string;
  /** The day it was done: its logged session's, else its planned day. */
  date: string;
  title: string;
  /** Who wrote its document (the coach, the Studio, …); null when unreadable. */
  source: (typeof DOC_SOURCES)[number] | null;
}

export interface ObjectiveBoardCard {
  objective: ObjectiveDto;
  keyResults: Array<{
    keyResult: KeyResultDto;
    progress: KeyResultProgress;
    /** Null when fewer than two points were ever logged (nothing yet to beat), or the measure reads nothing. */
    best: KeyResultBest | null;
  }>;
  /** The latest done workouts naming it, newest first (OBJECTIVE_SERVED_SHOWN at most). */
  served: ObjectiveServedWorkout[];
  /**
   * Weeks in a row (Monday to Sunday, the athlete's days) in which a workout naming it was done, counted back from this
   * week — or from last week while this one has none yet: a week under way never ends a streak. 0 when last week had
   * none either.
   */
  streakWeeks: number;
  /** The latest coach-written workout naming it (by its day): its one-sentence summary. Null when there is none. */
  note: { text: string; workoutId: string; date: string } | null;
}

/** Exact shape of `GET /api/objectives/board`. */
export interface ObjectiveBoardDto {
  /** The athlete's today, which every window ends on. */
  today: string;
  objectives: ObjectiveBoardCard[];
}

/** The served workouts a card lists, at most. */
export const OBJECTIVE_SERVED_SHOWN = 3;
/** The weeks a streak is counted over, at most (the read looks no further back). */
export const OBJECTIVE_STREAK_WEEKS = 26;
