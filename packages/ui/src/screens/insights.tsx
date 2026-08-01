import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { Card, EmptyState, formatDayLong, Spinner } from "../components.js";
import { AdherenceChart, ChartFrame, RunSeriesChart, WeeklyDurationChart } from "../charts.js";

interface MetricOk<T> {
  status: "ok";
  value: T;
  sampleSize: number;
  comparisonNote: string;
}
interface MetricInsufficient {
  status: "insufficient_data";
  needed: number;
  have: number;
  explanation: string;
}
type Metric<T> = MetricOk<T> | MetricInsufficient;

function InsufficientNote({ m }: { m: MetricInsufficient }) {
  return (
    <p className="muted">
      {m.explanation} {m.have} of {m.needed} available so far.
    </p>
  );
}

export function InsightsScreen() {
  const insights = useQuery({ queryKey: ["insights"], queryFn: api.insights, staleTime: 60_000 });

  if (insights.isLoading) return <Spinner label="Computing insights" />;
  if (!insights.data) return <EmptyState title="Couldn't load insights" />;

  const d = insights.data as Record<string, unknown>;
  const consistency = d.consistency as {
    planned: number;
    completed: number;
    moved: number;
    skipped: number;
    missed: number;
    unresolved: number;
    adherenceRate: number;
    weeklyBreakdown: Array<{ weekStart: string; planned: number; completed: number; adherence: number }>;
  };
  const weekly = d.weekly as {
    weeks: Array<{ weekStart: string; durationSeconds: number; distanceMeters: number; easySeconds: number; qualitySeconds: number; runCount: number }>;
    fourWeekAvgDuration?: number;
  };
  const efficiency = d.efficiency as Metric<{ perRun: Array<{ date: string; efficiency: number }>; trendPct: number }>;
  const drift = d.drift as Metric<{ perRun: Array<{ date: string; driftPct: number }>; medianDriftPct: number }>;
  const timeOfDay = d.timeOfDay as Metric<{
    morning: { planned: number; completed: number; rate: number };
    evening: { planned: number; completed: number; rate: number };
  }>;
  const records = (d.records ?? []) as Array<{ id: string; title: string; value: string; achievedOn: string; rule: string }>;
  const reviews = (d.reviews ?? []) as Array<{ weekStart: string; narrative: string | null; facts: Record<string, unknown> }>;

  const recentWeeks = consistency.weeklyBreakdown.slice(-8);
  const recentTraining = weekly.weeks.slice(-8);

  return (
    <div className="stack">
      <h1 className="screen-title">Insights</h1>

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
            <WeeklyDurationChart weeks={recentTraining} />
          </ChartFrame>
        )}
      </Card>

      <Card title="Aerobic efficiency">
        {efficiency.status === "ok" ? (
          <ChartFrame
            title="Meters per heartbeat on comparable easy runs"
            subtitle={efficiency.comparisonNote}
            summary={`Aerobic efficiency across ${efficiency.sampleSize} comparable easy runs. Trend ${efficiency.value.trendPct >= 0 ? "up" : "down"} ${Math.abs(efficiency.value.trendPct).toFixed(1)} percent.`}
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

      <Card title="Heart-rate drift">
        {drift.status === "ok" ? (
          <ChartFrame
            title="Second-half vs first-half heart rate on steady runs"
            subtitle={drift.comparisonNote}
            summary={`Median heart-rate drift ${drift.value.medianDriftPct.toFixed(1)} percent across ${drift.sampleSize} steady runs.`}
            note={`n=${drift.sampleSize} steady runs · intervals excluded · median ${drift.value.medianDriftPct.toFixed(1)}%`}
          >
            <RunSeriesChart
              points={drift.value.perRun.map((p) => ({ date: p.date, value: p.driftPct }))}
              unit="% drift"
              seriesLabel="Heart-rate drift"
              colorVar="--chart-2"
              decimals={1}
            />
          </ChartFrame>
        ) : (
          <InsufficientNote m={drift} />
        )}
      </Card>

      <Card title="Time of day">
        {timeOfDay.status === "ok" ? (
          <div>
            <p>
              Morning: {timeOfDay.value.morning.completed} of {timeOfDay.value.morning.planned} completed (
              {Math.round(timeOfDay.value.morning.rate * 100)}%) · Evening: {timeOfDay.value.evening.completed} of{" "}
              {timeOfDay.value.evening.planned} ({Math.round(timeOfDay.value.evening.rate * 100)}%)
            </p>
            <p className="faint" style={{ marginTop: "0.3rem" }}>
              {timeOfDay.comparisonNote}
            </p>
          </div>
        ) : (
          <InsufficientNote m={timeOfDay} />
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
