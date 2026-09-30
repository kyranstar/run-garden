import { sameWeight, toKg, type Weight, type WeightUnit } from "@rg/domain";
import {
  attrsOf, modeSkeleton, positionGroup,
  type BlockId, type CheckReading, type EngineData, type ExerciseRecord, type Format, type FormatId, type Mode, type ModeSkeleton, type Theme,
} from "@rg/exercise-library";
import { Blocks } from "./blocks.js";
import { Coverage } from "./coverage.js";
import { Hist } from "./hist.js";
import { Lib } from "./lib.js";
import { Prog } from "./prog.js";
import { Rng } from "./rng.js";
import { Select, type Scored, type SelectCtx } from "./select.js";
import type { Alternative, Block, BuildInput, BuildResult, Group, Item, Plan, Prefs, Step, Swaps, Target } from "./types.js";

// Builds a session: skeleton blocks → exercises → formats → a flat step list the timer plays.
// The skeleton (including a cared-for profile's care block) comes from EngineData; every condition rule
// comes from the active profiles, and today's checks decide what the day allows.
// swaps: { "<block>:<index>": { from: exId, to: exId } }

const PREP_SECONDS = 8;
const CHIME_SECONDS = 3;
const LOG_SECONDS = 10;
const MAX_ITEMS_PER_BLOCK = 12;
const NEW_MOVE = "New move this week";
const SWAPPED = "Swapped in";

interface Ctx extends SelectCtx {
  data: EngineData;
  mode: Mode;
  theme: Theme | null;
  checks: Readonly<Record<string, CheckReading>>;
  sessions: BuildInput["sessions"];
  block: Block | null;
  swaps: Swaps;
  seed: string;
  prefs: Prefs;
  equipment: readonly string[];
  unit: WeightUnit;
  kbWeights: Weight[];
  jitter: (id: string) => number;
  used: Set<string>;
  banned: Set<string>;
  reserved: Set<string>;
  /** Whether this week still wants a new move (fixed for the whole build). */
  newMoveWeek: boolean;
  /** Closes once a new move is picked. */
  newMoveOpen: boolean;
  coreRegions: string[] | null;
  skeleton: ModeSkeleton;
}

function fmt(data: EngineData, id: FormatId): Format {
  const f = data.formats.find(x => x.id === id);
  if (!f) throw new Error(`Unknown format "${id}"`);
  return f;
}
const round5 = (n: number): number => Math.max(5, Math.round(n / 5) * 5);
const mid = (range: readonly [number, number]): number => (range[0] + range[1]) / 2;
const setsRange = (ex: ExerciseRecord): readonly [number, number] => ex.dose.sets || [2, 3];

/** One timed window. Fixed by the dose — never stretched to fill time. */
function windowSeconds(ex: ExerciseRecord, target: Partial<Target> | null): number {
  const d = ex.dose;
  if (d.type === "time") return target && target.secs ? target.secs : round5(mid(d.range));
  if (d.type === "carry") return target && target.secs ? target.secs : d.range[1];
  if (d.type === "breaths") return round5(mid(d.range) * 6);
  const reps = Math.round(mid(d.range)) * (ex.laterality === "alternating" ? 2 : 1);
  return Math.max(30, round5(reps * (d.secsPerRep || 4)));
}

/** Planning estimate for one self-paced set. */
function setSeconds(ex: ExerciseRecord, target: Partial<Target> | null): number {
  const reps = (target && target.reps) || ex.dose.range[0];
  const sides = ex.laterality === "bilateral" ? 1 : 2;
  return reps * (ex.dose.secsPerRep || 3) * sides + LOG_SECONDS;
}

const costOf = (steps: readonly Step[]): number => steps.reduce((sum, s) => sum + s.seconds + (s.prepGap || 0), 0);

function base(item: Item, formatId: FormatId, extra: Partial<Step> = {}): Step {
  return {
    kind: "timed", seconds: 0,
    slotKey: item.slotKey, block: item.block, exerciseId: item.exercise.id, side: null,
    setIndex: 0, setCount: item.sets || 1, target: item.target || null,
    format: { id: formatId, group: item.group || null, round: null },
    why: item.why || [], isNew: Boolean(item.isNew), log: false, prepGap: 0,
    ...extra,
  };
}

function rest(item: Item, seconds: number, formatId: FormatId): Step {
  return {
    kind: "rest", slotKey: item.slotKey, block: item.block, exerciseId: null, side: null, setIndex: null, setCount: null,
    seconds, prepGap: 0, target: null, format: { id: formatId, group: null, round: null }, why: [], isNew: false, log: false,
  };
}

function windows(item: Item, formatId: FormatId, extra: Partial<Step> = {}): Step[] {
  const ex = item.exercise;
  const secs = windowSeconds(ex, item.target);
  const gap = formatId === "flow" || formatId === "circuit" ? CHIME_SECONDS : PREP_SECONDS;
  const logged = ex.load !== "none";
  if (ex.laterality === "unilateral") {
    return [
      { ...base(item, formatId, extra), kind: "timed", side: "Left", seconds: secs, prepGap: gap },
      { ...base(item, formatId, extra), kind: "timed", side: "Right", seconds: secs, prepGap: gap, log: logged },
    ];
  }
  return [{ ...base(item, formatId, extra), kind: "timed", seconds: secs, prepGap: gap, log: logged }];
}

/** One set: self-paced for reps; timed windows for holds and carries. */
function oneSet(item: Item, setIndex: number, formatId: FormatId, extra: Partial<Step> = {}): Step[] {
  const ex = item.exercise;
  if (ex.dose.type === "time" || ex.dose.type === "carry") return windows(item, formatId, { setIndex, ...extra });
  const target = extra.target || item.target;
  return [{ ...base(item, formatId, { setIndex, ...extra }), kind: "set", seconds: setSeconds(ex, target), log: true }];
}

function groupSteps(data: EngineData, group: Group): Step[] {
  const f = group.format;
  const items = group.items;
  const steps: Step[] = [];
  if (f === "holds" || f === "flow") {
    for (const it of items) steps.push(...windows(it, f));
  } else if (f === "straight") {
    items.forEach((it, i) => {
      for (let s = 0; s < it.sets; s++) {
        steps.push(...oneSet(it, s, f));
        if (!(i === items.length - 1 && s === it.sets - 1)) steps.push(rest(it, it.exercise.dose.restSec || 60, f));
      }
    });
  } else if (f === "superset") {
    const [a, b] = items as [Item, Item];
    const n = Math.max(a.sets, b.sets);
    const restSec = Math.max(a.exercise.dose.restSec || 60, b.exercise.dose.restSec || 60);
    for (let s = 0; s < n; s++) {
      if (s < a.sets) steps.push(...oneSet(a, s, f));
      if (s < b.sets) steps.push(...oneSet(b, s, f));
      if (s < n - 1) steps.push(rest(a, restSec, f));
    }
  } else if (f === "circuit") {
    const def = fmt(data, "circuit");
    const rounds = group.rounds || def.rounds![0];
    for (let r = 0; r < rounds; r++) {
      items.forEach((it, i) => {
        steps.push({ ...base(it, f, { setIndex: r, setCount: rounds }), kind: "timed", seconds: def.workSec!, prepGap: CHIME_SECONDS, format: { id: f, group: null, round: r + 1 } });
        if (i < items.length - 1) steps.push(rest(it, def.restSec!, f));
      });
      if (r < rounds - 1) steps.push(rest(items[items.length - 1]!, def.roundRestSec!, f));
    }
  } else if (f === "ladder") {
    const def = fmt(data, "ladder");
    const rungs = def.rungs!;
    rungs.forEach((reps, r) => {
      for (const it of items) steps.push(...oneSet(it, r, f, { setCount: rungs.length, target: { ...(it.target || {}), reps } }));
      if (r < rungs.length - 1) steps.push(rest(items[0]!, def.restSec!, f));
    });
  } else {
    throw new Error(`Unknown format "${String(f)}"`);
  }
  return steps;
}

/** A format takes the exercise: role, every active profile's cap for this format, load, dose, sides. */
function accepts(data: EngineData, formatId: FormatId, ex: ExerciseRecord): boolean {
  const f = fmt(data, formatId);
  return ex.roles.some(r => f.roles.includes(r)) &&
    data.profiles.active.every(p => {
      const a = attrsOf(ex, p);
      return a != null && p.fitsFormat(a, formatId);
    }) &&
    f.loads.includes(ex.load) && f.doseTypes.includes(ex.dose.type) && (!f.laterality || f.laterality.includes(ex.laterality));
}

function fitsBlock(ctx: Ctx, ex: ExerciseRecord, block: BlockId): boolean {
  const spec = ctx.skeleton.blocks[block];
  const roles = spec?.roles ?? [];
  const pats = spec?.patterns ?? null;
  return ex.roles.some(r => roles.includes(r)) && (!pats || ex.patterns.some(p => pats.includes(p)));
}

// Two exercises are the same move in different clothes (e.g. with or without the block) when they
// share a family and the same body areas; a session gets at most one of them.
const moveKey = (ex: ExerciseRecord): string => `${ex.family}|${[...ex.regions].sort().join(",")}`;
function movesInPlan(ctx: Ctx): Set<string> {
  const keys = new Set<string>();
  for (const id of ctx.used) {
    if (ctx.banned.has(id)) continue;
    const ex = Lib.get(ctx.data, id);
    if (ex) keys.add(moveKey(ex));
  }
  return keys;
}

// allowReserved: include exercises reserved for a user's swap (only the swap's own slot may take them).
// The day's checks apply (Lib.eligible with checks): e.g. overhead pressing needs an answered, calm check.
function candidates(block: BlockId, formatId: FormatId, ctx: Ctx, allowReserved = false): ExerciseRecord[] {
  const taken = movesInPlan(ctx);
  return Lib.all(ctx.data).filter(ex =>
    !taken.has(moveKey(ex)) &&
    fitsBlock(ctx, ex, block) &&
    Lib.eligible(ctx.data, ex, { equipment: ctx.equipment, mode: ctx.mode, excluded: ctx.prefs.excluded, checks: ctx.checks }) &&
    !ctx.used.has(ex.id) &&
    (allowReserved || !ctx.reserved.has(ex.id)) &&
    accepts(ctx.data, formatId, ex));
}

const pairable = (a: ExerciseRecord, b: ExerciseRecord): boolean =>
  a.dose.type === "reps" && b.dose.type === "reps" &&
  !a.patterns.some(p => b.patterns.includes(p)) &&
  positionGroup(a.position) === positionGroup(b.position);

function targetFor(ex: ExerciseRecord, ctx: Ctx): Target | null {
  if (ex.load === "none") return null;
  return Prog.suggest(ctx.data, ex, Prog.historyFor(ctx.data, ctx.sessions, ex.id), {
    mode: ctx.mode, checks: ctx.checks, implement: Lib.implementFor(ex, ctx.equipment),
    kbWeights: ctx.kbWeights, unit: ctx.unit, equipment: ctx.equipment,
  });
}

function makeItem(scored: Pick<Scored, "ex" | "reasons" | "isNew">, block: BlockId, slotKey: string, formatId: FormatId, ctx: Ctx): Item {
  return {
    slotKey, block, exercise: scored.ex, format: formatId, sets: 1, group: null, coreFamily: null,
    target: targetFor(scored.ex, ctx), why: scored.reasons, isNew: Boolean(scored.isNew),
  };
}

/** The user's swap for this slot, if it's a valid choice here. */
function swapFor(slotKey: string, pool: readonly ExerciseRecord[], ctx: Ctx): Scored | null {
  const swap = ctx.swaps[slotKey];
  const ex = swap && swap.to ? Lib.get(ctx.data, swap.to) : null;
  return ex && pool.some(c => c.id === ex.id) ? { ex, total: 0, reasons: [SWAPPED], isNew: false } : null;
}

function timedFormat(block: BlockId, ctx: Ctx): FormatId {
  const modeFormats = ctx.data.modes[ctx.mode].formats;
  const allowed = (ctx.skeleton.blocks[block]?.formats ?? []).filter(f => modeFormats.includes(f));
  const themed = ctx.theme ? ctx.theme.formats.find(f => allowed.includes(f)) : undefined;
  return themed || (allowed.includes("holds") ? "holds" : allowed[0]!);
}

/** Adds items to a timed block (or to an existing group) while they fit. */
function fillTimed(block: BlockId, budget: number, ctx: Ctx, group: Group | null = null, addAtMost = Infinity): { groups: Group[]; spent: number } {
  const formatId = group ? group.format : timedFormat(block, ctx);
  const items = group ? group.items : [];
  const min = ctx.skeleton.min[block] || 0;
  const max = Math.min(MAX_ITEMS_PER_BLOCK, ctx.skeleton.max[block] || MAX_ITEMS_PER_BLOCK);
  const startCount = items.length;
  let spent = 0;
  while (items.length < max && items.length - startCount < addAtMost) {
    const pool = candidates(block, formatId, ctx);
    if (!pool.length) break;
    const slotKey = `${block}:${items.length}`;
    const prevPosition = items.length ? items[items.length - 1]!.exercise.position : null;
    const swap = swapFor(slotKey, candidates(block, formatId, ctx, true), ctx);
    const ranked = swap ? [swap] : Select.rank(ctx.data, pool, { ...ctx, prevPosition, coreRegions: block === "prep" ? ctx.coreRegions : null });
    let picked: { item: Item; cost: number } | null = null;
    for (const r of ranked) {
      const item = makeItem(r, block, slotKey, formatId, ctx);
      const cost = costOf(windows(item, formatId));
      if (spent + cost <= budget || items.length < min || r === swap) { picked = { item, cost }; break; }
    }
    if (!picked) break;
    items.push(picked.item);
    ctx.used.add(picked.item.exercise.id);
    if (picked.item.isNew) ctx.newMoveOpen = false;
    spent += picked.cost;
  }
  return { groups: !group && items.length ? [{ block, format: formatId, items }] : [], spent };
}

function coreGroups(items: Item[], ctx: Ctx): Group[] {
  const wantSuperset = ctx.data.modes[ctx.mode].formats.includes("superset") && Boolean(ctx.theme && ctx.theme.formats.includes("superset"));
  const remaining = [...items];
  const groups: Group[] = [];
  if (wantSuperset) {
    let pair: [number, number] | null = null;
    for (let i = 0; i < remaining.length && !pair; i++) {
      for (let j = i + 1; j < remaining.length && !pair; j++) {
        if (pairable(remaining[i]!.exercise, remaining[j]!.exercise)) pair = [i, j];
      }
    }
    if (pair) {
      const a = remaining[pair[0]]!, b = remaining[pair[1]]!;
      remaining.splice(pair[1], 1);
      remaining.splice(pair[0], 1);
      a.format = b.format = "superset";
      a.group = "A";
      b.group = "B";
      groups.push({ block: "core", format: "superset", items: [a, b] });
    }
  }
  for (const it of remaining) groups.push({ block: "core", format: "straight", items: [it] });
  return groups;
}

/** A core lift: what the family, the day's checks and the plan so far allow. */
const corePool = (family: string, ctx: Ctx): ExerciseRecord[] =>
  Blocks.familyCandidates(ctx.data, family, { equipment: ctx.equipment, excluded: ctx.prefs.excluded })
    .filter(ex => Lib.fitsMode(ctx.data, ex, ctx.mode, ctx.checks) && !ctx.used.has(ex.id));

function coreItem(ctx: Ctx, pick: { family: string; ex: ExerciseRecord; slotKey: string; swapped: boolean }, sets: number, week: number): Item {
  const target = targetFor(pick.ex, ctx);
  return {
    slotKey: pick.slotKey, block: "core", exercise: pick.ex, format: "straight", sets,
    group: null, coreFamily: pick.family, target, isNew: false,
    why: [pick.swapped ? SWAPPED : `Core lift · block ${ctx.block!.number} · week ${week} of ${ctx.block!.weeks}`, target && target.note].filter((x): x is string => Boolean(x)),
  };
}

function fillCore(budget: number, ctx: Ctx): { groups: Group[]; spent: number } {
  const hi = ctx.data.modes[ctx.mode].coreCount[1];
  if (!hi || !ctx.block) return { groups: [], spent: 0 };
  const families = Blocks.familiesForSession(ctx.data, ctx.block, { mode: ctx.mode, sessions: ctx.sessions, today: ctx.today, theme: ctx.theme, rng: ctx.rng });
  const week = Blocks.weekOf(ctx.block, ctx.today);
  const picks: Array<{ family: string; ex: ExerciseRecord; slotKey: string; swapped: boolean }> = [];
  for (const family of families) {
    const slotKey = `core:${picks.length}`;
    const all = corePool(family, ctx);
    const pool = all.filter(ex => !ctx.reserved.has(ex.id));
    const swap = swapFor(slotKey, all, ctx);
    let ex = swap ? swap.ex : Blocks.resolveCore(ctx.data, ctx.block, family, ctx.equipment, ctx.mode);
    if (ex && !swap && !pool.some(c => c.id === ex!.id)) ex = pool[0] ?? null;
    if (!ex) continue;
    ctx.used.add(ex.id);
    picks.push({ family, ex, slotKey, swapped: Boolean(swap) });
  }

  const setsFor = (ex: ExerciseRecord, minimal: boolean) => (minimal || ctx.mode !== "build" ? setsRange(ex)[0] : Math.round(mid(setsRange(ex))));
  // The most lifts that fit, then fewer sets, then fewer lifts.
  for (let n = picks.length; n >= 1; n--) {
    for (const minimal of [false, true]) {
      const groups = coreGroups(picks.slice(0, n).map(p => coreItem(ctx, p, setsFor(p.ex, minimal), week)), ctx);
      const spent = groups.reduce((sum, g) => sum + costOf(groupSteps(ctx.data, g)), 0);
      if (spent <= budget || (n === 1 && minimal)) {
        picks.slice(n).forEach(p => ctx.used.delete(p.ex.id));
        const fresh = ctx.newMoveOpen && groups.flatMap(g => g.items).find(it => neverDone(it.exercise, ctx) && !it.why.includes(SWAPPED));
        if (fresh) markNew(fresh, ctx);
        return { groups, spent };
      }
    }
  }
  return { groups: [], spent: 0 };
}

/** Kettlebells at this place, light to heavy, without duplicates. */
function bellsAt(input: BuildInput): Weight[] {
  const out: Weight[] = [];
  for (const w of [...(input.location.implements?.kettlebell ?? [])].sort((a, b) => toKg(a) - toKg(b))) {
    if (w && w.v > 0 && !out.some(o => sameWeight(o, w))) out.push(w);
  }
  return out;
}

function makeContext(data: EngineData, input: BuildInput): Ctx {
  const unit = input.unit || "lb";
  const sessions = input.sessions || [];
  const swaps = input.swaps || {};
  const seed = [input.today, input.mode, input.theme ? input.theme.id : "", input.minutes, input.location.id].join("|");
  const debt = Coverage.debt(data, sessions, input.today);
  const swapped = Object.values(swaps);
  const newMoveWeek = !Hist.newMoveThisWeek(data, sessions, input.today);
  return {
    data, today: input.today, mode: input.mode, theme: input.theme || null, checks: input.checks || {},
    sessions, block: input.block || null, swaps, seed,
    prefs: { ratings: {}, excluded: [], pinned: [], ...(input.prefs || {}) },
    equipment: input.location.equipment || [],
    unit,
    kbWeights: bellsAt(input),
    rng: Rng.create(seed),
    jitter: (id: string) => Rng.create(`${seed}|${id}`)(),
    debt,
    maxDebt: Math.max(1, ...Object.values(debt.patterns), ...Object.values(debt.regions)),
    coverageLast: Coverage.exposures(data, sessions, input.today).last,
    stats: Select.stats(data, sessions, input.today),
    saved: new Set(input.savedIds || []),
    used: new Set(swapped.map(s => s && s.from).filter((x): x is string => Boolean(x))),
    banned: new Set(swapped.map(s => s && s.from).filter((x): x is string => Boolean(x))),
    reserved: new Set(swapped.map(s => s && s.to).filter((x): x is string => Boolean(x))),
    newMoveWeek,
    newMoveOpen: newMoveWeek,
    coreRegions: null,
    skeleton: modeSkeleton(data.skeleton, input.mode),
  };
}

// Swaps are checked against the plan without them: a swap applies only if its slot still holds the
// exercise it replaced (no stale swaps), and the new move exists, isn't already in the plan, fits the
// slot's block, format, and mode, and is allowed today. Anything else is ignored entirely.
function validSwaps(data: EngineData, input: BuildInput): Swaps {
  const swaps = input.swaps || {};
  const keys = Object.keys(swaps);
  if (!keys.length) return {};
  const basePlan = buildPlan(data, { ...input, swaps: {} });
  const ctx = makeContext(data, { ...input, swaps: {} });
  const inPlan = new Set(basePlan.items.map(it => it.exercise.id));
  const out: Record<string, { from: string; to: string }> = {};
  for (const key of keys) {
    const s = swaps[key] || {};
    const at = basePlan.items.find(it => it.slotKey === key);
    const to = s.to ? Lib.get(data, s.to) : null;
    if (!at || !to || inPlan.has(to.id)) continue;
    if (s.from && Hist.canonical(data, s.from) !== at.exercise.id) continue;
    if (!Lib.eligible(data, to, { equipment: ctx.equipment, mode: input.mode, excluded: ctx.prefs.excluded, checks: ctx.checks })) continue;
    if (at.block === "core" ? Lib.coreFamilyOf(data, to) !== at.coreFamily : !(fitsBlock(ctx, to, at.block) && accepts(data, at.format, to))) continue;
    if (at.format === "superset") {
      const partner = basePlan.items.find(it => it.block === at.block && it.format === "superset" && it !== at);
      if (partner && !pairable(partner.exercise, to)) continue;
    }
    out[key] = { from: at.exercise.id, to: to.id };
  }
  return out;
}

function build(data: EngineData, input: BuildInput): BuildResult {
  const plan = buildPlan(data, { ...input, swaps: validSwaps(data, input) });
  return { ...plan, alternatives: alternativesFor(data, input, plan, 3) };
}

function buildPlan(data: EngineData, input: BuildInput): Plan {
  const ctx = makeContext(data, input);
  const budget = input.minutes * 60;
  const shares = ctx.skeleton.shares;
  const mins = ctx.skeleton.min;
  const groups = emptyGroups();
  let carry = 0;
  let spent = 0;
  for (const block of ctx.skeleton.fillOrder) {
    const share = (shares[block] || 0) * budget;
    if (!share && !mins[block]) continue;
    // Unused time flows forward, but only core, accessory, and prep may use it; care, arrival,
    // and cool-down stay at their own share so leftovers become more prep (then cool-down via extend).
    const sink = block === "core" || block === "accessory" || block === "prep";
    const available = share + (sink ? carry : 0);
    const res = block === "core" ? fillCore(available, ctx)
      : block === "accessory" ? fillAccessory(available, ctx)
      : fillTimed(block, available, ctx);
    groups[block] = res.groups;
    if (block === "core") ctx.coreRegions = [...new Set(res.groups.flatMap(g => g.items.flatMap(it => it.exercise.regions)))];
    carry = sink ? Math.max(0, available - res.spent) : carry + Math.max(0, share - res.spent);
    spent += res.spent;
  }
  extend(groups, budget - spent, ctx);
  trim(groups, budget, ctx);
  ensureNewMove(groups, budget, ctx);
  const ordered = ctx.skeleton.order.flatMap(b => groups[b]).filter(g => g.items.length);
  const steps = ordered.flatMap(g => groupSteps(data, g));
  const items = ordered.flatMap(g => g.items);
  const newItem = items.find(it => it.isNew);
  return { mode: ctx.mode, theme: ctx.theme, minutes: input.minutes, seed: ctx.seed, groups: ordered, items, steps, plannedSeconds: costOf(steps), newMove: newItem ? newItem.exercise.id : null };
}

const emptyGroups = (): Record<BlockId, Group[]> => ({ arrive: [], prep: [], core: [], accessory: [], care: [], cooldown: [] });

function fillAccessory(budget: number, ctx: Ctx): { groups: Group[]; spent: number } {
  const modeFormats = ctx.data.modes[ctx.mode].formats;
  const allowed = (ctx.skeleton.blocks.accessory?.formats ?? []).filter(f => modeFormats.includes(f));
  if (!allowed.length || budget < 60) return { groups: [], spent: 0 };
  const themed = ctx.theme ? ctx.theme.formats.filter(f => allowed.includes(f)) : [];
  const pool = themed.length ? themed : allowed;
  const first = pool[Math.floor(ctx.rng() * pool.length)]!;
  for (const formatId of [first, ...allowed.filter(f => f !== first)]) {
    const group = tryFormat(formatId, budget, ctx);
    if (!group) continue;
    for (const it of group.items) {
      ctx.used.add(it.exercise.id);
      if (it.isNew) ctx.newMoveOpen = false;
    }
    return { groups: [group], spent: costOf(groupSteps(ctx.data, group)) };
  }
  return { groups: [], spent: 0 };
}

/** Picks exercises for one accessory format and shrinks it until it fits, or gives up. */
function tryFormat(formatId: FormatId, budget: number, ctx: Ctx): Group | null {
  const f = fmt(ctx.data, formatId);
  const [minN, maxN] = f.count;
  const items: Item[] = [];
  for (let i = 0; i < maxN; i++) {
    const pool = candidates("accessory", formatId, ctx)
      .filter(ex => !items.some(it => it.exercise.id === ex.id))
      .filter(ex => formatId !== "superset" || !items.length || pairable(items[0]!.exercise, ex));
    if (!pool.length) break;
    const slotKey = `accessory:${i}`;
    const prevPosition = items.length ? items[items.length - 1]!.exercise.position : null;
    const newOpen = ctx.newMoveOpen && !items.some(it => it.isNew);
    const swapPool = candidates("accessory", formatId, ctx, true)
      .filter(ex => !items.some(it => it.exercise.id === ex.id))
      .filter(ex => formatId !== "superset" || !items.length || pairable(items[0]!.exercise, ex));
    const choice = swapFor(slotKey, swapPool, ctx) || Select.rank(ctx.data, pool, { ...ctx, prevPosition, newMoveOpen: newOpen, coreRegions: null })[0]!;
    items.push(makeItem(choice, "accessory", slotKey, formatId, ctx));
  }
  if (items.length < minN) return null;
  items.forEach((it, i) => {
    it.sets = formatId === "ladder" ? f.rungs!.length
      : formatId === "circuit" ? 1
      : ctx.mode === "build" ? Math.round(mid(setsRange(it.exercise))) : setsRange(it.exercise)[0];
    if (formatId === "superset") it.group = i === 0 ? "A" : "B";
  });
  const group: Group = { block: "accessory", format: formatId, items };
  if (f.rounds) group.rounds = f.rounds[1];
  for (let guard = 0; guard < 30 && costOf(groupSteps(ctx.data, group)) > budget; guard++) {
    if (group.rounds && f.rounds && group.rounds > f.rounds[0]) { group.rounds -= 1; continue; }
    const most = [...items].sort((a, b) => b.sets - a.sets)[0]!;
    if ((formatId === "straight" || formatId === "superset") && most.sets > 1) { most.sets -= 1; continue; }
    if (items.length > minN) { items.pop(); continue; }
    return null;
  }
  return costOf(groupSteps(ctx.data, group)) <= budget ? group : null;
}

// Spare time goes to lifting volume first (core, then accessory sets: up to the middle of the range in
// consistent, the top in build), then to one more prep or cool-down move at a time, within each block's cap.
function extend(groups: Record<BlockId, Group[]>, leftover: number, ctx: Ctx): void {
  let left = leftover;
  const setCap = (ex: ExerciseRecord) => (ctx.mode === "build" ? setsRange(ex)[1] : Math.round(mid(setsRange(ex))));
  const grow = (list: Group[]) => {
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of list) {
        if (g.format !== "straight" && g.format !== "superset") continue;
        for (const it of g.items) {
          if (it.sets >= setCap(it.exercise)) continue;
          const before = costOf(groupSteps(ctx.data, g));
          it.sets += 1;
          const delta = costOf(groupSteps(ctx.data, g)) - before;
          if (delta <= left) { left -= delta; grew = true; } else it.sets -= 1;
        }
      }
    }
  };
  if (ctx.mode !== "recovery") {
    grow(groups.core);
    grow(groups.accessory);
  }
  let added = true;
  while (added && left >= 30) {
    added = false;
    for (const block of ["prep", "cooldown"] as const) {
      const existing = groups[block][0] || null;
      const res = fillTimed(block, left, ctx, existing, 1);
      if (!existing && res.groups.length) groups[block] = res.groups;
      if (res.spent > 0) { left -= res.spent; added = true; }
    }
  }
}

const total = (groups: Record<BlockId, Group[]>, ctx: Ctx): number =>
  ctx.skeleton.order.reduce((sum, b) => sum + groups[b].reduce((s, g) => s + costOf(groupSteps(ctx.data, g)), 0), 0);

/** One small step down in accessory work: fewer rounds, then fewer sets, then fewer moves. */
function shrinkAccessory(groups: Record<BlockId, Group[]>, ctx: Ctx): boolean {
  const g = groups.accessory[0];
  if (!g) return false;
  const f = fmt(ctx.data, g.format);
  if (g.rounds && f.rounds && g.rounds > f.rounds[0]) { g.rounds -= 1; return true; }
  if (g.format === "straight" || g.format === "superset") {
    const most = [...g.items].sort((a, b) => b.sets - a.sets)[0]!;
    if (most.sets > 1) { most.sets -= 1; return true; }
  }
  if (g.items.length > f.count[0]) { g.items.pop(); return true; }
  return false;
}

// Safety net: never go over budget. Shrinks in small steps (extra prep, accessory volume, extra core
// sets, extra cool-down) before dropping whole groups.
function trim(groups: Record<BlockId, Group[]>, budget: number, ctx: Ctx): void {
  const min = ctx.skeleton.min;
  const coreItems = () => groups.core.flatMap(g => g.items).sort((a, b) => b.sets - a.sets);
  for (let guard = 0; guard < 200 && total(groups, ctx) > budget; guard++) {
    const prep = groups.prep[0];
    if (prep && prep.items.length > Math.max(1, min.prep || 0)) { prep.items.pop(); continue; }
    if (shrinkAccessory(groups, ctx)) continue;
    const aboveMin = coreItems().find(it => it.sets > setsRange(it.exercise)[0]);
    if (aboveMin) { aboveMin.sets -= 1; continue; }
    const cool = groups.cooldown[0];
    if (cool && cool.items.length > (min.cooldown || 0)) { cool.items.pop(); continue; }
    if (groups.accessory.length) { groups.accessory = []; continue; }
    const heaviest = coreItems()[0];
    if (heaviest && heaviest.sets > 1) { heaviest.sets -= 1; continue; }
    if (groups.core.length > 1) { groups.core.pop(); continue; }
    break;
  }
}

const neverDone = (ex: ExerciseRecord, ctx: Ctx): boolean => {
  const st = ctx.stats.get(ex.id);
  return !st || !st.lastDate;
};

function markNew(item: Item, ctx: Ctx): void {
  item.isNew = true;
  const others = item.why.filter(w => w !== NEW_MOVE);
  // Core lifts keep their block label first.
  item.why = (item.block === "core" ? [others[0], NEW_MOVE] : [NEW_MOVE, ...others]).filter((x): x is string => Boolean(x)).slice(0, 2);
  ctx.newMoveOpen = false;
}

// The weekly new move is promised while one fits: if ranking didn't pick one, swap the last non-core item of
// a compatible group for the best never-done candidate that keeps the plan in budget.
function ensureNewMove(groups: Record<BlockId, Group[]>, budget: number, ctx: Ctx): void {
  if (!ctx.newMoveWeek || ctx.skeleton.order.some(b => groups[b].some(g => g.items.some(it => it.isNew)))) return;
  const blocks = (["accessory", "prep", "cooldown", "care", "arrive"] as const).filter(b => ctx.skeleton.order.includes(b));
  for (const block of blocks) {
    for (const g of groups[block]) {
      // Longest items first: swapping out a long item leaves the most room for the new one.
      const alone: FormatId = g.format === "superset" ? "straight" : g.format;   // a superset needs two items to cost
      const order = g.items.map((it, i) => ({ i, secs: costOf(groupSteps(ctx.data, { ...g, format: alone, items: [it] })) })).sort((a, b) => b.secs - a.secs || b.i - a.i);
      for (const { i } of order) {
        const old = g.items[i]!;
        if (old.why.includes(SWAPPED)) continue;
        const partner = g.format === "superset" ? g.items[1 - i] ?? null : null;
        const pool = candidates(block, g.format, ctx)
          .filter(ex => neverDone(ex, ctx))
          .filter(ex => !partner || pairable(partner.exercise, ex));
        for (const r of Select.rank(ctx.data, pool, { ...ctx, newMoveOpen: true, coreRegions: block === "prep" ? ctx.coreRegions : null })) {
          const item = { ...makeItem(r, block, old.slotKey, g.format, ctx), sets: old.sets, group: old.group };
          g.items[i] = item;
          if (total(groups, ctx) <= budget) {
            ctx.used.delete(old.exercise.id);
            ctx.used.add(item.exercise.id);
            markNew(item, ctx);
            return;
          }
          g.items[i] = old;
        }
      }
    }
  }
}

/** The steps a slot would play with `ex` swapped in (same format, sets and group). */
function stepsIfSwapped(plan: Plan, item: Item, ex: ExerciseRecord, ctx: Ctx): Step[] {
  const group = plan.groups.find(g => g.items.includes(item));
  if (!group) return [];
  const swapped: Item = item.block === "core"
    ? coreItem(ctx, { family: item.coreFamily ?? "", ex, slotKey: item.slotKey, swapped: true }, item.sets, 0)
    : makeItem({ ex, reasons: [SWAPPED], isNew: false }, item.block, item.slotKey, item.format, ctx);
  const alt: Item = { ...swapped, format: item.format, sets: item.sets, group: item.group };
  return groupSteps(ctx.data, { ...group, items: group.items.map(it => (it === item ? alt : it)) })
    .filter(s => s.kind !== "rest" && s.slotKey === item.slotKey);
}

/** Ranked alternatives for one slot of a built plan. */
function slotAlternatives(plan: Plan, item: Item, ctx: Ctx, k: number): Alternative[] {
  // Other versions of the slot's own move are fair alternatives.
  const slotCtx: Ctx = { ...ctx, banned: new Set([...ctx.banned, item.exercise.id]) };
  const partner = item.format === "superset" ? plan.items.find(it => it.format === "superset" && it.block === item.block && it !== item) ?? null : null;
  const pool = (item.block === "core" ? corePool(item.coreFamily ?? "", slotCtx) : candidates(item.block, item.format, slotCtx))
    .filter(ex => !partner || pairable(partner.exercise, ex));
  return Select.rank(ctx.data, pool, slotCtx).slice(0, k)
    .map(r => ({ id: r.ex.id, name: r.ex.name, reasons: r.reasons, steps: stepsIfSwapped(plan, item, r.ex, slotCtx) }));
}

function alternativesFor(data: EngineData, input: BuildInput, plan: Plan, k: number): Record<string, Alternative[]> {
  const ctx = makeContext(data, { ...input, swaps: {} });
  plan.items.forEach(it => ctx.used.add(it.exercise.id));
  const out: Record<string, Alternative[]> = {};
  for (const item of plan.items) out[item.slotKey] = slotAlternatives(plan, item, ctx, k);
  return out;
}

/** Up to k alternatives for one slot (the build carries the top 3 for every slot). */
function alternatives(data: EngineData, input: BuildInput, slotKey: string, k = 3): Alternative[] {
  const plan = buildPlan(data, { ...input, swaps: validSwaps(data, input) });
  const item = plan.items.find(it => it.slotKey === slotKey);
  if (!item) return [];
  const ctx = makeContext(data, { ...input, swaps: {} });
  plan.items.forEach(it => ctx.used.add(it.exercise.id));
  return slotAlternatives(plan, item, ctx, k);
}

export const Builder = { build, alternatives, groupSteps, costOf, PREP_SECONDS, CHIME_SECONDS };
