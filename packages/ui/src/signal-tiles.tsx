import type { KeyboardEvent } from "react";
import type { InsightsResponse } from "@rg/api-client";
import { dateX } from "./chart-kit.js";

/**
 * Signal tiles — the compact per-metric cards on the rebuilt Insights
 * screen, plus the sticky-friendly status strip that summarizes them.
 *
 * Types are derived from `InsightsResponse` (the worker's actual payload,
 * via `@rg/api-client`) rather than imported from `@rg/analytics` directly —
 * `@rg/ui` doesn't depend on `@rg/analytics`, and this is the same pattern
 * `screens/insights.tsx` already uses for exactly that reason.
 */
export type InterpretedMetric = InsightsResponse["interpreted"][number];
export type MetricGauge = NonNullable<InterpretedMetric["gauge"]>;
export type MetricSeriesPoint = NonNullable<InterpretedMetric["series"]>[number];
export type MetricStripCell = NonNullable<InterpretedMetric["strip"]>[number];

// ── Tile-visual selection (pure; unit-tested) ───────────────────────────────

export type TileVisual = "gauge" | "gauge+spark" | "sparkline" | "strip" | "none";

/**
 * Which inline visual(s) a tile draws.
 *
 * A gauge and a sparkline answer different questions and the spec asks for
 * both on the recovery tiles: the gauge says where today sits against the
 * healthy band, the sparkline says how it got there. A gauge alone can't
 * distinguish "46 bpm, steady all month" from "46 bpm, climbing for a week",
 * which is the entire point of a recovery signal — so when a metric carries
 * both, both are drawn (`"gauge+spark"`, sparkline beneath the gauge).
 *
 * This is a shape rule, not an id list: any metric shipping a gauge and a
 * daily series gets both (today that is restingHr, hrv and loadRatio, whose
 * series is 56 daily ratios). Falling back: gauge > sparkline > strip.
 *
 * A present-but-empty `series`/`strip` array counts as absent — there is
 * nothing honest to draw from zero points, so selection falls through to
 * the next candidate (or `"none"`) exactly as if the field were unset.
 */
export function pickTileVisual(m: {
  gauge?: MetricGauge;
  series?: MetricSeriesPoint[];
  strip?: MetricStripCell[];
}): TileVisual {
  const hasSeries = !!m.series && m.series.length > 0;
  if (m.gauge) return hasSeries ? "gauge+spark" : "gauge";
  if (hasSeries) return "sparkline";
  if (m.strip && m.strip.length > 0) return "strip";
  return "none";
}

/**
 * Whether a tile has a drilldown worth opening — i.e. whether the sheet would
 * have anything in it that the tile doesn't already show.
 *
 * Two routes in. Per-run evidence (`detail`) is one. The other is a daily
 * `series` **paired with its `baseline` band**: the recovery metrics
 * (`restingHr`, `hrv`) carry no `detail` at all — their evidence is a run of
 * morning readings, not a list of runs — and the sheet draws them as a
 * baseline-band chart. Gating on `detail` alone (as this file originally did)
 * made the spec's "recovery drill-downs get the baseline-band daily chart"
 * unreachable: the tile was never clickable.
 *
 * The `baseline` half of that condition is load-bearing, not belt-and-braces:
 * `loadRatio` also ships a `series` (56 daily ratios) but no baseline band, so
 * a series-only test would put a chevron on it promising a sheet containing
 * nothing but the meaning text already printed on the tile.
 *
 * An empty `series` array counts as absent, matching `pickTileVisual`.
 */
export function hasDrilldown(m: {
  detail?: unknown;
  series?: MetricSeriesPoint[];
  baseline?: unknown;
}): boolean {
  return !!m.detail || (!!m.baseline && (m.series?.length ?? 0) > 0);
}

// ── Status-strip priority (pure; unit-tested) ───────────────────────────────

export type StatusStripSeverity = "high" | "watch" | "clear";

export interface StatusStripPick {
  severity: StatusStripSeverity;
  /** Absent exactly when severity is "clear" — there is no single metric to point at. */
  metric?: InterpretedMetric;
}

function isRenderedId(id: string, renderedIds?: ReadonlySet<string> | string[]): boolean {
  if (!renderedIds) return true;
  return Array.isArray(renderedIds) ? renderedIds.includes(id) : renderedIds.has(id);
}

/**
 * First `band==="high"` metric wins; else first `band==="watch"`; else
 * "clear".
 *
 * `renderedIds`, when given, restricts which metrics are even eligible to
 * headline the strip. The screen's grid renders a fixed whitelist of ids
 * (see `insights.tsx`'s `METRIC_GROUPS`) — without this filter, a metric the
 * worker started sending but the grid doesn't yet have a group for could
 * still win here, and the strip's click target (`scrollToSignal`) would
 * scroll to a `signal-${id}` element that was never rendered.
 *
 * A band alone is not enough to win (audit#2 (a4)): a metric carrying an
 * uncertainty marker — `bandNote` (the verdict doesn't survive its input's
 * error bar) or `staleNote` (the reading describes the past) — must never
 * headline the strip, whatever band arrived beside it. Both notes contract
 * to `band: undefined` on the worker side; this gate enforces the contract
 * where the alarm is actually raised, so no payload regression can put an
 * unconfident red banner at the top of the page.
 */
export function pickStatusStripMetric(
  interpreted: readonly InterpretedMetric[],
  renderedIds?: ReadonlySet<string> | string[],
): StatusStripPick {
  const eligible = interpreted.filter(
    (m) => isRenderedId(m.id, renderedIds) && m.status === "ok" && !m.bandNote && !m.staleNote,
  );
  const high = eligible.find((m) => m.band === "high");
  if (high) return { severity: "high", metric: high };
  const watch = eligible.find((m) => m.band === "watch");
  if (watch) return { severity: "watch", metric: watch };
  return { severity: "clear" };
}

/**
 * The first sentence of `text` (up to and including the first `.`/`!`/`?`),
 * or the trimmed whole string when there's no terminator to split on. Used
 * to keep the status strip's one-line summary short even when a metric's
 * `suggestion`/`meaning` runs to two or three sentences — a deterministic,
 * punctuation-based trim rather than an arbitrary character count, so it
 * never cuts a word in half.
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^[^.!?]*[.!?]?/);
  const sentence = (match?.[0] ?? "").trim();
  return sentence.length > 0 ? sentence : trimmed;
}

function actionablePhrase(m: InterpretedMetric): string {
  return firstSentence(m.suggestion ?? m.meaning);
}

// ── Strip kind (pure) ────────────────────────────────────────────────────

export type StripKind = "hard" | "easy";

/**
 * The only two strip-bearing metrics today are `hardStack` (7 boxes, one
 * per day, on=hard — see `computeHardDayStacking`'s `strip` field) and
 * `easyDiscipline` (one box per easy-designated run, on=stayed-easy — see
 * `computeEasyDiscipline`'s `ticks` field, mapped to `{date, on: t.easy}`
 * in `apps/worker/src/routes/misc.ts`). Both map `on` to "the highlighted/
 * good state" per `MetricStripCell`'s doc comment, so the polarity is NOT
 * ambiguous: hardStack on=true is a hard day (informational, not bad by
 * itself); easyDiscipline on=true is a run that stayed easy (good), so
 * on=false is a run that ran over the easy ceiling (worth flagging).
 */
export function stripKindForMetricId(id: string): StripKind {
  return id === "hardStack" ? "hard" : "easy";
}

// ── Gauge ────────────────────────────────────────────────────────────────

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function formatGaugeLabel(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Horizontal bullet gauge: a 6px track spanning [min, max], a shaded
 * healthy band, and a 2px ink-colored value marker. The marker clamps to
 * the track and shows a small overflow arrow when the real value fell
 * outside [min, max] — the track's extent is honest, not stretched to fit
 * an outlier.
 *
 * `aria-label` (not `aria-hidden`): the marker's raw position is not
 * always recoverable from the tile's other visible text — e.g. loadRatio
 * shows "+X% vs norm" as its headline value while the gauge draws the
 * underlying 0.5–2 ratio, so the ratio itself has no visible text form
 * anywhere else on the tile. `role="img"` pairs with it so the label is
 * exposed as the element's accessible name (a bare `<div>`'s implicit
 * `generic` role doesn't reliably support `aria-label` on its own, per
 * ARIA's global-attribute rules — the same `role="img"` pairing every
 * other chart in this app already uses, see charts.tsx).
 */
function gaugeAriaLabel(g: MetricGauge): string {
  return (
    `${formatGaugeLabel(g.value)} on a ${formatGaugeLabel(g.min)}–${formatGaugeLabel(g.max)} scale, ` +
    `healthy ${formatGaugeLabel(g.healthyLo)}–${formatGaugeLabel(g.healthyHi)}`
  );
}

function Gauge({ g }: { g: MetricGauge }) {
  const span = g.max - g.min;
  const pct = (v: number): number => (span > 0 ? clamp01((v - g.min) / span) * 100 : 50);
  const rawPct = span > 0 ? ((g.value - g.min) / span) * 100 : 50;
  const markerPct = Math.min(100, Math.max(0, rawPct));
  const clampedLow = rawPct < 0;
  const clampedHigh = rawPct > 100;
  const bandLeft = pct(g.healthyLo);
  const bandRight = pct(g.healthyHi);

  return (
    <div className="gauge" role="img" aria-label={gaugeAriaLabel(g)}>
      <div className="gauge-track">
        <div
          className="gauge-band"
          style={{ left: `${Math.min(bandLeft, bandRight)}%`, width: `${Math.abs(bandRight - bandLeft)}%` }}
        />
        <div className="gauge-marker" style={{ left: `${markerPct}%` }} />
        {clampedLow ? (
          <span className="gauge-overflow gauge-overflow-lo">‹</span>
        ) : null}
        {clampedHigh ? (
          <span className="gauge-overflow gauge-overflow-hi">›</span>
        ) : null}
      </div>
      <div className="gauge-scale">
        <span className="gauge-end gauge-end-lo">{formatGaugeLabel(g.min)}</span>
        {/* A band edge sitting exactly on a track end has its number printed
            twice, in the same place: restingHr's healthyLo IS its min, hrv's
            and lowIntensityShare's healthyHi IS their max. Two absolutely
            positioned labels then overlap into unreadable pulp ("386" for two
            36s). The end label wins — it's the one that anchors the scale. */}
        {g.healthyLo > g.min ? (
          <span className="gauge-tick" style={{ left: `${bandLeft}%` }}>
            {formatGaugeLabel(g.healthyLo)}
          </span>
        ) : null}
        {g.healthyHi < g.max ? (
          <span className="gauge-tick" style={{ left: `${bandRight}%` }}>
            {formatGaugeLabel(g.healthyHi)}
          </span>
        ) : null}
        <span className="gauge-end gauge-end-hi">{formatGaugeLabel(g.max)}</span>
      </div>
    </div>
  );
}

// ── Sparkline ────────────────────────────────────────────────────────────

const SPARK_W = 100;
const SPARK_H = 28;
const SPARK_PAD = 4;

/**
 * Last 14 points, no axes, ~28px tall, width fills the tile. Uses
 * `dateX` (chart-kit) for x so points land proportional to elapsed time,
 * not just index — consistent with every other chart in the app.
 */
function Sparkline({ series }: { series: MetricSeriesPoint[] }) {
  const pts = series.slice(-14);
  if (pts.length === 0) return null;
  const values = pts.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo;
  const x = dateX(
    pts.map((p) => p.date),
    SPARK_W,
    0,
  );
  const y = (v: number): number =>
    span > 0 ? SPARK_H - SPARK_PAD - ((v - lo) / span) * (SPARK_H - 2 * SPARK_PAD) : SPARK_H / 2;
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.date).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1]!;

  return (
    <svg className="spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" aria-hidden="true">
      {pts.length > 1 ? <path d={path} fill="none" stroke="var(--chart-3)" strokeWidth={1.5} /> : null}
      <circle cx={x(last.date)} cy={y(last.value)} r={2.5} fill="var(--chart-3)" />
    </svg>
  );
}

// ── StripBoxes ───────────────────────────────────────────────────────────

const STRIP_VISUAL_CAP = 20;

function stripBoxClassName(kind: StripKind, on: boolean): string {
  if (kind === "hard") return on ? "strip-box strip-box-hard" : "strip-box";
  return on ? "strip-box strip-box-easy" : "strip-box strip-box-over";
}

/**
 * hardStack: exactly 7 boxes, one per day, on=filled (hard day). Uncapped
 * — the metric always hands back a fixed 7-day window.
 *
 * easyDiscipline: one box per easy-designated run, on=filled-and-plain
 * (stayed easy). Capped visually at ~20 (most recent) with a "+N more"
 * faint suffix so a long streak doesn't blow out tile height; off boxes
 * (ran over the ceiling) get BOTH a danger-tinted fill AND a ✕ glyph —
 * color is never the only signal for the "bad" state.
 */
function StripBoxes({ strip, kind }: { strip: MetricStripCell[]; kind: StripKind }) {
  const overflow = kind === "easy" ? Math.max(0, strip.length - STRIP_VISUAL_CAP) : 0;
  const cells = kind === "easy" ? strip.slice(-STRIP_VISUAL_CAP) : strip;
  return (
    <div className="strip-boxes" aria-hidden="true">
      {cells.map((c, i) => (
        <span key={`${c.date}-${i}`} className={stripBoxClassName(kind, c.on)}>
          {kind === "easy" && !c.on ? <span className="strip-box-glyph">✕</span> : null}
        </span>
      ))}
      {overflow > 0 ? <span className="strip-more">+{overflow} more</span> : null}
    </div>
  );
}

// ── BandPill ─────────────────────────────────────────────────────────────

/**
 * Small status pill — reimplemented here (not imported from
 * `screens/insights.tsx`, which would be a reverse dependency) with
 * identical behavior to that screen's `BandPill`: normal earns silence,
 * so a `healthy` (or absent) band renders nothing.
 */
function BandPill({ band }: { band?: string }) {
  if (!band || band === "healthy") return null;
  const label = band === "watch" ? "Watch" : band === "low" ? "Below norm" : "High";
  const cls = band === "watch" ? "pill-warn" : "pill-neutral";
  return <span className={`pill ${cls}`}>{label}</span>;
}

// ── SignalTile ───────────────────────────────────────────────────────────

export function SignalTile({ m, onDrill }: { m: InterpretedMetric; onDrill?: (m: InterpretedMetric) => void }) {
  const drillable = !!onDrill && hasDrilldown(m);
  const visual = pickTileVisual(m);
  const insufficient = m.status === "insufficient_data";

  return (
    <div
      id={`signal-${m.id}`}
      className={`metric-card signal-tile${drillable ? " metric-drillable" : ""}`}
      {...(drillable
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: () => onDrill!(m),
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onDrill!(m);
              }
            },
          }
        : {})}
    >
      <div className="metric-head">
        <span className="metric-title">{m.title}</span>
        {!insufficient ? <BandPill band={m.band} /> : null}
      </div>

      {insufficient ? (
        <>
          <p className="muted">{m.meaning}</p>
          <p className="faint">{m.sampleNote}</p>
        </>
      ) : (
        <>
          <div className="metric-value">
            {m.value}
            {m.range ? <span className="faint"> · {m.range}</span> : null}
          </div>
          {visual === "gauge" || visual === "gauge+spark" ? <Gauge g={m.gauge!} /> : null}
          {visual === "gauge+spark" || visual === "sparkline" ? <Sparkline series={m.series!} /> : null}
          {visual === "strip" ? <StripBoxes strip={m.strip!} kind={stripKindForMetricId(m.id)} /> : null}
          <p className="muted signal-meaning">{m.meaning}</p>
          {m.suggestion ? <p className="metric-suggestion">{m.suggestion}</p> : null}
          {m.staleNote ? <p className="faint signal-stale">{m.staleNote}</p> : null}
          {/* Why this tile shows a number but no status pill (audit#2 (a4)):
              the verdict was withheld, and silence without the reason would
              read as "healthy" — the exact claim being declined. */}
          {m.bandNote ? <p className="faint signal-stale">{m.bandNote}</p> : null}
        </>
      )}

      {drillable ? (
        <span className="signal-drill-chevron" aria-hidden="true">
          ›
        </span>
      ) : null}
    </div>
  );
}

// ── StatusStrip ──────────────────────────────────────────────────────────

export interface StatusStripText {
  base: string;
  /**
   * Set only on the all-clear line, only when at least one metric is still
   * `insufficient_data` — those metrics were never assessed, so counting
   * them into "All N signals in range" would claim more than is honestly
   * known. Rendered as a separate, visually faint clause rather than
   * folded into `base` so the distinction survives to the DOM, not just
   * this function's prose.
   */
  awaitingCount?: number;
}

/**
 * The clear-branch count is `status === "ok"` metrics only — an
 * `insufficient_data` metric has no band at all, so it was never actually
 * confirmed "in range"; folding it into the headline count would be a
 * false claim, not silence-earned-by-being-normal.
 *
 * `renderedIds` restricts the count to the metrics the caller actually draws,
 * for the same reason `pickStatusStripMetric` takes it: "All 9 signals in
 * range" beside a grid of 8 tiles sends the reader hunting for a ninth that
 * was never on the page. The two must be filtered by the same set or the
 * strip's headline and its count disagree about what "the signals" means.
 */
export function statusStripBaseText(
  pick: StatusStripPick,
  interpreted: readonly InterpretedMetric[],
  renderedIds?: ReadonlySet<string> | string[],
): StatusStripText {
  if (pick.severity === "clear" || !pick.metric) {
    const eligible = interpreted.filter((m) => isRenderedId(m.id, renderedIds));
    const okCount = eligible.filter((m) => m.status === "ok").length;
    const awaitingCount = eligible.length - okCount;
    return {
      base: `All ${okCount} signals in range`,
      awaitingCount: awaitingCount > 0 ? awaitingCount : undefined,
    };
  }
  // High keeps its ⚠ — it says something the sentence doesn't. "Watch" used
  // to get a "•", which said nothing at all: the strip is one line, not a
  // list, so it read on the deployed page as a stray bullet in front of the
  // metric's name. The severity is already carried by the strip's left border
  // (.status-strip-watch) and by the phrase itself.
  const glyph = pick.severity === "high" ? "⚠ " : "";
  return { base: `${glyph}${pick.metric.title}: ${pick.metric.value ?? ""} — ${actionablePhrase(pick.metric)}` };
}

function scrollToSignal(id: string): void {
  const el = document.getElementById(`signal-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  // Programmatic focus needs a tabindex; only add one if the target isn't
  // already keyboard-focusable (a drillable tile already has tabIndex=0 —
  // don't clobber that with -1, which would pull it out of tab order).
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

/**
 * One-line summary, plain div (the screen decides sticky placement).
 * Priority: first `band==="high"` metric, else first `band==="watch"`,
 * else an all-clear line. Clicking/Enter-ing scrolls the referenced
 * `signal-${id}` tile into view and moves focus there; the all-clear state
 * has no single target and renders as a plain (non-interactive) strip.
 *
 * `renderedIds`, when passed, is forwarded to `pickStatusStripMetric` so the
 * strip can never headline (and offer a click target for) a metric the
 * caller isn't actually rendering as a tile.
 */
export function StatusStrip({
  interpreted,
  adherencePct,
  renderedIds,
}: {
  interpreted: readonly InterpretedMetric[];
  adherencePct?: number;
  renderedIds?: ReadonlySet<string> | string[];
}) {
  const pick = pickStatusStripMetric(interpreted, renderedIds);
  const { base, awaitingCount } = statusStripBaseText(pick, interpreted, renderedIds);
  const targetId = pick.metric?.id;

  return (
    <div
      className={`status-strip status-strip-${pick.severity}`}
      {...(targetId
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: () => scrollToSignal(targetId),
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                scrollToSignal(targetId);
              }
            },
          }
        : {})}
    >
      {base}
      {awaitingCount ? <span className="faint status-strip-awaiting"> · {awaitingCount} awaiting data</span> : null}
      {typeof adherencePct === "number" ? ` · adherence ${adherencePct}%` : null}
    </div>
  );
}
