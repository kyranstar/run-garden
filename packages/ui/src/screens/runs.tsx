import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ActivityDto, type WorkoutDto } from "@rg/api-client";
import { isAdventureSport, sportLabel } from "@rg/domain";
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
import { CoachRead } from "./coach-read.js";

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

type DisciplineFilter = "all" | "run" | "strength" | "yoga" | "adventure";

const FILTERS: { key: DisciplineFilter; label: string; chipClass: string }[] = [
  { key: "all", label: "All", chipClass: "chip-all" },
  { key: "run", label: "Runs", chipClass: "chip-run" },
  { key: "strength", label: "Lifting", chipClass: "chip-strength" },
  { key: "yoga", label: "Yoga", chipClass: "chip-yoga" },
  { key: "adventure", label: "Adventures", chipClass: "chip-adventure" },
];

/**
 * "All" shows every session Run Garden stores, including sports outside the
 * garden's three disciplines (hikes, rides, ski days, and everything else
 * COROS reports). Those adventures have their own chip and filter — real
 * training to see in your history, welcomed but never demanded.
 */

const EMPTY_COPY: Record<DisciplineFilter, { art: string; title: string; body: string }> = {
  all: {
    art: "🏃",
    title: "No activity yet",
    body: "Completed runs, lifts, yoga sessions, and adventures appear here. Use “Backfill history” in Settings to pull your COROS history.",
  },
  run: {
    art: "🏃",
    title: "No runs yet",
    body: "Completed runs from COROS appear here. Use “Backfill history” in Settings to pull your past sessions.",
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
  adventure: {
    art: "🥾",
    title: "No adventures yet",
    body: "Hikes, rides, ski days and every other outing from COROS land here — the garden rests easy while you roam.",
  },
};

/** Effort tier from COROS training load — garden-toned words, never a scold. */
function effortTier(load: number): { word: string; ticks: 1 | 2 | 3 } {
  // Same thresholds the garden engine uses (ADVENTURE_TUNING minLoad/bigLoad)
  // so a day never reads "gentle" here while qualifying as a real adventure.
  if (load < 40) return { word: "gentle", ticks: 1 };
  if (load < 80) return { word: "steady", ticks: 2 };
  return { word: "strong", ticks: 3 };
}

function EffortChip({ load, feel }: { load: number | null; feel: number | null }) {
  if (load == null && feel == null) return null;
  const tier = load != null ? effortTier(load) : null;
  return (
    <span className="act-effort" title={load != null ? `Training load ${Math.round(load)}` : undefined}>
      {tier ? (
        <>
          <span className="act-ticks" aria-hidden="true">
            {[1, 2, 3].map((t) => (
              <i key={t} className={t <= tier.ticks ? "on" : ""} />
            ))}
          </span>
          {tier.word} · {Math.round(load!)}
        </>
      ) : null}
      {feel != null ? <span className="act-feel">felt {feel}/5</span> : null}
    </span>
  );
}

/**
 * The run's shape: one thin bar per lap, width ∝ lap time, height ∝ speed
 * (faster laps stand taller), normalized within the activity itself — an
 * interval session reads as a comb, a long run as a low plateau. Single hue
 * per figure (the card's category color via currentColor); per-lap tooltips;
 * no axes — it is a silhouette, not a graph.
 */
function PaceShape({ laps }: { laps: Array<{ s: number; p: number | null }> }) {
  const paced = laps.filter((l) => l.p != null && l.p > 0);
  if (paced.length < 2) return null;
  const speeds = laps.map((l) => (l.p && l.p > 0 ? 1000 / l.p : null));
  const known = speeds.filter((v): v is number => v != null);
  const vMean = known.reduce((a, b) => a + b, 0) / known.length;
  const totalS = laps.reduce((acc, l) => acc + Math.max(1, l.s), 0);
  const W = 100;
  const H = 30;
  const GAP = laps.length > 24 ? 0.35 : 0.7;
  // Semi-absolute scale anchored to the activity's MEAN speed: a steady run
  // sits as a mid-height plateau (every lap ≈ the mean), an interval session
  // swings the full band — so amplitude means variance, comparably across
  // activities. ±25% of mean spans the band; beyond that clamps.
  const fracFor = (v: number | null): number => {
    if (v == null || vMean <= 0) return 0.18;
    const r = v / vMean;
    return Math.min(1, Math.max(0.18, 0.625 + (r - 1) * 1.5));
  };
  // Widths: proportional to lap time with a legibility floor, then rescaled
  // so the row always sums to exactly W — a floor without the rescale pushed
  // trailing laps past the right edge and silently clipped them.
  const rawW = laps.map((l) => Math.max(1.2, (Math.max(1, l.s) / totalS) * (W - GAP * (laps.length - 1))));
  const sumW = rawW.reduce((a, b) => a + b, 0);
  const scaleW = (W - GAP * (laps.length - 1)) / sumW;
  let x = 0;
  const bars = laps.map((l, i) => {
    const w = rawW[i]! * scaleW;
    const h = H * fracFor(speeds[i] ?? null);
    const mins = l.s < 60 ? `${Math.round(l.s)}s` : `${Math.round(l.s / 60)} min`;
    const bar = (
      <rect key={i} x={x} y={H - h} width={w} height={h} rx={0.8}>
        <title>
          {`Lap ${i + 1} · ${mins}${l.p ? ` · ${Math.floor(l.p / 60)}:${String(Math.round(l.p % 60)).padStart(2, "0")}/km` : ""}`}
        </title>
      </rect>
    );
    x += w + GAP;
    return bar;
  });
  const fmtPace = (p: number) => `${Math.floor(p / 60)}:${String(Math.round(p % 60)).padStart(2, "0")}/km`;
  const pMin = Math.min(...paced.map((l) => l.p!));
  const pMax = Math.max(...paced.map((l) => l.p!));
  return (
    <svg
      className="act-shape"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Pace shape, ${laps.length} laps, ${fmtPace(pMax)} to ${fmtPace(pMin)}`}
    >
      {bars}
    </svg>
  );
}

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
      void qc.invalidateQueries({ queryKey: ["garden"] });
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
  const [readOpen, setReadOpen] = useState<string | null>(null);

  const backfill = useMutation({
    mutationFn: () => api.backfillHistory(),
    onSuccess: (r) => {
      // The walk runs on the desktop bridge, chunk by chunk, so this only
      // reports that it was queued — Settings shows the progress.
      setNote(
        !r.enqueued
          ? r.reason === "already_running"
            ? "A history read is already queued or running — see Settings for progress."
            : "Couldn't start the backfill. Open the desktop app and try again."
          : r.reason === "rearmed"
            ? "Queued — waiting for your Mac to pick it up. Progress is in Settings."
            : "Queued — your Mac reads runs, lifts, yoga, and adventures. Progress is in Settings.",
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
    filter === "all" ? true : filter === "adventure" ? isAdventureSport(a.sport) : a.sport === filter,
  );
  const empty = EMPTY_COPY[filter];

  return (
    <div>
      <div className="row-between screen-title">
        <h1>Activity</h1>
        <button className="btn btn-small" disabled={backfill.isPending} onClick={() => backfill.mutate()}>
          {backfill.isPending ? "Starting…" : "Backfill history"}
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
        items.map((a) => {
          const catKey = a.matched?.category ?? (isAdventureSport(a.sport) ? "adventure" : a.sport);
          return (
            <div key={a.id}>
              <article className={`act-card act-hue-${catKey}`}>
                <div className="act-spine" aria-hidden="true" />
                <div className="act-main">
                  <div className="act-titlerow">
                    <span className="act-title">{a.title || sportLabel(a.sport)}</span>
                    <span className="act-sport faint">{sportLabel(a.sport)}</span>
                  </div>
                  <div className="act-meta faint">
                    <span>{formatDayLong(a.date)}</span>
                    <span>{formatMinutes(a.durationSeconds)}</span>
                    {a.distanceMeters ? <span>{dist(a.distanceMeters)}</span> : null}
                    {a.avgPaceSecPerKm ? <span>{pace(a.avgPaceSecPerKm)}</span> : null}
                  </div>
                  {a.laps || a.trainingLoad != null || a.feel != null ? (
                    <div className="act-glance">
                      {a.laps ? <PaceShape laps={a.laps} /> : null}
                      <EffortChip load={a.trainingLoad} feel={a.feel} />
                    </div>
                  ) : null}
                </div>
                {/* Fixed-geometry action column: the status slot renders EITHER
                    the linked pill OR the Link button in the same box, so a
                    state change can never reflow the card. */}
                <div className="act-actions">
                  <div className="act-status-slot">
                    {a.matched ? (
                      <span className="pill pill-ok" title={`Counted as your ${a.matched.title}`}>
                        ✓ {CATEGORY_LABELS[a.matched.category] ?? a.matched.category}
                      </span>
                    ) : (
                      <button className="btn btn-small" onClick={() => setLinking(a)}>
                        Link to a workout
                      </button>
                    )}
                  </div>
                  <button
                    className="btn btn-small"
                    aria-expanded={readOpen === a.id}
                    title="Ask the coach for a read of this effort"
                    onClick={() => setReadOpen(readOpen === a.id ? null : a.id)}
                  >
                    {readOpen === a.id ? "Hide read" : "✨ Coach's read"}
                  </button>
                </div>
              </article>
              {readOpen === a.id ? <CoachRead activityId={a.id} /> : null}
            </div>
          );
        })
      )}
      {linking ? <LinkSheet activity={linking} onClose={() => setLinking(null)} /> : null}
    </div>
  );
}
