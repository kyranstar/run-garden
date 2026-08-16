/**
 * The invariant behind a measured regression: **a chart's text never lands on
 * a chart's data.**
 *
 * What went wrong. Charts used to build a fixed 560-unit viewBox that CSS then
 * scaled to the container, so a phone got the desktop picture at 0.58× —
 * illegible, but never overlapping. The sizing layer made the viewBox equal the
 * container, which fixed legibility (every label is now exactly
 * `CHART_LABEL_PX` CSS px) and created a new problem nobody measured: the plot
 * shrinks with the container and the type does not. `ReferenceLine` printed its
 * label INSIDE the plot, right-aligned at the end of the line. "4-wk avg 2.8h"
 * is 66px wide — 12% of a 560px chart and 20% of a 324px phone one — and on a
 * phone it covered the last two bars of a rising-load chart, which is exactly
 * where the tallest bars are.
 *
 * So the assertion here is not "these pixels": it is that the boxes of the two
 * populations are disjoint. Text boxes are estimated GENEROUSLY (0.62em per
 * glyph against a real ~0.50em, a full em of ascent against Chrome's measured
 * 1.0, 0.3em of descent against 0.2) so the test errs toward failing.
 *
 * Two things this cannot see, and how they are covered:
 *  - Real font metrics. There is no DOM in this suite. A browser sweep over
 *    containers 300…1200 measured `getBoundingClientRect()` on every text and
 *    every mark of every chart and found zero intersections.
 *  - Narrow widths. A server render always reports the design-width fallback
 *    (`chartWidth(null, cap)`), so every chart here is built at its cap. That
 *    is enough, and it is the point of the fix: annotations live in a strip
 *    whose geometry (`CHART_HEADER_H`) does not depend on the width at all, so
 *    a violation at any width is a violation at the cap. `the header row still
 *    fits at the narrowest chart` below covers the one thing that DOES vary.
 */
import { createElement } from "react";
import type { ReactElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
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
import { PlannedVsActualBars, ProgressionStepChart } from "../src/screens/plan-charts.js";
import {
  CHART_HEADER_H,
  CHART_LABEL_PX,
  CHART_MIN_WIDTH,
  CHART_STRIP_X,
  referenceLabelWidth,
} from "../src/chart-kit.js";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

// ── Boxes ───────────────────────────────────────────────────────────────────

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Deliberately fat. Chrome measures these labels at ~0.50em per glyph, 1.0em
 * of ascent and 0.2em of descent; over-estimating can only turn a real pass
 * into a failure, never the reverse.
 */
const GLYPH_W = 0.62 * CHART_LABEL_PX;
const ASCENT = 1.0 * CHART_LABEL_PX;
const DESCENT = 0.3 * CHART_LABEL_PX;

function textBox(t: { x: number; y: number; anchor: string; text: string }, ascent = ASCENT): Box {
  const w = t.text.length * GLYPH_W;
  const x = t.anchor === "end" ? t.x - w : t.anchor === "middle" ? t.x - w / 2 : t.x;
  return { x, y: t.y - ascent, w, h: ascent + DESCENT };
}

/**
 * Clipping is measured against the INK, not the em box. Overlap errs fat on
 * purpose — a false failure there costs a nudge — but the top of an em box is
 * empty space above the caps (Chrome measures these labels' cap height at
 * ~0.72em), and counting it as ink would fail a label that is comfortably
 * inside its canvas. 0.8em is still above every ascender this layer prints.
 *
 * The live case that proves the distinction is worth keeping: `ConsistencyHeatmap`
 * prints May/Jun/Jul/Aug on a baseline of 9 in a 10px font, and Chrome reports
 * `getBBox().y === -1.00` for all four at every container width — a 1-unit
 * EM-BOX overhang above the viewBox. No glyph ink is cut (cap top lands at
 * ~1.8), so measuring the em box here would report a clip that does not exist.
 */
const CLIP_ASCENT = 0.8 * CHART_LABEL_PX;

function intersects(a: Box, b: Box): number {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? Math.min(ox, oy) : 0;
}

// ── A very small SVG reader ─────────────────────────────────────────────────

/** Digits in the NAME, not just the value: `x1`/`y2` are attributes too, and a
 *  letters-only class silently reported every one of them as absent. */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

const num = (v: string | undefined, fallback = 0) => (v == null ? fallback : Number(v));

/** The chart's own SVG — not a legend swatch, which is a few units wide. */
function chartSvg(html: string): string {
  const svgs = [...html.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/g)].map((m) => m[0]);
  const scored = svgs.map((s) => ({ s, w: Number((attrs(s.slice(0, s.indexOf(">")))["viewBox"] ?? "0 0 0 0").split(" ")[2]) }));
  scored.sort((a, b) => b.w - a.w);
  expect(scored[0], "no <svg> in this chart").toBeDefined();
  return scored[0]!.s;
}

/** `<defs>` holds the hatch pattern — a template, not a mark on the canvas. */
const withoutDefs = (svg: string) => svg.replace(/<defs\b[\s\S]*?<\/defs>/g, "");

function texts(svg: string) {
  return [...withoutDefs(svg).matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((m) => {
    const a = attrs(m[1]!);
    const text = m[2]!.replace(/<!--[\s\S]*?-->/g, "").trim();
    return { x: num(a["x"]), y: num(a["y"]), anchor: a["text-anchor"] ?? "start", text };
  });
}

/**
 * Every stroked `<line>`. The grid, the axis rules, a reference line and the
 * swatch that keys it are all one element type, told apart only by the two
 * attributes below — which is exactly the confusion this reads for.
 */
function lines(svg: string) {
  return [...withoutDefs(svg).matchAll(/<line\b([^>]*?)\/?>/g)].map((m) => {
    const a = attrs(m[1]!);
    return {
      stroke: a["stroke"] ?? "",
      width: num(a["stroke-width"], 1),
      x1: num(a["x1"]),
      y1: num(a["y1"]),
      y2: num(a["y2"]),
    };
  });
}

/**
 * Every VISIBLE mark. A transparent circle is a touch target (`.chart-hit`),
 * not a mark, and text may sit on one — that is what a hit target is for.
 */
function marks(svg: string): Array<{ tag: string; box: Box }> {
  const out: Array<{ tag: string; box: Box }> = [];
  for (const m of withoutDefs(svg).matchAll(/<(circle|rect|path)\b([^>]*?)\/?>/g)) {
    const tag = m[1]!;
    const a = attrs(m[2]!);
    const fill = a["fill"] ?? "";
    if (fill === "transparent" || fill === "none") continue;
    if ((a["class"] ?? "").includes("chart-hit")) continue;
    if (tag === "circle") {
      const r = num(a["r"]);
      out.push({ tag, box: { x: num(a["cx"]) - r, y: num(a["cy"]) - r, w: 2 * r, h: 2 * r } });
    } else if (tag === "rect") {
      out.push({ tag, box: { x: num(a["x"]), y: num(a["y"]), w: num(a["width"]), h: num(a["height"]) } });
    } else {
      out.push({ tag, box: pathBox(a["d"] ?? "") });
    }
  }
  return out;
}

/**
 * Exact for the paths this layer draws: `charts-math` emits only M/L/Q/Z, whose
 * every number is half of an (x, y) pair, and a quadratic's control point is
 * the corner it rounds — inside the box either way. An H/V/A would silently
 * break the pairing, so this throws instead of measuring the wrong thing.
 */
function pathBox(d: string): Box {
  const commands = d.match(/[A-Za-z]/g) ?? [];
  const unsupported = commands.filter((c) => !"MLQZmlqz".includes(c));
  if (unsupported.length) throw new Error(`pathBox cannot measure "${unsupported.join("")}" in ${d}`);
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (n.length === 0 || n.length % 2 !== 0) throw new Error(`odd coordinate count in ${d}`);
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys),
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const iso = (base: number, i: number, stepDays = 1) =>
  new Date(base + i * stepDays * 86_400_000).toISOString().slice(0, 10);

/**
 * A RISING load, because that is the shape the defect hid behind: the tallest
 * bars are at the right, under a label the old code right-aligned at the right
 * end of its line. A flat fixture passes the broken code.
 */
const weeks = Array.from({ length: 12 }, (_, i) => ({
  weekStart: iso(Date.UTC(2026, 3, 6), i, 7),
  lowSeconds: 2400 + i * 420,
  highSeconds: i % 3 === 0 ? 900 + i * 60 : 300,
  ...(i === 11 ? { partial: true } : {}),
}));
const avgSeconds = Math.round(weeks.reduce((a, w) => a + w.lowSeconds + w.highSeconds, 0) / weeks.length);

const laps = Array.from({ length: 10 }, (_, i) => ({
  lapIndex: i + 1,
  avgHr: 148 + Math.round(Math.sin(i / 1.5) * 9) + i,
}));

const daily = Array.from({ length: 70 }, (_, i) => ({ date: iso(Date.UTC(2026, 2, 1), i), value: 46 + Math.round(Math.sin(i / 3) * 6) }));

/** A 12-week build that PEAKS ON A ROUND NUMBER (20), so `niceTicks` puts the
 *  peak exactly on the top gridline — the case that used to clip its callout. */
const runProg = {
  key: "run:long-run",
  label: "Long run",
  unit: "km",
  from: 11,
  to: 20,
  now: 16,
  series: Array.from({ length: 12 }, (_, i) => ({
    week: i + 1,
    value: [11, 12, 13, 12, 14, 15, 16, 17, 18, 20, 14, 10][i]!,
    ...(i < 8 ? { done: true } : {}),
  })),
};

/** Two weeks is the shortest series that draws at all — and the case where the
 *  two callouts have the fewest places to go. */
const liftProg = {
  key: "lift:bench",
  label: "Bench Press",
  unit: "kg",
  from: 60,
  to: 62.5,
  now: 62.5,
  series: [
    { week: 1, value: 60, done: true },
    { week: 2, value: 62.5, done: true },
  ],
};

const minutesProg = {
  key: "run:weekly-minutes",
  label: "Weekly time",
  unit: "min",
  from: 284,
  to: 258,
  now: 258,
  series: Array.from({ length: 12 }, (_, i) => ({
    week: i + 1,
    value: i % 2 === 0 ? 284 : 258,
    // Real, non-zero filled bars from week 1 on: the first bar is the one that
    // used to straddle the y axis and sit on its tick labels.
    ...(i < 9 ? { actual: 250 + i * 4 } : {}),
    ...(i < 6 ? { done: true } : {}),
  })),
};

const CHARTS: Array<[string, ReactElement]> = [
  [
    "WeeklyDurationChart",
    createElement(WeeklyDurationChart, { weeks, avgSeconds, avgLabel: "4-wk avg" }),
  ],
  [
    "RunSeriesChart(zeroLine)",
    createElement(RunSeriesChart, {
      points: Array.from({ length: 14 }, (_, i) => ({
        activityId: `d${i}`,
        date: iso(Date.UTC(2026, 4, 1), i, 4),
        value: -1 + i * 0.9,
      })),
      unit: "%",
      seriesLabel: "Decoupling",
      decimals: 1,
      band: { y1: 0, y2: 5 },
      zeroLine: true,
      onPointClick: () => undefined,
    }),
  ],
  [
    "RunSeriesChart",
    createElement(RunSeriesChart, {
      points: Array.from({ length: 14 }, (_, i) => ({
        activityId: `a${i}`,
        date: iso(Date.UTC(2026, 4, 1), i, 4),
        value: 1.5 + Math.sin(i / 2) * 0.9,
      })),
      unit: "m/beat",
      seriesLabel: "Aerobic efficiency",
    }),
  ],
  [
    "BaselineBandChart",
    createElement(BaselineBandChart, {
      series: daily,
      baseline: 46,
      band: { lo: 41, hi: 51 },
      unit: "bpm",
      seriesLabel: "Resting heart rate",
      title: "Daily readings",
    }),
  ],
  ["LapHrBars(ceiling)", createElement(LapHrBars, { laps, threshold: { value: 155, unit: "bpm" } })],
  ["LapHrBars(median)", createElement(LapHrBars, { laps })],
  [
    "DivergingPaceBars",
    createElement(DivergingPaceBars, {
      runs: Array.from({ length: 8 }, (_, i) => ({
        activityId: `p${i}`,
        date: iso(Date.UTC(2026, 4, 1), i, 6),
        deltaSecPerKm: [-12, 6, 0, 18, -3, 9, -21, 4][i]!,
      })),
    }),
  ],
  [
    "OutcomeBar",
    createElement(OutcomeBar, { completed: 48, moved: 6, pending: 2, skipped: 4, missed: 1, planned: 63 }),
  ],
  [
    "ConsistencyHeatmap",
    createElement(ConsistencyHeatmap, {
      days: Array.from({ length: 84 }, (_, i) => ({
        date: iso(Date.UTC(2026, 4, 11), i),
        status: (["completed", "rest", "moved", "skipped", "missed", "pending", "none"] as const)[i % 7]!,
      })) as never,
    }),
  ],
  // ── The plan layer ────────────────────────────────────────────────────────
  // Second chart layer, same invariant. Its fixtures are chosen the same way
  // the weekly one was — for the shapes the defect hid behind:
  //  - a RACE WEEK at the end of the span, because that is where the race
  //    line's label used to be centred, i.e. half of it outside the viewBox;
  //  - a peak whose value IS the top tick, because the peak's callout then had
  //    to be drawn above the plot's own top edge;
  //  - a bar chart whose first bar sits on the y axis, where week 1's bar used
  //    to be drawn straddling the tick labels.
  ["ProgressionStepChart(lift)", createElement(ProgressionStepChart, { progression: liftProg, discipline: "lift" })],
  [
    "ProgressionStepChart(race)",
    createElement(ProgressionStepChart, {
      progression: runProg,
      discipline: "run",
      raceWeek: 12,
      raceLabel: "race · Aug 24",
    }),
  ],
  [
    "PlannedVsActualBars(race)",
    createElement(PlannedVsActualBars, {
      progression: minutesProg,
      raceWeek: 12,
      raceLabel: "race · Aug 24",
    }),
  ],
];

/** Rendered once. The console swap eats the `useLayoutEffect` notice that
 *  `renderToStaticMarkup` emits for every chart (they all use the tooltip
 *  hook); `render-smoke.test.ts` is the suite that polices React warnings. */
const rendered = (() => {
  const realError = console.error;
  console.error = () => {};
  try {
    return CHARTS.map(([name, el]) => [name, chartSvg(renderToStaticMarkup(el))] as const);
  } finally {
    console.error = realError;
  }
})();

/** Every chart that names a reference line in its header strip, and the label. */
const LABELLED: Array<[string, RegExp]> = [
  ["WeeklyDurationChart", /^4-wk avg /],
  ["RunSeriesChart(zeroLine)", /^0$/],
  ["BaselineBandChart", /^baseline /],
  ["LapHrBars(ceiling)", /ceiling$/],
  ["LapHrBars(median)", /median$/],
  // A VERTICAL reference line's label lives in the same strip, for a
  // sharper version of the same reason: race week is the last week, so a
  // label centred on the line was centred on the plot's right edge.
  ["ProgressionStepChart(race)", /^race · /],
  ["PlannedVsActualBars(race)", /^race · /],
];

// ── The invariant ───────────────────────────────────────────────────────────

describe("a chart's text never lands on a chart's data", () => {
  for (const [name, svg] of rendered) {
    it(`${name}: no label overlaps any mark`, () => {
      const ts = texts(svg);
      const ms = marks(svg);
      // OutcomeBar is the one chart whose labels are HTML below the bar, so it
      // has marks and no text. Every other chart must have both, and the total
      // across the suite is asserted below so a broken parser can't pass by
      // finding nothing anywhere.
      expect(ms.length, "nothing to check — the fixture rendered no marks").toBeGreaterThan(0);
      const collisions = ts.flatMap((t) => {
        const tb = textBox(t);
        return ms
          .filter((m) => intersects(tb, m.box) > 0)
          .map((m) => `"${t.text}" (${tb.x.toFixed(1)},${tb.y.toFixed(1)} ${tb.w.toFixed(1)}×${tb.h.toFixed(1)}) over <${m.tag}> at ${m.box.x.toFixed(1)},${m.box.y.toFixed(1)}`);
      });
      expect(collisions).toEqual([]);
    });
  }

  it("the parser actually finds text (a silent zero would pass everything)", () => {
    expect(rendered.reduce((a, [, svg]) => a + texts(svg).length, 0)).toBeGreaterThan(40);
  });

  it("a reference line's label prints in the header strip, not over the plot", () => {
    // The specific geometry the regression broke: the label used to sit at the
    // reference line's own y, which is wherever the data put it.
    for (const [chart, pattern] of LABELLED) {
      const svg = rendered.find(([n]) => n === chart)![1];
      const found = texts(svg).filter((x) => pattern.test(x.text));
      expect(found.length, `${chart} should print exactly one ${pattern} label`).toBe(1);
      const t = found[0]!;
      // Baseline in the strip, whole box clear of the plot's top edge.
      expect(t.y, chart).toBeLessThan(CHART_HEADER_H);
      expect(textBox(t).y + textBox(t).h, chart).toBeLessThanOrEqual(CHART_HEADER_H);
      expect(textBox(t).y, `${chart} label is clipped by the top of the viewBox`).toBeGreaterThanOrEqual(0);
    }
  });

  it("a reference line is drawn heavier than the grid it must be picked out from", () => {
    /**
     * The strip only works if the reader can FIND the line it names. There
     * used to be an `emphasis` flag, defaulting to false, that drew a
     * reference line in the grid token at grid weight — and the one caller
     * that left it at the default was `BaselineBandChart`, whose baseline then
     * sat inside a shaded band looking exactly like the gridlines around it
     * while the strip printed "baseline 46" and a swatch in that same
     * invisible stroke. Measured in Chrome afterwards: 2 gridlines at
     * `var(--chart-grid)` 1, the reference line and its swatch at
     * `var(--ink-faint)` 1.5.
     */
    for (const [chart] of LABELLED) {
      const ls = lines(rendered.find(([n]) => n === chart)![1]);
      const grid = ls.filter((l) => l.stroke === "var(--chart-grid)");
      const reference = ls.filter((l) => l.stroke !== "var(--chart-grid)");
      // The line itself plus the swatch that keys it, in the same stroke.
      expect(reference.length, `${chart}: no line distinguishable from the grid`).toBeGreaterThanOrEqual(2);
      const weights = [...new Set(reference.map((l) => l.width))];
      expect(weights, `${chart}: reference marks disagree about their weight`).toEqual([1.5]);
      for (const g of grid)
        expect(g.width, `${chart}: a gridline at ${g.width} is as heavy as the reference`).toBeLessThan(1.5);
      // …and the swatch is drawn in the line's exact stroke, or it keys
      // nothing. (Both are non-grid, so one distinct value across the set.)
      expect([...new Set(reference.map((l) => l.stroke))], chart).toHaveLength(1);
    }
  });

  it("the reference strip and the series legend start at the same left edge", () => {
    // Two keys on two left margins read as two unrelated things — and the
    // reference strip, at 10px under a 13px HTML legend, read as a caption for
    // something else. It used to start at the PLOT's left edge (M.left, 40);
    // the legend starts at the card's. One origin now, and it is the card's.
    expect(CHART_STRIP_X).toBe(0);
    for (const [chart, pattern] of LABELLED) {
      const svg = rendered.find(([n]) => n === chart)![1];
      const t = texts(svg).find((x) => pattern.test(x.text))!;
      // Swatch at the origin, label one swatch-plus-gap along. `referenceLabelWidth`
      // owns those two numbers, so ask it rather than restating them.
      expect(t.anchor, chart).toBe("start");
      expect(t.x, chart).toBe(CHART_STRIP_X + referenceLabelWidth("") );
      const swatch = lines(svg).filter((l) => l.stroke !== "var(--chart-grid)" && l.y1 < CHART_HEADER_H);
      expect(swatch.length, `${chart}: no swatch in the strip`).toBe(1);
      // A horizontal swatch starts at the origin; a vertical one is centred on it.
      expect(swatch[0]!.x1, chart).toBeGreaterThanOrEqual(CHART_STRIP_X);
      expect(swatch[0]!.x1, chart).toBeLessThan(CHART_STRIP_X + referenceLabelWidth(""));
    }
    // …and the HTML legend really does sit at the card's edge, so 0 is the
    // same x for both.
    const legend = css.slice(css.indexOf("\n.chart-legend {"), css.indexOf("}", css.indexOf("\n.chart-legend {")));
    expect(legend).not.toMatch(/(?:margin|padding)(?:-left|-inline-start)?:/);
  });

  it("a bar's length is its value: the planned-vs-done axis starts at zero", () => {
    /**
     * `Weekly time — planned vs done` opened on a y axis starting at 100, so
     * every bar was drawn missing its first 100 minutes. That is not a style
     * choice — it is the classic way a bar chart lies: on the truncated axis a
     * 250-minute week was 24% of the height of a 282-minute one; honestly it
     * is 89%. Line progressions may still crop (a position, not a length) —
     * `ProgressionStepChart` is deliberately not in here.
     */
    const svg = rendered.find(([n]) => n === "PlannedVsActualBars(race)")![1];
    const ticks = texts(svg).filter((t) => t.anchor === "end" && t.y > CHART_HEADER_H);
    expect(ticks.map((t) => t.text), "the axis must show its zero").toContain("0");
    // The filled bars are the actuals, in week order — 250, 254, … 282.
    const actual = minutesProg.series.flatMap((p) => (p.actual === undefined ? [] : [p.actual]));
    const bars = [...svg.matchAll(/<rect\b([^>]*?)\/?>/g)]
      .map((m) => attrs(m[1]!))
      .filter((a) => a["fill"] === "var(--chart-1)")
      .map((a) => Number(a["height"]));
    expect(bars.length, "fixture drew no filled bars").toBe(actual.length);
    // Height is proportional to value, which is only true from a zero origin.
    const perUnit = bars.map((h, i) => h / actual[i]!);
    for (const r of perUnit) expect(r).toBeCloseTo(perUnit[0]!, 6);
    // The zero tick's own gridline is where the bars stand.
    const zeroTick = ticks.find((t) => t.text === "0")!;
    const bottoms = [...svg.matchAll(/<rect\b([^>]*?)\/?>/g)]
      .map((m) => attrs(m[1]!))
      .filter((a) => a["fill"] === "var(--chart-1)")
      .map((a) => Number(a["y"]) + Number(a["height"]));
    for (const b of bottoms) expect(b).toBeCloseTo(zeroTick.y - 3.5, 6);
  });

  it("no label is clipped by its own viewBox", () => {
    // The other half of "text never lands on data": text that leaves the
    // canvas. `race · Aug 24` was centred on the race line, race week is the
    // last week, and the last week is the plot's right edge — so the label was
    // cut in half at every width the layer produces (49 clipped labels in a
    // browser sweep of 56 chart renders).
    for (const [name, svg] of rendered) {
      const vb = (attrs(svg.slice(0, svg.indexOf(">")))["viewBox"] ?? "0 0 0 0").split(" ").map(Number);
      const [, , w, h] = vb as [number, number, number, number];
      for (const t of texts(svg)) {
        const b = textBox(t, CLIP_ASCENT);
        const where = `${name}: "${t.text}" at ${b.x.toFixed(1)},${b.y.toFixed(1)} ${b.w.toFixed(1)}×${b.h.toFixed(1)} in ${w}×${h}`;
        expect(b.x, where).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w, where).toBeLessThanOrEqual(w);
        expect(b.y, where).toBeGreaterThanOrEqual(0);
        expect(b.y + b.h, where).toBeLessThanOrEqual(h);
      }
    }
  });

  it("the plan charts label the weeks by stride, not just the first and last", () => {
    // They printed exactly two labels — W1 and W12 — at every width, which is
    // a hard-coded stride wearing a different hat. `labelStride` asks how many
    // fit instead: eleven of twelve at the 420 design width, and the sweep in
    // the browser thins them to five in a 300px modal column.
    for (const name of ["ProgressionStepChart(race)", "PlannedVsActualBars(race)"]) {
      const svg = rendered.find(([n]) => n === name)![1];
      const weeks = texts(svg).filter((t) => /^W\d+$/.test(t.text));
      expect(weeks.length, name).toBeGreaterThan(5);
      // …and the first and last week are always among them: the last is the
      // one the reader is counting towards.
      expect(weeks.map((t) => t.text), name).toContain("W1");
      expect(weeks.map((t) => t.text), name).toContain("W12");
    }
  });

  it("the header row still fits at the narrowest chart the layer can build", () => {
    // Only the strip's contents vary with width, and only by moving: the unit
    // is right-aligned and the reference label left-aligned. If their widths
    // sum to more than the plot is wide, they collide — at 240, the floor.
    const innerW = CHART_MIN_WIDTH - 40 - 10;
    for (const [name, svg] of rendered) {
      const header = texts(svg).filter((t) => t.y <= CHART_HEADER_H);
      const used = header.reduce((a, t) => a + textBox(t).w, 0) + 17; // + the swatch and its gap
      expect(used, `${name}: ${header.map((t) => t.text).join(" / ")}`).toBeLessThan(innerW);
    }
  });
});

// ── The token ───────────────────────────────────────────────────────────────

const src = (f: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${f}`, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

/**
 * All THREE files, because the layer is three files. The scan started as
 * charts.tsx only, which is how `fontSize={9.5}` survived in chart-kit's
 * ReferenceLine; it then covered both of those, which is how nine
 * `fontSize="9"` survived in screens/plan-charts.tsx — a whole second chart
 * layer, on the busiest modal in the app, in a 320-unit viewBox CSS then scaled
 * to the container. Measured in Chrome those nine labels rendered at 8.4 CSS px
 * in the two-column modal and 33.8 in a wide one.
 */
const LAYER_FILES = ["charts.tsx", "chart-kit.tsx", "screens/plan-charts.tsx"];

describe("one type size for the whole chart layer", () => {
  for (const file of LAYER_FILES) {
    it(`${file} declares no raw font size`, () => {
      expect([...src(file).matchAll(/fontSize=\{[\d.]+\}/g)].map((m) => m[0])).toEqual([]);
      expect([...src(file).matchAll(/fontSize="[^"]*"/g)].map((m) => m[0])).toEqual([]);
    });
  }

  it("every font size in the layer IS the token", () => {
    const all = LAYER_FILES.flatMap((f) => [...src(f).matchAll(/fontSize=\S+/g)]);
    expect(all.length).toBeGreaterThan(15);
    for (const m of all) expect(m[0]).toBe("fontSize={CHART_LABEL_PX}");
  });
});
