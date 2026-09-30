import { parseWeightList, type Weight } from "@rg/domain";
import { makeEngineData } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Blocks, Lib, Rng, type Block, type BlockCtx } from "../src/index.js";
import { dataWith, ex, lifted, session, tmj } from "./fixtures.js";

// Ported from the standalone tests/engine-blocks.test.js.

const data = dataWith([
  lifted("gobletSquat", { family: "squat" }),
  lifted("frontSquat", { family: "squat", difficulty: 3 }),
  ex("tempoSquat", { patterns: ["squat"], roles: ["core"], family: "squat", load: "bodyweight", dose: { type: "reps", range: [8, 15] } }),
  lifted("deadlift", { patterns: ["hinge"], family: "deadlift" }),
  lifted("rdl", { patterns: ["hinge"], family: "deadlift", difficulty: 3 }),
  lifted("supportedRow", { patterns: ["pull-h"], family: "row" }),
  lifted("chestRow", { patterns: ["pull-h"], family: "row", equipment: { all: ["bench", "dumbbells"], oneOf: [] } }),
  ex("proneRow", { patterns: ["pull-h"], roles: ["core"], family: "row", load: "bodyweight", dose: { type: "reps", range: [6, 10] }, difficulty: 2 }),
  lifted("floorPress", { patterns: ["push-h"], family: "press" }),
  lifted("ohPress", { patterns: ["push-v"], family: "press", difficulty: 3 }),
  lifted("suitcaseCarry", { patterns: ["carry"], family: "carry", dose: { type: "carry", range: [30, 60], sets: [2, 3], restSec: 60 } }),
]);
const home = ["mat", "kettlebell", "bench"];
const prefs = { ratings: {}, excluded: [], pinned: [] };
const lb = (v: number): Weight => ({ v, u: "lb" });
const ctx = (extra: Partial<BlockCtx> = {}): BlockCtx => ({ today: "2026-09-01", equipment: home, prefs, weeks: 5, sessions: [], ...extra });
const withCore = (b: Block, core: Record<string, string>): Block => ({ ...b, core: { ...b.core, ...core } });

test("a first block picks one Home-friendly lift per family, never overhead pressing", () => {
  const { block, events } = Blocks.ensure(data, null, ctx());
  expect(block.number).toBe(1);
  expect(block.startedAt).toBe("2026-09-01");
  expect(block.weeks).toBe(5);
  expect(block.core.row).toBe("supportedRow");       // chestRow needs dumbbells
  expect(block.core.press).toBe("floorPress");
  expect(["gobletSquat", "tempoSquat", "frontSquat"]).toContain(block.core.squat);
  expect(events[0]).toMatch(/Block 1/);
});

test("after the block's weeks a new block rotates unpinned lifts and keeps pins", () => {
  const first: Block = { id: "b1", number: 1, startedAt: "2026-09-01", weeks: 5, core: { squat: "gobletSquat", hinge: "deadlift", row: "supportedRow", press: "floorPress", carry: "suitcaseCarry" }, rotations: [] };
  const { block, events } = Blocks.ensure(data, first, ctx({ today: "2026-10-06", prefs: { ...prefs, pinned: ["deadlift"] } }));
  expect(block.number).toBe(2);
  expect(block.core.squat).not.toBe("gobletSquat");
  expect(block.core.hinge).toBe("deadlift");
  expect(events[0]).toMatch(/Block 1 complete/);
});

test("mid-block: rotate early after clenching in 2 of 3 sessions", () => {
  const b = withCore(Blocks.ensure(data, null, ctx()).block, { squat: "gobletSquat" });
  const sessions = ["2026-09-03", "2026-09-05", "2026-09-08"].map((d, i) => session(d, { entries: [{ id: "gobletSquat", clenched: i > 0, sets: [{ w: lb(25), reps: 8 }] }] }));
  const { block, events } = Blocks.ensure(data, b, ctx({ today: "2026-09-10", sessions }));
  expect(block.core.squat).not.toBe("gobletSquat");
  expect(events[0]).toMatch(/clenched/);
  expect(block.rotations.length).toBe(1);
});

test("mid-block: rotate early after 3 sessions without progress, not while improving", () => {
  const b = withCore(Blocks.ensure(data, null, ctx()).block, { hinge: "deadlift" });
  const flat = ["2026-09-02", "2026-09-04", "2026-09-06", "2026-09-08"].map(d => session(d, { entries: [{ id: "deadlift", sets: [{ w: lb(30), reps: 8 }] }] }));
  expect(Blocks.ensure(data, b, ctx({ today: "2026-09-10", sessions: flat })).block.core.hinge).not.toBe("deadlift");
  const rising = ["2026-09-02", "2026-09-04", "2026-09-06", "2026-09-08"].map((d, i) => session(d, { entries: [{ id: "deadlift", sets: [{ w: lb(30), reps: 6 + i }] }] }));
  expect(Blocks.ensure(data, b, ctx({ today: "2026-09-10", sessions: rising })).block.core.hinge).toBe("deadlift");
});

test("rotation doesn't flip-flop: a lift rotated out stays out, and one rotation per family per day", () => {
  const b = withCore(Blocks.ensure(data, null, ctx()).block, { row: "supportedRow" });
  const clenchy = ["2026-09-03", "2026-09-05", "2026-09-08"].map((d, i) => session(d, { idSuffix: "r", entries: [{ id: "supportedRow", clenched: i > 0, sets: [{ w: lb(25), reps: 8 }] }] }));
  const first = Blocks.ensure(data, b, ctx({ today: "2026-09-10", sessions: clenchy })).block;
  expect(first.core.row).toBe("proneRow");
  // proneRow then stalls, but supportedRow was rotated out for clenching this block: it must not come back.
  const stalled = ["2026-09-11", "2026-09-13", "2026-09-15", "2026-09-17"].map(d => session(d, { idSuffix: "p", entries: [{ id: "proneRow", sets: [{ w: null, reps: 10 }] }] }));
  const second = Blocks.ensure(data, first, ctx({ today: "2026-09-18", sessions: [...clenchy, ...stalled] })).block;
  expect(second.core.row).toBe("proneRow");
  const again = Blocks.ensure(data, second, ctx({ today: "2026-09-18", sessions: [...clenchy, ...stalled] })).block;
  expect(again.core.row).toBe("proneRow");
  expect(again.rotations.length).toBe(1);
});

test("a lift judged only on sessions since it joined the block", () => {
  const b: Block = { ...withCore(Blocks.ensure(data, null, ctx()).block, { hinge: "rdl" }), rotations: [{ family: "hinge", from: "deadlift", to: "rdl", date: "2026-09-09", why: "test" }] };
  // Old stalled rdl sessions from before it rotated in don't count.
  const old = ["2026-09-02", "2026-09-04", "2026-09-06", "2026-09-08"].map(d => session(d, { idSuffix: "h", entries: [{ id: "rdl", sets: [{ w: lb(30), reps: 8 }] }] }));
  expect(Blocks.ensure(data, b, ctx({ today: "2026-09-10", sessions: old })).block.core.hinge).toBe("rdl");
});

test("a block lift that's no longer in the library is replaced, not a crash", () => {
  const b = withCore(Blocks.ensure(data, null, ctx()).block, { squat: "ghostSquat" });
  const sessions = ["2026-09-03", "2026-09-05", "2026-09-08"].map(d => session(d, { idSuffix: "g", entries: [{ id: "ghostSquat", clenched: true, sets: [{ w: lb(25), reps: 8 }] }] }));
  const { block, events } = Blocks.ensure(data, b, ctx({ today: "2026-09-10", sessions }));
  expect(Lib.get(data, block.core.squat), String(block.core.squat)).toBeTruthy();
  expect(events.join(" ")).toMatch(/ghostSquat/);
});

test("a topped-out lift moves up a level at the next block", () => {
  const first: Block = { id: "b1", number: 1, startedAt: "2026-09-01", weeks: 5, core: { squat: "gobletSquat", hinge: "deadlift", row: "supportedRow", press: "floorPress", carry: "suitcaseCarry" }, rotations: [] };
  const sessions = [session("2026-10-01", { idSuffix: "t", entries: [{ id: "gobletSquat", sets: [{ w: lb(35), reps: 8 }, { w: lb(35), reps: 8 }] }] })];
  const kbWeights = parseWeightList("10, 15, 20, 25, 30, 35 lb", "lb");
  // A rating pulls toward the easier tempo squat unless topped-out logic lifts the target level.
  const liked = { ratings: { tempoSquat: 1 }, excluded: [], pinned: [] };
  expect(Blocks.ensure(data, first, ctx({ today: "2026-10-06", sessions: [], kbWeights, unit: "lb", prefs: liked })).block.core.squat).toBe("tempoSquat");
  const next = Blocks.ensure(data, first, ctx({ today: "2026-10-06", sessions, kbWeights, unit: "lb", prefs: liked })).block;
  expect(next.core.squat).toBe("frontSquat");
});

test("graduate swaps a family's block lift for the harder move", () => {
  const b = withCore(Blocks.ensure(data, null, ctx()).block, { squat: "gobletSquat" });
  const g = Blocks.graduate(data, b, "squat", "frontSquat", "2026-09-20", ["kettlebell"]);
  expect(g.core.squat).toBe("frontSquat");
  expect(g.rotations[g.rotations.length - 1]!.why).toBe("graduated");
  expect(Blocks.graduate(data, b, "squat", "floorPress", "2026-09-20", ["kettlebell"]).core.squat).toBe("gobletSquat");  // wrong family: unchanged
});

test("resolveCore maps to what the location allows", () => {
  const b = { core: { squat: "gobletSquat", row: "supportedRow" } };
  expect(Blocks.resolveCore(data, b, "squat", ["dumbbells"], "build")?.id).toBe("gobletSquat");
  expect(Blocks.resolveCore(data, b, "squat", ["mat"], "build")?.id).toBe("tempoSquat");
  expect(Blocks.resolveCore(data, { core: { press: "floorPress" } }, "press", ["mat"], "build")).toBe(null);
});

test("familiesForSession: count by mode, untrained families first, theme bias", () => {
  const b = { startedAt: "2026-09-01", core: { squat: "gobletSquat", hinge: "deadlift", row: "supportedRow", press: "floorPress", carry: "suitcaseCarry" } };
  const rng = () => Rng.create("x");
  const sessions = [session("2026-09-09", { entries: [{ id: "gobletSquat", sets: [] }, { id: "deadlift", sets: [] }] })];
  expect(Blocks.familiesForSession(data, b, { mode: "recovery", sessions, today: "2026-09-10", rng: rng() }).length).toBe(0);
  const consistent = Blocks.familiesForSession(data, b, { mode: "consistent", sessions, today: "2026-09-10", rng: rng() });
  expect(consistent.length).toBe(2);
  expect(!consistent.includes("squat") && !consistent.includes("hinge"), consistent.join()).toBe(true);
  const themed = Blocks.familiesForSession(data, b, { mode: "build", sessions: [], today: "2026-09-10", theme: { coreBias: ["carry"] }, rng: rng() });
  expect(themed.length).toBe(3);
  expect(themed[0]).toBe("carry");
});

test("weekOf counts from the block start", () => {
  expect(Blocks.weekOf({ startedAt: "2026-09-01" }, "2026-09-01")).toBe(1);
  expect(Blocks.weekOf({ startedAt: "2026-09-01" }, "2026-09-15")).toBe(3);
});

test("a block's core lift prefers a loaded variant over a bodyweight one at the same level", () => {
  const picks = new Set<string | null | undefined>();
  for (let d = 1; d <= 28; d++) picks.add(Blocks.ensure(data, null, ctx({ today: `2026-09-${String(d).padStart(2, "0")}` })).block.core.row);
  expect([...picks]).toEqual(["supportedRow"]);
  const mat = Blocks.ensure(data, null, ctx({ equipment: ["mat"] })).block.core.row;
  expect(mat, "without a bell, the bodyweight row is still the lift").toBe("proneRow");
});

describe("beyond the standalone suite", () => {
  test("with no profile active, rotation ignores flags and overhead pressing may be a block lift", () => {
    const none = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: data.exercises });
    const b = withCore(Blocks.ensure(none, null, ctx()).block, { squat: "gobletSquat" });
    const sessions = ["2026-09-03", "2026-09-05", "2026-09-08"].map((d, i) => session(d, { entries: [{ id: "gobletSquat", clenched: i > 0, sets: [{ w: lb(25), reps: 6 + i }] }] }));
    expect(Blocks.ensure(none, b, ctx({ today: "2026-09-10", sessions })).block.core.squat).toBe("gobletSquat");
    expect(Blocks.familyCandidates(none, "press", { equipment: home }).map(x => x.id)).toContain("ohPress");
  });

  describe("a block lift an active profile forbids is not kept (audit M6)", () => {
    // heavySquat is clench 3 (TMJ never), e.g. assigned while no profile was active; ohPress is overhead pressing.
    const withHeavy = dataWith([...data.exercises.map(e => e as never), lifted("heavySquat", { family: "squat", conditions: tmj(3) })]);
    const block = (core: Record<string, string>): Block => ({ ...Blocks.ensure(withHeavy, null, ctx()).block, core: { ...Blocks.ensure(withHeavy, null, ctx()).block.core, ...core } });

    test("mid-block, an unpinned or pinned forbidden lift rotates out with the profile's reason", () => {
      for (const pinned of [[], ["heavySquat"]]) {
        const { block: next, events } = Blocks.ensure(withHeavy, block({ squat: "heavySquat" }), ctx({ today: "2026-09-03", prefs: { ...prefs, pinned } }));
        expect(next.core.squat).not.toBe("heavySquat");
        expect(events.join(" ")).toMatch(/heavySquat → .+: not allowed with TMJ\./);
      }
      const { block: next } = Blocks.ensure(withHeavy, block({ press: "ohPress" }), ctx({ today: "2026-09-03", prefs: { ...prefs, pinned: ["ohPress"] } }));
      expect(next.core.press).not.toBe("ohPress");
    });

    test("graduation never switches a block to a lift an active profile rules out (re-review m6)", () => {
      const b = block({ press: "floorPress" });
      expect(Blocks.graduate(withHeavy, b, "press", "ohPress", "2026-09-03", home)).toBe(b);
      expect(Blocks.graduate(withHeavy, block({ squat: "gobletSquat" }), "squat", "heavySquat", "2026-09-03", home).core.squat).toBe("gobletSquat");
      expect(Blocks.graduate(withHeavy, block({ squat: "gobletSquat" }), "squat", "frontSquat", "2026-09-03", home).core.squat).toBe("frontSquat");
    });

    test("a pinned forbidden lift is not carried into the next block", () => {
      const old = { ...block({ squat: "heavySquat" }), startedAt: "2026-07-01" };
      const next = Blocks.ensure(withHeavy, old, ctx({ today: "2026-09-03", prefs: { ...prefs, pinned: ["heavySquat"] } })).block;
      expect(next.number).toBe(2);
      expect(next.core.squat).not.toBe("heavySquat");
    });
  });
});
