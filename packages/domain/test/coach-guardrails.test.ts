/**
 * Guardrail validator (Plan A Task A3, spec §4): hard rules reject, soft
 * rules flag — and the validator injects soft flags the model forgot, so the
 * UI's "breaks your rule" chip is guaranteed truthful.
 */
import { describe, expect, it } from "vitest";
import { validateOps, type GuardrailCtx } from "../src/coach-guardrails.js";
import type { CoachOp } from "../src/coach.js";

const easy = (title = "Easy 40") => ({
  category: "easy" as const,
  title,
  durationMinutes: 40,
  run: { blocks: [{ kind: "duration" as const, value: 40, intensity: "easy" as const }] },
});
const quality = () => ({
  category: "quality" as const,
  title: "Tempo 3×10",
  durationMinutes: 50,
  run: { blocks: [{ kind: "duration" as const, value: 50, intensity: "threshold" as const }] },
});

function ctx(overrides: Partial<GuardrailCtx> = {}): GuardrailCtx {
  return {
    today: "2026-08-05",
    workouts: [
      { id: "w-past", date: "2026-08-04", category: "quality", completionState: "completed", durationMinutes: 50, discipline: "run" },
      { id: "w-thu", date: "2026-08-06", category: "quality", completionState: "scheduled", durationMinutes: 50, discipline: "run" },
      { id: "w-fri", date: "2026-08-07", category: "strength", completionState: "scheduled", durationMinutes: 45, discipline: "strength" },
      { id: "w-sat", date: "2026-08-08", category: "long", completionState: "scheduled", durationMinutes: 90, discipline: "run" },
      { id: "w-race", date: "2026-08-16", category: "race", completionState: "scheduled", durationMinutes: 100, discipline: "run" },
    ],
    weeklyMinutesByDiscipline: { run: [180, 190, 200, 190], strength: [90, 90, 90, 90] },
    raceDates: ["2026-08-16"],
    firmHorizonEnd: "2026-08-23",
    rules: [
      { id: "r-sat-long", kind: "anchor_day", category: "long", weekday: 6 },
      { id: "r-tue-quality", kind: "fixed_slot", category: "quality", weekday: 2 },
    ],
    coachPlanIds: ["cp1"],
  };
}

describe("hard rules", () => {
  it("H1: ramp beyond 10% of trailing average is rejected", () => {
    // Trailing avg 190min; adding 3×80min easy runs to next week blows past 209.
    const ops: CoachOp[] = [
      { kind: "add", date: "2026-08-10", session: { ...easy(), durationMinutes: 80 } },
      { kind: "add", date: "2026-08-11", session: { ...easy(), durationMinutes: 80 } },
      { kind: "add", date: "2026-08-12", session: { ...easy(), durationMinutes: 80 } },
    ];
    const out = validateOps(ops, ctx());
    expect(out.hard.some((v) => v.rule === "ramp")).toBe(true);
  });

  it("H2: hard sessions on consecutive days are rejected", () => {
    // Adding quality on Friday puts quality(Fri) next to long(Sat).
    const out = validateOps([{ kind: "add", date: "2026-08-07", session: quality() }], ctx());
    expect(out.hard.some((v) => v.rule === "hard_adjacency")).toBe(true);
  });

  it("H3: touching a completed or past workout is rejected", () => {
    const out = validateOps([{ kind: "move", workoutId: "w-past", toDate: "2026-08-09" }], ctx());
    expect(out.hard.some((v) => v.rule === "touch_resolved")).toBe(true);
  });

  it("resolveRaceConflict edits no training day and passes clean", () => {
    const out = validateOps([{ kind: "resolveRaceConflict", keep: "settings" }], ctx());
    expect(out.hard).toEqual([]);
  });

  it("H4: edits beyond the firm horizon are rejected (except firmUp/extend/reshape)", () => {
    const out = validateOps([{ kind: "add", date: "2026-09-01", session: easy() }], ctx());
    expect(out.hard.some((v) => v.rule === "beyond_horizon")).toBe(true);
    const ok = validateOps(
      [
        {
          kind: "firmUp",
          planId: "cp1",
          weekStart: "2026-08-31",
          sessions: [{ date: "2026-09-01", session: easy() }],
        },
      ],
      ctx(),
    );
    expect(ok.hard.filter((v) => v.rule === "beyond_horizon")).toHaveLength(0);
  });

  it("H5: new intensity inside race week is rejected", () => {
    const out = validateOps([{ kind: "add", date: "2026-08-12", session: quality() }], ctx());
    expect(out.hard.some((v) => v.rule === "race_week_intensity")).toBe(true);
  });

  it("H6: skipping a race is rejected", () => {
    const out = validateOps([{ kind: "skip", workoutId: "w-race", reason: "tired" }], ctx());
    expect(out.hard.some((v) => v.rule === "never_skip_race")).toBe(true);
  });

  it("a clean easing passes with no hard violations", () => {
    const out = validateOps(
      [{ kind: "ease", workoutId: "w-thu", session: easy("Steady 40 Z2") }],
      ctx(),
    );
    expect(out.hard).toHaveLength(0);
  });

  it("H7: structural ops on a plan the coach did not author are rejected", () => {
    const out = validateOps([{ kind: "retirePlan", planId: "coros-import-4738" }], ctx());
    expect(out.hard.some((v) => v.rule === "imported_plan_structure")).toBe(true);
    const reshape = validateOps(
      [
        {
          kind: "reshapeWeek",
          planId: "coros-import-4738",
          weekStart: "2026-08-10",
          sessions: [{ date: "2026-08-11", session: easy() }],
        },
      ],
      ctx(),
    );
    expect(reshape.hard.some((v) => v.rule === "imported_plan_structure")).toBe(true);
  });

  it("H7: skipping or moving an imported session stays allowed", () => {
    // w-sat belongs to no coached plan (workout-level ops carry no planId) —
    // session-level ops must never trip the structural rule.
    const out = validateOps([{ kind: "skip", workoutId: "w-thu", reason: "backpacking weekend" }], ctx());
    expect(out.hard.filter((v) => v.rule === "imported_plan_structure")).toHaveLength(0);
  });

  it("H7: structural ops on a coach-authored plan pass", () => {
    const out = validateOps([{ kind: "retirePlan", planId: "cp1" }], ctx());
    expect(out.hard.filter((v) => v.rule === "imported_plan_structure")).toHaveLength(0);
  });
});

describe("soft rules", () => {
  it("moving the long run off Saturday flags the anchor rule", () => {
    const out = validateOps([{ kind: "move", workoutId: "w-sat", toDate: "2026-08-09" }], ctx());
    expect(out.hard).toHaveLength(0);
    expect(out.soft.some((v) => v.rule === "r-sat-long")).toBe(true);
  });

  it("keeping the long run on a Saturday stays unflagged", () => {
    const out = validateOps([{ kind: "move", workoutId: "w-sat", toDate: "2026-08-15" }], ctx());
    expect(out.soft.filter((v) => v.rule === "r-sat-long")).toHaveLength(0);
  });
});
