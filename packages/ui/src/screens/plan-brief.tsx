import type { PlanWeekResponse } from "@rg/api-client";
import { formatMinutes } from "../components.js";

/**
 * The weekly brief (rework spec §6): headline state, four fact chips, the
 * coach's one action line. Concise or it fails — chips with no data simply
 * don't render, and the whole coach line disappears when it's stale.
 * Presentational; the page injects everything.
 */

/** Headline copy in the garden's voice — names the situation, never scolds. */
export const HEADLINE_COPY: Record<PlanWeekResponse["headline"], string> = {
  on_track: "on track",
  behind: "slightly behind",
  ahead: "ahead",
  rebuilding: "rebuilding",
  race_week: "race week",
  resting: "resting up",
};

const TREND_ARROW: Record<"up" | "flat" | "down", string> = { up: "↗", flat: "→", down: "↘" };

export function WeeklyBrief({
  week,
  pendingCount,
  onNeedsYou,
}: {
  week: PlanWeekResponse;
  /** Pending proposals — the "Needs you" chip renders only when > 0. */
  pendingCount: number;
  onNeedsYou: () => void;
}) {
  const headline =
    week.weekIndex !== null && week.weekTotal !== null
      ? `Week ${week.weekIndex} of ${week.weekTotal} — ${HEADLINE_COPY[week.headline]}.`
      : `This week — ${HEADLINE_COPY[week.headline]}.`;
  return (
    <section className="card plan-brief" aria-label="Weekly brief">
      <div className="plan-brief-head">
        <h2 className="plan-brief-headline">{headline}</h2>
        {pendingCount > 0 ? (
          <button type="button" className="pill pill-warnsoft plan-brief-needs" onClick={onNeedsYou}>
            Needs you · {pendingCount}
          </button>
        ) : null}
      </div>
      <div className="plan-brief-chips">
        <span className="plan-brief-chip">
          <b className="num">
            {week.doneCount} of {week.sessionCount}
          </b>{" "}
          sessions
        </span>
        <span className="plan-brief-chip">
          <b className="num">{formatMinutes(week.plannedSeconds)}</b> planned
        </span>
        {week.adherence4w.pct !== null ? (
          <span className="plan-brief-chip">
            4-wk adherence <b className="num">{week.adherence4w.pct}%</b>
            {week.adherence4w.trend ? (
              <span className={`plan-brief-trend trend-${week.adherence4w.trend}`} aria-hidden>
                {" "}
                {TREND_ARROW[week.adherence4w.trend]}
              </span>
            ) : null}
          </span>
        ) : null}
        {week.loadRatio !== null ? (
          <span className="plan-brief-chip">
            load 7d/28d <b className="num">{week.loadRatio.toFixed(2)}</b>
          </span>
        ) : null}
      </div>
      {week.focus ? (
        <p className="plan-brief-action">
          <span className="plan-brief-who">Coach</span>
          <span>{week.focus.text}</span>
        </p>
      ) : null}
    </section>
  );
}
