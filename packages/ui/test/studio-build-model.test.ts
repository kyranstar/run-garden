/**
 * Stage 2 Task 6 — the builder's decisions, pure (spec §8): what the builder judges with, the notes it shows (their
 * place in the draft, their Fix, whether a check would answer them), what blocks Start and Schedule, the summary's
 * numbers, the item sheet's steppers and load, the swap list, the parts on offer, the activation it prompts for, and
 * the "Later today" slot.
 */
import { describe, expect, it } from "vitest";
import type { WorkoutDto } from "@rg/api-client";
import type { WorkoutDoc, WorkoutDose } from "@rg/domain";
import { DEFAULT_SCHEDULING_PREFERENCES, itemSchema, REVISABILITY_WORDS, partSchema, secondsText, workoutDocSchema } from "@rg/domain";
import { EXERCISES, NO_EQUIPMENT_GEAR, PROFILES } from "@rg/exercise-library";
import { edit, newDoc, startEditing, suggestedItem, undo, type DraftDoc, type EditAction } from "@rg/workout";
import {
  activationAt,
  addablePurposes,
  amountKind,
  areasWorked,
  balanceRows,
  blockedLine,
  buildCtxOf,
  clockIn,
  doseSummary,
  editAll,
  editRefusal,
  forSchedule,
  holdSeconds,
  judgeDayOf,
  judgeDraft,
  laterToday,
  loadFrom,
  moveTarget,
  nowHHMM,
  placeChoices,
  placeOf,
  readOnlyWhy,
  showsSuggestions,
  sourceOfPath,
  suggestCtxOf,
  stepAmount,
  stepSets,
  swapOptions,
  timeHasPassed,
  typedAmount,
  usualTime,
  type BuildCtx,
} from "../src/screens/studio/build-model.js";
import { emptyStudioCtx, studioCtxFrom, type MovePrefs, type StudioCtx } from "../src/screens/studio/model.js";
import { libraryDto, profileDto, row, twoPlacesDto } from "./studio-fixtures.js";
import { CHECK_GATED } from "./check-gated-profile.js";

const TODAY = "2026-10-12";
const rec = (id: string) => EXERCISES.find((r) => r.id === id)!;
const prefs = (over: Partial<MovePrefs> = {}): MovePrefs => ({ rating: null, pinned: false, excluded: false, lastDoneOn: null, timesDone30d: 0, doneCleanly: false, ...over });

const studio = (over: Partial<StudioCtx> = {}): StudioCtx => ({ ...emptyStudioCtx, today: TODAY, ...over });
/** A day with a profile whose gate reads the check (TMJ's rule until 2026-10-23, `CHECK_GATED`): what the gating notes are held with. */
const tmjCtx = (pre: number | null): StudioCtx =>
  studio({ profiles: [CHECK_GATED], readings: pre === null ? {} : { tmj: { pre, post: null, feelingOff: false } } });

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

  it("what was done cleanly is the server's word on each move (the library's one rule, flags and all) — and nothing before its read", () => {
    // Done, but only ever clenched: the server says not clean, and it is not.
    const known = new Map([["landingStick", prefs({ lastDoneOn: "2026-10-01", doneCleanly: true })], ["pogoHop", prefs({ lastDoneOn: "2026-10-02" })]]);
    expect([...buildCtxOf(studio({ prefs: known, profiles: [PROFILES.tmj] }), TODAY).done!]).toEqual(["landingStick"]);
    expect(buildCtxOf(studio(), TODAY).done).toBeUndefined();
  });

  it("the Studio reads the server's word from the library rows — and an older cached row, without it, says nothing either way", () => {
    const ctx = studioCtxFrom(libraryDto({ items: [row("snapDown", { doneCleanly: true, lastDoneOn: "2026-10-01" }), row("pogoHop", { lastDoneOn: "2026-10-02" })] }));
    expect(ctx.prefs.get("snapDown")!.doneCleanly).toBe(true);
    expect(ctx.prefs.get("pogoHop")!.doneCleanly).toBe(false);
    expect([...buildCtxOf(ctx, TODAY).done!]).toEqual(["snapDown"]);
    // A read from before the field: not "nothing done cleanly" (every jump a jump) but unknown, as before any read.
    const older = studioCtxFrom(libraryDto({ items: [{ ...row("snapDown", { lastDoneOn: "2026-10-01" }), doneCleanly: undefined } as never] }));
    expect(older.prefs.get("snapDown")!.doneCleanly).toBeNull();
    expect(buildCtxOf(older, TODAY).done).toBeUndefined();
    // A row that does not say, among rows that do, is not counted clean.
    const mixed = studioCtxFrom(libraryDto({ items: [row("snapDown", { doneCleanly: true }), { ...row("pogoHop", { lastDoneOn: "2026-10-02" }), doneCleanly: undefined } as never] }));
    expect([...buildCtxOf(mixed, TODAY).done!]).toEqual(["snapDown"]);
  });

  it("so the frontier speaks in the builder: a jump past the ones done cleanly is noted, with the rung that comes first", () => {
    const hop = draft({ type: "addPart", purpose: "power" }, { type: "addItem", part: 1, item: suggestedItem(rec("pogoHop"), "power") });
    const noteOf = (ctx: StudioCtx) => judgeDraft(hop, buildCtxOf(ctx, TODAY), TODAY).notes.find((n) => n.code === "progression_jump");
    const note = noteOf(studio({ prefs: new Map([["catCow", prefs({ doneCleanly: true })]]) }))!;
    expect(note.message).toBe("Pogo hops is a step past the jumps you've done; Snap-down comes first.");
    expect(note.fix).toEqual({ action: { type: "swapItem", part: 1, item: 0, libraryId: "snapDown" }, label: "Swap in Snap-down" });
    expect(noteOf(studio({ prefs: new Map([["snapDown", prefs({ doneCleanly: true })]]) }))).toBeUndefined();
    // Before the library read, no frontier is claimed, so nothing is said.
    expect(noteOf(studio())).toBeUndefined();
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

  it("with TMJ itself (since 2026-10-23) no check is asked: a press on a Develop day is fine unanswered or high; a Recover day refuses it by its mode", () => {
    const real = (pre: number | null): StudioCtx => studio({ profiles: [PROFILES.tmj], readings: pre === null ? {} : { tmj: { pre, post: null, feelingOff: false } } });
    const develop = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress"));
    for (const pre of [null, 3, 4]) {
      const j = judgeDraft(develop, buildCtxOf(real(pre), TODAY), TODAY);
      expect(j.notes.filter((n) => n.severity === "error"), String(pre)).toEqual([]);
      expect(j.checks).toEqual([]);
    }
    const recover = draft({ type: "setIntent", intent: { effort: "recover" } }, into(1, "halfKneelingPress"));
    const j = judgeDraft(recover, buildCtxOf(real(null), TODAY), TODAY);
    expect(j.notes.find((n) => n.code === "condition_pattern")!.message).toBe("Half-kneeling one-arm press isn't allowed on a Recover day with TMJ.");
    expect(j.checks).toEqual([]);
    expect(j.blocked).toBe("Half-kneeling one-arm press isn't allowed on a Recover day with TMJ.");
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
    // Each side, then to max (re-review N6).
    expect(say({ holdSec: 30, max: true, perSide: true })).toBe("30 s each side, to max");
    expect(say({ max: true, perSide: true })).toBe("each side, to max");
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
    // Down to the schema's own floor, one second.
    expect(stepAmount({ holdSec: 5 }, "hold", -1)).toEqual({ holdSec: 1 });
    expect(stepAmount({ holdSec: 1 }, "hold", -1)).toEqual({ holdSec: 1 });
    expect(stepAmount({}, "breaths", 1)).toEqual({ breaths: 1 });
    expect(stepSets({ reps: 8 }, 1)).toEqual({ reps: 8, sets: 2 });
    expect(stepSets({ sets: 1, reps: 8 }, -1)).toEqual({ sets: 1, reps: 8 });
    expect(stepSets({ sets: 20, reps: 8 }, 1)).toEqual({ sets: 20, reps: 8 });
  });

  it("a typed amount: a number, a range, or nothing it can use", () => {
    expect(typedAmount({ reps: 8, sets: 2 }, "reps", "12")).toEqual({ reps: 12, sets: 2 });
    expect(typedAmount({ reps: 8 }, "reps", "8-12")).toEqual({ reps: { min: 8, max: 12 } });
    expect(typedAmount({ holdSec: 30 }, "hold", "45")).toEqual({ holdSec: 45 });
    // A hold in minutes, as a person types it.
    expect(typedAmount({ holdSec: 30 }, "hold", "2m")).toEqual({ holdSec: 120 });
    expect(typedAmount({ holdSec: 30 }, "hold", "2 min")).toEqual({ holdSec: 120 });
    expect(typedAmount({ holdSec: 30 }, "hold", "1:30")).toEqual({ holdSec: 90 });
    expect(typedAmount({ holdSec: 30 }, "hold", "90 s")).toEqual({ holdSec: 90 });
    expect(holdSeconds("0")).toBeNull();
    expect(holdSeconds("1:75")).toBeNull();
    expect(holdSeconds("61m")).toBeNull();
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

  it("never offers a move the athlete set aside, in any of its lists", () => {
    const d = draft(into(1, "gobletSquat", { alternates: [{ libraryId: "deadlift" }] }));
    const ctx = studio({ prefs: new Map([["deadlift", prefs({ excluded: true })], ["boxSquat", prefs({ excluded: true })]]) });
    const o = swapOptions(d.parts[1]!.items[0]!, rec("gobletSquat"), d, EXERCISES, buildCtxOf(ctx, TODAY));
    expect(o.alternates).toEqual([]);
    expect(o.easier).toEqual([]);
    expect([...o.harder, ...o.same].map((r) => r.id)).not.toContain("boxSquat");
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

  it("Later today is the athlete's usual time when it is at least 15 minutes ahead, else the next whole hour and one more", () => {
    expect(laterToday(at(5, 40), prefs, TODAY)).toBe("07:00");
    expect(laterToday(at(14, 20), prefs, TODAY)).toBe("16:00");
    expect(laterToday(at(14, 20), { ...prefs, defaultWindow: "evening" }, TODAY)).toBe("19:00");
    // 2026-10-17 is a Saturday: the weekend's own morning time.
    expect(laterToday(at(6, 0, "2026-10-17"), prefs, "2026-10-17")).toBe("08:00");
    expect(laterToday(at(14, 20), null, TODAY)).toBe("16:00");
    // Ten minutes to the usual time is now, not later: the next whole hour and one more.
    expect(laterToday(at(6, 50), prefs, TODAY)).toBe("08:00");
    expect(laterToday(at(6, 45), prefs, TODAY)).toBe("07:00");
  });

  it("…and finishes by the athlete's latest evening finish (21:00 unless they set another), or is not offered", () => {
    expect(laterToday(at(18, 10), prefs, TODAY)).toBe("20:00");
    expect(laterToday(at(19, 5), prefs, TODAY)).toBe("21:00");
    // A 30-minute workout from 21:00 would run past it.
    expect(laterToday(at(19, 5), prefs, TODAY, 30)).toBeNull();
    expect(laterToday(at(18, 10), prefs, TODAY, 45)).toBe("20:00");
    expect(laterToday(at(18, 10), prefs, TODAY, 61)).toBeNull();
    expect(laterToday(at(21, 30), { ...prefs, latestEveningFinish: "23:30" }, TODAY)).toBe("23:00");
    // With no settings, only midnight bounds it.
    expect(laterToday(at(22, 30), null, TODAY)).toBeNull();
    expect(laterToday(at(21, 59), null, TODAY)).toBe("23:00");
  });

  it("the athlete's usual time for a day is the window the server places an untimed workout in", () => {
    // TODAY (2026-10-12) is a Monday; 2026-10-17 a Saturday, with its own morning time.
    expect(usualTime(prefs, TODAY)).toBe("07:00");
    expect(usualTime(prefs, "2026-10-17")).toBe("08:00");
    expect(usualTime({ ...prefs, defaultWindow: "evening" }, TODAY)).toBe("19:00");
    expect(usualTime({ ...prefs, defaultWindow: "evening" }, "2026-10-17")).toBe("19:00");
    // Unknown (no settings yet, or a time not written as one): nothing to compare with.
    expect(usualTime(null, TODAY)).toBeNull();
    expect(usualTime({ ...prefs, weekdayMorningTime: "early" }, TODAY)).toBeNull();
  });

  it("a time today that has come is past", () => {
    expect(timeHasPassed("14:20", at(14, 20))).toBe(true);
    expect(timeHasPassed("14:21", at(14, 20))).toBe(false);
    expect(timeHasPassed("09:00", at(14, 20))).toBe(true);
  });

  it("a template's workout says it is based on the template", () => {
    const doc = { title: "T" } as WorkoutDoc;
    expect(forSchedule(doc, { kind: "template", id: "t1" })).toEqual({ title: "T", basedOn: { kind: "template", id: "t1" } });
    expect(forSchedule(doc, { kind: "new" })).toBe(doc);
  });
});

describe("edits, and why one was refused", () => {
  it("several actions are one edit — one Undo takes them all back — and a refusal stops them all", () => {
    const s0 = startEditing(draft());
    const r = editAll(s0, [{ type: "setIntent", intent: { summary: "Hips" } }, { type: "setTitle", title: "Hips" }], EXERCISES);
    expect(r.rejected).toBeUndefined();
    expect([r.state.doc.title, r.state.doc.intent.summary]).toEqual(["Hips", "Hips"]);
    expect(r.state.past).toHaveLength(1);
    const back = undo(r.state);
    expect([back.doc.title, back.doc.intent.summary]).toEqual(["Test", "Test"]);
    // The title can't be empty: nothing at all changes, the summary included.
    const no = editAll(s0, [{ type: "setIntent", intent: { summary: "X" } }, { type: "setTitle", title: "  " }], EXERCISES);
    expect(no.rejected).toBe("invalid");
    expect(no.state).toBe(s0);
    expect(editAll(s0, [{ type: "setTitle", title: "Test" }], EXERCISES).rejected).toBe("unchanged");
  });

  it("says why in the words of what was asked — each bound the schema's own, so the two can't drift apart", () => {
    const d = draft(into(1, "gobletSquat"));
    // The bounds as the schema writes them (today: rounds 1–50, rest 15 min, a part's why 160, the summary 200, goals 6,
    // focus 12, parts 20, a part's moves 60, a cue 160, a title 80).
    const listMax = (s: { _def: { maxLength: { value: number } | null } }) => s._def.maxLength!.value;
    const rounds = partSchema.shape.rounds.unwrap();
    const intent = workoutDocSchema.shape.intent.shape;
    const cue = itemSchema.options[0].shape.cue.unwrap();
    expect(editRefusal({ type: "setDose", part: 1, item: 0, dose: { reps: 900 } }, "invalid", d)).toBe("That dose is more than a workout takes.");
    expect(editRefusal({ type: "setPart", part: 1, patch: { rounds: 99 } }, "invalid", d)).toBe(`Rounds go from ${rounds.minValue} to ${rounds.maxValue}.`);
    expect(editRefusal({ type: "setPart", part: 1, patch: { restBetweenRoundsSec: 2000 } }, "invalid", d)).toBe(
      `Rest between rounds goes up to ${secondsText(partSchema.shape.restBetweenRoundsSec.unwrap().maxValue!)}.`,
    );
    expect(editRefusal({ type: "setPart", part: 1, patch: { why: "x".repeat(400) } }, "invalid", d)).toBe(`A part's why takes at most ${partSchema.shape.why.unwrap().maxLength} characters.`);
    expect(editRefusal({ type: "setPart", part: 1, patch: { format: "steady" } }, "invalid", d)).toBe("That doesn't fit this part.");
    expect(editRefusal({ type: "setIntent", intent: { goals: [] } }, "invalid", d)).toBe(`A workout serves at most ${listMax(intent.goals)} goals.`);
    expect(editRefusal({ type: "setIntent", intent: { focus: [] } }, "invalid", d)).toBe(`A workout has at most ${listMax(intent.focus)} focus areas.`);
    expect(editRefusal({ type: "setIntent", intent: { summary: "x".repeat(400) } }, "invalid", d)).toBe(`The why takes at most ${intent.summary.maxLength} characters.`);
    expect(editRefusal({ type: "setCue", part: 1, item: 0, cue: "x".repeat(400) }, "invalid", d)).toBe(`A cue takes at most ${cue.maxLength} characters.`);
    expect(editRefusal({ type: "setTitle", title: "" }, "invalid", d)).toBe("The title can't be empty.");
    expect(editRefusal({ type: "setTitle", title: "x".repeat(200) }, "invalid", d)).toBe(`A title takes at most ${workoutDocSchema.shape.title.maxLength} characters.`);
    expect(editRefusal({ type: "addPart", purpose: "power" }, "full", d)).toBe(`A workout holds at most ${listMax(workoutDocSchema.shape.parts)} parts.`);
    expect(editRefusal({ type: "addItem", part: 1, item: suggestedItem(rec("catCow"), "main") }, "full", d)).toBe(`A part holds at most ${listMax(partSchema.shape.items)} moves.`);
    // A move with no part named, refused full in a workout of as many parts as it can hold: no room for its part.
    const most = { ...d, parts: Array.from({ length: listMax(workoutDocSchema.shape.parts) }, () => d.parts[1]!) } as WorkoutDoc;
    expect(editRefusal({ type: "addItem", item: suggestedItem(rec("catCow"), "main") }, "full", most)).toBe(`A workout holds at most ${listMax(workoutDocSchema.shape.parts)} parts.`);
    expect(editRefusal({ type: "addItem", item: suggestedItem(rec("catCow"), "main") }, "full", d)).toBe(`A part holds at most ${listMax(partSchema.shape.items)} moves.`);
    expect(editRefusal({ type: "removeItem", part: 4, item: 0 }, "missing", d)).toBe("That's gone already.");
    // An item already outside the rules (a stored document's) changes only by a swap or by going.
    const broken = { ...d, parts: d.parts.map((p, i) => (i === 1 ? { ...p, items: [{ kind: "exercise", libraryId: "gobletSquat", dose: { reps: 900 } }] } : p)) } as WorkoutDoc;
    expect(editRefusal({ type: "setDose", part: 1, item: 0, dose: { reps: 8 } }, "invalid", broken)).toBe("Fix this item first.");
  });
});

describe("a planned workout that can't change", () => {
  const w = (over: Partial<WorkoutDto>): WorkoutDto =>
    ({ id: "w1", effectiveDate: TODAY, completionState: "scheduled", contentState: "outline", archived: false, origin: "studio", ...over }) as WorkoutDto;
  it("opens read-only, and says why in plain words", () => {
    expect(readOnlyWhy(w({}), TODAY)).toBeNull();
    expect(readOnlyWhy(w({ effectiveDate: "2026-10-20" }), TODAY)).toBeNull();
    expect(readOnlyWhy(w({ completionState: "completed" }), TODAY)).toBe("This workout is done, so it can't be changed.");
    expect(readOnlyWhy(w({ contentState: "done" }), TODAY)).toBe("This workout is done, so it can't be changed.");
    expect(readOnlyWhy(w({ completionState: "skipped" }), TODAY)).toBe("This workout was skipped, so it can't be changed.");
    expect(readOnlyWhy(w({ completionState: "missed" }), TODAY)).toBe("This workout was missed, so it can't be changed.");
    expect(readOnlyWhy(w({ contentState: "started" }), TODAY)).toBe("This workout is under way, so it can't be changed.");
    expect(readOnlyWhy(w({ archived: true }), TODAY)).toBe("This workout is no longer in the plan, so it can't be changed.");
    expect(readOnlyWhy(w({ effectiveDate: "2026-10-01" }), TODAY)).toBe("This workout's day has passed, so it can't be changed.");
  });

  it("is judged by today's reading only while it can still be done today: once done with, by the static rules alone", () => {
    // Editable: its own day (today's, or the day ahead it is planned for).
    expect(judgeDayOf(w({}), TODAY, TODAY)).toBe(TODAY);
    expect(judgeDayOf(w({ effectiveDate: "2026-10-20" }), TODAY, "2026-10-20")).toBe("2026-10-20");
    expect(judgeDayOf(undefined, TODAY, TODAY)).toBe(TODAY);
    // Under way today: today's reading still holds for it.
    expect(judgeDayOf(w({ contentState: "started" }), TODAY, TODAY)).toBe(TODAY);
    // Its day passed, or done with: today's reading says nothing of it.
    expect(judgeDayOf(w({ effectiveDate: "2026-10-09" }), TODAY, TODAY)).toBeNull();
    expect(judgeDayOf(w({ effectiveDate: "2026-10-09", contentState: "started" }), TODAY, TODAY)).toBeNull();
    expect(judgeDayOf(w({ completionState: "completed" }), TODAY, TODAY)).toBeNull();
    expect(judgeDayOf(w({ contentState: "done" }), TODAY, TODAY)).toBeNull();
    expect(judgeDayOf(w({ completionState: "skipped" }), TODAY, TODAY)).toBeNull();
    expect(judgeDayOf(w({ completionState: "missed" }), TODAY, TODAY)).toBeNull();
    expect(judgeDayOf(w({ archived: true }), TODAY, TODAY)).toBeNull();
  });

  it("judged with no day, a move today's reading rules out is no note — the static rules still speak", () => {
    const d = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress", { alternates: [{ libraryId: "floorPress" }] }));
    const today = judgeDraft(d, buildCtxOf(tmjCtx(3), TODAY), TODAY);
    expect(today.notes.some((n) => n.message.includes("today's Jaw / head check"))).toBe(true);
    const none = judgeDraft(d, buildCtxOf({ ...tmjCtx(3), place: { name: "Home", equipment: ["mat"] } }, TODAY), null);
    expect(none.notes.map((n) => n.message)).toEqual([
      "Half-kneeling one-arm press needs kettlebell or dumbbells, which this place doesn't have.",
      "Floor press needs kettlebell or dumbbells, which this place doesn't have.",
    ]);
    expect(none.checks).toEqual([]);
    expect(none.blocked).toBeNull();
  });
});

describe("what the actions say while Start is off", () => {
  it("the reason itself only for an empty workout; otherwise where to look — the note above says what", () => {
    expect(blockedLine(judgeDraft(draft(), buildCtxOf(studio(), TODAY), TODAY))).toBe("Add a move first.");
    const one = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress"));
    expect(blockedLine(judgeDraft(one, buildCtxOf(tmjCtx(3), TODAY), TODAY))).toBe("Fix the note above to start.");
    const two = draft({ type: "setIntent", intent: { effort: "develop" } }, into(1, "halfKneelingPress"), into(1, "halfKneelingPress"));
    expect(blockedLine(judgeDraft(two, buildCtxOf(tmjCtx(3), TODAY), TODAY))).toBe("Fix the 2 notes above to start.");
    expect(blockedLine(judgeDraft(draft(into(1, "gobletSquat")), buildCtxOf(studio(), TODAY), TODAY))).toBeNull();
  });
});

/** `BuildCtx` is exported for the components; its shape is the contract above. */
export type _Ctx = BuildCtx;

describe("the list row's dose (Stage 2 whole-branch review M3)", () => {
  it("is the dose Add would put in, for the part it would put the move in — in the builder's words", async () => {
    const { doseLine } = await import("../src/screens/studio/model.js");
    const { doseFor, itemFor, placementFor } = await import("@rg/workout");
    const { doseSummary } = await import("@rg/domain");
    for (const e of EXERCISES.slice(0, 120)) {
      expect(doseLine(e)).toBe(doseSummary((itemFor(e) as { dose: never }).dose));
      expect(doseLine(e)).toBe(doseSummary(doseFor(e, placementFor(e))));
    }
    // A warm-up move is one set there: "8–12 reps", never "2 × …".
    const warm = EXERCISES.find((e) => placementFor(e) === "warmup" && e.dose.type === "reps" && (e.dose.sets?.[0] ?? 1) > 1);
    if (warm) expect(doseLine(warm)).not.toMatch(/ × /);
  });
});

describe("a refusal says what to do next (Stage 2 whole-branch review M8)", () => {
  it("not today, a day passed, offline", async () => {
    const { refusalText } = await import("../src/screens/studio/use-build-flows.js");
    const { ApiError } = await import("@rg/api-client");
    const err = (status: number, body: unknown) => new ApiError(status, body as never);
    expect(refusalText(err(409, { error: "not_today" }), "start")).toBe("This workout isn't today's — schedule it for today to start it.");
    // A refusal carrying the server's words says them: the why, then what to do instead.
    expect(refusalText(err(409, { error: "not_editable", cause: "programme", why: REVISABILITY_WORDS.programme.why, instead: REVISABILITY_WORDS.programme.instead }), "save")).toBe(
      `${REVISABILITY_WORDS.programme.why} ${REVISABILITY_WORDS.programme.instead}`,
    );
    expect(refusalText(err(422, { error: "past_date", why: REVISABILITY_WORDS.past.why as string, instead: REVISABILITY_WORDS.past.instead }), "save")).toBe("Its day has passed. Propose for today or later.");
    // No words in the body: the generic text stays.
    expect(refusalText(err(409, { error: "not_editable" }), "save")).toBe("This workout can't be changed now — it's under way or done. Save it as a template to change a copy.");
    expect(refusalText(err(422, { error: "past_date" }), "schedule")).toBe("That day has passed — pick today or a later day.");
    expect(refusalText(err(409, { error: "stale_revision" }), "save")).toBe("This workout changed elsewhere — reload it to see the new version.");
    expect(refusalText(new TypeError("Failed to fetch"), "start")).toBe("Starting needs a connection — try again once you're online.");
    expect(refusalText(new TypeError("Failed to fetch"), "save")).toBe("Saving needs a connection — try again once you're online.");
  });
});

describe("Do it again's address (CUJ B2)", () => {
  it("opens a planned workout's document as the start of a new one", () => {
    expect(sourceOfPath("/studio/build/again/w1")).toEqual({ kind: "again", id: "w1" });
    expect(sourceOfPath("/studio/build/again/")).toBeNull();
  });
});

describe("the athlete's focus areas and places reach the Studio (CUJ R7, R8)", () => {
  const ctx = studioCtxFrom(undefined, undefined, twoPlacesDto(["mat"]), profileDto([{ id: "calf", refs: ["calves", "soleus"] }, { id: "hips", refs: ["hips", "calves"] }]));

  it("the profile's focus areas are the suggestions' focus: each region or muscle once", () => {
    expect(ctx.focusRefs).toEqual(["calves", "soleus", "hips"]);
    expect(suggestCtxOf(buildCtxOf(ctx, "2026-10-11"), "2026-10-11").focusRefs).toEqual(["calves", "soleus", "hips"]);
    // Before the profile is read: none.
    expect(studioCtxFrom().focusRefs).toEqual([]);
  });

  it("the places, the default first, each with its id; the default place carries its id", () => {
    const flipped = studioCtxFrom(undefined, undefined, { ...twoPlacesDto(["mat"]), places: [...twoPlacesDto(["mat"]).places].reverse() });
    expect(flipped.places.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(ctx.place).toEqual({ id: "p1", name: "Home", equipment: ["mat"] });
    expect(studioCtxFrom(undefined, undefined, { places: [], equipment: [] }).place?.id).toBeUndefined();
  });

  it("a document's place is the one judged: No equipment is bodyweight only, a place its own gear, none named the default", () => {
    // "No equipment" is the library's own place: bodyweight plus what any room has (a wall, a chair, the floor).
    expect(buildCtxOf(ctx, "2026-10-11", {}, "none").equipment).toEqual([...NO_EQUIPMENT_GEAR]);
    expect(buildCtxOf(ctx, "2026-10-11", {}, "p2").equipment).toContain("cable");
    expect(buildCtxOf(ctx, "2026-10-11").equipment).toEqual(["mat"]);
    // A place gone (or not known here): the default's gear, as the chip says.
    expect(buildCtxOf(ctx, "2026-10-11", {}, "p9").equipment).toEqual(["mat"]);
    expect(placeOf(ctx, "none")?.name).toBe("No equipment");
    expect(placeOf(ctx, "p2")?.name).toBe("Gym");
    expect(placeOf(ctx, undefined)?.name).toBe("Home");
  });

  it("the chip's choices: the athlete's places, else the library's Home; then No equipment", () => {
    expect(placeChoices(ctx)).toEqual([
      { id: "p1", name: "Home" },
      { id: "p2", name: "Gym" },
      { id: "none", name: "No equipment" },
    ]);
    expect(placeChoices(studioCtxFrom(undefined, undefined, { places: [], equipment: [] }))).toEqual([
      { id: undefined, name: "Home" },
      { id: "none", name: "No equipment" },
    ]);
  });
});

describe("the account's clock (CUJ R14)", () => {
  // One instant: 03:30 UTC on Oct 11 — the evening before in Los Angeles, lunchtime in Tokyo.
  const at = new Date("2026-10-11T03:30:00Z");

  it("its date and minute of the day are the account's timezone's, whatever the device's", () => {
    expect(clockIn(at, "America/Los_Angeles")).toEqual({ date: "2026-10-10", minutes: 20 * 60 + 30 });
    expect(clockIn(at, "Asia/Tokyo")).toEqual({ date: "2026-10-11", minutes: 12 * 60 + 30 });
    expect(nowHHMM(at, "Asia/Tokyo")).toBe("12:30");
  });

  it("no zone known, or one this runtime doesn't know: the device's clock", () => {
    const device = { date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`, minutes: at.getHours() * 60 + at.getMinutes() };
    expect(clockIn(at, null)).toEqual(device);
    expect(clockIn(at, "Not/AZone")).toEqual(device);
    expect(nowHHMM(at)).toBe(`${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`);
  });

  it("Later today and a time gone by are read on the account's clock", () => {
    expect(laterToday(at, null, "2026-10-11", 0, "Asia/Tokyo")).toBe("14:00");
    expect(laterToday(at, null, "2026-10-10", 0, "America/Los_Angeles")).toBe("22:00");
    expect(timeHasPassed("13:00", at, "Asia/Tokyo")).toBe(false);
    expect(timeHasPassed("13:00", at, "America/Los_Angeles")).toBe(true);
  });
});

describe("the default place, in the server's order (apps/worker/src/services/default-place.ts)", () => {
  /** As `GET /api/places` lists them: the place marked default first, then by creation. */
  const places = (...ps: Array<[string, boolean]>) => ({
    places: ps.map(([id, isDefault]) => ({ id, name: id, equipment: [], implements: {}, isDefault })),
    equipment: [],
  });
  const choosing = (id?: string) => ({ ...profileDto(), preferences: id ? { defaultPlaceId: id } : {} });
  const at = (...a: Parameters<typeof studioCtxFrom>) => studioCtxFrom(...a).place;

  it("the profile's chosen default while it is one of the places; else the one marked default; else the first made; else Home", () => {
    expect(at(undefined, undefined, places(["gym", true], ["home", false], ["cabin", false]), choosing("cabin"))?.id).toBe("cabin");
    // A choice that is no longer one of the places is no choice.
    expect(at(undefined, undefined, places(["gym", true], ["home", false]), choosing("gone"))?.id).toBe("gym");
    expect(at(undefined, undefined, places(["gym", true], ["home", false]), choosing())?.id).toBe("gym");
    expect(at(undefined, undefined, places(["first", false], ["second", false]))?.id).toBe("first");
    const home = at(undefined, undefined, places());
    expect(home?.id).toBeUndefined();
    expect(home?.name).toBe("Home");
  });

  it("the default leads the place chip's list", () => {
    expect(studioCtxFrom(undefined, undefined, places(["gym", true], ["home", false], ["cabin", false]), choosing("cabin")).places.map((p) => p.id)).toEqual(["cabin", "gym", "home"]);
  });
});

describe("the account's zone in the Studio's context (CUJ J34)", () => {
  it("comes with the profile; unknown before it", () => {
    expect(studioCtxFrom(undefined, undefined, undefined, { ...profileDto(), timezone: "America/Los_Angeles" }).timeZone).toBe("America/Los_Angeles");
    expect(studioCtxFrom().timeZone).toBeNull();
  });
});
