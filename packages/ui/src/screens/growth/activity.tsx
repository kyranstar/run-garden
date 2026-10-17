/**
 * GROWTH'S ACTIVITY (the new shape §7: "today's Activity screen, simplified"): the discipline chips, a program's progress
 * tiles (beside every view but the running ones), the training chart over the period, the signals (a flagged one shown, the
 * rest one tap down), and the feed by week (feed.tsx). Records moved to their own section; the plan's consistency is the
 * Plan's.
 */
import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type ActivityDto, type InsightsResponse } from "@rg/api-client";
import { isAdventureSport, sportLabel, type GrowthPeriod } from "@rg/domain";
import type { Discipline } from "@rg/analytics";
import { Banner, countNoun, EmptyState, formatShortDate, localTodayGuess, settling, Spinner, type Units } from "../../components.js";
import { ChartFrame, WeeklyDurationChart } from "../../charts.js";
import { formatHours } from "../../charts-math.js";
import { firstSentence, SignalTile } from "../../signal-tiles.js";
import { MetricDrilldown, RENDERED_METRIC_IDS, ReviewBody, SignalsPanel } from "../signals-panel.js";
import { CorosCheck } from "../coros-check.js";
import { ProgressTiles, progressShown } from "../progress-tiles.js";
import { useCorosReadNow } from "../use-coros-read.js";
import { ActivityDetail, EMPTY_COPY, feedRowBits, FILTERS, flaggedSignals, groupByWeek, LinkSheet, mondayOf, type DisciplineFilter } from "./feed.js";

type InterpretedMetric = InsightsResponse["interpreted"][number];

/** The chart's weeks for a period: this week and the four before it for the month, the twelve before it for the season. */
export const CHART_WEEKS: Record<GrowthPeriod, number> = { month: 5, season: 13 };

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

export function GrowthActivity({ period }: { period: GrowthPeriod }) {
  const corosCheck = useCorosReadNow();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.activities(40) });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const units: Units = settings.data?.prefs.units ?? "km";
  const [filter, setFilter] = useState<DisciplineFilter>("all");
  // The overview reads insights for the chip's discipline; All and Adventures show running — the default discipline
  // and the product's center.
  const insightsDiscipline: Discipline = filter === "strength" ? "strength" : filter === "yoga" ? "yoga" : "run";
  const insights = useQuery({
    queryKey: ["insights", insightsDiscipline],
    queryFn: () => api.insights(insightsDiscipline),
    staleTime: 60_000,
  });
  const [linking, setLinking] = useState<ActivityDto | null>(null);
  const [drill, setDrill] = useState<InterpretedMetric | null>(null);
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openStory, setOpenStory] = useState<string | null>(null);
  const [weeksShown, setWeeksShown] = useState(3);
  const headingId = useId();

  // The weekly review's client-side seen mark (earned-moments spec §2): reviews live here, so this writes the mark
  // home's ReviewPull reads, and the pull goes quiet after a visit.
  useEffect(() => {
    const latest = insights.data?.reviews?.[0];
    if (!latest) return;
    try {
      window.localStorage.setItem("rg-review-seen", latest.weekStart);
    } catch {
      // Storage unavailable — the pull will simply show again.
    }
  }, [insights.data]);

  let body;
  // First-paint gate: the chart and the feed arrive together — a feed that paints and then grows a chart above it is
  // the layout shift the gate exists to prevent.
  if (settling(runs, insights)) body = <Spinner label="Loading activity" />;
  else if (runs.isError || !runs.data) {
    // A failed load must never masquerade as "you have no activity".
    body = (
      <div className="stack">
        <Banner kind="warn">Couldn't load your activity — check your connection.</Banner>
        <button className="btn" onClick={() => void runs.refetch()}>
          Try again
        </button>
      </div>
    );
  } else {
    const items = (runs.data.activities ?? []).filter((a) =>
      filter === "all" ? true : filter === "adventure" ? isAdventureSport(a.sport) : a.sport === filter,
    );
    const empty = EMPTY_COPY[filter];
    const data = insights.data ?? null;
    const flagged = data ? flaggedSignals(data.interpreted) : [];
    const signalCount = data ? data.interpreted.filter((m) => RENDERED_METRIC_IDS.has(m.id)).length : 0;
    const recentTraining = data ? data.weekly.weeks.slice(-CHART_WEEKS[period]) : [];
    const todayMonday = mondayOf(localTodayGuess());
    const weeks = groupByWeek(items);
    body = (
      <>
        <div className="discipline-chips" role="tablist" aria-label="Filter by discipline">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              className={`chip ${f.chipClass}${filter === f.key ? " active" : ""}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {data ? (
          <>
            {/* A program's numbers (Phase 2d, mocks §8): beside every view but the running ones. */}
            {filter !== "run" && filter !== "adventure" && progressShown(data.progress) ? (
              <section className="dash-sect" aria-label="Progress">
                <h3 className="dash-eyebrow">Progress</h3>
                <ProgressTiles progress={data.progress} />
              </section>
            ) : null}

            <section className="dash-sect" aria-label="Training">
              {recentTraining.length === 0 ? (
                <p className="muted">Completed sessions will appear here.</p>
              ) : (
                <ChartFrame
                  title="Training time per week"
                  legend={[
                    { label: "Easy time", colorVar: "--chart-1" },
                    { label: "Hard time", colorVar: "--chart-2" },
                  ]}
                  summary={recentTraining.map((w) => `Week of ${w.weekStart}: ${formatHours(w.durationSeconds)}.`).join(" ")}
                >
                  <WeeklyDurationChart weeks={recentTraining} avgSeconds={data.weekly.fourWeekAvgDuration} avgLabel="4-wk avg" />
                </ChartFrame>
              )}
            </section>

            <section className="dash-sect" aria-label="Signals">
              {flagged.length > 0 ? (
                <div className="signal-grid">
                  {flagged.map((m) => (
                    <SignalTile key={m.id} m={m} onDrill={setDrill} compact />
                  ))}
                </div>
              ) : (
                <p className="dash-allclear">All {signalCount} signals in range.</p>
              )}
              <button type="button" className="linklike dash-more" aria-expanded={signalsOpen} onClick={() => setSignalsOpen((v) => !v)}>
                All {signalCount} signals
                <span className="disclosure-caret" aria-hidden>
                  {signalsOpen ? "▾" : "▸"}
                </span>
              </button>
              {signalsOpen ? <SignalsPanel data={data} onDrill={setDrill} /> : null}
            </section>
          </>
        ) : null}

        <h3 className="visually-hidden">Every session</h3>
        {items.length === 0 ? (
          <EmptyState art={empty.art} title={empty.title}>
            {empty.body}
          </EmptyState>
        ) : (
          <>
            {weeks.slice(0, weeksShown).map((wk) => {
              const total = wk.items.reduce((s2, a) => s2 + (a.durationSeconds ?? 0), 0);
              const review = data?.reviews.find((r) => r.weekStart === wk.monday) ?? null;
              const storyOpen = openStory === wk.monday;
              return (
                <section key={wk.monday} className="fw-week" aria-label={`Week of ${wk.monday}`}>
                  <div className="fw-head">
                    <h4 className="fw-title">{wk.monday === todayMonday ? "This week" : `Week of ${formatShortDate(wk.monday)}`}</h4>
                    <span className="fw-stats">
                      {countNoun(wk.items.length, "session")} · {formatHours(total)}
                    </span>
                  </div>
                  {review?.narrative ? (
                    <p className="fw-story">
                      “{firstSentence(review.narrative)}”{" "}
                      <button
                        type="button"
                        className="linklike fw-story-more"
                        aria-expanded={storyOpen}
                        onClick={() => setOpenStory(storyOpen ? null : wk.monday)}
                      >
                        Full review
                        <span className="disclosure-caret" aria-hidden>
                          {storyOpen ? "▾" : "▸"}
                        </span>
                      </button>
                    </p>
                  ) : null}
                  {storyOpen && review ? <ReviewBody r={review} /> : null}
                  {wk.items.map((a) => {
                    const catKey = a.matched?.category ?? (isAdventureSport(a.sport) ? "adventure" : a.sport);
                    const open = openId === a.id;
                    const dow = DOW[new Date(`${a.date}T12:00:00Z`).getUTCDay()];
                    return (
                      <article key={a.id} className={`fw-act act-hue-${catKey}${open ? " fw-act-open" : ""}`}>
                        <button type="button" className="fw-row" aria-expanded={open} onClick={() => setOpenId(open ? null : a.id)}>
                          <span className="fw-when">
                            <b>{Number(a.date.slice(8, 10))}</b>
                            <small>{dow}</small>
                          </span>
                          <span className="fw-what">
                            <b>{a.title || sportLabel(a.sport)}</b>
                            <small>
                              {feedRowBits(a, units).map((bit, i) => (
                                <span key={i}>
                                  {i > 0 ? " · " : ""}
                                  <span className="fw-bit">{bit}</span>
                                </span>
                              ))}
                            </small>
                          </span>
                          <span className="fw-caret" aria-hidden="true">
                            ›
                          </span>
                        </button>
                        {open ? <ActivityDetail a={a} units={units} efficiency={data?.efficiency} onLink={setLinking} /> : null}
                      </article>
                    );
                  })}
                </section>
              );
            })}
            {weeks.length > weeksShown ? (
              <p className="fw-earlier">
                <button type="button" className="linklike" onClick={() => setWeeksShown((n) => n + 3)}>
                  Earlier weeks ›
                </button>
              </p>
            ) : null}
          </>
        )}

        {linking ? <LinkSheet activity={linking} onClose={() => setLinking(null)} /> : null}
        {drill ? <MetricDrilldown m={drill} onClose={() => setDrill(null)} /> : null}
      </>
    );
  }

  return (
    <section className="growth-sect stack" aria-labelledby={headingId}>
      <div className="row-between growth-sect-head">
        <h2 id={headingId} className="rank-item growth-h">
          Activity
        </h2>
        <CorosCheck state={corosCheck.state} />
      </div>
      {body}
    </section>
  );
}
