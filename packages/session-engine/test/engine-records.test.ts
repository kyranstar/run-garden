import { addDays, type Weight } from "@rg/domain";
import { makeEngineData } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Records, type HistorySession } from "../src/index.js";
import { dataWith, ex, lifted, normalise, session, type LegacyEntry, type LegacySession } from "./fixtures.js";

// Ported from the standalone tests/engine-records.test.js.

const data = dataWith([
  lifted("gobletSquat", { name: "Goblet squat", legacyIds: ["kbGoblet"] }),
  lifted("deadlift", { name: "Kettlebell deadlift", patterns: ["hinge"] }),
  lifted("row", { name: "One-arm row", patterns: ["pull-h"] }),
  lifted("floorPress", { name: "Floor press", patterns: ["push-h"] }),
  lifted("suitcaseCarry", { name: "Suitcase carry", patterns: ["carry"], dose: { type: "carry", range: [30, 60], sets: [2, 3], restSec: 60 } }),
  ex("sidePlank", { name: "Side plank from knees", patterns: ["anti-lateral"], roles: ["accessory"], load: "bodyweight", dose: { type: "time", range: [20, 40] } }),
  ex("tempoSquat", { name: "Tempo squat", patterns: ["squat"], roles: ["accessory"], load: "bodyweight", dose: { type: "reps", range: [8, 15] } }),
  ex("wallAngels", { name: "Wall angels" }),
]);

const MON = "2026-08-31";
const lb = (v: number): Weight => ({ v, u: "lb" });
const kg = (v: number): Weight => ({ v, u: "kg" });
const on = (n: number, overrides: LegacySession = {}) => session(addDays(MON, n), overrides);
const lift = (id: string, w: Weight | null, reps: number, extra: LegacyEntry = {}): LegacyEntry => ({ id, clenched: false, sets: [{ w, reps, secs: null }], ...extra });
const hold = (id: string, secs: number, w: Weight | null = null): LegacyEntry => ({ id, clenched: false, sets: [{ w, reps: null, secs }] });
const bell = (id: string, w: Weight) => lift(id, w, 5, { implement: "kettlebell" });

// One session a day; `each(i)` gives the i-th session's overrides.
const daily = (n: number, each: (i: number) => LegacySession = () => ({})) => Array.from({ length: n }, (_, i) => on(i, each(i)));

// counts[w] sessions in week w, Monday onwards.
function weeks(counts: number[]): HistorySession[] {
  const out: HistorySession[] = [];
  counts.forEach((n, w) => { for (let i = 0; i < n; i++) out.push(on(7 * w + i)); });
  return out;
}

const records = (sessions: HistorySession[]) => Records.compute(data, sessions).records;
const kinds = (sessions: HistorySession[], kind: string) => records(sessions).filter(r => r.kind === kind);
const milestones = (sessions: HistorySession[], prefix: string, opts?: { weeklyGoal?: number }) => Records.compute(data, sessions, opts).milestones.filter(m => m.id.startsWith(prefix));
const milestoneIds = (sessions: HistorySession[], prefix: string, opts?: { weeklyGoal?: number }) => milestones(sessions, prefix, opts).map(m => m.id);

test("the first time doing a move is a record; the first weight isn't a weight record", () => {
  const s1 = on(0, { entries: [lift("gobletSquat", lb(25), 8)], done: [{ id: "wallAngels", secs: 60 }] });
  const rs = records([s1]);
  expect(rs.map(r => [r.kind, r.exerciseId])).toEqual([["first", "wallAngels"], ["first", "gobletSquat"]]);
  expect(rs[0]).toEqual({ kind: "first", exerciseId: "wallAngels", sessionId: s1.id, date: s1.date, value: null, previous: null, text: "First time: Wall angels" });
  expect(rs[1]!.text).toBe("First time: Goblet squat");
});

test("a heavier weight, compared in kg, is a weight record", () => {
  const sessions = [
    on(0, { entries: [lift("gobletSquat", lb(25), 8)] }),
    on(1, { entries: [lift("gobletSquat", kg(11.35), 8)] }), // 25.02 lb: the same weight
    on(2, { entries: [lift("gobletSquat", kg(12), 5)] }),
    on(3, { entries: [lift("gobletSquat", lb(20), 10)] }),
    on(4, { entries: [{ id: "gobletSquat", sets: [{ w: lb(30), reps: 6 }, { w: lb(30), reps: 8 }, { w: lb(25), reps: 12 }] }] }),
  ];
  const ws = kinds(sessions, "weight");
  expect(ws.map(r => [r.date, r.value, r.previous])).toEqual([
    [sessions[2]!.date, kg(12), lb(25)],
    [sessions[4]!.date, lb(30), kg(12)],
  ]);
  expect(ws[0]!.text).toBe("New best: Goblet squat 12 kg × 5");
  expect(ws[1]!.text).toBe("New best: Goblet squat 30 lb × 8");
  expect(ws[1]!.sessionId).toBe(sessions[4]!.id);
});

test("more reps at the best weight so far is a reps record", () => {
  const sessions = [
    on(0, { entries: [lift("gobletSquat", lb(25), 8)] }),
    on(1, { entries: [lift("gobletSquat", lb(25), 9)] }),
    on(2, { entries: [lift("gobletSquat", lb(25), 9)] }),
    on(3, { entries: [lift("gobletSquat", lb(20), 12)] }),
    on(4, { entries: [lift("gobletSquat", kg(11.36), 10)] }),
  ];
  const rs = kinds(sessions, "reps");
  expect(rs.map(r => [r.date, r.value, r.previous])).toEqual([[sessions[1]!.date, 9, 8], [sessions[4]!.date, 10, 9]]);
  expect(rs[0]!.text).toBe("New best: Goblet squat 25 lb × 9");
  expect(rs[1]!.text).toBe("New best: Goblet squat 11.36 kg × 10");
  expect(kinds(sessions, "weight")).toEqual([]);
});

test("a weight record resets the bar for reps at the new weight", () => {
  const sessions = [
    on(0, { entries: [lift("gobletSquat", lb(25), 8)] }),
    on(1, { entries: [lift("gobletSquat", lb(30), 5)] }),
    on(2, { entries: [lift("gobletSquat", lb(25), 10)] }),
    on(3, { entries: [lift("gobletSquat", lb(30), 6)] }),
  ];
  expect(records(sessions).filter(r => r.kind !== "first").map(r => [r.kind, r.date, r.value, r.previous])).toEqual([
    ["weight", sessions[1]!.date, lb(30), lb(25)],
    ["reps", sessions[3]!.date, 6, 5],
  ]);
});

test("bodyweight reps records count reps without a weight", () => {
  const sessions = [
    on(0, { entries: [lift("tempoSquat", null, 10)] }),
    on(1, { entries: [lift("tempoSquat", null, 12)] }),
    on(2, { entries: [lift("tempoSquat", null, 11)] }),
  ];
  expect(kinds(sessions, "reps").map(r => [r.value, r.previous, r.text])).toEqual([[12, 10, "New best: Tempo squat 12 reps"]]);
});

test("the longest hold or carry is a hold record; timed rep sets aren't holds", () => {
  const timedSet = (secs: number): LegacyEntry => ({ id: "gobletSquat", sets: [{ w: lb(25), reps: 8, secs }] });
  const sessions = [
    on(0, { entries: [hold("sidePlank", 30), hold("suitcaseCarry", 45, lb(25)), timedSet(40)] }),
    on(1, { entries: [hold("sidePlank", 40), hold("suitcaseCarry", 60, lb(25)), timedSet(90)] }),
    on(2, { entries: [hold("sidePlank", 35), hold("suitcaseCarry", 60, lb(25))] }),
  ];
  const hs = kinds(sessions, "hold");
  expect(hs.map(r => [r.exerciseId, r.value, r.previous, r.text])).toEqual([
    ["sidePlank", 40, 30, "Longest hold: Side plank from knees 40 s"],
    ["suitcaseCarry", 60, 45, "Longest carry: Suitcase carry 60 s"],
  ]);
  expect(hs.every(r => r.date === sessions[1]!.date)).toBe(true);
});

test("ladder and circuit entries don't count for weight, reps, or holds", () => {
  const sessions = [
    on(0, { entries: [lift("gobletSquat", lb(25), 8), hold("sidePlank", 30)] }),
    on(1, { entries: [lift("gobletSquat", lb(35), 8, { format: "ladder" }), { ...hold("sidePlank", 60), format: "circuit" }, lift("tempoSquat", null, 4, { format: "ladder" })] }),
    on(2, { entries: [lift("gobletSquat", lb(25), 9, { format: "circuit" })] }),
    on(3, { entries: [lift("gobletSquat", lb(30), 5), lift("tempoSquat", null, 10)] }),
  ];
  const rs = records(sessions);
  expect(rs.filter(r => r.kind !== "first").map(r => [r.kind, r.date, r.previous])).toEqual([["weight", sessions[3]!.date, lb(25)]]);
  expect(rs.filter(r => r.kind === "first").map(r => r.exerciseId)).toEqual(["gobletSquat", "sidePlank", "tempoSquat"]);
});

test("renamed ids resolve to one exercise", () => {
  const sessions = [
    on(0, { entries: [lift("kbGoblet", lb(25), 8)] }),
    on(1, { entries: [lift("gobletSquat", lb(30), 8)] }),
    on(2, { entries: [lift("kbGoblet", lb(30), 9)] }),
  ];
  expect(records(sessions).map(r => [r.kind, r.exerciseId])).toEqual([["first", "gobletSquat"], ["weight", "gobletSquat"], ["reps", "gobletSquat"]]);
});

test("records come out in chronological order whatever the input order", () => {
  const a = on(0, { entries: [lift("gobletSquat", lb(25), 8)] });
  const b = on(1, { entries: [lift("gobletSquat", lb(30), 8)] });
  expect(records([b, a]).map(r => [r.kind, r.date])).toEqual([["first", a.date], ["weight", b.date]]);
});

test("session count milestones at 10, 25, 50, and 100", () => {
  expect(milestoneIds(daily(9), "sessions-")).toEqual([]);
  const ten = daily(10);
  expect(milestones(ten, "sessions-")).toEqual([{ id: "sessions-10", sessionId: ten[9]!.id, date: ten[9]!.date, text: "10 sessions" }]);
  expect(milestoneIds(daily(24), "sessions-")).toEqual(["sessions-10"]);
  expect(milestoneIds(daily(99), "sessions-")).toEqual(["sessions-10", "sessions-25", "sessions-50"]);
  const hundred = daily(100);
  expect(milestoneIds(hundred, "sessions-")).toEqual(["sessions-10", "sessions-25", "sessions-50", "sessions-100"]);
  expect(milestones(hundred, "sessions-100")[0]!.sessionId).toBe(hundred[99]!.id);
});

test("weeks-at-goal streaks count consecutive Monday weeks, awarded in the session that meets the goal", () => {
  const two = weeks([4, 5]);
  expect(milestones(two, "goal-")).toEqual([{ id: "goal-weeks-2", sessionId: two[7]!.id, date: two[7]!.date, text: "2 weeks in a row at your goal" }]);
  expect(two[7]!.date).toBe("2026-09-10"); // Thursday of week 2
  expect(milestoneIds(weeks([4, 3]), "goal-")).toEqual([]);
  expect(milestoneIds(weeks([4, 3, 4]), "goal-")).toEqual([]);
  expect(milestoneIds(weeks([4, 0, 4]), "goal-")).toEqual([]);
  expect(milestoneIds(weeks([4, 3, 4, 4]), "goal-")).toEqual(["goal-weeks-2"]);
  expect(milestoneIds(weeks([4, 4, 4]), "goal-")).toEqual(["goal-weeks-2"]);
  expect(milestoneIds(weeks([4, 4, 4, 4]), "goal-")).toEqual(["goal-weeks-2", "goal-weeks-4"]);
  // A Sunday session belongs to the week that started the Monday before.
  const sunday = [on(0), on(1), on(2), on(6), on(7), on(8), on(9), on(10)];
  expect(milestoneIds(sunday, "goal-")).toEqual(["goal-weeks-2"]);
});

test("weeks-at-goal uses the weekly goal option, up to 52 weeks", () => {
  expect(milestoneIds(weeks([2, 2]), "goal-", { weeklyGoal: 2 })).toEqual(["goal-weeks-2"]);
  expect(milestoneIds(weeks([2, 2]), "goal-")).toEqual([]);
  const ones = (n: number) => weeks(Array(n).fill(1));
  expect(milestoneIds(ones(51), "goal-", { weeklyGoal: 1 })).toEqual(["goal-weeks-2", "goal-weeks-4", "goal-weeks-8", "goal-weeks-12", "goal-weeks-26"]);
  expect(milestoneIds(ones(52), "goal-", { weeklyGoal: 1 }).slice(-1)).toEqual(["goal-weeks-52"]);
});

test("calm-jaw streaks: consecutive sessions with post ≤ pre", () => {
  const calm = { pre: 3, post: 2 };
  expect(milestoneIds(daily(4, () => calm), "calm-")).toEqual([]);
  const five = daily(5, (i) => (i === 4 ? { pre: 2, post: 2 } : calm));
  expect(milestones(five, "calm-")).toEqual([{ id: "calm-5", sessionId: five[4]!.id, date: five[4]!.date, text: "5 calm-jaw sessions in a row" }]);
  expect(milestoneIds(daily(6, (i) => (i === 2 ? { pre: 1, post: 2 } : calm)), "calm-")).toEqual([]);
  expect(milestoneIds(daily(6, (i) => (i === 2 ? { pre: 1, post: null } : calm)), "calm-")).toEqual([]);
  expect(milestoneIds(daily(6, (i) => (i === 2 ? { pre: undefined, post: 1 } : calm)), "calm-")).toEqual([]);
  expect(milestoneIds(daily(19, () => calm), "calm-")).toEqual(["calm-5", "calm-10"]);
  expect(milestoneIds(daily(50, () => calm), "calm-")).toEqual(["calm-5", "calm-10", "calm-20", "calm-50"]);
});

test("block completed: the first session of a higher block", () => {
  const sessions = [on(0), on(1, { blockNumber: 1 }), on(2, { blockNumber: 1 }), on(3, { blockNumber: 2 }), on(4, { blockNumber: 2 }), on(5, { blockNumber: 1 }), on(6, { blockNumber: 3 })];
  expect(milestones(sessions, "block-")).toEqual([
    { id: "block-1", sessionId: sessions[3]!.id, date: sessions[3]!.date, text: "Block 1 complete" },
    { id: "block-2", sessionId: sessions[6]!.id, date: sessions[6]!.date, text: "Block 2 complete" },
  ]);
  expect(milestoneIds([on(0), on(1, { blockNumber: 2 })], "block-")).toEqual([]);
});

test("new heaviest bell: beats every earlier kettlebell weight in any exercise", () => {
  const sessions = [
    on(0, { entries: [bell("gobletSquat", lb(25))] }),
    on(1, { entries: [bell("deadlift", lb(20))] }),
    on(2, { entries: [bell("deadlift", lb(30)), bell("gobletSquat", lb(25))] }),
    on(3, { entries: [lift("deadlift", lb(50), 5, { implement: "dumbbells" })] }),
    on(4, { entries: [bell("row", kg(13.6))] }),
    on(5, { entries: [bell("row", kg(16))] }),
  ];
  expect(milestones(sessions, "bell-")).toEqual([
    { id: "bell-14", sessionId: sessions[2]!.id, date: sessions[2]!.date, text: "New heaviest bell: 30 lb" },
    { id: "bell-16", sessionId: sessions[5]!.id, date: sessions[5]!.date, text: "New heaviest bell: 16 kg" },
  ]);
  expect(milestoneIds([on(0, { entries: [bell("gobletSquat", lb(35))] })], "bell-")).toEqual([]);
  // Pass-1 sessions wrote the implement capitalised.
  const pass1 = [on(0, { entries: [lift("gobletSquat", lb(25), 8, { implement: "Kettlebell" })] }), on(1, { entries: [lift("gobletSquat", lb(35), 8, { implement: "Kettlebell" })] })];
  expect(milestoneIds(pass1, "bell-")).toEqual(["bell-16"]);
});

test("every core family trained in one week, once per week", () => {
  const four = ["gobletSquat", "deadlift", "row", "floorPress"].map(id => lift(id, lb(25), 8));
  const sessions = [
    on(0, { entries: four.slice(0, 2) }),
    on(1, { entries: four.slice(2) }),
    on(2, { done: [{ id: "suitcaseCarry", secs: 60 }] }),
    on(3, { entries: [...four, hold("suitcaseCarry", 60, lb(25))] }),
    on(7, { entries: [lift("kbGoblet", lb(25), 8), ...four.slice(1)] }),
    on(8, { entries: [hold("suitcaseCarry", 60, lb(25))] }),
  ];
  expect(milestones(sessions, "all-core-")).toEqual([
    { id: "all-core-2026-08-31", sessionId: sessions[2]!.id, date: sessions[2]!.date, text: "Every core lift trained in one week" },
    { id: "all-core-2026-09-07", sessionId: sessions[5]!.id, date: sessions[5]!.date, text: "Every core lift trained in one week" },
  ]);
  // Split across two weeks, or trained only through non-core moves, doesn't count.
  expect(milestoneIds([on(5, { entries: four }), on(7, { entries: [hold("suitcaseCarry", 60, lb(25))] })], "all-core-")).toEqual([]);
  expect(milestoneIds([on(0, { entries: [lift("tempoSquat", null, 10), ...four.slice(1), hold("suitcaseCarry", 60, lb(25))] })], "all-core-")).toEqual([]);
});

test("each milestone is awarded at most once", () => {
  const calm = daily(11, (i) => (i === 5 ? { pre: 1, post: 3 } : {}));
  expect(milestoneIds(calm, "calm-")).toEqual(["calm-5"]);
  expect(milestoneIds(weeks([4, 4, 0, 4, 4]), "goal-")).toEqual(["goal-weeks-2"]);
  expect(milestoneIds([on(0, { blockNumber: 1 }), on(1, { blockNumber: 2 }), on(2, { blockNumber: 1 }), on(3, { blockNumber: 2 })], "block-")).toEqual(["block-1"]);
  expect(milestoneIds([on(0, { entries: [bell("row", lb(30))] }), on(1, { entries: [bell("row", lb(35))] }), on(2, { entries: [bell("row", kg(16))] })], "bell-")).toEqual(["bell-16"]);
});

test("forSession returns only what that session achieved", () => {
  const sessions = daily(10, (i) => ({ entries: [lift("gobletSquat", lb(20 + 5 * Math.min(i, 3)), 8)], pre: 3, post: 5 }));
  const last = Records.forSession(data, sessions, sessions[9]!.id);
  expect(last).toEqual({ records: [], milestones: [{ id: "sessions-10", sessionId: sessions[9]!.id, date: sessions[9]!.date, text: "10 sessions" }] });
  const second = Records.forSession(data, sessions, sessions[1]!.id);
  expect(second.records.map(r => [r.kind, r.text])).toEqual([["weight", "New best: Goblet squat 25 lb × 8"]]);
  expect(second.milestones).toEqual([]);
  expect(Records.forSession(data, sessions, "nope")).toEqual({ records: [], milestones: [] });
  const goal = weeks([2, 2]);
  expect(Records.forSession(data, goal, goal[3]!.id, { weeklyGoal: 2 }).milestones.map(m => m.id)).toEqual(["goal-weeks-2"]);
});

test("damaged history doesn't throw", () => {
  const sessions = [
    null as unknown as HistorySession,
    normalise({ id: "old", date: "2026-08-31", entries: [null, { id: "gobletSquat", sets: null }, { id: "gobletSquat", sets: [null, { w: lb(25), reps: 8 }] }] }),
    normalise({ id: "bare", date: "2026-09-01" }),
    normalise({ id: "gone", date: "2026-09-02", done: [null, { secs: 30 }, { id: "retiredMove", secs: 30 }], entries: [{ sets: [{ w: lb(99), reps: 1 }] }, { id: "retiredLift", sets: [{ w: lb(10), reps: 5 }] }] }),
    normalise({ id: "odd", date: "2026-09-03", startedAt: null, pre: null, entries: [{ id: "gobletSquat", implement: "kettlebell", sets: [{ w: { v: null, u: "lb" }, reps: 8 }, { w: lb(30), reps: null }, {}] }] }),
    normalise({ id: "nodate", entries: [{ id: "gobletSquat", sets: [{ w: lb(99), reps: 1 }] }] }),
    normalise({ id: "retiredAgain", date: "2026-09-04", entries: [{ id: "retiredLift", sets: [{ w: lb(15), reps: 5 }] }] }),
  ];
  const out = Records.compute(data, sessions);
  expect(out.records.map(r => [r.kind, r.exerciseId, r.sessionId])).toEqual([
    ["first", "gobletSquat", "old"],
    ["first", "retiredMove", "gone"],
    ["first", "retiredLift", "gone"],
    ["weight", "gobletSquat", "odd"],
    ["weight", "retiredLift", "retiredAgain"],
  ]);
  expect(out.records[1]!.text).toBe("First time: retiredMove");
  expect(out.records[3]!.text).toBe("New best: Goblet squat 30 lb");
  expect(out.records[4]!.text).toBe("New best: retiredLift 15 lb × 5");
  expect(Records.compute(data, undefined)).toEqual({ records: [], milestones: [] });
  expect(Records.forSession(data, null, "x")).toEqual({ records: [], milestones: [] });
});

describe("beyond the standalone suite", () => {
  test("calm streaks come from each profile's own check and label; none without a profile", () => {
    const calm = daily(5, () => ({ pre: 3, post: 2 }));
    expect(milestoneIds(calm, "calm-")).toEqual(["calm-5"]);
    const none = makeEngineData({ activeProfiles: [], careProfiles: [], exercises: data.exercises });
    expect(Records.compute(none, calm).milestones.filter(m => m.id.startsWith("calm-"))).toEqual([]);
  });
});
