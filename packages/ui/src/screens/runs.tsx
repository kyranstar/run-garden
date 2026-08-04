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

function dist(m: number | null): string {
  if (!m) return "";
  return `${(m / 1000).toFixed(1)} km · ${(m / 1609.344).toFixed(1)} mi`;
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

type DisciplineFilter = "all" | "run" | "strength" | "yoga";

const FILTERS: { key: DisciplineFilter; label: string; chipClass: string }[] = [
  { key: "all", label: "All", chipClass: "chip-all" },
  { key: "run", label: "Runs", chipClass: "chip-run" },
  { key: "strength", label: "Lifting", chipClass: "chip-strength" },
  { key: "yoga", label: "Yoga", chipClass: "chip-yoga" },
];

/**
 * "All" shows every session Run Garden stores, including sports outside the
 * garden's three disciplines (ski, admitted for its training load). Those have
 * no chip of their own — they are real training to see in your history, not a
 * fourth thing the garden asks you to keep up.
 */
const SPORT_LABELS: Record<string, string> = {
  run: "Run",
  strength: "Strength",
  yoga: "Yoga",
  ski: "Ski",
};

const EMPTY_COPY: Record<DisciplineFilter, { art: string; title: string; body: string }> = {
  all: {
    art: "🏃",
    title: "No activity yet",
    body: "Completed runs, lifts, and yoga sessions appear here. Use “Sync past runs” to pull your Strava run history.",
  },
  run: {
    art: "🏃",
    title: "No runs yet",
    body: "Completed runs from COROS and Strava appear here. Use “Sync past runs” to pull your Strava history.",
  },
  strength: {
    art: "🏋️",
    title: "No lifts yet",
    body: "Completed strength sessions from COROS appear here.",
  },
  yoga: {
    art: "🧘",
    title: "No yoga sessions yet",
    body: "Completed yoga sessions from COROS appear here.",
  },
};

/** Sheet to attribute an unplanned activity to a planned workout. */
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
    <Sheet open onClose={onClose} title="Link this activity to a workout">
      {linkedTo ? (
        <div className="stack">
          <Banner kind="info">Linked to “{linkedTo.title}” — it's now marked done.</Banner>
          {linkedTo.effectiveDate !== activity.date ? (
            <p className="muted">
              It was planned for {formatDayLong(linkedTo.effectiveDate)}, but you logged it on{" "}
              {formatDayLong(activity.date)}. To shuffle the rest of that week,{" "}
              <Link to={`/plan?workout=${linkedTo.id}`} onClick={onClose}>
                open it in Plan
              </Link>{" "}
              and move the surrounding sessions.
            </p>
          ) : null}
          <button className="btn" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <div className="stack">
          <p className="muted">
            Which planned workout did this activity cover? Nearest matches are first — the rest of
            your plan stays where it is.
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
  const [filter, setFilter] = useState<DisciplineFilter>("all");

  const backfill = useMutation({
    mutationFn: () => api.backfillHistory(),
    onSuccess: (r) => {
      // The walk runs on the desktop bridge, chunk by chunk, so this only
      // reports that it was queued — Settings shows the progress.
      setNote(
        !r.enqueued
          ? r.reason === "already_running"
            ? "Already reading your history — see Settings for progress."
            : "Couldn't start the backfill. Open the desktop app and try again."
          : "Reading your COROS history — runs, lifts, and yoga. Progress is in Settings.",
      );
      void qc.invalidateQueries({ queryKey: ["runs"] });
      void qc.invalidateQueries({ queryKey: ["plan"] });
      void qc.invalidateQueries({ queryKey: ["garden"] });
    },
    onError: () => setNote("Backfill failed. Try again in a moment."),
  });

  if (runs.isLoading) return <Spinner label="Loading activity" />;
  if (runs.isError) {
    // A failed load must never masquerade as "you have no activity".
    return (
      <div className="stack">
        <Banner kind="warn">Couldn't load your activity — check your connection.</Banner>
        <button className="btn" onClick={() => void runs.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  const items = (runs.data?.activities ?? []).filter((a) =>
    filter === "all" ? true : a.sport === filter,
  );
  const empty = EMPTY_COPY[filter];

  return (
    <div>
      <div className="row-between screen-title">
        <h1>Activity</h1>
        <button className="btn btn-small" disabled={backfill.isPending} onClick={() => backfill.mutate()}>
          {backfill.isPending ? "Syncing…" : "Sync past runs"}
        </button>
      </div>
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
      {note ? <Banner kind="info">{note}</Banner> : null}
      {items.length === 0 ? (
        <EmptyState art={empty.art} title={empty.title}>
          {empty.body}
        </EmptyState>
      ) : (
        items.map((a) => (
          <div key={a.id} className="workout-row" style={{ cursor: "default" }}>
            <div className="body">
              <div className="title">{a.title || SPORT_LABELS[a.sport] || "Activity"}</div>
              <div className="meta">
                <span>{formatDayLong(a.date)}</span>
                <span>{formatMinutes(a.durationSeconds)}</span>
                {a.distanceMeters ? <span>{dist(a.distanceMeters)}</span> : null}
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
