/**
 * Insights copy defects seen on the deployed page (audit 2026-08-14 finding 7):
 * a chart description reading "0.9h over 1 runs", and a stray "• " in front of
 * the status strip's metric name. Both are written here in the UI (the metric
 * TITLES come from the worker; the sentence around them does not), so both are
 * fixed here. Data arrives via a primed QueryClient cache — the screen's own
 * query then serves synchronously in a static render (studio-modal.test.tsx
 * pattern); the key is ["insights", discipline].
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InsightsResponse } from "@rg/api-client";
import { InsightsScreen } from "../src/screens/insights.js";

/** One week, one run — the exact shape that produced "0.9h over 1 runs". */
function insights(over: Record<string, unknown> = {}): InsightsResponse {
  return {
    discipline: "run",
    availableDisciplines: ["run"],
    consistency: {
      planned: 0,
      completed: 0,
      skipped: 0,
      missed: 0,
      moved: 0,
      pending: 0,
      adherenceRate: 0,
      days: [],
    },
    weekly: {
      weeks: [
        {
          weekStart: "2026-08-03",
          durationSeconds: 3240,
          runCount: 1,
          lowSeconds: 3240,
          highSeconds: 0,
        },
      ],
      fourWeekAvgDuration: null,
    },
    records: [],
    evidence: null,
    reviews: [],
    interpreted: [],
    ...over,
  } as unknown as InsightsResponse;
}

function render(data: InsightsResponse): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["insights", "run"], data);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(MemoryRouter, null, createElement(InsightsScreen)),
    ),
  );
}

describe("Insights copy", () => {
  it("counts agree with their noun: '0.9h over 1 run', never '1 runs'", () => {
    const html = render(insights());
    expect(html).toContain("0.9h over 1 run.");
    expect(html).toContain("n=1 run");
    expect(html).not.toContain("1 runs");
  });

  it("plural counts keep their s", () => {
    const html = render(
      insights({
        weekly: {
          weeks: [
            {
              weekStart: "2026-08-03",
              durationSeconds: 10_800,
              runCount: 4,
              lowSeconds: 7200,
              highSeconds: 3600,
            },
          ],
          fourWeekAvgDuration: null,
        },
      }),
    );
    expect(html).toContain("3.0h over 4 runs.");
    expect(html).toContain("n=4 runs");
  });

  it("the status strip headlines a watch metric without a stray bullet", () => {
    const html = render(
      insights({
        interpreted: [
          {
            id: "lowIntensityShare",
            title: "Low-intensity share",
            status: "ok",
            band: "watch",
            value: "66%",
            meaning: "How much of your running stayed genuinely easy.",
            suggestion: "Under half your running is easy. More of it could be.",
          },
        ],
      }),
    );
    expect(html).toContain("Low-intensity share: 66% —");
    expect(html).not.toContain("• Low-intensity share");
    expect(html).not.toContain("•");
  });
});
