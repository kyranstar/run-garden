/**
 * THE WEEK'S LINE WITH MORE THAN ONE PLAN (§8 §5, stream W; review-3 and its re-check). The line names the week's MAIN
 * plan — a running plan with a race first, else the one holding the most of the week's sessions, a tie to the earlier
 * start — with its own week count when the app knows it, and "+N" for the other plans holding the week. Never one plan's
 * name beside another plan's count: a coach block's count is its own (its dates, counted as the server counts a block's
 * weeks); a watch plan's week isn't one the plan's week read gives, so it goes without one. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import type { CoachPlanDto, PlanWeekResponse, WorkoutDto } from "@rg/api-client";
import { weekLine, weekPlan, weekPlanName } from "../src/screens/week-view.js";

const plan = (id: string, name: string, startDate: string, endDate: string, o: Partial<CoachPlanDto> = {}): CoachPlanDto => ({
  id, discipline: "run", name, status: "active", startDate, endDate, raceDate: null, source: "coach", ...o,
});
/** The week of Mon 12 Oct, its sessions by plan id (one a day from Monday, a rest day not counted). */
const week = (planIds: string[], over: Partial<PlanWeekResponse> = {}): PlanWeekResponse =>
  ({
    weekStart: "2026-10-12",
    days: Array.from({ length: 7 }, (_, i) => ({
      date: `2026-10-${12 + i}`,
      workouts: planIds[i] ? [{ id: `w${i}`, planId: planIds[i], category: i === 6 ? "rest" : "easy" } as unknown as WorkoutDto] : [],
    })),
    plannedSeconds: 0,
    doneCount: 0,
    sessionCount: 6,
    weekIndex: 7,
    weekTotal: 9,
    ...over,
  }) as unknown as PlanWeekResponse;

const line = (blocks: CoachPlanDto[], w: PlanWeekResponse) => weekLine({ week: w, ...weekPlan(blocks, w.weekStart, w), race: null });

const half = plan("tp-half", "Fall Half Marathon Build", "2026-08-03", "2026-11-22", { source: "coros", raceDate: "2026-11-22" });
const lift = plan("cp-lift", "Strength block", "2026-09-28", "2026-11-01", { discipline: "lift" });
const tenK = plan("cp-10k", "10K build", "2026-10-12", "2026-11-08");
const base = plan("cp-base", "Spring base", "2026-09-07", "2026-11-29");

describe("the week's main plan, its own count, and how many others", () => {
  it("one plan: its name with its own week count", () => {
    expect(line([tenK], week(["cp-10k", "cp-10k"]))).toBe("Oct 12–18 · 10K build, week 1 of 4 · 0 of 6 done");
  });

  it("a watch running plan with a race and a lifting plan: the running plan, '+1', and no count (the week read gives none of a watch plan's)", () => {
    // The lifting plan holds more of the week's sessions; the race makes the running plan the main one.
    const w = week(["cp-lift", "cp-lift", "tp-half", "cp-lift"]);
    expect(weekPlan([lift, half], w.weekStart, w)).toEqual({ planName: "Fall Half Marathon Build", planWeekOf: null, planMore: 1 });
    expect(line([lift, half], w)).toBe("Oct 12–18 · Fall Half Marathon Build +1 · 0 of 6 done");
  });

  it("two coach blocks: the one holding more of the week, with its own count — never the longer one's — and '+1'", () => {
    const w = week(["cp-10k", "cp-10k", "cp-base"]);
    // The server counts the longer block's weeks (week 7 of 9 in the read): the line counts the 10K build's own.
    expect(line([base, tenK], w)).toBe("Oct 12–18 · 10K build, week 1 of 4 +1 · 0 of 6 done");
  });

  it("a tie in sessions goes to the earlier start (a rest day is no session)", () => {
    // The 10K build's Sunday is a rest day: one session each.
    const w = week(["cp-10k", "cp-base", "", "", "", "", "cp-10k"]);
    expect(weekPlan([tenK, base], w.weekStart, w).planName).toBe("Spring base");
    expect(line([tenK, base], w)).toBe("Oct 12–18 · Spring base, week 6 of 12 +1 · 0 of 6 done");
    expect(weekPlanName([tenK, base], w.weekStart, w)).toBe("Spring base");
  });

  it("none holding the week: no name, the count as the week read gives it", () => {
    const w = week([]);
    expect(weekPlan([plan("cp-later", "Later", "2026-12-07", "2027-01-03")], w.weekStart, w)).toEqual({ planName: null, planWeekOf: undefined, planMore: 0 });
    expect(line([], w)).toBe("Oct 12–18 · week 7 of 9 · 0 of 6 done");
  });
});
