import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ActivityDto, type WorkoutDto } from "@rg/api-client";
import {
  Banner,
  CategoryDot,
  CATEGORY_LABELS,
  EmptyState,
  formatDayLong,
  formatMinutes,
  Sheet,
  Spinner,
} from "../components.js";

function km(m: number | null): string {
  return m ? `${(m / 1000).toFixed(1)} km` : "";
}
function pace(secPerKm: number | null): string {
  if (!secPerKm) return "";
  const mm = Math.floor(secPerKm / 60);
  const ss = Math.round(secPerKm % 60);
  return `${mm}:${String(ss).padStart(2, "0")}/km`;
}
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

/** Sheet to attribute an unplanned run to a planned workout. */
function LinkSheet({ activity, onClose }: { activity: ActivityDto; onClose: () => void }) {
  const qc = useQueryClient();
  const plan = useQuery({ queryKey: ["plan"], queryFn: () => api.workouts() });
  const [linkedTo, setLinkedTo] = useState<WorkoutDto | null>(null);

  const candidates = useMemo(() => {
    const all = plan.data?.workouts ?? [];
    return all
      .filter(
        (w) =>
          w.category !== "rest" &&
          (w.completionState === "scheduled" || w.completionState === "unresolved") &&
          Math.abs(dayDiff(w.effectiveDate, activity.date)) <= 10,
      )
      .sort(
        (a, b) =>
          Math.abs(dayDiff(a.effectiveDate, activity.date)) -
          Math.abs(dayDiff(b.effectiveDate, activity.date)),
      );
  }, [plan.data, activity.date]);

  const link = useMutation({
    mutationFn: (workoutId: string) => api.match(workoutId, activity.id),
    onSuccess: (_res, workoutId) => {
      setLinkedTo(candidates.find((c) => c.id === workoutId) ?? null);
      void qc.invalidateQueries({ queryKey: ["runs"] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
      void qc.invalidateQueries({ queryKey: ["today"] });
    },
  });

  return (
    <Sheet open onClose={onClose} title="Link this run to a workout">
      {linkedTo ? (
        <div className="stack">
          <Banner kind="info">Linked to “{linkedTo.title}” — it's now marked done.</Banner>
          {linkedTo.effectiveDate !== activity.date ? (
            <p className="muted">
              It was planned for {formatDayLong(linkedTo.effectiveDate)}, but you ran on{" "}
              {formatDayLong(activity.date)}. To shuffle the rest of that week,{" "}
              <Link to={`/plan?workout=${linkedTo.id}`} onClick={onClose}>
                open it in Plan
              </Link>{" "}
              and move the surrounding runs.
            </p>
          ) : null}
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <div className="stack">
          <p className="muted">
            Which planned workout did this run cover? Nearest matches are first — the rest of your
            plan stays where it is.
          </p>
          {plan.isLoading ? (
            <Spinner label="Loading plan" />
          ) : candidates.length === 0 ? (
            <p className="muted">No open workouts near {formatDayLong(activity.date)} to link to.</p>
          ) : (
            candidates.slice(0, 8).map((w) => {
              const diff = dayDiff(w.effectiveDate, activity.date);
              return (
                <button
                  key={w.id}
                  className="workout-row"
                  disabled={link.isPending}
                  onClick={() => link.mutate(w.id)}
                >
                  <CategoryDot category={w.category} />
                  <div className="body">
                    <div className="title">{w.title}</div>
                    <div className="meta">
                      <span>{formatDayLong(w.effectiveDate)}</span>
                      <span>
                        {diff === 0
                          ? "same day"
                          : `${Math.abs(diff)}d ${diff < 0 ? "earlier" : "later"}`}
                      </span>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      )}
    </Sheet>
  );
}

export function RunsScreen() {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.activities(40) });
  const [linking, setLinking] = useState<ActivityDto | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const backfill = useMutation({
    mutationFn: () => api.backfillRuns(90),
    onSuccess: (r) => {
      setNote(
        !r.ok
          ? "Couldn't reach Strava — connect it in Settings to backfill history."
          : r.ingested === 0
            ? "No new past runs found in the last 90 days."
            : `Backfilled ${r.ingested} run${r.ingested === 1 ? "" : "s"}${
                r.matched ? `, matched ${r.matched} to your plan` : ""
              }.`,
      );
      void qc.invalidateQueries({ queryKey: ["runs"] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
      void qc.invalidateQueries({ queryKey: ["garden"] });
    },
    onError: () => setNote("Backfill failed. Try again in a moment."),
  });

  if (runs.isLoading) return <Spinner label="Loading runs" />;
  const items = (runs.data?.activities ?? []).filter((a) => a.sport === "run");

  return (
    <div>
      <div className="row-between screen-title">
        <h1>Runs</h1>
        <button className="btn btn-small" disabled={backfill.isPending} onClick={() => backfill.mutate()}>
          {backfill.isPending ? "Syncing…" : "Sync past runs"}
        </button>
      </div>
      {note ? <Banner kind="info">{note}</Banner> : null}
      {items.length === 0 ? (
        <EmptyState art="🏃" title="No runs yet">
          Completed runs from COROS and Strava appear here. Use “Sync past runs” to pull your Strava
          history.
        </EmptyState>
      ) : (
        items.map((a) => (
          <div key={a.id} className="workout-row" style={{ cursor: "default" }}>
            <div className="body">
              <div className="title">{a.title || "Run"}</div>
              <div className="meta">
                <span>{formatDayLong(a.date)}</span>
                <span>{formatMinutes(a.durationSeconds)}</span>
                {a.distanceMeters ? <span>{km(a.distanceMeters)}</span> : null}
                {a.avgPaceSecPerKm ? <span>{pace(a.avgPaceSecPerKm)}</span> : null}
              </div>
            </div>
            {a.matched ? (
              <span className="pill pill-ok" title={`Counted as your ${a.matched.title}`}>
                ✓ {CATEGORY_LABELS[a.matched.category] ?? a.matched.category}
              </span>
            ) : (
              <button className="btn btn-small" style={{ marginLeft: "auto" }} onClick={() => setLinking(a)}>
                Link to a workout
              </button>
            )}
          </div>
        ))
      )}
      {linking ? <LinkSheet activity={linking} onClose={() => setLinking(null)} /> : null}
    </div>
  );
}
