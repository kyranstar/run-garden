import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type InsightsResponse } from "@rg/api-client";
import { Card, EmptyState, formatDayLong, formatDayShort, Sheet, Spinner } from "../components.js";
import { AdherenceChart, ChartFrame, RunSeriesChart, WeeklyDurationChart } from "../charts.js";

// Derived from InsightsResponse (the worker's actual payload) rather than
// redeclared here — this is exactly what task A9 replaced the blind `as`
// casts with.
type InterpretedMetric = InsightsResponse["interpreted"][number];
type MetricDetail = NonNullable<InterpretedMetric["detail"]>;
type MetricRunDetail = MetricDetail["runs"][number];
type MetricLapDetail = NonNullable<MetricRunDetail["laps"]>[number];
/** The insufficient-data branch is identical across every MetricResult<T>, whatever T is. */
type MetricInsufficient = Extract<InsightsResponse["decoupling"], { status: "insufficient_data" }>;

function InsufficientNote({ m }: { m: MetricInsufficient }) {
  return (
    <p className="muted">
      {m.explanation} {m.have} of {m.needed} available so far.
    </p>
  );
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function BandPill({ band }: { band?: string }) {
  // Normal earns silence: a metric that's fine doesn't need a badge saying so.
  if (!band || band === "healthy") return null;
  const label = band === "watch" ? "Watch" : band === "low" ? "Below norm" : "High";
  const cls = band === "watch" ? "pill-warn" : "pill-neutral";
  return <span className={`pill ${cls}`}>{label}</span>;
}

function MetricCard({ m, onDrill }: { m: InterpretedMetric; onDrill?: (m: InterpretedMetric) => void }) {
  const drillable = !!m.detail && !!onDrill;
  return (
    <div
      className={`metric-card${drillable ? " metric-drillable" : ""}`}
      {...(drillable
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: () => onDrill!(m),
            onKeyDown: (e: React.KeyboardEvent) => {
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
        {m.status === "ok" ? <BandPill band={m.band} /> : null}
      </div>
      {m.status === "ok" ? (
        <div className="metric-value">
          {m.value}
          {m.range ? <span className="faint"> · {m.range}</span> : null}
        </div>
      ) : null}
      <p className="muted">{m.meaning}</p>
      {m.status === "ok" && m.suggestion ? <p className="metric-suggestion">{m.suggestion}</p> : null}
      <p className="faint">{m.sampleNote}</p>
      {drillable ? <p className="metric-drill-hint">See the runs behind this →</p> : null}
    </div>
  );
}

/**
 * Per-lap HR bars for one run: each bar's height tracks the lap's average HR,
 * red bars breached the easy ceiling, and the dashed line IS the ceiling —
 * so "where it went wrong" is visible at a glance.
 */
function LapHrBars({ laps, threshold }: { laps: MetricLapDetail[]; threshold?: { value: number; unit?: string } }) {
  const withHr = laps.filter((l) => (l.avgHr ?? 0) > 0);
  if (withHr.length < 2) return null;
  const max = Math.max(...withHr.map((l) => l.avgHr!), threshold?.value ?? 0) * 1.06;
  const min = Math.min(...withHr.map((l) => l.avgHr!), threshold?.value ?? Infinity) * 0.92;
  const h = 72;
  const y = (hr: number) => h - ((hr - min) / (max - min)) * h;
  const bw = Math.min(28, Math.max(10, 220 / withHr.length));
  const width = withHr.length * (bw + 3);
  return (
    <svg
      viewBox={`0 0 ${width} ${h + 14}`}
      className="lap-bars"
      role="img"
      aria-label={`Per-lap heart rate${threshold ? `, ceiling ${threshold.value}` : ""}`}
    >
      {withHr.map((l, i) => {
        const top = y(l.avgHr!);
        return (
          <g key={l.lapIndex}>
            <rect
              x={i * (bw + 3)}
              y={top}
              width={bw}
              height={h - top}
              rx={2}
              className={l.over ? "lap-bar lap-bar-over" : "lap-bar"}
            >
              <title>{`Lap ${l.lapIndex}: ${l.avgHr} bpm${l.over ? " — over the ceiling" : ""}`}</title>
            </rect>
            <text x={i * (bw + 3) + bw / 2} y={h + 11} textAnchor="middle" className="lap-label">
              {l.lapIndex}
            </text>
          </g>
        );
      })}
      {threshold ? (
        <>
          <line x1={0} x2={width} y1={y(threshold.value)} y2={y(threshold.value)} className="lap-ceiling" />
          <text x={width - 2} y={y(threshold.value) - 3} textAnchor="end" className="lap-ceiling-label">
            {threshold.value}
            {threshold.unit ? ` ${threshold.unit}` : ""}
          </text>
        </>
      ) : null}
    </svg>
  );
}

function MetricDrilldown({ m, onClose }: { m: InterpretedMetric; onClose: () => void }) {
  const d = m.detail!;
  return (
    <Sheet open onClose={onClose} title={m.title}>
      <div className="stack">
        <p className="muted">{d.explain}</p>
        <ul className="drill-runs">
          {d.runs.map((r) => (
            <li key={r.activityId} className={r.over ? "drill-run drill-run-over" : "drill-run"}>
              <div className="drill-run-head">
                <span className="date">{formatDayShort(r.date)}</span>
                <span className="drill-run-title">{r.title ?? "Run"}</span>
                {r.value ? <span className="drill-run-value">{r.value}</span> : null}
              </div>
              {r.note ? <p className="faint">{r.note}</p> : null}
              {r.laps && r.laps.length >= 2 ? (
                <LapHrBars laps={r.laps} threshold={d.threshold} />
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}

const METRIC_GROUPS: Array<{ title: string; ids: string[] }> = [
  { title: "Load", ids: ["loadRatio", "ramp", "monotony"] },
  { title: "Recovery", ids: ["restingHr", "hrv", "hardStack"] },
  { title: "Execution", ids: ["lowIntensityShare", "easyDiscipline", "pacing"] },
];

export function InsightsScreen() {
  const insights = useQuery({ queryKey: ["insights"], queryFn: api.insights, staleTime: 60_000 });
  const [drill, setDrill] = useState<InterpretedMetric | null>(null);

  if (insights.isLoading) return <Spinner label="Computing insights" />;
  if (!insights.data) return <EmptyState title="Couldn't load insights" />;

  const { consistency, weekly, efficiency, decoupling, records, reviews, interpreted } = insights.data;

  const recentWeeks = consistency.weeklyBreakdown.slice(-8);
  const recentTraining = weekly.weeks.slice(-8);

  return (
    <div className="stack">
      <h1 className="screen-title">Insights</h1>

      {METRIC_GROUPS.map((g) => {
        const metrics = interpreted.filter((m) => g.ids.includes(m.id));
        if (metrics.length === 0) return null;
        return (
          <Card title={g.title} key={g.title}>
            <div className="metric-grid">
              {metrics.map((m) => (
                <MetricCard key={m.id} m={m} onDrill={setDrill} />
              ))}
            </div>
          </Card>
        );
      })}

      <Card title="Plan consistency · last 12 weeks">
        <div className="row" style={{ gap: "1.4rem", marginBottom: "0.8rem", flexWrap: "wrap" }}>
          <Stat label="Planned" value={consistency.planned} />
          <Stat label="Completed" value={consistency.completed} />
          <Stat label="Moved" value={consistency.moved} note="not a failure" />
          <Stat label="Skipped" value={consistency.skipped} />
          <Stat label="Missed" value={consistency.missed} />
          {consistency.unresolved > 0 ? <Stat label="Unresolved" value={consistency.unresolved} /> : null}
        </div>
        {recentWeeks.length > 0 ? (
          <ChartFrame
            title="Completed vs planned by week"
            summary={`Adherence ${(consistency.adherenceRate * 100).toFixed(0)} percent across ${consistency.planned} planned workouts. ${recentWeeks.map((w) => `Week of ${w.weekStart}: ${w.completed} of ${w.planned}.`).join(" ")}`}
            note={`Overall adherence ${(consistency.adherenceRate * 100).toFixed(0)}% · moving a workout still counts as completing it`}
          >
            <AdherenceChart weeks={recentWeeks} />
          </ChartFrame>
        ) : (
          <p className="muted">Weekly breakdown appears once the plan has run for a week.</p>
        )}
      </Card>

      <Card title="Weekly training">
        {recentTraining.length === 0 ? (
          <p className="muted">Completed runs will appear here.</p>
        ) : (
          <ChartFrame
            title="Training time per week"
            subtitle="Stacked: easy vs quality time (from completed, matched runs)"
            legend={[
              { label: "Easy", colorVar: "--chart-1" },
              { label: "Quality", colorVar: "--chart-2" },
            ]}
            summary={recentTraining
              .map(
                (w) =>
                  `Week of ${w.weekStart}: ${Math.round(w.durationSeconds / 60)} minutes over ${w.runCount} runs.`,
              )
              .join(" ")}
            note={
              weekly.fourWeekAvgDuration
                ? `4-week average: ${Math.round(weekly.fourWeekAvgDuration / 3600 * 10) / 10} h/week · n=${recentTraining.reduce((s, w) => s + w.runCount, 0)} runs`
                : `n=${recentTraining.reduce((s, w) => s + w.runCount, 0)} runs`
            }
          >
            <WeeklyDurationChart
              weeks={recentTraining.map((w) => ({
                weekStart: w.weekStart,
                // WeeklyDurationChart still takes the old easy/quality prop names;
                // low/high (zone-based, from A7) is now the more accurate split.
                // B3 renames the chart's own props properly.
                easySeconds: w.lowSeconds,
                qualitySeconds: w.highSeconds,
              }))}
            />
          </ChartFrame>
        )}
      </Card>

      <Card title="Aerobic efficiency">
        {efficiency.status === "ok" ? (
          <ChartFrame
            title="Meters per heartbeat on comparable easy runs"
            subtitle={efficiency.comparisonNote}
            summary={`Aerobic efficiency across ${efficiency.sampleSize} comparable easy runs.${efficiency.value.trend ? ` Trend ${efficiency.value.trend.pct >= 0 ? "up" : "down"} ${Math.abs(efficiency.value.trend.pct).toFixed(1)} percent over ${efficiency.value.trend.n} runs.` : ""}`}
            note={`n=${efficiency.sampleSize} runs · higher is easier speed at the same heart rate · noisy week to week`}
          >
            <RunSeriesChart
              points={efficiency.value.perRun.map((p) => ({ date: p.date, value: p.efficiency }))}
              unit="m/beat"
              seriesLabel="Aerobic efficiency"
            />
          </ChartFrame>
        ) : (
          <InsufficientNote m={efficiency} />
        )}
      </Card>

      <Card title="Aerobic decoupling (Pa:HR)">
        {decoupling.status === "ok" ? (
          <ChartFrame
            title="Pace-adjusted speed-to-heart-rate decoupling, first half vs second half of steady runs"
            subtitle={decoupling.comparisonNote}
            summary={`Median Pa:HR decoupling ${decoupling.value.medianPct.toFixed(1)} percent across ${decoupling.sampleSize} steady runs.`}
            note={`n=${decoupling.sampleSize} steady runs · median ${decoupling.value.medianPct.toFixed(1)}%${
              efficiency.status === "ok" && efficiency.value.trend
                ? ` · efficiency trend ${signed(efficiency.value.trend.pct)}% over ${efficiency.value.trend.n} runs`
                : ""
            }`}
          >
            <RunSeriesChart
              points={decoupling.value.perRun.map((p) => ({ date: p.date, value: p.decouplingPct }))}
              unit="% decoupling"
              seriesLabel="Aerobic decoupling"
              colorVar="--chart-2"
              decimals={1}
            />
          </ChartFrame>
        ) : (
          <InsufficientNote m={decoupling} />
        )}
      </Card>

      {records.length > 0 ? (
        <Card title="Quiet records">
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {records.map((r) => (
              <li key={r.id} style={{ marginBottom: "0.5rem" }}>
                <strong>{r.title}:</strong> {r.value}{" "}
                <span className="faint">({formatDayLong(r.achievedOn)})</span>
                <div className="faint">{r.rule}</div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {reviews.length > 0 ? (
        <Card title="Weekly reviews">
          <div className="stack">
            {reviews.map((r) => (
              <div key={r.weekStart}>
                <p style={{ fontWeight: 650 }}>Week of {formatDayLong(r.weekStart)}</p>
                {r.narrative ? (
                  <p className="muted" style={{ whiteSpace: "pre-wrap" }}>
                    {r.narrative}
                  </p>
                ) : (
                  <p className="muted">
                    {String((r.facts as { completed?: number }).completed ?? 0)} of{" "}
                    {String((r.facts as { planned?: number }).planned ?? 0)} planned workouts completed.
                  </p>
                )}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {drill?.detail ? <MetricDrilldown m={drill} onClose={() => setDrill(null)} /> : null}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div>
      <div style={{ fontSize: "1.3rem", fontWeight: 650, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div className="faint">
        {label}
        {note ? ` · ${note}` : ""}
      </div>
    </div>
  );
}
