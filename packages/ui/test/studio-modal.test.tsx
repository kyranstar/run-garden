/**
 * Studio modal (2026-08-11 rework §7): detail mode renders header, prog
 * chips, honest charts, week rows, two-step retire; intake mode renders the
 * interview CTA. Detail arrives via a primed QueryClient cache — the modal's
 * own query then serves synchronously in a static render.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { CoachPlanDto, PlanDetailResponse, PlanProgression } from "@rg/api-client";
import { StudioModal } from "../src/screens/studio-modal.js";
import { PlannedVsActualBars, ProgressionStepChart } from "../src/screens/plan-charts.js";

const noop = () => undefined;

function renderWithCache(el: React.ReactElement, prime?: { key: unknown[]; data: unknown }): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  if (prime) qc.setQueryData(prime.key, prime.data);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, el)),
  );
}

const liftPlan: CoachPlanDto = {
  id: "cp2",
  discipline: "lift",
  name: "Strength Block B",
  status: "active",
  startDate: "2026-07-27",
  endDate: "2026-09-20",
  raceDate: null,
  source: "coach",
};

const bench: PlanProgression = {
  key: "lift:S1",
  label: "Bench Press",
  unit: "kg",
  from: 52,
  to: 66,
  now: 56,
  series: [
    { week: 1, value: 52, done: true },
    { week: 2, value: 54, done: true },
    { week: 3, value: 56 },
    { week: 8, value: 66 },
  ],
};

const detail: PlanDetailResponse = {
  plan: liftPlan,
  weeks: [
    { weekStart: "2026-07-27", index: 1, state: "firm", volumeTarget: null, keySessions: [], summary: "bench 52, squat 75 · 38 sets", done: true, current: false },
    { weekStart: "2026-08-03", index: 2, state: "firm", volumeTarget: null, keySessions: [], summary: "bench 54, squat 80 · 42 sets", done: true, current: false },
    { weekStart: "2026-08-10", index: 3, state: "firm", volumeTarget: null, keySessions: [], summary: "bench 56, squat 82.5 · 44 sets", done: false, current: true },
  ],
  progressions: [bench],
  sessions: { planned: 16, done: 5 },
  adherencePct: 91,
};

describe("StudioModal — detail mode", () => {
  const props = {
    planId: "cp2",
    plans: [liftPlan],
    onClose: noop,
    onCanned: noop,
    onRetire: noop,
    onRename: noop,
  };
  const prime = { key: ["plan-detail", "cp2"], data: detail };

  it("renders name, pills, dates, sessions line, prog chips, weeks, actions", () => {
    const html = renderWithCache(createElement(StudioModal, props), prime);
    expect(html).toContain("Strength Block B");
    expect(html).toContain("pill-lift");
    expect(html).toContain("Jul 27 → Sep 20");
    expect(html).toContain("5 of 16 sessions done");
    expect(html).toContain("adherence 91%");
    expect(html).toContain("52 → <b>66 kg</b>");
    expect(html).toContain("W3");
    expect(html).toContain("is-current");
    expect(html).toContain("✓ done");
    for (const action of ["Extend", "Wind down", "Rename", "Retire…", "Talk to your coach about this plan"]) {
      expect(html).toContain(action);
    }
    // Retire is two-step: the destructive copy only appears after arming.
    expect(html).not.toContain("Really retire");
  });

  it("intake mode renders the interview CTA and no weeks section", () => {
    const html = renderWithCache(
      createElement(StudioModal, { ...props, planId: "new-run" }),
    );
    expect(html).toContain("Plan running with your coach");
    expect(html).toContain("Start the interview");
    expect(html).not.toContain("studio-modal-weeks");
  });
});

describe("progression charts", () => {
  it("ProgressionStepChart: viewBox-only SVG, dashed prescription, done dots, end label", () => {
    const html = renderToStaticMarkup(
      createElement(ProgressionStepChart, { progression: bench, discipline: "lift" }),
    );
    expect(html).toContain("viewBox=");
    expect(html).not.toMatch(/<svg[^>]* width="\d/);
    expect(html).toContain('stroke-dasharray="4 3"');
    expect(html.match(/<circle/g)!.length).toBe(2); // the two done weeks
    expect(html).toContain("66 kg");
    expect(html).toContain("visually-hidden"); // text alternative
  });

  /**
   * A tapered block is where the old end label lied: it printed
   * `progression.to` (the PEAK) hard against the right edge, i.e. over race
   * week, whose prescription is a fraction of it. Label the peak where the
   * peak is, and say the word.
   */
  const tapered: PlanProgression = {
    key: "run:long-run",
    label: "Long run",
    unit: "km",
    from: 8,
    to: 16.1,
    now: 12.9,
    series: [
      { week: 1, value: 8, done: true },
      { week: 5, value: 12.9, done: true },
      { week: 8, value: 16.1 },
      { week: 9, value: 10 },
    ],
  };

  it("ProgressionStepChart: the peak label is drawn at the peak week, not at the endpoint", () => {
    const html = renderToStaticMarkup(
      createElement(ProgressionStepChart, { progression: tapered, discipline: "run" }),
    );
    expect(html).toContain("peak 16.1 km");
    const label = html.match(/<text x="([\d.]+)"[^>]*>peak 16\.1 km<\/text>/);
    expect(label).not.toBeNull();
    // Weeks 1–9 across the plot band (left margin 40, right edge 310): week 8
    // sits at 276.25 — the label must NOT be pinned to the right edge, which
    // is week 9's 10 km taper.
    expect(Number(label![1])).toBeCloseTo(276.25, 1);
    // Nothing captions the last week with the peak's number any more.
    expect(html).not.toMatch(/<text x="310"[^>]*>16\.1/);
  });

  it("ProgressionStepChart: the text alternative describes the drawn line, taper included", () => {
    const html = renderToStaticMarkup(
      createElement(ProgressionStepChart, { progression: tapered, discipline: "run" }),
    );
    expect(html).toContain("from 8 km in week 1 to a peak of 16.1 km in week 8");
    expect(html).toContain("easing to 10 km by week 9");
    // The old wording claimed the block ended at its peak.
    expect(html).not.toContain("from 8 to 16.1 km across weeks 1–9");
  });

  it("ProgressionStepChart: when the current week IS the peak, one label carries both", () => {
    const html = renderToStaticMarkup(
      createElement(ProgressionStepChart, {
        progression: { ...tapered, now: 16.1 },
        discipline: "run",
      }),
    );
    expect(html).toContain("peak 16.1 km · now");
    // …and not a second, overlapping "16.1 · now" text at the same point.
    expect(html).not.toMatch(/>16\.1 · now</);
  });

  it("PlannedVsActualBars: outline planned for every week, filled only where actuals exist", () => {
    const weekly: PlanProgression = {
      key: "run:weekly-minutes",
      label: "Weekly time",
      unit: "min",
      from: 190,
      to: 330,
      now: 260,
      series: [
        { week: 1, value: 190, actual: 185, done: true },
        { week: 2, value: 220, actual: 240, done: true },
        { week: 3, value: 260 },
        { week: 4, value: 330 },
      ],
    };
    const html = renderToStaticMarkup(createElement(PlannedVsActualBars, { progression: weekly }));
    const outlines = html.match(/stroke-dasharray="3 3"/g) ?? [];
    expect(outlines.length).toBe(4);
    const filled = html.match(/fill="var\(--chart-1\)"/g) ?? [];
    expect(filled.length).toBe(2);
  });
});
