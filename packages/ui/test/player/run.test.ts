/**
 * THE PLAYER'S STATE (Phase 2b Task 4; spec §2b "Player"): the recorder against the build's own slice, walked step by
 * step with wall-clock timers. Every expectation is worked out by hand from the fixture's steps (fixtures.ts).
 */
import { describe, expect, it } from "vitest";
import {
  addRest,
  beginPlayer,
  confirmLog,
  endSession,
  fromLiveSession,
  isComplete,
  logTarget,
  next,
  pause,
  playerData,
  prev,
  resume,
  saveOf,
  settle,
  stepView,
  swapSlot,
  toLiveSession,
  type PlayerState,
} from "../../src/player/run.js";
import { BUILD_ID, build, SLOT, T0, view } from "./fixtures.js";

const S = 1000;
const src = () => ({ workoutId: SLOT, build: build(), view: view(), profiles: ["tmj"] });
const data = playerData(src());
const begin = (now = T0) => beginPlayer(src(), data, { performedId: "perf-1", now });

/** Walk forward with Next until the step `index` is current, each Next at `at`. */
function walkTo(state: PlayerState, index: number, at: number): PlayerState {
  let s = state;
  while (s.index < index) s = next(s, at);
  return s;
}

describe("a timed step", () => {
  it("counts down its get-ready, then its hold, from the wall clock", () => {
    const s = begin();
    expect(stepView(s, T0)).toMatchObject({ phase: "ready", remainingMs: 3 * S });
    expect(stepView(s, T0 + 2 * S)).toMatchObject({ phase: "ready", remainingMs: 1 * S });
    expect(stepView(s, T0 + 3 * S)).toMatchObject({ phase: "hold", remainingMs: 45 * S });
    expect(stepView(s, T0 + 30 * S)).toMatchObject({ phase: "hold", remainingMs: 18 * S });
    expect(stepView(s, T0 + 48 * S)).toMatchObject({ phase: "over", remainingMs: 0 });
  });

  it("moves on by itself when the timer ends, the next step starting when the last one ended", () => {
    const s = settle(begin(), T0 + 50 * S, { autoAdvance: true });
    expect(s.index).toBe(1);
    // Right side: started at T0+48 s, so 2 s of its 3 s get-ready are gone.
    expect(stepView(s, T0 + 50 * S)).toMatchObject({ phase: "ready", remainingMs: 1 * S });
  });

  it("waits at 0:00 for Next when auto-advance is off", () => {
    const s = settle(begin(), T0 + 60 * S, { autoAdvance: false });
    expect(s.index).toBe(0);
    expect(stepView(s, T0 + 60 * S)).toMatchObject({ phase: "over", remainingMs: 0 });
  });

  it("left before half its hold it is not done; after half it counts at the time held", () => {
    const at7 = walkTo(begin(), 7, T0);
    expect(at7.live.steps[7]!.exerciseId).toBe("wallSit");
    // The new move's how-to holds the countdown until it is closed; resume it there.
    const a = resume(at7, T0);
    // 8 s get-ready, then 15 s of a 40 s hold: under half.
    const short = next(a, T0 + 23 * S);
    expect(short.live.entries.wallSit!.sets[0]!.done).toBe(false);
    // 25 s of 40: over half — done, at 25 s.
    const long = next(a, T0 + 33 * S);
    expect(long.live.entries.wallSit!.sets[0]).toMatchObject({ done: true, secs: 25 });
  });
});

describe("Review Focus 1 — the phone locks mid-hold and unlocks 2 minutes later", () => {
  // At the wall sit (40 s hold after an 8 s get-ready), 10 s into the hold.
  const atHold = () => resume(walkTo(begin(), 7, T0), T0);
  const lockedAt = T0 + 18 * S;

  it("the hold is judged by the half-time rule on resume, at the time it could be held — never the time locked", () => {
    const s = settle(atHold(), lockedAt + 120 * S, { autoAdvance: true });
    // The hold ended at T0+48 s, 40 s held: done, 40 s (not the 130 s the screen was off).
    expect(s.live.entries.wallSit!.sets[0]).toMatchObject({ done: true, secs: 40 });
    // The butterfly (8 + 60 s) began at T0+48 s and ran out at T0+116 s: the session is at its end.
    expect(s.finished).toBe(true);
  });

  it("a shorter lock resumes the hold with the true remaining time", () => {
    const s = settle(atHold(), lockedAt + 20 * S, { autoAdvance: true });
    expect(s.index).toBe(7);
    // 30 s of 40 held by the wall clock: 10 s left.
    expect(stepView(s, lockedAt + 20 * S)).toMatchObject({ phase: "hold", remainingMs: 10 * S });
    expect(s.live.entries.wallSit!.sets[0]!.done).toBe(false);
  });

  it("without auto-advance the hold waits at 0:00 and Next judges it at its full time", () => {
    const waiting = settle(atHold(), lockedAt + 120 * S, { autoAdvance: false });
    expect(waiting.index).toBe(7);
    expect(stepView(waiting, lockedAt + 120 * S)).toMatchObject({ phase: "over", remainingMs: 0 });
    const s = next(waiting, lockedAt + 120 * S);
    expect(s.live.entries.wallSit!.sets[0]).toMatchObject({ done: true, secs: 40 });
  });

  it("a paused hold keeps its time across the lock: 10 s held, 30 s left, and Skip then leaves it not done", () => {
    const paused = pause(atHold(), lockedAt);
    const later = settle(paused, lockedAt + 120 * S, { autoAdvance: true });
    expect(stepView(later, lockedAt + 120 * S)).toMatchObject({ phase: "hold", remainingMs: 30 * S });
    const skipped = next(later, lockedAt + 120 * S);
    expect(skipped.live.entries.wallSit!.sets[0]!.done).toBe(false);
  });
});

describe("a set", () => {
  const atSet = () => walkTo(begin(), 2, T0);

  it("is counted when reached and shows its target; it waits for Done (no timer runs it out)", () => {
    const s = settle(atSet(), T0 + 600 * S, { autoAdvance: true });
    expect(s.index).toBe(2);
    expect(stepView(s, T0 + 600 * S).phase).toBe("set");
    expect(s.live.entries.gobletSquat!.sets[0]).toMatchObject({ done: true, w: { v: 30, u: "lb" }, reps: 6 });
  });

  it("the log card edits that set (and the sets not touched yet), sets the flag, and Confirm starts the rest", () => {
    const s = atSet();
    expect(logTarget(s)).toMatchObject({ exerciseId: "gobletSquat", setIndex: 0, w: { v: 30, u: "lb" }, reps: 6 });
    const after = confirmLog(s, { w: { v: 35, u: "lb" }, reps: 5 }, { clenched: true }, T0 + 40 * S);
    expect(after.index).toBe(3);
    expect(stepView(after, T0 + 40 * S)).toMatchObject({ phase: "rest", remainingMs: 75 * S });
    const sets = after.live.entries.gobletSquat!.sets;
    expect(sets[0]).toMatchObject({ w: { v: 35, u: "lb" }, reps: 5, touched: true });
    expect(sets[1]).toMatchObject({ w: { v: 35, u: "lb" }, reps: 5, touched: false });
    expect(after.live.entries.gobletSquat!.flags).toEqual(["clenched"]);
  });

  it("Confirm with the target unchanged leaves later sets alone", () => {
    const after = confirmLog(atSet(), { w: { v: 30, u: "lb" }, reps: 6 }, {}, T0 + 40 * S);
    expect(after.live.entries.gobletSquat!.sets[0]!.touched).toBe(false);
    expect(after.live.entries.gobletSquat!.flags).toEqual([]);
  });
});

describe("a rest", () => {
  const atRest = () => confirmLog(walkTo(begin(), 2, T0), { w: { v: 30, u: "lb" }, reps: 6 }, {}, T0);

  it("+15 s lengthens it; it ends by itself", () => {
    const longer = addRest(atRest(), 15);
    expect(stepView(longer, T0 + 80 * S)).toMatchObject({ phase: "rest", remainingMs: 10 * S });
    expect(settle(longer, T0 + 89 * S, { autoAdvance: true }).index).toBe(3);
    expect(settle(longer, T0 + 91 * S, { autoAdvance: true }).index).toBe(4);
  });

  it("Skip ends it at once", () => {
    expect(next(atRest(), T0 + 5 * S).index).toBe(4);
  });
});

describe("pausing, stepping back, and the session's running time", () => {
  it("a pause stops the step's timer and the session's running time", () => {
    const s = pause(begin(), T0 + 10 * S);
    expect(stepView(s, T0 + 70 * S)).toMatchObject({ phase: "hold", remainingMs: 38 * S });
    const r = resume(s, T0 + 70 * S);
    expect(stepView(r, T0 + 75 * S)).toMatchObject({ phase: "hold", remainingMs: 33 * S });
    const done = endSession(r, T0 + 75 * S);
    // 10 s before the pause + 5 s after it.
    expect(saveOf(done, { endedAt: new Date(T0 + 75 * S).toISOString() }).seconds).toBe(15);
  });

  it("← goes back a step with its timer from the start", () => {
    const s = prev(next(begin(), T0 + 10 * S), T0 + 12 * S);
    expect(s.index).toBe(0);
    expect(stepView(s, T0 + 12 * S)).toMatchObject({ phase: "ready", remainingMs: 3 * S });
  });

  it("Next on the last step ends the session", () => {
    const s = next(resume(walkTo(begin(), 8, T0), T0), T0);
    expect(s.finished).toBe(true);
  });
});

describe("ending early", () => {
  it("the set in play when the session ends is not done — reaching it counted it, but it was never confirmed", () => {
    // The flow's two sides held to the end (each 3 s + 45 s), then the set reached.
    const atSet = settle(begin(), T0 + 96 * S, { autoAdvance: true });
    expect(atSet.index).toBe(2);
    const s = endSession(atSet, T0 + 101 * S);
    expect(s.finished).toBe(true);
    expect(s.live.entries.gobletSquat!.sets[0]!.done).toBe(false);
    const save = saveOf(s, { endedAt: new Date(T0 + 101 * S).toISOString() });
    expect(save.stepsDone).toBe(2);
    expect(save.completed).toBe(false);
  });

  it("holds skipped before half their time are no steps done, and their move is not done (ruling 2b-R15)", () => {
    const s = endSession(walkTo(begin(), 2, T0), T0 + 5 * S);
    const save = saveOf(s, { endedAt: new Date(T0 + 5 * S).toISOString() });
    expect(save.stepsDone).toBe(0);
    expect(save.done.map((d) => d.id)).toEqual([]);
  });

  it("a hold in play counts by the half-time rule; under half it is not a step done", () => {
    const under = endSession(begin(), T0 + 20 * S);
    expect(saveOf(under, { endedAt: new Date(T0 + 20 * S).toISOString() }).stepsDone).toBe(0);
    const over = endSession(begin(), T0 + 40 * S);
    expect(saveOf(over, { endedAt: new Date(T0 + 40 * S).toISOString() }).stepsDone).toBe(1);
  });

  it("played to the end is complete", () => {
    const s = next(resume(walkTo(begin(), 8, T0), T0), T0);
    expect(isComplete(s)).toBe(true);
    expect(isComplete(endSession(walkTo(begin(), 2, T0), T0))).toBe(false);
  });
});

describe("the new move", () => {
  it("arriving at it the first time holds the countdown for its how-to; the second time it does not", () => {
    const s = walkTo(begin(), 7, T0);
    expect(s.paused).toBe(true);
    expect(s.howto).toBe("wallSit");
    const back = walkTo(prev(resume(s, T0), T0), 7, T0);
    expect(back.paused).toBe(false);
  });
});

describe("a swap mid-session", () => {
  it("plays the alternative for the slot's remaining sets; the sets already done stay with the move they were done with", () => {
    const atSecondSet = walkTo(begin(), 4, T0);
    const alt = build().alternatives["core:0"]![0]!;
    const s = swapSlot(atSecondSet, data, "core:0", alt, T0 + 5 * S);
    expect(s.live.steps.map((st) => st.exerciseId)).toEqual([
      "lowLunge", "lowLunge", "gobletSquat", null, "splitSquat", null, "splitSquat", "wallSit", "reclinedButterfly",
    ]);
    expect(s.index).toBe(4);
    expect(s.live.entries.gobletSquat!.sets.filter((x) => x.done)).toHaveLength(1);
    // The swapped-in set is the one now playing: counted, with the alternative's own target.
    expect(s.live.entries.splitSquat!.sets[1]).toMatchObject({ done: true, w: { v: 20, u: "lb" }, reps: 8 });
    expect(s.swaps).toEqual([{ slotKey: "core:0", to: "splitSquat" }]);
  });
});

describe("leave and resume", () => {
  it("what is stored is what comes back: the step, its timer, the logged sets, the flags", () => {
    const s = confirmLog(walkTo(begin(), 2, T0), { w: { v: 35, u: "lb" }, reps: 5 }, { clenched: true }, T0 + 40 * S);
    const stored = toLiveSession(s, T0 + 50 * S);
    expect(stored).toMatchObject({ workoutId: SLOT, performedId: "perf-1", buildId: BUILD_ID, stepIndex: 3, paused: false, startedAt: T0 });
    // Stored as plain data (it goes through IndexedDB and is read by the outbox's tests as JSON).
    const back = fromLiveSession(JSON.parse(JSON.stringify(stored)), src());
    expect(back).not.toBeNull();
    expect(back!.index).toBe(3);
    expect(stepView(back!, T0 + 60 * S)).toMatchObject({ phase: "rest", remainingMs: 55 * S });
    expect(back!.live.entries.gobletSquat!.sets[0]).toMatchObject({ w: { v: 35, u: "lb" }, reps: 5 });
    expect(back!.live.entries.gobletSquat!.flags).toEqual(["clenched"]);
    expect([...back!.live.reached].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });

  it("a stored session for another build, or one that is not the player's, is not resumed", () => {
    const stored = toLiveSession(begin(), T0);
    expect(fromLiveSession({ ...stored, buildId: "other" }, src())).toBeNull();
    expect(fromLiveSession({ ...stored, recorder: {} }, src())).toBeNull();
  });
});

describe("the save", () => {
  it("names the session, its build, its day, its reading before, and what was done", () => {
    let s = settle(begin(), T0 + 96 * S, { autoAdvance: true });
    expect(s.index).toBe(2);
    s = confirmLog(s, { w: { v: 30, u: "lb" }, reps: 6 }, {}, T0 + 130 * S);
    s = endSession(s, T0 + 130 * S);
    const save = saveOf(s, { endedAt: new Date(T0 + 130 * S).toISOString(), post: { tmj: 0 }, completed: false });
    expect(save).toMatchObject({
      id: "perf-1",
      date: "2026-10-08",
      startedAt: new Date(T0).toISOString(),
      mode: "consistent",
      theme: "deskUnwind",
      locationId: "home",
      blockId: "block-1",
      blockNumber: 1,
      completed: false,
      checks: { tmj: { pre: 1, post: 0, feelingOff: false } },
      seconds: 130,
    });
    expect(save.entries.map((e) => [e.id, e.sets.length])).toEqual([["gobletSquat", 1]]);
    expect(save.done.map((d) => d.id)).toEqual(["lowLunge", "gobletSquat"]);
  });
});
