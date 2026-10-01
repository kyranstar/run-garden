import { describe, expect, it } from "vitest";
import {
  adaptiveConfigSchema,
  blockIntentSchema,
  blockKindSchema,
  parseBlockIntent,
  programKindSchema,
  programStatusSchema,
} from "../src/index.js";

describe("programKindSchema / programStatusSchema", () => {
  it("names the four kinds and five statuses of the programs table", () => {
    expect(programKindSchema.options).toEqual(["adaptive", "coros_import", "coach", "studio"]);
    expect(programStatusSchema.options).toEqual(["draft", "active", "completed", "retired", "archived"]);
    expect(programKindSchema.safeParse("training_plan").success).toBe(false);
  });
});

describe("adaptiveConfigSchema", () => {
  it("fills every default from an empty object", () => {
    expect(adaptiveConfigSchema.parse({})).toEqual({
      weeklyGoal: 4,
      preferredDays: [],
      defaultMinutes: 30,
      defaultLocationId: null,
      blockWeeks: 5,
      modes: ["recovery", "consistent", "build"],
      careProfiles: [],
      placementWeeksAhead: 2,
    });
  });

  it("keeps a full config as given", () => {
    const config = {
      weeklyGoal: 3,
      preferredDays: [4, 0, 2],
      defaultMinutes: 45,
      defaultLocationId: "loc-1",
      blockWeeks: 6,
      modes: ["consistent", "build"],
      careProfiles: ["profile-a"],
      placementWeeksAhead: 4,
    };
    expect(adaptiveConfigSchema.parse(config)).toEqual(config);
  });

  it.each([
    ["weeklyGoal", 0],
    ["weeklyGoal", 8],
    ["weeklyGoal", 2.5],
    ["defaultMinutes", 9],
    ["defaultMinutes", 91],
    ["blockWeeks", 3],
    ["blockWeeks", 7],
    ["placementWeeksAhead", 0],
    ["placementWeeksAhead", 5],
    ["preferredDays", [7]],
    ["preferredDays", [-1]],
    ["preferredDays", [1, 1]],
    ["modes", []],
    ["modes", ["flare"]],
    ["modes", ["build", "build"]],
    ["careProfiles", [""]],
    ["careProfiles", ["a", "a"]],
    ["defaultLocationId", ""],
  ])("refuses %s = %j", (key, value) => {
    expect(adaptiveConfigSchema.safeParse({ [key]: value }).success).toBe(false);
  });

  it("accepts each bound itself", () => {
    for (const config of [
      { weeklyGoal: 1, defaultMinutes: 10, blockWeeks: 4, placementWeeksAhead: 1, preferredDays: [0] },
      { weeklyGoal: 7, defaultMinutes: 90, blockWeeks: 6, placementWeeksAhead: 4, preferredDays: [6, 5, 4, 3, 2, 1, 0] },
    ]) {
      expect(adaptiveConfigSchema.safeParse(config).success, JSON.stringify(config)).toBe(true);
    }
  });

  it("refuses a key it does not know", () => {
    expect(adaptiveConfigSchema.safeParse({ weeklygoal: 3 }).success).toBe(false);
  });
});

describe("blockIntentSchema", () => {
  const core = {
    core: { squat: "goblet-squat", hinge: null },
    rotations: [{ family: "hinge", from: null, to: "kb-deadlift", date: "2026-10-08", why: "No progress in 3 sessions." }],
  };

  it("parses each kind's intent against that kind", () => {
    expect(blockKindSchema.options).toEqual(["core_block", "firm_week", "shape_week"]);
    expect(parseBlockIntent("core_block", core)).toEqual(core);
    expect(parseBlockIntent("core_block", { core: {} })).toEqual({ core: {}, rotations: [] });
    expect(parseBlockIntent("shape_week", { volumeTarget: "~4h easy", keySessions: ["Long run"] })).toEqual({
      volumeTarget: "~4h easy",
      keySessions: ["Long run"],
    });
    expect(parseBlockIntent("firm_week", {})).toEqual({});
  });

  it("refuses an intent that belongs to another kind, or a malformed one", () => {
    expect(() => parseBlockIntent("firm_week", core)).toThrow();
    expect(() => parseBlockIntent("core_block", { volumeTarget: "x", keySessions: [] })).toThrow();
    expect(() => parseBlockIntent("core_block", { core: { squat: "" } })).toThrow();
    expect(() => parseBlockIntent("core_block", { ...core, rotations: [{ ...core.rotations[0], date: "2026-13-01" }] })).toThrow();
    expect(blockIntentSchema.safeParse(null).success).toBe(false);
  });

  it("accepts any kind's intent through the union", () => {
    for (const intent of [core, { volumeTarget: "v", keySessions: [] }, {}]) {
      expect(blockIntentSchema.safeParse(intent).success, JSON.stringify(intent)).toBe(true);
    }
  });
});
