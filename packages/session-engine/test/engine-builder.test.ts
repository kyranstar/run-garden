import { describe, expect, test } from "vitest";
import { Builder, Lib, type HistorySession, type Mode, type Plan } from "../src/index.js";
import { PLACES, data, gym, home, makeInput, themeById, themeFor } from "./builder-fixtures.js";
import { normalise } from "./fixtures.js";

// Ported from the standalone tests/engine-builder.test.js (the standalone `jaw` block is `care`).

const today = "2026-09-29";
const input = makeInput({ today });
const idsOf = (plan: Plan) => plan.items.map(i => i.exercise.id);
const MODES: Mode[] = ["recovery", "consistent", "build"];

// The fill floor is the standalone 80%, except mat-only 40-minute sessions, which the standalone handoff notes
// fill ~78%. The standalone test cleared 80% there only through its library's "from your saves" bonus; saves are
// now the person's own ids (spec §5), and with none the same engine plans 1884 s of 2400 s here — exactly what
// the standalone plans with its saves removed.
const fillFloor = (locId: string, minutes: number) => (locId === "mat" && minutes === 40 ? 0.78 : 0.8);

for (const loc of PLACES) {
  for (const mode of MODES) {
    for (const minutes of [15, 30, 40]) {
      test(`${loc.id} · ${mode} · ${minutes} min fits, fills, and follows the rules`, () => {
        const plan = Builder.build(data, input({ mode, minutes, location: loc, theme: themeFor(mode) }));
        const floor = fillFloor(loc.id, minutes);
        expect(plan.plannedSeconds, `${plan.plannedSeconds}s is over ${minutes * 60}s`).toBeLessThanOrEqual(minutes * 60);
        expect(plan.plannedSeconds, `${plan.plannedSeconds}s is under ${floor * 100}% of ${minutes * 60}s`).toBeGreaterThanOrEqual(minutes * 60 * floor);
        for (const b of ["arrive", "prep", "care", "cooldown"]) expect(plan.items.some(i => i.block === b), `no ${b}`).toBe(true);
        const ids = idsOf(plan);
        expect(new Set(ids).size, "an exercise repeats").toBe(ids.length);
        for (const it of plan.items) {
          expect(Lib.hasEquipment(it.exercise, loc.equipment), `${it.exercise.id} needs missing gear`).toBe(true);
          expect(it.exercise.conditions.tmj!.clench).toBeLessThan(3);
          expect(Lib.fitsMode(data, it.exercise, mode), `${it.exercise.id} breaks ${mode} limits`).toBe(true);
        }
        if (mode === "recovery") {
          expect(plan.items.every(i => Lib.flareSafe(data, i.exercise))).toBe(true);
          expect(plan.items.filter(i => i.block === "care").length).toBeGreaterThanOrEqual(3);
          expect(plan.steps.every(s => s.kind === "timed"), "recovery is all timed").toBe(true);
        }
      });
    }
  }
}

test("core lifts: 2 in consistent, 2–3 in build, none in recovery; labelled with the block week", () => {
  const core = (mode: Mode, minutes: number) => Builder.build(data, input({ mode, minutes, theme: themeFor(mode) })).items.filter(i => i.block === "core");
  expect(core("consistent", 30).length).toBe(2);
  const b = core("build", 40);
  expect(b.length >= 2 && b.length <= 3).toBe(true);
  expect(core("recovery", 30).length).toBe(0);
  for (const it of b) {
    expect(it.why[0]).toBe("Core lift · block 1 · week 3 of 5");
    expect(it.target, `${it.exercise.id} has no target`).toBeTruthy();
    if (it.exercise.load === "external") expect(it.target!.w, `${it.exercise.id} has no weight`).toBeTruthy();
    expect(it.coreFamily).toBeTruthy();
  }
});

test("the same inputs always give the same plan; different days vary", () => {
  expect(JSON.stringify(Builder.build(data, input()))).toBe(JSON.stringify(Builder.build(data, input())));
  const days = ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28"];
  const preps = new Set(days.map(d => Builder.build(data, input({ today: d })).items.filter(i => i.block === "prep").map(i => i.exercise.id).join(",")));
  expect(preps.size, "prep never varies").toBeGreaterThanOrEqual(2);
});

test("leftover time goes to prep and cool-down, not to jaw care or arrival", () => {
  for (const mode of ["consistent", "build"] as const) {
    const plan = Builder.build(data, input({ mode, minutes: 40, theme: themeById("deskUnwind") }));
    const count = (b: string) => plan.items.filter(i => i.block === b).length;
    expect(count("care"), `${mode}: ${count("care")} care moves`).toBeLessThanOrEqual(3);
    expect(count("arrive"), `${mode}: ${count("arrive")} arrival moves`).toBeLessThanOrEqual(2);
  }
});

test("spare time becomes lifting volume first, and timed blocks stay within their caps", () => {
  for (const loc of [home, gym]) {
    for (const mode of ["consistent", "build"] as const) {
      for (const minutes of [30, 40]) {
        const plan = Builder.build(data, input({ mode, minutes, location: loc, theme: themeById("deskUnwind") }));
        const label = `${loc.id} ${mode} ${minutes}`;
        for (const b of ["arrive", "prep", "care", "cooldown"] as const) {
          const n = plan.items.filter(i => i.block === b).length;
          const max = data.skeleton.max[mode][b]!;
          expect(n, `${label}: ${n} ${b} moves (max ${max})`).toBeLessThanOrEqual(max);
        }
        const core = plan.items.filter(i => i.block === "core");
        expect(core.some(i => i.sets > i.exercise.dose.sets![0]), `${label}: core lifts stuck at minimum sets`).toBe(true);
        expect(plan.plannedSeconds, `${label}: ${plan.plannedSeconds}s`).toBeGreaterThanOrEqual(minutes * 60 * 0.8);
      }
    }
  }
});

test("more minutes means more exercises, not longer ones", () => {
  const short = Builder.build(data, input({ mode: "build", minutes: 15, theme: themeFor("build") }));
  const long = Builder.build(data, input({ mode: "build", minutes: 40, theme: themeFor("build") }));
  expect(long.items.length).toBeGreaterThan(short.items.length);
  const secsById = (plan: Plan) => Object.fromEntries(plan.steps.filter(s => s.kind === "timed" && s.format.id !== "circuit").map(s => [`${s.exerciseId}:${s.side}`, s.seconds]));
  const a = secsById(short), b = secsById(long);
  for (const k of Object.keys(a)) if (k in b) expect(a[k], k).toBe(b[k]);
});

test("a swap puts the chosen exercise in that slot and drops the original", () => {
  const base = Builder.build(data, input());
  const slot = base.items.find(i => i.slotKey === "prep:1")!;
  const alt = Builder.alternatives(data, input(), "prep:1")[0]!;
  const swappedPlan = Builder.build(data, input({ swaps: { "prep:1": { from: slot.exercise.id, to: alt.id } } }));
  expect(swappedPlan.items.find(i => i.slotKey === "prep:1")!.exercise.id).toBe(alt.id);
  expect(idsOf(swappedPlan)).not.toContain(slot.exercise.id);
  expect(swappedPlan.items.find(i => i.slotKey === "prep:1")!.why).toEqual(["Swapped in"]);
  // Blocks planned before prep are untouched by the swap (spare-time fillers added afterwards may shift).
  const outside = (plan: Plan) => plan.items.filter(i => ["arrive", "core", "accessory", "care"].includes(i.block) || i.slotKey === "cooldown:0").map(i => `${i.slotKey}=${i.exercise.id}`).join(",");
  expect(outside(swappedPlan)).toBe(outside(base));
});

test("bad swaps are ignored and change nothing", () => {
  const base = JSON.stringify(Builder.build(data, input({ mode: "recovery", theme: themeFor("recovery") })));
  const prep0 = Builder.build(data, input({ mode: "recovery", theme: themeFor("recovery") })).items.find(i => i.slotKey === "prep:0")!.exercise.id;
  for (const to of ["doesNotExist", "gobletSquat", prep0]) {
    const plan = Builder.build(data, input({ mode: "recovery", theme: themeFor("recovery"), swaps: { "prep:1": { to } } }));
    expect(JSON.stringify(plan), `swap to ${to} changed the plan`).toBe(base);
  }
});

test("bad or stale swaps that name the original are ignored too", () => {
  const i = (swaps: Record<string, { from?: string; to: string }>) => input({ swaps });
  const base = Builder.build(data, i({}));
  const at = (k: string) => base.items.find(x => x.slotKey === k)!.exercise.id;
  const baseJson = JSON.stringify(base);
  const cases: Array<Record<string, { from?: string; to: string }>> = [
    { "prep:1": { from: at("prep:1"), to: "doesNotExist" } },
    { "prep:1": { from: at("prep:1"), to: "halfKneelingPress" } },       // push-v: not allowed in consistent
    { "prep:1": { from: at("prep:1"), to: at("prep:0") } },              // already in the plan
    { "prep:1": { from: "breath", to: Builder.alternatives(data, i({}), "prep:1")[0]!.id } }, // stale: slot holds something else now
    { "core:0": { from: at("core:0"), to: "doesNotExist" } },
    { "core:0": { from: at("core:0"), to: "catCow" } },                  // not a core lift
  ];
  for (const swaps of cases) expect(JSON.stringify(Builder.build(data, i(swaps))), JSON.stringify(swaps)).toBe(baseJson);
});

test("sessions open with a breathing drill; the final jaw check never opens", () => {
  for (const loc of PLACES) for (const mode of MODES) for (const d of ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"]) {
    const plan = Builder.build(data, input({ today: d, mode, location: loc, theme: themeFor(mode) }));
    for (const it of plan.items.filter(x => x.block === "arrive")) {
      expect(it.exercise.patterns.includes("breathe"), `${loc.id} ${mode} ${d}: arrive has ${it.exercise.id}`).toBe(true);
      expect(it.exercise.id).not.toBe("finalJaw");
    }
  }
});

test("overhead pressing needs a calm jaw even when build is forced", () => {
  for (const d of ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"]) {
    for (const theme of data.themes.filter(t => t.modes.includes("build"))) {
      const plan = Builder.build(data, input({ today: d, mode: "build", pre: 5, minutes: 40, theme }));
      expect(plan.items.some(it => it.exercise.patterns.includes("push-v")), `${d} ${theme.id}: push-v on a rough day`).toBe(false);
    }
  }
});

test("a session never holds two versions of the same move (e.g. puppy pose with and without the block)", () => {
  const key = (ex: Plan["items"][number]["exercise"]) => `${ex.family}|${[...ex.regions].sort().join(",")}`;
  for (const loc of PLACES) for (const mode of MODES) for (const minutes of [15, 30, 40]) {
    for (const d of ["2026-09-27", "2026-09-28", "2026-09-29"]) {
      const plan = Builder.build(data, input({ today: d, mode, minutes, location: loc, theme: themeFor(mode) }));
      const seen = new Map<string, string>();
      for (const it of plan.items) {
        const k = key(it.exercise);
        expect(!seen.has(k) || seen.get(k) === it.exercise.id, `${loc.id} ${mode} ${minutes} ${d}: ${seen.get(k)} and ${it.exercise.id}`).toBe(true);
        seen.set(k, it.exercise.id);
      }
    }
  }
});

test("almost no equipment still gives a valid session", () => {
  for (const equipment of [[], ["mat"]]) {
    const plan = Builder.build(data, input({ location: { id: "bare", name: "Bare", equipment } }));
    expect(plan.items.length).toBeGreaterThanOrEqual(5);
    expect(plan.plannedSeconds).toBeLessThanOrEqual(1800);
    for (const it of plan.items) expect(Lib.hasEquipment(it.exercise, equipment), it.exercise.id).toBe(true);
    for (const b of ["arrive", "care", "cooldown"]) expect(plan.items.some(i => i.block === b), b).toBe(true);
  }
});

// History where every exercise except `keep` was done last week, so nothing is new yet this week.
const allDoneBut = (...keep: string[]): HistorySession[] => [normalise({
  id: "old", date: "2026-09-20", startedAt: "2026-09-20T18:00:00", seconds: 1800, pre: 1, post: 1, entries: [],
  done: data.exercises.filter(ex => !keep.includes(ex.id)).map(ex => ({ id: ex.id, secs: 60 })),
})];
const upperBack = themeById("upperBackNeck");

test("a never-done core lift counts as the week's new move", () => {
  const plan = Builder.build(data, input({ sessions: allDoneBut("supportedRow"), theme: upperBack }));
  expect(plan.newMove).toBe("supportedRow");
  const item = plan.items.find(i => i.exercise.id === "supportedRow")!;
  expect(item.block).toBe("core");
  expect(item.isNew).toBe(true);
});

test("the weekly new move is guaranteed whenever a never-done move fits a slot, even in short sessions", () => {
  const missed: string[] = [];
  for (const theme of data.themes.filter(t => t.modes.includes("consistent"))) {
    for (const keep of data.exercises) {
      if (keep.roles.includes("core") || !Lib.eligible(data, keep, { equipment: home.equipment, mode: "consistent" })) continue;
      const plan = Builder.build(data, input({ sessions: allDoneBut(keep.id), theme, minutes: 15 }));
      if (plan.newMove !== keep.id) { missed.push(`${theme.id}/${keep.id}`); continue; }
      const fresh = plan.items.filter(i => i.isNew);
      expect(fresh.length).toBe(1);
      expect(fresh[0]!.why[0]).toBe("New move this week");
      expect(plan.plannedSeconds).toBeLessThanOrEqual(900);
    }
  }
  expect(missed).toEqual([]);
});

test("going slightly over budget shrinks the plan a little instead of dropping whole blocks", () => {
  // This session used to land 17 s over budget and lose its entire accessory superset (and its new move).
  const plan = Builder.build(data, input({ sessions: allDoneBut("deadBug"), theme: themeById("deskUnwind"), minutes: 15 }));
  expect(plan.plannedSeconds).toBeLessThanOrEqual(900);
  expect(plan.plannedSeconds, `only ${plan.plannedSeconds}s of 900s planned`).toBeGreaterThanOrEqual(720);
  expect(plan.groups.some(g => g.block === "accessory"), "accessory block was dropped").toBe(true);
});

test("a never-done move that fits nowhere leaves the plan alone (walks superset groups safely)", () => {
  const theme = { id: "ss", name: "Supersets", blurb: "", modes: ["consistent" as const], emphasis: { patterns: {}, regions: {} }, formats: ["superset" as const], coreBias: [] };
  const plan = Builder.build(data, input({ sessions: allDoneBut("halfKneelingPress"), theme }));
  expect(plan.groups.some(g => g.block === "accessory" && g.format === "superset"), "no accessory superset to walk").toBe(true);
  expect(plan.items.filter(i => i.isNew).length).toBe(plan.newMove ? 1 : 0);
});

test("no new move once one has been introduced this week", () => {
  const sessions = [...allDoneBut("inclinePushup", "rdl"), normalise({ id: "mon", date: "2026-09-28", startedAt: "2026-09-28T18:00:00", seconds: 1800, pre: 1, post: 1, done: [{ id: "rdl", secs: 60 }], entries: [] })];
  expect(Builder.build(data, input({ sessions, theme: upperBack })).newMove).toBe(null);
});

test("step list shape", () => {
  const plan = Builder.build(data, input({ mode: "build", minutes: 40, theme: themeFor("build") }));
  for (const s of plan.steps) {
    expect(["timed", "set", "rest"]).toContain(s.kind);
    expect(s.seconds, `${s.kind} ${s.exerciseId} has ${s.seconds}s`).toBeGreaterThan(0);
    if (s.kind === "set") { expect(s.log).toBe(true); expect(s.target).toBeTruthy(); }
    if (s.kind !== "rest") expect(Lib.get(data, s.exerciseId)).toBeTruthy();
  }
  expect(plan.steps[plan.steps.length - 1]!.kind).not.toBe("rest");
  const straight = plan.groups.find(g => g.format === "straight" && g.items.length === 1 && g.items[0]!.sets >= 2 && g.items[0]!.exercise.dose.type === "reps");
  if (straight) {
    const kinds = Builder.groupSteps(data, straight).map(s => s.kind);
    expect(kinds.slice(0, 3)).toEqual(["set", "rest", "set"]);
    expect(kinds[kinds.length - 1]).not.toBe("rest");
  }
  expect(plan.plannedSeconds).toBe(Builder.costOf(plan.steps));
});

describe("beyond the standalone suite", () => {
  const DAYS = ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"];
  const gymBuilds = (pre: number | null, extra = {}) => DAYS.flatMap(d => data.themes.filter(t => t.modes.includes("build")).map(theme =>
    Builder.build(data, input({ today: d, mode: "build", pre, minutes: 40, location: gym, theme, ...extra }))));
  const hasPushV = (plan: Plan) => plan.items.some(it => it.exercise.patterns.includes("push-v"));

  test("overhead pressing needs an answered check: with no check today, build never includes it (spec §5 change 1)", () => {
    expect(gymBuilds(1).some(hasPushV), "a calm, answered check should allow overhead pressing somewhere").toBe(true);
    expect(gymBuilds(null).some(hasPushV)).toBe(false);
    expect(gymBuilds(null, { checks: {} }).some(hasPushV)).toBe(false);
  });

  test("a build carries up to 3 alternatives per slot, with the steps a swap would play", () => {
    const plan = Builder.build(data, input({ mode: "build", minutes: 40, theme: themeFor("build") }));
    const planIds = new Set(idsOf(plan));
    expect(Object.keys(plan.alternatives).sort()).toEqual(plan.items.map(i => i.slotKey).sort());
    for (const it of plan.items) {
      const alts = plan.alternatives[it.slotKey]!;
      expect(alts.length).toBeLessThanOrEqual(3);
      expect(alts).toEqual(Builder.alternatives(data, input({ mode: "build", minutes: 40, theme: themeFor("build") }), it.slotKey));
      for (const a of alts) {
        expect(planIds.has(a.id), `${a.id} is already in the plan`).toBe(false);
        expect(a.steps.length).toBeGreaterThan(0);
        for (const s of a.steps) {
          expect(s.slotKey).toBe(it.slotKey);
          expect(s.exerciseId).toBe(a.id);
          expect(s.kind).not.toBe("rest");
        }
      }
    }
    // In every slot, each offered alternative's steps are exactly what the swapped build plays there
    // (swaps.test.ts checks this over a few hundred seeded builds).
    for (const slot of plan.items) {
      for (const alt of plan.alternatives[slot.slotKey]!) {
        const swapped = Builder.build(data, input({ mode: "build", minutes: 40, theme: themeFor("build"), swaps: { [slot.slotKey]: { from: slot.exercise.id, to: alt.id } } }));
        expect(swapped.items.find(i => i.slotKey === slot.slotKey)!.exercise.id).toBe(alt.id);
        expect(swapped.steps.filter(s => s.slotKey === slot.slotKey && s.kind !== "rest")).toEqual(alt.steps);
      }
    }
  });

  test("alternatives follow the day's checks too: no overhead pressing offered on a rough day", () => {
    for (const plan of gymBuilds(5)) {
      for (const alts of Object.values(plan.alternatives)) {
        for (const a of alts) expect(Lib.get(data, a.id)!.patterns.includes("push-v"), a.id).toBe(false);
      }
    }
  });
});
