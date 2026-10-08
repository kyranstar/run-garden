/**
 * Weekly strength volume and a lift's top sets (Phase 2d Task 3; spec §2d "Progress"; one-workout-system spec
 * §12.2): weight × reps, both sides of a one-sided move; a lift's line in kilograms whatever it was typed in,
 * labelled in the unit last used (Review Focus 5). Every result is a MetricResult that says honestly when there
 * is too little to draw.
 */
import { describe, expect, it } from "vitest";
import { liftTopSets, weeklyStrengthVolume, type LoggedLoadSet, type StrengthSession } from "../src/strength.js";

const LB = 0.45359237;
/** A Wednesday: this week starts Monday 2026-10-12; eight weeks back is Monday 2026-08-24. */
const TODAY = "2026-10-14";

const set = (exerciseId: string, v: number, u: "lb" | "kg", reps: number | null, extra: Partial<LoggedLoadSet> = {}): LoggedLoadSet => ({
  exerciseId,
  reps,
  load: { v, u },
  kg: u === "kg" ? v : v * LB,
  perSide: false,
  side: null,
  ...extra,
});
const session = (date: string, sets: LoggedLoadSet[], startedAt: string | null = null): StrengthSession => ({ date, startedAt, sets });

describe("weeklyStrengthVolume", () => {
  it("is weight × reps per week, in kilograms, eight weeks oldest first ending this week", () => {
    const r = weeklyStrengthVolume(
      [
        session("2026-10-12", [set("gobletSquat", 20, "kg", 8), set("gobletSquat", 20, "kg", 8)]),
        session("2026-10-05", [set("deadlift", 100, "lb", 5)]),
        session("2026-08-24", [set("deadlift", 10, "kg", 10)]),
      ],
      TODAY,
    );
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.weeks.map((w) => w.weekStart)).toEqual([
      "2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12",
    ]);
    expect(r.value.weeks.map((w) => w.kg)).toEqual([100, 0, 0, 0, 0, 0, 226.8, 320]);
    expect(r.value.weeks.map((w) => w.sessions)).toEqual([1, 0, 0, 0, 0, 0, 1, 1]);
    expect(r.value.thisWeekKg).toBe(320);
    expect(r.sampleSize).toBe(3);
  });

  it("counts both sides of a one-sided move: twice for a set that covered both, once for each side logged apart", () => {
    const both = weeklyStrengthVolume([session("2026-10-13", [set("supportedRow", 10, "kg", 10, { perSide: true })])], TODAY);
    const apart = weeklyStrengthVolume(
      [
        session("2026-10-13", [
          set("supportedRow", 10, "kg", 10, { perSide: true, side: "left" }),
          set("supportedRow", 10, "kg", 10, { perSide: true, side: "right" }),
        ]),
      ],
      TODAY,
    );
    expect(both.status === "ok" && both.value.thisWeekKg).toBe(200);
    expect(apart.status === "ok" && apart.value.thisWeekKg).toBe(200);
  });

  it("leaves out sets with no reps, sessions before the window and after today", () => {
    const r = weeklyStrengthVolume(
      [
        session("2026-10-13", [set("carry", 20, "kg", null), set("gobletSquat", 10, "kg", 5)]),
        session("2026-08-23", [set("gobletSquat", 50, "kg", 5)]),
        session("2026-10-15", [set("gobletSquat", 50, "kg", 5)]),
      ],
      TODAY,
    );
    expect(r.status === "ok" && r.value.weeks.reduce((n, w) => n + w.kg, 0)).toBe(50);
  });

  it("is insufficient_data with nothing weighted in the eight weeks — never a row of zeros", () => {
    const r = weeklyStrengthVolume([session("2026-10-13", [set("carry", 20, "kg", null)]), session("2026-08-01", [set("x", 5, "kg", 5)])], TODAY);
    expect(r).toMatchObject({ status: "insufficient_data", needed: 1, have: 0 });
    expect(weeklyStrengthVolume([], TODAY)).toMatchObject({ status: "insufficient_data", needed: 1, have: 0 });
  });
});

describe("liftTopSets (Review Focus 5: mixed units)", () => {
  const mixed = [
    session("2026-09-01", [set("gobletSquat", 20, "lb", 8), set("gobletSquat", 25, "lb", 6)]),
    session("2026-09-15", [set("gobletSquat", 12, "kg", 8)]),
    session("2026-10-13", [set("gobletSquat", 30, "lb", 6), set("deadlift", 40, "kg", 5)]),
  ];

  it("draws each week's heaviest set in kilograms, labels in the unit last used, and keeps the best as typed", () => {
    const r = liftTopSets(mixed, "gobletSquat", TODAY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.value.series.map((p) => [p.weekStart, Number(p.kg.toFixed(3))])).toEqual([
      ["2026-08-31", Number((25 * LB).toFixed(3))],
      ["2026-09-14", 12],
      ["2026-10-12", Number((30 * LB).toFixed(3))],
    ]);
    expect(r.value.unit).toBe("lb");
    expect(r.value.best).toEqual({ w: { v: 30, u: "lb" }, reps: 6, date: "2026-10-13" });
    expect(r.sampleSize).toBe(3);
  });

  it("labels in kilograms when kilograms were used last, however the earlier sets were typed", () => {
    const r = liftTopSets([...mixed, session("2026-10-14", [set("gobletSquat", 10, "kg", 10)], "2026-10-14T18:00:00Z")], "gobletSquat", TODAY);
    expect(r.status === "ok" && r.value.unit).toBe("kg");
    // The lighter last set does not change the week's top, or the best.
    expect(r.status === "ok" && r.value.best.w).toEqual({ v: 30, u: "lb" });
  });

  it("the later of two sessions on one day is the one used last", () => {
    const day = [
      session("2026-10-13", [set("gobletSquat", 14, "kg", 8)], "2026-10-13T19:00:00Z"),
      session("2026-10-13", [set("gobletSquat", 30, "lb", 8)], "2026-10-13T07:00:00Z"),
    ];
    const r = liftTopSets([mixed[0]!, ...day], "gobletSquat", TODAY);
    expect(r.status === "ok" && r.value.unit).toBe("kg");
  });

  it("a tie on weight goes to the set with more reps", () => {
    const r = liftTopSets(
      [session("2026-10-05", [set("deadlift", 40, "kg", 8)]), session("2026-10-13", [set("deadlift", 40, "kg", 5)])],
      "deadlift",
      TODAY,
    );
    expect(r.status === "ok" && r.value.best).toEqual({ w: { v: 40, u: "kg" }, reps: 8, date: "2026-10-05" });
  });

  it("is insufficient_data below two weeks with a top set — one point is not a line", () => {
    expect(liftTopSets(mixed, "deadlift", TODAY)).toMatchObject({ status: "insufficient_data", needed: 2, have: 1 });
    expect(liftTopSets(mixed, "floorPress", TODAY)).toMatchObject({ status: "insufficient_data", needed: 2, have: 0 });
    // Two sessions in one week are still one week.
    const oneWeek = [session("2026-10-12", [set("x", 10, "kg", 5)]), session("2026-10-14", [set("x", 12, "kg", 5)])];
    expect(liftTopSets(oneWeek, "x", TODAY)).toMatchObject({ status: "insufficient_data", needed: 2, have: 1 });
  });
});
