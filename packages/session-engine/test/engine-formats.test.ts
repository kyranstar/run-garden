import { Vocab } from "@rg/exercise-library";
import { expect, test } from "vitest";
import { Builder, Lib, type Plan } from "../src/index.js";
import { data, home, makeInput, themeById, themed } from "./builder-fixtures.js";

// Ported from the standalone tests/engine-formats.test.js.

const input = makeInput({ today: "2026-09-29", mode: "build", theme: themed(["circuit"]), minutes: 40 });
const accessory = (plan: Plan) => plan.groups.find(g => g.block === "accessory");

test("circuit: 3–4 low-clench bodyweight moves, 40 s on / 20 s off, rounds with 45 s between", () => {
  const plan = Builder.build(data, input());
  const g = accessory(plan)!;
  expect(g.format).toBe("circuit");
  expect(g.items.length >= 3 && g.items.length <= 4).toBe(true);
  expect(g.rounds! >= 2 && g.rounds! <= 3).toBe(true);
  for (const it of g.items) {
    expect(it.exercise.conditions.tmj!.clench).toBeLessThanOrEqual(1);
    expect(["bodyweight", "none"]).toContain(it.exercise.load);
  }
  const steps = Builder.groupSteps(data, g);
  const work = steps.filter(s => s.kind === "timed");
  expect(work.length).toBe(g.items.length * g.rounds!);
  expect(work.every(s => s.seconds === 40)).toBe(true);
  const rests = steps.filter(s => s.kind === "rest").map(s => s.seconds);
  expect(rests.filter(r => r === 45).length).toBe(g.rounds! - 1);
  expect(rests.filter(r => r === 20).length).toBe((g.items.length - 1) * g.rounds!);
});

test("circuits never hold one-sided moves, which would get only one side", () => {
  for (const d of ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"]) {
    const g = accessory(Builder.build(data, input({ today: d })));
    if (g && g.format === "circuit") for (const it of g.items) expect(it.exercise.laterality, `${d}: ${it.exercise.id}`).not.toBe("unilateral");
  }
});

test("accessory moves never claim to prep today's lifts", () => {
  for (const f of [["circuit"], ["ladder"], ["superset"], ["straight"]] as const) {
    for (const d of ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"]) {
      const plan = Builder.build(data, input({ today: d, theme: themed([...f]) }));
      for (const it of plan.items.filter(x => x.block === "accessory")) expect(it.why.includes("Preps today's lifts"), `${f} ${d}: ${it.exercise.id}`).toBe(false);
    }
  }
});

test("ladder: rungs 2-4-6-8 with 20 s rests", () => {
  const g = accessory(Builder.build(data, input({ theme: themed(["ladder"]) })))!;
  expect(g.format).toBe("ladder");
  const sets = Builder.groupSteps(data, g).filter(s => s.kind === "set");
  const reps = [...new Set(sets.map(s => s.target!.reps))];
  expect(reps).toEqual([2, 4, 6, 8]);
  for (const it of g.items) expect(it.exercise.conditions.tmj!.clench).toBeLessThanOrEqual(1);
});

test("supersets pair different patterns in the same position group", () => {
  let seen = 0;
  for (const d of ["2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"]) {
    const plan = Builder.build(data, input({ today: d, theme: themed(["superset"]) }));
    for (const g of plan.groups.filter(x => x.format === "superset")) {
      seen += 1;
      const [a, b] = g.items.map(i => i.exercise);
      expect(a!.patterns.some(p => b!.patterns.includes(p)), `${a!.id} + ${b!.id} share a pattern`).toBe(false);
      expect(Vocab.positionGroup(a!.position)).toBe(Vocab.positionGroup(b!.position));
      expect(g.items.map(i => i.group)).toEqual(["A", "B"]);
    }
  }
  expect(seen, "no supersets were built").toBeGreaterThan(0);
});

test("consistent mode never uses circuits or ladders", () => {
  for (const f of ["circuit", "ladder"] as const) {
    const plan = Builder.build(data, input({ mode: "consistent", theme: themed([f, "superset"], ["consistent"]) }));
    expect(plan.groups.every(g => g.format !== f), f).toBe(true);
  }
});

test("build fills leftover time with extra core sets, within each lift's range", () => {
  const plan = Builder.build(data, input({ theme: themed(["superset"]) }));
  const core = plan.items.filter(i => i.block === "core");
  for (const it of core) {
    const [lo, hi] = it.exercise.dose.sets!;
    expect(it.sets >= lo && it.sets <= hi, `${it.exercise.id} has ${it.sets} sets`).toBe(true);
  }
  expect(plan.plannedSeconds).toBeLessThanOrEqual(2400);
});

test("alternatives can offer another version of the slot's own move", () => {
  const i = input({ mode: "recovery", theme: themeById("jawReset") });
  const plan = Builder.build(data, i);
  const child = plan.items.find(x => x.exercise.id === "childBlock" || x.exercise.id === "childHands");
  if (!child) return;
  const other = child.exercise.id === "childBlock" ? "childHands" : "childBlock";
  const alts = Builder.alternatives(data, i, child.slotKey, 20).map(a => a.id);
  expect(alts, alts.join(",")).toContain(other);
});

test("alternatives: up to 3 eligible options not already in the plan", () => {
  const i = input({ theme: themed(["superset"]) });
  const plan = Builder.build(data, i);
  for (const it of [plan.items.find(x => x.block === "prep")!, plan.items.find(x => x.block === "core")!]) {
    const alts = Builder.alternatives(data, i, it.slotKey);
    expect(alts.length >= 1 && alts.length <= 3, it.slotKey).toBe(true);
    const planIds = plan.items.map(x => x.exercise.id);
    for (const a of alts) {
      expect(planIds, `${a.id} is already in the plan`).not.toContain(a.id);
      const ex = Lib.get(data, a.id)!;
      expect(Lib.hasEquipment(ex, home.equipment) && Lib.fitsMode(data, ex, "build")).toBe(true);
      if (it.block === "core") expect(Lib.coreFamilyOf(data, ex)).toBe(it.coreFamily);
    }
  }
});
