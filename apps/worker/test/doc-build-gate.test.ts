/**
 * The pure half of a document workout's build (`doc-build.ts`): the document as the day allows it (`gateDoc`) and the
 * build the player plays from it (`materializeDocBuild`). Fixed dates; synthetic documents.
 */
import { describe, expect, it } from "vitest";
import { workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import { Swapping } from "@rg/session-engine";
import { deriveDoc, playerStepsFromDoc, type ValidateCtx } from "@rg/workout";
import { gateDoc, judgeDoc, materializeDocBuild } from "../src/services/doc-build.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";

const DAY = "2026-10-07";

/** TMJ on, the jaw at `pre` today. */
const ctxAt = (pre: number | null): ValidateCtx => ({
  library: EXERCISES,
  activeProfiles: [PROFILES.tmj],
  day: { date: DAY, today: DAY, readings: pre === null ? {} : { tmj: { pre, post: null, feelingOff: false } } },
});

function withPower(items: unknown[]): WorkoutDoc {
  const doc = landingsDoc();
  return workoutDocSchema.parse({ ...doc, parts: [{ purpose: "power", format: "straight", items }, doc.parts[1]] });
}

describe("gateDoc", () => {
  it("a document the day allows comes back as it is", () => {
    const doc = landingsDoc();
    const gated = gateDoc(doc, ctxAt(1));
    expect(gated).toEqual({ doc, swaps: [], blocked: [] });
    expect(gated.doc).toBe(doc);
  });

  it("an alternate the day keeps out is taken off its item and blocks nothing: the item itself is played", () => {
    const doc = landingsDoc();
    const main = workoutDocSchema.parse({
      ...doc,
      parts: [
        doc.parts[1],
        { purpose: "accessory", format: "straight", items: [{ kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 10 }, alternates: [{ libraryId: "snapDown" }, { libraryId: "deadBug" }] }] },
      ],
    });
    const gated = gateDoc(main, ctxAt(6));
    expect(gated.swaps).toEqual([]);
    expect(gated.blocked).toEqual([]);
    expect(gated.doc.parts[1]!.items[0]).toEqual({ kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 10 }, alternates: [{ libraryId: "deadBug" }] });
  });

  it("swaps to the FIRST alternate that passes, keeping the rest the day allows; the alternate's why replaces the item's, its progression and test go", () => {
    const doc = withPower([
      {
        kind: "exercise",
        libraryId: "snapDown",
        dose: { sets: 2, reps: 5 },
        why: "Land softly.",
        progression: "Add a rep next time.",
        test: {},
        alternates: [{ libraryId: "pogoHop", why: "Another jump." }, { libraryId: "tempoSquat", why: "No landing." }, { libraryId: "bwSplitSquat" }],
      },
    ]);
    const gated = gateDoc(doc, ctxAt(6));
    expect(gated.swaps).toEqual([{ path: "parts[0].items[0]", from: "snapDown", to: "tempoSquat", reason: expect.any(String) }]);
    expect(gated.doc.parts[0]!.items[0]).toEqual({
      kind: "exercise",
      libraryId: "tempoSquat",
      dose: { sets: 2, reps: 5 },
      why: "No landing.",
      // The other jump is closed today too: taken off.
      alternates: [{ libraryId: "bwSplitSquat" }],
    });
    expect(gated.blocked).toEqual([]);
    // The stored document is never changed.
    expect(doc.parts[0]!.items[0]).toMatchObject({ libraryId: "snapDown" });
  });

  it("prefers an alternate that costs nothing (no warning either), then the first the day allows", () => {
    const doc = withPower([
      { kind: "exercise", libraryId: "snapDown", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "tempoSquat" }, { libraryId: "bwSplitSquat" }] },
    ]);
    // Set aside, tempo squats cost a warning: the split squat, clean, stands in.
    const setAside: ValidateCtx = { ...ctxAt(6), excluded: ["tempoSquat"] };
    expect(gateDoc(doc, setAside).swaps.map((s) => s.to)).toEqual(["bwSplitSquat"]);
    // Every alternate costs something: the first the day allows.
    expect(gateDoc(doc, { ...ctxAt(6), excluded: ["tempoSquat", "bwSplitSquat"] }).swaps.map((s) => s.to)).toEqual(["tempoSquat"]);
    expect(gateDoc(doc, ctxAt(6)).swaps.map((s) => s.to)).toEqual(["tempoSquat"]);
  });

  it("a gated item with no passing alternate is blocked, while another item's swap still stands", () => {
    const doc = withPower([
      { kind: "exercise", libraryId: "snapDown", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "tempoSquat" }] },
      { kind: "exercise", libraryId: "pogoHop", dose: { sets: 2, reps: 10 }, alternates: [{ libraryId: "lineHopForwardBack" }] },
    ]);
    const gated = gateDoc(doc, ctxAt(6));
    expect(gated.swaps.map((s) => s.path)).toEqual(["parts[0].items[0]"]);
    expect(gated.blocked.map((i) => [i.path, i.code])).toEqual([["parts[0].items[1].libraryId", "condition_gate"]]);
    expect(gated.blocked.every((i) => i.severity === "error")).toBe(true);
  });

  it("an unanswered check keeps a jump out too (unanswered is not allowed)", () => {
    expect(gateDoc(landingsDoc(), ctxAt(null)).swaps.map((s) => s.to)).toEqual(["tempoSquat"]);
  });

  it("an alternate that is the item's own move is no stand-in", () => {
    const doc = withPower([{ kind: "exercise", libraryId: "snapDown", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "snapDown" }] }]);
    const gated = gateDoc(doc, ctxAt(6));
    expect(gated.swaps).toEqual([]);
    expect(gated.blocked.map((i) => i.code)).toEqual(["condition_gate"]);
  });

  it("only a move the day keeps out swaps: a move the library no longer has is blocked, its alternate notwithstanding", () => {
    const doc = withPower([{ kind: "exercise", libraryId: "goneMove", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "tempoSquat" }] }]);
    const gated = gateDoc(doc, ctxAt(1));
    expect(gated.swaps).toEqual([]);
    expect(gated.blocked.map((i) => [i.path, i.code])).toEqual([["parts[0].items[0].libraryId", "unknown_exercise"]]);
  });

  it("an error no alternate can answer (a superset of three) is blocked, and nothing is swapped", () => {
    const doc = workoutDocSchema.parse({
      ...calmDoc(),
      parts: [{ purpose: "main", format: "superset", items: [...calmDoc().parts[0]!.items, { kind: "exercise", libraryId: "birdDog", dose: { reps: 6 } }] }],
    });
    const gated = gateDoc(doc, ctxAt(1));
    expect(gated.swaps).toEqual([]);
    expect(gated.blocked.map((i) => [i.path, i.code])).toEqual([["parts[0].format", "format_mismatch"]]);
  });
});

describe("judgeDoc (a save's judgement)", () => {
  it("today: a move its alternate answers is a warning naming the alternate; an alternate the day closes, a warning", () => {
    const doc = withPower([
      { kind: "exercise", libraryId: "snapDown", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "pogoHop" }, { libraryId: "tempoSquat" }] },
    ]);
    const judged = judgeDoc(doc, ctxAt(6));
    expect(judged.errors).toEqual([]);
    const name = EXERCISES.find((e) => e.id === "tempoSquat")!.name;
    expect(judged.warnings).toContainEqual(
      expect.objectContaining({ path: "parts[0].items[0].libraryId", code: "condition_gate", fix: "tempoSquat", message: expect.stringMatching(new RegExp(`${name} stands in today\\.$`)) }),
    );
    expect(judged.warnings).toContainEqual(expect.objectContaining({ path: "parts[0].items[0].alternates[0].libraryId", code: "condition_gate", severity: "warning" }));
    expect(judged.warnings.every((i) => i.severity === "warning")).toBe(true);
  });

  it("today: what no alternate answers is the error", () => {
    const judged = judgeDoc(landingsDoc({ alternates: false }), ctxAt(6));
    expect(judged.errors.map((i) => [i.path, i.code, i.severity])).toEqual([["parts[0].items[0].libraryId", "condition_gate", "error"]]);
  });

  it("a day ahead keeps the validator's pending rule; a template (no day) its own", () => {
    const ahead: ValidateCtx = { ...ctxAt(null), day: { date: "2026-10-09", today: DAY, readings: {} } };
    expect(judgeDoc(landingsDoc({ alternates: false }), ahead).errors.map((i) => i.code)).toEqual(["condition_gate_pending"]);
    expect(judgeDoc(landingsDoc(), ahead).warnings.map((i) => i.code)).toContain("condition_gate_pending");
    expect(judgeDoc(landingsDoc({ alternates: false }), { ...ctxAt(null), day: null })).toEqual({ errors: [], warnings: expect.any(Array) });
    // Ahead, an alternate must suit a recovery day — a hard lift does not, so the jump is still an error (the day's
    // build is never asked to swap in a move the pending rule would refuse).
    const hardAlternate = withPower([
      { kind: "exercise", libraryId: "snapDown", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "skaterSquat" }] },
    ]);
    expect(judgeDoc(hardAlternate, ahead).errors.map((i) => [i.path, i.code])).toEqual([["parts[0].items[0].libraryId", "condition_gate_pending"]]);
  });
});

describe("materializeDocBuild", () => {
  const location = { id: "home", name: "Home", equipment: [], implements: {} };

  it("plays the document's own steps: one item per slot in play order, the moves' records without their provider mappings", () => {
    const doc = landingsDoc();
    const made = materializeDocBuild(doc, { date: DAY, location, checks: {}, library: EXERCISES });
    const steps = playerStepsFromDoc(doc, EXERCISES);
    expect(made.build.steps).toEqual(steps);
    // One item per slot, in play order: the jumps (a power part) play as the accessory block, the lift as core.
    expect(made.build.items).toEqual([
      { slotKey: "accessory:0", block: "accessory", exerciseId: "snapDown", format: "straight", sets: 2, group: null, coreFamily: null, isNew: false, why: [] },
      { slotKey: "core:0", block: "core", exerciseId: "bwSplitSquat", format: "straight", sets: 2, group: null, coreFamily: null, isNew: false, why: [] },
    ]);
    expect(Object.keys(made.build.exercises).sort()).toEqual(["bwSplitSquat", "snapDown"]);
    expect(Object.values(made.build.exercises).every((e) => !("providers" in e))).toBe(true);
    expect(made.build).toMatchObject({ date: DAY, mode: "consistent", theme: null, alternatives: {}, targets: {}, newMove: null, weekOfBlock: null, locationId: "home" });
    expect(made.build.plannedSeconds).toBe(Swapping.costOf(steps));
    expect(made.build.minutes).toBe(deriveDoc(doc, EXERCISES).estimatedMinutes);
    expect(made.view).toMatchObject({ mode: "consistent", proposedMode: "consistent", theme: null, block: null, newMove: null, location });
    const name = (id: string) => EXERCISES.find((e) => e.id === id)!.name;
    // The lead names the core lift first, then the session's first moves.
    expect(made.view.lead).toEqual({ moves: [expect.objectContaining({ name: name("bwSplitSquat") }), expect.objectContaining({ name: name("snapDown") })], more: 0 });
  });

  it("the mode is the effort's", () => {
    const recover = workoutDocSchema.parse({ ...calmDoc(), intent: { ...calmDoc().intent, effort: "recover" } });
    expect(materializeDocBuild(recover, { date: DAY, location, checks: {}, library: EXERCISES }).build.mode).toBe("recovery");
  });
});
