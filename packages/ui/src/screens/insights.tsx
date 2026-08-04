import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type InsightsResponse } from "@rg/api-client";
import {
  Card,
  EmptyState,
  formatDayLong,
  formatDayShort,
  formatShortDate,
  Sheet,
  Spinner,
} from "../components.js";
import {
  ChartFrame,
  ConsistencyHeatmap,
  LapHrBars,
  OutcomeBar,
  RunSeriesChart,
  WeeklyDurationChart,
} from "../charts.js";
import { formatHours } from "../charts-math.js";

// Derived from InsightsResponse (the worker's actual payload) rather than
// redeclared here — this is exactly what task A9 replaced the blind `as`
// casts with.
type InterpretedMetric = InsightsResponse["interpreted"][number];
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
                <LapHrBars
                  laps={r.laps}
                  threshold={d.threshold}
                  title={`Heart rate, lap by lap — ${r.title ?? formatShortDate(r.date)}`}
                />
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
        {consistency.planned > 0 ? (
          <div className="stack">
            <OutcomeBar
              completed={consistency.completed}
              moved={consistency.moved}
              pending={consistency.pending}
              skipped={consistency.skipped}
              missed={consistency.missed}
              planned={consistency.planned}
              subtitle={`Adherence ${(consistency.adherenceRate * 100).toFixed(0)}% · moving a workout still counts as completing it`}
            />
            <ConsistencyHeatmap
              days={consistency.days}
              note="One square per day, weeks left to right. The outlined squares in the last column are the rest of this week."
            />
          </div>
        ) : (
          <p className="muted">Plan consistency appears once the plan has workouts in it.</p>
        )}
      </Card>

      <Card title="Weekly training">
        {recentTraining.length === 0 ? (
          <p className="muted">Completed runs will appear here.</p>
        ) : (
          <ChartFrame
            title="Training time per week"
            subtitle="Stacked: low vs high intensity time (from completed, matched runs)"
            legend={[
              { label: "Low intensity", colorVar: "--chart-1" },
              { label: "High intensity", colorVar: "--chart-2" },
            ]}
            summary={recentTraining
              .map(
                (w) =>
                  `Week of ${formatShortDate(w.weekStart)}: ${formatHours(w.durationSeconds)} over ${w.runCount} runs.`,
              )
              .join(" ")}
            note={
              weekly.fourWeekAvgDuration
                ? `4-week average: ${formatHours(weekly.fourWeekAvgDuration)}/week · n=${recentTraining.reduce((s, w) => s + w.runCount, 0)} runs`
                : `n=${recentTraining.reduce((s, w) => s + w.runCount, 0)} runs`
            }
          >
            <WeeklyDurationChart
              weeks={recentTraining}
              avgSeconds={weekly.fourWeekAvgDuration}
              avgLabel="4-wk avg"
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
            note={`n=${efficiency.sampleSize} runs · higher is easier speed at the same heart rate · noisy week to week${
              efficiency.value.trend
                ? ` · trend ${signed(efficiency.value.trend.pct)}% over ${efficiency.value.trend.n} runs`
                : ""
            }`}
          >
            <RunSeriesChart
              points={efficiency.value.perRun.map((p) => ({
                date: p.date,
                value: p.efficiency,
                activityId: p.activityId,
              }))}
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
            note={`n=${decoupling.sampleSize} steady runs · median ${decoupling.value.medianPct.toFixed(1)}% · shaded 0–5% is the range that means "held together"`}
          >
            <RunSeriesChart
              points={decoupling.value.perRun.map((p) => ({
                date: p.date,
                value: p.decouplingPct,
                activityId: p.activityId,
              }))}
              unit="% decoupling"
              seriesLabel="Aerobic decoupling"
              colorVar="--chart-2"
              decimals={1}
              band={{ y1: 0, y2: 5 }}
              zeroLine
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
