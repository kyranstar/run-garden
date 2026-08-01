import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type WorkoutDto } from "@rg/api-client";
import { startOfIsoWeek } from "@rg/domain";
import {
  Banner,
  Card,
  CategoryDot,
  CATEGORY_LABELS,
  CompletionPill,
  CorosPill,
  dayOfMonth,
  EmptyState,
  formatDayLong,
  formatMinutes,
  formatTime,
  Sheet,
  Spinner,
  weekdayShort,
} from "../components.js";
import { MoveSheet } from "./move-sheet.js";
import { MatchSheet } from "./match-sheet.js";

function WorkoutDetail({ w, onClose }: { w: WorkoutDto; onClose: () => void }) {
  const qc = useQueryClient();
  const [moving, setMoving] = useState(false);
  const [matching, setMatching] = useState(false);
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

  const stages = (detail.data?.stages ?? []) as Array<Record<string, unknown>>;
  const match = detail.data?.match as { activity?: Record<string, unknown> } | null | undefined;

  return (
    <Sheet open onClose={onClose} title={w.title}>
      <div className="stack">
        <div className="row">
          <CategoryDot category={w.category} />
          <span className="muted">{CATEGORY_LABELS[w.category] ?? w.category}</span>
          <CompletionPill state={w.completionState} />
          <CorosPill state={w.corosSyncState} hideWhenHealthy />
        </div>
        <p>
          {formatDayLong(w.effectiveDate)} at {formatTime(w.effectiveTime)}
        </p>
        {w.effectiveDate !== w.lastVerifiedCorosDate ? (
          <Banner kind={w.corosSyncState === "needs_attention" ? "warn" : "info"}>
            {w.corosSyncState === "needs_attention"
              ? `COROS has this on ${formatDayLong(w.lastVerifiedCorosDate)}; Run Garden has ${formatDayLong(w.effectiveDate)}. Pick where it should live.`
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
          {w.completionState === "scheduled" && w.category !== "rest" ? (
            <button className="btn btn-primary" onClick={() => setMoving(true)}>
              Move
            </button>
          ) : null}
          {w.completionState === "unresolved" ? (
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
          {w.corosSyncState === "needs_attention" || w.corosSyncState === "calendar_only" ? (
            <button className="btn" disabled={retry.isPending} onClick={() => retry.mutate()}>
              Retry COROS sync
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
        </div>
      </div>
      <MoveSheet workout={w} open={moving} onClose={() => setMoving(false)} />
      <MatchSheet workout={w} open={matching} onClose={() => setMatching(false)} />
    </Sheet>
  );
}

export function PlanScreen() {
  const [params, setParams] = useSearchParams();
  const plan = useQuery({ queryKey: ["plan"], queryFn: () => api.workouts() });
  const selectedId = params.get("workout");

  const weeks = useMemo(() => {
    const map = new Map<string, WorkoutDto[]>();
    for (const w of plan.data?.workouts ?? []) {
      const wk = startOfIsoWeek(w.effectiveDate);
      const list = map.get(wk) ?? [];
      list.push(w);
      map.set(wk, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [plan.data]);

  if (plan.isLoading) return <Spinner label="Loading plan" />;
  if (!plan.data) return <EmptyState title="Couldn't load the plan" />;

  const selected = plan.data.workouts.find((w) => w.id === selectedId);

  return (
    <div>
      <div className="row-between screen-title">
        <h1>Plan</h1>
        {plan.data.plan ? <span className="muted">{plan.data.plan.name}</span> : null}
      </div>
      {plan.data.workouts.length === 0 ? (
        <EmptyState art="🗓" title="No active COROS training plan was found">
          Start a plan in COROS, then refresh from the desktop app.
        </EmptyState>
      ) : (
        weeks.map(([weekStart, workouts]) => (
          <section key={weekStart}>
            <h2 className="week-header">Week of {formatDayLong(weekStart)}</h2>
            {workouts.map((w) => (
              <button
                key={w.id}
                className={`workout-row ${w.completionState === "completed" || w.completionState === "provisionally_completed" ? "done" : ""}`}
                onClick={() => setParams({ workout: w.id })}
              >
                <div className="date" aria-hidden>
                  <div className="dow">{weekdayShort(w.effectiveDate)}</div>
                  <div className="dom">{dayOfMonth(w.effectiveDate)}</div>
                </div>
                <CategoryDot category={w.category} />
                <div className="body">
                  <div className="title">{w.title}</div>
                  <div className="meta">
                    {w.category !== "rest" ? (
                      <>
                        <span>{formatTime(w.effectiveTime)}</span>
                        <span>{formatMinutes(w.workoutSeconds)}</span>
                      </>
                    ) : (
                      <span>Rest day</span>
                    )}
                  </div>
                </div>
                <CompletionPill state={w.completionState} />
                <CorosPill state={w.corosSyncState} hideWhenHealthy />
              </button>
            ))}
          </section>
        ))
      )}
      {selected ? <WorkoutDetail w={selected} onClose={() => setParams({})} /> : null}
    </div>
  );
}
