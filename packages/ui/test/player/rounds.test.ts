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
import {
  beginPlayer,
  confirmLog,
  doneHold,
  fromLiveSession,
  heldBefore,
  logFor,
  logTarget,
  next,
  playerData,
  prev,
  reopen,
  saveOf,
  stepView,
  swapSlot,
  toLiveSession,
  type PlayerState,
} from "../../src/player/run.js";
import { elapsedMs } from "../../src/player/timer.js";
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

describe("an open hold: a timed move to max with no target, played as a set (Stage 2 whole-branch M-3)", () => {
  /** Two sets of a wall sit to max with no hold, a rest between. */
  const open = () => built(docOf([{ purpose: "main", format: "straight", items: [
    { kind: "exercise", libraryId: "wallSit", dose: { sets: 2, max: true, restSec: 30 } },
    { kind: "exercise", libraryId: "birdDog", dose: { sets: 1, reps: 8 } },
  ] }]), { "core:0": { max: true } });

  it("counts only on Confirm: arrived at, it is not done; skipped, it logs nothing", () => {
    const s = start(open());
    expect(s.live.steps[0]).toMatchObject({ kind: "set", exerciseId: "wallSit" });
    expect(s.live.entries.wallSit!.sets[0]!.done).toBe(false);
    const skipped = next(s, T0 + 30 * S);
    const save = saveOf(skipped, { endedAt: new Date(T0 + 40 * S).toISOString() });
    expect(save.entries.find((e) => e.id === "wallSit")).toBeUndefined();
    expect(save.done.map((d) => d.id)).not.toContain("wallSit");
    // No step done either: the rest after it is no step.
    expect(save.stepsDone).toBe(0);
  });

  it("confirmed, it counts at the card's seconds; a second set skipped is never saved with the first's", () => {
    let s = start(open());
    s = confirmLog(s, { secs: 95 }, {}, T0 + 95 * S, logFor(s));
    expect(s.live.entries.wallSit!.sets.map((x) => [x.done, x.secs])).toEqual([[true, 95], [false, 95]]);
    // The rest, then the second set: skipped.
    s = next(s, T0 + 100 * S);
    expect(s.live.steps[s.index]).toMatchObject({ kind: "set", exerciseId: "wallSit", setIndex: 1 });
    s = next(s, T0 + 110 * S);
    const save = saveOf(s, { endedAt: new Date(T0 + 120 * S).toISOString() });
    expect(save.entries.find((e) => e.id === "wallSit")!.sets.map((x) => x.secs)).toEqual([95]);
  });

  it("going back to one confirmed keeps it", () => {
    let s = start(open());
    s = confirmLog(s, { secs: 95 }, {}, T0 + 95 * S, logFor(s));
    s = prev(s, T0 + 96 * S);
    expect(s.index).toBe(0);
    expect(s.live.entries.wallSit!.sets[0]).toMatchObject({ done: true, secs: 95 });
  });
});

describe("a hold to max reopened far past its target (Stage 2 whole-branch M-4)", () => {
  /** A rest of 30 s, then a wall sit to max: its 8 s get-ready, a 40 s target. Far past it: 2 × 40 + 120 = 200 s held. */
  const restThenHold = () => built(docOf([{ purpose: "main", format: "holds", items: [
    { kind: "exercise", libraryId: "birdDog", dose: { sets: 1, reps: 8 } },
    { kind: "rest", seconds: 30 },
    { kind: "exercise", libraryId: "wallSit", dose: { sets: 1, holdSec: 40, max: true } },
  ] }]), { "core:1": { max: true } });
  /** Kept on the device at `at` (the app killed then), opened again at `now`. */
  const reopened = (s: PlayerState, at: number, now: number, b: SessionBuildDto) =>
    reopen(fromLiveSession(toLiveSession(s, at), { workoutId: SLOT, build: b })!, now, { autoAdvance: true });

  it("killed mid-hold and opened far past the target: back at the hold's start, paused, the session's time stopped where the hold began", () => {
    const b = restThenHold();
    let s = next(next(start(b), T0 + 10 * S), T0 + 40 * S);
    expect(s.live.steps[s.index]!.exerciseId).toBe("wallSit");
    const back = reopened(s, T0 + 60 * S, T0 + 40 * S + (8 + 201) * S, b);
    expect(back.index).toBe(s.index);
    expect(back.paused).toBe(true);
    expect(stepView(back, T0 + 3_600 * S)).toMatchObject({ phase: "ready", elapsedMs: 0 });
    expect(elapsedMs(back.session, T0 + 3_600 * S)).toBe(40 * S);
    // Not that far: the hold carries on, counted.
    const near = reopened(s, T0 + 60 * S, T0 + 40 * S + (8 + 200) * S, b);
    expect(near.paused).toBe(false);
    expect(stepView(near, T0 + 40 * S + 208 * S)).toMatchObject({ phase: "hold", elapsedMs: 208 * S });
  });

  it("killed mid-rest and opened half an hour later: the hold the clock ran into is back at its start, paused", () => {
    const b = restThenHold();
    const s = next(start(b), T0 + 10 * S);
    expect(s.live.steps[s.index]!.kind).toBe("rest");
    const back = reopened(s, T0 + 15 * S, T0 + 1_800 * S, b);
    expect(back.live.steps[back.index]!.exerciseId).toBe("wallSit");
    expect(back.paused).toBe(true);
    expect(stepView(back, T0 + 1_900 * S)).toMatchObject({ phase: "ready", elapsedMs: 0 });
    // The session ran to the end of the rest: 10 s, then 30 s of rest.
    expect(elapsedMs(back.session, T0 + 1_900 * S)).toBe(40 * S);
  });

  it("a hold that is not to max is never touched (the clock already ends it)", () => {
    const b = built(docOf([{ purpose: "main", format: "holds", items: [{ kind: "exercise", libraryId: "wallSit", dose: { sets: 2, holdSec: 40 } }] }]), {});
    const s = start(b);
    const back = reopened(s, T0 + 5 * S, T0 + 1_800 * S, b);
    expect(back.finished).toBe(true);
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
