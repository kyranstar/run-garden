import type { ReactNode } from "react";

/**
 * Small dependency-free SVG charts. Rules applied (dataviz method):
 * one axis, labeled with units; thin marks with 2px surface gaps; series
 * colors from the validated --chart-* tokens; a legend whenever ≥2 series;
 * per-mark tooltips via <title>; honest missing data; sample sizes and an
 * accessible text summary under every chart. No gradients, no dual axes.
 */

const M = { top: 8, right: 8, bottom: 26, left: 40 };

export interface ChartFrameProps {
  title: string;
  subtitle?: string;
  summary: string;
  note?: string;
  legend?: Array<{ label: string; colorVar: string }>;
  children: ReactNode;
}

export function ChartFrame({ title, subtitle, summary, note, legend, children }: ChartFrameProps) {
  return (
    <figure style={{ margin: 0 }} className="chart-block">
      <figcaption>
        <div className="chart-title">{title}</div>
        {subtitle ? <div className="chart-subtitle">{subtitle}</div> : null}
      </figcaption>
      {legend && legend.length > 1 ? (
        <div className="row" style={{ gap: "0.9rem", marginBottom: "0.3rem" }}>
          {legend.map((l) => (
            <span key={l.label} className="faint row" style={{ gap: "0.3rem" }}>
              <span
                aria-hidden
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: `var(${l.colorVar})`,
                  display: "inline-block",
                }}
              />
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

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const mult of [1, 2, 2.5, 5, 10]) {
    if (value <= mult * pow) return mult * pow;
  }
  return 10 * pow;
}

/** Weekly stacked duration bars: easy (chart-1) + quality (chart-2), hours axis. */
export function WeeklyDurationChart({
  weeks,
}: {
  weeks: Array<{ weekStart: string; easySeconds: number; qualitySeconds: number }>;
}) {
  const width = 560;
  const height = 180;
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const maxHours = niceMax(
    Math.max(0.5, ...weeks.map((w) => (w.easySeconds + w.qualitySeconds) / 3600)),
  );
  const barW = Math.min(34, (innerW / Math.max(1, weeks.length)) * 0.62);
  const step = innerW / Math.max(1, weeks.length);
  const y = (hours: number) => M.top + innerH - (hours / maxHours) * innerH;
  const ticks = [0, maxHours / 2, maxHours];

  return (
    <svg
      role="img"
      aria-label={`Weekly training duration, ${weeks.length} weeks`}
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", maxWidth: width, height: "auto", display: "block" }}
    >
      {ticks.map((t) => (
        <g key={t}>
          <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
          <text x={M.left - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--ink-faint)">
            {t % 1 === 0 ? t : t.toFixed(1)}h
          </text>
        </g>
      ))}
      {weeks.map((w, i) => {
        const x = M.left + i * step + (step - barW) / 2;
        const easyH = (w.easySeconds / 3600 / maxHours) * innerH;
        const qualH = (w.qualitySeconds / 3600 / maxHours) * innerH;
        const label = w.weekStart.slice(5).replace("-", "/");
        const totalMin = Math.round((w.easySeconds + w.qualitySeconds) / 60);
        return (
          <g key={w.weekStart}>
            {easyH > 0 ? (
              <rect x={x} y={M.top + innerH - easyH} width={barW} height={easyH} rx={3} fill="var(--chart-1)">
                <title>{`Week of ${w.weekStart}: easy ${Math.round(w.easySeconds / 60)} min`}</title>
              </rect>
            ) : null}
            {qualH > 0 ? (
              <rect
                x={x}
                y={M.top + innerH - easyH - qualH - 2}
                width={barW}
                height={Math.max(0, qualH)}
                rx={3}
                fill="var(--chart-2)"
              >
                <title>{`Week of ${w.weekStart}: quality ${Math.round(w.qualitySeconds / 60)} min`}</title>
              </rect>
            ) : null}
            {totalMin === 0 ? (
              <rect x={x} y={M.top + innerH - 2} width={barW} height={2} fill="var(--chart-track)">
                <title>{`Week of ${w.weekStart}: no recorded training`}</title>
              </rect>
            ) : null}
            <text x={x + barW / 2} y={height - 8} textAnchor="middle" fontSize={9.5} fill="var(--ink-faint)">
              {label}
            </text>
          </g>
        );
      })}
      {/* Unit ("h") is on the tick labels already — no separate axis label to overlap. */}
    </svg>
  );
}

/** Adherence: completed (fill) inside planned (track) per week, with n/n labels. */
export function AdherenceChart({
  weeks,
}: {
  weeks: Array<{ weekStart: string; planned: number; completed: number }>;
}) {
  const width = 560;
  const rowH = 26;
  const height = weeks.length * rowH + 8;
  const labelW = 74;
  const valueW = 46;
  const innerW = width - labelW - valueW;
  const maxPlanned = Math.max(1, ...weeks.map((w) => w.planned));

  return (
    <svg
      role="img"
      aria-label={`Plan adherence by week, ${weeks.length} weeks`}
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", maxWidth: width, height: "auto", display: "block" }}
    >
      {weeks.map((w, i) => {
        const yy = i * rowH + 6;
        const trackW = (w.planned / maxPlanned) * innerW;
        const fillW = w.planned > 0 ? (w.completed / maxPlanned) * innerW : 0;
        return (
          <g key={w.weekStart}>
            <text x={0} y={yy + 12} fontSize={10} fill="var(--ink-faint)">
              {w.weekStart.slice(5).replace("-", "/")}
            </text>
            <rect x={labelW} y={yy} width={Math.max(trackW, 2)} height={14} rx={4} fill="var(--chart-track)">
              <title>{`Week of ${w.weekStart}: ${w.planned} planned`}</title>
            </rect>
            {fillW > 0 ? (
              <rect x={labelW} y={yy} width={fillW} height={14} rx={4} fill="var(--chart-1)">
                <title>{`Week of ${w.weekStart}: ${w.completed} of ${w.planned} completed`}</title>
              </rect>
            ) : null}
            <text x={labelW + Math.max(trackW, 2) + 8} y={yy + 11.5} fontSize={10.5} fill="var(--ink-soft)">
              {w.completed}/{w.planned}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Per-run line for aerobic efficiency (meters per beat) or drift (%). */
export function RunSeriesChart({
  points,
  unit,
  seriesLabel,
  colorVar = "--chart-3",
  decimals = 2,
}: {
  points: Array<{ date: string; value: number }>;
  unit: string;
  seriesLabel: string;
  colorVar?: string;
  decimals?: number;
}) {
  const width = 560;
  const height = 160;
  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;
  const values = points.map((p) => p.value);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.1 || 1;
  const yLo = lo - pad;
  const yHi = hi + pad;
  const x = (i: number) => M.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => M.top + innerH - ((v - yLo) / (yHi - yLo)) * innerH;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");

  return (
    <svg
      role="img"
      aria-label={`${seriesLabel} across ${points.length} runs`}
      viewBox={`0 0 ${width} ${height}`}
      style={{ width: "100%", maxWidth: width, height: "auto", display: "block" }}
    >
      {[yLo + pad, (yLo + yHi) / 2, yHi - pad].map((t) => (
        <g key={t}>
          <line x1={M.left} x2={width - M.right} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
          <text x={M.left - 6} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--ink-faint)">
            {t.toFixed(decimals)}
          </text>
        </g>
      ))}
      {points.length > 1 ? <path d={path} fill="none" stroke={`var(${colorVar})`} strokeWidth={2} /> : null}
      {points.map((p, i) => (
        <circle key={p.date + i} cx={x(i)} cy={y(p.value)} r={4} fill={`var(${colorVar})`} stroke="var(--bg-raised)" strokeWidth={2}>
          <title>{`${p.date}: ${p.value.toFixed(decimals)} ${unit}`}</title>
        </circle>
      ))}
      <text x={x(0)} y={height - 8} fontSize={9.5} fill="var(--ink-faint)">
        {points[0]?.date.slice(5)}
      </text>
      {points.length > 1 ? (
        <text x={x(points.length - 1)} y={height - 8} textAnchor="end" fontSize={9.5} fill="var(--ink-faint)">
          {points[points.length - 1]!.date.slice(5)}
        </text>
      ) : null}
      <text x={M.left - 30} y={M.top + 2} fontSize={9.5} fill="var(--ink-faint)">
        {unit}
      </text>
    </svg>
  );
}
