import type { DoseType } from "@rg/exercise-library";
import type { Step } from "./types.js";

// Swaps as an exact, pure operation on a built plan (audit I1, I2, M4). A swap replaces one slot's move and
// nothing else: the slot keeps its format, sets and rests; its own steps become the choice's steps. Whether a
// swap is allowed depends only on the plan it lands in (no move twice, one version of a move, superset partners
// that pair, the time budget), so a choice the plan offers is exactly what applying it produces — before Start
// (the server applies the same functions) and mid-session (the player applies them offline, with no library).

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
  /** Other moves this slot can take, best first; checked against the plan when offered. */
  pool: SlotChoice[];
}

/** A built plan's swap state: what each slot holds now, and what it could hold. */
export interface SwapState {
  /** Planned seconds may not exceed this. */
  budget: number;
  current: Record<string, SlotChoice>;
  slots: Record<string, SwapSlot>;
}

const costOf = (steps: readonly Step[]): number => steps.reduce((sum, s) => sum + s.seconds + (s.prepGap || 0), 0);

const pairable = (a: Pairing, b: Pairing): boolean =>
  a.doseType === "reps" && b.doseType === "reps" && !a.patterns.some(p => b.patterns.includes(p)) && a.positionGroup === b.positionGroup;

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

/** Whether the slot can take `choice` in this plan. */
function fits(state: SwapState, steps: readonly Step[], slotKey: string, choice: SlotChoice): boolean {
  const slot = state.slots[slotKey];
  const here = state.current[slotKey];
  if (!slot || !here || choice.id === here.id) return false;
  for (const [key, c] of Object.entries(state.current)) {
    if (key !== slotKey && (c.id === choice.id || c.moveKey === choice.moveKey)) return false;
  }
  const partner = slot.partner ? state.current[slot.partner] : undefined;
  if (partner && !pairable(partner.pairing, choice.pairing)) return false;
  return costOf(splice(steps, slotKey, choice.steps)) <= state.budget;
}

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
  const out: SlotChoice[] = [];
  for (const c of list) {
    if (out.length >= k) break;
    if (!out.some(o => o.id === c.id) && fits(state, steps, slotKey, c)) out.push(c);
  }
  return out;
}

/** Every rule at once: distinct moves, one version of each, partners that pair, within the budget. */
function consistent(state: SwapState, steps: readonly Step[]): boolean {
  const current = Object.entries(state.current);
  const ids = new Set(current.map(([, c]) => c.id));
  const keys = new Set(current.map(([, c]) => c.moveKey));
  if (ids.size !== current.length || keys.size !== current.length) return false;
  for (const [slotKey, c] of current) {
    const partner = state.slots[slotKey]?.partner;
    const other = partner ? state.current[partner] : undefined;
    if (other && !pairable(other.pairing, c.pairing)) return false;
  }
  return costOf(steps) <= state.budget;
}

export const Swapping = { offered, fits, apply, splice, consistent, pairable, costOf };
