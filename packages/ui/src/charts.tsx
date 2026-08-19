import type { KeyboardEvent, ReactNode } from "react";
import type { InsightsResponse } from "@rg/api-client";
import {
  CHART_HEADER_BASELINE,
  CHART_HEADER_H,
  CHART_LABEL_PX,
  GridLines,
  HatchDefs,
  ReferenceLine,
  ShadedBand,
  chartWidth,
  dateX,
  labelStride,
  niceTicks,
  rollingMedian,
  svgStyle,
  useChartTooltip,
  useHatchId,
  type ChartMark,
} from "./chart-kit.js";
import {
  divergingDomain,
  formatHours,
  heatmapColumns,
  horizontalBarPath,
  inProgressColumnIndex,
  monthStartDates,
  newMonthColumns,
  outcomeSegments,
  roundedTopBarPath,
  stackedBarSegments,
  symmetricHalfExtent,
  verticalBarPath,
} from "./charts-math.js";
import { countNoun, formatShortDate, formatShortMonth } from "./components.js";

/**
 * The Insights chart layer. Dependency-free SVG, built on `chart-kit.tsx`
 * (scales, ticks, tooltip overlay, reference marks) and `charts-math.ts`
 * (every pixel decision that can be tested without a DOM).
 *
 * The rules these charts exist to obey — the project's dataviz method:
 *   - ONE axis, and a grid that recedes (`--chart-grid`). Text is always an
 *     ink token; only marks and glyphs carry series or valence color.
 *   - Bars start at zero. Line charts may crop (an indexed quantity like
 *     m/beat has no meaningful zero) — and get a rolling-median line and,
 *     where one exists, a reference band, so the reader has an anchor that
 *     isn't the axis.
 *   - Surface gaps are SUBTRACTED from segments, never added between them,
 *     so a stack's overall height still reads as its total.
 *   - Rounded corners on the data end only; square where a bar meets its
 *     baseline or its reference line.
 *   - Color is never the only signal. Every status-colored mark also differs
 *     in shape, glyph, pattern, or position, and every chart carries direct
 *     labels or a legend.
 *   - Every chart is wrapped in `ChartFrame`: a real caption, a
 *     visually-hidden prose summary (what a screen-reader user gets instead
 *     of the marks), and a note carrying sample sizes and caveats.
 *   - Tooltips come from `useChartTooltip` (hover + tap-to-pin). There are no
 *     SVG `<title>` elements in this file: they are unreachable on touch and
 *     render inconsistently across browsers.
 *   - Dates go through `formatShortDate` ("May 12") and weekly durations
 *     through `formatHours` ("4.5h") — everywhere, tooltips and hidden
 *     summaries included.
 */

/**
 * The plot's margins. There is no `top` here: the plot's top edge is
 * `CHART_HEADER_H` in every chart, because that is the strip the unit and a
 * reference line's label print in. Two of these charts used to start their
 * plot at 10 and label their reference line INSIDE it.
 */
const M = { right: 10, bottom: 26, left: 40 };

const GRID = "var(--chart-grid)";
const INK_FAINT = "var(--ink-faint)";
const TRACK = "var(--chart-track)";

// ── ChartFrame ──────────────────────────────────────────────────────────────

export interface ChartLegendItem {
  label: string;
  /** A plain color chip (`--chart-1`, …). Ignored when `swatch` is given. */
  colorVar?: string;
  /** A bespoke swatch — a tiny inline SVG mirroring the mark it stands for. */
  swatch?: ReactNode;
}

export interface ChartFrameProps {
  title: string;
  subtitle?: string;
  /** Prose that says everything the marks say — the screen-reader equivalent of the chart. */
  summary: string;
  note?: string;
  legend?: ChartLegendItem[];
  /**
   * A small node pinned to the right of the caption row — today, the
   * `TrendChip` on aerobic efficiency. It lives here rather than in
   * `subtitle` because `subtitle` is prose (a string) and a chip is a mark:
   * a reader scanning two charts side by side should find the trend in the
   * same place on both, not buried mid-sentence.
   */
  aside?: ReactNode;
  children: ReactNode;
}

export function ChartFrame({ title, subtitle, summary, note, legend, aside, children }: ChartFrameProps) {
  return (
    <figure style={{ margin: 0 }} className="chart-block">
      <figcaption className="chart-caption">
        <div className="chart-caption-text">
          <div className="chart-title">{title}</div>
          {subtitle ? <div className="chart-subtitle">{subtitle}</div> : null}
        </div>
        {aside ? <div className="chart-caption-aside">{aside}</div> : null}
      </figcaption>
      {legend && legend.length > 1 ? (
        <div className="chart-legend">
          {legend.map((l) => (
            <span key={l.label} className="chart-legend-item">
              <span aria-hidden className="chart-legend-swatch">
                {l.swatch ?? (
                  <span
                    className="chart-legend-chip"
                    style={{ background: `var(${l.colorVar ?? "--chart-1"})` }}
                  />
                )}
              </span>
              {l.label}
            </span>
          ))}
        </div>
      ) : null}
      {children}
      <p className="visually-hidden">{summary}</p>
      {note ? <p className="chart-note">{note}</p> : null}
    </figure>
  );
}

// ── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Tick values and the y-scale they imply, in one of two domain modes.
 *
 * `"ticks"` runs the scale over the full tick extent — the top and bottom
 * gridlines are round numbers, and bars get a little headroom. Right for a
 * zero-based bar chart.
 *
 * `"data"` runs the scale over the data's own (lightly padded) extent and
 * keeps only the ticks that fall inside it. `niceTicks` rounds OUTWARD, so on
 * a tight range it can more than double the domain — 138–164 bpm becomes a
 * 120–180 axis, and every lap bar shrinks into the middle third of the plot
 * for no informational gain. Cropping is already allowed for these indexed
 * quantities; wasting two thirds of the canvas on empty axis is not.
 *
 * A flat series (every value identical, so `niceTicks` returns one tick) is
 * widened rather than divided by a zero span.
 */
function yAxis(
  values: number[],
  top: number,
  innerH: number,
  { count = 3, mode = "ticks", pad = 0.05 }: { count?: number; mode?: "ticks" | "data"; pad?: number } = {},
) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const scale = (yLo: number, yHi: number) => {
    const span = yHi - yLo || 1;
    return (v: number) => top + innerH - ((v - yLo) / span) * innerH;
  };

  if (mode === "data") {
    const rawSpan = hi - lo;
    const padding = rawSpan > 0 ? rawSpan * pad : Math.max(1, Math.abs(lo) * 0.05);
    const yLo = lo - padding;
    const yHi = hi + padding;
    // One extra interval, because filtering to the domain drops the outermost
    // ticks that niceTicks added by rounding outward.
    const inside = niceTicks(yLo, yHi, count + 1).filter((t) => t >= yLo && t <= yHi);
    if (inside.length >= 2) return { ticks: inside, y: scale(yLo, yHi) };
    // Too tight for round numbers to land inside — fall through to the tick
    // extent rather than draw an axis with one lonely gridline.
  }

  let ticks = niceTicks(lo, hi, count);
  if (ticks.length < 2) {
    const nudge = Math.max(1, Math.abs(lo) * 0.05);
    ticks = niceTicks(lo - nudge, hi + nudge, count);
  }
  return { ticks, y: scale(ticks[0]!, ticks[ticks.length - 1]!) };
}

function signed(v: number, decimals = 0): string {
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(decimals)}`;
}

function onActivate(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

// ── RunSeriesChart ──────────────────────────────────────────────────────────

export interface RunSeriesPoint {
  date: string;
  value: number;
  activityId?: string;
}

export interface RunSeriesChartProps {
  points: RunSeriesPoint[];
  unit: string;
  seriesLabel: string;
  colorVar?: string;
  decimals?: number;
  /** A reference band in data units (decoupling: 0–5% is "held together"). */
  band?: { y1: number; y2: number };
  /** Draw and label a solid line at zero — only meaningful for signed quantities. */
  zeroLine?: boolean;
  onPointClick?: (activityId: string) => void;
}

/**
 * Per-run scatter with a rolling-median spine: one muted dot per run on a
 * DATE scale (so a three-week gap looks like a three-week gap, not like the
 * next run), plus a 5-run centered rolling median as the trend the eye should
 * actually follow. The raw dots are deliberately recessive — a per-run
 * efficiency number is noisy, and drawing them as a connected full-strength
 * line invites reading meaning into noise.
 */
export function RunSeriesChart({
  points,
  unit,
  seriesLabel,
  colorVar = "--chart-3",
  decimals = 2,
  band,
  zeroLine,
  onPointClick,
}: RunSeriesChartProps) {
  const { wrapperProps, tooltip, registerMarks, measured } = useChartTooltip();
  const sorted = [...points].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  // Sized to the box it is IN, not to a fixed 560 that a phone column then
  // shrank to 58% (System 3 §B). Every scale below is derived from `width`,
  // so the whole geometry reflows and only the type stays put.
  const width = chartWidth(measured, 560);
  const height = 176;
  // The annotation strip: the unit and the zero line's label sit ABOVE the
  // plot, not floating in the tick column or over the dots.
  const top = CHART_HEADER_H;
  const innerW = width - M.left - M.right;
  const innerH = height - top - M.bottom;
  const color = `var(${colorVar})`;

  const values = sorted.map((p) => p.value);
  const domainValues = [...values];
  if (band) domainValues.push(band.y1, band.y2);
  if (zeroLine) domainValues.push(0);
  const { ticks, y } = yAxis(domainValues.length ? domainValues : [0, 1], top, innerH, {
    mode: "data",
  });
  const x = dateX(
    sorted.map((p) => p.date),
    innerW,
    M.left,
  );
  const median = rollingMedian(values, 5);
  const medianPath = sorted
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.date).toFixed(1)},${y(median[i]!).toFixed(1)}`)
    .join(" ");

  const marks: ChartMark[] = sorted.map((p) => ({
    x: x(p.date),
    y: y(p.value),
    label: `${formatShortDate(p.date)}: ${p.value.toFixed(decimals)} ${unit}`,
    ...(onPointClick && p.activityId
      ? { action: { label: "view run ›", onClick: () => onPointClick(p.activityId!) } }
      : {}),
  }));
  registerMarks(marks);

  if (sorted.length === 0) return null;

  return (
    <div {...wrapperProps}>
      <svg
        role={onPointClick ? "group" : "img"}
        aria-label={`${seriesLabel} across ${countNoun(sorted.length, "run")}`}
        viewBox={`0 0 ${width} ${height}`}
        style={svgStyle(width)}
      >
        {band ? <ShadedBand x1={M.left} x2={width - M.right} y1={y(band.y1)} y2={y(band.y2)} /> : null}
        <GridLines
          ticks={ticks}
          y={y}
          x1={M.left}
          x2={width - M.right}
          format={(t) => t.toFixed(decimals)}
        />
        {zeroLine ? <ReferenceLine x1={M.left} x2={width - M.right} y={y(0)} label="0" /> : null}
        {sorted.length > 1 ? (
          <path d={medianPath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        ) : null}
        {sorted.map((p, i) => (
          <circle key={`${p.date}-${i}`} cx={x(p.date)} cy={y(p.value)} r={3} fill={color} opacity={0.45} />
        ))}
        {/* Focusable, labeled hit targets: the tooltip's "view run ›" button is
            an enhancement for pointer and touch, never the only way in. */}
        {onPointClick
          ? sorted.map((p, i) =>
              p.activityId ? (
                <circle
                  key={`hit-${p.date}-${i}`}
                  className="chart-hit"
                  cx={x(p.date)}
                  cy={y(p.value)}
                  r={12}
                  fill="transparent"
                  role="button"
                  tabIndex={0}
                  aria-label={`${formatShortDate(p.date)}: ${p.value.toFixed(decimals)} ${unit}. View run.`}
                  onClick={() => onPointClick(p.activityId!)}
                  onKeyDown={onActivate(() => onPointClick(p.activityId!))}
                />
              ) : null,
            )
          : null}
        <text x={x(sorted[0]!.date)} y={height - 8} fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
          {formatShortDate(sorted[0]!.date)}
        </text>
        {sorted.length > 1 ? (
          <text
            x={x(sorted[sorted.length - 1]!.date)}
            y={height - 8}
            textAnchor="end"
            fontSize={CHART_LABEL_PX}
            fill={INK_FAINT}
          >
            {formatShortDate(sorted[sorted.length - 1]!.date)}
          </text>
        ) : null}
        <text
          x={width - M.right}
          y={CHART_HEADER_BASELINE}
          textAnchor="end"
          fontSize={CHART_LABEL_PX}
          fill={INK_FAINT}
        >
          {unit}
        </text>
      </svg>
      {tooltip}
    </div>
  );
}

// ── WeeklyDurationChart ─────────────────────────────────────────────────────

export interface WeeklyDurationWeek {
  weekStart: string;
  lowSeconds: number;
  highSeconds: number;
  /** The ISO week still in progress — hatched, and excluded from the average. */
  partial?: boolean;
}

/**
 * Weekly training time, split low vs high intensity. Bars start at zero (a
 * duration has a real zero, so cropping it would be a lie), the 2px surface
 * gap is carved out of the upper segment rather than added on top, and only
 * the top of the stack is rounded.
 */
export function WeeklyDurationChart({
  weeks,
  avgSeconds,
  avgLabel = "avg",
}: {
  weeks: WeeklyDurationWeek[];
  avgSeconds?: number;
  /** Names the window the average covers — the chart can't know it. */
  avgLabel?: string;
}) {
  const { wrapperProps, tooltip, registerMarks, measured } = useChartTooltip();
  const hatchId = useHatchId();
  const width = chartWidth(measured, 560);
  const height = 184;
  // The average line's label prints in the annotation strip, so the plot
  // starts below it — see CHART_HEADER_H. The bars lose 14 units of height
  // and no longer lose their tops to a caption on a phone.
  const top = CHART_HEADER_H;
  const innerW = width - M.left - M.right;
  const innerH = height - top - M.bottom;
  const baselineY = top + innerH;

  const totals = weeks.map((w) => (w.lowSeconds + w.highSeconds) / 3600);
  const avgHours = avgSeconds != null ? avgSeconds / 3600 : undefined;
  const { ticks, y } = yAxis([0, Math.max(0.5, ...totals, avgHours ?? 0)], top, innerH);
  const step = innerW / Math.max(1, weeks.length);
  const barW = Math.min(34, step * 0.62);
  const px = (seconds: number) => baselineY - y(seconds / 3600);
  // Stride by the room the labels HAVE, not by a constant tuned for one
  // width: "May 12" is ~38px at 10px type, and this chart now builds itself
  // anywhere from 240 to 560 wide.
  const labelEvery = labelStride(weeks.length, innerW, 46);

  const marks: ChartMark[] = [];
  const bars = weeks.map((w, i) => {
    const x = M.left + i * step + (step - barW) / 2;
    const segments = stackedBarSegments({ low: px(w.lowSeconds), high: px(w.highSeconds) }, baselineY);
    const topY = segments.length ? Math.min(...segments.map((s) => s.y)) : baselineY;
    marks.push({
      x: x + barW / 2,
      y: topY,
      label:
        `${formatShortDate(w.weekStart)}${w.partial ? " (in progress)" : ""}: ` +
        `${formatHours(w.lowSeconds + w.highSeconds)} total — ` +
        `${formatHours(w.lowSeconds)} low, ${formatHours(w.highSeconds)} high`,
    });
    return { week: w, x, segments, topY };
  });
  registerMarks(marks);

  return (
    <div {...wrapperProps}>
      <svg
        role="img"
        aria-label={`Weekly training time, ${weeks.length} weeks`}
        viewBox={`0 0 ${width} ${height}`}
        style={svgStyle(width)}
      >
        <HatchDefs id={hatchId} />
        <GridLines
          ticks={ticks}
          y={y}
          x1={M.left}
          x2={width - M.right}
          format={(t) => `${t % 1 === 0 ? t : t.toFixed(1)}h`}
        />
        {bars.map(({ week, x, segments }, i) => (
          <g key={week.weekStart}>
            {segments.map((s) => {
              const isTop = s.key === "high" || segments.length === 1;
              const d = isTop
                ? roundedTopBarPath(x, s.y, barW, s.height, 3)
                : verticalBarPath(x, s.y, barW, s.height, 3, {});
              return (
                <g key={s.key}>
                  <path d={d} fill={s.key === "low" ? "var(--chart-1)" : "var(--chart-2)"} />
                  {week.partial ? <path d={d} fill={`url(#${hatchId})`} opacity={0.9} /> : null}
                </g>
              );
            })}
            {segments.length === 0 ? (
              <rect x={x} y={baselineY - 2} width={barW} height={2} fill={TRACK} />
            ) : null}
            {i % labelEvery === 0 ? (
              <text x={x + barW / 2} y={height - 9} textAnchor="middle" fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
                {formatShortDate(week.weekStart)}
              </text>
            ) : null}
          </g>
        ))}
        {avgHours != null ? (
          <ReferenceLine
            x1={M.left}
            x2={width - M.right}
            y={y(avgHours)}
            label={`${avgLabel} ${avgHours.toFixed(1)}h`}
          />
        ) : null}
      </svg>
      {tooltip}
    </div>
  );
}

// ── ConsistencyHeatmap ──────────────────────────────────────────────────────

export type ConsistencyDay = InsightsResponse["consistency"]["days"][number];
export type ConsistencyStatus = ConsistencyDay["status"];

const STATUS_LABEL: Record<ConsistencyStatus, string> = {
  completed: "Completed",
  moved: "Moved — still counts",
  pending: "Awaiting confirmation",
  skipped: "Skipped on purpose",
  missed: "Missed",
  rest: "Rest day",
  future: "Still to come",
  none: "Nothing planned",
};

/** Statuses that stand for a real workout — the only cells worth opening. */
const WORKOUT_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "moved",
  "pending",
  "skipped",
  "missed",
]);

const CELL = 16;
const CELL_STEP = 18;
const CELL_GAP = CELL_STEP - CELL;
const ROW_GUTTER = 26;
const MONTH_BAND = 14;
const ROW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * The heatmap is the one chart whose width is INTRINSIC — a week is a column,
 * so its natural size is `columns × step`, not a design width. It therefore
 * takes the sizing layer from the other end: instead of clamping a fixed
 * viewBox to the measured box, it picks the cell step that makes the grid FILL
 * the measured box, and the viewBox follows from that. Same outcome as every
 * other chart (viewBox width = rendered width, so labels are CSS pixels), and
 * a second benefit that only touch cares about: the cells grow on a phone
 * instead of shrinking, so a tappable day is a bigger target where the taps
 * actually happen.
 *
 * The clamp bounds are the two failure modes. Below 14 the day cell stops
 * being a target (12px with the gap taken out); above 26 twelve weeks of
 * squares turn into a wall of tiles and stop reading as a calendar.
 */
const CELL_STEP_MIN = 14;
const CELL_STEP_MAX = 26;
export function heatCellStep(measured: number | null, columns: number): number {
  if (measured == null || !Number.isFinite(measured) || columns <= 0) return CELL_STEP;
  const perColumn = (measured - ROW_GUTTER - 2) / columns;
  return Math.max(CELL_STEP_MIN, Math.min(CELL_STEP_MAX, Math.floor(perColumn)));
}

/**
 * One day cell. Every status differs in SHAPE as well as color — a filled
 * square, a dot, a ring, a slash, a cross, a hairline outline — so the grid
 * still reads for a color-blind reader and in a black-and-white printout.
 */
function HeatCellMark({
  status,
  x,
  y,
  cell = CELL,
}: {
  status: ConsistencyStatus;
  x: number;
  y: number;
  /** Cell edge in viewBox units — which, post-sizing-layer, is CSS pixels. */
  cell?: number;
}) {
  const box = { x, y, width: cell, height: cell, rx: 3 };
  // The inset marks (the slash, the ✕, the pending ring) are drawn at a
  // FRACTION of the cell rather than at fixed 4/4.5px insets: the cell is a
  // measured size now, and a constant inset that reads right at 16px eats a
  // 14px cell alive and looks lost in a 26px one.
  const inset = cell * 0.28;
  switch (status) {
    case "completed":
      return <rect {...box} fill="var(--chart-1)" />;
    case "moved":
      return (
        <g>
          <rect {...box} fill="var(--chart-1)" opacity={0.55} />
          <circle cx={x + cell / 2} cy={y + cell / 2} r={2.5} fill="var(--bg-raised)" />
        </g>
      );
    case "pending":
      return (
        <g>
          <rect {...box} fill={TRACK} />
          <rect
            x={x + 0.75}
            y={y + 0.75}
            width={cell - 1.5}
            height={cell - 1.5}
            rx={2.5}
            fill="none"
            stroke={INK_FAINT}
            strokeWidth={1.5}
          />
        </g>
      );
    case "skipped":
      return (
        <g>
          <rect {...box} fill={TRACK} />
          <line
            x1={x + inset}
            y1={y + cell - inset}
            x2={x + cell - inset}
            y2={y + inset}
            stroke={INK_FAINT}
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </g>
      );
    case "missed":
      return (
        <g stroke="var(--danger-ink)" strokeWidth={1.5} strokeLinecap="round">
          <line x1={x + inset} y1={y + inset} x2={x + cell - inset} y2={y + cell - inset} />
          <line x1={x + cell - inset} y1={y + inset} x2={x + inset} y2={y + cell - inset} />
        </g>
      );
    case "rest":
      return <circle cx={x + cell / 2} cy={y + cell / 2} r={1.5} fill={INK_FAINT} opacity={0.45} />;
    case "future":
      return (
        <rect
          x={x + 0.5}
          y={y + 0.5}
          width={cell - 1}
          height={cell - 1}
          rx={2.5}
          fill="none"
          stroke={GRID}
          strokeWidth={1}
        />
      );
    default:
      return null;
  }
}

function HeatSwatch({ status }: { status: ConsistencyStatus }) {
  return (
    <svg width={12} height={12} viewBox={`0 0 ${CELL} ${CELL}`} aria-hidden focusable="false">
      <HeatCellMark status={status} x={0} y={0} />
    </svg>
  );
}

const HEATMAP_LEGEND: ConsistencyStatus[] = [
  "completed",
  "moved",
  "pending",
  "skipped",
  "missed",
  "rest",
  "future",
];

/**
 * Twelve-ish weeks of plan consistency, one column per ISO week (oldest
 * left), one row per weekday. The current week needs no marker of its own:
 * `consistency.days` now runs to the end of the current ISO week, so the days
 * still ahead of you draw as hairline outlines and the week reads as
 * in-progress on its own. `inProgressColumnIndex` survives only to add
 * "· this week" to those cells' tooltips — one quiet mark beat four noisy
 * ones, and no mark at all beats one.
 */
export function ConsistencyHeatmap({
  days,
  onDayClick,
  title = "Every day of the plan",
  subtitle,
  note,
}: {
  days: ConsistencyDay[];
  onDayClick?: (date: string) => void;
  title?: string;
  subtitle?: string;
  note?: string;
}) {
  const { wrapperProps, tooltip, registerMarks, measured } = useChartTooltip();
  const columns = heatmapColumns(days, 14);
  const monthCols = new Map(
    newMonthColumns(columns).map((i) => [i, formatShortMonth(columns[i]!.weekStart)]),
  );
  const inProgress = inProgressColumnIndex(columns);
  // Fill the measured box (see heatCellStep) rather than draw at a fixed 18px
  // step and let `width: 100%` scale the whole picture — that scaling is what
  // made these month/weekday labels a different physical size on every screen.
  const step = heatCellStep(measured, columns.length);
  const cell = step - CELL_GAP;
  const width = ROW_GUTTER + columns.length * step + 2;
  const height = MONTH_BAND + 7 * step;

  // Counted from the columns actually drawn, not from `days` — the summary is
  // the screen-reader's version of this chart, so it has to describe the cells
  // on screen and not the ones `heatmapColumns` trimmed off the left.
  const drawn = columns.flatMap((c) => c.days.filter((d) => d != null));
  const counts = new Map<ConsistencyStatus, number>();
  for (const d of drawn) counts.set(d.status, (counts.get(d.status) ?? 0) + 1);
  const summary =
    `${drawn.length} days across ${columns.length} weeks. ` +
    HEATMAP_LEGEND.filter((s) => (counts.get(s) ?? 0) > 0)
      .map((s) => `${counts.get(s)} ${STATUS_LABEL[s].toLowerCase()}`)
      .join(", ") +
    ".";

  const marks: ChartMark[] = [];
  for (let col = 0; col < columns.length; col++) {
    for (let row = 0; row < 7; row++) {
      const day = columns[col]!.days[row];
      if (!day || day.status === "none") continue;
      marks.push({
        x: ROW_GUTTER + col * step + cell / 2,
        y: MONTH_BAND + row * step + cell / 2,
        label: `${formatShortDate(day.date)}: ${STATUS_LABEL[day.status]}${
          col === inProgress ? " · this week" : ""
        }`,
      });
    }
  }
  registerMarks(marks);

  if (columns.length === 0) return null;

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      summary={summary}
      note={note}
      // Only the statuses this plan actually contains — a key for a state you
      // have never been in is clutter that makes the real ones harder to find.
      legend={HEATMAP_LEGEND.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => ({
        label: STATUS_LABEL[s],
        swatch: <HeatSwatch status={s} />,
      }))}
    >
      <div {...wrapperProps}>
        <svg
          role={onDayClick ? "group" : "img"}
          aria-label={`Plan consistency, ${columns.length} weeks by weekday`}
          viewBox={`0 0 ${width} ${height}`}
          style={svgStyle(width)}
        >
          {[...monthCols].map(([i, label]) => (
            <text
              key={`m${i}`}
              x={ROW_GUTTER + i * step}
              y={MONTH_BAND - 5}
              fontSize={CHART_LABEL_PX}
              fill={INK_FAINT}
            >
              {label}
            </text>
          ))}
          {ROW_LABELS.map((label, row) => (
            <text
              key={label}
              x={ROW_GUTTER - 5}
              y={MONTH_BAND + row * step + cell / 2 + 3}
              textAnchor="end"
              fontSize={CHART_LABEL_PX}
              fill={INK_FAINT}
            >
              {label}
            </text>
          ))}
          {columns.map((column, col) =>
            column.days.map((day, row) => {
              if (!day) return null;
              const x = ROW_GUTTER + col * step;
              const y = MONTH_BAND + row * step;
              const clickable = !!onDayClick && WORKOUT_STATUSES.has(day.status);
              return (
                <g key={day.date}>
                  <HeatCellMark status={day.status} x={x} y={y} cell={cell} />
                  {clickable ? (
                    <rect
                      className="chart-hit"
                      x={x}
                      y={y}
                      width={cell}
                      height={cell}
                      rx={3}
                      fill="transparent"
                      role="button"
                      tabIndex={0}
                      aria-label={`${formatShortDate(day.date)}: ${STATUS_LABEL[day.status]}`}
                      onClick={() => onDayClick!(day.date)}
                      onKeyDown={onActivate(() => onDayClick!(day.date))}
                    />
                  ) : null}
                </g>
              );
            }),
          )}
        </svg>
        {tooltip}
      </div>
    </ChartFrame>
  );
}

// ── OutcomeBar ──────────────────────────────────────────────────────────────

const OUTCOME_LABEL = {
  completed: "done",
  moved: "moved (still counts)",
  pending: "pending",
  skipped: "skipped",
  missed: "missed",
  upcoming: "still ahead",
} as const;

/**
 * Every planned workout in one 12px bar. `moved` is drawn as its own segment
 * carved out of `completed` (the report counts a moved-and-done workout as
 * both, so stacking the raw numbers would double-count it) and sits beside
 * it in the same hue — moving a session is not a failure, and the chart is
 * not allowed to imply that it is.
 */
export function OutcomeBar({
  completed,
  moved,
  pending,
  skipped,
  missed,
  planned,
  title = "How the plan actually went",
  subtitle,
}: {
  completed: number;
  moved: number;
  pending: number;
  skipped: number;
  missed: number;
  planned: number;
  title?: string;
  subtitle?: string;
}) {
  const { wrapperProps, tooltip, registerMarks, measured } = useChartTooltip();
  const movedHatch = useHatchId();
  const skippedHatch = useHatchId();
  const width = chartWidth(measured, 560);
  const barH = 12;
  const segments = outcomeSegments({ completed, moved, pending, skipped, missed, planned }, width);

  registerMarks(
    segments.map((s) => ({
      x: s.x + s.width / 2,
      y: barH / 2,
      label: `${s.count} ${OUTCOME_LABEL[s.kind]} of ${planned} planned`,
    })),
  );

  if (segments.length === 0) return null;

  const fillFor = (kind: (typeof segments)[number]["kind"]) => {
    switch (kind) {
      case "completed":
        return { fill: "var(--chart-1)", opacity: 1, pattern: null as string | null };
      case "moved":
        return { fill: "var(--chart-1)", opacity: 0.55, pattern: movedHatch };
      case "pending":
        return { fill: TRACK, opacity: 1, pattern: null };
      case "skipped":
        return { fill: TRACK, opacity: 1, pattern: skippedHatch };
      case "missed":
        return { fill: "var(--danger)", opacity: 0.85, pattern: null };
      case "upcoming":
        return { fill: "none", opacity: 1, pattern: null };
    }
  };

  const summary =
    `${planned} planned workouts: ` +
    segments.map((s) => `${s.count} ${OUTCOME_LABEL[s.kind]}`).join(", ") +
    ". Moving a workout still counts as completing it.";

  return (
    <ChartFrame title={title} subtitle={subtitle} summary={summary}>
      <div {...wrapperProps}>
        <svg
          role="img"
          aria-label={`Plan outcomes across ${planned} workouts`}
          viewBox={`0 0 ${width} ${barH}`}
          style={svgStyle(width)}
        >
          <HatchDefs id={movedHatch} />
          <HatchDefs id={skippedHatch} angle={-45} />
          {segments.map((s, i) => {
            const d = horizontalBarPath(s.x, 0, s.width, barH, 6, {
              left: i === 0,
              right: i === segments.length - 1,
            });
            const style = fillFor(s.kind);
            return (
              <g key={s.kind}>
                <path
                  d={d}
                  fill={style.fill}
                  opacity={style.opacity}
                  stroke={s.kind === "upcoming" ? GRID : undefined}
                  strokeWidth={s.kind === "upcoming" ? 1 : undefined}
                />
                {style.pattern ? <path d={d} fill={`url(#${style.pattern})`} /> : null}
              </g>
            );
          })}
        </svg>
        {tooltip}
      </div>
      {/* The count line IS this chart's legend: at 12px tall the segments can't
          carry their own labels, and counts beat a color key anyway. */}
      <p className="outcome-counts">
        {segments.map((s, i) => (
          <span key={s.kind} className="outcome-count">
            {i > 0 ? <span aria-hidden className="outcome-sep"> · </span> : null}
            <span aria-hidden className={`outcome-chip outcome-chip-${s.kind}`} />
            {s.count} {OUTCOME_LABEL[s.kind]}
          </span>
        ))}
      </p>
    </ChartFrame>
  );
}

// ── LapHrBars ───────────────────────────────────────────────────────────────

export interface LapDetail {
  lapIndex: number;
  avgHr?: number;
  over?: boolean;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Per-lap heart rate as a DIVERGING chart: every bar is anchored at the easy
 * ceiling and grows up (over — the thing that costs you) or down (under). The
 * old version drew bars up from an arbitrary cropped floor, which made a lap
 * 3 bpm over look like a lap twice as hard as one 3 bpm under. Distance from
 * the ceiling is the whole question, so distance from the ceiling is what the
 * mark encodes.
 *
 * With no `threshold` supplied there is no ceiling to diverge from, so the
 * bars diverge from the run's own median lap — labeled as the median, never
 * dressed up as a target.
 */
export function LapHrBars({
  laps,
  threshold,
  title = "Heart rate, lap by lap",
}: {
  laps: LapDetail[];
  threshold?: { value: number; unit?: string };
  title?: string;
}) {
  const { wrapperProps, tooltip, registerMarks, measured } = useChartTooltip();
  const withHr = laps.filter((l) => (l.avgHr ?? 0) > 0);
  const hrs = withHr.map((l) => l.avgHr!);
  const width = chartWidth(measured, 420);
  const height = 132;
  const left = 34;
  // Bars diverge from the ceiling line, so the line's own label had nowhere
  // safe to sit inside the plot: it belongs in the annotation strip.
  const top = CHART_HEADER_H;
  const innerW = width - left - 10;
  const innerH = height - top - 22;
  const unit = threshold?.unit ?? "bpm";
  const center = threshold?.value ?? (hrs.length ? median(hrs) : 0);
  const domain = divergingDomain(hrs.length ? hrs : [center], center);
  const { ticks, y } = yAxis([domain.lo, domain.hi], top, innerH, { mode: "data", pad: 0 });
  const step = innerW / Math.max(1, withHr.length);
  const barW = Math.min(24, step * 0.66);
  const yCenter = y(center);
  const labelEvery = labelStride(withHr.length, innerW, 18);
  // With no threshold the bars diverge from the run's OWN median lap, which is
  // a description of the run, not a target it was measured against. Calling
  // that line a "ceiling" in the tooltip and the accessible name — as both did
  // — invented a standard the reader was never held to, and the visible
  // summary a few lines below already said "median" for the same number.
  const centerLabel = threshold ? "ceiling" : "median";

  registerMarks(
    withHr.map((l, i) => ({
      x: left + i * step + step / 2,
      y: (yCenter + y(l.avgHr!)) / 2,
      label: `Lap ${l.lapIndex}: ${l.avgHr} ${unit}, ${signed(l.avgHr! - center)} vs ${centerLabel}`,
    })),
  );

  if (withHr.length < 2) return null;

  const overLaps = withHr.filter((l) => l.avgHr! > center);
  const summary =
    `${withHr.length} laps against a ${center} ${unit} ${threshold ? "easy ceiling" : "median"}. ` +
    (overLaps.length === 0
      ? "Every lap stayed at or under it."
      : `${overLaps.length} over it: ${overLaps
          .map((l) => `lap ${l.lapIndex} at ${l.avgHr} (${signed(l.avgHr! - center)})`)
          .join(", ")}.`);

  return (
    <ChartFrame title={title} summary={summary}>
      <div {...wrapperProps}>
        <svg
          role="img"
          aria-label={`Heart rate for ${withHr.length} laps against a ${center} ${unit} ${threshold ? "easy ceiling" : "median"}`}
          viewBox={`0 0 ${width} ${height}`}
          style={svgStyle(width)}
        >
          <GridLines ticks={ticks} y={y} x1={left} x2={width - 10} format={(t) => String(t)} />
          {withHr.map((l, i) => {
            const x = left + i * step + (step - barW) / 2;
            const yv = y(l.avgHr!);
            const over = l.avgHr! > center;
            const h = Math.max(2, Math.abs(yv - yCenter));
            const barY = over ? yCenter - h : yCenter;
            return (
              <g key={l.lapIndex}>
                <path
                  d={verticalBarPath(x, barY, barW, h, 3, over ? { top: true } : { bottom: true })}
                  fill={over ? "var(--danger)" : "var(--chart-1)"}
                  opacity={over ? 0.85 : 1}
                />
                {i % labelEvery === 0 ? (
                  <text
                    x={x + barW / 2}
                    y={height - 8}
                    textAnchor="middle"
                    fontSize={CHART_LABEL_PX}
                    fill={INK_FAINT}
                  >
                    {l.lapIndex}
                  </text>
                ) : null}
              </g>
            );
          })}
          <ReferenceLine
            x1={left}
            x2={width - 10}
            y={yCenter}
            label={`${center} ${unit} ${centerLabel}`}
          />
        </svg>
        {tooltip}
      </div>
    </ChartFrame>
  );
}

// ── DivergingPaceBars ───────────────────────────────────────────────────────

export interface PaceSplitRun {
  activityId: string;
  date: string;
  /** Second-half pace minus first-half pace: negative = finished faster. */
  deltaSecPerKm: number;
}

/**
 * One thin bar per run, diverging from a centered zero: left is a negative
 * split (finished faster), right is a fade. The axis is symmetric so a 12 s/km
 * fade and a 12 s/km negative split are the same length — direction alone
 * carries the sign, which means the chart still reads without color.
 */
export function DivergingPaceBars({
  runs,
  title = "How each run finished",
  subtitle,
  note,
  units = "km",
}: {
  runs: PaceSplitRun[];
  title?: string;
  subtitle?: string;
  units?: "km" | "mi";
  note?: string;
}) {
  const { wrapperProps, tooltip, registerMarks, measured } = useChartTooltip();
  const width = chartWidth(measured, 420);
  const gutter = 56;
  const rowH = 16;
  const barH = 9;
  const axisBand = 18;
  const height = runs.length * rowH + axisBand;
  const plotLeft = gutter;
  const plotRight = width - 12;
  const center = (plotLeft + plotRight) / 2;
  const half = (plotRight - plotLeft) / 2;
  const extent = symmetricHalfExtent(runs.map((r) => r.deltaSecPerKm));
  const x = (v: number) => center + (v / extent) * half;

  registerMarks(
    runs.map((r, i) => ({
      x: (center + x(r.deltaSecPerKm)) / 2,
      y: i * rowH + rowH / 2,
      label:
        r.deltaSecPerKm === 0
          ? `${formatShortDate(r.date)}: even split`
          : `${formatShortDate(r.date)}: ${signed(units === "mi" ? Math.round(r.deltaSecPerKm * 1.609344) : r.deltaSecPerKm)} s/${units}`,
    })),
  );

  if (runs.length === 0) return null;

  const faded = runs.filter((r) => r.deltaSecPerKm > 0);
  const even = runs.filter((r) => r.deltaSecPerKm === 0);
  const summary =
    `${countNoun(runs.length, "steady run")}, second-half pace against first half. ` +
    `${runs.length - faded.length - even.length} finished faster, ${faded.length} faded` +
    `${even.length > 0 ? `, ${even.length} even` : ""}. ` +
    runs.map((r) => `${formatShortDate(r.date)} ${signed(units === "mi" ? Math.round(r.deltaSecPerKm * 1.609344) : r.deltaSecPerKm)} seconds per ${units === "mi" ? "mile" : "kilometre"}`).join("; ") +
    ".";

  return (
    <ChartFrame title={title} subtitle={subtitle} summary={summary} note={note}>
      <div {...wrapperProps}>
        <svg
          role="img"
          aria-label={`Second-half pace change for ${countNoun(runs.length, "run")}`}
          viewBox={`0 0 ${width} ${height}`}
          style={svgStyle(width)}
        >
          <line
            x1={center}
            x2={center}
            y1={0}
            y2={runs.length * rowH}
            stroke={GRID}
            strokeWidth={1}
          />
          {runs.map((r, i) => {
            const barY = i * rowH + (rowH - barH) / 2;
            const even = r.deltaSecPerKm === 0;
            const faster = r.deltaSecPerKm < 0;
            // A dead-even split belongs ON the axis in a neutral token: give
            // it a side and a series color and the chart claims a direction
            // the run never went.
            const w = even ? 2 : Math.max(2, Math.abs(x(r.deltaSecPerKm) - center));
            const barX = even ? center - 1 : faster ? center - w : center;
            return (
              <g key={r.activityId}>
                <text x={gutter - 8} y={i * rowH + barH + 1} textAnchor="end" fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
                  {formatShortDate(r.date)}
                </text>
                <path
                  d={horizontalBarPath(barX, barY, w, barH, 3, {
                    left: !even && faster,
                    right: !even && !faster,
                  })}
                  fill={even ? INK_FAINT : faster ? "var(--chart-1)" : "var(--chart-2)"}
                  opacity={even ? 0.55 : 1}
                />
              </g>
            );
          })}
          <text x={center} y={height - 6} textAnchor="middle" fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            0
          </text>
          <text x={plotLeft} y={height - 6} fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            ← faster
          </text>
          <text x={plotRight} y={height - 6} textAnchor="end" fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            faded →
          </text>
        </svg>
        {tooltip}
      </div>
    </ChartFrame>
  );
}

// ── BaselineBandChart ───────────────────────────────────────────────────────

/**
 * A daily recovery series against its own baseline: muted dots for the raw
 * readings, a 7-READING rolling median as the line worth reading (the window
 * counts points, not calendar days — a gap in the readings shortens the span
 * it covers, and the note says "readings" so nobody reads it as a week), and a shaded
 * band at the metric's own noise threshold around the baseline. The band is
 * the point — it says which wobbles mean nothing, so a single spiky morning
 * doesn't get read as a trend.
 *
 * `band` carries ABSOLUTE edges, in the same unit as `series` (task B4 —
 * replacing the original `bandPct`). The two metrics that feed this chart
 * derive their band differently: HRV's is ±N% of the baseline, resting HR's
 * is a flat ±5 bpm. A single percentage could only have expressed one of
 * them, and computing the edges here would have meant the chart re-deriving
 * a number the analytics layer already owns — so the server sends both edges
 * (`InterpretedMetric.baseline`) and this component just draws them.
 */
export function BaselineBandChart({
  series,
  baseline,
  band,
  unit,
  seriesLabel,
  colorVar = "--chart-3",
  decimals = 0,
  title,
  subtitle,
  note,
}: {
  series: Array<{ date: string; value: number }>;
  baseline: number;
  /** Absolute band edges in `series`' unit — NOT a percentage. */
  band: { lo: number; hi: number };
  unit: string;
  seriesLabel: string;
  colorVar?: string;
  decimals?: number;
  title?: string;
  subtitle?: string;
  note?: string;
}) {
  const { wrapperProps, tooltip, registerMarks, measured } = useChartTooltip();
  const sorted = [...series].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const width = chartWidth(measured, 560);
  const height = 176;
  const top = CHART_HEADER_H;
  const innerW = width - M.left - M.right;
  const innerH = height - top - M.bottom;
  const color = `var(${colorVar})`;

  const bandLo = Math.min(band.lo, band.hi);
  const bandHi = Math.max(band.lo, band.hi);
  const values = sorted.map((p) => p.value);
  const { ticks, y } = yAxis(
    values.length ? [...values, bandLo, bandHi] : [bandLo, bandHi],
    top,
    innerH,
    { mode: "data" },
  );
  const dates = sorted.map((p) => p.date);
  const x = dateX(dates, innerW, M.left);
  const smoothed = rollingMedian(values, 7);
  const path = sorted
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.date).toFixed(1)},${y(smoothed[i]!).toFixed(1)}`)
    .join(" ");

  registerMarks(
    sorted.map((p) => ({
      x: x(p.date),
      y: y(p.value),
      label: `${formatShortDate(p.date)}: ${p.value.toFixed(decimals)} ${unit}`,
    })),
  );

  if (sorted.length === 0) return null;

  // "typical range", not "healthy range" or "band" standing alone: the
  // shaded region is a NOISE threshold (which wobbles are small enough to
  // ignore), not a verdict on whether a reading is good or bad. Wording it
  // as a health judgment would claim something the metric doesn't.
  const inBand = values.filter((v) => v >= bandLo && v <= bandHi).length;
  const summary =
    `${seriesLabel}: ${sorted.length} daily readings from ${formatShortDate(sorted[0]!.date)} to ` +
    `${formatShortDate(sorted[sorted.length - 1]!.date)}, against a baseline of ` +
    `${baseline.toFixed(decimals)} ${unit} and a typical range of ${bandLo.toFixed(decimals)} to ` +
    `${bandHi.toFixed(decimals)} ${unit}. ` +
    `${inBand} of ${sorted.length} readings fell within the typical range.`;

  return (
    <ChartFrame
      title={title ?? seriesLabel}
      subtitle={subtitle}
      summary={summary}
      note={
        note ??
        `Shaded band: ${bandLo.toFixed(decimals)}–${bandHi.toFixed(decimals)} ${unit} around a baseline of ` +
          `${baseline.toFixed(decimals)} ${unit} · line is a 7-reading rolling median`
      }
    >
      <div {...wrapperProps}>
        <svg
          role="img"
          aria-label={`${seriesLabel} over ${sorted.length} days against its baseline band`}
          viewBox={`0 0 ${width} ${height}`}
          style={svgStyle(width)}
        >
          <ShadedBand x1={M.left} x2={width - M.right} y1={y(bandLo)} y2={y(bandHi)} />
          <GridLines
            ticks={ticks}
            y={y}
            x1={M.left}
            x2={width - M.right}
            format={(t) => t.toFixed(decimals)}
          />
          <ReferenceLine
            x1={M.left}
            x2={width - M.right}
            y={y(baseline)}
            label={`baseline ${baseline.toFixed(decimals)}`}
          />
          {sorted.length > 1 ? (
            <path d={path} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
          ) : null}
          {sorted.map((p, i) => (
            <circle key={`${p.date}-${i}`} cx={x(p.date)} cy={y(p.value)} r={2.5} fill={color} opacity={0.45} />
          ))}
          {monthStartDates(dates).map((d) => (
            <text key={d} x={x(d)} y={height - 8} textAnchor="middle" fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
              {formatShortMonth(d)}
            </text>
          ))}
          <text
            x={width - M.right}
            y={CHART_HEADER_BASELINE}
            textAnchor="end"
            fontSize={CHART_LABEL_PX}
            fill={INK_FAINT}
          >
            {unit}
          </text>
        </svg>
        {tooltip}
      </div>
    </ChartFrame>
  );
}

// ── Sleep & recovery (0020) ─────────────────────────────────────────────────

/**
 * Strain & answer: each training day's load above the divider, the night
 * that followed it below — same day column, so "hard day → the night dips →
 * it settles" is one vertical read. Loads are bars (magnitude), nights are
 * dots against the athlete's own band (the shaded strip). A day without load
 * is an empty slot; a night without a reading is a base tick, never a guess.
 */
export function StrainAnswerChart({
  pairs,
  band,
  unit = "ms",
}: {
  pairs: Array<{ date: string; load: number | null; value: number | null }>;
  /** Absolute night-band edges in `unit` (the hrv metric's baseline band). */
  band: { lo: number; hi: number } | null;
  unit?: string;
}) {
  const { wrapperProps, tooltip, registerMarks, measured } = useChartTooltip();
  const width = chartWidth(measured, 560);
  const height = 190;
  const top = CHART_HEADER_H;
  const innerW = width - M.left - M.right;
  const laneDivider = top + 62; // load lane above, night lane below
  const nightTop = laneDivider + 18;
  const nightBottom = height - M.bottom;

  const slotW = innerW / Math.max(1, pairs.length);
  const barW = Math.max(6, Math.min(18, slotW - 4));
  const xOf = (i: number) => M.left + slotW * (i + 0.5);

  const maxLoad = Math.max(1, ...pairs.map((p) => p.load ?? 0));
  const loadH = (load: number) => Math.max(2, (load / maxLoad) * (laneDivider - top - 6));

  const nightVals = pairs.map((p) => p.value).filter((v): v is number => v != null);
  const lo = Math.min(...(band ? [band.lo] : []), ...nightVals);
  const hi = Math.max(...(band ? [band.hi] : []), ...nightVals);
  const span = Math.max(1, hi - lo);
  const yNight = (v: number) =>
    nightBottom - ((v - lo) / span) * (nightBottom - nightTop);

  registerMarks(
    pairs.flatMap((p, i) => {
      const marks: ChartMark[] = [];
      if (p.load != null && p.load > 0) {
        marks.push({
          x: xOf(i),
          y: laneDivider - loadH(p.load),
          label: `${formatShortDate(p.date)}: load ${Math.round(p.load)}`,
        });
      }
      if (p.value != null) {
        marks.push({
          x: xOf(i),
          y: yNight(p.value),
          label: `night after ${formatShortDate(p.date)}: ${Math.round(p.value)} ${unit}`,
        });
      }
      return marks;
    }),
  );

  const withLoad = pairs.filter((p) => p.load != null && p.load > 0).length;
  const lowNights = band
    ? pairs.filter((p) => p.value != null && p.value < band.lo).length
    : 0;
  const summary =
    `Fourteen days of training load, each paired with the night that followed. ` +
    `${withLoad} days carried load; ` +
    (band
      ? `${lowNights} following night${lowNights === 1 ? "" : "s"} fell below your ${band.lo}–${band.hi} ${unit} band.`
      : `no personal night band is known yet.`);

  return (
    <ChartFrame
      title="Strain & answer"
      subtitle="Each day's training, and how the night answered · 14 days"
      summary={summary}
      note={
        band
          ? `Dots: the night AFTER each day, against your ${band.lo}–${band.hi} ${unit} band · a tick at the base is a night without a reading`
          : "Dots: the night after each day · a tick at the base is a night without a reading"
      }
    >
      <div {...wrapperProps}>
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${width} ${height}`}
          style={svgStyle(width)}
        >
          <text x={M.left} y={CHART_HEADER_BASELINE} fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            load
          </text>
          {pairs.map((p, i) =>
            p.load != null && p.load > 0 ? (
              <path
                key={`l-${p.date}`}
                d={roundedTopBarPath(xOf(i) - barW / 2, laneDivider - loadH(p.load), barW, loadH(p.load), 3)}
                fill="var(--border-strong)"
              />
            ) : null,
          )}
          <line x1={M.left} x2={width - M.right} y1={laneDivider} y2={laneDivider} stroke="var(--chart-grid)" />
          <text x={M.left} y={laneDivider + 13} fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            the night after
          </text>
          {band ? (
            <ShadedBand x1={M.left} x2={width - M.right} y1={yNight(band.hi)} y2={yNight(band.lo)} />
          ) : null}
          {pairs.map((p, i) => {
            if (p.value == null) {
              return (
                <line
                  key={`n-${p.date}`}
                  x1={xOf(i)}
                  x2={xOf(i)}
                  y1={nightBottom}
                  y2={nightBottom - 5}
                  stroke="var(--border-strong)"
                />
              );
            }
            const low = band != null && p.value < band.lo;
            return (
              <circle
                key={`n-${p.date}`}
                cx={xOf(i)}
                cy={yNight(p.value)}
                r={3}
                fill={low ? "var(--warn)" : "var(--ink)"}
                opacity={0.8}
              />
            );
          })}
          <text x={M.left} y={height - 8} fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            {formatShortDate(pairs[0]!.date)}
          </text>
          <text
            x={width - M.right}
            y={height - 8}
            textAnchor="end"
            fontSize={CHART_LABEL_PX}
            fill={INK_FAINT}
          >
            {formatShortDate(pairs[pairs.length - 1]!.date)}
          </text>
        </svg>
        {tooltip}
      </div>
    </ChartFrame>
  );
}

/**
 * Sleep by stage: each recorded night stacked deep → REM → light from the
 * ground up (depth at the root, like soil), against a 7 h reference line.
 * Nights whose stages are unknown draw as a single pale bar — duration is
 * never withheld just because depth wasn't measured. Gap nights (no record)
 * simply aren't slots: the wire only carries recorded nights, and inventing
 * empty columns for unworn-watch nights would read as insomnia.
 */
export function SleepStagesChart({
  nights,
}: {
  nights: Array<{
    date: string;
    totalSeconds: number;
    deepSeconds?: number | null;
    remSeconds?: number | null;
    lightSeconds?: number | null;
  }>;
}) {
  const { wrapperProps, tooltip, registerMarks, measured } = useChartTooltip();
  const shown = nights.slice(-14);
  const width = chartWidth(measured, 560);
  const height = 180;
  const top = CHART_HEADER_H;
  const innerW = width - M.left - M.right;
  const bottom = height - M.bottom;

  const slotW = innerW / Math.max(1, shown.length);
  const barW = Math.max(8, Math.min(22, slotW - 4));
  const xOf = (i: number) => M.left + slotW * (i + 0.5);

  const maxH = Math.max(9, ...shown.map((n) => n.totalSeconds / 3600));
  const yOf = (hours: number) => bottom - (hours / maxH) * (bottom - top - 6);

  registerMarks(
    shown.map((nt, i) => ({
      x: xOf(i),
      y: yOf(nt.totalSeconds / 3600),
      label: `${formatShortDate(nt.date)}: ${(nt.totalSeconds / 3600).toFixed(1)} h`,
    })),
  );

  if (shown.length === 0) return null;

  const summary =
    `${shown.length} recorded nights from ${formatShortDate(shown[0]!.date)} to ` +
    `${formatShortDate(shown[shown.length - 1]!.date)}, stacked by depth where known, ` +
    `against a 7 hour reference line.`;

  const GAP = 2;
  return (
    <ChartFrame
      title="Sleep"
      subtitle={`Depth of each recorded night · line marks 7 h`}
      summary={summary}
      legend={[
        { label: "deep", swatch: <span className="chart-legend-chip" style={{ background: "var(--night-deep)" }} /> },
        { label: "REM", swatch: <span className="chart-legend-chip" style={{ background: "var(--night-rem)" }} /> },
        { label: "light", swatch: <span className="chart-legend-chip" style={{ background: "var(--night-light)" }} /> },
      ]}
      note="Only recorded nights are drawn — a night the watch wasn't worn is absent, not zero"
    >
      <div {...wrapperProps}>
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${width} ${height}`}
          style={svgStyle(width)}
        >
          {shown.map((nt, i) => {
            const x = xOf(i) - barW / 2;
            const totalH = yOf(0) - yOf(nt.totalSeconds / 3600);
            const deep = nt.deepSeconds ?? null;
            const rem = nt.remSeconds ?? null;
            if (deep == null && rem == null) {
              return (
                <path
                  key={nt.date}
                  d={roundedTopBarPath(x, yOf(nt.totalSeconds / 3600), barW, totalH, 3)}
                  fill="var(--night-light)"
                  opacity={0.75}
                />
              );
            }
            // light = the remainder, unless the wire carried it explicitly.
            const light =
              nt.lightSeconds ?? Math.max(0, nt.totalSeconds - (deep ?? 0) - (rem ?? 0));
            const hPx = (sec: number) => (sec / 3600 / maxH) * (bottom - top - 6);
            const deepH = Math.max(0, hPx(deep ?? 0) - GAP);
            const remH = Math.max(0, hPx(rem ?? 0) - GAP);
            const lightH = Math.max(0, hPx(light) - GAP);
            let cursor = bottom;
            const segs: ReactNode[] = [];
            if (deepH > 0) {
              segs.push(<rect key="d" x={x} y={cursor - deepH} width={barW} height={deepH} fill="var(--night-deep)" />);
              cursor -= deepH + GAP;
            }
            if (remH > 0) {
              segs.push(<rect key="r" x={x} y={cursor - remH} width={barW} height={remH} fill="var(--night-rem)" />);
              cursor -= remH + GAP;
            }
            if (lightH > 0) {
              segs.push(
                <path key="g" d={roundedTopBarPath(x, cursor - lightH, barW, lightH, 3)} fill="var(--night-light)" />,
              );
            }
            return <g key={nt.date}>{segs}</g>;
          })}
          <ReferenceLine x1={M.left} x2={width - M.right} y={yOf(7)} label="7 h" />
          <text x={M.left} y={height - 8} fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            {formatShortDate(shown[0]!.date)}
          </text>
          <text x={width - M.right} y={height - 8} textAnchor="end" fontSize={CHART_LABEL_PX} fill={INK_FAINT}>
            {formatShortDate(shown[shown.length - 1]!.date)}
          </text>
        </svg>
        {tooltip}
      </div>
    </ChartFrame>
  );
}
