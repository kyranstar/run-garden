import { parseWeightList, type Weight } from "@rg/domain";
import { makeEngineData } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Lib, Prog, type HistorySet, type Mode, type ProgCtx, type ProgEntry } from "../src/index.js";
import { dataWith, ex, lifted, normalise, session } from "./fixtures.js";

// Ported from the standalone tests/engine-prog.test.js.

const data = dataWith([
  lifted("gobletSquat", { harder: ["frontSquat"], legacyIds: ["kbGoblet"] }),
  lifted("frontSquat", { difficulty: 3, equipment: { all: [], oneOf: ["kettlebell"] } }),
  lifted("suitcaseCarry", { patterns: ["carry"], laterality: "unilateral", dose: { type: "carry", range: [30, 60], sets: [2, 3], restSec: 60 } }),
  ex("tempoSquat", { patterns: ["squat"], roles: ["core"], load: "bodyweight", dose: { type: "reps", range: [8, 15] }, harder: ["bwSplitSquat"] }),
  ex("bwSplitSquat", { patterns: ["lunge"], roles: ["core"], load: "bodyweight", dose: { type: "reps", range: [8, 12] } }),
  ex("sidePlank", { patterns: ["anti-lateral"], roles: ["core"], load: "bodyweight", dose: { type: "time", range: [20, 40] } }),
  lifted("floorPress", { dose: { type: "reps", range: [6, 10], sets: [2, 3], restSec: 60, startKg: 8 } }),
]);

const lb = (v: number): Weight => ({ v, u: "lb" });
const kg = (v: number): Weight => ({ v, u: "kg" });
const kb: ProgCtx = { mode: "build", checks: {}, implement: "kettlebell", kbWeights: parseWeightList("10, 15, 20, 25, 30, 35 lb", "lb"), unit: "lb", equipment: ["kettlebell"] };
const gym: ProgCtx = { mode: "build", checks: {}, implement: "dumbbells", kbWeights: [], unit: "lb", equipment: ["dumbbells"] };
const withPre = (ctx: ProgCtx, pre: number | null): ProgCtx => ({ ...ctx, checks: { tmj: { pre, post: null, feelingOff: false } } });
const sets = (list: Array<Partial<HistorySet>>): HistorySet[] => list.map(s => ({ w: null, reps: null, secs: null, ...s }));

/** A logged history item (the standalone `past`): clean, pre/post 1, a build session on 2026-09-20. */
function past(list: Array<Partial<HistorySet>>, extra: { clenched?: boolean; pre?: number | null; post?: number | null; mode?: Mode | null; date?: string } = {}): ProgEntry {
  const { clenched = false, pre = 1, post = 1, mode = "build", date = "2026-09-20" } = extra;
  return { date, startedAt: date, sets: sets(list), flags: clenched ? ["clenched"] : [], checks: { tmj: { pre, post, feelingOff: false } }, mode };
}
const g = () => Lib.get(data, "gobletSquat")!;
const byId = (id: string) => Lib.get(data, id)!;

test("start weight comes from the exercise's startKg, snapped to a bell", () => {
  const s = Prog.suggest(data, g(), [], kb);
  expect(s.action).toBe("start");
  expect(s.w).toEqual(lb(25));
  expect(s.reps).toBe(5);
  expect(Prog.suggest(data, byId("floorPress"), [], kb).w).toEqual(lb(15));
  expect(Prog.suggest(data, g(), [], { ...gym, unit: "kg" }).w).toEqual({ v: 12.5, u: "kg" });
});

test("build: top of the range with a quiet jaw goes up one bell", () => {
  const s = Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }, { w: lb(25), reps: 8 }])], kb);
  expect(s.action).toBe("up");
  expect(s.w).toEqual(lb(30));
  expect(s.reps).toBe(5);
  expect(s.note).toBe("Hit 8 with a quiet jaw — go up.");
});

test("consistent: needs two sessions at the top before going up", () => {
  const top = past([{ w: lb(25), reps: 8 }]);
  const once = Prog.suggest(data, g(), [top], { ...kb, mode: "consistent" });
  expect(once.action).toBe("hold");
  expect(once.w).toEqual(lb(25));
  const twice = Prog.suggest(data, g(), [top, { ...top, date: "2026-09-18" }], { ...kb, mode: "consistent" });
  expect(twice.action).toBe("up");
});

test("missing the top adds a rep at the same weight", () => {
  const s = Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }, { w: lb(25), reps: 6 }])], kb);
  expect(s.action).toBe("reps");
  expect(s.reps).toBe(7);
});

test("clench or a symptom rise steps down; a rough pre-check holds", () => {
  const clenched = Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }], { clenched: true })], kb);
  expect(clenched.w).toEqual(lb(20));
  expect(clenched.note).toBe("You clenched last time — one step lighter.");
  const rose = Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }], { pre: 2, post: 4 })], kb);
  expect(rose.action).toBe("down");
  expect(rose.note).toBe("Symptoms rose during last session — one step lighter.");
  expect(Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }])], withPre(kb, 5)).action).toBe("hold");
  expect(Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }])], withPre(kb, 5)).note).toBe("Jaw/head is up today — hold here and keep it easy.");
  expect(Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }])], withPre(kb, 3)).action).toBe("hold");
  expect(Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }])], withPre(kb, 3)).note).toBe("Symptoms are higher than last session — hold here.");
  expect(Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }])], withPre(kb, 2)).action).toBe("up");
});

test("recovery steps down once, then holds", () => {
  expect(Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }])], { ...kb, mode: "recovery" }).action).toBe("down");
  const s = Prog.suggest(data, g(), [past([{ w: lb(20), reps: 5 }], { mode: "recovery" })], { ...kb, mode: "recovery" });
  expect(s.action).toBe("hold");
  expect(s.w).toEqual(lb(20));
});

test("topped out at the heaviest bell suggests the harder variant", () => {
  const s = Prog.suggest(data, g(), [past([{ w: lb(35), reps: 8 }])], kb);
  expect(s.action).toBe("graduate");
  expect(s.graduate).toBe("frontSquat");
  const noGear = Prog.suggest(data, g(), [past([{ w: lb(35), reps: 8 }])], { ...kb, equipment: ["dumbbells"] });
  expect(noGear.action).toBe("tempo");
});

test("dumbbells step on a 5 lb / 2.5 kg grid; off-list bells snap down", () => {
  expect(Prog.suggest(data, g(), [past([{ w: lb(26), reps: 8 }])], gym).w).toEqual(lb(30));
  expect(Prog.suggest(data, g(), [past([{ w: kg(12), reps: 8 }])], gym).w).toEqual({ v: 12.5, u: "kg" });
  expect(Prog.suggest(data, g(), [past([{ w: lb(28), reps: 6 }])], kb).w).toEqual(lb(25));
});

test("an empty or garbage bell list falls back to the grid (no NaN)", () => {
  for (const weights of ["", "abc", "lb"]) {
    const ctx = { ...kb, kbWeights: parseWeightList(weights, "lb") };
    const start = Prog.suggest(data, g(), [], ctx);
    expect(start.w, weights).toEqual(lb(25));
    expect(Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }])], ctx).w, weights).toEqual(lb(30));
  }
});

test("carries go up after two clean sessions at the same weight", () => {
  const c = byId("suitcaseCarry");
  const one = Prog.suggest(data, c, [past([{ w: lb(25), secs: 60 }])], kb);
  expect(one.action).toBe("hold");
  expect(one.secs).toBe(60);
  const two = Prog.suggest(data, c, [past([{ w: lb(25), secs: 60 }]), past([{ w: lb(25), secs: 60 }])], kb);
  expect(two.action).toBe("up");
  expect(two.w).toEqual(lb(30));
});

test("bodyweight reps add a rep, then graduate to the harder move", () => {
  const t = byId("tempoSquat");
  expect(Prog.suggest(data, t, [], kb).reps).toBe(8);
  expect(Prog.suggest(data, t, [past([{ w: null, reps: 10 }])], kb).reps).toBe(11);
  const top = Prog.suggest(data, t, [past([{ w: null, reps: 15 }])], kb);
  expect(top.action).toBe("graduate");
  expect(top.graduate).toBe("bwSplitSquat");
});

test("holds add 5 s per clean session and shorten after a rough one", () => {
  const p = byId("sidePlank");
  expect(Prog.suggest(data, p, [], kb).secs).toBe(20);
  const more = Prog.suggest(data, p, [past([{ w: null, reps: null, secs: 25 }])], kb);
  expect(more.action).toBe("more");
  expect(more.secs).toBe(30);
  const rough = Prog.suggest(data, p, [past([{ secs: 30 }], { clenched: true })], kb);
  expect(rough.secs).toBe(25);
  expect(rough.note).toBe("You clenched last time — shorter hold today.");
  expect(Prog.suggest(data, p, [past([{ secs: 30 }], { pre: 1, post: 3 })], kb).note).toBe("Symptoms rose last time — shorter hold today.");
  expect(Prog.suggest(data, p, [past([{ secs: 40 }])], kb).action).toBe("tempo");
});

test("stepWeight walks the bell list and the dumbbell grid", () => {
  expect(Prog.stepWeight(lb(25), 1, kb)).toEqual(lb(30));
  expect(Prog.stepWeight(lb(10), -1, kb)).toEqual(lb(10));
  expect(Prog.stepWeight(lb(27), -1, gym)).toEqual(lb(25));
});

test("improved compares weight, then reps, then time", () => {
  const a = (list: Array<Partial<HistorySet>>) => ({ sets: sets(list) });
  expect(Prog.improved(a([{ w: lb(30), reps: 5 }]), a([{ w: lb(25), reps: 8 }]))).toBe(true);
  expect(Prog.improved(a([{ w: lb(25), reps: 8 }]), a([{ w: lb(25), reps: 7 }]))).toBe(true);
  expect(Prog.improved(a([{ w: lb(25), reps: 7 }]), a([{ w: lb(25), reps: 7 }]))).toBe(false);
  expect(Prog.improved(a([{ secs: 35 }]), a([{ secs: 30 }]))).toBe(true);
});

test("ladder and circuit entries don't feed progression", () => {
  const sessions = [
    session("2026-09-01", { entries: [{ id: "gobletSquat", sets: [{ w: lb(25), reps: 7 }] }] }),
    session("2026-09-03", { entries: [{ id: "gobletSquat", format: "ladder", sets: [2, 4, 6, 8].map(reps => ({ w: lb(25), reps })) }] }),
  ];
  const h = Prog.historyFor(data, sessions, "gobletSquat");
  expect(h.length).toBe(1);
  expect(Prog.suggest(data, g(), h, kb).reps).toBe(8);
});

test("damaged history (null entries, missing startedAt) doesn't crash and sorts by date", () => {
  const sessions = [
    normalise({ id: "a", date: "2026-09-10", entries: [null, { id: "gobletSquat", sets: [{ w: lb(20), reps: 8 }] }] }),
    normalise({ id: "b", date: "2026-09-12", startedAt: "2026-09-12T08:00:00", entries: [{ id: "gobletSquat", sets: [{ w: lb(25), reps: 8 }] }], done: [null] }),
    normalise({ id: "c", date: "2026-09-05", entries: [{ id: "gobletSquat", sets: [null, { w: lb(15), reps: 8 }] }] }),
  ];
  const h = Prog.historyFor(data, sessions, "gobletSquat");
  expect(h.map(e => e.date)).toEqual(["2026-09-12", "2026-09-10", "2026-09-05"]);
});

test("historyFor resolves legacy ids and pass-1 flare sessions", () => {
  const sessions = [
    session("2026-09-01", { entries: [{ id: "kbGoblet", clenched: false, sets: [{ w: lb(20), reps: 8 }] }] }),
    session("2026-09-05", { plan: { phase: "flare" }, pre: 3, post: 3, entries: [{ id: "gobletSquat", clenched: true, sets: [{ w: lb(25), reps: 6 }] }] }),
    session("2026-09-06", { entries: [{ id: "ghost", sets: [{ reps: 3 }] }] }),
  ];
  const h = Prog.historyFor(data, sessions, "gobletSquat");
  expect(h.length).toBe(2);
  expect(h[0]!.date).toBe("2026-09-05");
  expect(h[0]!.mode).toBe("recovery");
  expect(h[0]!.flags).toEqual(["clenched"]);
  expect(h[1]!.date).toBe("2026-09-01");
});

describe("beyond the standalone suite", () => {
  test("weights typed in mixed units compare in kg and suggest in the unit last used (Review Focus 4)", () => {
    const consistent: ProgCtx = { ...gym, mode: "consistent" };
    // 11.35 kg and 25 lb are the same weight within 0.05 kg: two clean sessions at the top → up, in kg.
    const kgLast = Prog.suggest(data, g(), [past([{ w: kg(11.35), reps: 8 }], { date: "2026-09-20" }), past([{ w: lb(25), reps: 8 }], { date: "2026-09-18" })], consistent);
    expect(kgLast.action).toBe("up");
    expect(kgLast.w).toEqual(kg(12.5));
    // …and the other way round, in lb.
    const lbLast = Prog.suggest(data, g(), [past([{ w: lb(25), reps: 8 }], { date: "2026-09-20" }), past([{ w: kg(11.35), reps: 8 }], { date: "2026-09-18" })], consistent);
    expect(lbLast.action).toBe("up");
    expect(lbLast.w).toEqual(lb(30));
    // 12 kg is not 25 lb (0.66 kg apart): the top isn't confirmed yet, so hold at the weight last used.
    const notSame = Prog.suggest(data, g(), [past([{ w: kg(12), reps: 8 }], { date: "2026-09-20" }), past([{ w: lb(25), reps: 8 }], { date: "2026-09-18" })], consistent);
    expect(notSame.action).toBe("hold");
    expect(notSame.w).toEqual(kg(12));
    // The heaviest set is found in kg across units within one session.
    expect(Prog.topSet(sets([{ w: lb(25), reps: 8 }, { w: kg(12), reps: 5 }]))).toEqual({ w: kg(12), reps: 5 });
    expect(Prog.improved({ sets: sets([{ w: kg(12), reps: 5 }]) }, { sets: sets([{ w: lb(25), reps: 8 }]) })).toBe(true);
  });

  test("with no profile active, nothing holds or steps down for symptoms, and the notes name no condition", () => {
    const none = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: data.exercises });
    const up = Prog.suggest(none, g(), [past([{ w: lb(25), reps: 8 }], { clenched: true, pre: 1, post: 5 })], withPre(kb, 8));
    expect(up.action).toBe("up");
    expect(up.note).toBe("Hit 8 — go up.");
  });
});
