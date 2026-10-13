/**
 * A DOCUMENT PART PLAYED IN ROUNDS, AND A MOVE IN TWO ITEMS (Stage 2 whole-branch review I-1), played through the real
 * adapter (`playerStepsFromDoc`): each round's set has its own number, so ⇄ in round 2 swaps that round on and the
 * rounds after it, and a hold to max played three rounds is three sets; the same move in a warm-up and the main part
 * keeps a set for each. ⇄'s choices are built the way the worker builds them: the slot's steps with the move in the
 * item's place.
 */
import { describe, expect, it } from "vitest";
import type { DocSlotDto, SessionBuildDto } from "@rg/api-client";
import { workoutDocSchema, type WorkoutDoc } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import type { SlotChoice } from "@rg/session-engine";
import { playerStepsFromDoc } from "@rg/workout";
import { beginPlayer, confirmLog, doneHold, heldBefore, logFor, logTarget, next, playerData, saveOf, swapSlot, type PlayerState } from "../../src/player/run.js";
import { docBuild, docView, exercise, SLOT, T0 } from "./fixtures.js";

const S = 1000;

const docOf = (parts: unknown[]): WorkoutDoc =>
  workoutDocSchema.parse({ version: 1, title: "Rounds", intent: { summary: "S", goals: [], focus: [], effort: "maintain" }, parts, source: { kind: "studio" } });

/** A slot's choice: the slot's steps with `id` in the item's place (`parts[part].items[item]`), as the worker makes it. */
function choice(doc: WorkoutDoc, part: number, item: number, slotKey: string, id: string): SlotChoice {
  const parts = doc.parts.map((p, i) => (i === part ? { ...p, items: p.items.map((it, j) => (j === item && it.kind === "exercise" ? { ...it, libraryId: id } : it)) } : p));
  const steps = playerStepsFromDoc({ ...doc, parts }, EXERCISES).filter((s) => s.kind !== "rest" && s.slotKey === slotKey);
  return { id, name: exercise(id).name, reasons: [], steps, moveKey: id, pairing: { doseType: "time", patterns: [], positionGroup: "standing" } };
}

function built(doc: WorkoutDoc, slots: Record<string, DocSlotDto>, extra: string[] = []): SessionBuildDto {
  const steps = playerStepsFromDoc(doc, EXERCISES);
  const ids = [...new Set([...steps.flatMap((s) => (s.exerciseId ? [s.exerciseId] : [])), ...extra])];
  return docBuild({
    steps,
    plannedSeconds: steps.reduce((n, s) => n + s.seconds + s.prepGap, 0),
    exercises: Object.fromEntries(ids.map((id) => [id, exercise(id)])),
    fromDoc: { rev: 1, swaps: [], blocked: [], slots },
  });
}

const start = (b: SessionBuildDto): PlayerState => {
  const src = { workoutId: SLOT, build: b, view: docView(), profiles: [] };
  return beginPlayer(src, playerData(src), { performedId: "perf-1", now: T0 });
};

/** Three rounds of a wall sit (30 s) and a bird dog: no rest between. */
const threeRounds = (max = false) =>
  docOf([{ purpose: "main", format: "holds", rounds: 3, items: [
    { kind: "exercise", libraryId: "wallSit", dose: { sets: 1, holdSec: 30, ...(max ? { max: true } : {}) } },
    { kind: "exercise", libraryId: "birdDog", dose: { sets: 1, reps: 8 } },
  ] }]);

describe("a part played in rounds", () => {
  it("⇄ in round 2 plays the new move that round and the next, each in its own round", () => {
    const doc = threeRounds();
    const alt = choice(doc, 0, 0, "core:0", "splitSquatHold");
    const b = built(doc, { "core:0": { alternates: [alt] } }, ["splitSquatHold"]);
    let s = start(b);
    expect(s.live.steps.map((st) => [st.exerciseId, st.setIndex])).toEqual([
      ["wallSit", 0], ["birdDog", 0], ["wallSit", 1], ["birdDog", 1], ["wallSit", 2], ["birdDog", 2],
    ]);
    s = next(next(s, T0), T0);
    expect(s.index).toBe(2);
    s = swapSlot(s, playerData({ build: b, profiles: [] }), "core:0", alt, T0);
    expect(s.live.steps.map((st) => st.exerciseId)).toEqual(["wallSit", "birdDog", "splitSquatHold", "birdDog", "splitSquatHold", "birdDog"]);
  });

  it("a hold to max played three rounds is three sets, each its own time", () => {
    const b = built(threeRounds(true), { "core:0": { max: true } });
    let s = start(b);
    // Each round: the wall sit's 8 s get-ready, then held to Done; the bird dog skipped.
    let at = T0;
    for (const held of [50, 45, 40]) {
      at += (8 + held) * S;
      s = doneHold(s, at);
      s = next(s, at);
    }
    const save = saveOf(s, { endedAt: new Date(at).toISOString() });
    expect(save.entries.find((e) => e.id === "wallSit")!.sets.map((x) => x.secs)).toEqual([50, 45, 40]);
  });
});

describe("the same move in two items", () => {
  /** A wall sit warm-up (20 s), a rest, then the main part's wall sit to max (45 s target). */
  const twoItems = () =>
    docOf([
      { purpose: "warmup", format: "holds", items: [{ kind: "exercise", libraryId: "wallSit", dose: { sets: 1, holdSec: 20 } }] },
      { purpose: "main", format: "holds", items: [
        { kind: "exercise", libraryId: "wallSit", dose: { sets: 1, holdSec: 45, max: true } },
        { kind: "rest", seconds: 30 },
      ] },
    ]);

  it("keeps a set for each: the warm-up's 20 s is never the main's; the main skipped saves only the warm-up's", () => {
    const b = built(twoItems(), { "core:0": { max: true } });
    let s = start(b);
    expect(s.live.steps.map((st) => [st.slotKey, st.exerciseId])).toEqual([["prep:0", "wallSit"], ["core:0", "wallSit"], ["core:0", null]]);
    // The warm-up held in full (8 s get-ready + 20 s), the main skipped.
    s = next(s, T0 + 28 * S);
    s = next(s, T0 + 30 * S);
    const save = saveOf(s, { endedAt: new Date(T0 + 40 * S).toISOString() });
    expect(save.entries.find((e) => e.id === "wallSit")!.sets.map((x) => x.secs)).toEqual([20]);
    expect(s.live.entries.wallSit!.sets.map((x) => x.done)).toEqual([true, false]);
  });

  it("the Edit card after the main's hold to max edits the main's set, and says so", () => {
    const b = built(twoItems(), { "core:0": { max: true } });
    let s = next(start(b), T0 + 28 * S);
    s = doneHold(s, T0 + (28 + 8 + 50) * S);
    expect(s.live.steps[s.index]!.kind).toBe("rest");
    expect(heldBefore(s)).toEqual({ secs: 50, sides: null });
    const held = logFor(s)!;
    expect(logTarget(s, held)).toMatchObject({ setIndex: 0, secs: 50 });
    s = confirmLog(s, { secs: 52 }, {}, T0 + 90 * S, held);
    expect(s.live.entries.wallSit!.sets.map((x) => x.secs)).toEqual([20, 52]);
  });
});
