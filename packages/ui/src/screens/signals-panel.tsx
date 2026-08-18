import { useUnits } from "../use-units.js";
import type { InsightsResponse } from "@rg/api-client";
import { countNoun, formatDayLong, formatDayShort, formatShortDate, Sheet } from "../components.js";
import {
  BaselineBandChart,
  ChartFrame,
  DivergingPaceBars,
  LapHrBars,
  RunSeriesChart,
} from "../charts.js";
import { TrendChip } from "../chart-kit.js";
import { SignalTile } from "../signal-tiles.js";

/**
 * The specialized end of the Activity dashboard (System 2): everything that
 * used to be the Insights page's tile grid and deep charts, now revealed by
 * the "All N signals" expander. Moved, not rewritten — the drilldown, the
 * grouped grid, hill exposure and the aerobic pair keep their exact
 * behavior; only the Card chrome around them changed hands.
 */

type InterpretedMetric = InsightsResponse["interpreted"][number];
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

/**
 * One drilldown sheet for every metric that has one. What it shows depends on
 * what the metric actually carries, not on a per-id switch:
 *   - a daily `series` + its `baseline` band → the baseline-band chart
 *     (restingHr, hrv — these carry no per-run `detail` at all, because their
 *     evidence is a run of morning readings, not a list of runs);
 *   - `detail.runs` with numeric `delta`s → diverging bars (pacing);
 *   - `detail.runs` → the per-run list, with lap bars on any run that has
 *     laps (easyDiscipline).
 * A metric with two of those gets both, in that order.
 */
export function MetricDrilldown({ m, onClose }: { m: InterpretedMetric; onClose: () => void }) {
  const units = useUnits();
  const detail = m.detail;
  const series = m.series ?? [];
  const baseline = m.baseline;
  // `delta` is optional on the wire, so a run without one is dropped rather
  // than plotted at zero — an unknown split is not an even split.
  const paceRuns = (detail?.runs ?? [])
    .filter((r) => typeof r.delta === "number")
    .map((r) => ({ activityId: r.activityId, date: r.date, deltaSecPerKm: r.delta! }));
  // Every label in BaselineBandChart runs through `toFixed(decimals)`, and the
  // default is 0 — right for bpm and ms, which are whole numbers off the
  // watch, but it would render loadRatio's entire 0.8–1.3 sweet spot as
  // "1 to 1" around a baseline of "1". A magnitude rule rather than a per-id
  // map: a baseline under 10 in its own unit has nothing left to say at zero
  // decimal places, whatever metric it belongs to.
  const bandDecimals = Math.abs(baseline?.value ?? 0) < 10 ? 2 : 0;

  return (
    <Sheet open onClose={onClose} title={m.title}>
      <div className="stack">
        <p className="muted">{detail?.explain ?? m.meaning}</p>

        {baseline && series.length > 0 ? (
          <BaselineBandChart
            series={series}
            baseline={baseline.value}
            band={{ lo: baseline.lo, hi: baseline.hi }}
            unit={baseline.unit}
            decimals={bandDecimals}
            seriesLabel={m.title}
            // The sheet's own header already says the metric's name; repeating
            // it as the chart caption says nothing. The caption says what the
            // marks are instead, and the range line carries the baseline.
            title="Daily readings"
            subtitle={m.range}
          />
        ) : null}

        {/* `pacing` is run-only (RUN_ONLY_METRICS), so this drilldown only ever
            opens on the run discipline — "run by run" is always true here. */}
        {m.id === "pacing" && paceRuns.length > 0 ? (
          <DivergingPaceBars
            units={units}
            runs={paceRuns}
            subtitle="Second half against first half, run by run — above the line is a fade."
          />
        ) : null}

        {detail ? (
          <ul className="drill-runs">
            {detail.runs.map((r) => (
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
                    threshold={detail.threshold}
                    title={`Heart rate, lap by lap — ${r.title ?? formatShortDate(r.date)}`}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Sheet>
  );
}

/** Load / Recovery / Execution. Ids not listed here are ignored — an unknown
 *  metric from a newer worker must never crash an older client. */
export const METRIC_GROUPS: Array<{ title: string; ids: string[] }> = [
  { title: "Load", ids: ["loadRatio", "ramp", "monotony"] },
  { title: "Recovery", ids: ["restingHr", "hrv", "hardStack"] },
  { title: "Execution", ids: ["lowIntensityShare", "easyDiscipline", "pacing"] },
];

/** The ids the grid actually renders — the flagged-tile filter and any strip
 *  logic must only surface a metric with a tile behind it. */
export const RENDERED_METRIC_IDS: ReadonlySet<string> = new Set(
  METRIC_GROUPS.flatMap((g) => g.ids),
);

/** A week's written review — the feed's week story opens into this. */
export function ReviewBody({ r }: { r: InsightsResponse["reviews"][number] }) {
  return (
    <div>
      <p className="review-week">Week of {formatDayLong(r.weekStart)}</p>
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
  );
}

/**
 * The expander's content: the full grouped grid, hill exposure, and the
 * aerobic pair. Everything here keeps the explanatory prose the flagged
 * tiles above deliberately shed — this IS the one-tap-down level the
 * density law points at.
 */
export function SignalsPanel({
  data,
  onDrill,
}: {
  data: InsightsResponse;
  onDrill: (m: InterpretedMetric) => void;
}) {
  const { efficiency, decoupling, interpreted } = data;
  return (
    <div className="stack">
      {METRIC_GROUPS.map((g) => {
        const metrics = interpreted.filter((m) => g.ids.includes(m.id));
        if (metrics.length === 0) return null;
        return (
          <div key={g.title} className="signal-group">
            <h3 className="signal-group-label">{g.title}</h3>
            <div className="signal-grid">
              {metrics.map((m) => (
                <SignalTile key={m.id} m={m} onDrill={onDrill} />
              ))}
            </div>
          </div>
        );
      })}

      {data.terrain?.recent ? (
        <div className="signal-group">
          <h3 className="signal-group-label">Hill exposure</h3>
          <p className="num" style={{ fontSize: "var(--text-lg)", margin: 0 }}>
            {data.terrain.recent.metresPerKm} m/km
          </p>
          <p className="muted" style={{ marginTop: "var(--space-2)" }}>
            {countNoun(data.terrain.recent.runs, "run")} since{" "}
            {formatShortDate(data.terrain.recent.sinceDate)} carried{" "}
            {data.terrain.recent.totalClimbMetres} m of climb between them.
          </p>
          {data.terrain.comparison ? (
            <p className="muted">
              {data.terrain.comparison.verdict === "under_prepared"
                ? `Your race course asks for ${data.terrain.raceMetresPerKm} m/km — hillier than you've been running. Hills are trainable; there's time.`
                : data.terrain.comparison.verdict === "over_prepared"
                  ? `Your race course asks for ${data.terrain.raceMetresPerKm} m/km — gentler than your recent running. Race day should feel flat.`
                  : `Your race course asks for ${data.terrain.raceMetresPerKm} m/km — about what you've been running.`}
            </p>
          ) : (
            <p className="faint">
              Set your race course in Settings to see how this compares with race day.
            </p>
          )}
        </div>
      ) : null}

      {/* Absent, not empty, for strength and yoga: both cards are built on
          pace, so for a lift the question does not apply. */}
      {efficiency && decoupling ? (
        <div className="signal-group">
          <h3 className="signal-group-label">Aerobic response</h3>
          <div className="aerobic-pair">
            <div className="aerobic-cell">
              {efficiency.status === "ok" ? (
                <ChartFrame
                  title="Aerobic efficiency"
                  subtitle={efficiency.comparisonNote}
                  aside={
                    efficiency.value.trend ? (
                      <TrendChip pct={efficiency.value.trend.pct} betterWhen="up" />
                    ) : null
                  }
                  summary={`Aerobic efficiency across ${countNoun(efficiency.sampleSize, "comparable easy run")}.${efficiency.value.trend ? ` Trend ${efficiency.value.trend.pct >= 0 ? "up" : "down"} ${Math.abs(efficiency.value.trend.pct).toFixed(1)} percent over ${countNoun(efficiency.value.trend.n, "run")}.` : ""}`}
                  note={`n=${countNoun(efficiency.sampleSize, "run")} · metres per heartbeat; higher is easier speed at the same heart rate · noisy week to week${
                    efficiency.value.trend
                      ? ` · trend ${signed(efficiency.value.trend.pct)}% over ${countNoun(efficiency.value.trend.n, "run")}`
                      : ""
                  }${
                    efficiency.value.excludedCount > 0
                      ? ` · ${countNoun(efficiency.value.excludedCount, "run")} lacked usable laps`
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
            </div>

            <div className="aerobic-cell">
              {decoupling.status === "ok" ? (
                <ChartFrame
                  title="Aerobic decoupling (Pa:HR)"
                  subtitle={decoupling.comparisonNote}
                  summary={`Median Pa:HR decoupling ${decoupling.value.medianPct.toFixed(1)} percent across ${countNoun(decoupling.sampleSize, "steady run")}.`}
                  note={`n=${countNoun(decoupling.sampleSize, "steady run")} · median ${decoupling.value.medianPct.toFixed(1)}% · shaded 0–5% is the range that means "held together"${
                    decoupling.value.excluded.count > 0
                      ? ` · ${countNoun(decoupling.value.excluded.count, "run")} excluded`
                      : ""
                  }`}
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
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
