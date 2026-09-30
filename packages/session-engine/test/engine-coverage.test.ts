import { describe, expect, test } from "vitest";
import { Coverage, Hist, Rng } from "../src/index.js";
import { dataWith, ex, lifted, normalise, session } from "./fixtures.js";

// Ported from the standalone tests/engine-coverage.test.js.

const data = dataWith([
  lifted("gobletSquat", { regions: ["quads", "glutes"], legacyIds: ["oldGoblet"] }),
  ex("catCow", { regions: ["thoracic"] }),
  ex("chinTuck", { regions: ["neck"], roles: ["jaw-care"] }),
  lifted("deadlift", { patterns: ["hinge"], regions: ["hamstrings"] }),
]);
const close = (a: number | undefined, b: number) => expect(Math.abs((a ?? NaN) - b), `${a} ≠ ${b}`).toBeLessThan(1e-9);

test("Rng is deterministic per seed and in [0, 1)", () => {
  const a = Rng.create("2026-09-29|build"), b = Rng.create("2026-09-29|build"), c = Rng.create("2026-09-30|build");
  const xs = [a(), a(), a()], ys = [b(), b(), b()], zs = [c(), c(), c()];
  expect(xs).toEqual(ys);
  expect(xs).not.toEqual(zs);
  for (const v of xs) expect(v >= 0 && v < 1).toBe(true);
});

test("Hist.daysBetween counts calendar days, including across DST", () => {
  expect(Hist.daysBetween("2026-09-25", "2026-09-29")).toBe(4);
  expect(Hist.daysBetween("2026-10-31", "2026-11-02")).toBe(2);
  expect(Hist.daysBetween("2026-09-29", "2026-09-29")).toBe(0);
});

test("Hist.idsIn merges done steps and logged entries without duplicates", () => {
  const s = session("2026-09-29", { done: [{ id: "catCow", secs: 60 }, { id: "gobletSquat", secs: 90 }], entries: [{ id: "gobletSquat", sets: [] }, { id: "deadlift", sets: [] }] });
  expect(Hist.idsIn(s).sort()).toEqual(["catCow", "deadlift", "gobletSquat"]);
  expect(Hist.idsIn(normalise({ date: "2026-09-29" }))).toEqual([]);
});

test("firstDone and newMoveThisWeek resolve legacy ids", () => {
  const sessions = [
    session("2026-09-10", { done: [{ id: "oldGoblet" }] }),
    session("2026-09-29", { done: [{ id: "gobletSquat" }, { id: "catCow" }] }),
  ];
  const first = Hist.firstDone(data, sessions);
  expect(first.get("gobletSquat")).toBe("2026-09-10");
  expect(first.get("catCow")).toBe("2026-09-29");
  expect(Hist.newMoveThisWeek(data, sessions, "2026-09-29")).toBe(true);   // catCow is new this week (Mon 28th)
  expect(Hist.newMoveThisWeek(data, sessions.slice(0, 1), "2026-09-29")).toBe(false);
});

test("lastFamilyDate finds the latest session with a core lift of that family", () => {
  const sessions = [session("2026-09-20", { entries: [{ id: "gobletSquat", sets: [] }] }), session("2026-09-25", { done: [{ id: "catCow" }] })];
  expect(Hist.lastFamilyDate(data, sessions, "squat", "2026-09-29")).toBe("2026-09-20");
  expect(Hist.lastFamilyDate(data, sessions, "hinge", "2026-09-29")).toBe(null);
});

test("exposures count each exercise once per session in the window and skip unknown ids", () => {
  const sessions = [
    session("2026-09-25", { done: [{ id: "oldGoblet" }, { id: "gone" }, { id: "catCow" }], entries: [{ id: "oldGoblet", sets: [] }] }),
    session("2026-09-10", { done: [{ id: "chinTuck" }] }),
  ];
  const { counts, last } = Coverage.exposures(data, sessions, "2026-09-29");
  expect(counts.patterns.squat).toBe(1);
  expect(counts.patterns.mobility).toBe(1);
  expect(counts.regions.neck).toBeUndefined();          // outside the 7-day window
  expect(last.regions.neck).toBe("2026-09-10");         // but still remembered as last trained
});

test("debt = missing exposures scaled by days since last trained", () => {
  const d = { ...data, targets: { patterns: { squat: 2, mobility: 1 }, regions: { neck: 1, glutes: 1 } } };
  const sessions = [session("2026-09-25", { done: [{ id: "gobletSquat" }] })];
  const debt = Coverage.debt(d, sessions, "2026-09-29");
  close(debt.patterns.squat, 1 * (1 + 4 / 7));
  close(debt.patterns.mobility, 1 * (1 + 14 / 7));   // never trained counts as 14 days
  close(debt.regions.neck, 3);
  expect(debt.regions.glutes).toBeUndefined();        // target met
});

test("pass-1 shaped sessions do not throw", () => {
  const legacy = [normalise({ id: "a", date: "2026-09-20", startedAt: "2026-09-20T10:00:00Z", plan: { phase: "flare" }, pre: null, post: null, entries: [{ id: "gobletSquat", sets: [{ w: { v: 25, u: "lb" }, reps: 8 }] }] })];
  expect(() => Coverage.debt(data, legacy, "2026-09-29")).not.toThrow();
});

describe("renamed and removed ids in history (Review Focus 3)", () => {
  test("a legacy id resolves to today's record everywhere; an unknown id is kept as-is or ignored, never thrown on", () => {
    expect(Hist.canonical(data, "oldGoblet")).toBe("gobletSquat");
    expect(Hist.canonical(data, "retiredMove")).toBe("retiredMove");
    const sessions = [
      session("2026-09-24", { done: [{ id: "retiredMove" }], entries: [{ id: "retiredLift", sets: [{ w: { v: 20, u: "lb" }, reps: 5 }] }] }),
      session("2026-09-25", { entries: [{ id: "oldGoblet", sets: [] }] }),
    ];
    expect(Hist.firstDone(data, sessions).get("retiredMove")).toBe("2026-09-24");
    expect(Hist.lastFamilyDate(data, sessions, "squat", "2026-09-29")).toBe("2026-09-25");
    const { counts } = Coverage.exposures(data, sessions, "2026-09-29");
    expect(counts.patterns.squat).toBe(1);
    expect(() => Coverage.debt(data, sessions, "2026-09-29")).not.toThrow();
  });
});
