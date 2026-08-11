import type { PlanWeekResponse, WorkoutDto } from "@rg/api-client";
import { addDays, humanizeWorkoutTitle, startOfIsoWeek } from "@rg/domain";
import { dayOfMonth, formatMinutes, monthTitle } from "../components.js";
import { IconAlert, IconCheck, IconClock } from "../icons.js";
import type { PendingGhost } from "./coach-panel.js";

/**
 * One pickable week (rework spec §6): arrows step ISO weeks, a jump menu
 * lists the plan's weeks, and a "back to this week" chip appears when
 * navigated away. Desktop renders 7 columns; below 1024px the same DOM folds
 * into a day list (empty days collapse, today always shows) — one component,
 * CSS does the folding, exactly like the old agenda fold it replaces.
 */

/**
 * "Did this run happen?" only ever makes sense for a date that has passed.
 * A workout can sit in `unresolved` with a future date briefly (it was
 * rescheduled after the question was raised); render it as scheduled.
 */
export function askable(w: WorkoutDto, today: string): boolean {
  return w.completionState === "unresolved" && w.effectiveDate <= today;
}

export function displayCompletionState(w: WorkoutDto, today: string): WorkoutDto["completionState"] {
  return w.completionState === "unresolved" && !askable(w, today) ? "scheduled" : w.completionState;
}

export function WorkoutCell({
  w,
  today,
  onOpen,
}: {
  w: WorkoutDto;
  today: string;
  onOpen: () => void;
}) {
  const completion = displayCompletionState(w, today);
  const done = completion === "completed";
  const faded = completion === "skipped" || completion === "missed";
  const asks = askable(w, today);
  const syncView = w.corosSyncView ?? w.corosSyncState;
  const attention = syncView === "needs_attention" || syncView === "sync_issue";

  if (w.category === "rest") {
    return (
      <button className="cal-card cal-rest" onClick={onOpen}>
        <span className="cal-card-title">Rest</span>
      </button>
    );
  }
  // The server already substitutes category words for opaque COROS codes
  // ("T1004") at the DTO boundary; humanizing again here is a no-op there
  // and a safety net for any payload that hasn't. Hover shows the raw code.
  const displayTitle = humanizeWorkoutTitle(w.title, w.category, w.qualitySubtype);
  return (
    <button
      className={`cal-card ${done ? "done" : ""} ${faded ? "faded" : ""} ${asks ? "asks" : ""}`}
      onClick={onOpen}
      title={w.corosName ?? w.title}
    >
      <i className={`cal-card-edge cat-${w.category}`} aria-hidden />
      <span className="cal-card-title">{displayTitle}</span>
      <span className="cal-card-meta">
        <span>{formatMinutes(w.workoutSeconds)}</span>
        {done ? (
          <span className="cal-glyph ok" title="Completed">
            <IconCheck size={11} />
          </span>
        ) : null}
        {asks ? (
          <span className="cal-glyph ask" title="Did this happen?">
            <IconClock size={11} />
          </span>
        ) : null}
        {attention ? (
          <span className="cal-glyph warn" title="Needs attention">
            <IconAlert size={11} />
          </span>
        ) : null}
        {completion === "skipped" ? <span className="cal-note">skipped</span> : null}
        {completion === "missed" ? <span className="cal-note">missed</span> : null}
      </span>
    </button>
  );
}

const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Aug 10–16" · "Aug 31 – Sep 6" — the picker's week label. */
export function weekRangeLabel(weekStart: string): string {
  const end = addDays(weekStart, 6);
  const a = monthTitle(weekStart);
  const b = monthTitle(end);
  const short = (m: string) => m.slice(0, 3);
  return a.month === b.month
    ? `${short(a.month)} ${dayOfMonth(weekStart)}–${dayOfMonth(end)}`
    : `${short(a.month)} ${dayOfMonth(weekStart)} – ${short(b.month)} ${dayOfMonth(end)}`;
}

export function WeekView({
  week,
  today,
  ghostsByDate,
  jumpWeeks,
  onPick,
  onOpenWorkout,
  onGhostTap,
}: {
  week: PlanWeekResponse;
  today: string;
  ghostsByDate: Map<string, PendingGhost[]>;
  /** The jump menu's entries — the active plans' weeks, labeled. */
  jumpWeeks: Array<{ monday: string; label: string }>;
  onPick: (monday: string) => void;
  onOpenWorkout: (id: string) => void;
  onGhostTap: (proposalId: string) => void;
}) {
  const thisMonday = startOfIsoWeek(today);
  const offCurrent = week.weekStart !== thisMonday;
  return (
    <section className="plan-week" aria-label="Week">
      <div className="plan-week-head">
        <span className="plan-week-nav" role="group" aria-label="Change week">
          <button type="button" aria-label="Previous week" onClick={() => onPick(addDays(week.weekStart, -7))}>
            ‹
          </button>
          <button type="button" aria-label="Next week" onClick={() => onPick(addDays(week.weekStart, 7))}>
            ›
          </button>
        </span>
        <h2 className="plan-week-title">
          {offCurrent ? null : <span className="pw-wide">This week · </span>}
          {weekRangeLabel(week.weekStart)}
        </h2>
        {week.weekIndex !== null ? (
          <span className="pill pill-neutral num">
            <span className="pw-wide">plan </span>wk {week.weekIndex}
          </span>
        ) : null}
        {offCurrent ? (
          <button type="button" className="chipbtn plan-week-back" onClick={() => onPick(thisMonday)}>
            back to this week
          </button>
        ) : null}
        <span className="plan-week-grow" />
        {jumpWeeks.length > 0 ? (
          <details className="plan-week-jump">
            <summary>
              <span className="pw-wide">jump to week</span>
              <span className="pw-narrow">weeks</span> ▾
            </summary>
            <div className="plan-week-jumplist" role="menu">
              {jumpWeeks.map((j) => (
                <button
                  key={j.monday}
                  type="button"
                  role="menuitem"
                  className={j.monday === week.weekStart ? "is-current" : ""}
                  onClick={(e) => {
                    (e.currentTarget.closest("details") as HTMLDetailsElement | null)?.removeAttribute("open");
                    onPick(j.monday);
                  }}
                >
                  {j.label}
                </button>
              ))}
            </div>
          </details>
        ) : null}
      </div>
      <div className="plan-week-grid">
        {week.days.map((day, i) => {
          const ghosts = ghostsByDate.get(day.date) ?? [];
          const isToday = day.date === today;
          const classes = [
            "plan-week-day",
            isToday ? "is-today" : "",
            day.workouts.length > 0 ? "has-items" : "",
            ghosts.length > 0 ? "has-ghosts" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <div key={day.date} className={classes}>
              <div className="plan-week-date">
                <span className="plan-week-dow">{WEEKDAY_HEADERS[i]}</span>
                <span className="plan-week-dom num">{dayOfMonth(day.date)}</span>
              </div>
              <div className="plan-week-items">
                {day.workouts.map((w) => (
                  <WorkoutCell key={w.id} w={w} today={today} onOpen={() => onOpenWorkout(w.id)} />
                ))}
                {ghosts.map((g, gi) => (
                  <button
                    key={`${g.proposalId}-${gi}`}
                    type="button"
                    className={`cal-ghost cal-ghost-${g.kind}`}
                    onClick={() => onGhostTap(g.proposalId)}
                    title={g.title}
                  >
                    {g.label}
                    <span className="cal-ghost-reason">{g.title} · pending</span>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
