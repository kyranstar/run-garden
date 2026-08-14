/**
 * Plan-page components (2026-08-11 rework): the weekly brief's headline and
 * chips, the pickable week view's picker/ghost/collapse rules, plan title
 * cards with progressions, and the coach window's open/minimized states.
 * Static-markup renders, same harness as coach-panel.test.tsx.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { CoachPlanDto, PlanDetailResponse, PlanWeekResponse, WorkoutDto } from "@rg/api-client";
import { BriefExplainerSheet, HEADLINE_COPY, headlineContext, WeeklyBrief } from "../src/screens/plan-brief.js";
import { PlanCards, progressionHeadline } from "../src/screens/plan-cards.js";
import { CoachWindow } from "../src/screens/coach-window.js";
import {
  centerScrollTop,
  jumplistDropsUp,
  WeekView,
  weekRangeLabel,
  WorkoutCell,
} from "../src/screens/week-view.js";

const noop = () => undefined;

/** Static-markup render inside router + query provider (PlanCards reads the
 * settings cache for display units); `prime` seeds a query key, same pattern
 * as studio-modal.test.tsx. */
function render(el: React.ReactElement, prime?: { key: unknown[]; data: unknown }): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (prime) qc.setQueryData(prime.key, prime.data);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, el)),
  );
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
    adventureDays: 0,
    headline: "on_track",
    focus: { text: "Saturday's 10-miler anchors the week.", at: "2026-08-11T08:00:00Z" },
    ...over,
  };
}

describe("WeeklyBrief", () => {
  it("renders the headline, the chips, the focus line, and the needs-you pill — but never the load-ratio chip", () => {
    const html = render(
      createElement(WeeklyBrief, { week: weekFixture(), pendingCount: 1, onNeedsYou: noop }),
    );
    expect(html).toContain("Week 5 of 12 — on track.");
    expect(html).toContain("1 of 6");
    expect(html).toContain("5h 5m");
    expect(html).toContain("86%");
    expect(html).toContain("Saturday&#x27;s 10-miler");
    expect(html).toContain("Needs you · 1");
    // The "load 7d/28d" chip is gone (expert jargon, duplicated on Insights) —
    // even with a non-null loadRatio in the fixture, "load" appears nowhere.
    expect(html).not.toContain("load");
    expect(html).not.toContain("1.04");
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

/**
 * The jump menu's placement and scroll (audit 2026-08-14). The measuring
 * itself needs a DOM this package's vitest doesn't have (environment "node"),
 * so — same split as `dockCoversStage` — the two decisions are pure functions
 * and it is those that are tested.
 */
describe("jump-to-week menu placement", () => {
  it("flips up when the list would run past the fold and there is more room above", () => {
    // The measured case: trigger low on an 862px viewport, 300px list.
    expect(jumplistDropsUp(640, 190, 300)).toBe(true);
  });

  it("stays below when it fits — a menu belongs under its trigger", () => {
    expect(jumplistDropsUp(200, 420, 300)).toBe(false);
    // Exactly-fits (plus the 8px margin) still counts as fitting.
    expect(jumplistDropsUp(700, 308, 300)).toBe(false);
  });

  it("stays below when neither side fits but below is the roomier one", () => {
    // Flipping into an even tighter space helps nobody; max-height clips.
    expect(jumplistDropsUp(120, 260, 300)).toBe(false);
  });

  it("a short list never flips, however low the trigger sits", () => {
    expect(jumplistDropsUp(700, 90, 60)).toBe(false);
  });

  it("centres the current week in the open list, clamped to the scroll range", () => {
    // 10 rows of 36px in a 300px window: week 10 (offsetTop 324) centres at 192.
    expect(centerScrollTop(324, 36, 300, 360 * 2)).toBe(192);
    // The first week can't scroll above the top…
    expect(centerScrollTop(0, 36, 300, 720)).toBe(0);
    // …and the last can't scroll past the bottom.
    expect(centerScrollTop(684, 36, 300, 720)).toBe(420);
  });

  it("asks for no scroll at all when the whole list is visible", () => {
    expect(centerScrollTop(180, 36, 300, 300)).toBe(0);
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
      // Settings cache primed to miles — matching the progression's own unit,
      // so the headline passes through unconverted.
      { key: ["settings"], data: { prefs: { units: "mi" } } },
    );
    expect(html).toContain("Fall Half Block");
    expect(html).toContain("wk 5/");
    expect(html).toContain("Long run 8 → 13.1 mi · now 10");
    expect(html).toContain("plan-card-spark");
    expect(html).toContain("Plan lifting with your coach");
    expect(html).not.toContain("Plan running with your coach");
  });

  it("converts a mile-denominated progression to km when the display preference is km", () => {
    const html = render(
      createElement(PlanCards, {
        plans: [runPlan],
        details: new Map([["cp1", detail]]),
        onOpen: noop,
        onNew: noop,
      }),
      { key: ["settings"], data: { prefs: { units: "km" } } },
    );
    // 8 mi → 12.9 km, 13.1 mi → 21.1 km, now 10 mi → 16.1 km.
    expect(html).toContain("Long run 12.9 → 21.1 km · now 16.1");
    expect(html).not.toContain("13.1 mi");
  });

  it("progressionHeadline omits a redundant now and never converts non-distance units", () => {
    expect(
      progressionHeadline({ key: "k", label: "Bench", unit: "kg", from: 52, to: 66, now: 66, series: [] }, "km"),
    ).toBe("Bench 52 → 66 kg");
    expect(
      progressionHeadline({ key: "k", label: "Bench", unit: "kg", from: 52, to: 66, now: 66, series: [] }, "mi"),
    ).toBe("Bench 52 → 66 kg");
  });

  it("progressionHeadline converts between distance units in both directions", () => {
    // The worker example from the units decision: "Long run 6.8 → 10 mi"
    // becomes 10.9 → 16.1 km for a km reader.
    expect(
      progressionHeadline({ key: "k", label: "Long run", unit: "mi", from: 6.8, to: 10, now: null, series: [] }, "km"),
    ).toBe("Long run 10.9 → 16.1 km");
    // And a km-denominated plan reads in miles for a mi reader (10 km → 6.2 mi).
    expect(
      progressionHeadline({ key: "k", label: "Long run", unit: "km", from: 10, to: 16, now: null, series: [] }, "mi"),
    ).toBe("Long run 6.2 → 9.9 mi");
    // Whole converted values drop the trailing .0 (16.09 km → "16.1", 32.19 → "32.2", 8.05 → "8").
    expect(
      progressionHeadline({ key: "k", label: "Long run", unit: "mi", from: 5, to: 10, now: null, series: [] }, "km"),
    ).toBe("Long run 8 → 16.1 km");
  });

  it("groups plans under sport sections, vertically in time order", () => {
    const upcoming: CoachPlanDto = {
      ...runPlan,
      id: "cp2",
      name: "Post-10K block",
      startDate: "2026-10-24",
      endDate: "2026-11-20",
      raceDate: null,
    };
    const html = render(
      createElement(PlanCards, {
        // Deliberately out of order — the section must sort by start date.
        plans: [upcoming, runPlan],
        details: new Map(),
        onOpen: noop,
        onNew: noop,
      }),
    );
    // Run section first, then Lift; inside Run the current plan precedes
    // the upcoming block.
    const runSection = html.indexOf("Running plans");
    const liftSection = html.indexOf("Lifting plans");
    expect(runSection).toBeGreaterThanOrEqual(0);
    expect(liftSection).toBeGreaterThan(runSection);
    const current = html.indexOf("Fall Half Block");
    const next = html.indexOf("Post-10K block");
    expect(current).toBeGreaterThan(runSection);
    expect(next).toBeGreaterThan(current);
    expect(next).toBeLessThan(liftSection);
    // Upcoming rows say when they run; the empty lift section still invites.
    expect(html).toContain("upcoming ·");
    expect(html).toContain("Plan lifting with your coach");
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

describe("round 2 — nothing needs prior context", () => {
  it("headlineContext explains each state; adventures never count against you", () => {
    const base = weekFixture();
    expect(headlineContext({ ...base, headline: "race_week" })).toContain("arriving fresh");
    expect(headlineContext({ ...base, headline: "resting" })).toContain("lighter week");
    expect(headlineContext({ ...base, headline: "on_track" })).toContain("86%");
    expect(headlineContext({ ...base, headline: "behind", adherence4w: { pct: 63, trend: "down" } })).toContain("63%");
    const trip = headlineContext({
      ...base,
      headline: "rebuilding",
      adherence4w: { pct: 40, trend: "down" },
      adventureDays: 6,
    })!;
    expect(trip).toContain("adventures");
    expect(trip).toContain("never count against you");
    expect(
      headlineContext({ ...base, headline: "rebuilding", adherence4w: { pct: null, trend: null }, adventureDays: 0 }),
    ).toContain("starts the record");
  });

  it("the brief renders the context line and tappable chips", () => {
    const html = render(createElement(WeeklyBrief, { week: weekFixture(), pendingCount: 0, onNeedsYou: noop }));
    expect(html).toContain("plan-brief-context");
    expect(html).toContain("keep the rhythm");
    // Three chips since the load-ratio chip's removal: sessions, planned
    // time, 4-week adherence. Training load lives on Insights (and in the
    // explainer sheet) instead.
    const chipButtons = html.match(/<button type="button" class="plan-brief-chip"/g) ?? [];
    expect(chipButtons.length).toBe(3);
  });

  it("BriefExplainerSheet spells out all four numbers with their values", () => {
    const html = render(
      createElement(BriefExplainerSheet, { week: weekFixture(), open: true, onClose: noop }),
    );
    expect(html).toContain("Sessions · 1 of 6");
    expect(html).toContain("5h 5m");
    expect(html).toContain("Around 80% is a healthy training rhythm");
    expect(html).toContain("pause the plan");
    expect(html).toContain("Near 1.0 is steady");
  });

  it("WorkoutCell speaks category words for COROS code titles, keeps real names", () => {
    const code = render(
      createElement(WorkoutCell, {
        w: workout({ title: "T1004", qualitySubtype: "threshold" }),
        today: "2026-08-11",
        onOpen: noop,
      }),
    );
    expect(code).toContain("Threshold");
    expect(code).not.toContain(">T1004<");
    expect(code).toContain('title="T1004"'); // the raw name survives on hover
    const real = render(
      createElement(WorkoutCell, { w: workout({ title: "Tempo 5k" }), today: "2026-08-11", onOpen: noop }),
    );
    expect(real).toContain("Tempo 5k");
  });
});
