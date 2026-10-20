/**
 * A STRUCTURED RUN RE-TIMED BY A FIXED RULE (the owner's decision, 2026-10-20).
 *
 * When the coach changes only a structured run's length (`adjust`), it states the new length and this does the
 * arithmetic — in code, so the card the athlete approves and the steps the app and the watch then hold are the same
 * numbers (the card is drawn from this function at propose time; the applier runs it again and refuses what differs).
 *
 * THE RULE
 *  1. The warm-up and the cool-down stay as they are.
 *  2. Repeated intervals change their count, not their length: 5 × 5 min at threshold becomes 3 × 5 min. A rep's recovery
 *     goes with it. The count is the one whose total is closest to the target (a tie: the fewer), never fewer than one.
 *  3. A continuous main block (easy, steady, tempo, long) scales to fill the rest: whole minutes for a time step, 100 m
 *     for a distance step. Only its work scales — a recovery in it, and a step under a minute (or 100 m), stay.
 *  4. Too short: when the warm-up + cool-down + one rep (or a 5-minute main block) doesn't fit, the warm-up and the
 *     cool-down shrink in proportion, down to RETIME_FLOOR_SEC each (one already shorter is its own floor); past that,
 *     refused (`too_short`), in words the coach reads: use `ease` to redesign it.
 *  5. Longer works in reverse: reps added — at most RETIME_REP_GROWTH times the count (rounded down) — then the main
 *     block extended. Nothing to scale but a warm-up and a cool-down: refused (`nothing_to_scale`), either way.
 *  6. A session that mixes repeats and a block: THE REPS FIRST — the count closest to the target with the block as it
 *     stands (longer: never past the target, so the block only extends) — THEN THE BLOCK for the remainder. A count that
 *     would leave the block under its floor is not taken. Several sets of repeats change together, each by the same
 *     share of its count.
 *  7. SHORT REPS ARE ACCESSORIES, NOT THE MAIN SET (the lead's ruling, 2026-10-20): a set whose work steps are each a
 *     minute or less, or 200 m or less (strides, pickups, short hill sprints), beside a main set — a continuous block, or
 *     longer reps — is kept as it is while the main set changes, as the warm-up and cool-down are; longer, it stays too.
 *     Only once the main set is at its floor (the block at five minutes, the reps at one) does its count give way: the
 *     most of it that leaves the block its floor (with no block, the count nearest the target), down to one, before the
 *     warm-up and cool-down shrink. Short reps with nothing else between the warm-up and cool-down (10 × 200 m) are the
 *     main set: their count changes, by rule 2.
 *  A target the session already is (to the minute) changes nothing (`changed: false`).
 *
 * THE SHAPE IS KEPT. What comes back has the same segments and the same steps, in order, with their roles and labels:
 * only a segment's `rounds` and a step's target move. A caller maps the result back onto its own form by position
 * (a workout document's parts and items, a plan run's stages) — or writes it out (`expandSegment`).
 *
 * The caller says what each step is: its role (`warmup`, `work`, `recovery`, `cooldown`), its time — a distance with
 * the seconds it is reckoned to take — and a word for its effort (the summary's: "steady 25 min (was 40)"). A run of
 * written-out reps is folded first (`foldRepeats`). Pure.
 */
import { formatStageDistance, formatStageDuration } from "./duration.js";

export type RetimeRole = "warmup" | "work" | "recovery" | "cooldown";
/** A time step's seconds; a distance step's metres, and the seconds it is reckoned to take. */
export type RetimeTarget = { kind: "time"; seconds: number } | { kind: "distance"; meters: number; seconds: number };
export interface RetimeStep {
  role: RetimeRole;
  target: RetimeTarget;
  /** Its effort in a word ("steady", "threshold"): the summary's, and what makes two written-out reps the same. */
  label?: string;
}
export interface RetimeSegment {
  /** How many times its steps run. */
  rounds: number;
  steps: RetimeStep[];
  /** A set of repeats — its count is what changes (a part with rounds, a repeat stage, a folded run of reps); else a
   * continuous stretch (a warm-up, a block, a cool-down). */
  repeat: boolean;
  /** A standing rest after each round but the last. */
  restBetweenRoundsSec?: number;
  /** The last round leaves off its last n steps: a written-out set whose last recovery isn't there. */
  lastRoundOmits?: number;
}
export interface RunStructure {
  segments: RetimeSegment[];
}

/** The warm-up's and the cool-down's floor when they shrink, and the least a main block shrinks to: five minutes. */
export const RETIME_FLOOR_SEC = 300;
/** Longer: a set of repeats grows to at most this many times its count (rounded down). */
export const RETIME_REP_GROWTH = 1.5;

export type RetimeRefusal = "too_short" | "nothing_to_scale";
export interface Retimed {
  structure: RunStructure;
  /** Its new length, in seconds (a distance at its reckoned time). */
  seconds: number;
  /** What changed in its structure, in a line: "3 × 5 min (was 5 × 5) · steady 18 min (was 20)" — "" when nothing did,
   * or when the run is one block (its length says it). */
  summary: string;
  changed: boolean;
}

const MINUTE = 60;
const HUNDRED_M = 100;

const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);
const stepsSeconds = (steps: readonly RetimeStep[]): number => sum(steps.map((s) => s.target.seconds));

/** A segment's seconds at `rounds` rounds: each round's steps, less what the last omits, and the rests between rounds. */
export function segmentSeconds(seg: RetimeSegment, rounds: number = seg.rounds): number {
  if (rounds <= 0) return 0;
  const omits = Math.min(seg.lastRoundOmits ?? 0, seg.steps.length);
  return rounds * stepsSeconds(seg.steps) - stepsSeconds(seg.steps.slice(seg.steps.length - omits)) + (seg.restBetweenRoundsSec ?? 0) * (rounds - 1);
}

/** A structure's seconds. */
export function runStructureSeconds(s: RunStructure): number {
  return sum(s.segments.map((x) => segmentSeconds(x)));
}

/** A segment written out: its steps, round after round, the last without what it omits (no rest between rounds). */
export function expandSegment(seg: RetimeSegment): RetimeStep[] {
  const out: RetimeStep[] = [];
  for (let r = 0; r < seg.rounds; r++) out.push(...(r === seg.rounds - 1 ? seg.steps.slice(0, seg.steps.length - (seg.lastRoundOmits ?? 0)) : seg.steps));
  return out;
}

const sameStep = (a: RetimeStep, b: RetimeStep): boolean =>
  a.role === b.role &&
  a.label === b.label &&
  a.target.kind === b.target.kind &&
  (a.target.kind === "time" ? a.target.seconds === b.target.seconds : a.target.meters === (b.target as { meters: number }).meters);

/**
 * A run of written-out steps as segments: a stretch that repeats — a period holding work, run at least twice, the last
 * round perhaps without its trailing recovery — is one set of repeats (the longest stretch from here; a tie, the
 * shortest period); every other step is its own continuous segment.
 */
export function foldRepeats(steps: readonly RetimeStep[]): RetimeSegment[] {
  const out: RetimeSegment[] = [];
  let i = 0;
  while (i < steps.length) {
    let best: { p: number; n: number; omits: number; end: number } | null = null;
    for (let p = 1; i + p < steps.length; p++) {
      const period = steps.slice(i, i + p);
      if (!period.some((s) => s.role === "work")) continue;
      let n = 1;
      let j = i + p;
      while (j + p <= steps.length && steps.slice(j, j + p).every((s, k) => sameStep(s, period[k]!))) {
        n += 1;
        j += p;
      }
      // A last round short of its trailing recovery.
      let m = 0;
      while (m < p - 1 && j + m < steps.length && sameStep(steps[j + m]!, period[m]!)) m += 1;
      let omits = 0;
      if (m > 0 && period.slice(m).every((s) => s.role === "recovery")) {
        n += 1;
        omits = p - m;
        j += m;
      }
      if (n >= 2 && (!best || j > best.end)) best = { p, n, omits, end: j };
    }
    if (best) {
      out.push({ rounds: best.n, repeat: true, steps: steps.slice(i, i + best.p), ...(best.omits > 0 ? { lastRoundOmits: best.omits } : {}) });
      i = best.end;
    } else {
      out.push({ rounds: 1, repeat: false, steps: [steps[i]!] });
      i += 1;
    }
  }
  return out;
}

// ── The rule ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A rep this short or shorter is an accessory beside a main set (the lead's ruling, 2026-10-20): a minute, or 200 m. */
export const ACCESSORY_MAX_SEC = 60;
export const ACCESSORY_MAX_METERS = 200;

/** A set of short reps — strides, pickups, short hill sprints: each of its work steps a minute or less, or 200 m or less. */
function isAccessory(seg: RetimeSegment): boolean {
  const work = seg.steps.filter((s) => s.role === "work");
  return work.length > 0 && work.every((s) => (s.target.kind === "time" ? s.target.seconds <= ACCESSORY_MAX_SEC : s.target.meters <= ACCESSORY_MAX_METERS));
}

/** A step that a block's scaling moves: work long enough to be a block (a minute, or 100 m). */
const scalable = (s: RetimeStep): boolean =>
  s.role !== "recovery" && (s.target.kind === "time" ? s.target.seconds >= MINUTE : s.target.meters >= HUNDRED_M);

/** A step at `seconds`: a time to the whole minute (at least one), a distance to the 100 m (at least 100) at its pace. */
function stepAt(s: RetimeStep, seconds: number): RetimeStep {
  if (s.target.kind === "time") {
    const next = Math.max(MINUTE, Math.round(seconds / MINUTE) * MINUTE);
    return next === s.target.seconds ? s : { ...s, target: { kind: "time", seconds: next } };
  }
  const perMeter = s.target.seconds / s.target.meters;
  const meters = Math.max(HUNDRED_M, Math.round(seconds / perMeter / HUNDRED_M) * HUNDRED_M);
  return meters === s.target.meters ? s : { ...s, target: { kind: "distance", meters, seconds: meters * perMeter } };
}

/** Where a group's steps are: segment and step indices. */
type At = readonly [number, number];

/**
 * Scale the steps at `at` (in `segs`, in place) together to about `total` seconds: each by the same share, then rounded.
 * A drift of the rounding is taken up a minute at a time on the group's longest time step, so the whole lands on
 * `wanted` minutes (when given) — but never below `floor` seconds for the group.
 */
function scaleGroup(segs: RetimeSegment[], at: readonly At[], total: number, floor: number, landOn: () => number, wanted: number | null): void {
  const cur = sum(at.map(([i, j]) => segs[i]!.steps[j]!.target.seconds));
  if (at.length === 0 || cur <= 0) return;
  const share = total / cur;
  for (const [i, j] of at) {
    const steps = segs[i]!.steps;
    steps[j] = stepAt(steps[j]!, steps[j]!.target.seconds * share);
  }
  if (wanted === null) return;
  const times = at.filter(([i, j]) => segs[i]!.steps[j]!.target.kind === "time");
  if (times.length === 0) return;
  const [li, lj] = times.reduce((a, b) => (segs[b[0]]!.steps[b[1]]!.target.seconds > segs[a[0]]!.steps[a[1]]!.target.seconds ? b : a));
  const groupSeconds = () => sum(at.map(([i, j]) => segs[i]!.steps[j]!.target.seconds));
  for (let tries = 0; tries < 3; tries++) {
    const off = Math.round(landOn() / MINUTE) - wanted;
    if (off === 0) return;
    const step = segs[li]!.steps[lj]!;
    const next = step.target.seconds - Math.sign(off) * MINUTE;
    if (next < MINUTE || (off > 0 && groupSeconds() - MINUTE < floor)) return;
    segs[li]!.steps[lj] = { ...step, target: { kind: "time", seconds: next } };
  }
}

const isWarmup = (s: RetimeSegment) => s.rounds === 1 && !s.repeat && s.steps.some((x) => x.role === "warmup") && s.steps.every((x) => x.role === "warmup" || x.role === "recovery");
const isCooldown = (s: RetimeSegment) => s.rounds === 1 && !s.repeat && s.steps.some((x) => x.role === "cooldown") && s.steps.every((x) => x.role === "cooldown" || x.role === "recovery");

const words = {
  tooShort: (minutes: number, what: string) =>
    `At ${minutes} min the session is too short to keep its warm-up, cool-down and ${what}: use ease to redesign it.`,
  nothing: "Only its warm-up and cool-down could change: there's no main set or block to re-time. Use ease to redesign it.",
};

/**
 * The run re-timed to `targetSeconds` by the rule (see the module comment), or refused with the reason the coach reads.
 * Never changes what it is given.
 */
export function retimeRun(structure: RunStructure, targetSeconds: number): Retimed | { refused: RetimeRefusal; reason: string } {
  const was = structure.segments;
  const segs: RetimeSegment[] = was.map((s) => ({ ...s, steps: s.steps.map((x) => ({ ...x, target: { ...x.target } })) }));
  const total = runStructureSeconds(structure);
  const wantedMinutes = Math.round(targetSeconds / MINUTE);
  if (Math.round(total / MINUTE) === wantedMinutes) return { structure: copyOf(structure), seconds: total, summary: "", changed: false };

  // The warm-up leads, the cool-down closes; between them the repeats and the blocks.
  let a = 0;
  while (a < segs.length && isWarmup(segs[a]!)) a += 1;
  let b = segs.length;
  while (b > a && isCooldown(segs[b - 1]!)) b -= 1;
  const middle = segs.map((_, i) => i).filter((i) => i >= a && i < b);
  const blockAt: At[] = middle.filter((i) => !segs[i]!.repeat).flatMap((i) => segs[i]!.steps.flatMap((s, j) => (scalable(s) ? [[i, j] as const] : [])));
  // Short reps beside a main set — a block, or longer reps — are its accessories: kept, as the warm-up and cool-down
  // are. Short reps alone are the main set, and their count changes.
  const allReps = middle.filter((i) => segs[i]!.repeat);
  const hasMain = blockAt.length > 0 || allReps.some((i) => !isAccessory(segs[i]!));
  const reps = hasMain ? allReps.filter((i) => !isAccessory(segs[i]!)) : allReps;
  const extras = hasMain ? allReps.filter((i) => isAccessory(segs[i]!)) : [];
  const extrasNow = () => sum(extras.map((i) => segmentSeconds(segs[i]!)));
  const fixedInBlocks = sum(middle.filter((i) => !segs[i]!.repeat).flatMap((i) => segs[i]!.steps.filter((s) => !scalable(s)).map((s) => s.target.seconds)));
  const warmAt: At[] = segs.flatMap((s, i) => (i < a ? s.steps.flatMap((x, j) => (x.role === "warmup" ? [[i, j] as const] : [])) : []));
  const coolAt: At[] = segs.flatMap((s, i) => (i >= b ? s.steps.flatMap((x, j) => (x.role === "cooldown" ? [[i, j] as const] : [])) : []));
  const secondsAt = (at: readonly At[]) => sum(at.map(([i, j]) => segs[i]!.steps[j]!.target.seconds));
  const W = sum(segs.slice(0, a).map((s) => segmentSeconds(s)));
  const D = sum(segs.slice(b).map((s) => segmentSeconds(s)));
  const K0 = secondsAt(blockAt);

  if (reps.length === 0 && blockAt.length === 0) return { refused: "nothing_to_scale", reason: words.nothing };

  const shorter = targetSeconds < total;
  const blockFloor = Math.min(K0, RETIME_FLOOR_SEC);
  const oneEach = sum([...reps, ...extras].map((i) => segmentSeconds(segs[i]!, 1)));
  const leastMiddle = fixedInBlocks + blockFloor + oneEach;
  const now = () => runStructureSeconds({ segments: segs });

  if (shorter && W + D + leastMiddle > targetSeconds) {
    // Rule 4: one rep each, the block at its floor, the warm-up and cool-down shrunk in proportion to what is left.
    const warmFixed = W - secondsAt(warmAt);
    const coolFixed = D - secondsAt(coolAt);
    const warmFloor = warmFixed + Math.min(secondsAt(warmAt), RETIME_FLOOR_SEC);
    const coolFloor = coolFixed + Math.min(secondsAt(coolAt), RETIME_FLOOR_SEC);
    const room = targetSeconds - leastMiddle;
    if (warmFloor + coolFloor > room + 0.5) {
      return { refused: "too_short", reason: words.tooShort(wantedMinutes, reps.length > 0 ? "one rep" : "a 5-minute main block") };
    }
    for (const i of [...reps, ...extras]) segs[i]!.rounds = 1;
    scaleGroup(segs, blockAt, blockFloor, blockFloor, now, null);
    const roomMinutes = Math.floor(room / MINUTE);
    let w = W + D > 0 ? Math.round((roomMinutes * W) / (W + D)) * MINUTE : 0;
    let c = roomMinutes * MINUTE - w;
    if (w < warmFloor) {
      w = warmFloor;
      c = room - w;
    } else if (c < coolFloor) {
      c = coolFloor;
      w = room - c;
    }
    scaleGroup(segs, warmAt, w - warmFixed, warmFloor - warmFixed, now, null);
    scaleGroup(segs, coolAt, c - coolFixed, coolFloor - coolFixed, now, null);
    return result(structure, segs, a, b);
  }

  // Rule 2, 5 and 6: the counts first — the block as it stands, the accessories as they are — then the block for what
  // is left.
  const held = extrasNow();
  if (reps.length > 0) {
    const lo = (i: number) => (shorter ? 1 : segs[i]!.rounds);
    const hi = (i: number) => (shorter ? segs[i]!.rounds : Math.max(segs[i]!.rounds, Math.floor(segs[i]!.rounds * RETIME_REP_GROWTH)));
    const best = bestCounts(segs, reps, lo, hi, (repSeconds) => {
      const base = W + D + fixedInBlocks + held + repSeconds;
      if (blockAt.length > 0 && (shorter ? targetSeconds - base < blockFloor : targetSeconds - base < K0)) return null;
      return Math.abs(targetSeconds - (base + K0));
    });
    // No count leaves the block its floor beside the accessories: one each, and the accessories give way (below).
    if (best) reps.forEach((i, k) => (segs[i]!.rounds = best[k]!));
    else if (shorter) for (const i of reps) segs[i]!.rounds = 1;
  }
  const repSeconds = sum(reps.map((i) => segmentSeconds(segs[i]!)));
  // THE ACCESSORIES GIVE WAY only once the main set is at its floor — the block at five minutes, the reps at one — and
  // only so far: the most of their count that leaves the block its floor; with no block, the count nearest the target.
  if (shorter && extras.length > 0) {
    const rest = W + D + fixedInBlocks + repSeconds;
    const mainAtFloor = blockAt.length > 0 ? targetSeconds - rest - held < blockFloor : reps.every((i) => segs[i]!.rounds === 1) && rest + held > targetSeconds;
    if (mainAtFloor) {
      const counts = bestCounts(segs, extras, () => 1, (i) => segs[i]!.rounds, (extraSeconds) => {
        if (blockAt.length > 0) return targetSeconds - rest - extraSeconds < blockFloor ? null : -extraSeconds;
        return Math.abs(targetSeconds - rest - extraSeconds);
      });
      extras.forEach((i, k) => (segs[i]!.rounds = counts?.[k] ?? 1));
    }
  }
  if (blockAt.length > 0) {
    const block = Math.max(shorter ? blockFloor : K0, targetSeconds - W - D - fixedInBlocks - repSeconds - extrasNow());
    scaleGroup(segs, blockAt, block, blockFloor, now, wantedMinutes);
  }
  return result(structure, segs, a, b);
}

/**
 * The counts of the repeat segments at `at`, each between `lo` and `hi`, all by one share of their counts — the share
 * whose seconds `score` scores lowest (null: not allowed), a tie to the fewer seconds. Null when no share is allowed.
 */
function bestCounts(
  segs: readonly RetimeSegment[],
  at: readonly number[],
  lo: (i: number) => number,
  hi: (i: number) => number,
  score: (seconds: number) => number | null,
): number[] | null {
  const shares = new Set<number>([0, 1, Number.POSITIVE_INFINITY]);
  for (const i of at) for (let k = lo(i); k <= hi(i); k++) shares.add(k / segs[i]!.rounds);
  let best: { counts: number[]; score: number; seconds: number } | null = null;
  for (const share of [...shares].sort((x, y) => x - y)) {
    const counts = at.map((i) => Math.min(hi(i), Math.max(lo(i), Math.round(segs[i]!.rounds * share))));
    const seconds = sum(at.map((i, k) => segmentSeconds(segs[i]!, counts[k])));
    const s = score(seconds);
    if (s === null) continue;
    if (!best || s < best.score - 1e-9 || (Math.abs(s - best.score) <= 1e-9 && seconds < best.seconds)) best = { counts, score: s, seconds };
  }
  return best ? best.counts : null;
}

function copyOf(s: RunStructure): RunStructure {
  return { segments: s.segments.map((x) => ({ ...x, steps: x.steps.map((st) => ({ ...st, target: { ...st.target } })) })) };
}

/** A target as the athlete reads it: "5 min", "1:30", "45s", "400 m", "1.2 km". */
const said = (t: RetimeTarget): string => (t.kind === "time" ? formatStageDuration(t.seconds) : formatStageDistance(t.meters));

/** What it was, beside what it is: the number alone when the unit is the same ("(was 40)"), else the whole. */
function wasBeside(now: string, before: string): string {
  const unit = (x: string) => /^[\d.:]+\s?(.*)$/.exec(x)?.[1] ?? null;
  const num = /^([\d.:]+)/.exec(before)?.[1];
  return unit(now) !== null && unit(now) === unit(before) && num ? num : before;
}

/** A segment's length said as one figure: its one step's target, else its whole minutes. */
function lengthOf(seg: RetimeSegment): string {
  return seg.steps.length === 1 && seg.rounds === 1 ? said(seg.steps[0]!.target) : formatStageDuration(Math.round(segmentSeconds(seg) / MINUTE) * MINUTE);
}

function result(before: RunStructure, segs: RetimeSegment[], a: number, b: number): Retimed {
  const structure: RunStructure = { segments: segs };
  const parts: string[] = [];
  const changedSeg = (i: number) => {
    const x = before.segments[i]!;
    const y = segs[i]!;
    return x.rounds !== y.rounds || x.steps.some((s, j) => JSON.stringify(s.target) !== JSON.stringify(y.steps[j]!.target));
  };
  const single = before.segments.length === 1 && before.segments[0]!.rounds === 1 && before.segments[0]!.steps.length === 1;
  segs.forEach((y, i) => {
    if (!changedSeg(i)) return;
    const x = before.segments[i]!;
    if (i < a || i >= b) {
      const now = lengthOf(y);
      parts.push(`${i < a ? "warm-up" : "cool-down"} ${now} (was ${wasBeside(now, lengthOf(x))})`);
      return;
    }
    if (y.repeat) {
      const rep = (y.steps.find((s) => s.role === "work") ?? y.steps[0]!).target;
      const now = said(rep);
      parts.push(`${y.rounds} × ${now} (was ${x.rounds} × ${wasBeside(now, now)})`);
      return;
    }
    if (single) return;
    y.steps.forEach((s, j) => {
      const old = x.steps[j]!;
      if (JSON.stringify(s.target) === JSON.stringify(old.target)) return;
      const now = said(s.target);
      parts.push(`${s.label ?? "main"} ${now} (was ${wasBeside(now, said(old.target))})`);
    });
  });
  const changed = before.segments.some((_, i) => changedSeg(i));
  return { structure, seconds: runStructureSeconds(structure), summary: parts.join(" · "), changed };
}
