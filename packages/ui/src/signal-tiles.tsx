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

export type TileVisual = "gauge" | "sparkline" | "strip" | "none";

/**
 * Which inline visual a tile draws, by priority: gauge > sparkline > strip.
 * A present-but-empty `series`/`strip` array counts as absent — there is
 * nothing honest to draw from zero points, so selection falls through to
 * the next candidate (or `"none"`) exactly as if the field were unset.
 */
export function pickTileVisual(m: {
  gauge?: MetricGauge;
  series?: MetricSeriesPoint[];
  strip?: MetricStripCell[];
}): TileVisual {
  if (m.gauge) return "gauge";
  if (m.series && m.series.length > 0) return "sparkline";
  if (m.strip && m.strip.length > 0) return "strip";
  return "none";
}

// ── Status-strip priority (pure; unit-tested) ───────────────────────────────

export type StatusStripSeverity = "high" | "watch" | "clear";

export interface StatusStripPick {
  severity: StatusStripSeverity;
  /** Absent exactly when severity is "clear" — there is no single metric to point at. */
  metric?: InterpretedMetric;
}

/** First `band==="high"` metric wins; else first `band==="watch"`; else "clear". */
export function pickStatusStripMetric(interpreted: readonly InterpretedMetric[]): StatusStripPick {
  const high = interpreted.find((m) => m.band === "high");
  if (high) return { severity: "high", metric: high };
  const watch = interpreted.find((m) => m.band === "watch");
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
 */
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
    <div className="gauge" aria-hidden="true">
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
        <span className="gauge-tick" style={{ left: `${bandLeft}%` }}>
          {formatGaugeLabel(g.healthyLo)}
        </span>
        <span className="gauge-tick" style={{ left: `${bandRight}%` }}>
          {formatGaugeLabel(g.healthyHi)}
        </span>
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
  const drillable = !!m.detail && !!onDrill;
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
          {visual === "gauge" ? <Gauge g={m.gauge!} /> : null}
          {visual === "sparkline" ? <Sparkline series={m.series!} /> : null}
          {visual === "strip" ? <StripBoxes strip={m.strip!} kind={stripKindForMetricId(m.id)} /> : null}
          <p className="muted signal-meaning">{m.meaning}</p>
          {m.suggestion ? <p className="metric-suggestion">{m.suggestion}</p> : null}
          {m.staleNote ? <p className="faint signal-stale">{m.staleNote}</p> : null}
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

function statusStripBaseText(pick: StatusStripPick, total: number): string {
  if (pick.severity === "clear" || !pick.metric) return `All ${total} signals in range`;
  const glyph = pick.severity === "high" ? "⚠" : "•";
  return `${glyph} ${pick.metric.title}: ${pick.metric.value ?? ""} — ${actionablePhrase(pick.metric)}`;
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
 */
export function StatusStrip({
  interpreted,
  adherencePct,
}: {
  interpreted: readonly InterpretedMetric[];
  adherencePct?: number;
}) {
  const pick = pickStatusStripMetric(interpreted);
  const suffix = typeof adherencePct === "number" ? ` · adherence ${adherencePct}%` : "";
  const text = statusStripBaseText(pick, interpreted.length) + suffix;
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
      {text}
    </div>
  );
}
