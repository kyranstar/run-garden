import { createElement } from "react";
import { renderToStaticMarkup as render } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  BaselineBandChart,
  ConsistencyHeatmap,
  DivergingPaceBars,
  LapHrBars,
  OutcomeBar,
  RunSeriesChart,
  WeeklyDurationChart,
} from "../src/charts.js";

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
// Installed before the renders below (which run at module load) and restored
// by the last test — collected rather than printed, so a real React warning
// becomes a failing assertion instead of scrollback nobody reads.
const warnings: string[] = [];
const realError = console.error;
console.error = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
};
const renderToStaticMarkup = render;

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

const cases: Array<[string, string]> = [
  [
    "RunSeriesChart",
    renderToStaticMarkup(
      createElement(RunSeriesChart, {
        points: runs,
        unit: "m/beat",
        seriesLabel: "Aerobic efficiency",
        band: { y1: 0, y2: 5 },
        zeroLine: true,
        onPointClick: () => undefined,
      }),
    ),
  ],
  [
    "RunSeriesChart(single point)",
    renderToStaticMarkup(
      createElement(RunSeriesChart, {
        points: [runs[0]!],
        unit: "m/beat",
        seriesLabel: "Aerobic efficiency",
      }),
    ),
  ],
  [
    "WeeklyDurationChart",
    renderToStaticMarkup(
      createElement(WeeklyDurationChart, {
        weeks: [
          { weekStart: "2026-06-01", lowSeconds: 14_400, highSeconds: 0 },
          { weekStart: "2026-06-08", lowSeconds: 0, highSeconds: 0 },
          { weekStart: "2026-06-15", lowSeconds: 18_000, highSeconds: 60 },
          { weekStart: "2026-06-22", lowSeconds: 12_600, highSeconds: 3600, partial: true },
        ],
        avgSeconds: 16_200,
      }),
    ),
  ],
  [
    "ConsistencyHeatmap",
    renderToStaticMarkup(
      createElement(ConsistencyHeatmap, { days: days as never, onDayClick: () => undefined }),
    ),
  ],
  [
    "OutcomeBar",
    renderToStaticMarkup(
      createElement(OutcomeBar, {
        completed: 48,
        moved: 6,
        pending: 2,
        skipped: 4,
        missed: 1,
        planned: 63,
      }),
    ),
  ],
  [
    "LapHrBars",
    renderToStaticMarkup(
      createElement(LapHrBars, {
        laps: [
          { lapIndex: 1, avgHr: 142 },
          { lapIndex: 2, avgHr: 151 },
          { lapIndex: 3, avgHr: 158, over: true },
          { lapIndex: 4, avgHr: 155 },
        ],
        threshold: { value: 155, unit: "bpm" },
      }),
    ),
  ],
  [
    "LapHrBars(no threshold)",
    renderToStaticMarkup(
      createElement(LapHrBars, {
        laps: [
          { lapIndex: 1, avgHr: 142 },
          { lapIndex: 2, avgHr: 142 },
        ],
      }),
    ),
  ],
  [
    "DivergingPaceBars",
    renderToStaticMarkup(
      createElement(DivergingPaceBars, {
        runs: [
          { activityId: "a", date: "2026-06-02", deltaSecPerKm: -8 },
          { activityId: "b", date: "2026-06-09", deltaSecPerKm: 14 },
          { activityId: "c", date: "2026-06-16", deltaSecPerKm: 0 },
        ],
      }),
    ),
  ],
  [
    "BaselineBandChart",
    renderToStaticMarkup(
      createElement(BaselineBandChart, {
        series: Array.from({ length: 60 }, (_, i) => ({
          date: new Date(Date.UTC(2026, 5, 1) + i * 86_400_000).toISOString().slice(0, 10),
          value: 48 + Math.sin(i / 4) * 3,
        })),
        baseline: 48,
        bandPct: 8,
        unit: "ms",
        seriesLabel: "HRV",
      }),
    ),
  ],
];

describe("chart rendering smoke", () => {
  for (const [name, html] of cases) {
    it(`${name} renders finite geometry`, () => {
      expect(html).not.toMatch(/NaN|Infinity|undefined/);
      expect(html).toContain("<svg");
    });
  }

  it("never emits an SVG <title> (tooltips are the HTML overlay, not <title>)", () => {
    for (const [name, html] of cases) {
      expect(html, name).not.toContain("<title>");
    }
  });

  it("gives every hatch pattern on one page a distinct id", () => {
    const ids = [...cases.map(([, h]) => h).join("").matchAll(/<pattern id="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("raises no React warnings (bad keys, invalid props) beyond the SSR useLayoutEffect notice", () => {
    console.error = realError;
    expect(warnings.filter((w) => !w.includes("useLayoutEffect"))).toEqual([]);
  });
});
