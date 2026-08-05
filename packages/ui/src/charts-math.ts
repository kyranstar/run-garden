import { isoWeekday, startOfIsoWeek } from "@rg/domain";

/**
 * Chart math — the pure, render-free half of the chart layer.
 *
 * Everything here is a plain function over numbers and ISO date strings so it
 * can be unit-tested without a DOM (packages/ui/test/charts-math.test.ts).
 * `charts.tsx` owns the SVG; this file owns the arithmetic that decides where
 * marks land, which is where the honesty rules actually live:
 *
 *   - surface gaps are SUBTRACTED from segments, never added to the stack, so
 *     a bar's total height/width still reads as its total value;
 *   - a nonzero segment is never allowed to vanish (2px floor), and the pixels
 *     that floor costs are taken from segments that can spare them rather than
 *     silently overflowing the bar;
 *   - a remainder the counts don't explain becomes its own labeled segment
 *     ("upcoming") instead of being absorbed into a neighbour.
 */

// ── Durations ───────────────────────────────────────────────────────────────

/**
 * The one weekly-duration format for the whole chart layer: hours, 1 decimal.
 * Minutes-based strings ("312 min") are retired — a reader comparing weeks
 * thinks in hours, and mixing the two units across a chart and its tooltip is
 * how the old screen ended up with three different date formats too.
 */
export function formatHours(seconds: number): string {
  return `${(seconds / 3600).toFixed(1)}h`;
}

// ── Heatmap bucketing ───────────────────────────────────────────────────────

export interface HeatmapDayLike {
  date: string;
  status: string;
}

export interface HeatmapColumn<D extends HeatmapDayLike> {
  /** Monday of this ISO week. */
  weekStart: string;
  /** Exactly 7 entries, index 0 = Monday … 6 = Sunday; `null` where the input had no such day. */
  days: Array<D | null>;
}

/**
 * Days bucketed into ISO-week columns (oldest first), each column a fixed
 * 7-row Mon→Sun array. A missing day stays `null` rather than shifting later
 * days up a row — a heatmap whose rows don't mean weekdays is worse than a
 * gappy one. Input order doesn't matter; later duplicates of the same date
 * win (the caller's own precedence has already run by then).
 */
export function heatmapColumns<D extends HeatmapDayLike>(
  days: readonly D[],
  maxColumns?: number,
): Array<HeatmapColumn<D>> {
  const byWeek = new Map<string, Array<D | null>>();
  for (const d of days) {
    const weekStart = startOfIsoWeek(d.date);
    let row = byWeek.get(weekStart);
    if (!row) {
      row = [null, null, null, null, null, null, null];
      byWeek.set(weekStart, row);
    }
    row[isoWeekday(d.date) - 1] = d;
  }
  const columns = [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([weekStart, rows]) => ({ weekStart, days: rows }));
  return maxColumns != null && columns.length > maxColumns ? columns.slice(-maxColumns) : columns;
}

/** Indices of the columns that open a new calendar month (index 0 always does). */
export function newMonthColumns(columns: ReadonlyArray<{ weekStart: string }>): number[] {
  const out: number[] = [];
  let previous = "";
  columns.forEach((c, i) => {
    const month = c.weekStart.slice(0, 7);
    if (i === 0 || month !== previous) out.push(i);
    previous = month;
  });
  return out;
}

const RESOLVED_STATUSES = new Set(["completed", "moved", "pending", "skipped", "missed", "rest"]);

/**
 * The column that is mid-week right now: the last one holding BOTH a resolved
 * day and a still-future one. Derived rather than passed in, so the chart
 * never has to be told what "today" is (and can't disagree with the data it
 * was handed). `-1` when no column is mid-week.
 */
export function inProgressColumnIndex<D extends HeatmapDayLike>(
  columns: ReadonlyArray<HeatmapColumn<D>>,
): number {
  for (let i = columns.length - 1; i >= 0; i--) {
    const days = columns[i]!.days;
    const hasResolved = days.some((d) => d && RESOLVED_STATUSES.has(d.status));
    const hasFuture = days.some((d) => d?.status === "future");
    if (hasResolved && hasFuture) return i;
  }
  return -1;
}

// ── Streak ──────────────────────────────────────────────────────────────────

/**
 * The user's CURRENT streak, in days, of completed-or-moved plan days.
 *
 * Starts from the most recent day that has actually happened — trailing
 * `future` cells (the rest of an in-progress ISO week) and trailing `none`
 * cells (no entry synced yet for today) are skipped rather than treated as a
 * broken streak; there's simply nothing to read there yet. From that day,
 * walking backward:
 *
 *   - `completed` / `moved` extends the streak by one (a moved-but-completed
 *     workout is never a failure anywhere else in this codebase, and isn't
 *     one here either);
 *   - `rest` neither extends the streak nor breaks it — it's skipped over, so
 *     a run day on either side of a rest day stays connected. This mirrors
 *     `records.ts`'s fastest-comeback record, which tolerates a gap of a few
 *     days between qualifying runs instead of demanding literally consecutive
 *     dates — a planned day off isn't a lapse;
 *   - anything else (`skipped`, `missed`, `pending`, or a `none` earlier in
 *     history, before the plan existed) stops the walk right there. `pending`
 *     in particular means "unknown, not yet resolved" rather than "failed" —
 *     so hitting one ends the count without retroactively zeroing the days
 *     already tallied before it, the same way an unresolved sync doesn't
 *     undo the completed days that came before it.
 *
 * `days` must be date-ascending, one entry per calendar day, with no gaps —
 * exactly the shape `ConsistencyReport.days` produces — since this walks
 * array order as if it were consecutive days. Typed structurally (matching
 * `HeatmapDayLike`) rather than importing `ConsistencyDay` from
 * `@rg/analytics`, for the same reason `heatmapColumns` is generic: this file
 * stays dependency-free and testable without the wire types.
 */
export function currentStreak(days: readonly HeatmapDayLike[]): number {
  let i = days.length - 1;
  while (i >= 0 && (days[i]!.status === "future" || days[i]!.status === "none")) i--;

  let streak = 0;
  for (; i >= 0; i--) {
    const status = days[i]!.status;
    if (status === "completed" || status === "moved") {
      streak++;
    } else if (status === "rest") {
      continue;
    } else {
      break;
    }
  }
  return streak;
}

// ── Outcome bar segments ────────────────────────────────────────────────────

export interface OutcomeCounts {
  completed: number;
  moved: number;
  pending: number;
  skipped: number;
  missed: number;
  planned: number;
}

/**
 * `completed` here is completed-and-not-moved: `moved` is a SUBSET of the
 * report's `completed` (a moved workout that got done counts as both), so
 * showing them as two stacked segments of the raw numbers would double-count.
 * `upcoming` is the remainder of `planned` the other counts don't explain —
 * workouts still ahead of you.
 */
export type OutcomeKind = "completed" | "moved" | "pending" | "skipped" | "missed" | "upcoming";

export interface OutcomeSegment {
  kind: OutcomeKind;
  count: number;
  x: number;
  width: number;
}

export interface OutcomeSegmentOptions {
  /** Surface gap between adjacent segments, subtracted from the drawable width. */
  gap?: number;
  /** Floor for a nonzero segment, so a count of 1 never renders as invisible. */
  minWidth?: number;
}

export function outcomeSegments(
  counts: OutcomeCounts,
  totalWidth: number,
  { gap = 2, minWidth = 2 }: OutcomeSegmentOptions = {},
): OutcomeSegment[] {
  const moved = Math.max(0, counts.moved);
  const completedOnPlan = Math.max(0, counts.completed - moved);
  const accounted = completedOnPlan + moved + counts.pending + counts.skipped + counts.missed;
  // Never shrink reality to fit the plan: if the counts exceed `planned` the
  // bar is drawn out of the counts, not out of a number they contradict.
  const denominator = Math.max(counts.planned, accounted);
  const upcoming = Math.max(0, denominator - accounted);

  const all: Array<{ kind: OutcomeKind; count: number }> = [
    { kind: "completed", count: completedOnPlan },
    { kind: "moved", count: moved },
    { kind: "pending", count: counts.pending },
    { kind: "skipped", count: counts.skipped },
    { kind: "missed", count: counts.missed },
    { kind: "upcoming", count: upcoming },
  ];
  const raw = all.filter((s) => s.count > 0);

  if (raw.length === 0 || denominator <= 0) return [];

  const available = Math.max(0, totalWidth - (raw.length - 1) * gap);
  const widths = raw.map((s) => (s.count / denominator) * available);

  // Floor the tiny ones, then buy those pixels back from the segments that
  // have slack — proportionally to how much slack each has, so the bar's
  // total width stays exactly what the caller asked for.
  let deficit = 0;
  for (let i = 0; i < widths.length; i++) {
    if (widths[i]! < minWidth) {
      deficit += minWidth - widths[i]!;
      widths[i] = minWidth;
    }
  }
  if (deficit > 0) {
    const slack = widths.map((w) => Math.max(0, w - minWidth));
    const slackTotal = slack.reduce((a, b) => a + b, 0);
    if (slackTotal > 0) {
      const take = Math.min(deficit, slackTotal);
      for (let i = 0; i < widths.length; i++) {
        widths[i] = widths[i]! - (slack[i]! / slackTotal) * take;
      }
    }
  }

  let x = 0;
  return raw.map((s, i) => {
    const seg = { kind: s.kind, count: s.count, x, width: widths[i]! };
    x += widths[i]! + gap;
    return seg;
  });
}

// ── Stacked weekly bars ─────────────────────────────────────────────────────

export interface StackedSegment {
  key: "low" | "high";
  y: number;
  height: number;
}

/**
 * Low (bottom, at the baseline) + high (top) as drawn rectangles, given each
 * one's honest pixel height. The 2px surface gap is subtracted from the UPPER
 * segment, so the stack's overall top still sits at `baselineY - (low + high)`
 * — the total remains readable as the total. A nonzero segment shorter than
 * `minSegment` is drawn at `minSegment` (a 6-minute quality block must not
 * disappear); that is the one case where the stack's top overstates by a pixel
 * or two, and it only ever happens to segments too small to read anyway.
 */
export function stackedBarSegments(
  heights: { low: number; high: number },
  baselineY: number,
  { gap = 2, minSegment = 2 }: { gap?: number; minSegment?: number } = {},
): StackedSegment[] {
  const out: StackedSegment[] = [];
  let cursor = baselineY;
  if (heights.low > 0) {
    const h = Math.max(minSegment, heights.low);
    out.push({ key: "low", y: cursor - h, height: h });
    cursor -= h;
  }
  if (heights.high > 0) {
    const g = heights.low > 0 ? gap : 0;
    const h = Math.max(minSegment, heights.high - g);
    out.push({ key: "high", y: cursor - g - h, height: h });
  }
  return out;
}

// ── Diverging scales ────────────────────────────────────────────────────────

/**
 * A domain that covers the data AND the reference line it diverges from, with
 * a little breathing room at both ends. Deliberately NOT symmetric about
 * `center`: for lap heart rate against an easy ceiling, forcing symmetry would
 * waste half the plot on a region the run never visited.
 */
export function divergingDomain(
  values: readonly number[],
  center: number,
  padFraction = 0.08,
): { lo: number; hi: number } {
  const lo = Math.min(center, ...values);
  const hi = Math.max(center, ...values);
  const span = hi - lo;
  const pad = span > 0 ? span * padFraction : Math.max(1, Math.abs(center) * 0.02);
  return { lo: lo - pad, hi: hi + pad };
}

/**
 * Half-width of a symmetric diverging axis: the largest distance any value
 * sits from `center`. Symmetry IS required here — a "faster" bar and a "faded"
 * bar of the same magnitude must be the same length, or the chart lies about
 * which way a run went. Never zero, so an all-flat series still gets an axis.
 */
export function symmetricHalfExtent(values: readonly number[], center = 0): number {
  let max = 0;
  for (const v of values) max = Math.max(max, Math.abs(v - center));
  return max > 0 ? max : 1;
}

// ── Date ticks ──────────────────────────────────────────────────────────────

/** The earliest charted date within each calendar month present, in order. */
export function monthStartDates(dates: readonly string[]): string[] {
  const firstByMonth = new Map<string, string>();
  for (const d of dates) {
    const month = d.slice(0, 7);
    const current = firstByMonth.get(month);
    if (current == null || d < current) firstByMonth.set(month, d);
  }
  return [...firstByMonth.values()].sort();
}

// ── Bar geometry ────────────────────────────────────────────────────────────

function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * A vertical bar with either end rounded. Round the DATA end only and leave
 * the end that meets the baseline square — a bar with two rounded ends reads
 * as a floating pill and quietly detaches the mark from its zero. (A bar
 * diverging from a ceiling rounds whichever end is away from that line, so
 * `bottom` is the right choice for the under-the-ceiling laps.)
 */
export function verticalBarPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  ends: { top?: boolean; bottom?: boolean } = {},
): string {
  const rr = Math.max(0, Math.min(r, w / 2, ends.top && ends.bottom ? h / 2 : h));
  const top = ends.top ? rr : 0;
  const bottom = ends.bottom ? rr : 0;
  const parts = [`M${n(x)},${n(y + h - bottom)}`, `L${n(x)},${n(y + top)}`];
  if (ends.top) parts.push(`Q${n(x)},${n(y)} ${n(x + rr)},${n(y)}`);
  parts.push(`L${n(x + w - top)},${n(y)}`);
  if (ends.top) parts.push(`Q${n(x + w)},${n(y)} ${n(x + w)},${n(y + rr)}`);
  parts.push(`L${n(x + w)},${n(y + h - bottom)}`);
  if (ends.bottom) {
    parts.push(`Q${n(x + w)},${n(y + h)} ${n(x + w - rr)},${n(y + h)}`);
    parts.push(`L${n(x + bottom)},${n(y + h)}`);
    parts.push(`Q${n(x)},${n(y + h)} ${n(x)},${n(y + h - rr)}`);
  }
  parts.push("Z");
  return parts.join(" ");
}

/** The common case: rounded at the top, square at the baseline. */
export function roundedTopBarPath(x: number, y: number, w: number, h: number, r: number): string {
  return verticalBarPath(x, y, w, h, r, { top: true });
}

/**
 * A horizontal bar with either, both, or neither end rounded — the outer ends
 * of a stacked bar round, the interior joins stay square.
 */
export function horizontalBarPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  ends: { left?: boolean; right?: boolean } = {},
): string {
  const rr = Math.max(0, Math.min(r, h / 2, w / 2));
  const left = ends.left ? rr : 0;
  const right = ends.right ? rr : 0;
  const parts = [`M${n(x + left)},${n(y)}`, `L${n(x + w - right)},${n(y)}`];
  if (ends.right) {
    parts.push(`Q${n(x + w)},${n(y)} ${n(x + w)},${n(y + rr)}`);
    parts.push(`L${n(x + w)},${n(y + h - rr)}`);
    parts.push(`Q${n(x + w)},${n(y + h)} ${n(x + w - rr)},${n(y + h)}`);
  } else {
    parts.push(`L${n(x + w)},${n(y + h)}`);
  }
  parts.push(`L${n(x + left)},${n(y + h)}`);
  if (ends.left) {
    parts.push(`Q${n(x)},${n(y + h)} ${n(x)},${n(y + h - rr)}`);
    // The straight left edge BETWEEN the two corner arcs. Without it the two
    // curves join directly and the end bows into a half-pill — invisible when
    // rr === h/2, wrong for every smaller radius.
    parts.push(`L${n(x)},${n(y + rr)}`);
    parts.push(`Q${n(x)},${n(y)} ${n(x + rr)},${n(y)}`);
  }
  parts.push("Z");
  return parts.join(" ");
}

/**
 * A record achieved in the last 7 days (inclusive) earns a quiet "New" pill
 * (earned-moments spec §1). Malformed or future dates never count.
 */
export function isRecentRecord(dateIso: string, todayIso: string): boolean {
  const d = Date.parse(dateIso);
  const t = Date.parse(todayIso);
  if (Number.isNaN(d) || Number.isNaN(t)) return false;
  const days = (t - d) / 86_400_000;
  return days >= 0 && days <= 7;
}

/**
 * Whether the latest weekly review is newer than what the user last opened
 * (earned-moments spec §2). ISO week-start strings compare lexically.
 */
export function reviewUnseen(latestWeekStart: string | null, stored: string | null): boolean {
  return !!latestWeekStart && (!stored || stored < latestWeekStart);
}
