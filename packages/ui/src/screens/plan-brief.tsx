import { useState } from "react";
import type { PlanWeekResponse } from "@rg/api-client";
import { startOfIsoWeek } from "@rg/domain";
import { formatMinutes, formatShortDate, Sheet } from "../components.js";
import { weekRangeLabel } from "./week-view.js";

/**
 * The weekly brief (rework spec §6): headline state, a context line that says
 * WHY in the garden's voice, four fact chips, the coach's one action line.
 * Every chip is tappable — the explainer sheet says what each number means
 * and where its healthy range sits, so nothing here requires prior context.
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

/** One sentence of why — adventure days pause the plan, they never count
 * against it (the difference between "rebuilding" and an accusation). */
export function headlineContext(week: PlanWeekResponse): string | null {
  const pct = week.adherence4w.pct;
  switch (week.headline) {
    case "race_week":
      return "Race day is inside a week — the only job now is arriving fresh.";
    case "resting":
      return "A deliberately lighter week — absorbing training is training too.";
    case "ahead":
      return "Sessions are landing and load is nudging up — a strong stretch.";
    case "on_track":
      return pct !== null
        ? `Planned sessions have been landing (${pct}% over the last four weeks) — keep the rhythm.`
        : "Planned sessions have been landing — keep the rhythm.";
    case "behind":
      return pct !== null
        ? `A few planned sessions slipped over the last four weeks (${pct}%) — one normal week brings it back.`
        : "A few planned sessions slipped lately — one normal week brings it back.";
    case "rebuilding":
      // ≥2: a weekend trip is exactly the case this line exists for (the
      // audit's real example produced 2 adventure days and missed the copy).
      if (week.adventureDays >= 2) {
        return `The plan mostly paused for adventures lately (${week.adventureDays} day${week.adventureDays === 1 ? "" : "s"} in the last four weeks) — those never count against you. This week is about finding the rhythm again.`;
      }
      if (pct === null) {
        return "Not enough recent plan history to judge — this week starts the record.";
      }
      return `Planned sessions were light over the last four weeks (${pct}%) — this week is about rhythm, not volume.`;
  }
}

const TREND_ARROW: Record<"up" | "flat" | "down", string> = { up: "↗", flat: "→", down: "↘" };

/** What each brief number means — the tap-through for every chip. */
export function BriefExplainerSheet({
  week,
  open,
  onClose,
}: {
  week: PlanWeekResponse;
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <Sheet open onClose={onClose} title="What these numbers mean">
      <div className="stack brief-explainer">
        <div>
          <h3 className="card-title">
            Sessions · {week.doneCount} of {week.sessionCount}
          </h3>
          <p className="muted">
            Planned sessions this week, rest days excluded. “Done” counts the ones matched to a
            real recorded activity.
          </p>
        </div>
        <div>
          <h3 className="card-title">Planned time · {formatMinutes(week.plannedSeconds)}</h3>
          <p className="muted">
            The week's total prescribed training time — what the plan asks for, not what you've
            done so far.
          </p>
        </div>
        <div>
          <h3 className="card-title">
            4-week adherence{week.adherence4w.pct !== null ? ` · ${week.adherence4w.pct}%` : ""}
          </h3>
          <p className="muted">
            Of the planned sessions that came due in the last four weeks, the share you completed.
            Around 80% is a healthy training rhythm. Adventure days (hikes, ski tours, trips)
            pause the plan rather than count against it, and the arrow shows the direction against
            the four weeks before.
          </p>
        </div>
        <div>
          <h3 className="card-title">
            Training load{week.loadRatio !== null ? ` · ${week.loadRatio.toFixed(2)}` : ""}
          </h3>
          <p className="muted">
            The last 7 days' training load compared with your 28-day average. Near 1.0 is steady;
            under 0.8 means you're easing; much above 1.3 is a spike worth respecting with extra
            recovery.
          </p>
        </div>
      </div>
    </Sheet>
  );
}

export function WeeklyBrief({
  week,
  today,
  pendingCount,
  onNeedsYou,
  onResolveRace,
  resolvingRace = false,
}: {
  week: PlanWeekResponse;
  /** The account's today — the brief's prose is only true of THIS week. */
  today?: string;
  /** Pending proposals — the "Needs you" chip renders only when > 0. */
  pendingCount: number;
  onNeedsYou: () => void;
  /** One-tap resolution for the two-race-dates warning — a warning the
   * athlete can't act on from where it appears just sits there (2026-08-13). */
  onResolveRace?: (keep: "settings" | "plan") => void;
  resolvingRace?: boolean;
}) {
  const [explaining, setExplaining] = useState(false);
  // Paging away from the current week keeps the chips honest but froze the
  // prose, so "This week is about finding the rhythm again" narrated a week
  // in October (live UX audit). Off-current weeks show facts only.
  const isCurrentWeek = today === undefined || startOfIsoWeek(today) === week.weekStart;
  const headline =
    week.weekIndex !== null && week.weekTotal !== null
      ? `Week ${week.weekIndex} of ${week.weekTotal}${isCurrentWeek ? ` — ${HEADLINE_COPY[week.headline]}` : ""}.`
      : isCurrentWeek
        ? `This week — ${HEADLINE_COPY[week.headline]}.`
        : `${weekRangeLabel(week.weekStart)}.`;
  const context = isCurrentWeek ? headlineContext(week) : null;
  const explain = () => setExplaining(true);
  return (
    <section className="card plan-brief" aria-label="Weekly brief">
      <div className="plan-brief-head">
        <h2 className="plan-brief-headline">{headline}</h2>
        {pendingCount > 0 ? (
          <button type="button" className="pill plan-brief-needs" onClick={onNeedsYou}>
            Needs you · {pendingCount}
          </button>
        ) : null}
      </div>
      {context ? <p className="plan-brief-context">{context}</p> : null}
      {week.raceMismatch ? (
        <div className="plan-brief-context" role="alert">
          <p>
            ⚠ Two race dates: the plan has “{week.raceMismatch.title}” on{" "}
            {formatShortDate(week.raceMismatch.plannedDate)}, but your race day is set to{" "}
            {formatShortDate(week.raceMismatch.raceDate)}. Which is right?
          </p>
          {/* Each choice is a whole sentence, so each is a `.btn .btn-wrap`
              and not a `.pill`: as pills these measured 456px inside a 358px
              card and put 102px of horizontal scroll on the entire app, which
              walked every fixed right-edge control (the Settings tab, the
              coach pill, a sheet's ✕) off-screen. */}
          {onResolveRace ? (
            <div className="plan-brief-race-actions">
              <button
                type="button"
                className="btn btn-small btn-wrap"
                disabled={resolvingRace}
                onClick={() => onResolveRace("settings")}
              >
                My race is {formatShortDate(week.raceMismatch.raceDate)} — make “
                {week.raceMismatch.title}” a normal hard session
              </button>
              <button
                type="button"
                className="btn btn-small btn-wrap"
                disabled={resolvingRace}
                onClick={() => onResolveRace("plan")}
              >
                The plan is right — set race day to{" "}
                {formatShortDate(week.raceMismatch.plannedDate)}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {/* Labels compact themselves under 640px (spec R1 + "no unnecessary
          wrapping"): the numbers stay, the prose shrinks, one row fits.
          Every chip opens the explainer — numbers must not need context. */}
      <div className="plan-brief-chips">
        <button type="button" className="plan-brief-chip" onClick={explain}>
          <b className="num">
            {week.doneCount} of {week.sessionCount}
          </b>{" "}
          <span className="brief-wide">sessions</span>
          <span className="brief-narrow">done</span>
        </button>
        <button type="button" className="plan-brief-chip" onClick={explain}>
          <b className="num">{formatMinutes(week.plannedSeconds)}</b>
          <span className="brief-wide"> planned</span>
        </button>
        {week.adherence4w.pct !== null ? (
          <button type="button" className="plan-brief-chip" onClick={explain}>
            <span className="brief-wide">4-wk adherence </span>
            <b className="num">{week.adherence4w.pct}%</b>
            {week.adherence4w.trend ? (
              <span className={`plan-brief-trend trend-${week.adherence4w.trend}`} aria-hidden>
                {" "}
                {TREND_ARROW[week.adherence4w.trend]}
              </span>
            ) : null}
          </button>
        ) : null}
        {/* No load-ratio chip: "load 7d/28d" was expert jargon on a glance
            surface, and Insights already carries the same signal with a
            proper explainer. The explainer sheet still describes training
            load for anyone who taps through. */}
      </div>
      {week.focus ? (
        <p className="plan-brief-action">
          <span className="plan-brief-who">Coach</span>
          <span>{week.focus.text}</span>
        </p>
      ) : null}
      <BriefExplainerSheet week={week} open={explaining} onClose={() => setExplaining(false)} />
    </section>
  );
}
