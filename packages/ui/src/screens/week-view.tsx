import { useRef, useState } from "react";
import type { CoachPlanDto, PlanWeekResponse, RaceHubResponse, WorkoutDto } from "@rg/api-client";
import { addDays, humanizeWorkoutTitle, linesOf, startOfIsoWeek, weekNaming, type LineBlock, type TrainingLine } from "@rg/domain";
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
      data-workout={w.id}
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

/** The week's title, in words (the new shape §6): this week, next, last — else its dates. */
export function weekTitle(weekStart: string, today: string): string {
  const thisMonday = startOfIsoWeek(today);
  if (weekStart === thisMonday) return "This week";
  if (weekStart === addDays(thisMonday, 7)) return "Next week";
  if (weekStart === addDays(thisMonday, -7)) return "Last week";
  return weekRangeLabel(weekStart);
}

/** A coach block's own week of `weekStart`, as the server counts a block's weeks (Monday to Monday from its first). */
function blockWeekOf(p: Pick<CoachPlanDto, "startDate" | "endDate">, weekStart: string): string {
  const w1 = startOfIsoWeek(p.startDate);
  const weeks = (to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${w1}T12:00:00Z`)) / (7 * 86_400_000)) + 1;
  return `week ${weeks(weekStart)} of ${weeks(startOfIsoWeek(p.endDate))}`;
}

type WeekPlanBlock = Pick<CoachPlanDto, "id" | "name" | "discipline" | "raceDate" | "startDate" | "endDate" | "source"> &
  Partial<Pick<CoachPlanDto, "status" | "planRaceDate">>;

/**
 * The plan a week's line names, its week, and how many other groups hold the week — by `weekNaming`, the one rule the
 * week brief shares (training lines §3.6). A plan holds a week when it runs into it (one starting mid-week holds it;
 * one that ended the Sunday before does not).
 *  - The MAIN group: the one holding the most of the week's sessions (`week`'s rows by their plan); a tie to the run
 *    line with a race, then the earlier start. A group is a training line or a plan of its own (Studio, COROS). Inside
 *    a line the phase holding the most sessions names the week; a tie to the later start.
 *  - Its own count: a coach block's, counted from its own dates as the server counts a block's weeks — never the count
 *    the week's read gives, which is the longest block's. A watch plan's (or the Studio's) week isn't one the read
 *    gives: none.
 *  - `planMore`: the other groups holding the week ("+1"); a line's own phases are never one.
 *  - `lines`: as the plans read answers them; absent, worked out from the coach blocks.
 *  - None holding it: no name; the count as the read gives it (`planWeekOf` undefined).
 */
export function weekPlan(
  blocks: ReadonlyArray<WeekPlanBlock>,
  weekStart: string,
  week?: Pick<PlanWeekResponse, "days"> | null,
  lines?: ReadonlyArray<TrainingLine>,
): { planName: string | null; planWeekOf: string | null | undefined; planMore: number } {
  const sessionsByPlan = new Map<string, number>();
  for (const d of week?.days ?? []) {
    for (const w of d.workouts) {
      if (w.planId && w.category !== "rest") sessionsByPlan.set(w.planId, (sessionsByPlan.get(w.planId) ?? 0) + 1);
    }
  }
  // The lines the plans read answers; an older payload has none, so they are worked out from the coach blocks.
  const known =
    lines ??
    linesOf(
      blocks
        .filter((b) => (b.source ?? "coach") === "coach")
        .map((b) => ({
          id: b.id,
          discipline: b.discipline as LineBlock["discipline"],
          status: (b.status ?? "active") as LineBlock["status"],
          name: b.name,
          startDate: b.startDate,
          endDate: b.endDate,
          planRaceDate: b.planRaceDate ?? b.raceDate,
        })),
      weekStart,
    );
  const named = weekNaming(blocks, known, weekStart, sessionsByPlan);
  const main = blocks.find((b) => b.id === named.planId);
  if (!main) return { planName: null, planWeekOf: undefined, planMore: 0 };
  return { planName: main.name, planWeekOf: (main.source ?? "coach") === "coach" ? blockWeekOf(main, weekStart) : null, planMore: named.others };
}

/**
 * The week-jump menu: the plans' weeks, the longest span numbering the list. A coach phase's span is its whole line's
 * (a line's second phase carries on the count from the line's first phase, never "wk 1" again); a Studio or COROS plan's
 * is its own. With no lines (an older payload) a phase counts from its own start.
 */
export function jumpWeeksOf(
  plans: ReadonlyArray<Pick<CoachPlanDto, "id" | "startDate" | "endDate" | "source">>,
  lines?: ReadonlyArray<Pick<TrainingLine, "startDate" | "endDate" | "phases">>,
): Array<{ monday: string; label: string }> {
  if (plans.length === 0) return [];
  const spans = plans.map((p) => {
    const line = (p.source ?? "coach") === "coach" ? lines?.find((l) => l.phases.some((ph) => ph.id === p.id)) : undefined;
    return { start: startOfIsoWeek(line?.startDate ?? p.startDate), end: startOfIsoWeek(line?.endDate ?? p.endDate) };
  });
  const anchor = spans.reduce((a, b) => (Date.parse(b.end) - Date.parse(b.start) > Date.parse(a.end) - Date.parse(a.start) ? b : a));
  const mondays = new Set<string>();
  for (const s of spans) {
    for (let m = s.start; m <= s.end; m = addDays(m, 7)) mondays.add(m);
  }
  return [...mondays].sort().map((monday) => {
    const idx = Math.floor((Date.parse(monday) - Date.parse(anchor.start)) / 604_800_000) + 1;
    const inAnchor = monday >= anchor.start && monday <= anchor.end;
    return { monday, label: `${inAnchor ? `wk ${idx} · ` : ""}${weekRangeLabel(monday)}` };
  });
}

/** The plan a week's line names (`weekPlan`'s main plan). */
export function weekPlanName(blocks: ReadonlyArray<WeekPlanBlock>, weekStart: string, week?: Pick<PlanWeekResponse, "days"> | null): string | null {
  return weekPlan(blocks, weekStart, week).planName;
}

/** What the week's line knows of the race: its countdown and its phase (the race hub's). */
export type WeekRace = Pick<NonNullable<RaceHubResponse["race"]>, "daysToRace" | "phase">;

/**
 * The week's one line (the new shape §6): the race strip and the weekly brief fold into it — its dates, the plan and its
 * week, how many of its sessions are done, the race's countdown. A part it does not know is left out, never guessed;
 * a race gone by says nothing here (its debrief is one tap down, in the brief).
 */
export function weekLine({
  week,
  planName,
  race,
  planWeekOf,
  planMore = 0,
}: {
  week: PlanWeekResponse;
  planName: string | null;
  race: WeekRace | null;
  /** The named plan's own week ("week 1 of 4"; `weekPlan`): null for none; absent, the week read's count. */
  planWeekOf?: string | null;
  /** The other plans holding the week: "+1". */
  planMore?: number;
}): string {
  const readWeek = week.weekIndex !== null && week.weekTotal !== null ? `week ${week.weekIndex} of ${week.weekTotal}` : null;
  const weekOf = planWeekOf === undefined ? readWeek : planWeekOf;
  const named = planName ? (weekOf ? `${planName}, ${weekOf}` : planName) : weekOf;
  const plan = named && planMore > 0 ? `${named} +${planMore}` : named;
  const done = week.sessionCount > 0 ? `${week.doneCount} of ${week.sessionCount} done` : null;
  const raceWords =
    !race || race.phase === "post" || race.daysToRace < 0
      ? null
      : race.daysToRace === 0
        ? "Race day"
        : race.daysToRace === 1
          ? "Race tomorrow"
          : `Race in ${race.daysToRace} days`;
  return [weekRangeLabel(week.weekStart), plan, done, raceWords].filter((p): p is string => !!p).join(" · ");
}

/**
 * Where the jump menu opens (audit 2026-08-14). It hangs `top: 100%` off a
 * summary that can sit anywhere down the page — measured live in prod at
 * bottom 977px inside an 862px viewport, so the last weeks of a long plan
 * were simply unreachable. Flip above the trigger when the rendered list
 * would run past the fold AND there is more room up there; otherwise stay
 * below, where a menu is expected. Pure, so the rule is testable without a
 * DOM (same shape as garden.tsx's `dockCoversStage`).
 */
export function jumplistDropsUp(
  spaceAbove: number,
  spaceBelow: number,
  listHeight: number,
  margin = 8,
): boolean {
  return listHeight + margin > spaceBelow && spaceAbove > spaceBelow;
}

/**
 * Scroll offset that centres the current week inside the open menu. The menu
 * always opened at scrollTop 0, so ten weeks into a block the highlighted
 * `.is-current` row was below the list's own fold — the one row the reader
 * came to find. Clamped to the scrollable range so a current week near either
 * end doesn't ask for a scroll position that doesn't exist.
 */
export function centerScrollTop(
  itemTop: number,
  itemHeight: number,
  viewHeight: number,
  scrollHeight: number,
): number {
  return Math.max(0, Math.min(scrollHeight - viewHeight, itemTop + itemHeight / 2 - viewHeight / 2));
}

export function WeekView({
  week,
  today,
  ghostsByDate,
  jumpWeeks,
  onPick,
  onOpenWorkout,
  onGhostTap,
  onBrief,
  planName = null,
  planWeekOf,
  planMore = 0,
  race = null,
  /** Steps the week by ±7 days from the last REQUESTED week. Clicks fired
   * inside one render tick must accumulate, so the caller owns the cursor
   * (a rendered-week or URL-derived base collapses them — live-verified:
   * 5 fast clicks advanced 1 week). */
  onStep,
  /** True while the shown week is the previous one, kept during the fetch. */
  loading = false,
}: {
  week: PlanWeekResponse;
  today: string;
  ghostsByDate: Map<string, PendingGhost[]>;
  /** The jump menu's entries — the active plans' weeks, labeled. */
  jumpWeeks: Array<{ monday: string; label: string }>;
  onPick: (monday: string) => void;
  onOpenWorkout: (id: string) => void;
  onGhostTap: (proposalId: string) => void;
  onStep: (deltaDays: number) => void;
  /** The line opens the week's brief (its numbers, the coach's line, the race). */
  onBrief: () => void;
  /** The plan the week belongs to, named on its line. */
  planName?: string | null;
  /** That plan's own week (`weekPlan`): null for none; absent, the week read's count. */
  planWeekOf?: string | null;
  /** The other plans holding the week ("+1"). */
  planMore?: number;
  /** The race's countdown, on the line. */
  race?: WeekRace | null;
  loading?: boolean;
}) {
  const thisMonday = startOfIsoWeek(today);
  const offCurrent = week.weekStart !== thisMonday;
  const jumpRef = useRef<HTMLDetailsElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [dropUp, setDropUp] = useState(false);
  // Measured on open, when the list is laid out and its real height is known
  // (a closed <details> has none). Closing resets, so the next open decides
  // afresh — the trigger moves as the page scrolls.
  const onJumpToggle = () => {
    const details = jumpRef.current;
    const list = listRef.current;
    if (!details || !list) return;
    if (!details.open) {
      setDropUp(false);
      return;
    }
    const box = details.getBoundingClientRect();
    setDropUp(
      jumplistDropsUp(box.top, window.innerHeight - box.bottom, list.getBoundingClientRect().height),
    );
    const current = list.querySelector<HTMLElement>(".is-current");
    if (current) {
      list.scrollTop = centerScrollTop(
        current.offsetTop,
        current.offsetHeight,
        list.clientHeight,
        list.scrollHeight,
      );
    }
  };
  return (
    <section
      className={`plan-week${loading ? " is-loading" : ""}`}
      aria-label="Week"
      aria-busy={loading || undefined}
    >
      <div className="plan-week-head">
        <span className="plan-week-nav" role="group" aria-label="Change week">
          <button type="button" aria-label="Previous week" onClick={() => onStep(-7)}>
            ‹
          </button>
          <button type="button" aria-label="Next week" onClick={() => onStep(7)}>
            ›
          </button>
        </span>
        <h2 className="plan-week-title" tabIndex={-1}>
          {weekTitle(week.weekStart, today)}
        </h2>
        {offCurrent ? (
          <button type="button" className="chipbtn plan-week-back" onClick={() => onPick(thisMonday)}>
            back to this week
          </button>
        ) : null}
        <span className="plan-week-grow" />
        {jumpWeeks.length > 0 ? (
          <details className="plan-week-jump" ref={jumpRef} onToggle={onJumpToggle}>
            <summary>
              <span className="pw-wide">jump to week</span>
              <span className="pw-narrow">weeks</span> ▾
            </summary>
            {/* `.scroller`: the menu caps at 300px and a long block runs well
                past it — it has to say so, and it opens mid-list (see
                centerScrollTop) where an unmarked scroll box reads as the
                whole list. */}
            <div
              className={`plan-week-jumplist scroller${dropUp ? " drops-up" : ""}`}
              role="menu"
              ref={listRef}
            >
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
      {/* The race strip and the weekly brief, folded into one line: the brief is one tap down. */}
      <button type="button" className="plan-week-line" aria-haspopup="dialog" onClick={onBrief}>
        {weekLine({ week, planName, planWeekOf, planMore, race })}
      </button>
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
            <div key={day.date} className={classes} data-date={day.date}>
              <div className="plan-week-date" tabIndex={-1}>
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

/**
 * Where focus goes once a workout's card has left the week (its sheet's Remove, re-review N3): the next card of its
 * day, else the day's heading, else the week's — never the page.
 */
export function focusAfterRemove(date: string, workoutId: string): void {
  const day = document.querySelector<HTMLElement>(`[data-date="${date}"]`);
  const next = [...(day?.querySelectorAll<HTMLElement>(".cal-card") ?? [])].find((c) => c.dataset.workout !== workoutId);
  const to = next ?? day?.querySelector<HTMLElement>(".plan-week-date") ?? document.querySelector<HTMLElement>(".plan-week-title");
  to?.focus();
}
