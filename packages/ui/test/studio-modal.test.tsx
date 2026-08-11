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
    expect(html).toContain("2026-07-27 → 2026-09-20");
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
