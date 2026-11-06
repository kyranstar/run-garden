import { describe, expect, it } from "vitest";
import {
  adaptiveConfigSchema,
  blockIntentSchema,
  blockKindSchema,
  courseConfigSchema,
  defaultOnEnd,
  onEndAllowed,
  parseBlockIntent,
  programKindSchema,
  programStatusSchema,
} from "../src/index.js";

describe("programKindSchema / programStatusSchema", () => {
  it("names the five kinds and five statuses of the programs table", () => {
    expect(programKindSchema.options).toEqual(["adaptive", "coros_import", "coach", "studio", "course"]);
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

describe("how a plan ends", () => {
  it.each([
    ["coach", ["run"], "ask"],
    ["coach", ["run", "strength"], "ask"],
    ["coach", ["strength"], "continue"],
    ["adaptive", ["yoga", "strength"], "continue"],
    ["course", ["yoga"], "continue"],
    ["coros_import", ["run"], "ask"],
    ["coros_import", ["strength"], "finish"],
  ] as const)("%s of %j ends by %s", (kind, sports, want) => expect(defaultOnEnd(kind, sports)).toBe(want));

  it("a programme or a course can't ask", () => {
    expect(onEndAllowed("adaptive", "ask")).toBe(false);
    expect(onEndAllowed("course", "ask")).toBe(false);
    expect(onEndAllowed("coach", "ask")).toBe(true);
  });

  it("each kind allows only its own endings", () => {
    expect(onEndAllowed("adaptive", "finish")).toBe(false);
    expect(onEndAllowed("adaptive", "continue")).toBe(true);
    expect(onEndAllowed("course", "finish")).toBe(true);
    expect(onEndAllowed("coros_import", "continue")).toBe(false);
    expect(onEndAllowed("coros_import", "finish")).toBe(true);
    expect(onEndAllowed("studio", "continue")).toBe(false);
  });

  it("a course's config needs a real day and time", () => {
    expect(courseConfigSchema.safeParse({ course: "tre", weekdays: [], time: "19:30" }).success).toBe(false);
    expect(courseConfigSchema.safeParse({ course: "tre", weekdays: [0, 0], time: "19:30" }).success).toBe(false);
    expect(courseConfigSchema.safeParse({ course: "tre", weekdays: [0, 4], time: "25:00" }).success).toBe(false);
    expect(courseConfigSchema.safeParse({ course: "tre", weekdays: [7], time: "19:30" }).success).toBe(false);
    const ok = courseConfigSchema.parse({ course: "tre", weekdays: [0, 4], time: "19:30" });
    expect(ok).toMatchObject({ quietDaysBeforeRace: 7, placementWeeksAhead: 2, easeNext: false });
  });
});
