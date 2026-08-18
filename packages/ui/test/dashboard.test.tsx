/**
 * The Activity dashboard (System 2): the merge's own contracts.
 *  - flaggedSignals mirrors the old status strip's eligibility gates — a
 *    low-confidence or unrendered metric can never headline the page;
 *  - groupByWeek buckets the feed newest-week-first, newest-day-first;
 *  - efficiencyClause speaks only when it has a run and three priors;
 *  - the page: flagged tile OR the all-clear line (never both), records
 *    capped at three until expanded, the week header counts its sessions,
 *    a review's first sentence heads its week.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ActivityDto, InsightsResponse } from "@rg/api-client";
import { efficiencyClause, flaggedSignals, groupByWeek, RunsScreen } from "../src/screens/runs.js";
import { emptyInsights } from "./runs-units.test.js";

type Interpreted = InsightsResponse["interpreted"][number];

function metric(over: Partial<Interpreted>): Interpreted {
  return {
    id: "lowIntensityShare",
    title: "Easy-running share",
    status: "ok",
    band: "high",
    value: "29%",
    meaning: "Share of easy running.",
    sampleNote: "",
    ...over,
  } as Interpreted;
}

function act(over: Partial<ActivityDto>): ActivityDto {
  return {
    id: `a-${Math.abs(JSON.stringify(over).split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7))}`,
    startTime: "2026-08-10T07:01:00Z",
    startTimeLocal: "2026-08-10T07:01:00",
    date: "2026-08-10",
    title: "Morning run",
    sport: "run",
    durationSeconds: 3000,
    distanceMeters: 10000,
    avgPaceSecPerKm: 300,
    trainingLoad: 62,
    feel: 4,
    laps: null,
    matched: null,
    ...over,
  } as ActivityDto;
}

describe("flaggedSignals", () => {
  it("keeps the strip's gates: rendered id, confident, not stale, banded", () => {
    const flagged = flaggedSignals([
      metric({ id: "lowIntensityShare", band: "high" }),
      metric({ id: "hrv", band: "watch" }),
      metric({ id: "restingHr", band: undefined }),
      metric({ id: "ramp", band: "high", bandNote: "withheld" }),
      metric({ id: "monotony", band: "high", staleNote: "old" }),
      metric({ id: "notARenderedMetric", band: "high" }),
      metric({ id: "pacing", band: "high", status: "insufficient_data" }),
    ]);
    expect(flagged.map((m) => m.id)).toEqual(["lowIntensityShare", "hrv"]);
  });
});

describe("groupByWeek", () => {
  it("buckets by ISO week, newest week first, newest day first inside it", () => {
    const weeks = groupByWeek([
      act({ id: "w1a", date: "2026-08-11" }),
      act({ id: "w2a", date: "2026-08-05" }),
      act({ id: "w1b", date: "2026-08-15" }),
      act({ id: "w2b", date: "2026-08-09" }),
    ]);
    expect(weeks.map((w) => w.monday)).toEqual(["2026-08-10", "2026-08-03"]);
    expect(weeks[0]!.items.map((a) => a.id)).toEqual(["w1b", "w1a"]);
    expect(weeks[1]!.items.map((a) => a.id)).toEqual(["w2b", "w2a"]);
  });
});

describe("efficiencyClause", () => {
  const eff = (values: number[], id = "target"): InsightsResponse["efficiency"] =>
    ({
      status: "ok",
      sampleSize: values.length,
      comparisonNote: "",
      value: {
        perRun: values.map((v, i) => ({
          activityId: i === values.length - 1 ? id : `r${i}`,
          date: `2026-08-0${i + 1}`,
          efficiency: v,
        })),
        excludedCount: 0,
      },
    }) as InsightsResponse["efficiency"];

  it("speaks in one plain clause, in both directions and on the line", () => {
    expect(efficiencyClause(eff([1.0, 1.0, 1.0, 1.1]), "target")).toContain("Above");
    expect(efficiencyClause(eff([1.0, 1.0, 1.0, 0.9]), "target")).toContain("Below");
    expect(efficiencyClause(eff([1.0, 1.0, 1.0, 1.0]), "target")).toContain("Right on");
  });

  it("stays silent without the run or without three scored priors", () => {
    expect(efficiencyClause(eff([1.0, 1.0, 1.0, 1.1]), "someone-else")).toBeNull();
    expect(efficiencyClause(eff([1.0, 1.1]), "target")).toBeNull();
    expect(efficiencyClause(undefined, "target")).toBeNull();
    expect(
      efficiencyClause(
        { status: "insufficient_data", needed: 5, have: 1, explanation: "" } as InsightsResponse["efficiency"],
        "target",
      ),
    ).toBeNull();
  });
});

function renderDash(insights: InsightsResponse, activities: ActivityDto[]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["runs"], { activities });
  qc.setQueryData(["settings"], { prefs: { units: "km" } });
  qc.setQueryData(["insights", "run"], insights);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(MemoryRouter, null, createElement(RunsScreen)),
    ),
  );
}

describe("the dashboard's own copy", () => {
  it("a flagged tile suppresses the all-clear line; all-clear suppresses tiles", () => {
    const flaggedPage = renderDash(
      { ...emptyInsights(), interpreted: [metric({})] } as InsightsResponse,
      [],
    );
    expect(flaggedPage).toContain("Easy-running share");
    expect(flaggedPage).not.toContain("signals in range");

    const clearPage = renderDash(
      { ...emptyInsights(), interpreted: [metric({ band: undefined })] } as InsightsResponse,
      [],
    );
    expect(clearPage).toContain("All 1 signals in range.");
    expect(clearPage).not.toContain("Easy-running share ·");
  });

  it("records cap at three until expanded, and the week header counts its sessions", () => {
    const recs = ["a", "b", "c", "d"].map((id, i) => ({
      id,
      title: `Record ${id}`,
      value: `${i}`,
      achievedOn: "2026-06-01",
      rule: "",
      numeric: i,
    }));
    const html = renderDash({ ...emptyInsights(), records: recs } as InsightsResponse, [
      act({ id: "x1", date: "2026-08-10" }),
      act({ id: "x2", date: "2026-08-11" }),
    ]);
    expect(html).toContain("Record a");
    expect(html).toContain("Record c");
    expect(html).not.toContain("Record d");
    expect(html).toContain("All 4 records");
    expect(html).toContain("2 sessions · 1.7h");
  });

  it("a review's first sentence heads its week, in quotes, with the full review a tap away", () => {
    const html = renderDash(
      {
        ...emptyInsights(),
        reviews: [
          {
            id: "r1",
            userId: "u",
            weekStart: "2026-08-10",
            facts: { completed: 3, planned: 4 },
            narrative: "The week held together. The long run stretched without the fade.",
            llmModel: null,
            llmCostMicros: 0,
            createdAt: "2026-08-17T00:00:00Z",
          },
        ],
      } as unknown as InsightsResponse,
      [act({ id: "y1", date: "2026-08-11" })],
    );
    expect(html).toContain("The week held together.");
    expect(html).not.toContain("without the fade");
    expect(html).toContain("Full review");
  });
});
