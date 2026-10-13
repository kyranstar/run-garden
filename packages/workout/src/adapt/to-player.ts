/**
 * The document → the steps the player plays (the session engine's `Step`). One builder per output (principles §3.2):
 * for an engine build, `playerStepsFromDoc(docFromBuild(b))` is the build's own steps, step for step (the test holds
 * it for 50 seeded builds); any other document plays by the same rules.
 *
 * RULES (the engine's `groupSteps`, read from the document's numbers)
 * - Size first: a document too large to build (`docTooLarge`: past 600 derived minutes or 600 steps) is refused with a
 *   `DocTooLargeError` before any step is made. One past what a watch takes plays in full: only its trip to the watch
 *   is refused.
 * - Blocks: arrive → arrive, warmup and activation → prep, main and run → core, power, accessory and conditioning →
 *   accessory, care → care, cooldown → cooldown. A power part is the engine's jumps block, which plays as its accessory
 *   block (before the core lifts on a jumping day): never the core block, which the worker reads as a core lift. Slots
 *   are numbered in play order within a block ("core:0", …; `docSlotKeys`, which says which item each slot is).
 * - A move with `holdSec` (or `carryM`, a 1 m/s walk) plays timed windows of that many seconds: per side (`perSide`
 *   with no fixed side) a Left then a Right window. A move with neither plays self-paced sets. The seconds of a window
 *   with no hold and of a set are the engine's own (`Builder.windowSeconds`, `Builder.setSeconds`), reading the
 *   document's numbers in place of the record's: its reps (a range's low) or breaths, its tempo's sum as the seconds
 *   per rep, its sides; a free-text move is a 3-second-a-rep move. A window's lead-in is 3 s in a flow or circuit, else
 *   8 s. A window is logged (the last side's) when the move takes a load; a set always is.
 * - A step's target is null unless the item states a load, a number of reps or a progression note (then: reps, the
 *   load as typed — or its kilograms when no unit reads the text — the note, the record's range and dose type, and the
 *   hold, for a move held by time: a reps move's window is the format's, not its target); a ladder rung always has one.
 * - holds, flow (and any other format): each move's sets of windows, in order; rest items as rests.
 * - straight (and steady): each move's sets, a rest after every set but the last of the part (the item's `restSec`,
 *   else the record's, else 60; zero means none).
 * - superset: each move plays its sets x rounds; round by round, the moves in order, then the rest between rounds
 *   (`restBetweenRoundsSec`, else the longest of the moves' rests).
 * - circuit (and intervals): round by round, each station one window (or a run segment), the rest items between
 *   stations as written, and `restBetweenRoundsSec` between rounds.
 * - ladder: `rounds` rungs whose reps step evenly from the reps range's low to its high; round by round the moves in
 *   order, `restBetweenRoundsSec` between rungs.
 * - Any other part with `rounds` plays its sequence that many times, `restBetweenRoundsSec` between; a slot's sets are
 *   numbered across the rounds (round r's set s is r × sets + s of rounds × sets; a run segment, its round), as a
 *   superset's, circuit's and ladder's are — each set a slot plays has its own number (`Round`). An engine build never
 *   has such a part: its numbers are the build's own (the parity test).
 * - A free-text move or a run segment plays with no move id. A run segment of a duration is a timed window; one of a
 *   distance or an open one is a self-paced step of the derived seconds (`secondsOfRun`: the pace band's middle, else
 *   6:00/km; open, a nominal 10 minutes).
 */
import type { WorkoutDoc, WorkoutDose, WorkoutItem, WorkoutPart } from "@rg/domain";
import type { BlockId, ExerciseRecord, FormatId } from "@rg/exercise-library";
import { Builder, type Step, type Target } from "@rg/session-engine";
import { DEFAULT_SECS_PER_REP, DocTooLargeError, FORMAT_OF_PART, docTooLarge, makeLibraryIndex, secondsOfRun } from "../derive.js";
import { WHY_SEPARATOR } from "../convert/from-build.js";
import { weightOfLoad } from "../convert/shared.js";

const DEFAULT_REST_SECONDS = 60;

export const BLOCK_OF_PURPOSE: Record<WorkoutPart["purpose"], BlockId> = {
  arrive: "arrive", warmup: "prep", activation: "prep", main: "core", power: "accessory", run: "core",
  accessory: "accessory", conditioning: "accessory", care: "care", cooldown: "cooldown",
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

const isMove = (s: Slot): s is Slot & { item: Move } => s.item.kind !== "run";

/** An item's slot: the key its steps carry, and where the item is (`parts[part].items[item]`). */
export interface DocSlotKey {
  key: string;
  part: number;
  item: number;
}

/**
 * Every item's slot but a rest's, in document order: its part's block and its place in play order within that block
 * ("core:0", "core:1", …). The one numbering — the steps' slot keys are these.
 */
export function docSlotKeys(doc: WorkoutDoc): DocSlotKey[] {
  const next: Partial<Record<BlockId, number>> = {};
  const out: DocSlotKey[] = [];
  doc.parts.forEach((part, p) => {
    const block = BLOCK_OF_PURPOSE[part.purpose];
    part.items.forEach((item, i) => {
      if (item.kind === "rest") return;
      const n = next[block] ?? 0;
      next[block] = n + 1;
      out.push({ key: `${block}:${n}`, part: p, item: i });
    });
  });
  return out;
}

export function playerStepsFromDoc(doc: WorkoutDoc, library: readonly ExerciseRecord[]): Step[] {
  const tooLarge = docTooLarge(doc, library);
  if (tooLarge) throw new DocTooLargeError(tooLarge);
  const find = makeLibraryIndex(library);
  const keys = new Map(docSlotKeys(doc).map((s) => [`${s.part}:${s.item}`, s.key]));
  const out: Step[] = [];
  doc.parts.forEach((part, p) => {
    const ctx: Ctx = { block: BLOCK_OF_PURPOSE[part.purpose], fid: FORMAT_OF_PART[part.format] };
    let letter = 0;
    const slots = part.items.map((item, i): Slot | null => {
      if (item.kind === "rest") return null;
      const rec = item.kind === "exercise" ? find(item.libraryId) : undefined;
      return {
        key: keys.get(`${p}:${i}`)!,
        item,
        rec,
        exerciseId: item.kind === "exercise" ? (rec?.id ?? item.libraryId) : null,
        why: item.why ? item.why.split(WHY_SEPARATOR) : [],
        group: part.format === "superset" && item.kind !== "run" ? String.fromCharCode(65 + letter++) : null,
      };
    });
    out.push(...partSteps(part, slots, ctx));
  });
  return out;
}

function partSteps(part: WorkoutPart, slots: Array<Slot | null>, ctx: Ctx): Step[] {
  const onlyMoves = part.items.every((i) => i.kind === "exercise" || i.kind === "free_exercise");
  if (part.format === "superset" && onlyMoves) return superset(part, slots as Slot[], ctx);
  if (part.format === "ladder" && onlyMoves) return ladder(part, slots as Slot[], ctx);
  if (part.format === "circuit" || part.format === "intervals") return circuit(part, slots, ctx);
  const once = (round: Round) => (part.format === "straight" || part.format === "steady" ? straight(part, slots, ctx, round) : sequence(part, slots, ctx, round));
  const rounds = part.rounds ?? 1;
  if (rounds <= 1) return once(null);
  const steps: Step[] = [];
  for (let r = 0; r < rounds; r++) {
    steps.push(...once({ at: r, of: rounds }));
    const last = lastKey(slots);
    if (r < rounds - 1 && (part.restBetweenRoundsSec ?? 0) > 0 && last) steps.push(rest(last, part.restBetweenRoundsSec!, ctx));
  }
  return steps;
}

const lastKey = (slots: Array<Slot | null>): string | null => [...slots].reverse().find((s) => s)?.key ?? null;
const firstKey = (slots: Array<Slot | null>): string | null => slots.find((s) => s)?.key ?? null;

/**
 * A part played in rounds (holds, flow, straight and any other format with `rounds`): which round this pass is, of how
 * many. A slot's sets are numbered across the rounds — round r's set s is r × sets + s of rounds × sets — so each set a
 * slot plays has its own number (the recorder logs a set by it, and ⇄ splices a slot by it); a left and a right window
 * share theirs. Null when the part is played once.
 */
type Round = { at: number; of: number } | null;

/** A slot's set `s` of `sets` in this pass: its number across the rounds (see `Round`). */
const numbered = (round: Round, s: number, sets: number) =>
  round === null ? { setIndex: s, setCount: sets } : { setIndex: round.at * sets + s, setCount: round.of * sets };
/** A run segment's number: its round. */
const runNumber = (round: Round): Partial<Step> => (round === null ? {} : { setIndex: round.at, setCount: round.of });
const roundOf = (round: Round): number | null => (round === null ? null : round.at + 1);

/** Holds, flow, and any format without its own rule: each item in order. */
function sequence(part: WorkoutPart, slots: Array<Slot | null>, ctx: Ctx, round: Round): Step[] {
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
      steps.push(runStep(slot, ctx, roundOf(round), runNumber(round)));
      return;
    }
    const sets = slot.item.dose.sets ?? 1;
    for (let s = 0; s < sets; s++) steps.push(...windows(slot, ctx, numbered(round, s, sets), roundOf(round)));
  });
  return steps;
}

function straight(part: WorkoutPart, slots: Array<Slot | null>, ctx: Ctx, round: Round): Step[] {
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
      steps.push(runStep(slot, ctx, roundOf(round), runNumber(round)));
      return;
    }
    const sets = slot.item.dose.sets ?? 1;
    for (let s = 0; s < sets; s++) {
      steps.push(...oneSet(slot, ctx, numbered(round, s, sets), roundOf(round)));
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
  const heldByTime = !slot.rec || slot.rec.dose.type === "time" || slot.rec.dose.type === "carry";
  return {
    ...(slot.rec ? { lo: slot.rec.dose.range[0], hi: slot.rec.dose.range[1], type: slot.rec.dose.type } : {}),
    reps,
    secs: heldByTime ? (d.holdSec ?? null) : null,
    w: weightOfLoad(d.load),
    note: progression ?? "",
  };
}

const repsOf = (d: WorkoutDose): number | undefined => (typeof d.reps === "number" ? d.reps : d.reps?.min);

/**
 * A free-text move as the engine's arithmetic sees one: bilateral, by reps, 3 s a rep. The engine reads only a
 * record's `dose` and `laterality`.
 */
const standIn = (reps: number): ExerciseRecord =>
  ({ laterality: "bilateral", dose: { type: "reps", range: [reps, reps], secsPerRep: DEFAULT_SECS_PER_REP } }) as unknown as ExerciseRecord;

/** A timed window's seconds: the hold, a carry at 1 m/s, else the engine's own window with the document's reps or breaths. */
function windowSeconds(slot: Slot & { item: Move }): number {
  const d = slot.item.dose;
  if (d.holdSec !== undefined) return d.holdSec;
  if (d.carryM !== undefined) return d.carryM;
  const rec = slot.rec ?? standIn(repsOf(d) ?? d.breaths ?? 0);
  const type = rec.dose.type;
  const n = type === "time" || type === "carry" ? undefined : type === "breaths" ? d.breaths : repsOf(d);
  return Builder.windowSeconds(n === undefined ? rec : { ...rec, dose: { ...rec.dose, range: [n, n] } }, null);
}

/** A self-paced set's planning estimate: the engine's own, with the document's reps, tempo and sides. */
function setSeconds(slot: Slot & { item: Move }, target: Partial<Target> | null): number {
  const d = slot.item.dose;
  const rec = slot.rec ?? standIn(0);
  const low = repsOf(d) || d.breaths || rec.dose.range[0] || 0;
  const t = d.tempo;
  const tempo = t ? (t.eccentricSec ?? 0) + (t.pauseSec ?? 0) + (t.concentricSec ?? 0) : 0;
  return Builder.setSeconds({
    ...rec,
    laterality: d.perSide ? "unilateral" : "bilateral",
    dose: { ...rec.dose, range: [low, Math.max(low, rec.dose.range[1])], ...(tempo > 0 ? { secsPerRep: tempo } : {}) },
  }, target);
}

/** The rest after a set: the item's, else the record's, else 60 (zero stated means none). */
function restSeconds(slot: Slot & { item: Move }): number {
  return slot.item.dose.restSec ?? (slot.rec?.dose.restSec || DEFAULT_REST_SECONDS);
}

function runStep(slot: Slot, ctx: Ctx, round: number | null, extra: Partial<Step> = {}): Step {
  const run = slot.item as Run;
  const timed = run.target.durationSec !== undefined;
  const seconds = secondsOfRun(run);
  return {
    ...base(slot, ctx, extra),
    kind: timed ? "timed" : "set",
    seconds,
    why: run.why ? [run.why] : [],
    ...(round !== null ? { format: { id: ctx.fid, group: null, round } } : {}),
  };
}
