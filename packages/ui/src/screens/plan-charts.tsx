import type { PlanProgression } from "@rg/api-client";
import { useRef } from "react";
import { ChartFrame } from "../charts.js";
import {
  CHART_HEADER_BASELINE,
  CHART_HEADER_H,
  CHART_LABEL_PX,
  CHART_STRIP_X,
  GridLines,
  VerticalReferenceLine,
  chartWidth,
  labelStride,
  labelWidth,
  niceTicks,
  referenceLabelWidth,
  svgStyle,
  useMeasuredWidth,
} from "../chart-kit.js";

const KM_PER_MI = 1.609344;
/** Distance progressions render in the athlete's display units; non-distance
 * units (kg, min, reps) pass through untouched (units sweep 2026-08-14). */
export function progressionInUnits(p: PlanProgression, units: "km" | "mi"): PlanProgression {
  if ((p.unit !== "km" && p.unit !== "mi") || p.unit === units) return p;
  const f = p.unit === "mi" ? KM_PER_MI : 1 / KM_PER_MI;
  const c = (v: number) => Math.round(v * f * 10) / 10;
  return {
    ...p,
    unit: units,
    from: c(p.from),
    to: c(p.to),
    now: p.now === null ? null : c(p.now),
    series: p.series.map((pt) => ({ ...pt, value: c(pt.value), ...(pt.actual !== undefined ? { actual: c(pt.actual) } : {}) })),
  };
}


/**
 * Progression charts for the studio modal (rework spec §7). Honest by
 * construction: lift series are the PRESCRIPTION drawn as steps with
 * completed sessions dotted on it (COROS sends no actual bar weights);
 * run series are planned values, with actual minutes overlaid when known.
 *
 * These are the SECOND chart layer in the app, and until now the only one the
 * sizing layer (System 3 §B) had not reached: a fixed 320-unit viewBox that
 * `width: 100%` then scaled to whatever box the modal gave it. Measured in
 * Chrome, that put its labels at 8.4 CSS px in the two-column modal, 11 px on a
 * 390px phone and 33.8 px in a wide sheet — the same label, three sizes, none
 * of them the one anybody chose. Everything below therefore comes from
 * `chart-kit`: `useMeasuredWidth` → `chartWidth` builds the viewBox at the box's
 * own width (so one unit is one CSS px and `CHART_LABEL_PX` is a real 10px),
 * `GridLines` draws the y axis, `labelStride` thins the week labels by the room
 * they have, and annotations live in the `CHART_HEADER_H` strip above the plot.
 */

/** The design width. Measuring can only make a chart narrower — see chartWidth. */
const CHART_CAP = 420;
const VB_H = 176;
/** No `top`: the plot's top edge is `CHART_HEADER_H`, the annotation strip. */
const M = { right: 10, bottom: 26, left: 40 };

/**
 * Clear air between the strip and the highest data point, so a callout drawn
 * ABOVE the peak (`placeCallout`) always has somewhere to go: one ascent plus
 * the mark's own radius and gap. Without it the peak sits ON the top gridline
 * whenever `niceTicks` lands exactly on it — which is how "peak 20 km" came to
 * be drawn at y=4 in a viewBox starting at 0, i.e. clipped in half.
 */
const CALLOUT_BAND = 21;
const RACE_STROKE = "var(--chart-2)";
const INK_FAINT = "var(--ink-faint)";
const INK_SOFT = "var(--ink-soft)";
const DOT_R = 4;
/** Air between a callout's box and the mark it names. */
const CALLOUT_GAP = 6;
/** The text box this file reasons with — deliberately the same generous
 *  estimate `chart-annotations.test.ts` measures collisions against. */
const ASCENT = CHART_LABEL_PX;
const DESCENT = 0.3 * CHART_LABEL_PX;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function boxOf(cx: number, baseline: number, w: number): Box {
  return { x: cx - w / 2, y: baseline - ASCENT, w, h: ASCENT + DESCENT };
}

function hits(a: Box, b: Box): boolean {
  return (
    Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) &&
    Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y)
  );
}

interface PlanScale {
  x: (week: number) => number;
  y: (v: number) => number;
  ticks: number[];
  wMin: number;
  wMax: number;
  left: number;
  right: number;
  innerW: number;
  /** The plot's top edge — the annotation strip ends here. */
  top: number;
  base: number;
  slot: number;
}

/**
 * Every scale a progression chart needs, built at the width the container
 * actually measured.
 *
 * `bars` says the marks are BARS, and it decides two things at once because
 * they are the same fact about a bar:
 *
 *  - the x band. A line's first point belongs ON the left edge, a bar's first
 *    BAR belongs in the middle of its week's band. Drawn without it, week 1's
 *    bar straddled the axis and sat on top of the y tick labels — two
 *    collisions per bar chart at every width.
 *  - the y ORIGIN. A bar encodes its value as a LENGTH, so its length has to
 *    start at zero or it is not that value any more. `Weekly time — planned vs
 *    done` ran 100…250 min, so `niceTicks` handed back an axis starting at 100
 *    and every bar was drawn missing its first 100 minutes: a 140-minute week
 *    was two fifths the height of a 200-minute one, when it is really seven
 *    tenths. The LINE progressions keep the cropped axis — see the file's
 *    dataviz rules, and the callers' note about which chart is which.
 *  - one more TICK. Anchoring at zero roughly doubles the domain, and three
 *    ticks over a doubled range is a coarser step: 0…250 min asked for a step
 *    of 200 and so an axis running to 400, with the tallest bar filling 62% of
 *    the plot. Four asks for 100 and an axis to 300 — 83%, and still round
 *    numbers. The line charts crop, so their domain never doubled and three
 *    is still right for them.
 */
function scales(progression: PlanProgression, width: number, bars = false): PlanScale {
  const banded = bars;
  const weeks = progression.series.map((p) => p.week);
  const values = progression.series.flatMap((p) => [p.value, ...(p.actual !== undefined ? [p.actual] : [])]);
  const wMin = Math.min(...weeks);
  const wMax = Math.max(...weeks);
  const ticks = niceTicks(
    bars ? Math.min(0, ...values) : Math.min(...values),
    Math.max(...values),
    bars ? 4 : 3,
  );
  const vMin = bars ? 0 : (ticks[0] ?? Math.min(...values));
  const vMax = ticks[ticks.length - 1] ?? Math.max(...values);
  const left = M.left;
  const right = width - M.right;
  const innerW = right - left;
  const top = CHART_HEADER_H;
  const base = VB_H - M.bottom;
  const plotTop = top + CALLOUT_BAND;
  const slot = innerW / (wMax - wMin + 1);
  const inset = banded ? slot / 2 : 0;
  const x = (week: number) =>
    wMax === wMin
      ? left + innerW / 2
      : left + inset + ((week - wMin) / (wMax - wMin)) * (innerW - 2 * inset);
  const y = (v: number) =>
    vMax === vMin
      ? (plotTop + base) / 2
      : base - ((v - vMin) / (vMax - vMin)) * (base - plotTop);
  return { x, y, ticks, wMin, wMax, left, right, innerW, top, base, slot };
}

/**
 * `labelWidth` averages 0.62em per glyph, which is generous for the digits and
 * lowercase the rest of the layer prints and NOT generous for a capital W —
 * Chrome measures one at ~0.94em, so a "W12" is 20.6px against the estimate's
 * 18.6. Every label on this axis starts with one, and the 2px it gives back is
 * the difference between a 4px gap and a 0.55px one (measured, at 390).
 */
const weekLabelWidth = (week: number) => labelWidth(`W${week}`) + 0.32 * CHART_LABEL_PX;

/**
 * Which weeks get a label.
 *
 * The old chart printed exactly two ("W1" and "W12"), which is the same shape
 * of bug as a hard-coded stride: it was tuned for one width and told the reader
 * nothing about the twelve weeks in between at any other. `labelStride` asks
 * how many "W12"s actually fit across the plot instead, and the range is
 * strided rather than the series index — a progression's x is proportional to
 * the WEEK NUMBER, so weeks 1, 2, 3, 20 are not evenly spaced and striding the
 * index would print three labels on top of each other.
 */
function weekTicks(s: PlanScale): number[] {
  const span = s.wMax - s.wMin;
  if (span <= 0) return [s.wMin];
  const need = weekLabelWidth(s.wMax) + 8;
  const stride = labelStride(span + 1, s.x(s.wMax) - s.x(s.wMin), need);
  const out: number[] = [];
  for (let w = s.wMin; w <= s.wMax; w += stride) out.push(w);
  const last = out[out.length - 1]!;
  // The last week is the one the reader is counting towards (it is usually
  // race week), so it always gets a label: appended when there is room for it,
  // otherwise in place of the label that would have crowded it.
  if (last !== s.wMax) {
    if (s.x(s.wMax) - s.x(last) >= need) out.push(s.wMax);
    else out[out.length - 1] = s.wMax;
  }
  return out;
}

/** The minimum air between two week labels. Measured in Chrome across
 *  300…1200px containers: 4 units here is 4 real pixels, now that
 *  `weekLabelWidth` accounts for the W. */
const WEEK_LABEL_GAP = 4;

/**
 * Where each week label actually lands, anchor included. The last label is
 * anchored at its END (a middle anchor on the plot's right edge hangs half the
 * box outside the viewBox), which pushes its box half a label to the right —
 * so the spacing `weekTicks` reasoned about with CENTRES can still come up
 * short here. Whatever it crowds is dropped, never the last week itself.
 */
type Anchor = "start" | "middle" | "end";

function weekLabelBoxes(s: PlanScale): Array<{ week: number; text: string; x: number; anchor: Anchor }> {
  const out: Array<{ week: number; text: string; x: number; anchor: Anchor; x0: number; x1: number }> = [];
  for (const w of weekTicks(s)) {
    const text = `W${w}`;
    const width = weekLabelWidth(w);
    const half = width / 2;
    const anchor: Anchor = s.x(w) + half > s.right ? "end" : s.x(w) - half < 0 ? "start" : "middle";
    const x0 = anchor === "end" ? s.x(w) - width : anchor === "start" ? s.x(w) : s.x(w) - half;
    while (out.length && out[out.length - 1]!.x1 + WEEK_LABEL_GAP > x0) out.pop();
    out.push({ week: w, text, x: s.x(w), anchor, x0, x1: x0 + width });
  }
  return out;
}

function WeekLabels({ s }: { s: PlanScale }) {
  return (
    <g>
      {weekLabelBoxes(s).map((l) => (
        <text
          key={l.week}
          x={l.x}
          y={VB_H - 9}
          textAnchor={l.anchor}
          fontSize={CHART_LABEL_PX}
          fill={INK_FAINT}
        >
          {l.text}
        </text>
      ))}
    </g>
  );
}

/**
 * Race day, when the race week falls inside the charted span (user request,
 * 2026-08-12) — a vertical landmark whose NAME prints in the header strip.
 *
 * It used to print "race · Aug 24" centred on the line itself, one unit above
 * the plot. Race week is the last week of a race plan, so that label was
 * centred on the plot's right edge and clipped by the viewBox at every width
 * the layer produces (measured: 49 clipped labels across the sweep). In the
 * strip it is left-aligned at `CHART_STRIP_X` — the card's edge — behind a
 * dashed vertical swatch in the line's own colour, exactly as a horizontal
 * `ReferenceLine` labels itself — see `VerticalReferenceLine`.
 */
function raceLine(
  s: PlanScale,
  raceWeek: number | null | undefined,
  raceLabel: string | undefined,
): { x: number; label: string } | null {
  if (raceWeek == null || raceWeek < s.wMin || raceWeek > s.wMax) return null;
  return { x: s.x(raceWeek), label: raceLabel ?? "race" };
}

/**
 * The strip holds at most two things: a reference line's name at the left and
 * the series' unit at the right. They are the only two, they never move with
 * the data, and this is where they are checked against each other — a chart
 * that grew a THIRD strip annotation would need a real layout rather than this.
 */
function StripAnnotations({
  s,
  race,
  unit,
}: {
  s: PlanScale;
  race: { x: number; label: string } | null;
  unit: string;
}) {
  // The strip starts at the card's edge (`CHART_STRIP_X`), not the plot's, so
  // the room the unit has left is measured from there too.
  const used = race ? CHART_STRIP_X + referenceLabelWidth(race.label) + 8 : CHART_STRIP_X;
  return (
    <g>
      {race ? (
        <VerticalReferenceLine
          x={race.x}
          y1={s.top}
          y2={s.base}
          label={race.label}
          dashed
          stroke={RACE_STROKE}
        />
      ) : null}
      {used + labelWidth(unit) <= s.right ? (
        <text
          x={s.right}
          y={CHART_HEADER_BASELINE}
          textAnchor="end"
          fontSize={CHART_LABEL_PX}
          fill={INK_FAINT}
        >
          {unit}
        </text>
      ) : null}
    </g>
  );
}

/**
 * A callout for one data point — the peak, the current week — placed where it
 * names its point and touches nothing.
 *
 * Tried above the mark first, then below it; `obstacles` (every drawn dot, plus
 * the callouts already placed) is what it is tried against, and a callout with
 * nowhere to go is DROPPED rather than drawn over the data. Dropping is safe
 * because the number is never only here: the card headline carries start→peak,
 * the prog chip carries "now", and the hidden summary carries both.
 */
function placeCallout(
  text: string,
  px: number,
  py: number,
  s: PlanScale,
  obstacles: Box[],
): { x: number; y: number } | null {
  const w = labelWidth(text);
  if (w >= s.innerW) return null;
  const cx = Math.min(Math.max(px, s.left + w / 2), s.right - w / 2);
  for (const baseline of [py - DOT_R - CALLOUT_GAP, py + DOT_R + CALLOUT_GAP + ASCENT]) {
    const box = boxOf(cx, baseline, w);
    if (box.y < s.top || box.y + box.h > s.base) continue;
    if (obstacles.some((o) => hits(box, o))) continue;
    obstacles.push(box);
    return { x: cx, y: baseline };
  }
  return null;
}

/** A callout's own look: soft ink, and the house halo so a gridline or the
 *  prescription line behind it can't eat the type. */
function Callout({ at, children }: { at: { x: number; y: number }; children: string }) {
  return (
    <text
      x={at.x}
      y={at.y}
      textAnchor="middle"
      fontSize={CHART_LABEL_PX}
      fontWeight="600"
      fill={INK_SOFT}
      paintOrder="stroke"
      stroke="var(--bg-raised)"
      strokeWidth={3}
      strokeLinejoin="round"
    >
      {children}
    </text>
  );
}

export function ProgressionStepChart({
  progression,
  discipline,
  raceWeek,
  raceLabel,
}: {
  progression: PlanProgression;
  discipline: "run" | "lift";
  raceWeek?: number | null;
  raceLabel?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const measured = useMeasuredWidth(boxRef);
  const s0 = progression.series;
  const width = chartWidth(measured, CHART_CAP);
  const color = discipline === "lift" ? "var(--chart-2)" : "var(--chart-1)";

  if (s0.length < 2) return null;
  const s = s0;
  // No `bars`: this is a LINE (or a step), and a line encodes its value as a
  // POSITION, not a length. A 12-week long-run block that runs 14…20 km says
  // more on a 14…20 axis than on a 0…20 one where the whole progression is a
  // flat wiggle in the top third — and the callouts print the numbers, so
  // nothing here depends on reading a height off the baseline. Only
  // `PlannedVsActualBars` asks for the zero origin.
  const sc = scales(progression, width);
  const { x, y } = sc;

  const stepPath = s
    .map((p, i) =>
      i === 0
        ? `M${x(p.week).toFixed(1)} ${y(p.value).toFixed(1)}`
        : `L${x(p.week).toFixed(1)} ${y(s[i - 1]!.value).toFixed(1)} L${x(p.week).toFixed(1)} ${y(p.value).toFixed(1)}`,
    )
    .join(" ");
  const linePath = s
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.week).toFixed(1)} ${y(p.value).toFixed(1)}`)
    .join(" ");
  const path = discipline === "lift" ? stepPath : linePath;
  const first = s[0]!;
  const last = s[s.length - 1]!;
  const done = s.filter((p) => p.done);
  const doneCount = done.length;
  /**
   * The one number the chart annotates is the PEAK, drawn where the peak
   * actually is. The end label used to print `progression.to` (which IS the
   * peak — see plan-progressions.ts `peak()`) hard against the right edge, on
   * the last week's height: on any block that tapers, race week ended up
   * captioned with a number two weeks older than it ("16.1 km" over a 10 km
   * taper week). The card headline still reads start→peak, deliberately; this
   * says which point that peak belongs to.
   */
  const peak = s.reduce((a, b) => (b.value > a.value ? b : a), first);
  const nowWeek =
    progression.now !== null && progression.now !== last.value
      ? Math.min(sc.wMax, Math.max(sc.wMin, s.find((p) => p.value === progression.now)?.week ?? sc.wMin))
      : null;
  const nowOnPeak = nowWeek !== null && nowWeek === peak.week;
  const race = raceLine(sc, raceWeek, raceLabel);

  // Every drawn dot is an obstacle for the callouts; the peak is placed first
  // because it is the headline of the two.
  const obstacles: Box[] = done.map((p) => ({
    x: x(p.week) - DOT_R,
    y: y(p.value) - DOT_R,
    w: DOT_R * 2,
    h: DOT_R * 2,
  }));
  const peakText = `peak ${peak.value} ${progression.unit}${nowOnPeak ? " · now" : ""}`;
  const peakAt = placeCallout(peakText, x(peak.week), y(peak.value), sc, obstacles);
  const nowText = `${progression.now} · now`;
  const nowAt =
    nowWeek !== null && !nowOnPeak
      ? placeCallout(nowText, x(nowWeek), y(progression.now!), sc, obstacles)
      : null;

  // Describes what is DRAWN — first, peak, and where the line actually ends —
  // so the alternative text can't caption a taper with the peak either.
  const summary =
    `${progression.label}: prescribed from ${first.value} ${progression.unit} in week ${sc.wMin} to a peak of ` +
    `${peak.value} ${progression.unit} in week ${peak.week}` +
    (peak.value > last.value ? `, easing to ${last.value} ${progression.unit} by week ${sc.wMax}` : "") +
    `; ${doneCount} of ${s.length} weeks completed` +
    (progression.now !== null ? `; currently ${progression.now} ${progression.unit}` : "") +
    (race ? `; ${race.label}` : "") +
    ".";

  return (
    <ChartFrame
      title={`${progression.label} — by week`}
      subtitle={`prescribed${doneCount > 0 ? " · dots mark completed weeks" : ""}`}
      summary={summary}
      legend={[]}
    >
      <div className="chartbox-svg" ref={boxRef}>
        <svg
          viewBox={`0 0 ${width} ${VB_H}`}
          style={svgStyle(width)}
          role="img"
          aria-hidden
          focusable="false"
        >
          <GridLines ticks={sc.ticks} y={y} x1={sc.left} x2={sc.right} format={(t) => String(t)} />
          <line x1={sc.left} y1={sc.base} x2={sc.right} y2={sc.base} stroke="var(--chart-grid)" />
          <StripAnnotations s={sc} race={race} unit={progression.unit} />
          <path d={path} fill="none" stroke={INK_FAINT} strokeWidth="1.5" strokeDasharray="4 3" />
          {done.map((p) => (
            <circle
              key={p.week}
              cx={x(p.week)}
              cy={y(p.value)}
              r={DOT_R}
              fill={color}
              stroke="var(--bg-raised)"
              strokeWidth="2"
            />
          ))}
          {nowAt ? <Callout at={nowAt}>{nowText}</Callout> : null}
          {peakAt ? <Callout at={peakAt}>{peakText}</Callout> : null}
          <WeekLabels s={sc} />
        </svg>
      </div>
    </ChartFrame>
  );
}

/**
 * Planned-vs-actual weekly minutes: outline planned, filled actual (run).
 *
 * `scales(..., bars)` — so the y axis starts at ZERO. It did not: the studio
 * modal's `Weekly time — planned vs done` opened on a 100…250 axis, which
 * truncated every bar's baseline and overstated the differences between them.
 * That is not a style choice, it is the classic way a bar chart lies.
 */
export function PlannedVsActualBars({
  progression,
  raceWeek,
  raceLabel,
}: {
  progression: PlanProgression;
  raceWeek?: number | null;
  raceLabel?: string;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const measured = useMeasuredWidth(boxRef);
  const s = progression.series;
  const width = chartWidth(measured, CHART_CAP);

  if (s.length < 2) return null;
  const sc = scales(progression, width, true);
  const { x, y } = sc;
  const barW = Math.min(26, sc.slot * 0.7);
  const base = sc.base;
  const race = raceLine(sc, raceWeek, raceLabel);
  const withActual = s.filter((p) => p.actual !== undefined).length;
  const summary =
    `${progression.label}: planned ${progression.from} to ${progression.to} ${progression.unit} by week; ` +
    `actuals known for ${withActual} of ${s.length} weeks${race ? `; ${race.label}` : ""}.`;
  return (
    <ChartFrame
      title={`${progression.label} — planned vs done`}
      subtitle="outline planned · filled done"
      summary={summary}
      legend={[]}
    >
      <div className="chartbox-svg" ref={boxRef}>
        <svg
          viewBox={`0 0 ${width} ${VB_H}`}
          style={svgStyle(width)}
          role="img"
          aria-hidden
          focusable="false"
        >
          <GridLines ticks={sc.ticks} y={y} x1={sc.left} x2={sc.right} format={(t) => String(t)} />
          <line x1={sc.left} y1={base} x2={sc.right} y2={base} stroke="var(--chart-grid)" />
          <StripAnnotations s={sc} race={race} unit={progression.unit} />
          {s.map((p) => {
            const cx = x(p.week);
            return (
              <g key={p.week}>
                <rect
                  x={cx - barW / 2}
                  y={y(p.value)}
                  width={barW}
                  height={Math.max(0, base - y(p.value))}
                  rx="4"
                  fill="none"
                  stroke={INK_FAINT}
                  strokeDasharray="3 3"
                />
                {p.actual !== undefined ? (
                  <rect
                    x={cx - barW / 2}
                    y={y(p.actual)}
                    width={barW}
                    height={Math.max(0, base - y(p.actual))}
                    rx="4"
                    fill="var(--chart-1)"
                  />
                ) : null}
              </g>
            );
          })}
          <WeekLabels s={sc} />
        </svg>
      </div>
    </ChartFrame>
  );
}
