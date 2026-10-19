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
 * last), at most RUN_WATCH_MAX_STEPS. Each step's pace band (`runStepBand`) is the one the coach wrote (`asked`), else
 * its effort's from the threshold (`paceBandFor`, the one function the card, the validator and the wire share;
 * `threshold`), else none — a recovery (review-2 M1), by feel, strides, hills, a race pace with no distance, or no
 * threshold known. A distance goes as its time at its
 * band's middle (`conversionPaceFor`: an effort with no band borrows the nearest one's, for its time only); with no
 * threshold and no pace asked a distance can't be timed (`unresolved`) and the run can't go to the watch. THE PREVIEW
 * IS THE WIRE: the run card's steps and the program `buildRunWatchProgram` writes are this one function's output.
 */
import { z } from "zod";
import { conversionPaceFor, paceBandFor, type PaceBand, type RunEffort } from "./pace.js";
import { RUN_EFFORTS, type WorkoutDoc, type WorkoutItem } from "./workout-doc.js";

/** The most steps a designed run puts on the watch, as its wire writes them (`runWatchStepCount`). */
export const RUN_WATCH_MAX_STEPS = 60;
/** The most rounds a part of a designed run takes (§8 phase 2: a sane cap, on either wire). */
export const RUN_WATCH_MAX_ROUNDS = 30;
/**
 * Which encoding a designed run goes to the watch in (§8 phase 2, the `RUN_WIRE_V2` switch): `v1` writes every step
 * out as a time (a distance as its time at its band's middle, the repeats written out round by round); `v2` writes a
 * distance as a distance (`targetType 5`) and a part's rounds as one repeat group (`runSegmentGroups`). The session is
 * the same on either: only how it is written, counted and shown differs. v1 is the default wherever none is given.
 */
export type RunWire = "v1" | "v2";
/**
 * The shortest step the app puts on the watch, in seconds (review-2 (e)): COROS's own minimum is unknown, a step of a
 * second or two is a shape no capture holds, and strides of 10–20 s stay fine. The validator refuses a shorter one.
 */
export const RUN_STEP_MIN_SEC = 10;
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
    rounds: z.number().int().min(1).max(RUN_WATCH_MAX_ROUNDS),
    steps: z.array(runWatchStepSchema).min(1).max(RUN_WATCH_MAX_STEPS),
    /** A standing rest after each round but the last, in seconds. */
    restBetweenRoundsSec: z.number().int().min(1).max(900).optional(),
  })
  .strict();
export type RunWatchSegment = z.infer<typeof runWatchSegmentSchema>;

/**
 * Whether a segment goes to the watch as one repeat group: on v2, a part of more than one round with no rest between
 * its rounds. That rest has no place in a group — it would follow the last round too — so such a part is written out,
 * round by round, as v1 writes it.
 */
export function runSegmentGroups(segment: Pick<RunWatchSegment, "rounds" | "restBetweenRoundsSec">, wire: RunWire): boolean {
  return wire === "v2" && segment.rounds > 1 && !segment.restBetweenRoundsSec;
}

/**
 * The steps a session's segments put on the watch, as `wire` writes them: v1 writes its repeats out (and the rests
 * between rounds); v2 writes a grouped part as its children and the group (`runSegmentGroups`), anything else as v1.
 */
export function runWatchStepCount(segments: readonly RunWatchSegment[], wire: RunWire = "v1"): number {
  return segments.reduce(
    (n, s) => n + (runSegmentGroups(s, wire) ? s.steps.length + 1 : s.rounds * s.steps.length + (s.restBetweenRoundsSec ? s.rounds - 1 : 0)),
    0,
  );
}

/** A part's rest between rounds as the watch takes it: whole seconds, none for a part of one round. */
const restBetweenOf = (part: WorkoutDoc["parts"][number]): number => {
  const rounds = part.rounds ?? 1;
  return part.restBetweenRoundsSec !== undefined && rounds > 1 ? Math.round(part.restBetweenRoundsSec) : 0;
};

/** The steps a run document puts on the watch as `wire` writes them (`runWatchStepCount`'s rule): the validator's count. */
export function runDocStepCount(doc: Pick<WorkoutDoc, "parts">, wire: RunWire = "v1"): number {
  return doc.parts.reduce((n, p) => {
    const rounds = p.rounds ?? 1;
    const rest = restBetweenOf(p);
    return n + (runSegmentGroups({ rounds, ...(rest > 0 ? { restBetweenRoundsSec: rest } : {}) }, wire) ? p.items.length + 1 : rounds * p.items.length + (rest > 0 ? rounds - 1 : 0));
  }, 0);
}

export const runWatchSessionSchema = z
  .object({
    kind: z.literal("run_watch"),
    /** The athlete-facing title — what the stamp reader un-stamps to. */
    title: z.string().min(1).max(200),
    segments: z.array(runWatchSegmentSchema).min(1).max(20),
  })
  .strict()
  // A session either wire can hold parses (v2's count is never more than v1's); the builder of the wire in use refuses
  // what it can't write (`buildRunWatchProgram`), and pushability asks first (`watchPushable`).
  .refine((s) => runWatchStepCount(s.segments, "v2") <= RUN_WATCH_MAX_STEPS, `more than ${RUN_WATCH_MAX_STEPS} steps on the watch`);
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

export type RunWatchRefusal = "mixed" | "open" | "too_many_rounds" | "too_many_steps";

/**
 * One document item as the watch takes it (the session's step, and the stage rows' — `designedRunStages`): its role,
 * its effort, its target in whole seconds, and a pace the athlete named ROUNDED TO WHOLE SECONDS (review-2 I1: the
 * wire has only ever carried whole seconds × 1000, and "8:00 /mi" is 298.258 s/km — the card, the stage rows and the
 * wire all read this one rounded copy). A move is `mixed`, an open segment `open`.
 */
export function runWatchStepOf(item: WorkoutItem, purpose: WorkoutDoc["parts"][number]["purpose"]): RunWatchStep | "mixed" | "open" {
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
  return { role, effort: item.effort, target, ...(t.pace ? { pace: { fastSecPerKm: Math.round(t.pace.fastSecPerKm), slowSecPerKm: Math.round(t.pace.slowSecPerKm) } } : {}) };
}

/**
 * A row's designed run as the watch takes it: the session of the coach's approved run (a proposal's document, every
 * item a run segment or a rest), else null — a plan run, a Studio workout, an import. Every path that rebuilds a
 * session from a row reads this before its stage rows (the body check's Undo; review-2 M2: the operator's content
 * convergence and absent push), so a designed run never goes back as its stage rows read as a thread-coach run.
 */
export function designedRunSession(doc: WorkoutDoc | null): RunWatchSession | null {
  if (!doc || doc.basedOn?.kind !== "proposal" || !isRunDoc(doc)) return null;
  const made = runWatchSessionOf(doc);
  return "session" in made ? made.session : null;
}

/** A designed run's session for the watch job (see the module comment), or why the wire can't hold it. */
export function runWatchSessionOf(doc: WorkoutDoc, wire: RunWire = "v1"): { session: RunWatchSession } | { refused: RunWatchRefusal } {
  const segments: RunWatchSegment[] = [];
  if (doc.parts.some((p) => (p.rounds ?? 1) > RUN_WATCH_MAX_ROUNDS)) return { refused: "too_many_rounds" };
  for (const part of doc.parts) {
    const steps: RunWatchStep[] = [];
    for (const item of part.items) {
      const step = runWatchStepOf(item, part.purpose);
      if (step === "mixed" || step === "open") return { refused: step };
      steps.push(step);
    }
    const rest = restBetweenOf(part);
    segments.push({ rounds: part.rounds ?? 1, steps, ...(rest > 0 ? { restBetweenRoundsSec: rest } : {}) });
  }
  if (runWatchStepCount(segments, wire) > RUN_WATCH_MAX_STEPS) return { refused: "too_many_steps" };
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
  /** v2: the distance goes to the watch as a distance (`targetType 5`) — `seconds` is then only its estimate. */
  asDistance?: true;
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

/**
 * A step's seconds on the watch: the time asked, or a distance at its pace's middle (the one named, else its effort's
 * conversion pace: `conversionPaceFor`); null when a distance can't be timed. The steps and the validator read it.
 */
export function runStepSeconds(s: RunWatchStep, thresholdSecPerKm: number | null | undefined): number | null {
  if (s.target.kind === "time") return s.target.seconds;
  const mid = s.pace
    ? (s.pace.fastSecPerKm + s.pace.slowSecPerKm) / 2
    : s.effort
      ? conversionPaceFor(s.effort, thresholdSecPerKm, { distanceM: s.target.meters })
      : null;
  return mid !== null ? Math.max(1, Math.round((s.target.meters / 1000) * mid)) : null;
}

/**
 * The pace band a step carries on the watch and where it came from: the one the athlete named (`asked`), else its
 * effort's from the threshold (race pace: for the step's own distance), else none. The steps, the stage rows and the
 * wire read this one function.
 */
export function runStepBand(s: RunWatchStep, thresholdSecPerKm: number | null | undefined): { band: PaceBand | null; from: "asked" | "threshold" | null } {
  // A RECOVERY GOES BARE (review-2 M1): on the watch a closed band through a recovery nags a walked or shuffled one
  // ("too slow"), the thread coach's rests have always gone bare, and a band on an exerciseType 4 step is a shape no
  // capture holds. A named pace still times a recovery's distance (`runWatchSteps`); it is just not a target.
  if (s.role === "recovery") return { band: null, from: null };
  if (s.pace) return { band: s.pace, from: "asked" };
  const band = s.effort ? paceBandFor(s.effort, thresholdSecPerKm, s.target.kind === "distance" ? { distanceM: s.target.meters } : {}) : null;
  return { band, from: band ? "threshold" : null };
}

/** The run's steps on the watch with the athlete's threshold (see the module comment). Pure. */
export function runWatchSteps(
  session: Pick<RunWatchSession, "segments">,
  thresholdSecPerKm: number | null | undefined,
  wire: RunWire = "v1",
): RunWatchResolved {
  const steps: RunWatchStepResolved[] = [];
  let distanceAsTime = 0;
  let paceOwed = 0;
  let unresolved = 0;
  let seconds: number | null = 0;
  let meters: number | null = 0;
  const resolve = (s: RunWatchStep): RunWatchStepResolved => {
    const distanceM = s.target.kind === "distance" ? s.target.meters : undefined;
    const { band, from } = runStepBand(s, thresholdSecPerKm);
    if (from === null && s.role !== "recovery" && s.effort && paceBandFor(s.effort, SOME_THRESHOLD, distanceM !== undefined ? { distanceM } : {})) paceOwed += 1;
    const secs = runStepSeconds(s, thresholdSecPerKm);
    // v2 runs a distance as a distance: no pace is needed to time it, and it is never "as its time".
    if (s.target.kind === "distance" && wire === "v1") {
      distanceAsTime += 1;
      if (secs === null) unresolved += 1;
    }
    return {
      role: s.role,
      ...(s.effort ? { effort: s.effort } : {}),
      seconds: secs,
      ...(distanceM !== undefined ? { meters: distanceM } : {}),
      ...(distanceM !== undefined && wire === "v2" ? { asDistance: true as const } : {}),
      pace: band,
      paceFrom: from,
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
      const p = r.pace ?? source.pace ?? null; // a recovery's named pace times it, though it carries no band
      const mid = p ? (p.fastSecPerKm + p.slowSecPerKm) / 2 : conversionPaceFor(source.effort, thresholdSecPerKm);
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
