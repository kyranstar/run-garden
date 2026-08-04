import { Fragment, createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BaselineBandChart,
  ConsistencyHeatmap,
  DivergingPaceBars,
  LapHrBars,
  OutcomeBar,
  RunSeriesChart,
  WeeklyDurationChart,
} from "../src/charts.js";
import { TrendChip } from "../src/chart-kit.js";

/**
 * Renders every chart to static markup and asserts the invariants that only
 * show up once the geometry actually runs: no NaN coordinates from a
 * degenerate domain, no SVG `<title>` sneaking back in, no duplicate pattern
 * ids when several hatched charts share a page, and no React warnings beyond
 * the one `renderToStaticMarkup` always emits for `useLayoutEffect`.
 *
 * This is a smoke test, not a snapshot: it asserts properties, so it does not
 * need updating every time a chart's pixels move.
 */
// React warnings are collected rather than printed, so a real one (a bad key,
// an invalid prop) becomes a failing assertion instead of scrollback nobody
// reads. The swap is scoped to beforeAll/afterAll — rendering happens inside
// beforeAll for exactly that reason, so nothing escapes to the real console.
const warnings: string[] = [];
const realError = console.error;
let cases: Array<[string, string]> = [];
/** Every chart in ONE React tree — the condition the real screen creates, and
 * the only one under which `useId` (and therefore `useHatchId`) promises
 * unique ids. Rendering each chart in its own root restarts the id sequence. */
let onePage = "";

const days = (() => {
  const out: Array<{ date: string; status: string }> = [];
  const statuses = ["completed", "rest", "moved", "skipped", "missed", "pending", "none"] as const;
  const start = Date.UTC(2026, 4, 11);
  for (let i = 0; i < 84; i++) {
    const d = new Date(start + i * 86_400_000).toISOString().slice(0, 10);
    out.push({ date: d, status: i > 80 ? "future" : statuses[i % statuses.length]! });
  }
  return out;
})();

const runs = Array.from({ length: 12 }, (_, i) => ({
  activityId: `a${i}`,
  date: new Date(Date.UTC(2026, 5, 1) + i * 5 * 86_400_000).toISOString().slice(0, 10),
  value: 1.1 + Math.sin(i) * 0.08,
}));

/** Name → element. Rendered per-chart for the geometry checks and all
 * together in one tree for the id check — see `onePage`. */
function chartElements(): Array<[string, ReactElement]> {
  return [
    [
      "RunSeriesChart",
      createElement(RunSeriesChart, {
        points: runs,
        unit: "m/beat",
        seriesLabel: "Aerobic efficiency",
        band: { y1: 0, y2: 5 },
        zeroLine: true,
        onPointClick: () => undefined,
      }),
    ],
    [
      "RunSeriesChart(single point)",
      createElement(RunSeriesChart, {
        points: [runs[0]!],
        unit: "m/beat",
        seriesLabel: "Aerobic efficiency",
      }),
    ],
    [
      "WeeklyDurationChart",
      createElement(WeeklyDurationChart, {
        weeks: [
          { weekStart: "2026-06-01", lowSeconds: 14_400, highSeconds: 0 },
          { weekStart: "2026-06-08", lowSeconds: 0, highSeconds: 0 },
          { weekStart: "2026-06-15", lowSeconds: 18_000, highSeconds: 60 },
          { weekStart: "2026-06-22", lowSeconds: 12_600, highSeconds: 3600, partial: true },
        ],
        avgSeconds: 16_200,
        avgLabel: "4-wk avg",
      }),
    ],
    [
      "ConsistencyHeatmap",
      createElement(ConsistencyHeatmap, { days: days as never, onDayClick: () => undefined }),
    ],
    [
      "OutcomeBar",
      createElement(OutcomeBar, {
        completed: 48,
        moved: 6,
        pending: 2,
        skipped: 4,
        missed: 1,
        planned: 63,
      }),
    ],
    [
      "LapHrBars",
      createElement(LapHrBars, {
        laps: [
          { lapIndex: 1, avgHr: 142 },
          { lapIndex: 2, avgHr: 151 },
          { lapIndex: 3, avgHr: 158, over: true },
          { lapIndex: 4, avgHr: 155 },
        ],
        threshold: { value: 155, unit: "bpm" },
      }),
    ],
    [
      "LapHrBars(no threshold)",
      createElement(LapHrBars, {
        laps: [
          { lapIndex: 1, avgHr: 142 },
          { lapIndex: 2, avgHr: 142 },
        ],
      }),
    ],
    [
      "DivergingPaceBars",
      createElement(DivergingPaceBars, {
        runs: [
          { activityId: "a", date: "2026-06-02", deltaSecPerKm: -8 },
          { activityId: "b", date: "2026-06-09", deltaSecPerKm: 14 },
          { activityId: "c", date: "2026-06-16", deltaSecPerKm: 0 },
        ],
      }),
    ],
    [
      "BaselineBandChart",
      createElement(BaselineBandChart, {
        series: Array.from({ length: 60 }, (_, i) => ({
          date: new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10),
          value: 48 + Math.sin(i / 4) * 3,
        })),
        baseline: 48,
        band: { lo: 44, hi: 52 },
        unit: "ms",
        seriesLabel: "HRV",
      }),
    ],
    [
      // loadRatio's drilldown: the same chart with a sub-10 baseline, which is
      // why the screen passes `decimals` — at the default 0 this entire chart
      // reads "1 to 1 around a baseline of 1".
      "BaselineBandChart(loadRatio)",
      createElement(BaselineBandChart, {
        series: Array.from({ length: 56 }, (_, i) => ({
          date: new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10),
          value: 1 + Math.sin(i / 5) * 0.25,
        })),
        baseline: 1,
        band: { lo: 0.8, hi: 1.3 },
        unit: "× norm",
        decimals: 2,
        seriesLabel: "Load vs your norm",
      }),
    ],
  ];
}

function renderAll(): Array<[string, string]> {
  return chartElements().map(([name, el]) => [name, render(el)]);
}

describe("chart rendering smoke", () => {
  beforeAll(() => {
    console.error = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    cases = renderAll();
    onePage = render(
      createElement(
        Fragment,
        null,
        ...chartElements().map(([name, el]) => createElement(Fragment, { key: name }, el)),
      ),
    );
  });
  afterAll(() => {
    console.error = realError;
  });

  it("renders finite geometry for every chart", () => {
    expect(cases.length).toBeGreaterThan(5);
    for (const [name, html] of cases) {
      expect(html, name).not.toMatch(/NaN|Infinity|undefined/);
      expect(html, name).toContain("<svg");
    }
  });

  it("never emits an SVG <title> (tooltips are the HTML overlay, not <title>)", () => {
    for (const [name, html] of cases) {
      expect(html, name).not.toContain("<title>");
    }
  });

  it("gives every hatch pattern on one page a distinct id", () => {
    const ids = [...onePage.matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]!);
    // WeeklyDurationChart (partial weeks) + OutcomeBar (moved, skipped).
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(ids.length);
    // Every reference must resolve to a pattern that is actually on the page.
    const refs = [...onePage.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ids).toContain(ref);
  });

  it("raises no React warnings (bad keys, invalid props) beyond the SSR useLayoutEffect notice", () => {
    expect(warnings.filter((w) => !w.includes("useLayoutEffect"))).toEqual([]);
  });

  it("calls LapHrBars' no-threshold centre line a median, never a ceiling", () => {
    // Without a threshold the bars diverge from the run's OWN median lap.
    // Naming that a "ceiling" in the accessible name invented a standard the
    // runner was never measured against — and contradicted the visible
    // summary, which already said median.
    const html = cases.find(([name]) => name === "LapHrBars(no threshold)")![1];
    expect(html).toContain("median");
    expect(html).not.toContain("ceiling");
  });

  it("still calls LapHrBars' thresholded centre line an easy ceiling", () => {
    const html = cases.find(([name]) => name === "LapHrBars")![1];
    expect(html).toContain("easy ceiling");
    expect(html).not.toContain("median");
  });

  it("renders loadRatio's baseline band at two decimals, not a collapsed 1-to-1", () => {
    const html = cases.find(([name]) => name === "BaselineBandChart(loadRatio)")![1];
    expect(html).toContain("0.80");
    expect(html).toContain("1.30");
    expect(html).toContain("baseline 1.00");
  });
});

describe("TrendChip", () => {
  const chip = (pct: number, betterWhen: "up" | "down" = "up"): string =>
    render(createElement(TrendChip, { pct, betterWhen }));

  it("treats a sub-0.05% move as flat: neutral pill, – glyph, 'no change'", () => {
    // The chip prints one decimal, so 0.004% renders as "0.0%" — a green ▲
    // beside that is a claim of improvement the number doesn't make.
    const html = chip(0.004);
    expect(html).toContain("pill-neutral");
    expect(html).toContain("–");
    expect(html).toContain("no change");
    expect(html).not.toContain("▲");
    expect(html).not.toContain("pill-ok");
  });

  it("treats a sub-0.05% NEGATIVE move as flat too", () => {
    const html = chip(-0.02);
    expect(html).toContain("pill-neutral");
    expect(html).toContain("no change");
    expect(html).not.toContain("▼");
  });

  it("still calls 0.05% itself a real move (the boundary is inclusive)", () => {
    const html = chip(0.05);
    expect(html).toContain("▲");
    expect(html).toContain("pill-ok");
    expect(html).toContain("improved");
  });

  it("keeps direction and valence for a clearly non-flat move", () => {
    expect(chip(3.2, "up")).toContain("pill-ok");
    expect(chip(3.2, "down")).toContain("pill-danger");
    expect(chip(-3.2, "up")).toContain("pill-danger");
    expect(chip(-3.2, "down")).toContain("pill-ok");
  });
});
