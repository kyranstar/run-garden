import { describe, expect, it } from "vitest";
import { MODE_IDS, THEMES, TMJ, composeSkeleton, makeEngineData, skeletonFor, type ConditionProfile } from "../src/index.js";

// The standalone tool's skeleton tables, with its `jaw` block written as `care`.
const STANDALONE = {
  skeletons: {
    recovery: { arrive: 0.12, prep: 0.46, core: 0, accessory: 0, care: 0.27, cooldown: 0.15 },
    consistent: { arrive: 0.07, prep: 0.2, core: 0.4, accessory: 0.13, care: 0.1, cooldown: 0.1 },
    build: { arrive: 0.05, prep: 0.16, core: 0.45, accessory: 0.2, care: 0.07, cooldown: 0.07 },
  },
  blockRoles: {
    arrive: ["downshift"], prep: ["warmup", "activation", "mobility"], core: ["core"], accessory: ["accessory", "finisher"],
    care: ["jaw-care"], cooldown: ["cooldown", "stretch", "downshift"],
  },
  blockFormats: {
    arrive: ["holds"], prep: ["flow", "holds"], core: ["straight", "superset"], accessory: ["superset", "circuit", "ladder", "straight"],
    care: ["holds"], cooldown: ["flow", "holds"],
  },
  blockMin: {
    recovery: { arrive: 1, prep: 1, care: 3, cooldown: 1 },
    consistent: { arrive: 1, prep: 1, care: 1, cooldown: 1 },
    build: { arrive: 1, prep: 1, care: 1, cooldown: 1 },
  },
  blockMax: {
    recovery: { arrive: 3, prep: 14, care: 6, cooldown: 5 },
    consistent: { arrive: 2, prep: 8, care: 3, cooldown: 4 },
    build: { arrive: 2, prep: 7, care: 3, cooldown: 3 },
  },
};

describe("skeletonFor", () => {
  it("with TMJ cared for, reproduces the standalone skeleton exactly (care = the standalone jaw block)", () => {
    for (const mode of MODE_IDS) {
      const s = skeletonFor(mode, [TMJ]);
      expect(s.order).toEqual(["arrive", "prep", "core", "accessory", "care", "cooldown"]);
      expect(s.fillOrder).toEqual(["core", "accessory", "care", "arrive", "cooldown", "prep"]);
      expect(s.shares).toEqual(STANDALONE.skeletons[mode]);
      expect(s.min).toEqual(STANDALONE.blockMin[mode]);
      expect(s.max).toEqual(STANDALONE.blockMax[mode]);
      for (const [block, roles] of Object.entries(STANDALONE.blockRoles)) expect(s.blocks[block as "care"]?.roles, block).toEqual(roles);
      for (const [block, formats] of Object.entries(STANDALONE.blockFormats)) expect(s.blocks[block as "care"]?.formats, block).toEqual(formats);
      expect(s.blocks.arrive?.patterns).toEqual(["breathe"]);
      expect(s.blocks.care?.label).toBe("Jaw care");
    }
  });

  it("with no cared-for profile, drops the care block and renormalises the shares", () => {
    for (const mode of MODE_IDS) {
      const s = skeletonFor(mode, []);
      expect(s.order).not.toContain("care");
      expect(s.fillOrder).not.toContain("care");
      expect(s.blocks.care).toBeUndefined();
      expect(s.min.care).toBeUndefined();
      expect(s.max.care).toBeUndefined();
      const shares = s.shares as Record<string, number>;
      expect(Object.keys(shares).sort()).toEqual(["accessory", "arrive", "cooldown", "core", "prep"]);
      const sum = Object.values(shares).reduce((x, y) => x + y, 0);
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
      // The ratios among the remaining blocks are the standalone ratios.
      const original = STANDALONE.skeletons[mode] as Record<string, number>;
      const scale = 1 - (original.care ?? 0);
      for (const [block, share] of Object.entries(shares)) expect(share).toBeCloseTo((original[block] ?? 0) / scale, 12);
    }
  });

  it("more than one cared-for profile is refused with a clear message", () => {
    const other: ConditionProfile = { ...TMJ, id: "other" };
    expect(() => composeSkeleton([TMJ, other])).toThrow(/at most one condition profile/);
  });
});

describe("makeEngineData", () => {
  it("adds the cared-for profile's targets and themes", () => {
    const d = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: [] });
    expect(d.profiles.active).toEqual([TMJ]);
    expect(d.profiles.care).toEqual([TMJ]);
    expect(d.targets.regions.jaw).toBe(4);
    expect(d.targets.regions.neck).toBe(3);
    expect(d.themes.map(t => t.id)).toEqual(THEMES.map(t => t.id));
    expect(d.skeleton.blocks.care?.roles).toEqual(["jaw-care"]);
  });

  it("without care: no care block, no care targets, no care themes; the profile's rules stay active", () => {
    const d = makeEngineData({ activeProfiles: ["tmj"], careProfiles: [], exercises: [] });
    expect(d.profiles.active).toEqual([TMJ]);
    expect(d.profiles.care).toEqual([]);
    expect(d.targets.regions.jaw).toBeUndefined();
    expect(d.themes.some(t => t.profile)).toBe(false);
    expect(d.themes.some(t => t.modes.includes("recovery"))).toBe(true);
    expect(d.skeleton.order).not.toContain("care");
  });

  it("unknown profiles are refused", () => {
    expect(() => makeEngineData({ activeProfiles: ["nope"], careProfiles: [], exercises: [] })).toThrow(/Unknown condition profile "nope" \(known: tmj\)/);
  });

  it("a program can only care for a profile that is active (audit M8)", () => {
    expect(() => makeEngineData({ activeProfiles: [], careProfiles: ["tmj"], exercises: [] })).toThrow(/cares for condition profile "tmj", which isn't active/);
    expect(() => makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: [] })).not.toThrow();
  });
});
