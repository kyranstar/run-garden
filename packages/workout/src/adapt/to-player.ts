/**
 * The document → the steps the player plays (the session engine's `Step`). One builder per output (principles §3.2):
 * for an engine build, `playerStepsFromDoc(docFromBuild(b))` is the build's own steps, step for step (the test holds
 * it for 50 seeded builds); any other document plays by the same rules.
 *
 * RULES (the engine's `groupSteps`, read from the document's numbers)
 * - Blocks: arrive → arrive, warmup and activation → prep, main, power and run → core, accessory and conditioning →
 *   accessory, care → care, cooldown → cooldown. Slots are numbered in play order within a block ("core:0", …).
 * - A move with `holdSec` (or `carryM`, a 1 m/s walk) plays timed windows of that many seconds: per side (`perSide`
 *   with no fixed side) a Left then a Right window. A move with neither plays self-paced sets of its reps (a range's
 *   low, else breaths, else the record's low) x seconds per rep (the tempo's sum, else the record's, else 3) x sides,
 *   plus 10 s to log. A window's lead-in is 3 s in a flow or circuit, else 8 s. A window is logged (the last side's)
 *   when the move takes a load; a set always is.
 * - A step's target is null unless the item states a load, a number of reps or a progression note (then: reps, the
 *   load as typed, the hold, the note, the record's range); a ladder rung always has one.
 * - holds, flow (and any other format): each move's sets of windows, in order; rest items as rests.
 * - straight (and steady): each move's sets, a rest after every set but the last of the part (the item's `restSec`,
 *   else the record's, else 60; zero means none).
 * - superset: each move plays its sets x rounds; round by round, the moves in order, then the rest between rounds
 *   (`restBetweenRoundsSec`, else the longest of the moves' rests).
 * - circuit (and intervals): round by round, each station one window (or a run segment), the rest items between
 *   stations as written, and `restBetweenRoundsSec` between rounds.
 * - ladder: `rounds` rungs whose reps step evenly from the reps range's low to its high; round by round the moves in
 *   order, `restBetweenRoundsSec` between rungs.
 * - Any other part with `rounds` plays its sequence that many times, `restBetweenRoundsSec` between.
 * - A free-text move or a run segment plays with no move id. A run segment of a duration is a timed window; one of a
 *   distance (at the pace band's middle, else 6:00/km) or an open one (a nominal 10 minutes) is a self-paced step.
 */
import type { WorkoutDoc, WorkoutDose, WorkoutItem, WorkoutPart } from "@rg/domain";
import type { BlockId, ExerciseRecord, FormatId } from "@rg/exercise-library";
import { Builder, type Step, type Target } from "@rg/session-engine";
import { makeLibraryIndex } from "../derive.js";
import { WHY_SEPARATOR } from "../convert/from-build.js";
import { weightOfLoad } from "../convert/shared.js";

/** The engine's planning estimate for logging one set (`builder.ts` LOG_SECONDS). */
const LOG_SECONDS = 10;
const DEFAULT_REST_SECONDS = 60;
const DEFAULT_SECS_PER_REP = 3;
const DEFAULT_RUN_SECS_PER_KM = 360;
const OPEN_RUN_SECONDS = 600;

export const BLOCK_OF_PURPOSE: Record<WorkoutPart["purpose"], BlockId> = {
  arrive: "arrive", warmup: "prep", activation: "prep", main: "core", power: "core", run: "core",
  accessory: "accessory", conditioning: "accessory", care: "care", cooldown: "cooldown",
};
const FORMAT_ID: Record<WorkoutPart["format"], FormatId> = {
  straight: "straight", superset: "superset", circuit: "circuit", ladder: "ladder", flow: "flow", holds: "holds",
  intervals: "circuit", steady: "straight",
};

type Move = Extract<WorkoutItem, { kind: "exercise" | "free_exercise" }>;
type Run = Extract<WorkoutItem, { kind: "run" }>;

interface Slot {
  key: string;
  item: Move | Run;
  rec: ExerciseRecord | undefined;
  exerciseId: string | null;
  why: string[];
  group: string | null;
}

interface Ctx {
  block: BlockId;
  fid: FormatId;
}

const round5 = (n: number): number => Math.max(5, Math.round(n / 5) * 5);
const mid = (r: readonly [number, number]): number => (r[0] + r[1]) / 2;
const isMove = (s: Slot): s is Slot & { item: Move } => s.item.kind !== "run";

export function playerStepsFromDoc(doc: WorkoutDoc, library: readonly ExerciseRecord[]): Step[] {
  const find = makeLibraryIndex(library);
  const next: Partial<Record<BlockId, number>> = {};
  const out: Step[] = [];
  for (const part of doc.parts) {
    const ctx: Ctx = { block: BLOCK_OF_PURPOSE[part.purpose], fid: FORMAT_ID[part.format] };
    let letter = 0;
    const slots = part.items.map((item): Slot | null => {
      if (item.kind === "rest") return null;
      const n = next[ctx.block] ?? 0;
      next[ctx.block] = n + 1;
      const rec = item.kind === "exercise" ? find(item.libraryId) : undefined;
      return {
        key: `${ctx.block}:${n}`,
        item,
        rec,
        exerciseId: item.kind === "exercise" ? (rec?.id ?? item.libraryId) : null,
        why: item.why ? item.why.split(WHY_SEPARATOR) : [],
        group: part.format === "superset" && item.kind !== "run" ? String.fromCharCode(65 + letter++) : null,
      };
    });
    out.push(...partSteps(part, slots, ctx));
  }
  return out;
}

function partSteps(part: WorkoutPart, slots: Array<Slot | null>, ctx: Ctx): Step[] {
  const onlyMoves = part.items.every((i) => i.kind === "exercise" || i.kind === "free_exercise");
  if (part.format === "superset" && onlyMoves) return superset(part, slots as Slot[], ctx);
  if (part.format === "ladder" && onlyMoves) return ladder(part, slots as Slot[], ctx);
  if (part.format === "circuit" || part.format === "intervals") return circuit(part, slots, ctx);
  const once = (round: number | null) => (part.format === "straight" || part.format === "steady" ? straight(part, slots, ctx, round) : sequence(part, slots, ctx, round));
  const rounds = part.rounds ?? 1;
  if (rounds <= 1) return once(null);
  const steps: Step[] = [];
  for (let r = 0; r < rounds; r++) {
    steps.push(...once(r + 1));
    const last = lastKey(slots);
    if (r < rounds - 1 && (part.restBetweenRoundsSec ?? 0) > 0 && last) steps.push(rest(last, part.restBetweenRoundsSec!, ctx));
  }
  return steps;
}

const lastKey = (slots: Array<Slot | null>): string | null => [...slots].reverse().find((s) => s)?.key ?? null;
const firstKey = (slots: Array<Slot | null>): string | null => slots.find((s) => s)?.key ?? null;

/** Holds, flow, and any format without its own rule: each item in order. */
function sequence(part: WorkoutPart, slots: Array<Slot | null>, ctx: Ctx, round: number | null): Step[] {
  const steps: Step[] = [];
  let prev = firstKey(slots);
  part.items.forEach((item, i) => {
    const slot = slots[i];
    if (item.kind === "rest" || !slot) {
      if (item.kind === "rest" && prev) steps.push(rest(prev, item.seconds, ctx));
      return;
    }
    prev = slot.key;
    if (!isMove(slot)) {
      steps.push(runStep(slot, ctx, round));
      return;
    }
    const sets = slot.item.dose.sets ?? 1;
    for (let s = 0; s < sets; s++) steps.push(...windows(slot, ctx, { setIndex: s, setCount: sets }, round));
  });
  return steps;
}

function straight(part: WorkoutPart, slots: Array<Slot | null>, ctx: Ctx, round: number | null): Step[] {
  const steps: Step[] = [];
  const lastMove = slots.reduce((at, s, i) => (s && isMove(s) ? i : at), -1);
  let prev = firstKey(slots);
  part.items.forEach((item, i) => {
    const slot = slots[i];
    if (item.kind === "rest" || !slot) {
      if (item.kind === "rest" && prev) steps.push(rest(prev, item.seconds, ctx));
      return;
    }
    prev = slot.key;
    if (!isMove(slot)) {
      steps.push(runStep(slot, ctx, round));
      return;
    }
    const sets = slot.item.dose.sets ?? 1;
    for (let s = 0; s < sets; s++) {
      steps.push(...oneSet(slot, ctx, { setIndex: s, setCount: sets }, round));
      const seconds = restSeconds(slot);
      if (!(i === lastMove && s === sets - 1) && seconds > 0) steps.push(rest(slot.key, seconds, ctx));
    }
  });
  return steps;
}

function superset(part: WorkoutPart, slots: Slot[], ctx: Ctx): Step[] {
  const moves = slots.filter(isMove);
  const rounds = part.rounds ?? 1;
  const passes = (s: Slot & { item: Move }) => (s.item.dose.sets ?? 1) * rounds;
  const n = Math.max(...moves.map(passes));
  const restSec = part.restBetweenRoundsSec ?? Math.max(...moves.map(restSeconds));
  const steps: Step[] = [];
  for (let s = 0; s < n; s++) {
    for (const m of moves) if (s < passes(m)) steps.push(...oneSet(m, ctx, { setIndex: s, setCount: passes(m) }, null));
    if (s < n - 1 && restSec > 0) steps.push(rest(moves[0]!.key, restSec, ctx));
  }
  return steps;
}

function circuit(part: WorkoutPart, slots: Array<Slot | null>, ctx: Ctx): Step[] {
  const rounds = part.rounds ?? 1;
  const steps: Step[] = [];
  for (let r = 0; r < rounds; r++) {
    let prev = firstKey(slots);
    part.items.forEach((item, i) => {
      const slot = slots[i];
      if (item.kind === "rest" || !slot) {
        if (item.kind === "rest" && prev) steps.push(rest(prev, item.seconds, ctx));
        return;
      }
      prev = slot.key;
      if (!isMove(slot)) {
        steps.push(runStep(slot, ctx, r + 1, { setIndex: r, setCount: rounds }));
        return;
      }
      steps.push({
        ...base(slot, ctx, { setIndex: r, setCount: rounds, target: targetOf(slot) }),
        kind: "timed", seconds: windowSeconds(slot), prepGap: Builder.CHIME_SECONDS,
        format: { id: ctx.fid, group: null, round: r + 1 },
      });
    });
    const last = lastKey(slots);
    if (r < rounds - 1 && (part.restBetweenRoundsSec ?? 0) > 0 && last) steps.push(rest(last, part.restBetweenRoundsSec!, ctx));
  }
  return steps;
}

function ladder(part: WorkoutPart, slots: Slot[], ctx: Ctx): Step[] {
  const moves = slots.filter(isMove);
  const rounds = part.rounds ?? moves[0]?.item.dose.sets ?? 1;
  const steps: Step[] = [];
  for (let r = 0; r < rounds; r++) {
    for (const m of moves) {
      const reps = rungOf(m.item.dose.reps, r, rounds);
      steps.push(...oneSet(m, ctx, { setIndex: r, setCount: rounds, target: targetOf(m, reps) }, null));
    }
    if (r < rounds - 1 && (part.restBetweenRoundsSec ?? 0) > 0) steps.push(rest(moves[0]!.key, part.restBetweenRoundsSec!, ctx));
  }
  return steps;
}

/** Rung r of n: the reps range's low to its high in even steps. */
function rungOf(reps: WorkoutDose["reps"], r: number, n: number): number {
  if (reps === undefined) return 0;
  if (typeof reps === "number") return reps;
  return n > 1 ? Math.round(reps.min + (r * (reps.max - reps.min)) / (n - 1)) : reps.max;
}

function base(slot: Slot, ctx: Ctx, extra: Partial<Step>): Step {
  return {
    kind: "timed", seconds: 0, slotKey: slot.key, block: ctx.block, exerciseId: slot.exerciseId, side: null,
    setIndex: 0, setCount: 1, target: null, format: { id: ctx.fid, group: slot.group, round: null },
    why: slot.why, isNew: false, log: false, prepGap: 0,
    ...extra,
  };
}

function rest(key: string, seconds: number, ctx: Ctx): Step {
  return {
    kind: "rest", slotKey: key, block: ctx.block, exerciseId: null, side: null, setIndex: null, setCount: null,
    seconds, prepGap: 0, target: null, format: { id: ctx.fid, group: null, round: null }, why: [], isNew: false, log: false,
  };
}

const timedDose = (d: WorkoutDose): boolean => d.holdSec !== undefined || d.carryM !== undefined;

/** One set of a move: windows for a timed dose, else one self-paced set. */
function oneSet(slot: Slot & { item: Move }, ctx: Ctx, extra: { setIndex: number; setCount: number; target?: Partial<Target> | null }, round: number | null): Step[] {
  if (timedDose(slot.item.dose)) return windows(slot, ctx, extra, round);
  const target = extra.target !== undefined ? extra.target : targetOf(slot);
  return [{
    ...base(slot, ctx, { ...extra, target }),
    kind: "set", seconds: setSeconds(slot, target), log: true,
    ...(round !== null ? { format: { id: ctx.fid, group: slot.group, round } } : {}),
  }];
}

function windows(slot: Slot & { item: Move }, ctx: Ctx, extra: { setIndex: number; setCount: number; target?: Partial<Target> | null }, round: number | null): Step[] {
  const seconds = windowSeconds(slot);
  const prepGap = ctx.fid === "flow" || ctx.fid === "circuit" ? Builder.CHIME_SECONDS : Builder.PREP_SECONDS;
  const logged = slot.rec ? slot.rec.load !== "none" : slot.item.dose.load !== undefined;
  const target = extra.target !== undefined ? extra.target : targetOf(slot);
  const one = (more: Partial<Step>): Step => ({
    ...base(slot, ctx, { ...extra, target }),
    kind: "timed", seconds, prepGap,
    ...(round !== null ? { format: { id: ctx.fid, group: slot.group, round } } : {}),
    ...more,
  });
  const fixed = slot.item.kind === "exercise" ? slot.item.side : undefined;
  if (slot.item.dose.perSide && fixed === undefined) return [one({ side: "Left" }), one({ side: "Right", log: logged })];
  return [one({ side: fixed === "left" ? "Left" : fixed === "right" ? "Right" : null, log: logged })];
}

/** What a step's target says: null unless the item states a load, reps or a progression note. */
function targetOf(slot: Slot & { item: Move }, rungReps?: number): Partial<Target> | null {
  const d = slot.item.dose;
  const reps = rungReps ?? (typeof d.reps === "number" ? d.reps : null);
  const progression = slot.item.kind === "exercise" ? slot.item.progression : undefined;
  if (d.load === undefined && reps === null && progression === undefined && rungReps === undefined) return null;
  return {
    ...(slot.rec ? { lo: slot.rec.dose.range[0], hi: slot.rec.dose.range[1], type: slot.rec.dose.type } : {}),
    reps,
    secs: d.holdSec ?? null,
    w: weightOfLoad(d.load),
    note: progression ?? "",
  };
}

/** A timed window's seconds: the hold, a carry at 1 m/s, else what the engine would give the move. */
function windowSeconds(slot: Slot & { item: Move }): number {
  const d = slot.item.dose;
  if (d.holdSec !== undefined) return d.holdSec;
  if (d.carryM !== undefined) return d.carryM;
  const r = slot.rec?.dose;
  const reps = typeof d.reps === "number" ? d.reps : d.reps?.min;
  if (!r) return Math.max(30, round5((reps ?? d.breaths ?? 0) * DEFAULT_SECS_PER_REP));
  if (r.type === "time") return round5(mid(r.range));
  if (r.type === "carry") return r.range[1];
  if (r.type === "breaths") return round5((d.breaths ?? mid(r.range)) * 6);
  const n = reps ?? Math.round(mid(r.range));
  return Math.max(30, round5(n * (slot.rec!.laterality === "alternating" ? 2 : 1) * (r.secsPerRep || 4)));
}

/** A self-paced set's planning estimate. */
function setSeconds(slot: Slot & { item: Move }, target: Partial<Target> | null): number {
  const d = slot.item.dose;
  const reps = (target && target.reps) || (typeof d.reps === "number" ? d.reps : d.reps?.min) || d.breaths || slot.rec?.dose.range[0] || 0;
  const t = d.tempo;
  const tempo = t ? (t.eccentricSec ?? 0) + (t.pauseSec ?? 0) + (t.concentricSec ?? 0) : 0;
  const perRep = tempo > 0 ? tempo : slot.rec?.dose.secsPerRep || DEFAULT_SECS_PER_REP;
  return reps * perRep * (d.perSide ? 2 : 1) + LOG_SECONDS;
}

/** The rest after a set: the item's, else the record's, else 60 (zero stated means none). */
function restSeconds(slot: Slot & { item: Move }): number {
  return slot.item.dose.restSec ?? (slot.rec?.dose.restSec || DEFAULT_REST_SECONDS);
}

function runStep(slot: Slot, ctx: Ctx, round: number | null, extra: Partial<Step> = {}): Step {
  const run = slot.item as Run;
  const t = run.target;
  const timed = t.durationSec !== undefined;
  const perKm = t.pace ? (t.pace.fastSecPerKm + t.pace.slowSecPerKm) / 2 : DEFAULT_RUN_SECS_PER_KM;
  const seconds = timed ? t.durationSec! : t.distanceM !== undefined ? Math.round((t.distanceM / 1000) * perKm) : OPEN_RUN_SECONDS;
  return {
    ...base(slot, ctx, extra),
    kind: timed ? "timed" : "set",
    seconds,
    why: run.why ? [run.why] : [],
    ...(round !== null ? { format: { id: ctx.fid, group: null, round } } : {}),
  };
}
