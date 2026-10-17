/**
 * THE SESSION'S CUES, PLANNED (the sound pass, 2026-10-17): `planCues` turns where the session stands into the cues the
 * cue player places — a countdown of ticks before every change, and a cue that says what the change is.
 *
 *  - a get-ready: ticks at its end −3, −2, −1 s (those inside it), then go;
 *  - the end of a timed hold of at least 4 s: ticks, then rest (a rest next), switch (the same move's other side), done
 *    (the last step) or next (anything else);
 *  - the end of a rest: next when a get-ready opens the step after it (its own ticks lead into go), else ticks and go;
 *  - a hold to max: its get-ready's ticks, go, and target at its target — nothing after it (it ends on Done);
 *  - a set ends the plan; a session finished by a tap plays done at once;
 *  - spacing: two runs of ticks never within 5 s (the earlier goes: the later leads into what comes next), a tick within
 *    0.5 s of another cue goes, and a tick never comes before its step began;
 *  - auto-advance off: the step in play only; nothing paused; nothing past, nothing beyond the cue player's window.
 *
 * And the calm signal: a recovery session, a document of "recover" effort, or a slow held one (yin-like) is calm.
 */
import { describe, expect, it } from "vitest";
import type { SessionBuildDto } from "@rg/api-client";
import type { Step } from "@rg/session-engine";
import { WINDOW_MS, type Cue } from "../../src/player/cue-player.js";
import { calmSession, planCues, type CueState } from "../../src/player/cues.js";
import { beginPlayer, next, pause, playerData, resume, settle } from "../../src/player/run.js";
import { build, exercise, SLOT, T0, view } from "./fixtures.js";

const S = 1000;
const T = T0;

const step = (over: Partial<Step> & Pick<Step, "kind" | "seconds">): Step => ({
  exerciseId: null,
  side: null,
  setIndex: null,
  setCount: null,
  prepGap: 0,
  target: null,
  format: { id: "holds", group: null, round: null },
  why: [],
  isNew: false,
  log: false,
  slotKey: "s:0",
  block: "core",
  ...over,
});
/** A timed hold of `id` (its slot is its id): `secs` held after a get-ready of `prep`. */
const hold = (id: string, secs: number, prep = 0, side: Step["side"] = null): Step =>
  step({ kind: "timed", exerciseId: id, slotKey: id, seconds: secs, prepGap: prep, side });
const rest = (secs: number): Step => step({ kind: "rest", seconds: secs });
const set = (id: string): Step => step({ kind: "set", exerciseId: id, slotKey: id, seconds: 40 });

/** Where the session stands: on step `index`, its timer started at `start` (T by default) and running. */
function at(steps: Step[], o: { index?: number; start?: number; extra?: Record<number, number>; toMax?: string[]; paused?: boolean } = {}): CueState {
  const start = o.start ?? T;
  return {
    index: o.index ?? 0,
    clock: o.paused ? { anchor: null, bankedMs: 0 } : { anchor: start, bankedMs: 0 },
    paused: !!o.paused,
    finished: false,
    finishedAt: null,
    restExtra: o.extra ?? {},
    toMax: o.toMax ?? [],
    live: { steps },
  };
}

/** The cues as [seconds after T, the cue] — a tick by its count. */
const rel = (cues: readonly Cue[]): Array<[number, string]> =>
  cues.map((c) => [Math.round((c.at - T) / 10) / 100, c.kind === "tick" ? `tick${c.n}` : c.kind]);
const plan = (state: CueState, now = T, auto = true) => rel(planCues(state, { auto, now }));
const ticks = (end: number, ...counts: Array<1 | 2 | 3>): Array<[number, string]> => counts.map((n) => [end - n, `tick${n}`]);

describe("the countdown before every change", () => {
  it("a get-ready: ticks at its end −3, −2 and −1 s, then go; a hold's end: ticks, then what comes next", () => {
    expect(plan(at([hold("a", 40, 8), hold("b", 30)]))).toEqual([
      ...ticks(8, 3, 2, 1),
      [8, "go"],
      ...ticks(48, 3, 2, 1),
      [48, "next"],
      ...ticks(78, 3, 2, 1),
      [78, "done"],
    ]);
  });

  it("a get-ready shorter than the countdown has only the ticks inside it", () => {
    expect(plan(at([hold("a", 40, 2)]), T - 1)).toEqual([[0, "tick2"], [1, "tick1"], [2, "go"], ...ticks(42, 3, 2, 1), [42, "done"]]);
  });
});

describe("the end of a timed hold says what comes next", () => {
  it("a rest: rest", () => {
    expect(plan(at([hold("a", 30), rest(60), hold("b", 30, 8)])).slice(0, 4)).toEqual([...ticks(30, 3, 2, 1), [30, "rest"]]);
  });

  it("the same move's other side: switch", () => {
    expect(plan(at([hold("a", 30, 0, "Left"), hold("a", 30, 0, "Right")]))).toEqual([...ticks(30, 3, 2, 1), [30, "switch"], ...ticks(60, 3, 2, 1), [60, "done"]]);
  });

  it("the last step: done", () => {
    expect(plan(at([hold("a", 30)]))).toEqual([...ticks(30, 3, 2, 1), [30, "done"]]);
  });

  it("a new move, or another move's side: next", () => {
    expect(plan(at([hold("a", 30, 0, "Right"), hold("b", 30, 0, "Left")])).slice(0, 4)).toEqual([...ticks(30, 3, 2, 1), [30, "next"]]);
  });

  it("the same side again (another round of it): next, never switch", () => {
    expect(plan(at([hold("a", 30, 0, "Left"), hold("a", 30, 0, "Left")])).slice(0, 4)).toEqual([...ticks(30, 3, 2, 1), [30, "next"]]);
  });

  it("a set: next, and the plan ends there (a set waits for Done)", () => {
    expect(plan(at([hold("a", 30), set("b"), hold("c", 30)]))).toEqual([...ticks(30, 3, 2, 1), [30, "next"]]);
  });

  it("a hold under 4 s has no ticks", () => {
    expect(plan(at([hold("a", 3), hold("b", 30)]))).toEqual([[3, "next"], ...ticks(33, 3, 2, 1), [33, "done"]]);
  });
});

describe("the end of a rest", () => {
  it("before a step that opens with a get-ready: next, with no ticks — the get-ready's own lead into go", () => {
    expect(plan(at([rest(30), hold("b", 40, 8)]))).toEqual([[30, "next"], ...ticks(38, 3, 2, 1), [38, "go"], ...ticks(78, 3, 2, 1), [78, "done"]]);
  });

  it("before work that starts at once (a hold): ticks, then go", () => {
    expect(plan(at([rest(30), hold("b", 40)]))).toEqual([...ticks(30, 3, 2, 1), [30, "go"], ...ticks(70, 3, 2, 1), [70, "done"]]);
  });

  it("before a set: ticks, then go — and the plan ends", () => {
    expect(plan(at([rest(30), set("b"), rest(30)]))).toEqual([...ticks(30, 3, 2, 1), [30, "go"]]);
  });

  it("+15 s and −15 s move it", () => {
    expect(plan(at([rest(30), set("b")], { extra: { 0: 15 } }))).toEqual([...ticks(45, 3, 2, 1), [45, "go"]]);
    expect(plan(at([rest(30), set("b")], { extra: { 0: -10 } }))).toEqual([...ticks(20, 3, 2, 1), [20, "go"]]);
  });
});

describe("a hold to max", () => {
  it("its get-ready's ticks, go, then target at its target — and nothing after it", () => {
    expect(plan(at([hold("m", 40, 8), rest(30), hold("c", 30)], { toMax: ["m"] }))).toEqual([...ticks(8, 3, 2, 1), [8, "go"], [48, "target"]]);
  });

  it("after a rest, with no get-ready of its own: the rest's ticks and go, then target", () => {
    expect(plan(at([rest(20), hold("m", 40), hold("c", 30)], { toMax: ["m"] }))).toEqual([...ticks(20, 3, 2, 1), [20, "go"], [60, "target"]]);
  });

  it("held past its go: the target alone", () => {
    expect(plan(at([hold("m", 40, 8)], { toMax: ["m"] }), T + 20 * S)).toEqual([[48, "target"]]);
  });
});

describe("what plays nothing ahead", () => {
  it("a set in play", () => {
    expect(plan(at([set("a"), rest(30), hold("b", 30)]))).toEqual([]);
  });

  it("a paused session — whatever its clock says", () => {
    expect(plan(at([hold("a", 30, 8)], { paused: true }))).toEqual([]);
    expect(plan({ ...at([hold("a", 30, 8)]), paused: true })).toEqual([]);
  });
});

describe("a session finished by a tap plays done at once", () => {
  const finished = (finishedAt: number): CueState => ({ ...at([hold("a", 30)]), index: 1, finished: true, finishedAt, clock: { anchor: null, bankedMs: 0 } });

  it("at once: no done was due yet", () => {
    const now = T + 12 * S;
    expect(planCues(finished(now), { auto: true, now })).toEqual([{ at: now + 50, kind: "done" }]);
    // The plan before it had a done still ahead (the hold ended early, by Skip): it was never played.
    expect(planCues(finished(now), { auto: true, now, played: [{ at: T + 30 * S, kind: "done" }] })).toEqual([{ at: now + 50, kind: "done" }]);
  });

  it("never twice: a session that ran out to its end, or a Next after the last hold's done, has had its done", () => {
    const now = T + 30 * S + 200;
    expect(planCues(finished(T + 30 * S), { auto: true, now, played: [{ at: T + 30 * S, kind: "done" }] })).toEqual([]);
  });

  it("not for a session that ended a while ago (opened again on its review)", () => {
    expect(planCues(finished(T), { auto: true, now: T + 60 * S })).toEqual([]);
  });
});

describe("spacing", () => {
  it("two runs of ticks are never within 5 s: the earlier goes, the later leads into what comes next", () => {
    // A flow of sides with a 3 s get-ready: the left side's end would tick at 30–32 s and the right side's get-ready at
    // 34–35 s. The get-ready's run is kept (into go); the hold's end has its switch alone.
    expect(plan(at([hold("a", 30, 3, "Left"), hold("a", 30, 3, "Right")]), T - 1)).toEqual([
      ...ticks(3, 3, 2, 1),
      [3, "go"],
      [33, "switch"],
      ...ticks(36, 2, 1),
      [36, "go"],
      ...ticks(66, 3, 2, 1),
      [66, "done"],
    ]);
  });

  it("a run 5 s or more from the next one is kept", () => {
    // A hold's end ticks at 27–29 s; the next get-ready (8 s) ticks at 35–37 s: 6 s apart.
    expect(plan(at([hold("a", 30), hold("b", 30, 8)])).slice(0, 4)).toEqual([...ticks(30, 3, 2, 1), [30, "next"]]);
  });

  it("a tick within 0.5 s of another cue goes; one 0.6 s from it stays", () => {
    // The get-ready's first tick lands 0.4 s after the hold's next (dropped), then 0.6 s after it (kept).
    expect(plan(at([hold("a", 10), hold("b", 30, 3.4)])).slice(0, 4)).toEqual([[10, "next"], [11.4, "tick2"], [12.4, "tick1"], [13.4, "go"]]);
    expect(plan(at([hold("a", 10), hold("b", 30, 3.6)])).slice(0, 5)).toEqual([[10, "next"], [10.6, "tick3"], [11.6, "tick2"], [12.6, "tick1"], [13.6, "go"]]);
  });

  it("a tick never comes before its step began", () => {
    // A 2 s rest, come to by Skip at T: its countdown's first tick would be at T − 1 s.
    expect(plan(at([rest(2), set("b")]), T - 1)).toEqual([[0, "tick2"], [1, "tick1"], [2, "go"]]);
    // A 2 s rest after a hold, and a 2 s get-ready after one: no tick at 9 s, before either began (its 10 s tick is the
    // hold's own cue's; the hold's end gives way to the run after it).
    expect(plan(at([hold("a", 10), rest(2), set("c")]))).toEqual([[10, "rest"], [11, "tick1"], [12, "go"]]);
    expect(plan(at([hold("a", 10), hold("b", 30, 2)])).slice(0, 3)).toEqual([[10, "next"], [11, "tick1"], [12, "go"]]);
  });
});

describe("how far ahead", () => {
  it("auto-advance off: the step in play only (with what its end says)", () => {
    expect(plan(at([hold("a", 30, 3), hold("b", 30)]), T - 1, false)).toEqual([...ticks(3, 3, 2, 1), [3, "go"], ...ticks(33, 3, 2, 1), [33, "next"]]);
  });

  it("nothing past, nothing beyond the cue player's window", () => {
    const state = at([hold("a", 100), hold("b", 100)]);
    expect(plan(state)).toEqual([...ticks(100, 3, 2, 1), [100, "next"]]);
    // Later, the next hold's end is inside the window; what is past is gone.
    expect(plan(state, T + 98 * S)).toEqual([[99, "tick1"], [100, "next"], ...ticks(200, 3, 2, 1), [200, "done"]]);
    for (const c of planCues(state, { auto: true, now: T + 98 * S })) expect(c.at - (T + 98 * S)).toBeLessThanOrEqual(WINDOW_MS);
  });

  it("from the session's own clock: a step resumed after a pause is counted from where it was", () => {
    // 10 s of the get-ready and hold run before a pause; resumed at T + 100 s: as if begun at T + 90 s.
    const resumed: CueState = { ...at([hold("a", 30, 8)]), clock: { anchor: T + 100 * S, bankedMs: 10 * S } };
    expect(plan(resumed, T + 100 * S)).toEqual([...ticks(128, 3, 2, 1), [128, "done"]]);
  });
});

describe("a plan made later agrees with the one before it", () => {
  const src = () => ({ workoutId: SLOT, build: build(), view: view(), profiles: ["tmj"] });
  const begin = () => beginPlayer(src(), playerData(src()), { performedId: "p", now: T0 });

  it("the fixture's flow: a plan made as each side begins holds the cues the first plan had for it", () => {
    // Made at Start: nothing at or before now (the countdown's first tick, at Start itself, is not played).
    const first = planCues(begin(), { auto: true, now: T0 });
    expect(rel(first)).toEqual([
      ...ticks(3, 2, 1),
      [3, "go"],
      [48, "switch"],
      ...ticks(51, 2, 1),
      [51, "go"],
      ...ticks(96, 3, 2, 1),
      [96, "next"],
    ]);
    // The left side ran out at 48 s: the right side's plan, made then or a moment later, says the same of what is ahead.
    for (const now of [T0 + 48 * S, T0 + 48 * S + 200, T0 + 50 * S]) {
      const later = settle(begin(), now, { autoAdvance: true });
      expect(later.index).toBe(1);
      expect(planCues(later, { auto: true, now })).toEqual(first.filter((c) => c.at > now));
    }
  });

  it("a paused and resumed step is planned from where it stands; Skip plans the next step from the tap", () => {
    const paused = pause(begin(), T0 + 10 * S);
    expect(planCues(paused, { auto: true, now: T0 + 20 * S })).toEqual([]);
    const resumed = resume(paused, T0 + 20 * S);
    // 10 s run before the pause: the left side ends 38 s after the Resume (its end's ticks give way to the right side's
    // get-ready, as in the flow above).
    expect(rel(planCues(resumed, { auto: true, now: T0 + 20 * S })).slice(0, 4)).toEqual([[58, "switch"], ...ticks(61, 2, 1), [61, "go"]]);
    // Skip at 10 s: the right side's get-ready runs from the tap; its first tick, at the tap itself, is not played.
    const skipped = next(begin(), T0 + 10 * S);
    expect(rel(planCues(skipped, { auto: true, now: T0 + 10 * S })).slice(0, 3)).toEqual([[11, "tick2"], [12, "tick1"], [13, "go"]]);
  });
});

describe("a calm session", () => {
  const stepsOf = (steps: Step[], mode: "recovery" | "consistent" | "build" = "consistent") => ({ meta: { mode }, steps }) as unknown as Parameters<typeof calmSession>[0];
  const buildOf = (over: Partial<SessionBuildDto> = {}) =>
    ({ exercises: Object.fromEntries(["lowLunge", "reclinedButterfly", "wallSit", "gobletSquat"].map((id) => [id, exercise(id)])), ...over }) as Pick<SessionBuildDto, "fromDoc" | "exercises">;
  const yin = () => [hold("reclinedButterfly", 60, 8), rest(15), hold("lowLunge", 45, 3, "Left"), hold("lowLunge", 45, 3, "Right")];

  it("a recovery session is calm", () => {
    expect(calmSession(stepsOf([hold("wallSit", 30), set("gobletSquat")], "recovery"), buildOf())).toBe(true);
  });

  it("a document workout of \"recover\" effort is calm", () => {
    const fromDoc = { rev: 1, swaps: [], blocked: [], effort: "recover" as const };
    expect(calmSession(stepsOf([set("gobletSquat")]), buildOf({ fromDoc }))).toBe(true);
    expect(calmSession(stepsOf([set("gobletSquat")]), buildOf({ fromDoc: { ...fromDoc, effort: "maintain" } }))).toBe(false);
  });

  it("a slow held session — every hold 45 s or more, no sets, no strength or jumping move — is calm", () => {
    expect(calmSession(stepsOf(yin()), buildOf())).toBe(true);
  });

  it("not with a hold under 45 s, a set, a strength hold, or no hold at all", () => {
    expect(calmSession(stepsOf([...yin(), hold("lowLunge", 44)]), buildOf())).toBe(false);
    // A set, however long it would take.
    expect(calmSession(stepsOf([...yin(), { ...set("lowLunge"), seconds: 90 }]), buildOf())).toBe(false);
    expect(calmSession(stepsOf([...yin(), hold("wallSit", 60)]), buildOf())).toBe(false);
    expect(calmSession(stepsOf([rest(60)]), buildOf())).toBe(false);
  });

  it("not with a jumping move, nor a power one", () => {
    const b = buildOf();
    const withMove = (id: string, over: object) => ({ ...b, exercises: { ...b.exercises, [id]: { ...exercise("lowLunge"), id, ...over } as unknown as SessionBuildDto["exercises"][string] } });
    expect(calmSession(stepsOf([...yin(), hold("hop", 60)]), withMove("hop", { contraction: ["plyometric"], purposes: ["conditioning"] }))).toBe(false);
    expect(calmSession(stepsOf([...yin(), hold("swing", 60)]), withMove("swing", { contraction: ["isotonic"], purposes: ["power"] }))).toBe(false);
    // The same move, slow and held: calm.
    expect(calmSession(stepsOf([...yin(), hold("easy", 60)]), withMove("easy", { contraction: ["isometric"], purposes: ["mobility"] }))).toBe(true);
  });

  it("the fixture's session (a squat, a wall sit) is not", () => {
    expect(calmSession(stepsOf(build().steps), build())).toBe(false);
  });
});
