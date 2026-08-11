/**
 * Plan-page components (2026-08-11 rework): the weekly brief's headline and
 * chips, the pickable week view's picker/ghost/collapse rules, plan title
 * cards with progressions, and the coach window's open/minimized states.
 * Static-markup renders, same harness as coach-panel.test.tsx.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { CoachPlanDto, PlanDetailResponse, PlanWeekResponse, WorkoutDto } from "@rg/api-client";
import { HEADLINE_COPY, WeeklyBrief } from "../src/screens/plan-brief.js";
import { PlanCards, progressionHeadline } from "../src/screens/plan-cards.js";
import { CoachWindow } from "../src/screens/coach-window.js";
import { WeekView, weekRangeLabel } from "../src/screens/week-view.js";

const noop = () => undefined;

function render(el: React.ReactElement): string {
  return renderToStaticMarkup(createElement(MemoryRouter, null, el));
}

function workout(over: Partial<WorkoutDto> = {}): WorkoutDto {
  return {
    id: "w1",
    title: "Tempo 40 min",
    category: "quality",
    qualitySubtype: null,
    sport: "run",
    originalPlanDate: "2026-08-11",
    lastVerifiedCorosDate: "2026-08-11",
    effectiveDate: "2026-08-11",
    effectiveTime: "07:00",
    workoutSeconds: 2400,
    calendarSeconds: 2400,
    stageSummary: null,
    calendarSyncState: "created",
    corosSyncState: "synced",
    completionState: "scheduled",
    archived: false,
    ...over,
  } as WorkoutDto;
}

function weekFixture(over: Partial<PlanWeekResponse> = {}): PlanWeekResponse {
  return {
    weekStart: "2026-08-10",
    days: Array.from({ length: 7 }, (_, i) => ({
      date: `2026-08-${10 + i}`,
      workouts: i === 1 ? [workout()] : [],
    })),
    plannedSeconds: 18300,
    doneCount: 1,
    sessionCount: 6,
    weekIndex: 5,
    weekTotal: 12,
    adherence4w: { pct: 86, trend: "up" },
    loadRatio: 1.04,
    headline: "on_track",
    focus: { text: "Saturday's 10-miler anchors the week.", at: "2026-08-11T08:00:00Z" },
    ...over,
  };
}

describe("WeeklyBrief", () => {
  it("renders the headline, all four chips, the focus line, and the needs-you pill", () => {
    const html = render(
      createElement(WeeklyBrief, { week: weekFixture(), pendingCount: 1, onNeedsYou: noop }),
    );
    expect(html).toContain("Week 5 of 12 — on track.");
    expect(html).toContain("1 of 6");
    expect(html).toContain("5h 5m");
    expect(html).toContain("86%");
    expect(html).toContain("1.04");
    expect(html).toContain("Saturday&#x27;s 10-miler");
    expect(html).toContain("Needs you · 1");
  });

  it("drops the week fragment without a plan, null chips, stale focus, zero pending", () => {
    const html = render(
      createElement(WeeklyBrief, {
        week: weekFixture({
          weekIndex: null,
          weekTotal: null,
          adherence4w: { pct: null, trend: null },
          loadRatio: null,
          focus: null,
        }),
        pendingCount: 0,
        onNeedsYou: noop,
      }),
    );
    expect(html).toContain("This week — on track.");
    expect(html).not.toContain("adherence");
    expect(html).not.toContain("load 7d/28d");
    expect(html).not.toContain("Needs you");
    expect(html).not.toContain("plan-brief-action");
  });

  it("headline copy covers every state", () => {
    for (const key of ["on_track", "behind", "ahead", "rebuilding", "race_week", "resting"] as const) {
      expect(HEADLINE_COPY[key]).toBeTruthy();
    }
  });
});

describe("WeekView", () => {
  const ghosts = new Map([
    ["2026-08-11", [{ kind: "rewrite" as const, label: "eased", proposalId: "p1", title: "Ease the tempo" }]],
  ]);

  it("renders 7 Mon-first cells, today ring, the ghost, and the current-week title", () => {
    const html = render(
      createElement(WeekView, {
        week: weekFixture(),
        today: "2026-08-11",
        ghostsByDate: ghosts,
        jumpWeeks: [],
        onPick: noop,
        onOpenWorkout: noop,
        onGhostTap: noop,
      }),
    );
    expect(html.match(/plan-week-day/g)!.length).toBeGreaterThanOrEqual(7);
    expect(html).toContain("is-today");
    expect(html).toContain("cal-ghost-rewrite");
    expect(html).toContain("This week · ");
    expect(html).toContain("Aug 10–16");
    expect(html).not.toContain("back to this week");
  });

  it("navigated away: plain range title + back-to-this-week chip; jump menu lists weeks", () => {
    const html = render(
      createElement(WeekView, {
        week: weekFixture({ weekStart: "2026-08-17", days: [] }),
        today: "2026-08-11",
        ghostsByDate: new Map(),
        jumpWeeks: [
          { monday: "2026-08-10", label: "wk 5 · Aug 10–16" },
          { monday: "2026-08-17", label: "wk 6 · Aug 17–23" },
        ],
        onPick: noop,
        onOpenWorkout: noop,
        onGhostTap: noop,
      }),
    );
    expect(html).toContain("back to this week");
    expect(html).toContain("wk 6 · Aug 17–23");
    expect(html).toContain("jump to week");
  });

  it("weekRangeLabel crosses months honestly", () => {
    expect(weekRangeLabel("2026-08-10")).toBe("Aug 10–16");
    expect(weekRangeLabel("2026-08-31")).toBe("Aug 31 – Sep 6");
  });
});

describe("PlanCards", () => {
  const runPlan: CoachPlanDto = {
    id: "cp1",
    discipline: "run",
    name: "Fall Half Block",
    status: "active",
    startDate: "2026-07-13",
    endDate: "2026-10-04",
    raceDate: "2026-10-04",
    source: "coach",
  };
  const detail = {
    plan: runPlan,
    weeks: [
      { weekStart: "2026-08-10", index: 5, state: "firm", volumeTarget: null, keySessions: [], summary: "", done: false, current: true },
    ],
    progressions: [
      {
        key: "run:long-run",
        label: "Long run",
        unit: "mi",
        from: 8,
        to: 13.1,
        now: 10,
        series: [
          { week: 1, value: 8, done: true },
          { week: 5, value: 10 },
          { week: 12, value: 13.1 },
        ],
      },
    ],
    sessions: { planned: 48, done: 20 },
    adherencePct: 86,
  } as unknown as PlanDetailResponse;

  it("renders the card with week label, progression headline, sparkline, and a new-lift card", () => {
    const html = render(
      createElement(PlanCards, {
        plans: [runPlan],
        details: new Map([["cp1", detail]]),
        onOpen: noop,
        onNew: noop,
      }),
    );
    expect(html).toContain("Fall Half Block");
    expect(html).toContain("wk 5/");
    expect(html).toContain("Long run 8 → 13.1 mi · now 10");
    expect(html).toContain("plan-card-spark");
    expect(html).toContain("Plan lifting with your coach");
    expect(html).not.toContain("Plan running with your coach");
  });

  it("progressionHeadline omits a redundant now", () => {
    expect(
      progressionHeadline({ key: "k", label: "Bench", unit: "kg", from: 52, to: 66, now: 66, series: [] }),
    ).toBe("Bench 52 → 66 kg");
  });
});

describe("CoachWindow", () => {
  it("minimized: the pill with the pending count; open: the window with children", () => {
    const pill = render(
      createElement(
        CoachWindow,
        { open: false, pendingCount: 2, onOpen: noop, onMinimize: noop, dialogOpen: false },
        createElement("div", { className: "inner-panel" }),
      ),
    );
    expect(pill).toContain("Coach · 2");
    expect(pill).not.toContain("coach-window");

    const win = render(
      createElement(
        CoachWindow,
        { open: true, pendingCount: 2, onOpen: noop, onMinimize: noop, dialogOpen: false },
        createElement("div", { className: "inner-panel" }),
      ),
    );
    expect(win).toContain("coach-window");
    expect(win).toContain("inner-panel");
    expect(win).toContain("Minimize the coach");
  });
});
