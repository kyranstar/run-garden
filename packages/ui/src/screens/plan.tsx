import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type WorkoutDto } from "@rg/api-client";
import { addDays, startOfIsoWeek } from "@rg/domain";
import {
  Banner,
  CategoryDot,
  CATEGORY_LABELS,
  CompletionPill,
  CorosPill,
  dayOfMonth,
  EmptyState,
  formatDayLong,
  formatMinutes,
  formatTime,
  monthTitle,
  Sheet,
  Spinner,
} from "../components.js";
import { IconAlert, IconCheck, IconClock } from "../icons.js";
import { MoveSheet } from "./move-sheet.js";
import { MatchSheet } from "./match-sheet.js";
import { StudioSection } from "./studio.js";

/**
 * "Did this run happen?" only ever makes sense for a date that has passed.
 * A workout can sit in `unresolved` with a future date briefly (it was
 * rescheduled after the question was raised); render it as scheduled.
 */
function askable(w: WorkoutDto, today: string): boolean {
  return w.completionState === "unresolved" && w.effectiveDate <= today;
}

function displayCompletionState(w: WorkoutDto, today: string): WorkoutDto["completionState"] {
  return w.completionState === "unresolved" && !askable(w, today) ? "scheduled" : w.completionState;
}

function WorkoutDetail({
  w,
  today,
  corosWritesEnabled,
  onClose,
}: {
  w: WorkoutDto;
  today: string;
  corosWritesEnabled: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [moving, setMoving] = useState(false);
  const [matching, setMatching] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const detail = useQuery({
    queryKey: ["workout", w.id],
    queryFn: () => api.workout(w.id),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["plan"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
    void qc.invalidateQueries({ queryKey: ["workout", w.id] });
  };
  const retry = useMutation({ mutationFn: () => api.retryCoros(w.id), onSuccess: invalidate });
  const restore = useMutation({ mutationFn: () => api.restoreCalendar(w.id), onSuccess: invalidate });
  const unmatch = useMutation({ mutationFn: () => api.unmatch(w.id), onSuccess: invalidate });
  const skip = useMutation({ mutationFn: () => api.skip(w.id), onSuccess: invalidate });
  const remove = useMutation({
    mutationFn: () => api.removeWorkout(w.id),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const stages = (detail.data?.stages ?? []) as Array<Record<string, unknown>>;
  const match = detail.data?.match as { activity?: Record<string, unknown> } | null | undefined;
  const asks = askable(w, today);
  const completion = displayCompletionState(w, today);
  const outOfSync = w.corosSyncState === "needs_attention" || w.corosSyncState === "calendar_only";

  return (
    <Sheet open onClose={onClose} title={w.title}>
      <div className="stack">
        <div className="row">
          <CategoryDot category={w.category} />
          <span className="muted">{CATEGORY_LABELS[w.category] ?? w.category}</span>
          <CompletionPill state={completion} />
          <CorosPill state={w.corosSyncState} hideWhenHealthy />
        </div>
        <p>
          {formatDayLong(w.effectiveDate)} at {formatTime(w.effectiveTime)}
        </p>
        {w.effectiveDate !== w.lastVerifiedCorosDate ? (
          <Banner kind={w.corosSyncState === "needs_attention" ? "warn" : "info"}>
            {w.corosSyncState === "needs_attention"
              ? `COROS has this on ${formatDayLong(w.lastVerifiedCorosDate)}; Run Garden has ${formatDayLong(w.effectiveDate)}. Pick where it should live.`
              : w.corosSyncState === "calendar_only"
                ? `Your COROS watch still has this on ${formatDayLong(w.lastVerifiedCorosDate)} — this move hasn't been written to COROS.`
                : `COROS still shows ${formatDayLong(w.lastVerifiedCorosDate)} — the update is on its way.`}
          </Banner>
        ) : null}
        <div className="hero-durations">
          <div>
            <div className="num">{formatMinutes(w.workoutSeconds)}</div>
            <div className="lbl">Workout{w.estimateSource === "coros_native" ? " · COROS estimate" : ""}</div>
          </div>
          <div>
            <div className="num">{formatMinutes(w.calendarSeconds)}</div>
            <div className="lbl">Calendar block</div>
          </div>
        </div>
        {w.stageSummary ? <div className="stage-summary">{w.stageSummary}</div> : null}
        {stages.length > 0 ? (
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>
              Full structure ({stages.filter((s) => s.kind !== "repeat").length} stages)
            </summary>
            <ul className="muted" style={{ paddingLeft: "1.2rem", marginTop: "0.4rem" }}>
              {stages.map((s) => (
                <li key={s.id as string}>
                  {s.kind as string}
                  {s.repeatCount ? ` × ${s.repeatCount}` : ""}
                  {s.durationSeconds ? ` — ${Math.round((s.durationSeconds as number) / 60)} min` : ""}
                  {s.distanceMeters ? ` — ${((s.distanceMeters as number) / 1000).toFixed(2)} km` : ""}
                  {s.label ? ` (${s.label})` : ""}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        {match?.activity ? (
          <p className="muted">
            Completed with “{(match.activity.title as string) ?? "activity"}” ·{" "}
            {formatMinutes(match.activity.durationSeconds as number)}
            {match.activity.distanceMeters
              ? ` · ${((match.activity.distanceMeters as number) / 1000).toFixed(1)} km`
              : ""}
          </p>
        ) : null}

        <div className="btn-row">
          {completion === "scheduled" && w.category !== "rest" ? (
            <button className="btn btn-primary" onClick={() => setMoving(true)}>
              Move
            </button>
          ) : null}
          {asks ? (
            <>
              <button className="btn btn-primary" onClick={() => setMatching(true)}>
                Match activity
              </button>
              <button className="btn" onClick={() => setMoving(true)}>
                Move it
              </button>
              <button className="btn" disabled={skip.isPending} onClick={() => skip.mutate()}>
                Skip it
              </button>
            </>
          ) : null}
          {outOfSync && corosWritesEnabled ? (
            <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate()}>
              Sync to COROS
            </button>
          ) : null}
          {w.calendarSyncState === "user_deleted" ? (
            <button className="btn" disabled={restore.isPending} onClick={() => restore.mutate()}>
              Restore to Calendar
            </button>
          ) : null}
          {(w.completionState === "completed" || w.completionState === "provisionally_completed") ? (
            <button className="btn" disabled={unmatch.isPending} onClick={() => unmatch.mutate()}>
              Undo match
            </button>
          ) : null}
          {w.completionState !== "completed" && w.completionState !== "provisionally_completed" ? (
            !confirmRemove ? (
              <button className="btn" onClick={() => setConfirmRemove(true)}>
                Remove from plan
              </button>
            ) : (
              <button className="btn btn-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Really remove — clears it from Run Garden and Calendar (COROS untouched)
              </button>
            )
          ) : null}
        </div>
        {outOfSync && !corosWritesEnabled ? (
          <p className="faint">
            COROS sync is off, so this can't be pushed to your watch.{" "}
            <Link to="/settings">Enable it in Settings</Link>.
          </p>
        ) : null}
      </div>
      <MoveSheet workout={w} open={moving} onClose={() => setMoving(false)} />
      <MatchSheet workout={w} open={matching} onClose={() => setMatching(false)} />
    </Sheet>
  );
}

// ── Calendar assembly ────────────────────────────────────────────────────────

interface CalDay {
  date: string;
  items: WorkoutDto[];
}
interface CalWeek {
  weekStart: string;
  days: CalDay[];
}
interface CalMonth {
  key: string;
  month: string;
  year: number;
  weeks: CalWeek[];
}

/** Continuous ISO weeks spanning the plan (and today), grouped by the month
 * their Monday falls in — gaps render as quiet empty cells, like an almanac. */
function buildMonths(workouts: WorkoutDto[], today: string | undefined): CalMonth[] {
  const byDate = new Map<string, WorkoutDto[]>();
  for (const w of workouts) {
    const list = byDate.get(w.effectiveDate) ?? [];
    list.push(w);
    byDate.set(w.effectiveDate, list);
  }
  if (byDate.size === 0) return [];
  const dates = [...byDate.keys()].sort();
  let start = startOfIsoWeek(dates[0]!);
  let end = startOfIsoWeek(dates[dates.length - 1]!);
  if (today) {
    const tw = startOfIsoWeek(today);
    if (tw < start) start = tw;
    if (tw > end) end = tw;
  }

  const months: CalMonth[] = [];
  for (let ws = start, guard = 0; ws <= end && guard < 80; ws = addDays(ws, 7), guard++) {
    const { month, year } = monthTitle(ws);
    const key = `${year}-${month}`;
    if (months.length === 0 || months[months.length - 1]!.key !== key) {
      months.push({ key, month, year, weeks: [] });
    }
    months[months.length - 1]!.weeks.push({
      weekStart: ws,
      days: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(ws, i);
        return { date, items: byDate.get(date) ?? [] };
      }),
    });
  }
  return months;
}

const WEEKDAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function WorkoutCell({
  w,
  today,
  onOpen,
}: {
  w: WorkoutDto;
  today: string;
  onOpen: () => void;
}) {
  const completion = displayCompletionState(w, today);
  const done = completion === "completed" || completion === "provisionally_completed";
  const faded = completion === "skipped" || completion === "missed";
  const asks = askable(w, today);
  const attention = w.corosSyncState === "needs_attention";

  if (w.category === "rest") {
    return (
      <button className="cal-card cal-rest" onClick={onOpen}>
        <span className="cal-card-title">Rest</span>
      </button>
    );
  }
  return (
    <button
      className={`cal-card ${done ? "done" : ""} ${faded ? "faded" : ""} ${asks ? "asks" : ""}`}
      onClick={onOpen}
      title={w.title}
    >
      <i className={`cal-card-edge cat-${w.category}`} aria-hidden />
      <span className="cal-card-title">{w.title}</span>
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

export function PlanScreen() {
  const [params, setParams] = useSearchParams();
  // Explicit horizon: the server's default window (8 weeks ahead) is shorter
  // than the longest lifting plan (16 weeks) — without this, a synced plan's
  // back half was visible nowhere in the app.
  const plan = useQuery({
    queryKey: ["plan"],
    queryFn: () => {
      const d = new Date();
      const iso = (x: Date) => x.toISOString().slice(0, 10);
      const start = new Date(d);
      start.setDate(start.getDate() - 8 * 7);
      const end = new Date(d);
      end.setDate(end.getDate() + 18 * 7);
      return api.workouts(iso(start), iso(end));
    },
  });
  const selectedId = params.get("workout");
  const todayRef = useRef<HTMLDivElement | null>(null);
  const scrolled = useRef(false);
  const today = plan.data?.today;
  const todayWeek = today ? startOfIsoWeek(today) : null;

  // Land on the current week on first load, so today's work is front and
  // centre instead of buried under weeks of history.
  useEffect(() => {
    if (plan.data && !scrolled.current && todayRef.current) {
      scrolled.current = true;
      todayRef.current.scrollIntoView({ block: "center" });
    }
  }, [plan.data]);

  const months = useMemo(
    () => buildMonths(plan.data?.workouts ?? [], plan.data?.today),
    [plan.data],
  );

  if (plan.isLoading) return <Spinner label="Loading plan" />;
  if (!plan.data) return <EmptyState title="Couldn't load the plan" />;

  const selected = plan.data.workouts.find((w) => w.id === selectedId);
  const openWorkout = (id: string) => setParams({ workout: id });

  return (
    <div>
      <div className="row-between screen-title">
        <h1>Plan</h1>
        <div className="row">
          {plan.data.plan ? <span className="muted">{plan.data.plan.name}</span> : null}
          {plan.data.workouts.length > 0 ? (
            <button
              className="btn btn-small"
              onClick={() => todayRef.current?.scrollIntoView({ block: "center", behavior: "smooth" })}
            >
              Today
            </button>
          ) : null}
        </div>
      </div>
      <StudioSection />
      {plan.data.workouts.length === 0 ? (
        <EmptyState art="🗓" title="No active COROS training plan was found">
          Start a plan in COROS, then refresh from the desktop app.
        </EmptyState>
      ) : (
        months.map((m) => (
          <section key={m.key} className="cal-month">
            <h2 className="cal-month-title">
              {m.month} <span className="cal-year">{m.year}</span>
            </h2>
            <div className="cal-weekdays" aria-hidden>
              {WEEKDAY_HEADERS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            {m.weeks.map((week) => (
              <div
                key={week.weekStart}
                className={`cal-week ${week.weekStart === todayWeek ? "current" : ""}`}
                ref={week.weekStart === todayWeek ? todayRef : undefined}
              >
                {week.days.map((day) => {
                  const isToday = day.date === today;
                  const isPast = !!today && day.date < today;
                  return (
                    <div
                      key={day.date}
                      className={`cal-day ${isToday ? "is-today" : ""} ${isPast ? "is-past" : ""} ${day.items.length > 0 ? "has-items" : ""}`}
                    >
                      <div className="cal-date">
                        <span className="cal-dow">{WEEKDAY_HEADERS[(new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7]}</span>
                        <span className="cal-dom">{dayOfMonth(day.date)}</span>
                      </div>
                      {day.items.map((w) => (
                        <WorkoutCell key={w.id} w={w} today={today!} onOpen={() => openWorkout(w.id)} />
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        ))
      )}
      {selected && today ? (
        <WorkoutDetail
          w={selected}
          today={today}
          corosWritesEnabled={plan.data.corosWritesEnabled ?? false}
          onClose={() => setParams({})}
        />
      ) : null}
    </div>
  );
}
