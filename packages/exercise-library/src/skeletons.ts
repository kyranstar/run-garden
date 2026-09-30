import type { ConditionProfile } from "./conditions/types.js";
import type { BlockId, FormatId, Mode, Pattern, Role } from "./vocab.js";
import { MODE_IDS } from "./vocab.js";

// The session skeleton: the blocks, the order they play in and fill in, which roles, patterns and
// formats each takes, and each block's share of the minutes and item limits per mode. The `care` block
// is a placeholder that a cared-for condition profile fills (Phase 1 spec §4.4).

export interface BlockSpec {
  label: string;
  roles: readonly Role[];
  /** An extra pattern requirement (sessions open with breathing), or null for none. */
  patterns: readonly Pattern[] | null;
  /** Formats the block may use, in preference order (mode and theme narrow them further). */
  formats: readonly FormatId[];
}

type PerBlock<T> = Readonly<Partial<Record<BlockId, T>>>;

export interface SkeletonSpec {
  /** Play order. */
  order: readonly BlockId[];
  /** Fill order: core first so prep can target its regions; prep last so it absorbs leftover time. */
  fillOrder: readonly BlockId[];
  blocks: PerBlock<BlockSpec>;
  /** Share of the session's minutes each block starts with (unused time rolls forward). */
  shares: Readonly<Record<Mode, PerBlock<number>>>;
  /** Minimum items per block (added even if the block's share is tight). */
  min: Readonly<Record<Mode, PerBlock<number>>>;
  /** Maximum items per timed block; spare time beyond these goes unused rather than piling up. */
  max: Readonly<Record<Mode, PerBlock<number>>>;
}

/** One mode's view of a skeleton. */
export interface ModeSkeleton {
  order: readonly BlockId[];
  fillOrder: readonly BlockId[];
  blocks: PerBlock<BlockSpec>;
  shares: PerBlock<number>;
  min: PerBlock<number>;
  max: PerBlock<number>;
}

export const SKELETON: SkeletonSpec = {
  order: ["arrive", "prep", "core", "accessory", "care", "cooldown"],
  fillOrder: ["core", "accessory", "care", "arrive", "cooldown", "prep"],
  blocks: {
    arrive: { label: "Arrive", roles: ["downshift"], patterns: ["breathe"], formats: ["holds"] },
    prep: { label: "Prep", roles: ["warmup", "activation", "mobility"], patterns: null, formats: ["flow", "holds"] },
    core: { label: "Core lifts", roles: ["core"], patterns: null, formats: ["straight", "superset"] },
    accessory: { label: "Accessory", roles: ["accessory", "finisher"], patterns: null, formats: ["superset", "circuit", "ladder", "straight"] },
    care: { label: "Care", roles: [], patterns: null, formats: [] },
    cooldown: { label: "Cool-down", roles: ["cooldown", "stretch", "downshift"], patterns: null, formats: ["flow", "holds"] },
  },
  shares: {
    recovery: { arrive: 0.12, prep: 0.46, core: 0, accessory: 0, care: 0.27, cooldown: 0.15 },
    consistent: { arrive: 0.07, prep: 0.2, core: 0.4, accessory: 0.13, care: 0.1, cooldown: 0.1 },
    build: { arrive: 0.05, prep: 0.16, core: 0.45, accessory: 0.2, care: 0.07, cooldown: 0.07 },
  },
  min: {
    recovery: { arrive: 1, prep: 1, cooldown: 1 },
    consistent: { arrive: 1, prep: 1, cooldown: 1 },
    build: { arrive: 1, prep: 1, cooldown: 1 },
  },
  max: {
    recovery: { arrive: 3, prep: 14, cooldown: 5 },
    consistent: { arrive: 2, prep: 8, cooldown: 4 },
    build: { arrive: 2, prep: 7, cooldown: 3 },
  },
};

const without = <T>(rec: PerBlock<T>, key: BlockId): PerBlock<T> => {
  const out: Partial<Record<BlockId, T>> = { ...rec };
  delete out[key];
  return out;
};

/**
 * The skeleton for the given cared-for profiles, all modes.
 * - one profile: its care block supplies roles, formats, min and max; the share is the table's `care` share;
 * - none: the `care` block is dropped and the remaining shares are renormalised to sum to 1;
 * - more than one: not supported.
 */
export function composeSkeleton(careProfiles: readonly ConditionProfile[]): SkeletonSpec {
  if (careProfiles.length > 1) {
    throw new Error(`A program can care for at most one condition profile for now (got ${careProfiles.map(p => p.id).join(", ")}).`);
  }
  const profile = careProfiles[0];
  if (profile) {
    const care = profile.care;
    if (!care) throw new Error(`Condition profile "${profile.id}" has no care content.`);
    const min = {} as Record<Mode, PerBlock<number>>;
    const max = {} as Record<Mode, PerBlock<number>>;
    for (const mode of MODE_IDS) {
      min[mode] = { ...SKELETON.min[mode], care: care.block.min[mode] };
      max[mode] = { ...SKELETON.max[mode], care: care.block.max[mode] };
    }
    return {
      ...SKELETON,
      blocks: { ...SKELETON.blocks, care: { label: care.block.label, roles: care.block.roles, patterns: null, formats: care.block.formats } },
      min,
      max,
    };
  }
  const shares = {} as Record<Mode, PerBlock<number>>;
  const min = {} as Record<Mode, PerBlock<number>>;
  const max = {} as Record<Mode, PerBlock<number>>;
  for (const mode of MODE_IDS) {
    const rest = without(SKELETON.shares[mode], "care");
    const total = Object.values(rest).reduce((sum: number, v) => sum + (v ?? 0), 0);
    const renormalised: Partial<Record<BlockId, number>> = {};
    for (const [k, v] of Object.entries(rest) as Array<[BlockId, number]>) renormalised[k] = total > 0 ? v / total : 0;
    shares[mode] = renormalised;
    min[mode] = without(SKELETON.min[mode], "care");
    max[mode] = without(SKELETON.max[mode], "care");
  }
  return {
    order: SKELETON.order.filter(b => b !== "care"),
    fillOrder: SKELETON.fillOrder.filter(b => b !== "care"),
    blocks: without(SKELETON.blocks, "care"),
    shares,
    min,
    max,
  };
}

/** One mode's slice of a skeleton. */
export function modeSkeleton(skeleton: SkeletonSpec, mode: Mode): ModeSkeleton {
  return {
    order: skeleton.order,
    fillOrder: skeleton.fillOrder,
    blocks: skeleton.blocks,
    shares: skeleton.shares[mode],
    min: skeleton.min[mode],
    max: skeleton.max[mode],
  };
}

/** The skeleton one mode uses with these cared-for profiles (Phase 1 spec §4.4). */
export function skeletonFor(mode: Mode, careProfiles: readonly ConditionProfile[]): ModeSkeleton {
  return modeSkeleton(composeSkeleton(careProfiles), mode);
}
