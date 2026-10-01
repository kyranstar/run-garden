import type { DoseType } from "@rg/exercise-library";
import type { Step } from "./types.js";

// Swaps as an exact, pure operation on a built plan (audit I1, I2, M4; re-review N1). A swap replaces one slot's
// move and nothing else: the slot keeps its format, sets and rests; its own steps become the choice's steps.
// Whether a swap is allowed depends only on the plan it lands in (no move twice, one version of a move, superset
// partners that pair, the time budget plus a small slack), so a choice the plan offers is exactly what applying
// it produces — before Start (the server applies the same functions) and mid-session (the player applies them
// offline, with no library). The rules judge what swaps bring in: two slots that both still hold the plan's own
// moves are never in conflict, even if the plan filled them with two versions of one move.

/** What superset pairing needs to know about a move. */
export interface Pairing {
  doseType: DoseType;
  patterns: readonly string[];
  positionGroup: string;
}

/** A move a slot can hold, with everything needed to check and play it offline. */
export interface SlotChoice {
  id: string;
  name: string;
  reasons: string[];
  /** The slot's steps (rests excluded) with this move in it. */
  steps: Step[];
  /** family|regions: a session holds one version of a move. */
  moveKey: string;
  pairing: Pairing;
}

export interface SwapSlot {
  slotKey: string;
  /** The superset partner's slot, if the slot is in a superset. */
  partner: string | null;
  /** The move the plan chose. */
  original: SlotChoice;
  /** Every other move this slot can take, best first; checked against the plan when offered. */
  pool: SlotChoice[];
}

/** A built plan's swap state: what each slot holds now, and what it could hold. */
export interface SwapState {
  /** The session's planned seconds (minutes × 60). */
  budget: number;
  /** How far swaps may take the plan past the budget, in seconds (plans are filled to within seconds of it). */
  slack: number;
  current: Record<string, SlotChoice>;
  slots: Record<string, SwapSlot>;
}

const costOf = (steps: readonly Step[]): number => steps.reduce((sum, s) => sum + s.seconds + (s.prepGap || 0), 0);

const pairable = (a: Pairing, b: Pairing): boolean =>
  a.doseType === "reps" && b.doseType === "reps" && !a.patterns.some(p => b.patterns.includes(p)) && a.positionGroup === b.positionGroup;

/** Whether the slot holds the plan's own move. */
const isOriginal = (state: SwapState, slotKey: string, choice: SlotChoice | undefined = state.current[slotKey]): boolean =>
  Boolean(choice && state.slots[slotKey] && state.slots[slotKey]!.original.id === choice.id);

/** Two slots' moves conflict (same move, or two versions of one) unless both are the plan's own. */
function clash(state: SwapState, keyA: string, a: SlotChoice, keyB: string, b: SlotChoice): boolean {
  if (a.id !== b.id && a.moveKey !== b.moveKey) return false;
  return !(isOriginal(state, keyA, a) && isOriginal(state, keyB, b));
}

/** Superset partners that don't pair, unless both are the plan's own. */
function unpaired(state: SwapState, keyA: string, a: SlotChoice, keyB: string, b: SlotChoice): boolean {
  return !pairable(a.pairing, b.pairing) && !(isOriginal(state, keyA, a) && isOriginal(state, keyB, b));
}

/** The slot's steps replaced set by set with `fresh` (as a mid-session rebase does); every other step stays. */
function splice(steps: readonly Step[], slotKey: string, fresh: readonly Step[]): Step[] {
  const out: Step[] = [];
  const emitted = new Set<number | null>();
  for (const s of steps) {
    if (s.kind === "rest" || s.slotKey !== slotKey) { out.push(s); continue; }
    if (emitted.has(s.setIndex)) continue;
    emitted.add(s.setIndex);
    out.push(...fresh.filter(x => x.setIndex === s.setIndex));
  }
  return out;
}

/**
 * One slot's judge in this plan: the same answer as checking `choice` against every other slot with `clash` and
 * `unpaired`, and the planned seconds of `splice(steps, slotKey, choice.steps)`, worked out in one pass.
 */
function judge(state: SwapState, steps: readonly Step[], slotKey: string): (choice: SlotChoice) => boolean {
  const slot = state.slots[slotKey];
  const here = state.current[slotKey];
  if (!slot || !here) return () => false;
  // For every id and move key held elsewhere: whether each slot holding it still holds the plan's own move.
  const ids = new Map<string, boolean>();
  const keys = new Map<string, boolean>();
  for (const [key, c] of Object.entries(state.current)) {
    if (key === slotKey) continue;
    const original = isOriginal(state, key, c);
    ids.set(c.id, (ids.get(c.id) ?? true) && original);
    keys.set(c.moveKey, (keys.get(c.moveKey) ?? true) && original);
  }
  let others = 0;
  const sets = new Set<number | null>();
  for (const s of steps) {
    if (s.kind !== "rest" && s.slotKey === slotKey) sets.add(s.setIndex);
    else others += s.seconds + (s.prepGap || 0);
  }
  const partnerKey = slot.partner;
  const partner = partnerKey ? state.current[partnerKey] : undefined;
  return (choice) => {
    if (choice.id === here.id) return false;
    const mine = slot.original.id === choice.id;
    const byId = ids.get(choice.id), byKey = keys.get(choice.moveKey);
    if (byId !== undefined && !(mine && byId)) return false;
    if (byKey !== undefined && !(mine && byKey)) return false;
    if (partner && unpaired(state, slotKey, choice, partnerKey!, partner)) return false;
    return others + costOf(choice.steps.filter(x => sets.has(x.setIndex))) <= state.budget + state.slack;
  };
}

/** Whether the slot can take `choice` in this plan. */
const fits = (state: SwapState, steps: readonly Step[], slotKey: string, choice: SlotChoice): boolean => judge(state, steps, slotKey)(choice);

/** The plan with the slot holding `choice` (no checks: call `fits` or `offered` first). */
function apply(state: SwapState, steps: readonly Step[], slotKey: string, choice: SlotChoice): { state: SwapState; steps: Step[] } {
  return { state: { ...state, current: { ...state.current, [slotKey]: choice } }, steps: splice(steps, slotKey, choice.steps) };
}

/** Up to k moves the slot can take now: the plan's original first once it has been swapped away, then the pool. */
function offered(state: SwapState, steps: readonly Step[], slotKey: string, k = 3): SlotChoice[] {
  const slot = state.slots[slotKey];
  const here = state.current[slotKey];
  if (!slot || !here) return [];
  const list = here.id !== slot.original.id ? [slot.original, ...slot.pool] : slot.pool;
  const ok = judge(state, steps, slotKey);
  const out: SlotChoice[] = [];
  for (const c of list) {
    if (out.length >= k) break;
    if (!out.some(o => o.id === c.id) && ok(c)) out.push(c);
  }
  return out;
}

/** Every rule at once, as `fits` judges each swap: no clash, partners that pair, within the budget and slack. */
function consistent(state: SwapState, steps: readonly Step[]): boolean {
  const current = Object.entries(state.current);
  for (let i = 0; i < current.length; i++) {
    for (let j = i + 1; j < current.length; j++) {
      if (clash(state, current[i]![0], current[i]![1], current[j]![0], current[j]![1])) return false;
    }
  }
  for (const [slotKey, c] of current) {
    const partner = state.slots[slotKey]?.partner;
    const other = partner ? state.current[partner] : undefined;
    if (other && unpaired(state, slotKey, c, partner!, other)) return false;
  }
  return costOf(steps) <= state.budget + state.slack;
}

export const Swapping = { offered, fits, apply, splice, consistent, pairable, costOf };
