/**
 * Stage 2 Task 6 — the builder's decisions, pure (spec §8): what the builder judges with, the notes it shows (their
 * place in the draft, their Fix, whether a check would answer them), what blocks Start and Schedule, the summary's
 * numbers, the item sheet's steppers and load, the swap list, the parts on offer, the activation it prompts for, and
 * the "Later today" slot.
 */
import { describe, expect, it } from "vitest";
import type { WorkoutDoc, WorkoutDose } from "@rg/domain";
import { DEFAULT_SCHEDULING_PREFERENCES } from "@rg/domain";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, suggestedItem, type DraftDoc, type EditAction } from "@rg/workout";
import {
  activationAt,
  addablePurposes,
  amountKind,
  areasWorked,
  balanceRows,
  buildCtxOf,
  doseSummary,
  forSchedule,
  judgeDraft,
  laterToday,
  loadFrom,
  moveTarget,
  showsSuggestions,
  sourceOfPath,
  stepAmount,
  stepSets,
  swapOptions,
  typedAmount,
  type BuildCtx,
} from "../src/screens/studio/build-model.js";
import { emptyStudioCtx, type MovePrefs, type StudioCtx } from "../src/screens/studio/model.js";

const TODAY = "2026-10-12";
const rec = (id: string) => EXERCISES.find((r) => r.id === id)!;
const prefs = (over: Partial<MovePrefs> = {}): MovePrefs => ({ rating: null, pinned: false, excluded: false, lastDoneOn: null, timesDone30d: 0, ...over });

const studio = (over: Partial<StudioCtx> = {}): StudioCtx => ({ ...emptyStudioCtx, today: TODAY, ...over });
const tmjCtx = (pre: number | null): StudioCtx =>
  studio({ profiles: [PROFILES.tmj], readings: pre === null ? {} : { tmj: { pre, post: null, feelingOff: false } } });

/** A structured draft, with these edits made. */
function draft(...actions: EditAction[]): DraftDoc {
  let s = startEditing(newDoc("structured", { title: "Test", source: { kind: "studio" } }));
  for (const a of actions) s = edit(s, a, EXERCISES);
  return s.doc;
}
const into = (part: number, id: string, extra: object = {}): EditAction => ({
  type: "addItem",
  part,
  item: { ...suggestedItem(rec(id), "main"), ...extra } as never,
});

describe("where the builder is", () => {
  it("reads its address: a new workout, a template, a planned workout — and nothing else", () => {
    expect(sourceOfPath("/studio/build/new")).toEqual({ kind: "new" });
    expect(sourceOfPath("/studio/build/template/t%201")).toEqual({ kind: "template", id: "t 1" });
    expect(sourceOfPath("/studio/build/workout/w1")).toEqual({ kind: "workout", id: "w1" });
    expect(sourceOfPath("/studio/build/elsewhere")).toBeNull();
    expect(sourceOfPath("/studio/build/workout/")).toBeNull();
  });
});

describe("what the builder judges with", () => {
  it("today's readings, joined by any this page recorded; the athlete's set-aside, pinned and recent moves; the place's gear", () => {
    const ctx = studio({
      profiles: [PROFILES.tmj],
      readings: { tmj: { pre: null, post: null, feelingOff: false } },
      prefs: new Map([
        ["bridge", prefs({ pinned: true, lastDoneOn: "2026-10-10" })],
        ["catCow", prefs({ excluded: true, lastDoneOn: "2026-09-01" })],
      ]),
      place: { name: "Home", equipment: ["mat", "kettlebell"] },
    });
    const bc = buildCtxOf(ctx, TODAY, { tmj: { pre: 2, post: null, feelingOff: false } });
    expect(bc.readings.tmj).toEqual({ pre: 2, post: null, feelingOff: false });
    expect(bc.pinned).toEqual(["bridge"]);
    expect(bc.excluded).toEqual(["catCow"]);
    // Done within the last week gives way to the others; a month ago does not.
    expect(bc.recent).toEqual(["bridge"]);
    expect(bc.equipment).toEqual(["mat", "kettlebell"]);
    expect(buildCtxOf(studio(), TODAY).equipment).toBeNull();
  });

  it("what was done cleanly is the library's one rule — and with a profile that flags a rung, this device can't tell, so it says nothing", () => {
    const known = new Map([["landingStick", prefs({ lastDoneOn: "2026-10-01" })], ["pogoHop", prefs()]]);
    expect([...(buildCtxOf(studio({ prefs: known }), TODAY).done ?? [])]).toEqual(["landingStick"]);
    // TMJ flags a clenched rung, which the library read does not carry: no frontier is claimed.
    expect(buildCtxOf(studio({ prefs: known, profiles: [PROFILES.tmj] }), TODAY).done).toBeUndefined();
    // Before the library read answers, nothing is known either.
    expect(buildCtxOf(studio(), TODAY).done).toBeUndefined();
  });
});

describe("the notes, and what they block", () => {
  it("an empty workout blocks with plain words and has nothing else to say", () => {
    const j = judgeDraft(draft(), buildCtxOf(studio(), TODAY), TODAY);
    expect(j.doc).toBeNull();
    expect(j.derived).toBeNull();
    expect(j.notes).toEqual([]);
    expect(j.blocked).toBe("Add a move first.");
  });

  it("an error sits on the draft's own item (empty parts and all), blocks with its reason, and Fix swaps in the alternate", () => {
    // The warm-up is empty, so the document the validator reads starts at the main part.
    const d = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress", { alternates: [{ libraryId: "floorPress" }] }));
    const j = judgeDraft(d, buildCtxOf(tmjCtx(3), TODAY), TODAY);
    const err = j.notes.find((n) => n.severity === "error")!;
    expect(err.part).toBe(1);
    expect(err.item).toBe(0);
    expect(err.message).toBe("Half-kneeling one-arm press isn't allowed with today's Jaw / head check at 3.");
    expect(err.fix).toEqual({ action: { type: "swapItem", part: 1, item: 0, libraryId: "floorPress" }, label: "Swap in Floor press" });
    expect(err.check).toBeNull();
    expect(j.blocked).toBe(err.message);
    // Errors come first.
    expect(j.notes[0]).toBe(err);
  });

  it("an error today's check could answer asks for the check instead of blocking", () => {
    const d = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress"));
    const j = judgeDraft(d, buildCtxOf(tmjCtx(null), TODAY), TODAY);
    const err = j.notes.find((n) => n.severity === "error")!;
    expect(err.message).toBe("Half-kneeling one-arm press needs today's Jaw / head check answered first.");
    expect(err.check).toBe("tmj");
    expect(j.blocked).toBeNull();
    expect(j.checks).toEqual(["tmj"]);
    // Answered — even calmly — it is the reading's to decide, and a refusal then blocks.
    const answered = judgeDraft(d, buildCtxOf(tmjCtx(3), TODAY), TODAY);
    expect(answered.checks).toEqual([]);
    expect(answered.blocked).toMatch(/isn't allowed with today's Jaw \/ head check at 3/);
  });

  it("a check that could not open it is no answer: the error still blocks", () => {
    // On a maintain day even the calmest reading keeps the press out.
    const d = draft(into(1, "halfKneelingPress"));
    const j = judgeDraft(d, buildCtxOf(tmjCtx(null), TODAY), TODAY);
    expect(j.notes[0]!.severity).toBe("error");
    expect(j.notes[0]!.check).toBeNull();
    expect(j.checks).toEqual([]);
    expect(j.blocked).toBe(j.notes[0]!.message);
  });

  it("a day ahead is judged as one: no check is asked for, the pending rule decides", () => {
    const d = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress"));
    const j = judgeDraft(d, buildCtxOf(tmjCtx(null), TODAY), "2026-10-15");
    expect(j.checks).toEqual([]);
    expect(j.notes[0]!.code).toBe("condition_gate_pending");
  });

  it("a part's format has its own Fix", () => {
    const d = draft(into(1, "gobletSquat"), { type: "setPart", part: 1, patch: { format: "superset" } });
    const j = judgeDraft(d, buildCtxOf(studio(), TODAY), TODAY);
    const err = j.notes.find((n) => n.code === "format_mismatch")!;
    expect(err.part).toBe(1);
    expect(err.item).toBeNull();
    expect(err.fix).toEqual({ action: { type: "setPart", part: 1, patch: { format: "straight" } }, label: "Use straight sets" });
  });

  it("warnings are costs: shown, never blocking", () => {
    const ctx = studio({ prefs: new Map([["gobletSquat", prefs({ excluded: true })]]) });
    const j = judgeDraft(draft(into(1, "gobletSquat")), buildCtxOf(ctx, TODAY), TODAY);
    expect(j.notes.map((n) => [n.code, n.severity])).toEqual([["excluded_by_athlete", "warning"]]);
    expect(j.blocked).toBeNull();
  });
});

describe("the summary", () => {
  it("each balance axis in its own unit, a level beside it, and None where there is none", () => {
    // Measured against each other in time: a rep is about three seconds of work.
    const rows = balanceRows({ isometricSec: 90, isotonicReps: 40, eccentricReps: 0, plyoContacts: 0, aerobicSec: 0, mobilitySec: 30, recoverySec: 0 });
    expect(rows.map((r) => [r.label, r.text, r.level])).toEqual([
      ["Holds", "90 s", 4],
      ["Through range", "40 reps", 5],
      ["Eccentric", "None", 0],
      ["Jumps", "None", 0],
      ["Aerobic", "None", 0],
      ["Mobility", "30 s", 1],
    ]);
    expect(balanceRows({ isometricSec: 0, isotonicReps: 0, eccentricReps: 0, plyoContacts: 12, aerobicSec: 600, mobilitySec: 0, recoverySec: 0 }).map((r) => r.text)).toEqual(
      ["None", "None", "None", "12 landings", "10 min", "None"],
    );
  });

  it("the areas worked, most first", () => {
    const j = judgeDraft(draft(into(1, "deadlift"), into(1, "gobletSquat")), buildCtxOf(studio(), TODAY), TODAY);
    expect(areasWorked(j.derived!)).toEqual(expect.arrayContaining(["glutes"]));
    expect(areasWorked(j.derived!).length).toBeLessThanOrEqual(4);
  });
});

describe("a dose in words, and its steppers", () => {
  it("says sets, amount, sides and the load as typed", () => {
    const say = (d: WorkoutDose) => doseSummary(d);
    expect(say({ sets: 3, reps: 8, load: { typed: "25 lb", kg: 11.34 } })).toBe("3 × 8 · 25 lb");
    expect(say({ reps: 10 })).toBe("10 reps");
    expect(say({ sets: 2, reps: { min: 8, max: 12 } })).toBe("2 × 8–12");
    expect(say({ sets: 1, holdSec: 30, perSide: true })).toBe("30 s each side");
    expect(say({ sets: 3, holdSec: 90 })).toBe("3 × 90 s");
    expect(say({ breaths: 6 })).toBe("6 breaths");
    expect(say({ holdSec: 30, max: true })).toBe("30 s, to max");
  });

  it("the amount follows the dose, else the move", () => {
    expect(amountKind({ holdSec: 20 }, rec("gobletSquat"))).toBe("hold");
    expect(amountKind({}, rec("wallSit"))).toBe("hold");
    expect(amountKind({}, rec("gobletSquat"))).toBe("reps");
    expect(amountKind({ breaths: 5 })).toBe("breaths");
  });

  it("steps reps by one (a range moves whole), holds by 5 s and by 15 s past a minute, within the schema's bounds", () => {
    expect(stepAmount({ reps: 8 }, "reps", 1)).toEqual({ reps: 9 });
    expect(stepAmount({ reps: { min: 8, max: 12 } }, "reps", -1)).toEqual({ reps: { min: 7, max: 11 } });
    expect(stepAmount({ reps: 1 }, "reps", -1)).toEqual({ reps: 1 });
    expect(stepAmount({ holdSec: 30 }, "hold", 1)).toEqual({ holdSec: 35 });
    expect(stepAmount({ holdSec: 60 }, "hold", 1)).toEqual({ holdSec: 75 });
    expect(stepAmount({ holdSec: 60 }, "hold", -1)).toEqual({ holdSec: 55 });
    expect(stepAmount({ holdSec: 5 }, "hold", -1)).toEqual({ holdSec: 5 });
    expect(stepAmount({}, "breaths", 1)).toEqual({ breaths: 1 });
    expect(stepSets({ reps: 8 }, 1)).toEqual({ reps: 8, sets: 2 });
    expect(stepSets({ sets: 1, reps: 8 }, -1)).toEqual({ sets: 1, reps: 8 });
    expect(stepSets({ sets: 20, reps: 8 }, 1)).toEqual({ sets: 20, reps: 8 });
  });

  it("a typed amount: a number, a range, or nothing it can use", () => {
    expect(typedAmount({ reps: 8, sets: 2 }, "reps", "12")).toEqual({ reps: 12, sets: 2 });
    expect(typedAmount({ reps: 8 }, "reps", "8-12")).toEqual({ reps: { min: 8, max: 12 } });
    expect(typedAmount({ holdSec: 30 }, "hold", "45")).toEqual({ holdSec: 45 });
    expect(typedAmount({ reps: 8 }, "reps", "")).toBeNull();
    expect(typedAmount({ reps: 8 }, "reps", "12-8")).toBeNull();
    expect(typedAmount({ reps: 8 }, "reps", "0")).toBeNull();
  });

  it("a load as typed, in the athlete's unit unless it names one", () => {
    expect(loadFrom("25", "lb")).toEqual({ typed: "25 lb", kg: 11.34 });
    expect(loadFrom("12 kg", "lb")).toEqual({ typed: "12 kg", kg: 12 });
    expect(loadFrom("  ", "kg")).toBeNull();
    expect(loadFrom("heavy", "kg")).toBe("invalid");
    expect(loadFrom("2000 lb", "lb")).toBe("invalid");
  });
});

describe("swap", () => {
  it("the item's alternates first, then easier and harder, then moves for the same purpose — none already in the workout", () => {
    const d = draft(into(1, "gobletSquat", { alternates: [{ libraryId: "deadlift" }] }), into(1, "tempoSquat"));
    const item = d.parts[1]!.items[0]!;
    const o = swapOptions(item, rec("gobletSquat"), d, EXERCISES, buildCtxOf(studio(), TODAY));
    expect(o.alternates.map((r) => r.id)).toEqual(["deadlift"]);
    expect(o.easier.map((r) => r.id)).toEqual(["boxSquat"]);
    expect(o.harder).toEqual([]);
    const same = o.same.map((r) => r.id);
    expect(same.length).toBeGreaterThan(0);
    expect(same.length).toBeLessThanOrEqual(4);
    for (const id of ["gobletSquat", "tempoSquat", "deadlift", "boxSquat"]) expect(same).not.toContain(id);
    expect(same.every((id) => rec(id).purposes.includes("strength"))).toBe(true);
  });
});

describe("parts", () => {
  it("offers the parts a workout lacks, condition care only while a profile with care is on", () => {
    expect(addablePurposes(draft(), [])).toEqual(["activation", "power", "accessory", "conditioning"]);
    expect(addablePurposes(draft(), [PROFILES.tmj])).toEqual(["activation", "power", "accessory", "conditioning", "care"]);
    const noWarmup = draft({ type: "removePart", part: 0 });
    expect(addablePurposes(noWarmup, [])).toEqual(["warmup", "activation", "power", "accessory", "conditioning"]);
  });

  it("prompts for activation once the main part loads a lift, where the part would go", () => {
    expect(activationAt(draft(), EXERCISES)).toBeNull();
    // Mobility in the main part is no lift.
    expect(activationAt(draft(into(1, "catCow")), EXERCISES)).toBeNull();
    expect(activationAt(draft(into(1, "deadlift")), EXERCISES)).toBe(1);
    expect(activationAt(draft(into(1, "deadlift"), { type: "addPart", purpose: "activation" }), EXERCISES)).toBeNull();
  });

  it("suggests in an empty part, and in a prompted part until it holds three", () => {
    expect(showsSuggestions({ purpose: "main", format: "straight", items: [] })).toBe(true);
    const one = suggestedItem(rec("catCow"), "warmup");
    expect(showsSuggestions({ purpose: "main", format: "straight", items: [one] })).toBe(false);
    expect(showsSuggestions({ purpose: "warmup", format: "straight", items: [one, one] })).toBe(true);
    expect(showsSuggestions({ purpose: "cooldown", format: "straight", items: [one, one, one] })).toBe(false);
  });

  it("up and down move within a part, and across into the next part at its edge", () => {
    const d = draft(into(0, "catCow"), into(1, "gobletSquat"), into(1, "deadlift"));
    expect(moveTarget(d, 1, 1, -1)).toEqual({ from: [1, 1], to: [1, 0] });
    expect(moveTarget(d, 1, 0, -1)).toEqual({ from: [1, 0], to: [0, 1] });
    expect(moveTarget(d, 1, 1, 1)).toEqual({ from: [1, 1], to: [2, 0] });
    expect(moveTarget(d, 0, 0, -1)).toBeNull();
    // The last item of the last part has nowhere further to go.
    const last = draft(into(2, "catCow"));
    expect(moveTarget(last, 2, 0, 1)).toBeNull();
  });
});

describe("scheduling", () => {
  const at = (hh: number, mm: number, date = TODAY) => {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y!, m! - 1, d!, hh, mm);
  };
  const prefs = DEFAULT_SCHEDULING_PREFERENCES;

  it("Later today is the athlete's usual time when it is still ahead, else the next whole hour and one more", () => {
    expect(laterToday(at(5, 40), prefs, TODAY)).toBe("07:00");
    expect(laterToday(at(14, 20), prefs, TODAY)).toBe("16:00");
    expect(laterToday(at(14, 20), { ...prefs, defaultWindow: "evening" }, TODAY)).toBe("19:00");
    // A Saturday morning is the weekend's own time.
    expect(laterToday(at(6, 0, "2026-10-17"), prefs, "2026-10-17")).toBe("08:00");
    expect(laterToday(at(14, 20), null, TODAY)).toBe("16:00");
    // Too late for one more: none.
    expect(laterToday(at(22, 30), prefs, TODAY)).toBeNull();
    expect(laterToday(at(21, 59), prefs, TODAY)).toBe("23:00");
  });

  it("a template's workout says it is based on the template", () => {
    const doc = { title: "T" } as WorkoutDoc;
    expect(forSchedule(doc, { kind: "template", id: "t1" })).toEqual({ title: "T", basedOn: { kind: "template", id: "t1" } });
    expect(forSchedule(doc, { kind: "new" })).toBe(doc);
  });
});

/** `BuildCtx` is exported for the components; its shape is the contract above. */
export type _Ctx = BuildCtx;
