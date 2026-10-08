/**
 * The Progress tiles on the Activity page (Phase 2d Task 3; mocks §8): the condition tile ("Jaw, after sessions ·
 * 1.4 from 2.1", before and after lines, flare days), weekly volume in the athlete's unit, and a tile per core lift
 * (its top set each week, its best as typed, labelled in the unit last used).
 *
 * Review Focus 4: below four paired sessions the condition tile says how many more it needs — no number, no line.
 * Review Focus 5: a lift logged in both units draws one line, labelled in the unit used last.
 * Every condition word comes from the profile (`label`); the UI has none of its own.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { InsightsResponse, ProgressDto } from "@rg/api-client";
import { ProgressTiles, progressShown } from "../src/screens/progress-tiles.js";
import { RunsScreen } from "../src/screens/runs.js";
import { emptyInsights } from "./runs-units.test.js";

const LB = 0.45359237;
const weeks8 = ["2026-08-24", "2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"];

const conditionOk: ProgressDto["conditions"][number] = {
  profileId: "tmj",
  label: "Jaw / head",
  trend: {
    status: "ok",
    sampleSize: 6,
    comparisonNote: "",
    value: {
      preMean: 2.1,
      postMean: 1.4,
      pairs: 6,
      flareDays: 2,
      weeks: weeks8.map((weekStart, i) => ({ weekStart, pre: i % 3 === 2 ? null : 2 + (i % 2) * 0.5, post: i % 3 === 2 ? null : 1.5 - i * 0.05 })),
    },
  },
};

const volumeOk: ProgressDto["volume"] = {
  status: "ok",
  sampleSize: 9,
  comparisonNote: "",
  value: { weeks: weeks8.map((weekStart, i) => ({ weekStart, kg: 1500 + i * 180, sessions: 1 })), thisWeekKg: 6120 * LB },
};

const squat = (unit: "lb" | "kg"): ProgressDto["lifts"][number] => ({
  exerciseId: "gobletSquat",
  name: "Goblet squat",
  trend: {
    status: "ok",
    sampleSize: 3,
    comparisonNote: "",
    value: {
      series: [
        { weekStart: "2026-09-14", kg: 20 * LB },
        { weekStart: "2026-09-28", kg: 25 * LB },
        { weekStart: "2026-10-12", kg: 30 * LB },
      ],
      best: { w: { v: 30, u: "lb" }, reps: 6, date: "2026-10-13" },
      unit,
    },
  },
});

const progress = (over: Partial<ProgressDto> = {}): ProgressDto => ({
  weightUnit: "lb",
  conditions: [conditionOk],
  volume: volumeOk,
  lifts: [squat("lb")],
  ...over,
});

const render = (p: ProgressDto) => renderToStaticMarkup(createElement(ProgressTiles, { progress: p }));

describe("the condition tile", () => {
  it("after sessions, from before: the means, both lines, and the flare days — in the profile's own word", () => {
    const html = render(progress());
    expect(html).toContain("Jaw, after sessions");
    expect(html).toContain(">1.4<");
    expect(html).toContain("from 2.1");
    expect(html).toContain("before");
    expect(html).toContain("after");
    expect(html).toContain("2 flare days");
    expect(html.match(/<polyline/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("Review Focus 4: below four pairs it says how many more sessions it needs — no number, no line", () => {
    const html = render(
      progress({
        conditions: [{ ...conditionOk, trend: { status: "insufficient_data", needed: 4, have: 1, explanation: "x" } }],
        volume: { status: "insufficient_data", needed: 1, have: 0, explanation: "x" },
        lifts: [],
      }),
    );
    expect(html).toContain("Jaw, after sessions");
    expect(html).toContain("Needs 3 more sessions");
    expect(html).not.toContain("from ");
    expect(html).not.toContain("<polyline");
  });

  it("speaks whatever profile is switched on", () => {
    const html = render(progress({ conditions: [{ ...conditionOk, profileId: "knee", label: "Knee / hip" }] }));
    expect(html).toContain("Knee, after sessions");
    expect(html).not.toContain("Jaw");
  });
});

describe("the weekly volume tile", () => {
  it("this week's volume in the athlete's unit, eight bars", () => {
    const html = render(progress());
    expect(html).toContain("Weekly volume");
    expect(html).toContain("6,120 lb");
    expect(html).toContain("8 weeks");
    expect(html.match(/<rect/g)).toHaveLength(8);
    expect(render(progress({ weightUnit: "kg" }))).toContain("2,776 kg");
  });

  it("with nothing weighted yet, says so", () => {
    expect(render(progress({ volume: { status: "insufficient_data", needed: 1, have: 0, explanation: "x" } }))).toContain("No weighted sets yet");
  });
});

describe("a lift tile (Review Focus 5)", () => {
  it("its best as typed, its line labelled low to high in the unit last used", () => {
    const html = render(progress());
    expect(html).toContain("Goblet squat");
    expect(html).toContain("best 30 lb × 6");
    expect(html).toContain("20 lb");
    expect(html).toContain("30 lb");
  });

  it("last used in kilograms: the same line labelled in kilograms, the best still as typed", () => {
    const html = render(progress({ lifts: [squat("kg")] }));
    expect(html).toContain("9 kg");
    expect(html).toContain("13.5 kg");
    expect(html).toContain("best 30 lb × 6");
  });

  it("one week logged: needs one more; never logged: no tile", () => {
    const one = render(progress({ lifts: [{ ...squat("lb"), trend: { status: "insufficient_data", needed: 2, have: 1, explanation: "x" } }] }));
    expect(one).toContain("Goblet squat");
    expect(one).toContain("Needs 1 more week");
    const none = render(progress({ lifts: [{ ...squat("lb"), trend: { status: "insufficient_data", needed: 2, have: 0, explanation: "x" } }] }));
    expect(none).not.toContain("Goblet squat");
  });
});

describe("progressShown", () => {
  it("a new account has nothing to show; a profile, a weighted set or a logged core lift does", () => {
    const empty: ProgressDto = { weightUnit: "lb", conditions: [], volume: { status: "insufficient_data", needed: 1, have: 0, explanation: "" }, lifts: [] };
    expect(progressShown(empty)).toBe(false);
    expect(progressShown(undefined)).toBe(false);
    expect(progressShown({ ...empty, volume: volumeOk })).toBe(true);
    expect(progressShown({ ...empty, conditions: [{ ...conditionOk, trend: { status: "insufficient_data", needed: 4, have: 0, explanation: "" } }] })).toBe(true);
    expect(progressShown({ ...empty, lifts: [{ ...squat("lb"), trend: { status: "insufficient_data", needed: 2, have: 0, explanation: "" } }] })).toBe(false);
  });
});

describe("on the Activity page", () => {
  function page(insights: InsightsResponse): string {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(["runs"], { activities: [] });
    qc.setQueryData(["settings"], { prefs: { units: "km" } });
    qc.setQueryData(["insights", "run"], insights);
    return renderToStaticMarkup(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, null, createElement(RunsScreen))));
  }

  it("a Progress section with the tiles under All; none for a payload without progress", () => {
    const html = page({ ...emptyInsights(), progress: progress() } as InsightsResponse);
    expect(html).toContain('aria-label="Progress"');
    expect(html).toContain("Weekly volume");
    expect(page(emptyInsights())).not.toContain('aria-label="Progress"');
  });
});

describe("no condition word of the UI's own", () => {
  it("the tiles' source names no profile and no condition", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/screens/progress-tiles.tsx", import.meta.url)), "utf8");
    expect(src).not.toMatch(/\bjaw\b|\btmj\b|\bknee\b/i);
  });
});
