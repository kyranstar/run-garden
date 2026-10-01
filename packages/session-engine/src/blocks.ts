import type { Weight, WeightUnit } from "@rg/domain";
import { attrsOf, type ConditionProfile, type EngineData, type ExerciseRecord, type HistorySession, type Mode, type Theme } from "@rg/exercise-library";
import { Hist, HistIndex } from "./hist.js";
import { Lib } from "./lib.js";
import { Prog } from "./prog.js";
import { Rng } from "./rng.js";
import type { Block, Prefs, Rotation } from "./types.js";

// Training blocks: one exercise per core family for N weeks, rotating at the end (or early on a stall or on
// a profile's rotation rule, e.g. repeated flags), with pins that never rotate.

export interface BlockCtx {
  today: string;
  /** Home's gear: blocks are judged with the equipment the person trains with most. */
  equipment: readonly string[];
  prefs?: Partial<Prefs>;
  weeks?: number;
  sessions?: readonly HistorySession[];
  kbWeights?: readonly Weight[];
  unit?: WeightUnit;
}

interface FullCtx extends BlockCtx {
  prefs: Prefs;
  rng: () => number;
  /** The build's history index over `sessions`, when the caller has one. */
  hist?: HistIndex;
}

/** A core lift every active profile allows as a block's lift candidate (and never rules out). */
const coreAllowed = (data: EngineData, ex: ExerciseRecord): boolean =>
  data.profiles.active.every(p => {
    const a = attrsOf(ex, p);
    return a != null && !p.never(a) && p.coreCandidate(a);
  });

/** The first active profile that rules this lift out as a block's lift (never, not a core candidate, or not assignable). */
function forbiddenBy(data: EngineData, ex: ExerciseRecord): ConditionProfile | null {
  for (const p of data.profiles.active) {
    const a = attrsOf(ex, p);
    if (!a || p.never(a) || !p.coreCandidate(a) || !p.blockAssignable(ex)) return p;
  }
  return null;
}

function familyCandidates(data: EngineData, familyId: string, { equipment, excluded = [] }: { equipment: readonly string[] | null | undefined; excluded?: readonly string[] }): ExerciseRecord[] {
  const fam = data.coreFamilies.find(f => f.id === familyId);
  if (!fam) return [];
  return Lib.all(data).filter(ex =>
    ex.roles.includes("core") &&
    ex.patterns.some(p => fam.patterns.includes(p)) &&
    Lib.hasEquipment(ex, equipment) &&
    coreAllowed(data, ex) &&
    !excluded.includes(ex.id));
}

/** A lift is topped out when progression has nowhere left to go with this equipment. */
function toppedOut(data: EngineData, ex: ExerciseRecord, ctx: BlockCtx & { hist?: HistIndex }): boolean {
  const history = Prog.historyForIn(HistIndex.for(data, ctx.sessions || [], ctx.hist), ex.id);
  if (!history.length) return false;
  const s = Prog.suggest(data, ex, history, {
    mode: "build", checks: {}, implement: Lib.implementFor(ex, ctx.equipment),
    kbWeights: ctx.kbWeights || [], unit: ctx.unit || "lb", equipment: ctx.equipment,
  });
  return s.action === "graduate" || s.action === "tempo";
}

// Prefers: similar difficulty (one harder if the last lift topped out), a change from last block,
// a related variation, liked lifts.
function pickVariant(data: EngineData, familyId: string, ctx: FullCtx, previousId: string | null): ExerciseRecord | null {
  const prev = previousId ? Lib.get(data, previousId) : null;
  const level = prev ? prev.difficulty + (toppedOut(data, prev, ctx) ? 1 : 0) : 2;
  const ratings = ctx.prefs.ratings || {};
  const pool = familyCandidates(data, familyId, { equipment: ctx.equipment, excluded: ctx.prefs.excluded || [] })
    .filter(ex => data.profiles.active.every(p => p.blockAssignable(ex)));
  let best: { ex: ExerciseRecord; s: number } | null = null;
  for (const ex of pool) {
    let s = -1.5 * Math.abs(ex.difficulty - level);
    if (prev && ex.id !== prev.id) s += 2;
    if (prev && ex.family === prev.family) s += 1;
    if (ex.load === "external") s += 1;   // a lift you can load is one you can progress for weeks
    s += 2 * (ratings[ex.id] || 0);
    s += ctx.rng() * 0.3;
    if (!best || s > best.s) best = { ex, s };
  }
  return best ? best.ex : null;
}

function start(data: EngineData, prev: Block | null, ctx: FullCtx): Block {
  const core: Record<string, string | null> = {};
  for (const fam of data.coreFamilies) {
    const prevId = prev ? prev.core[fam.id] ?? null : null;
    const pinnedLift = prevId && (ctx.prefs.pinned || []).includes(prevId) ? Lib.get(data, prevId) : null;
    // A pin never carries a lift an active profile rules out.
    const pinned = pinnedLift && !forbiddenBy(data, pinnedLift) ? pinnedLift : null;
    const pick = pinned || pickVariant(data, fam.id, ctx, prevId);
    core[fam.id] = pick ? pick.id : null;
  }
  const number = prev ? prev.number + 1 : 1;
  return { id: `b${number}`, number, startedAt: ctx.today, weeks: ctx.weeks || 5, core, rotations: [] };
}

// Judged only on sessions since the lift joined the block (block start, or the day it rotated in).
function rotateReason(data: EngineData, exId: string, sessions: readonly HistorySession[], block: Block, familyId: string, hist?: HistIndex): string | null {
  if (!Lib.get(data, exId)) return "no longer in the library";
  const joined = [...(block.rotations || [])].reverse().find(r => r.family === familyId && r.to === exId);
  // An entry's date is its session's: the lift's whole log from the day it joined is the same entries, in the same
  // order, as the log of only the sessions since then.
  const log = Prog.historyForIn(HistIndex.for(data, sessions, hist), exId).filter(e => (joined ? e.date > joined.date : e.date >= block.startedAt));
  for (const p of data.profiles.active) {
    const why = p.rotateReason(log);
    if (why) return why;
  }
  if (log.length >= 4 && [0, 1, 2].every(i => !Prog.improved(log[i]!, log[i + 1]!))) return "no progress in 3 sessions";
  return null;
}

function ensure(data: EngineData, block: Block | null, ctx: BlockCtx, hist?: HistIndex): { block: Block; events: string[] } {
  const sessions = ctx.sessions || [];
  const c: FullCtx = {
    ...ctx, prefs: { ratings: {}, excluded: [], pinned: [], ...(ctx.prefs || {}) }, rng: Rng.create(`${ctx.today}|block`),
    hist: HistIndex.for(data, sessions, hist),
  };
  if (!block) return { block: start(data, null, c), events: ["Block 1 started."] };
  if (Hist.daysBetween(block.startedAt, ctx.today) >= block.weeks * 7) {
    const next = start(data, block, c);
    return { block: next, events: [`Block ${block.number} complete — block ${next.number} started.`] };
  }
  const core: Record<string, string | null> = { ...block.core };
  const rotations: Rotation[] = [...(block.rotations || [])];
  const events: string[] = [];
  for (const fam of data.coreFamilies) {
    const id = core[fam.id];
    if (!id) continue;
    const lift = Lib.get(data, id);
    const ruledOut = lift ? forbiddenBy(data, lift) : null;   // e.g. assigned while no profile was active
    if (!ruledOut && c.prefs.pinned.includes(id)) continue;
    if (rotations.some(r => r.family === fam.id && r.date === ctx.today)) continue;   // at most once a day
    const why = ruledOut ? `not allowed with ${ruledOut.label}` : rotateReason(data, id, sessions, { ...block, core, rotations }, fam.id, c.hist);
    if (!why) continue;
    // Lifts rotated out earlier in this block stay out.
    const out = [id, ...rotations.filter(r => r.family === fam.id).map(r => r.from).filter((x): x is string => Boolean(x))];
    const pick = pickVariant(data, fam.id, { ...c, prefs: { ...c.prefs, excluded: [...c.prefs.excluded, ...out] } }, Lib.get(data, id) ? id : null);
    if (!pick) continue;
    core[fam.id] = pick.id;
    rotations.push({ family: fam.id, from: id, to: pick.id, date: ctx.today, why });
    events.push(`${(Lib.get(data, id) || { name: id }).name} → ${pick.name}: ${why}.`);
  }
  return { block: { ...block, core, rotations }, events };
}

/** The block's lift if this location and mode allow it, else the closest same-family option. */
function resolveCore(data: EngineData, block: Pick<Block, "core">, familyId: string, equipment: readonly string[], mode: Mode): ExerciseRecord | null {
  const chosenId = block.core[familyId];
  const chosen = chosenId ? Lib.get(data, chosenId) : null;
  if (chosen && Lib.hasEquipment(chosen, equipment) && Lib.fitsMode(data, chosen, mode)) return chosen;
  const level = chosen ? chosen.difficulty : 2;
  const same = (ex: ExerciseRecord) => (chosen && ex.family === chosen.family ? 1 : 0);
  const pool = familyCandidates(data, familyId, { equipment }).filter(ex => Lib.fitsMode(data, ex, mode));
  pool.sort((a, b) => same(b) - same(a) || Math.abs(a.difficulty - level) - Math.abs(b.difficulty - level) || a.id.localeCompare(b.id));
  return pool[0] ?? null;
}

interface FamiliesArgs {
  mode: Mode;
  sessions?: readonly HistorySession[];
  today: string;
  theme?: Pick<Theme, "coreBias"> | null;
  rng: () => number;
}

function familiesForSession(data: EngineData, block: Pick<Block, "core">, { mode, sessions = [], today, theme = null, rng }: FamiliesArgs, hist?: HistIndex): string[] {
  const hi = data.modes[mode].coreCount[1];
  if (!hi) return [];
  const h = HistIndex.for(data, sessions, hist);
  return data.coreFamilies
    .filter(f => block.core[f.id])
    .map(f => {
      const last = Hist.lastFamilyDateIn(h, f.id, today);
      const days = last ? Hist.daysBetween(last, today) : 14;
      const bias = theme && (theme.coreBias || []).includes(f.id) ? 3 : 0;
      return { id: f.id, score: Math.min(days, 14) + bias + rng() * 0.3 };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, hi)
    .map(x => x.id);
}

const weekOf = (block: Pick<Block, "startedAt">, today: string): number => Math.floor(Hist.daysBetween(block.startedAt, today) / 7) + 1;

/** Accepting a "ready for the harder move?" suggestion: the block's lift for that family changes. */
function graduate(data: EngineData, block: Block, familyId: string, exId: string, today: string, equipment: readonly string[]): Block {
  const lift = familyCandidates(data, familyId, { equipment }).find(ex => ex.id === exId);
  // Never a lift an active profile rules out as a block's lift (it would rotate out the next day).
  if (!lift || forbiddenBy(data, lift)) return block;
  return {
    ...block,
    core: { ...block.core, [familyId]: exId },
    rotations: [...(block.rotations || []), { family: familyId, from: block.core[familyId] ?? null, to: exId, date: today, why: "graduated" }],
  };
}

export const Blocks = { ensure, start, pickVariant, resolveCore, familyCandidates, familiesForSession, weekOf, graduate, rotateReason };
