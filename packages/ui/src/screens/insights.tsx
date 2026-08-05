import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type InsightsResponse } from "@rg/api-client";
import { disciplineLabel, sessionNoun, type Discipline } from "@rg/analytics";
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
  BaselineBandChart,
  ChartFrame,
  ConsistencyHeatmap,
  DivergingPaceBars,
  LapHrBars,
  OutcomeBar,
  RunSeriesChart,
  WeeklyDurationChart,
} from "../charts.js";
import { TrendChip } from "../chart-kit.js";
import { SignalTile, StatusStrip } from "../signal-tiles.js";
import { currentStreak, formatHours, isRecentRecord, reviewUnseen } from "../charts-math.js";

/**
 * The Insights dashboard. Reading order, top to bottom: one line of status →
 * the nine signals as tiles → did the plan happen → how much you ran → how
 * your aerobic system responded → what you've quietly got faster at → what
 * the week's review said.
 *
 * The old shape (three sibling metric Cards of prose-heavy MetricCards, each
 * ending in "See the runs behind this →") is gone: the tiles carry their own
 * inline visual and a chevron, so the repeated sentence had nothing left to
 * say. `SignalTile`/`StatusStrip` come from signal-tiles.tsx; every chart
 * from charts.tsx.
 */

// Derived from InsightsResponse (the worker's actual payload) rather than
// redeclared here — this is exactly what task A9 replaced the blind `as`
// casts with.
type InterpretedMetric = InsightsResponse["interpreted"][number];
/** The insufficient-data branch is identical across every MetricResult<T>, whatever T is. */
type MetricInsufficient = Extract<InsightsResponse["decoupling"], { status: "insufficient_data" }>;
type WeeklyReview = InsightsResponse["reviews"][number];

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
function MetricDrilldown({ m, onClose }: { m: InterpretedMetric; onClose: () => void }) {
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
const METRIC_GROUPS: Array<{ title: string; ids: string[] }> = [
  { title: "Load", ids: ["loadRatio", "ramp", "monotony"] },
  { title: "Recovery", ids: ["restingHr", "hrv", "hardStack"] },
  { title: "Execution", ids: ["lowIntensityShare", "easyDiscipline", "pacing"] },
];

/**
 * Derived from `METRIC_GROUPS`, not hand-duplicated: the strip must only
 * headline a metric with a tile to scroll to, and the grid above is the
 * single source of truth for which ids that is. A future worker metric with
 * no entry in `METRIC_GROUPS` is invisible on the grid; without this gate it
 * could still win the strip and offer a scroll-to-nowhere button.
 */
const RENDERED_METRIC_IDS: ReadonlySet<string> = new Set(METRIC_GROUPS.flatMap((g) => g.ids));

function ReviewBody({ r }: { r: WeeklyReview }) {
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

export function InsightsScreen() {
  const [discipline, setDiscipline] = useState<Discipline>("run");
  const insights = useQuery({
    queryKey: ["insights", discipline],
    queryFn: () => api.insights(discipline),
    staleTime: 60_000,
  });
  const [drill, setDrill] = useState<InterpretedMetric | null>(null);
  // The review's "New" pill shows on the visit that reveals it, then goes
  // quiet: the seen mark is written after this render's pill computed
  // against the pre-visit value (earned-moments spec §2).
  let storedReviewSeen: string | null = null;
  try {
    storedReviewSeen = window.localStorage.getItem("rg-review-seen");
  } catch {
    storedReviewSeen = null;
  }
  useEffect(() => {
    const latest = insights.data?.reviews?.[0];
    if (!latest) return;
    try {
      window.localStorage.setItem("rg-review-seen", latest.weekStart);
    } catch {
      // Storage unavailable — the pill will simply show again.
    }
  }, [insights.data]);
  // Switching discipline is a new query key with nothing cached, so the query
  // goes back to `isLoading` and the whole screen — selector included — used to
  // be replaced by a spinner. Remembering the last known list keeps the chips
  // on screen and interactive while the new discipline loads, so a mis-tap is
  // one tap to undo rather than a wait. Deliberately NOT keepPreviousData:
  // showing running's numbers under a Yoga chip, even for a moment, is worse
  // than showing nothing.
  const [knownDisciplines, setKnownDisciplines] = useState<Discipline[]>([]);
  const available = insights.data?.availableDisciplines ?? knownDisciplines;
  if (
    insights.data?.availableDisciplines &&
    insights.data.availableDisciplines.join() !== knownDisciplines.join()
  ) {
    setKnownDisciplines(insights.data.availableDisciplines);
  }

  // The selected discipline always appears, even if this window no longer has
  // sessions for it — otherwise selecting it can hide the very control needed
  // to leave it.
  const chips = available.includes(discipline) ? available : [...available, discipline];

  const selector =
    chips.length > 1 ? (
      <div className="discipline-chips" role="tablist" aria-label="Discipline">
        {chips.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={discipline === key}
            className={`chip chip-${key}${discipline === key ? " active" : ""}`}
            onClick={() => setDiscipline(key)}
          >
            {disciplineLabel(key)}
          </button>
        ))}
      </div>
    ) : null;

  if (insights.isLoading) {
    return (
      <div className="stack">
        <h1 className="screen-title">Insights</h1>
        {selector}
        <Spinner label="Computing insights" />
      </div>
    );
  }
  if (!insights.data) {
    // A failed fetch is usually transient (asleep laptop, dropped wifi, a
    // worker cold start), and this screen's only other escape was a full page
    // reload — the query is already cached-and-retryable, so offer the retry
    // instead of making the reader find it. `isFetching` disables the button
    // while a retry is in flight so a second press can't queue another.
    return (
      <EmptyState title="Couldn't load insights">
        Check your connection, then try again.{" "}
        <button
          className="btn btn-small"
          onClick={() => void insights.refetch()}
          disabled={insights.isFetching}
        >
          {insights.isFetching ? "Retrying…" : "Retry"}
        </button>
      </EmptyState>
    );
  }

  const { consistency, weekly, efficiency, decoupling, records, reviews, interpreted } = insights.data;

  const recentTraining = weekly.weeks.slice(-8);
  const adherencePct = Math.round(consistency.adherenceRate * 100);
  // The adherence denominator, spelled out: `adherenceRate` is
  // completed / (planned − still-ahead − unresolved), and those three
  // categories partition into exactly completed + skipped + missed. Saying
  // "22 of 24 resolved" beside the percentage means the reader can check it.
  const resolved = consistency.completed + consistency.skipped + consistency.missed;
  const totalRuns = recentTraining.reduce((s, w) => s + w.runCount, 0);
  const streak = currentStreak(consistency.days);

  return (
    <div className="stack">
      <h1 className="screen-title">Insights</h1>

      {/* Only when there is a real choice: a single-discipline history should
          not be asked to pick from a list of one. */}
      {selector}

      {/* `resolved` (computed above, and reused by the Consistency card's own
          headline math) gates the percentage here too: when nothing has
          resolved yet, `adherenceRate` is 0/0 → 0, and printing "adherence
          0%" on the strip would contradict the card underneath it, which
          correctly suppresses the number in favor of "Nothing has resolved
          yet…". `undefined` makes StatusStrip drop the clause entirely. */}
      <StatusStrip
        interpreted={interpreted}
        adherencePct={resolved > 0 ? adherencePct : undefined}
        renderedIds={RENDERED_METRIC_IDS}
      />

      <Card title="Signals">
        {METRIC_GROUPS.map((g) => {
          const metrics = interpreted.filter((m) => g.ids.includes(m.id));
          if (metrics.length === 0) return null;
          return (
            <div key={g.title} className="signal-group">
              <h2 className="signal-group-label">{g.title}</h2>
              <div className="signal-grid">
                {metrics.map((m) => (
                  <SignalTile key={m.id} m={m} onDrill={setDrill} />
                ))}
              </div>
            </div>
          );
        })}
      </Card>

      <Card title="Consistency · last 12 weeks">
        {consistency.planned > 0 ? (
          <div className="stack">
            {resolved > 0 ? (
              <p className="headline-stat">
                <span className="headline-stat-value">{adherencePct}%</span>
                <span className="headline-stat-suffix">
                  {" "}
                  · {consistency.completed} of {resolved} resolved workouts
                </span>
              </p>
            ) : (
              <p className="muted">
                Nothing has resolved yet — {consistency.pending} workout
                {consistency.pending === 1 ? "" : "s"} still waiting on an answer.
              </p>
            )}
            {/* Quiet by design: a streak under 2 days is just normal
                training, and normal earns silence (see charts-math.ts'
                currentStreak for the rest/pending/missed walk-back rule). */}
            {streak >= 2 ? <p className="streak-note">{streak}-day streak</p> : null}
            <OutcomeBar
              completed={consistency.completed}
              moved={consistency.moved}
              pending={consistency.pending}
              skipped={consistency.skipped}
              missed={consistency.missed}
              planned={consistency.planned}
            />
            {/* No onDayClick: the plan screen addresses workouts by id
                (`/plan?workout=<id>`), not by date, and a ConsistencyDay
                carries only `{date, status}` — there is no id to navigate
                with. Omitting the handler also drops ~60 tab stops. */}
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
            subtitle={`Stacked: low vs high intensity time (from completed, matched ${sessionNoun(discipline, true)})`}
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
                ? `4-week average: ${formatHours(weekly.fourWeekAvgDuration)}/week · n=${totalRuns} runs`
                : `n=${totalRuns} runs`
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

      {/* Absent, not empty, for strength and yoga: both cards are built on pace,
          so for a lift the question does not apply — and an empty card would
          claim the data is missing instead. */}
      {efficiency && decoupling ? (
      <Card title="Aerobic response">
        {/* Side by side from 720px, stacked below — the two answer the same
            question (is the engine getting better, and does it hold together)
            and are read against each other. */}
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
                summary={`Aerobic efficiency across ${efficiency.sampleSize} comparable easy runs.${efficiency.value.trend ? ` Trend ${efficiency.value.trend.pct >= 0 ? "up" : "down"} ${Math.abs(efficiency.value.trend.pct).toFixed(1)} percent over ${efficiency.value.trend.n} runs.` : ""}`}
                // The excluded count is disclosed, not swallowed: "n=12 runs"
                // reads as "all 12 of your runs" unless the chart says how
                // many it couldn't score.
                note={`n=${efficiency.sampleSize} runs · metres per heartbeat; higher is easier speed at the same heart rate · noisy week to week${
                  efficiency.value.trend
                    ? ` · trend ${signed(efficiency.value.trend.pct)}% over ${efficiency.value.trend.n} runs`
                    : ""
                }${
                  efficiency.value.excludedCount > 0
                    ? ` · ${efficiency.value.excludedCount} runs lacked usable laps`
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
                summary={`Median Pa:HR decoupling ${decoupling.value.medianPct.toFixed(1)} percent across ${decoupling.sampleSize} steady runs.`}
                note={`n=${decoupling.sampleSize} steady runs · median ${decoupling.value.medianPct.toFixed(1)}% · shaded 0–5% is the range that means "held together"${
                  decoupling.value.excluded.count > 0
                    ? ` · ${decoupling.value.excluded.count} runs excluded`
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
        {/* No onPointClick on either chart: there is no per-activity route in
            the app (see app.tsx — /runs is a list with no id segment or search
            param), so a dot click would have nowhere to go. RunSeriesChart
            already carries `activityId` through, so wiring it is one prop the
            day that route exists. */}
      </Card>
      ) : null}

      {records.length > 0 ? (
        <Card title="Records">
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {records.map((r) => (
              <li key={r.id} style={{ marginBottom: "0.5rem" }}>
                <strong>{r.title}:</strong> {r.value}{" "}
                <span className="faint">({formatDayLong(r.achievedOn)})</span>
                {isRecentRecord(r.achievedOn, new Date().toISOString().slice(0, 10)) ? (
                  <span className="new-ring">New</span>
                ) : null}
                <div className="faint">{r.rule}</div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {reviews.length > 0 ? (
        <Card title="Weekly review">
          <div className="stack">
            {reviewUnseen(reviews[0]!.weekStart, storedReviewSeen) ? (
              <span className="new-ring">New this week</span>
            ) : null}
            {/* Newest first — the worker orders by weekStart desc. */}
            <ReviewBody r={reviews[0]!} />
            {reviews.length > 1 ? (
              <details className="reviews-earlier">
                <summary>Earlier weeks ({reviews.length - 1})</summary>
                <div className="stack">
                  {reviews.slice(1).map((r) => (
                    <ReviewBody key={r.weekStart} r={r} />
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </Card>
      ) : null}

      {drill ? <MetricDrilldown m={drill} onClose={() => setDrill(null)} /> : null}
    </div>
  );
}
