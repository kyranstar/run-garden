import { describe, expect, it } from "vitest";
import {
  RUN_EFFORTS,
  PART_FORMATS,
  workoutDocSchema,
  parseStoredWorkoutDoc,
  type WorkoutDoc,
} from "../src/index.js";

const valid = (): WorkoutDoc => ({
  version: 1,
  title: "Hips and a short run",
  intent: { summary: "Open the hips, then an easy run.", goals: ["mobility", "aerobic-base"], focus: ["hip"], effort: "maintain", objectiveIds: ["obj-1"] },
  setting: { placeId: "home", equipment: ["band"], targetMinutes: 40 },
  basedOn: { kind: "template", id: "t-1", rev: 2 },
  parts: [
    {
      purpose: "warmup", why: "Wake the hips.", format: "flow",
      items: [
        { kind: "exercise", libraryId: "hip-circle", dose: { sets: 2, reps: { min: 8, max: 10 }, perSide: true, tempo: { eccentricSec: 3 }, load: "bodyweight", restSec: 30 }, cue: "Slow.", alternates: [{ libraryId: "x", why: "No band" }], test: { keyResultId: "kr-1" }, side: "left", why: "w", progression: "p" },
        { kind: "exercise", libraryId: "plank", dose: { holdSec: 30, max: true } },
        { kind: "free_exercise", name: "Odd move", dose: { reps: 5 }, cue: "c", coros: { key: "k" } },
        { kind: "rest", seconds: 20 },
      ],
    },
    {
      purpose: "run", format: "holds",
      items: [
        { kind: "run", effort: "by_feel", target: { distanceM: 4800, typed: "3 mi", pace: { fastSecPerKm: 330, slowSecPerKm: 360 }, hr: { low: 120, high: 140 }, zone: { kind: "pace", index: 2 } }, cue: "Relax" },
        { kind: "run", effort: "hills", target: { open: true } },
      ],
    },
  ],
  source: { kind: "coach", ref: "r" },
  notes: "n",
});

describe("workoutDocSchema", () => {
  it("parses a full valid document", () => {
    expect(workoutDocSchema.safeParse(valid()).success).toBe(true);
  });
  it("has the amended vocabularies", () => {
    expect(RUN_EFFORTS).toEqual(["easy", "recovery", "steady", "long", "tempo", "threshold", "interval", "hills", "strides", "race", "by_feel"]);
    expect(PART_FORMATS).toContain("holds");
  });
  const bad: Array<[string, (d: any) => void]> = [
    ["no parts", (d) => { d.parts = []; }],
    ["empty part", (d) => { d.parts[0].items = []; }],
    ["run with no duration, distance or open", (d) => { d.parts[1].items[0].target = { typed: "3 mi" }; }],
    ["unknown purpose", (d) => { d.parts[0].purpose = "nap"; }],
    ["title too long", (d) => { d.title = "x".repeat(81); }],
    ["version 2", (d) => { d.version = 2; }],
    ["old effort 'rest'", (d) => { d.parts[1].items[0].effort = "rest"; }],
    ["4 alternates", (d) => { d.parts[0].items[0].alternates = [1, 2, 3, 4].map((i) => ({ libraryId: `a${i}` })); }],
    ["long cue", (d) => { d.parts[0].items[0].cue = "x".repeat(161); }],
    ["dose.max false", (d) => { d.parts[0].items[1].dose.max = false; }],
    ["zone index 7", (d) => { d.parts[1].items[0].target.zone.index = 7; }],
    ["21 equipment", (d) => { d.setting.equipment = Array.from({ length: 21 }, (_, i) => `e${i}`); }],
    ["reps min > max", (d) => { d.parts[0].items[0].dose.reps = { min: 10, max: 8 }; }],
    ["reps range over 200", (d) => { d.parts[0].items[0].dose.reps = { min: 5, max: 201 }; }],
    ["fractional reps range", (d) => { d.parts[0].items[0].dose.reps = { min: 5.5, max: 8 }; }],
    ["pace fast > slow", (d) => { d.parts[1].items[0].target.pace = { fastSecPerKm: 400, slowSecPerKm: 300 }; }],
    ["pace under 120", (d) => { d.parts[1].items[0].target.pace = { fastSecPerKm: 60, slowSecPerKm: 300 }; }],
    ["pace over 1800", (d) => { d.parts[1].items[0].target.pace = { fastSecPerKm: 300, slowSecPerKm: 2000 }; }],
    ["pace infinite", (d) => { d.parts[1].items[0].target.pace = { fastSecPerKm: 300, slowSecPerKm: Infinity }; }],
    ["hr low > high", (d) => { d.parts[1].items[0].target.hr = { low: 150, high: 120 }; }],
    ["hr under 30", (d) => { d.parts[1].items[0].target.hr = { low: 20, high: 120 }; }],
    ["hr over 230", (d) => { d.parts[1].items[0].target.hr = { low: 120, high: 300 }; }],
    ["hr fractional", (d) => { d.parts[1].items[0].target.hr = { low: 120.5, high: 140 }; }],
    ["open false", (d) => { d.parts[1].items[1].target = { open: false }; }],
    ["open false beside a duration", (d) => { d.parts[1].items[1].target = { open: false, durationSec: 60 }; }],
    ["unknown basedOn kind", (d) => { d.basedOn.kind = "dream"; }],
  ];
  for (const [name, mutate] of bad) {
    it(`rejects ${name}`, () => {
      const d = JSON.parse(JSON.stringify(valid()));
      mutate(d);
      expect(workoutDocSchema.safeParse(d).success).toBe(false);
    });
  }
  for (const [name, target] of [["duration only", { durationSec: 600 }], ["distance only", { distanceM: 1000 }], ["open only", { open: true }]] as const) {
    it(`accepts a run target with ${name}`, () => {
      const d = valid();
      d.parts[1]!.items[1] = { kind: "run", effort: "easy", target: target as any };
      expect(workoutDocSchema.safeParse(d).success).toBe(true);
    });
  }
  it("strips unknown optional keys rather than rejecting", () => {
    const r = workoutDocSchema.safeParse({ ...valid(), future: 1 });
    expect(r.success).toBe(true);
    expect(r.success && "future" in r.data).toBe(false);
  });
});

describe("parseStoredWorkoutDoc", () => {
  it("returns null for null, bad JSON and invalid objects", () => {
    expect(parseStoredWorkoutDoc(null)).toBeNull();
    expect(parseStoredWorkoutDoc("not json")).toBeNull();
    expect(parseStoredWorkoutDoc({})).toBeNull();
  });
  it("returns null for undefined and a number", () => {
    expect(parseStoredWorkoutDoc(undefined)).toBeNull();
    expect(parseStoredWorkoutDoc(42)).toBeNull();
  });
  it("parses a double-encoded string", () => {
    expect(parseStoredWorkoutDoc(JSON.stringify(JSON.stringify(valid())))?.title).toBe("Hips and a short run");
    expect(parseStoredWorkoutDoc(JSON.stringify("not json"))).toBeNull();
  });
  it("strips an unknown key on the object path", () => {
    const r = parseStoredWorkoutDoc({ ...valid(), future: 1 });
    expect(r && "future" in r).toBe(false);
  });
  it("parses a JSON string and an object", () => {
    expect(parseStoredWorkoutDoc(JSON.stringify(valid()))?.title).toBe("Hips and a short run");
    expect(parseStoredWorkoutDoc(valid())?.version).toBe(1);
  });
});
