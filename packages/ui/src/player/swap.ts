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
 * stands. A slot's move that is the session's new or retried jump says so (`fresh`, as the engine's swap state marks
 * it), so the one-new-rung rule holds offline as it does on the server. Every move offered fits the plan by the server's full state too, and applying it plays exactly its offered
 * steps — the server's rebuild with the same swaps plays the same; a slot may offer fewer (or later-ranked) moves than
 * the server would list, since the moves the build did not offer are not on the device. Swaps apply in the order
 * made, as the server applies stored swaps.
 *
 * A DOCUMENT workout's item may plan its own alternates (Stage 2 spec §11): the build carries each with its steps
 * (`fromDoc.slots`), and ⇄ offers them first, then the library's usual offers the server worked out for the slot (the
 * engine's offers for a document: `slots[k].offers`), then the engine's own (an engine build's). A document's time and
 * its superset pairs are its author's — the day's own swap at the build (`gateDoc`) holds an alternate to the
 * validator alone — so its build is held to no time budget and no pairing rule; a move the session already holds is
 * still never offered.
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
  const fromDoc = build.fromDoc !== undefined;
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
      // The session's one new-or-retried jump, as the server's swap state marked it: no slot takes a second one.
      ...(item.fresh ? { fresh: true as const } : {}),
    };
    // The item's planned alternates first, then the usual offers (a move listed twice is offered once, the first time).
    const doc = build.fromDoc?.slots?.[item.slotKey];
    const offered = [...(doc?.alternates ?? []), ...(doc?.offers ?? []), ...(build.alternatives[item.slotKey] ?? [])];
    // The plan's own move: what a day's swap replaced, when the build offers it back; otherwise the move it holds.
    const from = build.params.swaps?.[item.slotKey]?.from ?? null;
    const original = (from && from !== item.exerciseId ? offered.find((c) => c.id === from) : undefined) ?? here;
    const partner =
      item.format === "superset" && !fromDoc
        ? (build.items.find((o) => o.slotKey !== item.slotKey && o.block === item.block && o.format === "superset")?.slotKey ?? null)
        : null;
    slots[item.slotKey] = { slotKey: item.slotKey, partner, original, pool: offered.filter((c) => c.id !== original.id) };
    current[item.slotKey] = here;
  }
  const budget = fromDoc ? Number.POSITIVE_INFINITY : build.minutes * 60;
  const out = { state: { budget, slack: Swapping.SLACK_SECONDS, current, slots }, steps: build.steps };
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
