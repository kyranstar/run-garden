import { DateTime } from "luxon";
import type {
  Instant,
  LocalDate,
  LocalTime,
  SchedulingPreferences,
  WorkoutCategory,
} from "@rg/domain";
import { addDays, daysBetween } from "@rg/domain";
import {
  computeBlock,
  fitsEvening,
  latestEveningEndBefore,
  overlapsBusy,
  preferredTimeFor,
  type BusyInterval,
  type DayWindow,
  type ScheduledBlock,
} from "./windows.js";

/**
 * The rescheduler changes placement, not plan contents. It proposes at most
 * three candidate placements, each with one short explanation, and never
 * shifts the rest of the plan.
 */

export interface ReschedulerWorkout {
  id: string;
  title: string;
  category: WorkoutCategory;
  qualitySubtype?: string;
  effectiveDate: LocalDate;
  effectiveTime: LocalTime;
  workoutSeconds: number;
}

export interface RescheduleRequest {
  workout: ReschedulerWorkout;
  /** Other planned workouts in the surrounding weeks (excluding the one moving). */
  others: ReschedulerWorkout[];
  busy: BusyInterval[];
  prefs: SchedulingPreferences;
  today: LocalDate;
  now: Instant;
}

export interface RescheduleCandidate {
  date: LocalDate;
  time: LocalTime;
  window: DayWindow;
  block: ScheduledBlock;
  explanation: string;
  warnings: string[];
  score: number;
  daysMoved: number;
}

export interface RescheduleResult {
  candidates: RescheduleCandidate[];
  /** Non-empty when no candidate can be offered (e.g. races are never moved). */
  blockedReason?: string;
  skipOption: { explanation: string };
}

const RUNNING_CATEGORIES: WorkoutCategory[] = ["recovery", "easy", "long", "quality", "race"];
const isRunningCat = (c: WorkoutCategory) => RUNNING_CATEGORIES.includes(c);
const isQualityCat = (c: WorkoutCategory) => c === "quality" || c === "race";

function startInstantOf(w: ReschedulerWorkout, zone: string): DateTime {
  return DateTime.fromISO(`${w.effectiveDate}T${w.effectiveTime}`, { zone });
}

interface Evaluation {
  blocked: boolean;
  blockReasons: string[];
  warnings: string[];
  penalty: number;
  cleanSpacing: boolean;
  separatedFrom?: ReschedulerWorkout;
}

function evaluatePlacement(
  req: RescheduleRequest,
  date: LocalDate,
  time: LocalTime,
  window: DayWindow,
  block: ScheduledBlock,
): Evaluation {
  const { workout, others, prefs, busy } = req;
  const zone = prefs.timezone;
  const warnings: string[] = [];
  const blockReasons: string[] = [];
  let penalty = 0;
  let cleanSpacing = true;
  let separatedFrom: ReschedulerWorkout | undefined;

  if (date < req.today) blockReasons.push("in the past");
  if (block.startInstant <= req.now) blockReasons.push("start time already passed");

  // Never two running workouts on one day; never land on a race day.
  const sameDay = others.filter((o) => o.effectiveDate === date);
  if (isRunningCat(workout.category) && sameDay.some((o) => isRunningCat(o.category))) {
    blockReasons.push("another run is planned that day");
  }
  if (sameDay.some((o) => o.category === "race")) blockReasons.push("race day");
  if (sameDay.some((o) => o.category === "rest")) {
    warnings.push("lands on a planned rest day");
    penalty += 12;
  }

  if (overlapsBusy(block, busy).length > 0) blockReasons.push("calendar conflict");

  if (window === "evening" && !fitsEvening(date, time, workout.workoutSeconds, prefs)) {
    blockReasons.push(`would finish after ${prefs.latestEveningFinish}`);
  }

  // Spacing constraints against neighbors (real elapsed hours, DST-safe).
  const candidateStart = DateTime.fromISO(block.workoutStartInstant, { zone: "utc" });
  for (const o of others) {
    if (!isRunningCat(o.category)) continue;
    const otherStart = startInstantOf(o, zone).toUTC();
    const gapHours = Math.abs(candidateStart.diff(otherStart, "hours").hours);
    const bothQuality = isQualityCat(workout.category) && isQualityCat(o.category);
    const qualityAndLong =
      (isQualityCat(workout.category) && o.category === "long") ||
      (workout.category === "long" && isQualityCat(o.category));

    if (bothQuality && gapHours < 36) {
      warnings.push(`two quality runs within 36 hours (${o.title})`);
      penalty += 30;
      cleanSpacing = false;
    } else if (bothQuality && gapHours < 48) {
      penalty += 10; // prefer 48h between demanding quality sessions
      cleanSpacing = false;
    } else if (qualityAndLong && gapHours < 36) {
      warnings.push(`too close to ${o.category === "long" ? "the long run" : o.title}`);
      penalty += 25;
      cleanSpacing = false;
    } else if (qualityAndLong && gapHours < 48 && gapHours >= 36) {
      separatedFrom = separatedFrom ?? o;
    }
  }

  // Order preservation: penalize jumping across a neighboring planned workout.
  const origDate = workout.effectiveDate;
  for (const o of others) {
    if (!isRunningCat(o.category)) continue;
    const wasBefore = o.effectiveDate < origDate;
    const nowBefore = o.effectiveDate < date;
    if (wasBefore !== nowBefore && o.effectiveDate !== date) {
      penalty += 12;
      warnings.push(`changes order with ${o.title}`);
      break;
    }
  }

  const daysMoved = Math.abs(daysBetween(origDate, date));
  if (daysMoved > 2) {
    warnings.push(`moves the workout ${daysMoved} days`);
    penalty += 8 * (daysMoved - 2);
  }

  // Unusually late prior evening before a morning run.
  if (window === "morning") {
    const lateEnd = latestEveningEndBefore(date, busy, zone);
    if (lateEnd) {
      const start = DateTime.fromISO(block.workoutStartInstant, { zone: "utc" }).setZone(zone);
      const restHours = start.diff(lateEnd, "hours").hours;
      if (restHours < 9) {
        warnings.push("late evening event the night before");
        penalty += 10;
      }
    }
  }

  return { blocked: blockReasons.length > 0, blockReasons, warnings, penalty, cleanSpacing, separatedFrom };
}

function explanationFor(
  candidate: { date: LocalDate; window: DayWindow; daysMoved: number },
  evaln: Evaluation,
  req: RescheduleRequest,
  isBestSpacing: boolean,
): string {
  if (candidate.daysMoved === 0) return "same day";
  if (evaln.separatedFrom) {
    const weekday = DateTime.fromISO(evaln.separatedFrom.effectiveDate).toFormat("cccc");
    const what = evaln.separatedFrom.category === "long" ? "long run" : "quality session";
    return `keeps ${weekday}'s ${what} separated`;
  }
  if (isBestSpacing) return "best workout spacing";
  const dir = candidate.date > req.workout.effectiveDate ? "later" : "earlier";
  return `${candidate.daysMoved === 1 ? "next" : `${candidate.daysMoved} days ${dir},`} open ${candidate.window}`;
}

export function proposeReschedules(req: RescheduleRequest): RescheduleResult {
  const skipOption = {
    explanation: "Skip this workout — later workouts stay where they are.",
  };

  if (req.workout.category === "race") {
    return { candidates: [], blockedReason: "Races are never moved automatically.", skipOption };
  }

  const { prefs } = req;
  const origDate = req.workout.effectiveDate;

  // Candidate day order per product spec: same day, +1, -1, +2, -2.
  const dayOffsets = [0, 1, -1, 2, -2];
  const windowOrder: DayWindow[] =
    prefs.defaultWindow === "morning" ? ["morning", "evening"] : ["evening", "morning"];

  const evaluated: Array<RescheduleCandidate & { evaln: Evaluation; orderIndex: number }> = [];
  let orderIndex = 0;
  for (const offset of dayOffsets) {
    const date = addDays(origDate, offset);
    for (const window of windowOrder) {
      const time = preferredTimeFor(date, window, prefs);
      const block = computeBlock(date, time, req.workout.workoutSeconds, prefs);
      const evaln = evaluatePlacement(req, date, time, window, block);
      orderIndex++;
      if (evaln.blocked) continue;
      // Enumeration order dominates the window-preference bonus so "same day"
      // always outranks a next-day slot when both are clean.
      let score = 100 - orderIndex * 6 - evaln.penalty;
      if (window === prefs.defaultWindow) score += 3;
      evaluated.push({
        date,
        time,
        window,
        block,
        explanation: "",
        warnings: evaln.warnings,
        score,
        daysMoved: Math.abs(daysBetween(origDate, date)),
        evaln,
        orderIndex,
      });
    }
  }

  evaluated.sort((a, b) => b.score - a.score);
  const bestSpacingId = evaluated.find((c) => c.evaln.cleanSpacing && c.daysMoved > 0);
  const top = evaluated.slice(0, 3).map((c) => ({
    date: c.date,
    time: c.time,
    window: c.window,
    block: c.block,
    explanation: explanationFor(c, c.evaln, req, c === bestSpacingId),
    warnings: c.warnings,
    score: c.score,
    daysMoved: c.daysMoved,
  }));

  return { candidates: top, skipOption };
}
