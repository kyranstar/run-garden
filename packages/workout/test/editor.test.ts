/** The document editor (Stage 2 spec §7, §8): every action, placement for every purpose, swap dose conversion, history. */
import { describe, expect, it } from "vitest";
import { PART_PURPOSES, workoutDocSchema, type WorkoutDoc, type WorkoutItem } from "@rg/domain";
import { EXERCISES, PURPOSES, type ExerciseRecord } from "@rg/exercise-library";
import { edit, tryEdit, newDoc, placementFor, redo, toProposable, undo, defaultDose, startEditing, type EditAction, type EditorState } from "../src/index.js";

const byId = new Map(EXERCISES.map((e) => [e.id, e]));
const rec = (id: string): ExerciseRecord => {
  const r = byId.get(id);
  if (!r) throw new Error(`no record ${id}`);
  return r;
};
const fake = (over: Partial<ExerciseRecord>): ExerciseRecord => ({ ...EXERCISES[0]!, contraction: ["isotonic"], ...over }) as ExerciseRecord;
const withPurposes = (...purposes: ExerciseRecord["purposes"][number][]) => fake({ purposes });
const lib = EXERCISES;
const ex = (libraryId: string, dose: WorkoutItem extends infer T ? Record<string, unknown> : never = { sets: 2, reps: 8 }): WorkoutItem => ({ kind: "exercise", libraryId, dose }) as WorkoutItem;
const meta = { title: "Hips and posture", source: { kind: "studio" as const } };
const fresh = (kind: "blank" | "structured" = "structured"): EditorState => startEditing(newDoc(kind, meta));
const run = (s: EditorState, ...actions: EditAction[]): EditorState => actions.reduce((st, a) => edit(st, a, lib), s);
const purposes = (s: EditorState) => s.doc.parts.map((p) => p.purpose);

/** A record of each dose type, and a time-only and reps-only move. */
const ofType = (t: string) => EXERCISES.find((e) => e.dose.type === t && e.laterality === "bilateral") ?? EXERCISES.find((e) => e.dose.type === t)!;

describe("newDoc", () => {
  it("a blank doc has no parts; a structured one starts warm-up, main, cool-down, empty", () => {
    expect(newDoc("blank", meta).parts).toEqual([]);
    const d = newDoc("structured", meta);
    expect(d.parts.map((p) => [p.purpose, p.items.length])).toEqual([["warmup", 0], ["main", 0], ["cooldown", 0]]);
    expect(d.source).toEqual({ kind: "studio" });
    expect(d.title).toBe("Hips and posture");
  });
  it("is a doc that is valid once an item is in it", () => {
    const s = run(fresh(), { type: "addItem", item: ex("gobletSquat") });
    expect(toProposable(s.doc)).not.toBeNull();
  });
});

describe("placementFor (spec §7)", () => {
  const cases: [string, string][] = [
    ["warmup", "warmup"], ["activation", "activation"], ["strength", "main"], ["power", "power"], ["balance", "accessory"],
    ["mobility", "cooldown"], ["stretch", "cooldown"], ["recovery", "cooldown"], ["cooldown", "cooldown"], ["condition-care", "care"], ["conditioning", "conditioning"],
  ];
  it.each(cases)("%s -> %s", (purpose, part) => {
    expect(placementFor(withPurposes(purpose as never))).toBe(part);
  });
  it("covers every library purpose, and lands only in real parts", () => {
    for (const p of PURPOSES) expect(PART_PURPOSES).toContain(placementFor(withPurposes(p)));
  });
  it("several purposes: activation, strength, power, conditioning, balance, warmup, condition-care, mobility, stretch, recovery", () => {
    const order = ["activation", "strength", "power", "conditioning", "balance", "warmup", "condition-care", "mobility", "stretch", "recovery"] as const;
    for (let i = 0; i < order.length - 1; i++) {
      const later = order.slice(i + 1);
      expect(placementFor(withPurposes(...later, order[i]!))).toBe(placementFor(withPurposes(order[i]!)));
    }
  });
  it("a passive-contraction move is a cool-down move, unless it is condition care", () => {
    expect(placementFor(fake({ purposes: ["warmup"], contraction: ["passive"] }))).toBe("cooldown");
    expect(placementFor(fake({ purposes: ["strength"], contraction: ["isotonic", "passive"] }))).toBe("cooldown");
    expect(placementFor(fake({ purposes: ["condition-care"], contraction: ["passive"] }))).toBe("care");
  });
  it("every library record lands in a real part", () => {
    for (const e of EXERCISES) expect(PART_PURPOSES).toContain(placementFor(e));
  });
});

describe("addItem", () => {
  it("with no part, the item lands in the part its purpose belongs to, creating it in order", () => {
    const strength = EXERCISES.find((e) => placementFor(e) === "main")!;
    const power = EXERCISES.find((e) => placementFor(e) === "power")!;
    const care = EXERCISES.find((e) => placementFor(e) === "care")!;
    let s = run(fresh(), { type: "addItem", item: ex(strength.id) });
    expect(s.doc.parts[1]!.items).toHaveLength(1);
    s = run(s, { type: "addItem", item: ex(power.id) });
    expect(purposes(s)).toEqual(["warmup", "power", "main", "cooldown"]);
    s = run(s, { type: "addItem", item: ex(care.id) });
    expect(purposes(s)).toEqual(["warmup", "power", "main", "care", "cooldown"]);
    expect(s.doc.parts[3]!.items).toHaveLength(1);
  });
  it("a second move of the same purpose joins the same part", () => {
    const a = EXERCISES.filter((e) => placementFor(e) === "main");
    const s = run(fresh("blank"), { type: "addItem", item: ex(a[0]!.id) }, { type: "addItem", item: ex(a[1]!.id) });
    expect(s.doc.parts).toHaveLength(1);
    expect(s.doc.parts[0]!.items).toHaveLength(2);
  });
  it("resolves a legacy id", () => {
    const e = fake({ id: "renamedMove", legacyIds: ["oldMove"], purposes: ["power"] });
    const s = edit(fresh("blank"), { type: "addItem", item: ex("oldMove") }, [e]);
    expect(purposes(s)).toEqual(["power"]);
  });
  it("an explicit part wins; a bad part is a no-op", () => {
    const s = run(fresh(), { type: "addItem", item: ex("x"), part: 0 });
    expect(s.doc.parts[0]!.items).toHaveLength(1);
    const same = edit(s, { type: "addItem", item: ex("x"), part: 9 }, lib);
    expect(same).toBe(s);
  });
  it("a run goes in a run part; an unknown id and a free exercise go in main; a rest joins the last part", () => {
    let s = run(fresh("blank"), { type: "addItem", item: { kind: "run", target: { durationSec: 600 }, effort: "easy" } });
    expect(purposes(s)).toEqual(["run"]);
    s = run(s, { type: "addItem", item: { kind: "free_exercise", name: "Plank", dose: { holdSec: 30 } } });
    expect(purposes(s)).toEqual(["main", "run"]);
    s = run(s, { type: "addItem", item: { kind: "rest", seconds: 30 } });
    expect(s.doc.parts[1]!.items).toHaveLength(2);
  });
  it("stops at 60 items and 20 parts", () => {
    let s = run(fresh("blank"), { type: "addPart", purpose: "main" });
    for (let i = 0; i < 60; i++) s = run(s, { type: "addItem", item: ex("a"), part: 0 });
    expect(s.doc.parts[0]!.items).toHaveLength(60);
    expect(edit(s, { type: "addItem", item: ex("a"), part: 0 }, lib)).toBe(s);
    let t = fresh("blank");
    for (let i = 0; i < 25; i++) t = run(t, { type: "addPart", purpose: "main", at: 0 });
    expect(t.doc.parts).toHaveLength(20);
  });
});

describe("parts", () => {
  it("addPart puts a part in canonical order, or at an index", () => {
    let s = run(fresh(), { type: "addPart", purpose: "activation" });
    expect(purposes(s)).toEqual(["warmup", "activation", "main", "cooldown"]);
    s = run(s, { type: "addPart", purpose: "accessory" });
    expect(purposes(s)).toEqual(["warmup", "activation", "main", "accessory", "cooldown"]);
    s = run(s, { type: "addPart", purpose: "arrive", at: 5 });
    expect(purposes(s).at(-1)).toBe("arrive");
    s = run(s, { type: "addPart", purpose: "arrive", at: -4 });
    expect(purposes(s)[0]).toBe("arrive");
  });
  it("removePart and movePart", () => {
    let s = run(fresh(), { type: "removePart", part: 1 });
    expect(purposes(s)).toEqual(["warmup", "cooldown"]);
    s = run(fresh(), { type: "movePart", part: 0, to: 2 });
    expect(purposes(s)).toEqual(["main", "cooldown", "warmup"]);
    s = run(s, { type: "movePart", part: 2, to: -3 });
    expect(purposes(s)).toEqual(["warmup", "main", "cooldown"]);
    const base = fresh();
    expect(edit(base, { type: "removePart", part: 7 }, lib)).toBe(base);
    expect(edit(base, { type: "movePart", part: 7, to: 0 }, lib)).toBe(base);
    expect(edit(base, { type: "movePart", part: 1, to: 1 }, lib)).toBe(base);
  });
  it("setPart changes format, rounds and why, never the items; a bad value is a no-op", () => {
    let s = run(fresh(), { type: "addItem", item: ex("a"), part: 1 }, { type: "setPart", part: 1, patch: { format: "superset", rounds: 3, why: "Heavier hinge." } });
    expect(s.doc.parts[1]).toMatchObject({ format: "superset", rounds: 3, why: "Heavier hinge.", items: [{ libraryId: "a" }] });
    const before = s;
    s = run(s, { type: "setPart", part: 1, patch: { rounds: 99 } });
    expect(s).toBe(before);
    expect(edit(s, { type: "setPart", part: 8, patch: { rounds: 2 } }, lib)).toBe(s);
    const empty = run(fresh(), { type: "setPart", part: 1, patch: { format: "circuit" } });
    expect(empty.doc.parts[1]!.format).toBe("circuit");
  });
});

describe("items", () => {
  const two = () => run(fresh(), { type: "addItem", item: ex("a"), part: 1 }, { type: "addItem", item: ex("b"), part: 1 }, { type: "addItem", item: ex("c"), part: 0 });
  it("removeItem may leave an empty part (a draft); toProposable drops it", () => {
    let s = run(two(), { type: "removeItem", part: 0, item: 0 });
    expect(s.doc.parts[0]!.items).toEqual([]);
    expect(toProposable(s.doc)!.parts.map((p) => p.purpose)).toEqual(["main"]);
    const same = edit(s, { type: "removeItem", part: 0, item: 3 }, lib);
    expect(same).toBe(s);
    s = run(s, { type: "removeItem", part: 1, item: 1 });
    expect(s.doc.parts[1]!.items.map((i) => (i as { libraryId: string }).libraryId)).toEqual(["a"]);
  });
  it("moveItem within a part and across parts", () => {
    const ids = (s: EditorState, p: number) => s.doc.parts[p]!.items.map((i) => (i as { libraryId: string }).libraryId);
    let s = run(two(), { type: "moveItem", from: [1, 0], to: [1, 1] });
    expect(ids(s, 1)).toEqual(["b", "a"]);
    s = run(s, { type: "moveItem", from: [1, 1], to: [0, 0] });
    expect(ids(s, 0)).toEqual(["a", "c"]);
    expect(ids(s, 1)).toEqual(["b"]);
    s = run(s, { type: "moveItem", from: [0, 0], to: [2, 99] });
    expect(ids(s, 2)).toEqual(["a"]);
    s = run(s, { type: "moveItem", from: [2, 0], to: [1, 0] }, { type: "moveItem", from: [0, 0], to: [1, -1] });
    expect(ids(s, 1)).toEqual(["c", "a", "b"]);
    expect(edit(s, { type: "moveItem", from: [0, 9], to: [1, 0] }, lib)).toBe(s);
    expect(edit(s, { type: "moveItem", from: [0, 0], to: [9, 0] }, lib)).toBe(s);
  });
  it("setDose replaces the dose; an invalid dose is a no-op; rests have no dose", () => {
    let s = run(two(), { type: "setDose", part: 1, item: 0, dose: { sets: 3, reps: { min: 6, max: 8 }, load: { typed: "25 lb", kg: 11.3 }, tempo: { eccentricSec: 3 }, max: true } });
    expect(s.doc.parts[1]!.items[0]).toMatchObject({ dose: { sets: 3, reps: { min: 6, max: 8 }, load: { typed: "25 lb", kg: 11.3 } } });
    s = run(s, { type: "setDose", part: 1, item: 0, dose: { load: "bodyweight", holdSec: 20 } });
    expect(s.doc.parts[1]!.items[0]).toMatchObject({ dose: { load: "bodyweight", holdSec: 20 } });
    expect(edit(s, { type: "setDose", part: 1, item: 0, dose: { sets: 99 } }, lib)).toBe(s);
    expect(edit(s, { type: "setDose", part: 1, item: 0, dose: { reps: { min: 9, max: 2 } } }, lib)).toBe(s);
    const withRest = run(s, { type: "addItem", item: { kind: "rest", seconds: 30 }, part: 1 });
    expect(edit(withRest, { type: "setDose", part: 1, item: 2, dose: { sets: 2 } }, lib)).toBe(withRest);
  });
  it("setCue sets, trims, clamps to 160 and clears", () => {
    let s = run(two(), { type: "setCue", part: 1, item: 0, cue: "  Slow down.  " });
    expect(s.doc.parts[1]!.items[0]).toMatchObject({ cue: "Slow down." });
    s = run(s, { type: "setCue", part: 1, item: 0, cue: "x".repeat(300) });
    expect((s.doc.parts[1]!.items[0] as { cue: string }).cue).toHaveLength(160);
    s = run(s, { type: "setCue", part: 1, item: 0, cue: undefined });
    expect(s.doc.parts[1]!.items[0]).not.toHaveProperty("cue");
    s = run(s, { type: "setCue", part: 1, item: 0, cue: "Hi" }, { type: "setCue", part: 1, item: 0, cue: "   " });
    expect(s.doc.parts[1]!.items[0]).not.toHaveProperty("cue");
    const withRest = run(s, { type: "addItem", item: { kind: "rest", seconds: 30 }, part: 1 });
    expect(edit(withRest, { type: "setCue", part: 1, item: 2, cue: "x" }, lib)).toBe(withRest);
  });
});

describe("swapItem", () => {
  const timeRec = ofType("time");
  const repsRec = ofType("reps");
  it("keeps the dose (and cue) when the new record's dose type matches", () => {
    const other = EXERCISES.find((e) => e.dose.type === "reps" && e.id !== repsRec.id)!;
    const dose = { sets: 4, reps: 5, load: { typed: "20 lb", kg: 9 }, restSec: 90 };
    let s = run(fresh(), { type: "addItem", item: { ...ex(repsRec.id, dose), cue: "Brace." } as WorkoutItem, part: 1 });
    s = run(s, { type: "swapItem", part: 1, item: 0, libraryId: other.id });
    expect(s.doc.parts[1]!.items[0]).toEqual({ kind: "exercise", libraryId: other.id, dose, cue: "Brace." });
  });
  it("converts reps to a hold with the new record's default dose, never leaving reps on a time-only move", () => {
    let s = run(fresh(), { type: "addItem", item: ex(repsRec.id, { sets: 4, reps: 5 }), part: 1 });
    s = run(s, { type: "swapItem", part: 1, item: 0, libraryId: timeRec.id });
    const it = s.doc.parts[1]!.items[0] as { libraryId: string; dose: Record<string, unknown> };
    expect(it.libraryId).toBe(timeRec.id);
    expect(it.dose).toEqual(defaultDose(timeRec));
    expect(it.dose.reps).toBeUndefined();
    expect(it.dose.holdSec).toBeDefined();
  });
  it("converts a hold to reps", () => {
    let s = run(fresh(), { type: "addItem", item: ex(timeRec.id, { sets: 2, holdSec: 30 }), part: 1 });
    s = run(s, { type: "swapItem", part: 1, item: 0, libraryId: repsRec.id });
    const dose = (s.doc.parts[1]!.items[0] as { dose: Record<string, unknown> }).dose;
    expect(dose).toEqual(defaultDose(repsRec));
    expect(dose.holdSec).toBeUndefined();
  });
  it("a carry is held for time: swapping a hold onto a carry keeps it, swapping reps onto one makes a timed carry", () => {
    const carry = ofType("carry");
    let s = run(fresh(), { type: "addItem", item: ex(timeRec.id, { sets: 2, holdSec: 40 }), part: 1 });
    s = run(s, { type: "swapItem", part: 1, item: 0, libraryId: carry.id });
    expect((s.doc.parts[1]!.items[0] as { dose: unknown }).dose).toEqual({ sets: 2, holdSec: 40 });
    s = run(fresh(), { type: "addItem", item: ex(repsRec.id, { sets: 3, reps: 8 }), part: 1 });
    s = run(s, { type: "swapItem", part: 1, item: 0, libraryId: carry.id });
    const dose = (s.doc.parts[1]!.items[0] as { dose: Record<string, unknown> }).dose;
    expect(dose).toEqual(defaultDose(carry));
    expect(dose.holdSec).toBeDefined();
    expect(dose.carryM).toBeUndefined();
  });
  it("a distance a source stated stays a distance on a carry", () => {
    const carry = ofType("carry");
    let s = run(fresh(), { type: "addItem", item: ex(carry.id, { sets: 2, carryM: 40 }), part: 1 });
    const other = EXERCISES.find((e) => e.dose.type === "carry" && e.id !== carry.id)!;
    s = run(s, { type: "swapItem", part: 1, item: 0, libraryId: other.id });
    expect((s.doc.parts[1]!.items[0] as { dose: unknown }).dose).toEqual({ sets: 2, carryM: 40 });
  });
  it("an empty dose converts too; a legacy target id resolves to the canonical id", () => {
    const legacy = fake({ id: "renamedMove", legacyIds: ["oldMove"], dose: { type: "reps", range: [6, 10] } });
    let s = run(fresh(), { type: "addItem", item: ex("zzz", {}), part: 1 });
    s = edit(s, { type: "swapItem", part: 1, item: 0, libraryId: "oldMove" }, [legacy]);
    expect(s.doc.parts[1]!.items[0]).toMatchObject({ libraryId: legacy.id, dose: defaultDose(legacy) });
  });
  it("an unknown record or a non-library item is a no-op", () => {
    const s = run(fresh(), { type: "addItem", item: ex(repsRec.id), part: 1 }, { type: "addItem", item: { kind: "free_exercise", name: "Plank", dose: { holdSec: 30 } }, part: 1 });
    expect(edit(s, { type: "swapItem", part: 1, item: 0, libraryId: "nope" }, lib)).toBe(s);
    expect(edit(s, { type: "swapItem", part: 1, item: 1, libraryId: repsRec.id }, lib)).toBe(s);
  });
});

describe("defaultDose", () => {
  it("uses the record's sets, the middle of its range, its rest", () => {
    const r = fake({ dose: { type: "reps", range: [8, 12], sets: [2, 4], restSec: 60 }, laterality: "bilateral" });
    expect(defaultDose(r)).toEqual({ sets: 2, reps: 10, restSec: 60 });
    expect(defaultDose(fake({ dose: { type: "time", range: [20, 40] }, laterality: "bilateral" }))).toEqual({ holdSec: 30 });
    expect(defaultDose(fake({ dose: { type: "breaths", range: [5, 10] }, laterality: "bilateral" }))).toEqual({ breaths: 8 });
    // A library carry's range is seconds: its default is a timed carry, never a distance (cross-task ruling, S2 T4 fix 1).
    expect(defaultDose(fake({ dose: { type: "carry", range: [20, 30] }, laterality: "bilateral" }))).toEqual({ holdSec: 25 });
    expect(defaultDose(fake({ dose: { type: "reps", range: [6, 6] }, laterality: "unilateral" as never }))).toEqual({ reps: 6, perSide: true });
  });
  it("every record's default dose parses", () => {
    for (const e of EXERCISES) expect(workoutDocSchema.shape.parts.element.shape.items.element.safeParse({ kind: "exercise", libraryId: e.id, dose: defaultDose(e) }).success).toBe(true);
  });
});

describe("title and intent", () => {
  it("sets and clamps the title; an empty one is ignored", () => {
    let s = run(fresh(), { type: "setTitle", title: "  New name " });
    expect(s.doc.title).toBe("New name");
    s = run(s, { type: "setTitle", title: "y".repeat(200) });
    expect(s.doc.title).toHaveLength(80);
    const before = s;
    expect(edit(s, { type: "setTitle", title: "   " }, lib)).toBe(before);
  });
  it("merges intent; an invalid intent is a no-op", () => {
    let s = run(fresh(), { type: "setIntent", intent: { effort: "develop", goals: ["posture", "ski"], summary: "Open the hips." } });
    expect(s.doc.intent).toMatchObject({ effort: "develop", goals: ["posture", "ski"], summary: "Open the hips.", focus: [] });
    s = run(s, { type: "setIntent", intent: { focus: ["hips"] } });
    expect(s.doc.intent).toMatchObject({ effort: "develop", focus: ["hips"] });
    expect(edit(s, { type: "setIntent", intent: { summary: "" } }, lib)).toBe(s);
    expect(edit(s, { type: "setIntent", intent: { effort: "extreme" as never } }, lib)).toBe(s);
  });
});

describe("history", () => {
  it("undo and redo walk the edits; a new edit clears redo", () => {
    let s = run(fresh(), { type: "setTitle", title: "One" }, { type: "setTitle", title: "Two" });
    expect(s.past).toHaveLength(2);
    s = undo(s);
    expect(s.doc.title).toBe("One");
    s = undo(s);
    expect(s.doc.title).toBe("Hips and posture");
    expect(undo(s)).toBe(s);
    s = redo(s);
    expect(s.doc.title).toBe("One");
    s = redo(s);
    expect(s.doc.title).toBe("Two");
    expect(redo(s)).toBe(s);
    s = undo(s);
    s = run(s, { type: "setTitle", title: "Three" });
    expect(s.future).toEqual([]);
    expect(redo(s)).toBe(s);
  });
  it("keeps the last 20 edits", () => {
    let s = fresh();
    for (let i = 0; i < 30; i++) s = run(s, { type: "setTitle", title: `T${i}` });
    expect(s.past).toHaveLength(20);
    expect(s.past[0]!.title).toBe("T9");
    for (let i = 0; i < 25; i++) s = undo(s);
    expect(s.doc.title).toBe("T9");
    expect(s.future).toHaveLength(20);
    for (let i = 0; i < 25; i++) s = redo(s);
    expect(s.doc.title).toBe("T29");
    expect(s.past).toHaveLength(20);
  });
  it("an action that changes nothing adds no history", () => {
    const s = run(fresh(), { type: "setTitle", title: "Same" });
    expect(edit(s, { type: "setTitle", title: "Same" }, lib)).toBe(s);
  });
  it("does not mutate the earlier document", () => {
    const a = fresh();
    const snapshot = JSON.stringify(a.doc);
    run(a, { type: "addItem", item: ex("x"), part: 0 }, { type: "setPart", part: 0, patch: { rounds: 2 } }, { type: "moveItem", from: [0, 0], to: [1, 0] });
    expect(JSON.stringify(a.doc)).toBe(snapshot);
  });
});

describe("toProposable", () => {
  it("null when nothing is left; otherwise the schema-valid doc without empty parts", () => {
    expect(toProposable(newDoc("structured", meta))).toBeNull();
    expect(toProposable(newDoc("blank", meta))).toBeNull();
    const s = run(fresh(), { type: "addItem", item: ex("gobletSquat"), part: 1 });
    const d = toProposable(s.doc) as WorkoutDoc;
    expect(d.parts).toHaveLength(1);
    expect(workoutDocSchema.safeParse(d).success).toBe(true);
  });
  it("null when the draft still fails the schema", () => {
    const s = run(fresh(), { type: "addItem", item: ex("a", { sets: 99 }), part: 1 });
    expect(toProposable(s.doc)).toBeNull();
  });
});

describe("a long editing session stays schema-valid apart from empty parts", () => {
  it("every state's non-empty parts validate", () => {
    const main = EXERCISES.filter((e) => placementFor(e) === "main").slice(0, 3);
    let s = fresh();
    const steps: EditAction[] = [
      { type: "addItem", item: itemOf(main[0]!) }, { type: "addItem", item: itemOf(main[1]!) }, { type: "addPart", purpose: "activation" },
      { type: "swapItem", part: 2, item: 0, libraryId: main[2]!.id }, { type: "moveItem", from: [2, 1], to: [1, 0] }, { type: "setCue", part: 2, item: 0, cue: "Slow." },
      { type: "setPart", part: 2, patch: { format: "superset", rounds: 3 } }, { type: "movePart", part: 0, to: 3 }, { type: "removeItem", part: 1, item: 0 },
    ];
    for (const a of steps) {
      s = edit(s, a, lib);
      const parts = s.doc.parts.filter((p) => p.items.length);
      if (parts.length) expect(workoutDocSchema.safeParse({ ...s.doc, parts }).success).toBe(true);
    }
  });
});
describe("tryEdit says why nothing happened", () => {
  const rej = (s: EditorState, a: EditAction) => tryEdit(s, a, lib);
  it("accepted: no reason, new state", () => {
    const r = rej(fresh(), { type: "setTitle", title: "Fresh" });
    expect(r.rejected).toBeUndefined();
    expect(r.state.doc.title).toBe("Fresh");
  });
  it("unchanged", () => {
    const s = fresh();
    expect(rej(s, { type: "setTitle", title: "Hips and posture" })).toEqual({ state: s, rejected: "unchanged" });
  });
  it("missing: a part, item or record that is not there", () => {
    const s = run(fresh(), { type: "addItem", item: ex("a"), part: 1 });
    for (const a of [
      { type: "removePart", part: 9 }, { type: "movePart", part: 9, to: 0 }, { type: "setPart", part: 9, patch: {} }, { type: "addItem", item: ex("a"), part: 9 },
      { type: "removeItem", part: 1, item: 9 }, { type: "moveItem", from: [1, 9], to: [0, 0] }, { type: "setDose", part: 9, item: 0, dose: {} },
      { type: "swapItem", part: 1, item: 0, libraryId: "nope" }, { type: "setCue", part: 1, item: 9, cue: "x" },
    ] as EditAction[]) {
      const r = rej(s, a);
      expect(r.rejected, a.type).toBe("missing");
      expect(r.state).toBe(s);
    }
  });
  it("invalid: breaks the schema", () => {
    const s = run(fresh(), { type: "addItem", item: ex("a"), part: 1 }, { type: "addItem", item: { kind: "rest", seconds: 5 }, part: 1 });
    expect(rej(s, { type: "setTitle", title: " " }).rejected).toBe("invalid");
    expect(rej(s, { type: "setIntent", intent: { summary: "" } }).rejected).toBe("invalid");
    expect(rej(s, { type: "setDose", part: 1, item: 0, dose: { sets: 99 } }).rejected).toBe("invalid");
    expect(rej(s, { type: "setDose", part: 1, item: 1, dose: { sets: 2 } }).rejected).toBe("invalid");
    expect(rej(s, { type: "setPart", part: 1, patch: { rounds: 99 } }).rejected).toBe("invalid");
    expect(rej(s, { type: "addItem", item: { kind: "rest", seconds: 0 } as never, part: 1 }).rejected).toBe("invalid");
    expect(rej(s, { type: "setCue", part: 1, item: 1, cue: "x" }).rejected).toBe("invalid");
    expect(rej(s, { type: "addPart", purpose: "nope" as never }).rejected).toBe("invalid");
  });
  it("full: 20 parts, 60 items", () => {
    let s = fresh("blank");
    for (let i = 0; i < 20; i++) s = run(s, { type: "addPart", purpose: "main", at: 0 });
    expect(rej(s, { type: "addPart", purpose: "main" }).rejected).toBe("full");
    expect(rej(s, { type: "addItem", item: { kind: "run", target: { open: true }, effort: "easy" } }).rejected).toBe("full");
    for (let i = 0; i < 60; i++) s = run(s, { type: "addItem", item: ex("a"), part: 0 });
    expect(rej(s, { type: "addItem", item: ex("a"), part: 0 }).rejected).toBe("full");
    s = run(s, { type: "addItem", item: ex("b"), part: 1 });
    expect(rej(s, { type: "moveItem", from: [1, 0], to: [0, 0] }).rejected).toBe("full");
  });
  it("edit is tryEdit's state", () => {
    const s = fresh();
    expect(edit(s, { type: "removePart", part: 9 }, lib)).toBe(s);
  });
});

describe("hardening", () => {
  it("newDoc with an empty or blank title falls back and trims like setTitle", () => {
    expect(newDoc("blank", { ...meta, title: "" }).title).toBe("New workout");
    expect(newDoc("blank", { ...meta, title: "   " }).title).toBe("New workout");
    expect(newDoc("blank", { ...meta, title: "  Padded " }).title).toBe("Padded");
    expect(newDoc("blank", { ...meta, title: "" }).intent.summary).toBe("New workout");
    expect(newDoc("blank", { ...meta, title: "z".repeat(200) }).title).toHaveLength(80);
  });
  it("setIntent stores the parsed data (unknown keys stripped)", () => {
    const s = run(fresh(), { type: "setIntent", intent: { effort: "develop", junk: 1 } as never });
    expect(s.doc.intent).not.toHaveProperty("junk");
  });
  it("setCue keeps the item schema-valid", () => {
    const s = run(fresh(), { type: "addItem", item: { kind: "free_exercise", name: "Plank", dose: { holdSec: 30 } }, part: 1 });
    expect(edit(s, { type: "setCue", part: 1, item: 0, cue: "ok" }, lib).doc.parts[1]!.items[0]).toMatchObject({ cue: "ok" });
  });
  it("an edit never produces an invalid item, even from a stored doc that already had one", () => {
    const bad = { ...newDoc("blank", meta), parts: [{ purpose: "main", format: "straight", items: [ex("a", { sets: 99 })] }] } as WorkoutDoc;
    const s = startEditing(bad);
    expect(tryEdit(s, { type: "setCue", part: 0, item: 0, cue: "ok" }, lib)).toEqual({ state: s, rejected: "invalid" });
  });
  it("a draft cannot stand in for a WorkoutDoc, but a stored doc can be opened", () => {
    const d = newDoc("blank", meta);
    const plain: WorkoutDoc = { ...d, parts: [{ purpose: "main", format: "straight", items: [{ kind: "rest", seconds: 5 }] }] };
    // @ts-expect-error a plain WorkoutDoc is not a draft
    toProposable(plain);
    expect(startEditing(plain).doc.parts).toHaveLength(1);
  });
});

function itemOf(e: ExerciseRecord): WorkoutItem {
  return { kind: "exercise", libraryId: e.id, dose: defaultDose(e) };
}
