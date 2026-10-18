/**
 * THE WEEK'S LINE WITH MORE THAN ONE PLAN (§8 §5, stream W; review-3). The line named the longest plan holding the week
 * and gave the week count the server counted for its coach block — another plan's, once the coach builds blocks beside a
 * watch plan: "Oct 19–25 · Fall Half Marathon Build, week 1 of 4", where week 1 of 4 was the 10K build's. Now: one plan
 * holding the week is named with its own count (a coach block's — the count the server gives is a coach block's); two or
 * more are said as "2 plans", with no count (the calm option: no plan named over another's number). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import type { CoachPlanDto, PlanWeekResponse } from "@rg/api-client";
import { weekLine, weekPlan, weekPlanName } from "../src/screens/week-view.js";

const plan = (id: string, name: string, startDate: string, endDate: string, source: CoachPlanDto["source"] = "coach"): CoachPlanDto => ({
  id, discipline: "run", name, status: "active", startDate, endDate, raceDate: null, source,
});
const week = (over: Partial<PlanWeekResponse> = {}): PlanWeekResponse =>
  ({ weekStart: "2026-10-19", days: [], plannedSeconds: 0, doneCount: 0, sessionCount: 11, weekIndex: 1, weekTotal: 4, ...over }) as unknown as PlanWeekResponse;

const tenK = plan("cp-10k", "10K build", "2026-10-19", "2026-11-15");
const watch = plan("tp-half", "Fall Half Marathon Build", "2026-08-03", "2026-11-22", "coros");

describe("the plan a week's line names", () => {
  it("one plan holding the week: its name, with its own week count", () => {
    expect(weekPlan([tenK], "2026-10-19")).toEqual({ name: "10K build", ownWeek: true });
    expect(weekLine({ week: week(), ...lineOf(weekPlan([tenK], "2026-10-19")), race: null })).toBe("Oct 19–25 · 10K build, week 1 of 4 · 0 of 11 done");
  });

  it("two plans holding it: '2 plans', and no week count — never one plan's name beside another's number", () => {
    const both = weekPlan([watch, tenK], "2026-10-19");
    expect(both).toEqual({ name: "2 plans", ownWeek: false });
    expect(weekLine({ week: week(), ...lineOf(both), race: null })).toBe("Oct 19–25 · 2 plans · 0 of 11 done");
    expect(weekPlanName([watch, tenK], "2026-10-19")).toBe("2 plans");
  });

  it("a watch plan alone: its name; the server's count is a coach block's, so none beside it", () => {
    expect(weekPlan([watch], "2026-10-19")).toEqual({ name: "Fall Half Marathon Build", ownWeek: false });
    expect(weekLine({ week: week(), ...lineOf(weekPlan([watch], "2026-10-19")), race: null })).toBe("Oct 19–25 · Fall Half Marathon Build · 0 of 11 done");
  });

  it("none holding it: no name, the count as the server gives it", () => {
    expect(weekPlan([tenK], "2026-12-07")).toEqual({ name: null, ownWeek: true });
  });
});

function lineOf(p: { name: string | null; ownWeek: boolean }) {
  return { planName: p.name, planWeek: p.ownWeek };
}
