/**
 * THE WEEK'S LINE WITH MORE THAN ONE PLAN (§8 §5, stream W; review-3 and its re-check; training lines §3.6). The line
 * names the week's MAIN plan — the group holding the most of the week's sessions, a tie to the run line with a race,
 * then the earlier start; inside a line, its phase holding the most (a tie to the later start) — with its own week
 * count when the app knows it, and "+N" for the other GROUPS holding the week: a line's own phases are never "+1". Never one plan's
 * name beside another plan's count: a coach block's count is its own (its dates, counted as the server counts a block's
 * weeks); a watch plan's week isn't one the plan's week read gives, so it goes without one. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import type { CoachPlanDto, PlanWeekResponse, WorkoutDto } from "@rg/api-client";
import { linesOf, type LineBlock } from "@rg/domain";
import { jumpWeeksOf, weekLine, weekPlan, weekPlanName } from "../src/screens/week-view.js";
import { WEEK_NAMING_CASES, datedPlans } from "../../domain/test/week-naming-cases.js";

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
/** The lines as `GET /api/coach/plans` answers them. */
const dtoLines = (blocks: CoachPlanDto[], today: string) =>
  linesOf(
    blocks.filter((b) => b.source === "coach").map((b) => ({ ...b, planRaceDate: b.raceDate }) as unknown as LineBlock),
    today,
  ).map((l) => ({ ...l, phases: l.phases.map((p) => ({ ...p, futureSessions: 0 })) }));

describe("the week's main plan, its own count, and how many others", () => {
  it("one plan: its name with its own week count", () => {
    expect(line([tenK], week(["cp-10k", "cp-10k"]))).toBe("Oct 12–18 · 10K build, week 1 of 4 · 0 of 6 done");
  });

  it("a watch running plan with a race and a lifting plan: the one holding more sessions (a race no longer comes first), '+1'", () => {
    // The lifting plan holds more of the week's sessions: it names the week, with its own count (spec §3.6).
    const w = week(["cp-lift", "cp-lift", "tp-half", "cp-lift"]);
    expect(weekPlan([lift, half], w.weekStart, w)).toEqual({ planName: "Strength block", planWeekOf: "week 3 of 5", planMore: 1 });
    expect(line([lift, half], w)).toBe("Oct 12–18 · Strength block, week 3 of 5 +1 · 0 of 6 done");
  });

  it("a tie in sessions goes to the run plan with a race: the watch plan, '+1', and no count (the week read gives none of a watch plan's)", () => {
    const w = week(["cp-lift", "tp-half"]);
    expect(weekPlan([lift, half], w.weekStart, w)).toEqual({ planName: "Fall Half Marathon Build", planWeekOf: null, planMore: 1 });
    expect(line([lift, half], w)).toBe("Oct 12–18 · Fall Half Marathon Build +1 · 0 of 6 done");
  });

  it("two phases of one line: the one holding more of the week, with its own count, never '+1'", () => {
    const w = week(["cp-10k", "cp-10k", "cp-base"]);
    // The 10K build runs inside the spring base: one line. The read counts the longer phase's weeks (week 7 of 9):
    // the line counts the 10K build's own.
    expect(line([base, tenK], w)).toBe("Oct 12–18 · 10K build, week 1 of 4 · 0 of 6 done");
    expect(weekPlan([base, tenK], w.weekStart, w).planMore).toBe(0);
  });

  it("a tie between a line's phases goes to the later start (a rest day is no session)", () => {
    // The 10K build's Sunday is a rest day: one session each.
    const w = week(["cp-10k", "cp-base", "", "", "", "", "cp-10k"]);
    expect(weekPlan([tenK, base], w.weekStart, w).planName).toBe("10K build");
    expect(weekPlanName([tenK, base], w.weekStart, w)).toBe("10K build");
  });

  it("a tie between two lines goes to the earlier start (a rest day is no session)", () => {
    // The lifting plan's Sunday is a rest day: one session each.
    const w = week(["cp-base", "cp-lift", "", "", "", "", "cp-lift"]);
    expect(weekPlan([lift, base], w.weekStart, w).planName).toBe("Spring base");
    expect(line([lift, base], w)).toBe("Oct 12–18 · Spring base, week 6 of 12 +1 · 0 of 6 done");
  });

  it("with no lines in hand, a plan's race is its OWN (planRaceDate), never Settings' fallback in raceDate", () => {
    // The 10K build's raceDate is Settings' fallback (it has no race of its own): a tie goes to the earlier start.
    const settingsRace = { ...tenK, raceDate: "2026-12-01", planRaceDate: null };
    const w = week(["cp-lift", "cp-10k"]);
    expect(weekPlan([lift, settingsRace], w.weekStart, w).planName).toBe("Strength block");
    const own = { ...tenK, raceDate: "2026-12-01", planRaceDate: "2026-12-01" };
    expect(weekPlan([lift, own], w.weekStart, w).planName).toBe("10K build");
  });

  it("reads the lines the plans read answers, and works them out itself when it has none", () => {
    const w = week(["cp-10k", "cp-base"]);
    const blocks = [base, tenK];
    expect(weekPlan(blocks, w.weekStart, w, dtoLines(blocks, w.weekStart))).toEqual(weekPlan(blocks, w.weekStart, w));
  });

  it("none holding the week: no name, the count as the week read gives it", () => {
    const w = week([]);
    expect(weekPlan([plan("cp-later", "Later", "2026-12-07", "2027-01-03")], w.weekStart, w)).toEqual({ planName: null, planWeekOf: undefined, planMore: 0 });
    expect(line([], w)).toBe("Oct 12–18 · week 7 of 9 · 0 of 6 done");
  });
});

describe("the week-jump menu numbers a line's weeks from its first phase", () => {
  const first = plan("cp-a", "Base", "2026-09-07", "2026-10-04", { status: "completed" });
  const second = plan("cp-b", "Build", "2026-10-05", "2026-11-01");
  it("a line's second phase carries on the count: Oct 12 is week 6, not week 2", () => {
    const labels = jumpWeeksOf([second], dtoLines([first, second], "2026-10-12"));
    expect(labels.find((j) => j.monday === "2026-10-12")?.label).toMatch(/^wk 6 · /);
    expect(labels[0]).toMatchObject({ monday: "2026-09-07" });
    expect(labels[0]!.label).toMatch(/^wk 1 · /);
  });
  it("without the lines it numbers from the phase's own start, as it did", () => {
    expect(jumpWeeksOf([second]).find((j) => j.monday === "2026-10-12")?.label).toMatch(/^wk 2 · /);
  });
  it("a Studio plan beside the line is a span of its own, but the line numbers the weeks (§3.6): Oct 12 is week 6 though the Studio span is longer", () => {
    const studio = plan("st-1", "Studio", "2026-08-31", "2026-11-01", { source: "studio", discipline: "lift" });
    const labels = jumpWeeksOf([second, studio], dtoLines([first, second], "2026-10-12"));
    expect(labels.find((j) => j.monday === "2026-10-12")?.label).toMatch(/^wk 6 · /);
    // A week only the Studio plan holds is numbered by nothing (no anchor holds it).
    expect(labels.find((j) => j.monday === "2026-08-31")?.label).not.toMatch(/^wk /);
  });
});

describe("the shared week-naming table (training lines §3.6): the week brief is held to the same rows", () => {
  // The anchor: Monday 12 Oct 2026, also "today" for the lines.
  const monday = "2026-10-12";
  const shift = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  for (const c of WEEK_NAMING_CASES) {
    it(c.name, () => {
      const dated = datedPlans(monday, c);
      const weekStart = shift(monday, c.weekOffset * 7);
      // What the Plan screen holds: no one-off buckets, no retired plan, and no id that is no plan (a programme's slots).
      const blocks = dated
        .filter((p) => !p.loose && p.status !== "retired" && p.source !== "orphan")
        .map((p) =>
          plan(p.id, p.name, p.startDate, p.endDate, {
            discipline: p.discipline,
            status: p.status,
            raceDate: p.raceDate,
            source: p.source === "studio" ? "studio" : "coach",
          }),
        );
      const ids = dated.flatMap((p) => Array.from({ length: p.sessions }, () => p.id));
      const days = Array.from({ length: 7 }, (_, i) => ({
        date: shift(weekStart, i),
        workouts: ids
          .filter((_, k) => k % 7 === i)
          .map((id, k) => ({ id: `w${i}-${k}`, planId: id, category: "easy" }) as unknown as WorkoutDto),
      }));
      const w = { weekStart, days, weekIndex: 99, weekTotal: 99 } as unknown as PlanWeekResponse;
      const got = weekPlan(blocks, weekStart, w, dtoLines(blocks, monday));
      expect(got.planName).toBe(blocks.find((b) => b.id === c.expect.planId)?.name ?? null);
      expect(got.planMore).toBe(c.expect.others);
      if (c.expect.planId === null) expect(got.planWeekOf).toBeUndefined();
      else expect(got.planWeekOf).toBe(c.expect.weekOf ? `week ${c.expect.weekOf[0]} of ${c.expect.weekOf[1]}` : null);
    });
  }
});
