/**
 * The pure half of a document workout's build (`doc-build.ts`): the document as the day allows it (`gateDoc`) and the
 * build the player plays from it (`materializeDocBuild`). Fixed dates; synthetic documents.
 */
import { describe, expect, it } from "vitest";
import { sessionLead, workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import { Swapping } from "@rg/session-engine";
import { deriveDoc, playerStepsFromDoc, validateWorkoutDoc, type ValidateCtx } from "@rg/workout";
import { DOC_BUILD_VERSION, gateDoc, judgeDoc, libraryOffers, materializeDocBuild, slotsForDay, type DocSlot } from "../src/services/doc-build.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DAY = "2026-10-07";

/**
 * TMJ on, the jaw at `pre` today, and feeling off or not. Since 2026-10-23 the jaw's gate keeps jumps out on a
 * recovery day, while feeling off, or on a flare day (an answered check of 5 or more, review M1); the tests written
 * while a flare alone didn't close them say "feeling off" too.
 */
const ctxAt = (pre: number | null, feelingOff = false): ValidateCtx => ({
  library: EXERCISES,
  activeProfiles: [PROFILES.tmj],
  day: { date: DAY, today: DAY, readings: pre === null ? {} : { tmj: { pre, post: null, feelingOff } } },
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
    const gated = gateDoc(main, ctxAt(6, true));
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
    const gated = gateDoc(doc, ctxAt(6, true));
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
    const setAside: ValidateCtx = { ...ctxAt(6, true), excluded: ["tempoSquat"] };
    expect(gateDoc(doc, setAside).swaps.map((s) => s.to)).toEqual(["bwSplitSquat"]);
    // Every alternate costs something: the first the day allows.
    expect(gateDoc(doc, { ...ctxAt(6, true), excluded: ["tempoSquat", "bwSplitSquat"] }).swaps.map((s) => s.to)).toEqual(["tempoSquat"]);
    expect(gateDoc(doc, ctxAt(6, true)).swaps.map((s) => s.to)).toEqual(["tempoSquat"]);
  });

  it("a gated item with no passing alternate is blocked, while another item's swap still stands", () => {
    const doc = withPower([
      { kind: "exercise", libraryId: "snapDown", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "tempoSquat" }] },
      { kind: "exercise", libraryId: "pogoHop", dose: { sets: 2, reps: 10 }, alternates: [{ libraryId: "lineHopForwardBack" }] },
    ]);
    const gated = gateDoc(doc, ctxAt(6, true));
    expect(gated.swaps.map((s) => s.path)).toEqual(["parts[0].items[0]"]);
    expect(gated.blocked.map((i) => [i.path, i.code])).toEqual([["parts[0].items[1].libraryId", "condition_gate"]]);
    expect(gated.blocked.every((i) => i.severity === "error")).toBe(true);
  });

  it("an unanswered check keeps no jump out any more (2026-10-23): the jaw's gate reads only feeling off and the mode", () => {
    expect(gateDoc(landingsDoc(), ctxAt(null))).toEqual({ doc: landingsDoc(), swaps: [], blocked: [] });
    expect(gateDoc(landingsDoc(), ctxAt(4))).toEqual({ doc: landingsDoc(), swaps: [], blocked: [] });
    // Feeling off, with no number, does.
    expect(gateDoc(landingsDoc(), { ...ctxAt(null), day: { date: DAY, today: DAY, readings: {}, feelingOff: true } }).swaps.map((s) => s.to)).toEqual(["tempoSquat"]);
  });

  // A flare day proposes recovery; a document planned above it (or the athlete's own choice of effort) still lands on a
  // flare day, and the day keeps its jumps and overhead pressing out — the reading alone, no "feeling off" (review M1).
  it("a flare reading alone keeps a jump and an overhead press out of a Maintain or Develop document; a day with no check yet keeps them in", () => {
    const pressDoc = (effort: "maintain" | "develop", alternates = true): WorkoutDoc => workoutDocSchema.parse({
      ...calmDoc(), intent: { ...calmDoc().intent, effort },
      parts: [{ purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "halfKneelingPress", dose: { sets: 2, reps: 8 }, ...(alternates ? { alternates: [{ libraryId: "tempoSquat" }] } : {}) },
      ] }],
    });
    const landings = (effort: "maintain" | "develop", alternates = true): WorkoutDoc => ({ ...landingsDoc({ alternates }), intent: { ...landingsDoc().intent, effort } });
    for (const effort of ["maintain", "develop"] as const) {
      for (const pre of [5, 7]) {
        const label = `${effort} ${pre}`;
        expect(gateDoc(landings(effort), ctxAt(pre)).swaps, label).toEqual([
          { path: "parts[0].items[0]", from: "snapDown", to: "tempoSquat", reason: `Snap-down isn't allowed with today's Jaw / head check at ${pre}.` },
        ]);
        expect(gateDoc(pressDoc(effort), ctxAt(pre)).swaps.map((s) => [s.from, s.to]), label).toEqual([["halfKneelingPress", "tempoSquat"]]);
        // No alternate: the day blocks it, and a save today refuses it.
        expect(gateDoc(landings(effort, false), ctxAt(pre)).blocked.map((i) => [i.path, i.code]), label).toEqual([["parts[0].items[0].libraryId", "condition_gate"]]);
        expect(judgeDoc(pressDoc(effort, false), ctxAt(pre)).errors.map((i) => [i.path, i.code]), label).toEqual([["parts[0].items[0].libraryId", "condition_pattern"]]);
      }
      for (const pre of [null, 4]) {
        expect(gateDoc(landings(effort), ctxAt(pre)), `${effort} ${pre}`).toEqual({ doc: landings(effort), swaps: [], blocked: [] });
        expect(gateDoc(pressDoc(effort), ctxAt(pre)), `${effort} ${pre}`).toEqual({ doc: pressDoc(effort), swaps: [], blocked: [] });
      }
    }
  });

  it("the day's own swap never stands in a jump past the frontier: the next alternate does", () => {
    // A profile that closes overhead pressing today while jumps stay open (TMJ no longer has such a gate, 2026-10-23).
    const pressClosed: ValidateCtx = { ...ctxAt(1), activeProfiles: [{ ...PROFILES.tmj, allowPattern: (p) => p !== "push-v" }] };
    const doc = workoutDocSchema.parse({
      ...calmDoc(),
      parts: [{ purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "halfKneelingPress", dose: { sets: 2, reps: 8 }, alternates: [{ libraryId: "boxJumpStepDown" }, { libraryId: "tempoSquat" }] },
      ] }],
    });
    // The box jump's snap-down never done: past the frontier, so the tempo squat stands in.
    const notReached = gateDoc(doc, { ...pressClosed, day: { ...pressClosed.day!, done: new Set<string>() } });
    expect(notReached.swaps.map((s) => [s.from, s.to])).toEqual([["halfKneelingPress", "tempoSquat"]]);
    // Its rungs below done: the box jump, first, stands in.
    const reached = gateDoc(doc, { ...pressClosed, day: { ...pressClosed.day!, done: new Set(["snapDown", "landingStick"]) } });
    expect(reached.swaps.map((s) => [s.from, s.to])).toEqual([["halfKneelingPress", "boxJumpStepDown"]]);
  });

  it("an alternate that is the item's own move is no stand-in", () => {
    const doc = withPower([{ kind: "exercise", libraryId: "snapDown", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "snapDown" }] }]);
    const gated = gateDoc(doc, ctxAt(6, true));
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
    const judged = judgeDoc(doc, ctxAt(6, true));
    expect(judged.errors).toEqual([]);
    const name = EXERCISES.find((e) => e.id === "tempoSquat")!.name;
    expect(judged.warnings).toContainEqual(
      expect.objectContaining({ path: "parts[0].items[0].libraryId", code: "condition_gate", fix: "tempoSquat", message: expect.stringMatching(new RegExp(`${name} stands in today\\.$`)) }),
    );
    expect(judged.warnings).toContainEqual(expect.objectContaining({ path: "parts[0].items[0].alternates[0].libraryId", code: "condition_gate", severity: "warning" }));
    expect(judged.warnings.every((i) => i.severity === "warning")).toBe(true);
  });

  it("today: what no alternate answers is the error", () => {
    const judged = judgeDoc(landingsDoc({ alternates: false }), ctxAt(6, true));
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
  /** No profile, no day: nothing the day keeps out. */
  const open: ValidateCtx = { library: EXERCISES, activeProfiles: [], day: null };
  const input = (judge: ValidateCtx = open) => ({ date: DAY, location, checks: {}, library: EXERCISES, judge });
  const options = (slot: DocSlot | undefined) => [...(slot?.alternates ?? []), ...(slot?.offers ?? [])];

  it("plays the document's own steps: one item per slot in play order, the moves' records without their provider mappings", () => {
    const doc = landingsDoc();
    const made = materializeDocBuild(doc, input());
    const steps = playerStepsFromDoc(doc, EXERCISES);
    expect(made.build.steps).toEqual(steps);
    // One item per slot, in play order: the jumps (a power part) play as the accessory block, the lift as core.
    expect(made.build.items).toEqual([
      { slotKey: "accessory:0", block: "accessory", exerciseId: "snapDown", format: "straight", sets: 2, group: null, coreFamily: null, isNew: false, why: [] },
      { slotKey: "core:0", block: "core", exerciseId: "bwSplitSquat", format: "straight", sets: 2, group: null, coreFamily: null, isNew: false, why: [] },
    ]);
    // The moves the steps name, and every move ⇄ may offer (offline: their records with them), the planned alternate too.
    const offered = Object.values(made.slots).flatMap((s) => options(s).map((c) => c.id));
    expect(offered).toContain("tempoSquat");
    expect(Object.keys(made.build.exercises).sort()).toEqual([...new Set(["bwSplitSquat", "snapDown", ...offered])].sort());
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
    expect(materializeDocBuild(recover, input()).build.mode).toBe("recovery");
  });

  describe("what the player reads of each item beside its steps (Stage 2 Task 8): its cue, a hold to max, what ⇄ offers", () => {
    const doc = () =>
      workoutDocSchema.parse({
        ...calmDoc(),
        parts: [
          {
            purpose: "main",
            format: "straight",
            items: [
              {
                kind: "exercise",
                libraryId: "bridge",
                dose: { sets: 2, reps: 12, restSec: 30 },
                why: "Wakes the glutes.",
                cue: "Squeeze at the top.",
                progression: "Add a pause next time.",
                alternates: [{ libraryId: "goneMove" }, { libraryId: "tempoSquat", why: "Kinder on the back." }, { libraryId: "bridge" }],
              },
              { kind: "rest", seconds: 20 },
              { kind: "exercise", libraryId: "wallSit", dose: { sets: 2, holdSec: 45, max: true, restSec: 60 }, cue: "Back flat on the wall." },
              {
                kind: "exercise",
                libraryId: "deadBug",
                dose: { sets: 2, reps: 8, restSec: 30 },
                alternates: [{ libraryId: "birdDog", why: "Another brace." }, { libraryId: "bridge" }],
              },
              { kind: "free_exercise", name: "Plank", dose: { sets: 1, holdSec: 30, max: true }, cue: "Ribs down." },
            ],
          },
        ],
      });

    it("a cue and a hold to max under the slot key its steps carry", () => {
      const made = materializeDocBuild(doc(), input());
      expect(made.slots["core:0"]).toMatchObject({ cue: "Squeeze at the top." });
      expect(made.slots["core:0"]!.max).toBeUndefined();
      expect(made.slots["core:1"]).toMatchObject({ cue: "Back flat on the wall.", max: true });
      // A free-text move: its cue and its max, though it names no move (and nothing to offer in its place).
      expect(made.slots["core:3"]).toEqual({ cue: "Ribs down.", max: true });
      expect(made.build.steps.filter((s) => s.slotKey === "core:3" && s.kind !== "rest").map((s) => s.exerciseId)).toEqual([null]);
    });

    it("an alternate plays the steps the document plays with it in the item's place (the day's own swap: `gateDoc`)", () => {
      const made = materializeDocBuild(doc(), input());
      // Never a move the library lacks, nor the item's own move.
      const alternates = made.slots["core:0"]!.alternates!;
      expect(alternates.map((a) => [a.id, a.reasons])).toEqual([["tempoSquat", ["Kinder on the back."]]]);
      // In the document's order, each with its why (if any). A move the session holds elsewhere is listed: the
      // player's swap rules (no move twice) judge it against the session as it stands.
      expect(made.slots["core:2"]!.alternates!.map((a) => [a.id, a.reasons])).toEqual([["birdDog", ["Another brace."]], ["bridge", []]]);
      const tempo = EXERCISES.find((e) => e.id === "tempoSquat")!;
      expect(alternates[0]).toMatchObject({ name: tempo.name, moveKey: Swapping.moveKeyOf(tempo), pairing: Swapping.pairingOf(tempo) });
      // The alternate takes the item's place and dose; its why replaces the item's; the progression note and the cue
      // go with the move.
      const swapped = workoutDocSchema.parse({
        ...doc(),
        parts: [{ ...doc().parts[0]!, items: [{ kind: "exercise", libraryId: "tempoSquat", dose: { sets: 2, reps: 12, restSec: 30 }, why: "Kinder on the back." }, ...doc().parts[0]!.items.slice(1)] }],
      });
      const own = playerStepsFromDoc(swapped, EXERCISES).filter((s) => s.kind !== "rest" && s.slotKey === "core:0");
      expect(own.map((s) => s.exerciseId)).toEqual(["tempoSquat", "tempoSquat"]);
      expect(alternates[0]!.steps).toEqual(own);
      // Offline: every alternate's record is in the build, without its provider mappings.
      expect(made.build.exercises.tempoSquat).toBeDefined();
      expect("providers" in made.build.exercises.tempoSquat!).toBe(false);
      // The build's own swap list stays the engine's (none for a document): the sheet's ⇄ rebuilds with the engine.
      expect(made.build.alternatives).toEqual({});
      // The steps and items are the document's own, whatever ⇄ may offer.
      expect(made.build.steps).toEqual(playerStepsFromDoc(doc(), EXERCISES));
    });

    it("the day judges the planned alternates: one it keeps out is not offered; one that costs something comes after the clean ones, its cost in plain words", () => {
      const planned = workoutDocSchema.parse({
        ...calmDoc(),
        parts: [{ purpose: "main", format: "straight", items: [
          { kind: "exercise", libraryId: "tempoSquat", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "bwSplitSquat", why: "One leg." }, { libraryId: "snapDown" }, { libraryId: "gobletSquat" }] },
        ] }],
      });
      // TMJ at 6: the jump is kept out; the split squat is set aside by the athlete (a warning: a cost, not a block).
      const judge: ValidateCtx = { ...ctxAt(6, true), excluded: ["bwSplitSquat"] };
      const made = materializeDocBuild(planned, input(judge));
      const alternates = made.slots["core:0"]!.alternates!;
      expect(alternates.map((a) => a.id)).toEqual(["gobletSquat", "bwSplitSquat"]);
      const aside = validateWorkoutDoc(planned, judge).find((i) => i.path === "parts[0].items[0].alternates[0].libraryId")!;
      expect(aside).toMatchObject({ code: "excluded_by_athlete", severity: "warning" });
      expect(alternates[1]!.reasons).toEqual(["One leg.", aside.message]);
      expect(alternates[0]!.reasons).toEqual([]);
      expect(options(made.slots["core:0"]).map((c) => c.id)).not.toContain("snapDown");
    });

    it("then the library's usual offers: easier versions first, the move's family, its patterns — dosed the same way, clean on the day, three at most", () => {
      const lift = workoutDocSchema.parse({
        ...calmDoc(),
        parts: [{ purpose: "main", format: "straight", items: [
          { kind: "exercise", libraryId: "singleLegBridge", dose: { sets: 2, reps: 10 } },
          { kind: "exercise", libraryId: "deadBug", dose: { sets: 2, reps: 8 } },
        ] }],
      });
      const rec = EXERCISES.find((e) => e.id === "singleLegBridge")!;
      const made = materializeDocBuild(lift, input(ctxAt(2)));
      const offers = made.slots["core:0"]!.offers!;
      expect(offers.length).toBeGreaterThan(0);
      expect(offers.length).toBeLessThanOrEqual(3);
      // Easier first: the move's own easier version, when the day allows it.
      expect(rec.easier.length).toBeGreaterThan(0);
      expect(offers[0]).toMatchObject({ id: rec.easier[0], reasons: ["An easier version"] });
      const tier = ["An easier version", "Another version", "The same movement"];
      const tiers = offers.map((o) => tier.indexOf(o.reasons[0]!));
      expect(tiers.every((t, i) => t >= 0 && (i === 0 || t >= tiers[i - 1]!))).toBe(true);
      for (const o of offers) {
        const r = EXERCISES.find((e) => e.id === o.id)!;
        // Never a move the document holds, dosed another way, or a jump in a move's place that is not one.
        expect(["singleLegBridge", "deadBug"]).not.toContain(o.id);
        expect(r.dose.type).toBe("reps");
        expect(r.contraction).not.toContain("plyometric");
        // Clean on the day: the validator raises nothing at it as the item's alternate.
        const probe = workoutDocSchema.parse({ ...lift, parts: [{ ...lift.parts[0]!, items: [{ ...lift.parts[0]!.items[0]!, alternates: [{ libraryId: o.id }] }, lift.parts[0]!.items[1]!] }] });
        expect(validateWorkoutDoc(probe, ctxAt(2)).filter((i) => i.path.startsWith("parts[0].items[0].alternates["))).toEqual([]);
        // Its steps are the slot's, with it in place; its record rides the build.
        expect(o.steps.length).toBeGreaterThan(0);
        expect(o.steps.every((s) => s.exerciseId === o.id && s.slotKey === "core:0")).toBe(true);
        expect(made.build.exercises[o.id]).toBeDefined();
      }
      // Never one the item already plans as an alternate: it is offered once, as planned.
      const planning = workoutDocSchema.parse({ ...lift, parts: [{ ...lift.parts[0]!, items: [{ ...lift.parts[0]!.items[0]!, alternates: [{ libraryId: rec.easier[0]! }] }, lift.parts[0]!.items[1]!] }] });
      const both = materializeDocBuild(planning, input(ctxAt(2))).slots["core:0"]!;
      expect(both.alternates!.map((a) => a.id)).toEqual([rec.easier[0]]);
      expect(both.offers!.map((o) => o.id)).not.toContain(rec.easier[0]);
      // Never a move the document holds — the bridge, the easier version, is in it here.
      const withBridge = workoutDocSchema.parse({ ...lift, parts: [{ ...lift.parts[0]!, items: [lift.parts[0]!.items[0]!, { kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 10 } }] }] });
      expect(materializeDocBuild(withBridge, input(ctxAt(2))).slots["core:0"]!.offers!.map((o) => o.id)).not.toContain("bridge");
      // Set aside by the athlete (a cost): never an offer.
      const aside = materializeDocBuild(lift, input({ ...ctxAt(2), excluded: [offers[0]!.id] }));
      expect(aside.slots["core:0"]!.offers!.map((o) => o.id)).not.toContain(offers[0]!.id);
    });

    it("on a flare day a move that isn't flare-safe is never offered as clean: judged in the item's place, as it would be played", () => {
      const upper = (alternates: Array<{ libraryId: string }> = []) =>
        workoutDocSchema.parse({
          ...calmDoc(),
          parts: [{ purpose: "main", format: "straight", items: [
            { kind: "exercise", libraryId: "bandPullApart", dose: { sets: 2, reps: 12 }, ...(alternates.length > 0 ? { alternates } : {}) },
          ] }],
        });
      const options = (slot: DocSlot | undefined) => [...(slot?.alternates ?? []), ...(slot?.offers ?? [])].map((c) => c.id);
      // A calm jaw: the face-down Y-T-W is one of the library's usual offers for the band pull-apart.
      expect(materializeDocBuild(upper(), input(ctxAt(1))).slots["core:0"]!.offers!.map((o) => o.id)).toContain("proneYTW");
      // A flare (5 to 7): never among the offers.
      for (const pre of [5, 6, 7]) {
        expect(options(materializeDocBuild(upper(), input(ctxAt(pre))).slots["core:0"]), `pre ${pre}`).not.toContain("proneYTW");
      }
      // Planned, it comes after the clean ones, saying why — the validator alone would have called it clean.
      const planned = upper([{ libraryId: "proneYTW" }, { libraryId: "deadBug" }]);
      expect(validateWorkoutDoc(planned, ctxAt(6, true)).filter((i) => i.path.startsWith("parts[0].items[0].alternates[0]"))).toEqual([]);
      const alternates = materializeDocBuild(planned, input(ctxAt(6, true))).slots["core:0"]!.alternates!;
      expect(alternates.map((a) => a.id)).toEqual(["deadBug", "proneYTW"]);
      expect(alternates[1]!.reasons.join(" ")).toMatch(/flare/);
    });

    it("alternates that together would take the document past its size bound are tried one by one; one that alone does is not offered", () => {
      // The bridge at 4 s a rep, its alternate at 8 s: each alternate doubles its item's time.
      const big = (reps: number) =>
        workoutDocSchema.parse({
          ...calmDoc(),
          parts: [
            {
              purpose: "main",
              format: "straight",
              items: [0, 1].map(() => ({ kind: "exercise", libraryId: "bridge", dose: { sets: 20, reps, restSec: 0 }, alternates: [{ libraryId: "broadJumpStick" }] })),
            },
          ],
        });
      const minutes = (doc: WorkoutDoc, swapped: number) =>
        deriveDoc({ ...doc, parts: [{ ...doc.parts[0]!, items: doc.parts[0]!.items.map((it, i) => (i < swapped ? { ...it, libraryId: "broadJumpStick" } : it)) as WorkoutDoc["parts"][0]["items"] }] }, EXERCISES).estimatedMinutes;
      // About 180 minutes an item: both alternates in are past 600 minutes, either alone is not.
      expect([minutes(big(135), 0), minutes(big(135), 1), minutes(big(135), 2)].map((m) => m <= 600)).toEqual([true, true, false]);
      const pair = materializeDocBuild(big(135), input());
      expect(pair.slots["core:0"]!.alternates!.map((a) => a.id)).toEqual(["broadJumpStick"]);
      expect(pair.slots["core:1"]!.alternates!.map((a) => a.id)).toEqual(["broadJumpStick"]);
      expect(pair.slots["core:1"]!.alternates![0]!.steps.every((s) => s.exerciseId === "broadJumpStick" && s.slotKey === "core:1")).toBe(true);
      // About 250 minutes an item: even one alternate is past it — none offered, and the build is made.
      expect([minutes(big(188), 0), minutes(big(188), 1)].map((m) => m <= 600)).toEqual([true, false]);
      const none = materializeDocBuild(big(188), input());
      expect(Object.values(none.slots).some((s) => s.alternates)).toBe(false);
      expect(none.build.steps).toEqual(playerStepsFromDoc(big(188), EXERCISES));
    });

    it("the day's own swap drops the cue with the move it was said of", () => {
      const cued = withPower([
        { kind: "exercise", libraryId: "snapDown", dose: { sets: 2, reps: 5 }, cue: "Land soft.", alternates: [{ libraryId: "tempoSquat" }] },
      ]);
      const gated = gateDoc(cued, ctxAt(6, true));
      expect(gated.swaps.map((s) => s.to)).toEqual(["tempoSquat"]);
      expect(gated.doc.parts[0]!.items[0]).not.toHaveProperty("cue");
      expect(materializeDocBuild(gated.doc, input(ctxAt(6, true))).slots["accessory:0"]?.cue).toBeUndefined();
      // Played as written, the cue stays.
      expect(materializeDocBuild(cued, input(ctxAt(1))).slots["accessory:0"]?.cue).toBe("Land soft.");
    });
  });
});

describe("a document build's targets (CUJ R4)", () => {
  const location = { id: "home", name: "Home", equipment: [], implements: {} };
  it("each move's target is its item's dose — reps, a range, a load, a hold — so the sheet and Today read as the builder does", () => {
    const doc = workoutDocSchema.parse({
      ...calmDoc(),
      parts: [
        { purpose: "main", format: "straight", items: [
          { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 3, reps: 8, load: { typed: "25 lb", kg: 11.34 } }, progression: "Add a rep next time." },
          { kind: "exercise", libraryId: "bwSplitSquat", dose: { sets: 3, reps: { min: 5, max: 8 }, perSide: true } },
        ] },
        { purpose: "accessory", format: "holds", items: [{ kind: "exercise", libraryId: "wallSit", dose: { sets: 1, holdSec: 45 } }] },
      ],
    });
    const made = materializeDocBuild(doc, { date: DAY, location, checks: {}, library: EXERCISES, judge: ctxAt(1) });
    const recOf = (id: string) => EXERCISES.find((e) => e.id === id)!;
    const blank = { graduate: null, last: null, lastDate: null, action: "hold" };
    expect(made.build.targets).toEqual({
      gobletSquat: { lo: recOf("gobletSquat").dose.range[0], hi: recOf("gobletSquat").dose.range[1], type: "reps", reps: 8, secs: null, w: { v: 25, u: "lb" }, note: "Add a rep next time.", ...blank },
      bwSplitSquat: { lo: 5, hi: 8, type: "reps", reps: null, secs: null, w: null, note: "", ...blank },
      wallSit: { lo: recOf("wallSit").dose.range[0], hi: recOf("wallSit").dose.range[1], type: "time", reps: null, secs: 45, w: null, note: "", ...blank },
    });
    // The lines the targets make, as Today's lead and the sheet say them with no words of the document's own.
    const lead = sessionLead({ ...made.build, items: made.build.items }, 3);
    expect(lead.moves.map((m) => m.dose)).toEqual(["3 × 8 @ 25 lb", "3 × 5–8 each side", "45 s"]);
  });

  it("a move in two items has the first's target (the targets are by move, as an engine build's are)", () => {
    const doc = workoutDocSchema.parse({
      ...calmDoc(),
      parts: [
        { purpose: "warmup", format: "straight", items: [{ kind: "exercise", libraryId: "gobletSquat", dose: { sets: 1, reps: 5 } }] },
        { purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "gobletSquat", dose: { sets: 3, reps: 8 } }] },
      ],
    });
    const made = materializeDocBuild(doc, { date: DAY, location, checks: {}, library: EXERCISES, judge: ctxAt(1) });
    expect(made.build.targets.gobletSquat).toMatchObject({ reps: 5 });
  });
});

describe("a part played in rounds (Stage 2 whole-branch I-1)", () => {
  const location = { id: "home", name: "Home", equipment: [], implements: {} };
  it("⇄'s options are numbered as the slot is, round by round, so a swap in round 2 splices that round on; builds of an older version are made again", () => {
    const doc = workoutDocSchema.parse({
      ...calmDoc(),
      parts: [{ purpose: "main", format: "holds", rounds: 3, items: [
        { kind: "exercise", libraryId: "wallSit", dose: { sets: 1, holdSec: 30 }, alternates: [{ libraryId: "splitSquatHold" }] },
        { kind: "exercise", libraryId: "birdDog", dose: { sets: 1, reps: 8 } },
      ] }],
    });
    const made = materializeDocBuild(doc, { date: DAY, location, checks: {}, library: EXERCISES, judge: ctxAt(1) });
    const numbers = (steps: readonly { kind: string; slotKey: string; setIndex: number | null; setCount: number | null }[]) =>
      steps.filter((s) => s.kind !== "rest" && s.slotKey === "core:0").map((s) => [s.setIndex, s.setCount]);
    expect(numbers(made.build.steps)).toEqual([[0, 3], [1, 3], [2, 3]]);
    const options = [...(made.slots["core:0"]?.alternates ?? []), ...(made.slots["core:0"]?.offers ?? [])];
    expect(options.length).toBeGreaterThan(0);
    for (const o of options) expect(numbers(o.steps), o.id).toEqual([[0, 3], [1, 3], [2, 3]]);
    // ⇄ splices set by set: each round's set into its own round, never the three back to back.
    const spliced = Swapping.splice(made.build.steps, "core:0", options[0]!.steps);
    const alt = options[0]!.id;
    expect(spliced.filter((s) => s.kind !== "rest").map((s) => s.exerciseId)).toEqual([alt, "birdDog", alt, "birdDog", alt, "birdDog"]);
    // "No equipment" builds in a bare room (CUJ R8), after 84532ee's doc-build-6 (R16): every older build is made again.
    expect(DOC_BUILD_VERSION).toBe("doc-build-7");
  });
});

describe("libraryOffers (the library's usual offers for a slot)", () => {
  const find = (id: string) => EXERCISES.find((e) => e.id === id);
  const none = { ids: new Set<string>(), keys: new Set<string>() };
  it("are dosed as the move is, never a jump for a move that is not one; nine at most, its own move never", () => {
    for (const id of ["tempoSquat", "gobletSquat", "wallSit", "bridge", "deadBug"]) {
      const rec = find(id)!;
      const kind = (t: string) => (t === "carry" ? "time" : t);
      const offers = libraryOffers(rec, EXERCISES, find, none);
      expect(offers.length, id).toBeGreaterThan(0);
      expect(offers.length).toBeLessThanOrEqual(9);
      for (const o of offers) {
        expect(o.to.id).not.toBe(id);
        expect(kind(o.to.dose.type), `${id} → ${o.to.id}`).toBe(kind(rec.dose.type));
        expect(o.to.contraction, `${id} → ${o.to.id}`).not.toContain("plyometric");
      }
    }
    // A jump's own: other jumps may stand in.
    expect(libraryOffers(find("snapDown")!, EXERCISES, find, none).some((o) => o.to.contraction.includes("plyometric"))).toBe(true);
  });

  it("never a move away names: one the item plans, or a version of a move held elsewhere", () => {
    const rec = find("tempoSquat")!;
    const first = libraryOffers(rec, EXERCISES, find, none)[0]!.to;
    expect(libraryOffers(rec, EXERCISES, find, { ids: new Set([first.id]), keys: new Set() }).map((o) => o.to.id)).not.toContain(first.id);
    expect(libraryOffers(rec, EXERCISES, find, { ids: new Set(), keys: new Set([Swapping.moveKeyOf(first)]) }).map((o) => o.to.id)).not.toContain(first.id);
  });

  // CUJ R9: a mobility, release, breathing or condition-care move is offered what eases the same area for the same end.
  const GENTLE = new Set(["mobility", "breathe", "release"]);
  const gentle = (r: (typeof EXERCISES)[number]) =>
    r.patterns.some((p) => GENTLE.has(p)) || r.purposes.some((p) => p === "mobility" || p === "stretch" || p === "condition-care");
  const shares = <T,>(a: readonly T[], b: readonly T[]) => a.some((x) => b.includes(x));

  it("a gentle move (mobility, release, breathing, condition care) is offered only moves of a region and a purpose it has (CUJ R9)", () => {
    const soft = EXERCISES.filter(gentle);
    expect(soft.length).toBeGreaterThan(20);
    let offered = 0;
    for (const rec of soft) {
      for (const o of libraryOffers(rec, EXERCISES, find, none)) {
        offered += 1;
        expect(shares(o.to.regions, rec.regions), `${rec.id} → ${o.to.id}: a region`).toBe(true);
        expect(shares(o.to.purposes, rec.purposes), `${rec.id} → ${o.to.id}: a purpose`).toBe(true);
      }
    }
    expect(offered).toBeGreaterThan(50);
  });

  it("says why honestly: \"The same movement\" only when the pattern and the region are the move's too; else what it eases or works, in plain words (CUJ R9)", () => {
    const reasons = new Set<string>();
    for (const rec of EXERCISES) {
      for (const o of libraryOffers(rec, EXERCISES, find, none)) {
        reasons.add(o.reason);
        if (o.reason === "The same movement") {
          expect(shares(o.to.patterns, rec.patterns) && shares(o.to.regions, rec.regions), `${rec.id} → ${o.to.id}`).toBe(true);
        }
      }
    }
    for (const r of reasons) expect(r, r).toMatch(/^(An easier version|Another version|The same movement|Also eases the [a-z ]+|Also works the [a-z ]+|Works the [a-z ]+)$/);
    expect([...reasons].some((r) => r.startsWith("Also eases the "))).toBe(true);
    // A neck move's: the neck by name.
    const neck = EXERCISES.filter((r) => gentle(r) && r.regions.includes("neck"));
    expect(neck.flatMap((r) => libraryOffers(r, EXERCISES, find, none)).map((o) => o.reason)).toContain("Also eases the neck");
  });
});

describe("the materialised build the player's tests play (packages/ui/test/player/doc-build-fixture.json)", () => {
  const location = { id: "home", name: "Home", equipment: [], implements: {} };
  it("is what materializeDocBuild makes of its document today — regenerate the fixture when this fails", () => {
    const doc = workoutDocSchema.parse({
      ...calmDoc(),
      parts: [{ purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "tempoSquat", dose: { sets: 2, reps: 5, restSec: 45 }, alternates: [{ libraryId: "bwSplitSquat", why: "One leg." }, { libraryId: "snapDown" }, { libraryId: "gobletSquat" }] },
        { kind: "exercise", libraryId: "deadBug", dose: { sets: 2, reps: 8, restSec: 30 } },
      ] }],
    });
    // TMJ at 6 (a flare) and feeling off (jumps kept out), the split squat set aside by the athlete.
    const judge: ValidateCtx = { ...ctxAt(6, true), excluded: ["bwSplitSquat"] };
    const made = materializeDocBuild(doc, { date: DAY, location, checks: {}, library: EXERCISES, judge });
    const fixture: unknown = JSON.parse(readFileSync(fileURLToPath(new URL("../../../packages/ui/test/player/doc-build-fixture.json", import.meta.url)), "utf8"));
    expect({
      minutes: made.build.minutes, plannedSeconds: made.build.plannedSeconds, steps: made.build.steps, items: made.build.items,
      alternatives: made.build.alternatives, params: made.build.params, exercises: Object.keys(made.build.exercises).sort(), slots: made.slots,
    }).toEqual(fixture);
  });
});

describe("slotsForDay (Start of a build sent to the watch)", () => {
  const location = { id: "home", name: "Home", equipment: [], implements: {} };
  it("takes off what ⇄ offers that the day's reading now keeps out, keeps the rest and what the slot says", () => {
    const doc = workoutDocSchema.parse({
      ...calmDoc(),
      parts: [{ purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "tempoSquat", dose: { sets: 2, reps: 5 }, cue: "Slow down.", alternates: [{ libraryId: "snapDown" }, { libraryId: "bwSplitSquat" }] },
      ] }],
    });
    const sent = materializeDocBuild(doc, { date: DAY, location, checks: {}, library: EXERCISES, judge: ctxAt(1) }).slots;
    expect(sent["core:0"]!.alternates!.map((a) => a.id)).toEqual(["snapDown", "bwSplitSquat"]);
    const now = slotsForDay(sent, doc, ctxAt(6, true));
    expect(now["core:0"]!.alternates!.map((a) => a.id)).toEqual(["bwSplitSquat"]);
    expect(now["core:0"]!.cue).toBe("Slow down.");
    // An offer stays only when it costs nothing in the item's place today (whole-branch M-2): any issue takes it off.
    const shut = (now["core:0"]!.offers ?? []).map((o) => o.id);
    for (const o of sent["core:0"]!.offers ?? []) {
      const probe = workoutDocSchema.parse({ ...doc, parts: [{ ...doc.parts[0]!, items: [{ ...doc.parts[0]!.items[0]!, libraryId: o.id, alternates: undefined }] }] });
      const costs = validateWorkoutDoc(probe, ctxAt(6, true)).some((i) => i.path === "parts[0].items[0].libraryId");
      expect(shut.includes(o.id), o.id).toBe(!costs);
    }
    // The same day: nothing changes.
    expect(slotsForDay(sent, doc, ctxAt(1))).toEqual(sent);
    // A snapshot the validator can no longer read at all (here past the size bound): nothing is offered — what the
    // slot says stays.
    const huge = workoutDocSchema.parse({
      ...doc,
      parts: [{ ...doc.parts[0]!, items: [0, 1, 2, 3].map(() => ({ ...doc.parts[0]!.items[0]!, dose: { sets: 20, reps: 188, restSec: 0 } })) }],
    });
    expect(slotsForDay(sent, huge, ctxAt(1))).toEqual({ "core:0": { cue: "Slow down." } });
  });

  it("a day turned into a flare: an offer that costs anything is taken off; a planned alternate stays, the flare cost in its reasons (whole-branch M-2)", () => {
    const doc = workoutDocSchema.parse({
      ...calmDoc(),
      parts: [{ purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "bandPullApart", dose: { sets: 2, reps: 5 }, alternates: [{ libraryId: "pushupPullThrough", why: "A push and a pull." }] },
      ] }],
    });
    const sent = materializeDocBuild(doc, { date: DAY, location, checks: {}, library: EXERCISES, judge: ctxAt(1) }).slots;
    // Sent on a calm day: the prone Y-T-W is offered, the planned alternate costs nothing.
    expect((sent["core:0"]!.offers ?? []).map((o) => o.id)).toContain("proneYTW");
    expect(sent["core:0"]!.alternates!.map((a) => [a.id, a.reasons])).toEqual([["pushupPullThrough", ["A push and a pull."]]]);
    const now = slotsForDay(sent, doc, ctxAt(6, true));
    // Started on a flare day: the Y-T-W is not flare-safe — a cost, so no longer an offer.
    expect((now["core:0"]!.offers ?? []).map((o) => o.id)).not.toContain("proneYTW");
    const alt = now["core:0"]!.alternates![0]!;
    expect(alt.id).toBe("pushupPullThrough");
    expect(alt.reasons[0]).toBe("A push and a pull.");
    expect(alt.reasons.slice(1)).toEqual([expect.stringContaining("flare")]);
    expect(alt.steps).toEqual(sent["core:0"]!.alternates![0]!.steps);
  });
});

describe("a document saved with run segments among its moves (before designed runs, §8 §3)", () => {
  /** The landings workout with a 10-minute easy run after it: what the coach could propose before run_mixed. */
  const mixed = (): WorkoutDoc => {
    const doc = landingsDoc();
    return workoutDocSchema.parse({ ...doc, parts: [...doc.parts, { purpose: "run", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] }] });
  };

  it("still plays as it did: the rule refuses saving one, never playing one already saved", () => {
    const doc = mixed();
    expect(validateWorkoutDoc(doc, ctxAt(1)).filter((i) => i.code === "run_mixed")).toHaveLength(1);
    expect(gateDoc(doc, ctxAt(1)).blocked).toEqual([]);
  });

  it("a save refuses it, today or ahead", () => {
    expect(judgeDoc(mixed(), ctxAt(1)).errors.map((i) => i.code)).toEqual(["run_mixed"]);
    // On a day a gate refuses a move (the save's own swap pass), it is still refused, never turned into a warning.
    const today = judgeDoc(mixed(), ctxAt(9, true));
    expect(today.errors.map((i) => i.code)).toContain("run_mixed");
    expect(today.warnings.map((i) => i.code)).not.toContain("run_mixed");
    const ahead = { ...ctxAt(1), day: { date: "2026-10-09", today: DAY, readings: {} } };
    expect(judgeDoc(mixed(), ahead).errors.map((i) => i.code)).toEqual(["run_mixed"]);
  });
});
