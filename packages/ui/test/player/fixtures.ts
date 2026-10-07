/**
 * A small locked build for the player tests, made of real library moves (so the recorder reads real records) with
 * hand-written steps (so every expectation is worked out by hand):
 *
 *   0  timed  prep:0      Low lunge · Left    3 s get-ready, 45 s     (flow)
 *   1  timed  prep:0      Low lunge · Right   3 s get-ready, 45 s     (flow)
 *   2  set    core:0      Goblet squat set 1  6 reps @ 30 lb
 *   3  rest   core:0      75 s
 *   4  set    core:0      Goblet squat set 2
 *   5  rest   core:0      75 s
 *   6  set    core:0      Goblet squat set 3
 *   7  timed  accessory:0 Wall sit            8 s get-ready, 40 s     (holds; logged; the new move)
 *   8  timed  cooldown:0  Reclined butterfly  8 s get-ready, 60 s     (holds)
 */
import type { ConditionViewDto, SessionBuildDto, SessionExerciseDto, SessionItemDto, SessionViewDto } from "@rg/api-client";
import { EXERCISES, PROFILES } from "@rg/exercise-library";
import type { Step } from "@rg/session-engine";

export const TODAY = "2026-10-08";
export const SLOT = "slot-p1-2026-10-08";
export const BUILD_ID = "build-1";
/** 2026-10-08 18:00 UTC. */
export const T0 = Date.UTC(2026, 9, 8, 18, 0, 0);

export function exercise(id: string): SessionExerciseDto {
  const ex = EXERCISES.find((e) => e.id === id);
  if (!ex) throw new Error(`no library move ${id}`);
  const { providers: _providers, ...slice } = ex;
  return slice as SessionExerciseDto;
}

const step = (over: Partial<Step> & Pick<Step, "kind" | "slotKey" | "block" | "seconds">): Step => ({
  exerciseId: null,
  side: null,
  setIndex: null,
  setCount: null,
  prepGap: 0,
  target: null,
  format: { id: "straight", group: null, round: null },
  why: [],
  isNew: false,
  log: false,
  ...over,
});

const squatTarget = { lo: 5, hi: 8, type: "reps" as const, w: { v: 30, u: "lb" as const }, reps: 6, secs: null, graduate: null, last: "25 lb × 8", lastDate: "2026-10-01", action: "up" as const, note: "Up today." };

const squatSet = (i: number): Step =>
  step({ kind: "set", slotKey: "core:0", block: "core", exerciseId: "gobletSquat", setIndex: i, setCount: 3, seconds: 40, target: squatTarget, log: true });
const rest = (): Step => step({ kind: "rest", slotKey: "core:0", block: "core", seconds: 75 });

export function steps(): Step[] {
  const flow = { id: "flow" as const, group: null, round: null };
  const holds = { id: "holds" as const, group: null, round: null };
  return [
    step({ kind: "timed", slotKey: "prep:0", block: "prep", exerciseId: "lowLunge", side: "Left", setIndex: 0, setCount: 1, seconds: 45, prepGap: 3, format: flow }),
    step({ kind: "timed", slotKey: "prep:0", block: "prep", exerciseId: "lowLunge", side: "Right", setIndex: 0, setCount: 1, seconds: 45, prepGap: 3, format: flow }),
    squatSet(0),
    rest(),
    squatSet(1),
    rest(),
    squatSet(2),
    step({ kind: "timed", slotKey: "accessory:0", block: "accessory", exerciseId: "wallSit", setIndex: 0, setCount: 1, seconds: 40, prepGap: 8, format: holds, isNew: true, log: true }),
    step({ kind: "timed", slotKey: "cooldown:0", block: "cooldown", exerciseId: "reclinedButterfly", setIndex: 0, setCount: 1, seconds: 60, prepGap: 8, format: holds }),
  ];
}

const item = (over: Partial<SessionItemDto> & Pick<SessionItemDto, "slotKey" | "block" | "exerciseId" | "format">): SessionItemDto => ({
  sets: 1,
  group: null,
  coreFamily: null,
  isNew: false,
  why: [],
  ...over,
});

const splitSquatSteps = (): Step[] =>
  [0, 1, 2].map((i) =>
    step({ kind: "set", slotKey: "core:0", block: "core", exerciseId: "splitSquat", setIndex: i, setCount: 3, seconds: 45, target: { ...squatTarget, w: { v: 20, u: "lb" }, reps: 8 }, log: true }),
  );

export function build(over: Partial<SessionBuildDto> = {}): SessionBuildDto {
  const all = steps();
  const plannedSeconds = all.reduce((n, s) => n + s.seconds + s.prepGap, 0);
  return {
    buildId: BUILD_ID,
    version: 1,
    engineVersion: "session-engine-2",
    inputsHash: "hash",
    builtAt: `${TODAY}T17:55:00.000Z`,
    date: TODAY,
    mode: "consistent",
    modeReasons: [],
    theme: "deskUnwind",
    themeReasons: [],
    minutes: 30,
    locationId: "home",
    blockRef: "block-1",
    weekOfBlock: 2,
    plannedSeconds,
    steps: all,
    items: [
      item({ slotKey: "prep:0", block: "prep", exerciseId: "lowLunge", format: "flow" }),
      item({ slotKey: "core:0", block: "core", exerciseId: "gobletSquat", format: "straight", sets: 3, coreFamily: "squat" }),
      item({ slotKey: "accessory:0", block: "accessory", exerciseId: "wallSit", format: "holds", isNew: true }),
      item({ slotKey: "cooldown:0", block: "cooldown", exerciseId: "reclinedButterfly", format: "holds" }),
    ],
    exercises: Object.fromEntries(
      ["lowLunge", "gobletSquat", "wallSit", "reclinedButterfly", "splitSquat"].map((id) => [id, exercise(id)]),
    ),
    alternatives: {
      "core:0": [
        {
          id: "splitSquat",
          name: "Supported split squat",
          reasons: ["Swapped in"],
          steps: splitSquatSteps(),
          moveKey: "squat|glutes,quads",
          pairing: { doseType: "reps", patterns: ["lunge"], positionGroup: "standing" },
        },
      ],
    },
    targets: { gobletSquat: squatTarget },
    newMove: "wallSit",
    params: { checks: { tmj: { pre: 1, feelingOff: false } }, overrides: {}, swaps: {} },
    ...over,
  } as SessionBuildDto;
}

export function view(over: Partial<SessionViewDto> = {}): SessionViewDto {
  return {
    mode: "consistent",
    proposedMode: "consistent",
    modeReasons: [],
    theme: { id: "deskUnwind", name: "Desk unwind" },
    proposedTheme: { id: "deskUnwind", name: "Desk unwind" },
    themeReasons: [],
    minutes: 30,
    location: {
      id: "home",
      name: "Home",
      equipment: ["kettlebell", "wall", "mat"],
      implements: { kettlebell: [{ v: 20, u: "lb" }, { v: 30, u: "lb" }, { v: 35, u: "lb" }] },
    },
    block: { number: 1, week: 2, weeks: 5, core: [{ family: "squat", name: "Goblet squat" }], events: [] },
    newMove: "wallSit",
    ...over,
  } as SessionViewDto;
}

/** The switched-on profile, in the profile's own words (read from the library, never typed here). */
export function profiles(): ConditionViewDto[] {
  return [{ profileId: "tmj", check: { ...PROFILES.tmj.check }, care: PROFILES.tmj.care?.block.label ?? null }];
}

export const flagLabel = (): string => PROFILES.tmj.setFlag!.label;
