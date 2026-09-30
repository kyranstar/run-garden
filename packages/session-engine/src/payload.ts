import { Swapping, type SlotChoice, type SwapSlot, type SwapState } from "./swapping.js";
import type { BuildResult, Group, Plan, Step } from "./types.js";

// The build as stored and sent to the player: everything the player and the how-to sheet render, without what
// the player can derive. `decode(encode(build))` equals the build.
//  - `alternatives` is dropped: it is `Swapping.offered` over the swap state for every slot.
//  - `swapState.current` is stored as ids: each is the slot's original or one of its pool.
//  - `groups[].items` is stored as slot keys: the items are in `items`.
//  - A choice's steps are stored as the fields they share plus each step's own fields.

/** A choice's steps: the fields every step shares, and what each step adds. */
interface PackedSteps {
  shared: Partial<Step>;
  each: Array<Partial<Step>>;
}

type PackedChoice = Omit<SlotChoice, "steps"> & { steps: PackedSteps };

interface PackedSlot {
  slotKey: string;
  partner: string | null;
  original: PackedChoice;
  pool: PackedChoice[];
}

export interface BuildPayload extends Omit<Plan, "groups"> {
  groups: Array<Omit<Group, "items"> & { items: string[] }>;
  swapState: {
    budget: number;
    slack: number;
    /** Slot key → the id of the move it holds (the original or one of its pool). */
    current: Record<string, string>;
    slots: Record<string, PackedSlot>;
  };
}

/** What a choice's steps say that its slot and its own id already tell: the slot key, its block, the move's id. */
const implied = (slotKey: string, id: string): Partial<Step> => ({ slotKey, block: slotKey.split(":")[0] as Step["block"], exerciseId: id });

function packSteps(steps: readonly Step[], known: Partial<Step>): PackedSteps {
  const first = steps[0];
  if (!first) return { shared: {}, each: [] };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const keys = Object.keys(first) as Array<keyof Step>;
  const sharedKeys = keys.filter(k => steps.every(s => same(s[k], first[k])));
  const shared: Partial<Step> = Object.fromEntries(sharedKeys.filter(k => !(k in known && same(known[k], first[k]))).map(k => [k, first[k]]));
  const each = steps.map(s => Object.fromEntries((Object.keys(s) as Array<keyof Step>).filter(k => !sharedKeys.includes(k)).map(k => [k, s[k]])) as Partial<Step>);
  return { shared, each };
}

const unpackSteps = (p: PackedSteps, known: Partial<Step>): Step[] => p.each.map(e => ({ ...known, ...p.shared, ...e }) as Step);

const packChoice = (slotKey: string, { steps, ...rest }: SlotChoice): PackedChoice => ({ ...rest, steps: packSteps(steps, implied(slotKey, rest.id)) });
const unpackChoice = (slotKey: string, { steps, ...rest }: PackedChoice): SlotChoice => ({ ...rest, steps: unpackSteps(steps, implied(slotKey, rest.id)) });

function encode(build: BuildResult): BuildPayload {
  const { alternatives: _derived, swapState, groups, ...plan } = build;
  const slots: Record<string, PackedSlot> = {};
  for (const [key, s] of Object.entries(swapState.slots)) {
    slots[key] = { slotKey: s.slotKey, partner: s.partner, original: packChoice(key, s.original), pool: s.pool.map(c => packChoice(key, c)) };
  }
  return {
    ...plan,
    groups: groups.map(g => ({ ...g, items: g.items.map(i => i.slotKey) })),
    swapState: {
      budget: swapState.budget, slack: swapState.slack,
      current: Object.fromEntries(Object.entries(swapState.current).map(([k, c]) => [k, c.id])),
      slots,
    },
  };
}

function decode(payload: BuildPayload): BuildResult {
  const { groups, swapState: packed, ...plan } = payload;
  const slots: Record<string, SwapSlot> = {};
  for (const [key, s] of Object.entries(packed.slots)) {
    slots[key] = { slotKey: s.slotKey, partner: s.partner, original: unpackChoice(key, s.original), pool: s.pool.map(c => unpackChoice(key, c)) };
  }
  const current: Record<string, SlotChoice> = {};
  for (const [key, id] of Object.entries(packed.current)) {
    const slot = slots[key];
    const choice = slot && (slot.original.id === id ? slot.original : slot.pool.find(c => c.id === id));
    if (!choice) throw new Error(`Build payload: slot ${key} holds "${id}", which is neither its original nor in its pool.`);
    current[key] = choice;
  }
  const swapState: SwapState = { budget: packed.budget, slack: packed.slack, current, slots };
  const bySlot = new Map(plan.items.map(i => [i.slotKey, i]));
  return {
    ...plan,
    groups: groups.map(g => ({ ...g, items: g.items.map(k => bySlot.get(k)!) })),
    alternatives: Object.fromEntries(plan.items.map(i => [i.slotKey, Swapping.offered(swapState, plan.steps, i.slotKey)])),
    swapState,
  };
}

export const Payload = { encode, decode };
