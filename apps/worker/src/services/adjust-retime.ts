/**
 * A PLANNED RUN'S LENGTH, RE-TIMED BY THE RULE (the owner's decision, 2026-10-20) — the planned row's side of
 * @rg/domain's `retimeRun`. When the coach changes only a structured run's length (`adjust`), the app re-times the run's
 * steps by a fixed rule in code: this reads the row's structure into the rule's terms, runs it, and says what the row,
 * its stage rows, its document and the watch's copy become.
 *
 * ONE PURE FUNCTION FOR THE CARD AND THE APPLY (`retimeOfRow`). adjust_plan runs it when the coach proposes the length,
 * and keeps what it found on the op (`RetimeExpectation`: the card's line comes from it); the applier runs it again at
 * the tap, from the row as it stands, and applies it only when it finds the same — else the session has changed since
 * and nothing is written (coach-apply.ts). So the card and the applied result cannot disagree.
 *
 * WHICH RUNS. A run (`sport` run) other than a race, with a structure the rule can read:
 *  - A DESIGNED RUN (the coach designer's: its document is a run, based on a proposal; §8 §3): its document's parts and
 *    items are the rule's segments and steps one for one — a part with `rounds` a set of repeats — each step's role
 *    and effort as the watch takes them (`runWatchStepOf`), a distance timed at its pace (`runStepSeconds`: the one
 *    asked for, else its effort's from the threshold; else its share of the row's stated length). It becomes its
 *    document re-timed (`setting.targetMinutes` the new length), its stage rows made from it (`designedRunStages`), and
 *    its watch session the designed run's own (`runWatchSessionOf`, the wire in force) — a count of reps the wire
 *    can't hold is refused.
 *  - A THREAD-COACH RUN (`threadCoachRun`: its `cw-` row, its stages still its blocks): its stage rows — written-out
 *    reps folded (`foldRepeats`) — each block's intensity its label and its role from the intensities
 *    (`threadCoachRoles`: an easy float between pickups a recovery), a distance its share of the row's stated length. It
 *    becomes a coach session of the re-timed blocks, written as an ease writes one (its stage rows, its document) but
 *    keeping the row's name, category and subtype; the watch's copy is that session with each distance as its time —
 *    the coach session's wire carries no distance (the body check's ruling for a run on the watch).
 * Anything else keeps the length alone (`length_only`: today's adjust, unchanged — the card says the watch is
 * unchanged, and it is): not a run, a race, no stages (an unstructured run), a stage the rule can't read (open, lap
 * button), steps already the length asked of a row stating another (review-L minor 6) — and A COROS-IMPORTED RUN
 * (review-L C1; re-timing one properly, its distances and its own targets kept, is a later item: see `threadCoachRun`).
 */
import {
  ACCESSORY_MAX_METERS,
  ACCESSORY_MAX_SEC,
  coachSessionSchema,
  foldRepeats,
  expandSegment,
  isRunDoc,
  parseStoredWorkoutDoc,
  retimeRun,
  RUN_EFFORT_LABELS,
  runStepSeconds,
  runWatchSessionOf,
  runWatchStepOf,
  runWatchSteps,
  sessionSummaryLine,
  workoutDocSchema,
  type CoachSession,
  type RetimeRefusal,
  type RetimeSegment,
  type RetimeStep,
  type RunIntensity,
  type RunStructure,
  type RunWatchSession,
  type RunWire,
  type WeightUnit,
  type WorkoutDoc,
  type WorkoutItem,
} from "@rg/domain";
import type { plannedWorkouts, plannedWorkoutStages } from "@rg/database";
import { summarizeStageRows } from "@rg/scheduling";
import { coachStageRows, sessionDoc } from "./coach-apply.js";
import { insertBatches } from "./db.js";
import { designedRunStages } from "./designed-runs.js";

type Row = typeof plannedWorkouts.$inferSelect;
type Stage = typeof plannedWorkoutStages.$inferSelect;

/** What the rule reads of a planned row. */
export type RetimeRowFields = Pick<
  Row,
  "id" | "sport" | "title" | "category" | "qualitySubtype" | "sourceEstimatedDurationSeconds" | "fallbackEstimatedDurationSeconds" | "calendarBlockDurationSeconds" | "workoutDoc"
>;
/** What the rule reads of a stage row. */
export type RetimeStageFields = Pick<Stage, "id" | "parentStageId" | "ord" | "kind" | "repeatCount" | "durationType" | "durationSeconds" | "distanceMeters" | "label">;

/**
 * What the card said a re-time does — kept on the coach's op when it was proposed (proposal-kinds.ts `PlanAdjustOp`) and
 * checked by the applier against the rule run again at the tap: its new length, its line, the stage summary the row
 * then says, and its stage rows (their count, and the inserts that write them: the approve's declared cost).
 */
export interface RetimeExpectation {
  minutes: number;
  summary: string;
  stageSummary: string;
  stageRows: number;
  stageInserts: number;
}

/** The same re-time as the card's. */
export const sameRetime = (a: RetimeExpectation, b: RetimeExpectation): boolean =>
  a.minutes === b.minutes && a.summary === b.summary && a.stageSummary === b.stageSummary && a.stageRows === b.stageRows;

/** What the row's re-time writes. */
export type RetimeWrite =
  | {
      family: "designed";
      doc: WorkoutDoc;
      stages: ReturnType<typeof designedRunStages>;
      /** The watch's copy (null: the wire can't hold it — never reached: refused first). */
      session: RunWatchSession;
      expectedDistanceMeters: number | null;
      stageSummary: string;
    }
  | {
      family: "plan";
      /** The app's copy. */
      session: CoachSession;
      /** The watch's: each distance as its time. */
      watchSession: CoachSession;
      stages: ReturnType<typeof coachStageRows>;
      doc: WorkoutDoc | null;
      stageSummary: string;
    };

export type RowRetime =
  /** Not a structured run the rule reads: the length alone changes (today's adjust). */
  | { kind: "length_only" }
  /** The rule refuses it, with the reason the coach reads. */
  | { kind: "refused"; refusal: RetimeRefusal | "too_many_steps"; reason: string }
  /** The rule leaves it as it is (a target it already is, or a count that can't move): `minutes` its length. */
  | { kind: "unchanged"; minutes: number }
  | { kind: "retimed"; minutes: number; summary: string; expect: RetimeExpectation; write: RetimeWrite };

export interface RetimeCtx {
  thresholdSecPerKm: number | null;
  runWire: RunWire;
  weightUnit?: WeightUnit;
}

const LENGTH_ONLY = { kind: "length_only" } as const;

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * The rule leaves the steps as they are. When they already are the length asked — the row stating another (review-L
 * minor 6) — that is the length alone: the row takes it, its steps and the watch's copy stay. Otherwise the reps come no
 * nearer the length asked: no change.
 */
function unchangedOrLength(minutes: number, targetMinutes: number): RowRetime {
  return minutes === targetMinutes ? LENGTH_ONLY : { kind: "unchanged", minutes };
}

/** The row's length as every reader takes it. */
const statedSeconds = (row: RetimeRowFields): number =>
  row.sourceEstimatedDurationSeconds ?? row.fallbackEstimatedDurationSeconds ?? row.calendarBlockDurationSeconds;

/** The rule's result for a row (see the module comment). Pure. */
export function retimeOfRow(row: RetimeRowFields, stages: readonly RetimeStageFields[], targetMinutes: number, ctx: RetimeCtx): RowRetime {
  if (row.sport !== "run" || row.category === "race") return LENGTH_ONLY;
  const doc = parseStoredWorkoutDoc(row.workoutDoc);
  if (doc && doc.basedOn?.kind === "proposal" && isRunDoc(doc)) return designedRetime(row, doc, targetMinutes, ctx);
  return planRetime(row, stages, targetMinutes, ctx);
}

// ── A designed run: its document ───────────────────────────────────────────────────────────────────────────────────

function designedRetime(row: RetimeRowFields, doc: WorkoutDoc, targetMinutes: number, ctx: RetimeCtx): RowRetime {
  // Each item a step; a distance with no pace to time it waits for its share of the row's stated length.
  const untimed: Array<[number, number]> = [];
  const segments: RetimeSegment[] = [];
  for (const [i, part] of doc.parts.entries()) {
    const steps: RetimeStep[] = [];
    for (const [j, item] of part.items.entries()) {
      const step = runWatchStepOf(item, part.purpose);
      if (step === "mixed" || step === "open") return LENGTH_ONLY;
      const label = item.kind === "run" ? RUN_EFFORT_LABELS[item.effort].toLowerCase() : "rest";
      if (step.target.kind === "time") {
        steps.push({ role: step.role, target: { kind: "time", seconds: step.target.seconds }, label });
      } else {
        const seconds = runStepSeconds(step, ctx.thresholdSecPerKm);
        if (seconds === null) untimed.push([i, j]);
        steps.push({ role: step.role, target: { kind: "distance", meters: step.target.meters, seconds: seconds ?? 0 }, label });
      }
    }
    const rounds = part.rounds ?? 1;
    const rest = part.restBetweenRoundsSec !== undefined && rounds > 1 ? Math.round(part.restBetweenRoundsSec) : 0;
    segments.push({ rounds, steps, repeat: part.rounds !== undefined, ...(rest > 0 ? { restBetweenRoundsSec: rest } : {}) });
  }
  if (!shareOut(segments, untimed, statedSeconds(row))) return LENGTH_ONLY;

  const r = retimeRun({ segments }, targetMinutes * 60);
  if ("refused" in r) return { kind: "refused", refusal: r.refused, reason: r.reason };
  const minutes = Math.round(r.seconds / 60);
  if (!r.changed) return unchangedOrLength(minutes, targetMinutes);

  const parts = doc.parts.map((part, i) => {
    const seg = r.structure.segments[i]!;
    return {
      ...part,
      ...(part.rounds !== undefined ? { rounds: seg.rounds } : {}),
      items: part.items.map((item, j) => retimedItem(item, segments[i]!.steps[j]!, seg.steps[j]!)),
    };
  });
  const parsed = workoutDocSchema.safeParse({ ...doc, setting: { ...(doc.setting ?? {}), targetMinutes: minutes }, parts });
  if (!parsed.success) return LENGTH_ONLY;
  const next = parsed.data;
  const made = runWatchSessionOf(next, ctx.runWire);
  if (!("session" in made)) {
    return { kind: "refused", refusal: "too_many_steps", reason: `That many reps is more steps than the watch holds: use ease to redesign it.` };
  }
  const stages = designedRunStages(row.id, next, ctx.thresholdSecPerKm);
  const stageSummary = summarizeStageRows(stages.map((s) => ({ ...s, parentStageId: s.parentStageId ?? null })));
  const resolved = runWatchSteps(made.session, ctx.thresholdSecPerKm, ctx.runWire);
  return {
    kind: "retimed",
    minutes,
    summary: r.summary,
    expect: { minutes, summary: r.summary, stageSummary, stageRows: stages.length, stageInserts: insertBatches(stages).length },
    write: { family: "designed", doc: next, stages, session: made.session, expectedDistanceMeters: resolved.totalMeters, stageSummary },
  };
}

/** A document item at its step's new length: a time its seconds, a distance its metres (the words typed for it go). */
function retimedItem(item: WorkoutItem, was: RetimeStep, now: RetimeStep): WorkoutItem {
  if (item.kind !== "run" || JSON.stringify(was.target) === JSON.stringify(now.target)) return item;
  const { typed: _typed, distanceM: _distance, durationSec: _duration, ...rest } = item.target;
  return {
    ...item,
    target: now.target.kind === "time" ? { ...rest, durationSec: now.target.seconds } : { ...rest, distanceM: now.target.meters },
  };
}

/**
 * The distances with no pace of their own, timed at their share of the row's stated length — what its timed steps (the
 * rounds written out) leave, by distance: the body check's rule for a plan run on the watch. False when they can't be:
 * the stated length leaves them nothing.
 */
function shareOut(segments: RetimeSegment[], untimed: ReadonlyArray<readonly [number, number]>, stated: number): boolean {
  if (untimed.length === 0) return true;
  const key = new Set(untimed.map(([i, j]) => `${i}:${j}`));
  let known = 0;
  let meters = 0;
  for (const [i, seg] of segments.entries()) {
    for (const [j, s] of seg.steps.entries()) {
      const times = seg.rounds - (j >= seg.steps.length - (seg.lastRoundOmits ?? 0) ? 1 : 0);
      if (key.has(`${i}:${j}`) && s.target.kind === "distance") meters += times * s.target.meters;
      else known += times * s.target.seconds;
    }
    known += (seg.restBetweenRoundsSec ?? 0) * (seg.rounds - 1);
  }
  const perMeter = meters > 0 ? (stated - known) / meters : 0;
  if (!(perMeter > 0)) return false;
  for (const [i, j] of untimed) {
    const s = segments[i]!.steps[j]!;
    if (s.target.kind === "distance") segments[i]!.steps[j] = { ...s, target: { ...s.target, seconds: s.target.meters * perMeter } };
  }
  return true;
}

// ── A thread-coach run: its stage rows ─────────────────────────────────────────────────────────────────────────────

/** The coach's categories a run takes; any other is easy (the body check's own mapping). */
const RUN_CATEGORIES = ["easy", "long", "quality", "recovery", "race"] as const;

/** The intensities the thread coach writes as its stage rows' labels (`coachStageRows`: each block's own). */
const COACH_INTENSITIES: ReadonlySet<string> = new Set<RunIntensity>(["easy", "steady", "threshold", "interval", "rest"]);
/** The wire's hard intensities (`runBlockRoles`): what makes an easy block either side of them a warm-up or cool-down. */
const HARD: ReadonlySet<string> = new Set<RunIntensity>(["steady", "threshold", "interval"]);

/**
 * THE THREAD COACH'S RUN ONLY (review-L C1). Its row is the thread coach's — a `cw-` id, plan.ts `appMadeRow`'s own
 * test, which a push to the watch leaves alone — and its stage rows are still its blocks: ids `<row>:<ord>`, flat, each
 * label an intensity or none. Anything else — a COROS-imported run, or a thread-coach run whose stages a COROS read has
 * since replaced — keeps the length alone, the watch untouched: a coach session made from an import's stages loses
 * COROS's own targets, reads its distances as times at the session's average pace, and would rewrite the athlete's own
 * COROS session with that. LATER: re-time an import through a `run_watch` session that keeps its distances (wire v2) and
 * each stage's own band (`pace`).
 */
function threadCoachRun(row: RetimeRowFields, sorted: readonly RetimeStageFields[]): boolean {
  return row.id.startsWith("cw-") && sorted.every((s) => s.id === `${row.id}:${s.ord}` && !s.parentStageId && (s.label === null || COACH_INTENSITIES.has(s.label)));
}

/** A step no longer than an accessory's (`ACCESSORY_MAX_SEC`, `ACCESSORY_MAX_METERS`). */
const shortStage = (s: RetimeStageFields): boolean =>
  s.durationType === "time" ? (s.durationSeconds ?? 0) <= ACCESSORY_MAX_SEC : s.durationType === "distance" ? (s.distanceMeters ?? 0) <= ACCESSORY_MAX_METERS : false;

/**
 * Each block's role, from its intensity — the thread coach's blocks carry no role, and the stored kinds are the wire's
 * (`runBlockRoles`), which cannot tell a float from work or pickups from a main set:
 *  - a rest is a recovery;
 *  - AN EASY FLOAT IS A RECOVERY (review-L minor 3): an easy block between two pickups (blocks neither easy nor rest),
 *    and one after a pickup as long as such a float (the last of a written-out set);
 *  - the first block, easy, is a warm-up, and the last, easy, a cool-down — only beside a hard block longer than an
 *    accessory: an easy run with pickups is its easy block and its pickups;
 *  - anything else is work.
 */
function threadCoachRoles(sorted: readonly RetimeStageFields[]): RetimeStep["role"][] {
  const n = sorted.length;
  const easy = (i: number) => sorted[i]?.label === "easy";
  const pickup = (i: number) => i >= 0 && i < n && sorted[i]!.label !== "easy" && sorted[i]!.label !== "rest";
  const lengthOf = (s: RetimeStageFields) => `${s.durationType}:${s.durationSeconds ?? s.distanceMeters}`;
  const float = sorted.map((_, i) => easy(i) && pickup(i - 1) && pickup(i + 1));
  const floatLengths = new Set(sorted.filter((_, i) => float[i]).map(lengthOf));
  sorted.forEach((s, i) => {
    if (easy(i) && pickup(i - 1) && floatLengths.has(lengthOf(s))) float[i] = true;
  });
  const longHard = sorted.map((s) => HARD.has(s.label ?? "") && !shortStage(s));
  return sorted.map((s, i): RetimeStep["role"] => {
    if (s.label === "rest" || float[i]) return "recovery";
    if (i === 0 && n > 1 && easy(i) && longHard.slice(1).some(Boolean)) return "warmup";
    if (i === n - 1 && n > 1 && easy(i) && longHard.slice(0, i).some(Boolean)) return "cooldown";
    return "work";
  });
}

function planRetime(row: RetimeRowFields, stages: readonly RetimeStageFields[], targetMinutes: number, ctx: RetimeCtx): RowRetime {
  if (stages.length === 0) return LENGTH_ONLY;
  const sorted = [...stages].sort((a, b) => a.ord - b.ord);
  if (!threadCoachRun(row, sorted)) return LENGTH_ONLY;

  // The distances' share of the stated length: what the timed blocks leave, by distance.
  const timed = sum(sorted.map((s) => (s.durationType === "time" ? (s.durationSeconds ?? 0) : 0)));
  const meters = sum(sorted.map((s) => (s.durationType === "distance" ? (s.distanceMeters ?? 0) : 0)));
  const perMeter = meters > 0 ? (statedSeconds(row) - timed) / meters : 0;
  if (meters > 0 && !(perMeter > 0)) return LENGTH_ONLY;

  const roles = threadCoachRoles(sorted);
  const steps: RetimeStep[] = [];
  for (const [i, s] of sorted.entries()) {
    const label = s.label ? { label: s.label } : {};
    const role = roles[i]!;
    if (s.durationType === "time" && (s.durationSeconds ?? 0) > 0) steps.push({ role, target: { kind: "time", seconds: Math.round(s.durationSeconds!) }, ...label });
    else if (s.durationType === "distance" && (s.distanceMeters ?? 0) > 0) steps.push({ role, target: { kind: "distance", meters: s.distanceMeters!, seconds: s.distanceMeters! * perMeter }, ...label });
    else return LENGTH_ONLY;
  }

  const structure: RunStructure = { segments: foldRepeats(steps) };
  const r = retimeRun(structure, targetMinutes * 60);
  if ("refused" in r) return { kind: "refused", refusal: r.refused, reason: r.reason };
  const minutes = Math.round(r.seconds / 60);
  if (!r.changed) return unchangedOrLength(minutes, targetMinutes);

  const written = r.structure.segments.flatMap(expandSegment);
  const block = (s: RetimeStep, asTime: boolean) => ({
    ...(s.target.kind === "time" || asTime
      ? { kind: "duration" as const, value: Math.round(s.target.seconds) / 60 }
      : { kind: "distance" as const, value: s.target.meters }),
    ...(s.label ? { intensity: s.label } : {}),
  });
  const sessionOf = (asTime: boolean): CoachSession | null => {
    const parsed = coachSessionSchema.safeParse({
      category: (RUN_CATEGORIES as readonly string[]).includes(row.category) ? row.category : "easy",
      title: row.title.trim() || "Run",
      durationMinutes: minutes,
      run: { blocks: written.map((s) => block(s, asTime)) },
    });
    return parsed.success ? parsed.data : null;
  };
  const session = sessionOf(false);
  const watchSession = sessionOf(true);
  if (!session || !watchSession) return LENGTH_ONLY;
  const rows = coachStageRows(row.id, session, ctx.thresholdSecPerKm ?? undefined);
  const stageSummary = sessionSummaryLine(session);
  return {
    kind: "retimed",
    minutes,
    summary: r.summary,
    expect: { minutes, summary: r.summary, stageSummary, stageRows: rows.length, stageInserts: insertBatches(rows).length },
    write: {
      family: "plan",
      session,
      watchSession,
      stages: rows,
      doc: sessionDoc(row.id, session, ctx.weightUnit, ctx.thresholdSecPerKm ?? undefined),
      stageSummary,
    },
  };
}
