/**
 * SWAPS MID-SESSION, OFFLINE (Phase 2b Task 5; spec §2b "Player"; Review Focus 4).
 *
 * The engine checks a swap against the whole plan — no move twice, one version of a move, superset partners that
 * pair, the time budget plus its slack (`Swapping`) — and offers each slot what fits now. The server keeps the full
 * swap pool for that; the stored build does not (it would be ~420 KB). What the build does carry is enough to rebuild
 * the swap state the player needs: each slot's move (its steps are the build's steps), the move the plan chose when
 * the day's own swaps replaced it (`params.swaps`), and the alternatives the build offered, each with its steps.
 *
 * So after each swap ⇄ re-asks the engine's own rules (`Swapping.offered`) over that state and the plan as it now
 * stands. Every move offered fits the plan by the server's full state too, and applying it plays exactly its offered
 * steps — the server's rebuild with the same swaps plays the same; a slot may offer fewer (or later-ranked) moves than
 * the server would list, since the moves the build did not offer are not on the device. Swaps apply in the order
 * made, as the server applies stored swaps.
 */
import type { SessionBuildDto } from "@rg/api-client";
import type { ExerciseRecord } from "@rg/exercise-library";
import { Swapping, type SlotChoice, type Step, type SwapSlot, type SwapState } from "@rg/session-engine";

/** A swap made in the player: the slot and the move it holds now. */
export interface MadeSwap {
  slotKey: string;
  to: string;
}

const cache = new WeakMap<SessionBuildDto, { state: SwapState; steps: Step[] }>();

/** The swap state as the build left it: every slot holding the build's move. */
export function swapStateOf(build: SessionBuildDto): { state: SwapState; steps: Step[] } {
  const hit = cache.get(build);
  if (hit) return hit;
  const slots: Record<string, SwapSlot> = {};
  const current: Record<string, SlotChoice> = {};
  for (const item of build.items) {
    const ex = build.exercises[item.exerciseId] as unknown as ExerciseRecord | undefined;
    if (!ex) continue;
    const here: SlotChoice = {
      id: item.exerciseId,
      name: ex.name,
      reasons: item.why,
      steps: build.steps.filter((s) => s.kind !== "rest" && s.slotKey === item.slotKey),
      moveKey: Swapping.moveKeyOf(ex),
      pairing: Swapping.pairingOf(ex),
    };
    const offered = build.alternatives[item.slotKey] ?? [];
    // The plan's own move: what a day's swap replaced, when the build offers it back; otherwise the move it holds.
    const from = build.params.swaps?.[item.slotKey]?.from ?? null;
    const original = (from && from !== item.exerciseId ? offered.find((c) => c.id === from) : undefined) ?? here;
    const partner =
      item.format === "superset"
        ? (build.items.find((o) => o.slotKey !== item.slotKey && o.block === item.block && o.format === "superset")?.slotKey ?? null)
        : null;
    slots[item.slotKey] = { slotKey: item.slotKey, partner, original, pool: offered.filter((c) => c.id !== original.id) };
    current[item.slotKey] = here;
  }
  const out = { state: { budget: build.minutes * 60, slack: Swapping.SLACK_SECONDS, current, slots }, steps: build.steps };
  cache.set(build, out);
  return out;
}

/** The choice `to` for a slot: its original or one the build offered. */
function choiceFor(state: SwapState, slotKey: string, to: string): SlotChoice | null {
  const slot = state.slots[slotKey];
  if (!slot) return null;
  if (slot.original.id === to) return slot.original;
  if (state.current[slotKey]?.id === to) return state.current[slotKey]!;
  return slot.pool.find((c) => c.id === to) ?? null;
}

/** The plan after the swaps made, in order (one that no longer fits is left out, as the server's rebuild does). */
export function planAfter(build: SessionBuildDto, swaps: readonly MadeSwap[]): { state: SwapState; steps: Step[] } {
  let plan = swapStateOf(build);
  for (const s of swaps) {
    const choice = choiceFor(plan.state, s.slotKey, s.to);
    if (!choice || choice.id === plan.state.current[s.slotKey]?.id) continue;
    if (!Swapping.fits(plan.state, plan.steps, s.slotKey, choice)) continue;
    plan = Swapping.apply(plan.state, plan.steps, s.slotKey, choice);
  }
  return plan;
}

/** What ⇄ offers for a slot now, after the swaps made: up to 3, the planned move first once swapped away. */
export function offeredNow(build: SessionBuildDto, swaps: readonly MadeSwap[], slotKey: string): SlotChoice[] {
  const plan = planAfter(build, swaps);
  return Swapping.offered(plan.state, plan.steps, slotKey);
}
