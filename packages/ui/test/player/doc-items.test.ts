/**
 * WHAT A DOCUMENT'S ITEMS SAY, PLAYED (Stage 2 spec §11; Task 8). A document workout's build carries, beside its steps,
 * what each slot's item says (`fromDoc.slots`): a hold TO MAX counts up past its target and Done logs the seconds held
 * (never capped — a hold-time objective reads them), moving on without Done logs nothing of it, a side at a time
 * logs each side; ⇄ offers the item's planned alternates first, then the usual offers. An engine build carries none of
 * it and plays exactly as before. Expectations worked out by hand from the fixtures' steps (fixtures.ts): in `docBuild`
 * the wall sit is step 7, an 8 s get-ready then a 40 s target; `maxBuild` is holds to max, each with a rest after.
 */
import { describe, expect, it } from "vitest";
import type { Alternative, Step } from "@rg/session-engine";
import {
  beginPlayer,
  confirmLog,
  doneHold,
  endSession,
  fromLiveSession,
  goesToMax,
  heldBefore,
  logFor,
  logTarget,
  next,
  openHold,
  playerData,
  prev,
  saveOf,
  settle,
  stepView,
  toLiveSession,
  type PlayerState,
} from "../../src/player/run.js";
import { offeredNow, planAfter } from "../../src/player/swap.js";
import type { SessionBuildDto } from "@rg/api-client";
import fixture from "./doc-build-fixture.json";
import { build, docBuild, docView, exercise, maxBuild, PLANNED_WHY, plannedSplitSquat, SLOT, T0, view } from "./fixtures.js";

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

  it("Skip, → or ← log nothing of it, however long it was held: a skipped test is no measure", () => {
    for (const at of [20, 78]) {
      const skipped = next(atWallSit(docSrc()), T0 + at * S);
      expect(wallSitSet(skipped).done).toBe(false);
      expect(saveOf(skipped, { endedAt: new Date(T0 + 90 * S).toISOString() }).entries.find((e) => e.id === "wallSit")).toBeUndefined();
      expect(wallSitSet(prev(atWallSit(docSrc()), T0 + at * S)).done).toBe(false);
    }
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
    // Nor is a set of reps to max a hold with no target: it plays as any set.
    expect(openHold(s, s.live.steps[2])).toBe(false);
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

describe("holds to max, each with a rest after (maxBuild)", () => {
  const src = () => ({ workoutId: SLOT, build: maxBuild(), view: docView(), profiles: ["tmj"] });
  const begin = () => beginPlayer(src(), playerData(src()), { performedId: "perf-1", now: T0 });
  /** Left done at 50 s (from T0, 3 s get-ready), the right at 38 s: on the rest after. */
  const bothSides = () => {
    const left = doneHold(begin(), T0 + 53 * S);
    expect(left.index).toBe(1);
    const right = doneHold(left, T0 + 94 * S);
    expect(right.index).toBe(2);
    return right;
  };

  it("a side at a time: each side is logged on its own, neither overwriting the other", () => {
    const s = bothSides();
    expect(s.live.entries.lowLunge!.sets[0]).toMatchObject({ done: true, sides: { left: 50, right: 38 } });
    const save = saveOf(s, { endedAt: new Date(T0 + 100 * S).toISOString() });
    // One set, as history reads it: what it held on both sides, and each side's.
    expect(save.entries.find((e) => e.id === "lowLunge")!.sets).toEqual([{ w: null, reps: null, secs: 38, sides: { left: 50, right: 38 } }]);
  });

  it("the rest after says what was held, and its log card edits it — each side, or the seconds", () => {
    const s = bothSides();
    expect(heldBefore(s)).toEqual({ secs: 45, sides: { left: 50, right: 38 } });
    expect(logTarget(s)).toMatchObject({ exerciseId: "lowLunge", sides: { left: 50, right: 38 } });
    const edited = confirmLog(s, { sides: { left: 50, right: 40 } }, {}, T0 + 96 * S);
    expect(edited.index).toBe(2);
    expect(edited.live.entries.lowLunge!.sets[0]!.sides).toEqual({ left: 50, right: 40 });
    // The wall sit: 61 s held of 40, then the rest after it.
    const atHold = next(edited, T0 + 100 * S);
    const done = doneHold(atHold, T0 + 169 * S);
    expect(done.index).toBe(4);
    expect(heldBefore(done)).toEqual({ secs: 61, sides: null });
    const fixed = confirmLog(done, { secs: 58 }, {}, T0 + 170 * S);
    expect(fixed.live.entries.wallSit!.sets[0]).toMatchObject({ done: true, secs: 58 });
    // Skipped, nothing was held: the rest says nothing.
    expect(heldBefore(next(atHold, T0 + 169 * S))).toBeNull();
    // Not after a hold to max (the rest after a set): nothing either.
    const doc = { workoutId: SLOT, build: docBuild(), view: docView(), profiles: ["tmj"] };
    const afterSet = next(next(next(beginPlayer(doc, playerData(doc), { performedId: "p", now: T0 }), T0), T0), T0);
    expect(afterSet.live.steps[afterSet.index]!.kind).toBe("rest");
    expect(logTarget(afterSet)).not.toBeNull();
    expect(heldBefore(afterSet)).toBeNull();
  });

  it("a card opened in the rest writes to the set it was opened on, whatever the clock did since — never the next step", () => {
    // The wall sit held 61 s; the rest after it (30 s) begins at T0+169 s.
    const atRest = doneHold(next(bothSides(), T0 + 100 * S), T0 + 169 * S);
    const held = logFor(atRest);
    expect(held).toEqual({ exerciseId: "wallSit", setIndex: 0, place: 0, side: null });
    // The rest runs out while the card is open: the next step (a set) is the one in play now.
    const moved = settle(atRest, T0 + 260 * S, { autoAdvance: true });
    expect(moved.index).toBe(5);
    expect(logTarget(moved)).toMatchObject({ exerciseId: "reclinedButterfly" });
    const confirmed = confirmLog(moved, { secs: 58 }, {}, T0 + 261 * S, held);
    expect(confirmed.live.entries.wallSit!.sets[0]).toMatchObject({ done: true, secs: 58 });
    // The set in play is neither written nor skipped.
    expect(confirmed.index).toBe(5);
    expect(confirmed.live.entries.reclinedButterfly!.sets[0]).toMatchObject({ secs: null, touched: false });
    // On the set it was opened on, Confirm goes on as ever.
    const onSet = confirmLog(moved, { secs: 90 }, {}, T0 + 262 * S, logFor(moved));
    expect(onSet.index).toBe(6);
  });

  it("a timed move to max with no target plays as a set that counts up; its log card is filled in on Done", () => {
    let s = bothSides();
    s = next(doneHold(next(s, T0 + 100 * S), T0 + 150 * S), T0 + 160 * S);
    expect(s.index).toBe(5);
    expect(openHold(s, s.live.steps[5])).toBe(true);
    expect(openHold(s, s.live.steps[3])).toBe(false);
    expect(stepView(s, T0 + 255 * S)).toMatchObject({ phase: "set", elapsedMs: 95 * S });
    // The screen fills the card with the seconds counted; Confirm logs them.
    const logged = confirmLog(s, { secs: 95 }, {}, T0 + 255 * S);
    expect(logged.live.entries.reclinedButterfly!.sets[0]).toMatchObject({ done: true, secs: 95 });
  });
});

describe("⇄ on a materialised document build (doc-build-fixture.json: what the worker's materializeDocBuild makes)", () => {
  /** TMJ at 6 (a flare; jumps kept out), the split squat set aside: the tempo squat plans the split squat, a jump and the goblet squat. */
  const materialised = (): SessionBuildDto =>
    ({
      ...build(),
      ...fixture,
      engineVersion: "doc-build-3",
      targets: {},
      newMove: null,
      exercises: Object.fromEntries((fixture.exercises as string[]).map((id) => [id, exercise(id)])),
      fromDoc: { rev: 1, swaps: [], blocked: [], slots: fixture.slots },
    }) as unknown as SessionBuildDto;

  it("offers the planned alternates the day allows — clean ones first, then a costly one with its cost — then the library's usual offers; each plays as offered", () => {
    const b = materialised();
    const slot = b.fromDoc!.slots!["core:0"]!;
    expect(slot.offers!.length).toBeGreaterThan(0);
    const offered = offeredNow(b, [], "core:0");
    // Three at most (the engine's rule), in order: the clean planned alternate, the set-aside one with its cost, then
    // the library's offers; never the jump the day keeps out.
    expect(offered.map((c) => c.id)).toEqual(["gobletSquat", "bwSplitSquat", ...slot.offers!.map((o) => o.id)].slice(0, 3));
    expect(offered[1]!.reasons[0]).toBe("One leg.");
    expect(offered[1]!.reasons.length).toBe(2);
    expect(offered.map((c) => c.id)).not.toContain("snapDown");
    // Every one plays exactly its offered steps in the slot.
    for (const c of offered) {
      const plan = planAfter(b, [{ slotKey: "core:0", to: c.id }]);
      expect(plan.state.current["core:0"]!.id).toBe(c.id);
      expect(plan.steps.filter((st) => st.kind !== "rest" && st.slotKey === "core:0")).toEqual(c.steps);
    }
    // The other slot: the library's offers alone (it plans no alternate).
    expect(offeredNow(b, [], "core:1").map((c) => c.id)).toEqual(b.fromDoc!.slots!["core:1"]!.offers!.map((o) => o.id).slice(0, 3));
  });
});

describe("⇄ offers the item's planned alternates first, then the usual offers", () => {
  const offer = (): Alternative => ({
    id: "tempoSquat",
    name: "Tempo squat",
    reasons: ["An easier version"],
    steps: plannedSplitSquat().steps.map((s) => ({ ...s, exerciseId: "tempoSquat" })),
    moveKey: "tempoSquat|glutes,quads",
    pairing: { doseType: "reps", patterns: ["squat"], positionGroup: "standing" },
  });

  it("a document's planned alternates, with their why, then the library's usual offers the build carries", () => {
    const b = docBuild({ fromDoc: { rev: 1, swaps: [], blocked: [], slots: { "core:0": { alternates: [plannedSplitSquat()], offers: [offer()] } } } });
    expect(offeredNow(b, [], "core:0").map((c) => [c.id, c.reasons])).toEqual([
      ["splitSquat", [PLANNED_WHY]],
      ["tempoSquat", ["An easier version"]],
    ]);
    // Offers alone: offered too.
    const only = docBuild({ fromDoc: { rev: 1, swaps: [], blocked: [], slots: { "core:0": { offers: [offer()] } } } });
    expect(offeredNow(only, [], "core:0").map((c) => c.id)).toEqual(["tempoSquat"]);
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
