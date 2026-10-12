/**
 * WHAT A DOCUMENT'S ITEMS SAY, PLAYED (Stage 2 spec §11; Task 8). A document workout's build carries, beside its steps,
 * what each slot's item says (`fromDoc.slots`): a hold TO MAX counts up past its target and Done logs the seconds held
 * (never capped — a hold-time objective reads them); ⇄ offers the item's planned alternates first, then the engine's
 * usual offers. An engine build carries none of it and plays exactly as before. Expectations worked out by hand from
 * the fixture's steps (fixtures.ts): the wall sit is step 7, an 8 s get-ready then a 40 s target.
 */
import { describe, expect, it } from "vitest";
import type { Alternative, Step } from "@rg/session-engine";
import {
  beginPlayer,
  doneHold,
  endSession,
  fromLiveSession,
  goesToMax,
  next,
  playerData,
  saveOf,
  settle,
  stepView,
  toLiveSession,
  type PlayerState,
} from "../../src/player/run.js";
import { offeredNow } from "../../src/player/swap.js";
import { build, docBuild, docView, PLANNED_WHY, plannedSplitSquat, SLOT, T0, view } from "./fixtures.js";

const S = 1000;
const docSrc = () => ({ workoutId: SLOT, build: docBuild(), view: docView(), profiles: ["tmj"] });
const engineSrc = () => ({ workoutId: SLOT, build: build({ newMove: null }), view: view({ newMove: null }), profiles: ["tmj"] });

/** At the wall sit (step 7), its timer started at `at`. */
function atWallSit(src: ReturnType<typeof docSrc>, at = T0): PlayerState {
  let s = beginPlayer(src, playerData(src), { performedId: "perf-1", now: T0 });
  while (s.index < 7) s = next(s, at);
  expect(s.live.steps[7]!.exerciseId).toBe("wallSit");
  return s;
}
const wallSitSet = (s: PlayerState) => s.live.entries.wallSit!.sets[0]!;

describe("a hold to max", () => {
  it("counts up past its target and never runs out: the clock does not move it on", () => {
    const s = atWallSit(docSrc());
    expect(stepView(s, T0 + 5 * S)).toMatchObject({ phase: "ready", remainingMs: 3 * S });
    // 70 s into a 40 s target: still holding.
    const later = settle(s, T0 + 78 * S, { autoAdvance: true });
    expect(later.index).toBe(7);
    expect(stepView(later, T0 + 78 * S)).toMatchObject({ phase: "hold", elapsedMs: 78 * S, phaseMs: 40 * S });
  });

  it("Done logs the seconds held, past the target — on the set, the move's time and the save", () => {
    const done = doneHold(atWallSit(docSrc()), T0 + 78 * S);
    expect(done.index).toBe(8);
    expect(wallSitSet(done)).toMatchObject({ done: true, secs: 70 });
    const save = saveOf(done, { endedAt: new Date(T0 + 80 * S).toISOString() });
    expect(save.entries.find((e) => e.id === "wallSit")!.sets).toEqual([{ w: null, reps: null, secs: 70 }]);
    expect(save.done.find((d) => d.id === "wallSit")!.secs).toBe(70);
  });

  it("Done short of half the target still counts: where the athlete stopped is the result", () => {
    const done = doneHold(atWallSit(docSrc()), T0 + 20 * S);
    expect(wallSitSet(done)).toMatchObject({ done: true, secs: 12 });
  });

  it("Done in the get-ready is no Done: it is only for the hold", () => {
    const s = atWallSit(docSrc());
    expect(doneHold(s, T0 + 5 * S)).toBe(s);
  });

  it("Skip keeps the half-time rule, at the time held (uncapped)", () => {
    expect(wallSitSet(next(atWallSit(docSrc()), T0 + 20 * S)).done).toBe(false);
    expect(wallSitSet(next(atWallSit(docSrc()), T0 + 78 * S))).toMatchObject({ done: true, secs: 70 });
  });

  it("End and review mid-hold logs the time held, uncapped", () => {
    const ended = endSession(atWallSit(docSrc()), T0 + 78 * S);
    expect(wallSitSet(ended)).toMatchObject({ done: true, secs: 70 });
  });

  it("resumed from the device it still counts up (what goes to max is read from the build)", () => {
    const s = atWallSit(docSrc());
    const back = fromLiveSession(toLiveSession(s, T0 + 10 * S), docSrc())!;
    expect(settle(back, T0 + 78 * S, { autoAdvance: true }).index).toBe(7);
    expect(wallSitSet(doneHold(back, T0 + 78 * S)).secs).toBe(70);
  });

  it("a document's hold its item does not send to max (a cue only) counts down and moves on as before", () => {
    // The stretch (step 8): 8 s get-ready, 60 s; reached at T0 when the wall sit is done at once.
    const s = doneHold(atWallSit(docSrc()), T0 + 9 * S);
    expect(s.index).toBe(8);
    expect(settle(s, T0 + 9 * S + 68 * S, { autoAdvance: true }).finished).toBe(true);
  });

  it("only a hold goes to max: a set in a slot to max (reps to max) plays as any set", () => {
    const src = { ...docSrc(), build: docBuild({ fromDoc: { rev: 1, swaps: [], blocked: [], slots: { "core:0": { max: true } } } }) };
    const s = beginPlayer(src, playerData(src), { performedId: "perf-1", now: T0 });
    expect(s.toMax).toEqual(["core:0"]);
    expect(goesToMax(s, s.live.steps[2])).toBe(false);
    expect(stepView(next(next(s, T0), T0), T0 + 5 * S)).toMatchObject({ phase: "set" });
  });

  it("an engine build's hold plays as before: capped at its window, moved on when it runs out", () => {
    const s = atWallSit(engineSrc());
    expect(stepView(s, T0 + 78 * S)).toMatchObject({ phase: "over" });
    const moved = settle(s, T0 + 78 * S, { autoAdvance: true });
    expect(moved.index).toBeGreaterThan(7);
    expect(wallSitSet(moved)).toMatchObject({ done: true, secs: 40 });
    expect(doneHold(s, T0 + 30 * S)).toBe(s);
  });
});

describe("⇄ offers the item's planned alternates first, then the engine's usual offers", () => {
  const engineOffer = (): Alternative => ({
    id: "tempoSquat",
    name: "Tempo squat",
    reasons: ["Swapped in"],
    steps: plannedSplitSquat().steps.map((s) => ({ ...s, exerciseId: "tempoSquat" })),
    moveKey: "tempoSquat|glutes,quads",
    pairing: { doseType: "reps", patterns: ["squat"], positionGroup: "standing" },
  });

  it("a document's alternate first, with its why; an engine offer after; never one twice", () => {
    const b = docBuild({ alternatives: { "core:0": [engineOffer(), { ...plannedSplitSquat(), reasons: ["Swapped in"] }] } });
    const offered = offeredNow(b, [], "core:0");
    expect(offered.map((c) => [c.id, c.reasons])).toEqual([
      ["splitSquat", [PLANNED_WHY]],
      ["tempoSquat", ["Swapped in"]],
    ]);
  });

  it("a document workout's alternates: offered offline, played exactly as offered", () => {
    const b = docBuild();
    expect(offeredNow(b, [], "core:0").map((c) => c.id)).toEqual(["splitSquat"]);
    // Swapped to it, the planned move is offered back first.
    expect(offeredNow(b, [{ slotKey: "core:0", to: "splitSquat" }], "core:0").map((c) => c.id)).toEqual(["gobletSquat"]);
  });

  it("a document's alternate is its author's: not held to the engine's time budget (an engine offer is)", () => {
    const long: Alternative = { ...plannedSplitSquat(), steps: plannedSplitSquat().steps.map((s) => ({ ...s, seconds: 900 })) };
    expect(offeredNow(docBuild({ fromDoc: { rev: 1, swaps: [], blocked: [], slots: { "core:0": { alternates: [long] } } } }), [], "core:0").map((c) => c.id)).toEqual([
      "splitSquat",
    ]);
    expect(offeredNow(build({ alternatives: { "core:0": [long] } }), [], "core:0")).toEqual([]);
  });

  it("a document's superset pairs are its author's: an alternate is not held to the engine's pairing rule", () => {
    const set = (id: string, k: number, slotKey: string, group: string): Step => ({
      kind: "set", slotKey, block: "core", exerciseId: id, side: null, setIndex: k, setCount: 2, seconds: 30, prepGap: 0,
      target: null, format: { id: "superset", group, round: null }, why: [], isNew: false, log: true,
    });
    const steps = [set("gobletSquat", 0, "core:0", "A"), set("splitSquat", 0, "core:1", "B"), set("gobletSquat", 1, "core:0", "A"), set("splitSquat", 1, "core:1", "B")];
    // A lunge for the squat's partner shares its pattern: the engine would never pair them.
    const lunge: Alternative = {
      id: "reverseLunge", name: "Reverse lunge", reasons: [], moveKey: "lunge|glutes,quads",
      steps: [0, 1].map((k) => set("reverseLunge", k, "core:1", "B")),
      pairing: { doseType: "reps", patterns: ["lunge", "squat"], positionGroup: "standing" },
    };
    const items = [
      { slotKey: "core:0", block: "core" as const, exerciseId: "gobletSquat", format: "superset" as const, sets: 2, group: "A", coreFamily: null, isNew: false, why: [] },
      { slotKey: "core:1", block: "core" as const, exerciseId: "splitSquat", format: "superset" as const, sets: 2, group: "B", coreFamily: null, isNew: false, why: [] },
    ];
    const fromDoc = { rev: 1, swaps: [], blocked: [], slots: { "core:1": { alternates: [lunge] } } };
    expect(offeredNow(docBuild({ steps, items, plannedSeconds: 120, fromDoc }), [], "core:1").map((c) => c.id)).toEqual(["reverseLunge"]);
    expect(offeredNow(build({ steps, items, plannedSeconds: 120, alternatives: { "core:1": [lunge] } }), [], "core:1")).toEqual([]);
  });
});
