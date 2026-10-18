/**
 * A DESIGNED RUN ON THE WATCH (§8 §3, 2026-10-18; phase 1).
 *
 * The conversation coach designs a run as a workout document: a warm-up part, one or more run parts (an intervals part
 * with `rounds` for repeats) and a cool-down part, each item a run segment with an effort and a time or a distance. Once
 * approved it goes to the watch as the thread coach's runs do — a `coach_create_workout` job — but its session is this
 * module's `run_watch` variant, not a `CoachSession`: a coach session's blocks hold four intensities and no roles, and
 * a document's run holds eleven efforts, roles, repeats, distances and a pace the athlete asked for.
 *
 * THE SESSION (`runWatchSessionOf`) is the document's run structure, kept as designed: one segment per part, with its
 * rounds and its rest between rounds, each step its role (a warm-up part's warm-up, a cool-down part's cool-down, a
 * recovery effort or a standing rest a recovery, anything else work), its effort, its time or distance, and a pace the
 * coach wrote because the athlete asked for one. No pace is computed into it: the bands come from the athlete's
 * threshold when the run is SENT (`runWatchSteps`), so the freshest threshold applies — and the update job's ease and
 * Undo rewrite it through the same function. Refused: a move among the runs (`mixed`), an open segment (`open`; the
 * validator refuses both first), and more than the watch's steps once the repeats are written out (`too_many_steps`).
 *
 * THE STEPS (`runWatchSteps`): the repeats written out step by step (a rest between rounds after each round but the
 * last), at most RUN_WATCH_MAX_STEPS. Each step's pace band is the one the coach wrote (`asked`), else its effort's from
 * the threshold (`paceBandFor`, the one function the card, the validator and the wire share; `threshold`), else none —
 * by feel, strides, hills, a race pace with no distance, or no threshold known. A distance goes as its time at its
 * band's middle (`conversionPaceFor`: an effort with no band borrows the nearest one's, for its time only); with no
 * threshold and no pace asked a distance can't be timed (`unresolved`) and the run can't go to the watch. THE PREVIEW
 * IS THE WIRE: the run card's steps and the program `buildRunWatchProgram` writes are this one function's output.
 */
import { z } from "zod";
import { conversionPaceFor, paceBandFor, type PaceBand, type RunEffort } from "./pace.js";
import { RUN_EFFORTS, type WorkoutDoc, type WorkoutItem } from "./workout-doc.js";

/** The most steps a designed run puts on the watch, its repeats written out (phase 1). */
export const RUN_WATCH_MAX_STEPS = 60;
/** What a step is for, as the watch announces it. */
export const RUN_STEP_ROLES = ["warmup", "work", "recovery", "cooldown"] as const;
export type RunStepRole = (typeof RUN_STEP_ROLES)[number];

/** A plausible threshold, for "would this effort have a band": what `paceOwed` counts against. */
const SOME_THRESHOLD = 300;

const paceSchema = z
  .object({ fastSecPerKm: z.number().finite().min(120).max(1800), slowSecPerKm: z.number().finite().min(120).max(1800) })
  .strict()
  .refine((p) => p.fastSecPerKm <= p.slowSecPerKm, "fast pace must not be slower than slow pace");

export const runWatchStepSchema = z
  .object({
    role: z.enum(RUN_STEP_ROLES),
    /** Absent for a standing rest. */
    effort: z.enum(RUN_EFFORTS).optional(),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("time"), seconds: z.number().int().min(1).max(86400) }).strict(),
      z.object({ kind: z.literal("distance"), meters: z.number().min(1).max(500000) }).strict(),
    ]),
    /** A pace the athlete asked for (race pace, a band they named): it wins over the effort's. */
    pace: paceSchema.optional(),
  })
  .strict();
export type RunWatchStep = z.infer<typeof runWatchStepSchema>;

export const runWatchSegmentSchema = z
  .object({
    /** How many times its steps run: a part's rounds, 1 for a part without. */
    rounds: z.number().int().min(1).max(50),
    steps: z.array(runWatchStepSchema).min(1).max(RUN_WATCH_MAX_STEPS),
    /** A standing rest after each round but the last, in seconds. */
    restBetweenRoundsSec: z.number().int().min(1).max(900).optional(),
  })
  .strict();
export type RunWatchSegment = z.infer<typeof runWatchSegmentSchema>;

/** The steps a session's segments write out to: its repeats, and the rests between rounds. */
export function runWatchStepCount(segments: readonly RunWatchSegment[]): number {
  return segments.reduce((n, s) => n + s.rounds * s.steps.length + (s.restBetweenRoundsSec ? s.rounds - 1 : 0), 0);
}

/** A part's rest between rounds as the watch takes it: whole seconds, none for a part of one round. */
const restBetweenOf = (part: WorkoutDoc["parts"][number]): number => {
  const rounds = part.rounds ?? 1;
  return part.restBetweenRoundsSec !== undefined && rounds > 1 ? Math.round(part.restBetweenRoundsSec) : 0;
};

/** The steps a run document writes out to on the watch (its repeats, the rests between rounds): the validator's count. */
export function runDocStepCount(doc: Pick<WorkoutDoc, "parts">): number {
  return doc.parts.reduce((n, p) => n + (p.rounds ?? 1) * p.items.length + (restBetweenOf(p) > 0 ? (p.rounds ?? 1) - 1 : 0), 0);
}

export const runWatchSessionSchema = z
  .object({
    kind: z.literal("run_watch"),
    /** The athlete-facing title — what the stamp reader un-stamps to. */
    title: z.string().min(1).max(200),
    segments: z.array(runWatchSegmentSchema).min(1).max(20),
  })
  .strict()
  .refine((s) => runWatchStepCount(s.segments) <= RUN_WATCH_MAX_STEPS, `more than ${RUN_WATCH_MAX_STEPS} steps once the repeats are written out`);
export type RunWatchSession = z.infer<typeof runWatchSessionSchema>;

/** The discriminator only: `runWatchSessionSchema` is what validates one. */
export function isRunWatchSession(s: unknown): s is RunWatchSession {
  return typeof s === "object" && s !== null && (s as { kind?: unknown }).kind === "run_watch";
}

/** A document of run segments (and rests) only, with at least one run: a designed run. */
export function isRunDoc(doc: Pick<WorkoutDoc, "parts">): boolean {
  const items = doc.parts.flatMap((p) => p.items);
  return items.some((i) => i.kind === "run") && items.every((i) => i.kind === "run" || i.kind === "rest");
}

export type RunWatchRefusal = "mixed" | "open" | "too_many_steps";

function stepOf(item: WorkoutItem, purpose: WorkoutDoc["parts"][number]["purpose"]): RunWatchStep | "mixed" | "open" {
  if (item.kind === "rest") return { role: "recovery", target: { kind: "time", seconds: Math.max(1, Math.round(item.seconds)) } };
  if (item.kind !== "run") return "mixed";
  const t = item.target;
  const role: RunStepRole = purpose === "warmup" ? "warmup" : purpose === "cooldown" ? "cooldown" : item.effort === "recovery" ? "recovery" : "work";
  const target: RunWatchStep["target"] | null =
    t.durationSec !== undefined
      ? { kind: "time", seconds: Math.max(1, Math.round(t.durationSec)) }
      : t.distanceM !== undefined
        ? { kind: "distance", meters: t.distanceM }
        : null;
  if (!target) return "open";
  return { role, effort: item.effort, target, ...(t.pace ? { pace: { fastSecPerKm: t.pace.fastSecPerKm, slowSecPerKm: t.pace.slowSecPerKm } } : {}) };
}

/** A designed run's session for the watch job (see the module comment), or why the wire can't hold it. */
export function runWatchSessionOf(doc: WorkoutDoc): { session: RunWatchSession } | { refused: RunWatchRefusal } {
  const segments: RunWatchSegment[] = [];
  for (const part of doc.parts) {
    const steps: RunWatchStep[] = [];
    for (const item of part.items) {
      const step = stepOf(item, part.purpose);
      if (step === "mixed" || step === "open") return { refused: step };
      steps.push(step);
    }
    const rest = restBetweenOf(part);
    segments.push({ rounds: part.rounds ?? 1, steps, ...(rest > 0 ? { restBetweenRoundsSec: rest } : {}) });
  }
  if (runWatchStepCount(segments) > RUN_WATCH_MAX_STEPS) return { refused: "too_many_steps" };
  return { session: { kind: "run_watch", title: doc.title, segments } };
}

/** One step on the watch, resolved: what the card shows and the wire writes. */
export interface RunWatchStepResolved {
  role: RunStepRole;
  /** Absent for a standing rest. */
  effort?: RunEffort;
  /** Its seconds on the watch: the time asked, or the distance at its pace's middle; null when a distance can't be timed. */
  seconds: number | null;
  /** The distance asked, when it was one. */
  meters?: number;
  /** The pace band the step carries, or null. */
  pace: PaceBand | null;
  /** Where the band came from: the coach wrote it (the athlete asked), or the threshold; null with none. */
  paceFrom: "asked" | "threshold" | null;
}

export interface RunWatchResolved {
  steps: RunWatchStepResolved[];
  /** Every step's seconds; null when a distance can't be timed. */
  totalSeconds: number | null;
  /** Every step's metres — a distance as asked, a time at its pace's middle — to the metre; null when one can't be read. */
  totalMeters: number | null;
  /** Steps asked as a distance that go to the watch as their time. */
  distanceAsTime: number;
  /** Steps whose effort takes a band from a threshold that carry none: no threshold is known. */
  paceOwed: number;
  /** Distances with no pace to time them by: the run can't go to the watch. */
  unresolved: number;
}

/** The run's steps on the watch with the athlete's threshold (see the module comment). Pure. */
export function runWatchSteps(session: Pick<RunWatchSession, "segments">, thresholdSecPerKm: number | null | undefined): RunWatchResolved {
  const steps: RunWatchStepResolved[] = [];
  let distanceAsTime = 0;
  let paceOwed = 0;
  let unresolved = 0;
  let seconds: number | null = 0;
  let meters: number | null = 0;
  const resolve = (s: RunWatchStep): RunWatchStepResolved => {
    const distanceM = s.target.kind === "distance" ? s.target.meters : undefined;
    const asked = s.pace ?? null;
    const band = asked ?? (s.effort ? paceBandFor(s.effort, thresholdSecPerKm, distanceM !== undefined ? { distanceM } : {}) : null);
    if (!asked && !band && s.effort && paceBandFor(s.effort, SOME_THRESHOLD, distanceM !== undefined ? { distanceM } : {})) paceOwed += 1;
    const mid = asked ? (asked.fastSecPerKm + asked.slowSecPerKm) / 2 : s.effort ? conversionPaceFor(s.effort, thresholdSecPerKm, distanceM !== undefined ? { distanceM } : {}) : null;
    let secs: number | null;
    if (s.target.kind === "time") {
      secs = s.target.seconds;
    } else {
      distanceAsTime += 1;
      secs = mid !== null ? Math.max(1, Math.round((s.target.meters / 1000) * mid)) : null;
      if (secs === null) unresolved += 1;
    }
    return {
      role: s.role,
      ...(s.effort ? { effort: s.effort } : {}),
      seconds: secs,
      ...(distanceM !== undefined ? { meters: distanceM } : {}),
      pace: band,
      paceFrom: asked ? "asked" : band ? "threshold" : null,
    };
  };
  const tally = (r: RunWatchStepResolved, source: RunWatchStep | null) => {
    steps.push(r);
    seconds = seconds === null || r.seconds === null ? null : seconds + r.seconds;
    if (meters === null) return;
    if (r.meters !== undefined) meters += r.meters;
    else if (source === null) return; // a rest between rounds: standing
    else if (!source.effort) return; // a standing rest
    else {
      const mid = r.pace ? (r.pace.fastSecPerKm + r.pace.slowSecPerKm) / 2 : conversionPaceFor(source.effort, thresholdSecPerKm);
      meters = mid ? meters + ((r.seconds ?? 0) / mid) * 1000 : null;
    }
  };
  for (const seg of session.segments) {
    for (let round = 0; round < seg.rounds; round++) {
      for (const s of seg.steps) tally(resolve(s), s);
      if (seg.restBetweenRoundsSec && round < seg.rounds - 1) tally({ role: "recovery", seconds: seg.restBetweenRoundsSec, pace: null, paceFrom: null }, null);
    }
  }
  return { steps, totalSeconds: seconds, totalMeters: meters === null ? null : Math.round(meters), distanceAsTime, paceOwed, unresolved };
}
