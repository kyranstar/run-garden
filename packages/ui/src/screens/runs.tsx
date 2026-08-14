import { useId, useMemo, useState } from "react";
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
  formatDistance,
  formatMinutes,
  formatPace,
  Sheet,
  Spinner,
  type Units,
} from "../components.js";
import { CoachRead } from "./coach-read.js";
import { useCorosReadNow } from "./use-coros-read.js";
import { CorosCheck } from "./coros-check.js";

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

/** Viewbox units. A bar narrower than this is a hairline nobody can see or
 * tap, so every lap gets at least this much — width that has to come out of
 * the laps that earned it, which is why the caption names them. */
const MIN_BAR_W = 1.2;

/** Below this the laps stop being "the activity's shape" and start being a
 * sample of it — the caption says so rather than letting the silhouette imply
 * whole-run coverage. */
const COVERAGE_FLOOR = 0.95;

/**
 * The run's shape: one thin bar per lap, width ∝ lap time, height ∝ speed
 * anchored to the activity's MEAN pace — a steady run reads as a mid-height
 * plateau, an interval session swings the band, and amplitude means variance
 * comparably across activities. Single hue per figure (the card's category
 * color via currentColor); no axes — a silhouette, not a graph.
 *
 * Lap detail without a mouse (audit 2026-08-14): native `<title>` tooltips
 * only ever appeared on hover, so on a phone — where most of this app is
 * read — the per-lap numbers did not exist. The figure is now one tab stop
 * (not one per lap: a 40-lap run would bury the rest of the page), ←/→ step
 * the laps, a tap picks one, and the caption line below carries the selected
 * lap. It doubles as the figure's `aria-describedby` target and a polite live
 * region, so the same words reach a screen reader. `<title>` stays for the
 * mouse.
 *
 * The caption is also where the figure admits its limits (same audit): laps
 * too brief to draw to scale are counted out loud, and when the laps don't
 * add up to the activity the caption says how much of it the shape covers.
 * A silhouette quietly standing in for half an hour it never drew is not the
 * activity's shape. Nothing is dropped — a 3-second lap is still a lap, and
 * on this data set an implausibly short one may be a duration that never got
 * repaired, which is exactly the kind of thing hiding it would bury.
 */
function PaceShape({
  laps,
  units,
  durationSeconds,
}: {
  laps: Array<{ s: number; p: number | null }>;
  units: Units;
  durationSeconds: number | null;
}) {
  const [sel, setSel] = useState<number | null>(null);
  const captionId = useId();
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
  const span = W - GAP * (laps.length - 1);
  const trueW = laps.map((l) => (Math.max(1, l.s) / totalS) * span);
  const rawW = trueW.map((w) => Math.max(MIN_BAR_W, w));
  const sumW = rawW.reduce((a, b) => a + b, 0);
  const scaleW = span / sumW;
  const stubs = trueW.filter((w) => w < MIN_BAR_W).length;
  const fmtPace = (p: number) => formatPace(p, units);
  const lapText = (i: number): string => {
    const l = laps[i]!;
    const mins = l.s < 60 ? `${Math.round(l.s)}s` : `${Math.round(l.s / 60)} min`;
    return `Lap ${i + 1} · ${mins}${l.p ? ` · ${fmtPace(l.p)}` : ""}`;
  };
  let x = 0;
  const bars = laps.map((l, i) => {
    const w = rawW[i]! * scaleW;
    const h = H * fracFor(speeds[i] ?? null);
    const bar = (
      <rect
        key={i}
        className={`act-shape-bar${trueW[i]! < MIN_BAR_W ? " is-stub" : ""}${sel === i ? " is-sel" : ""}`}
        x={x}
        y={H - h}
        width={w}
        height={h}
        rx={0.8}
        onClick={() => setSel(sel === i ? null : i)}
      >
        <title>{lapText(i)}</title>
      </rect>
    );
    x += w + GAP;
    return bar;
  });
  const pMin = Math.min(...paced.map((l) => l.p!));
  const pMax = Math.max(...paced.map((l) => l.p!));
  const lapSeconds = laps.reduce((acc, l) => acc + Math.max(0, l.s), 0);
  const shortfall =
    durationSeconds != null && durationSeconds > 0 && lapSeconds < durationSeconds * COVERAGE_FLOOR;
  // Caveats before the flourish: the caption is one line and ellipsises, so
  // what the figure DIDN'T draw must not be the part that gets clipped.
  const overview = [
    `${laps.length} laps`,
    shortfall ? `${formatMinutes(lapSeconds)} of ${formatMinutes(durationSeconds)} drawn` : null,
    stubs > 0 ? `${stubs} too brief to draw to scale` : null,
    `${fmtPace(pMax)}–${fmtPace(pMin)}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const caption = sel !== null ? lapText(sel) : overview;
  const step = (d: number) =>
    setSel((cur) => {
      const next = cur == null ? (d > 0 ? 0 : laps.length - 1) : cur + d;
      return Math.min(laps.length - 1, Math.max(0, next));
    });
  return (
    <>
      <svg
        className={`act-shape${sel !== null ? " has-selection" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        tabIndex={0}
        aria-label={`Pace shape, ${laps.length} laps, ${fmtPace(pMax)} to ${fmtPace(pMin)}. Left and right arrows step through the laps.`}
        aria-describedby={captionId}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
            e.preventDefault();
            step(e.key === "ArrowRight" ? 1 : -1);
          } else if (e.key === "Escape") {
            setSel(null);
          }
        }}
        onBlur={() => setSel(null)}
      >
        {bars}
      </svg>
      <p className="act-shape-note" id={captionId} aria-live="polite" title={caption}>
        {caption}
      </p>
    </>
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
  const corosCheck = useCorosReadNow();
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.activities(40) });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const units: Units = settings.data?.prefs.units ?? "km";
  const [linking, setLinking] = useState<ActivityDto | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [filter, setFilter] = useState<DisciplineFilter>("all");
  const [readOpen, setReadOpen] = useState<string | null>(null);

  const backfill = useMutation({
    mutationFn: () => api.backfillHistory(),
    onSuccess: (r) => {
      // The walk runs in the cloud, chunk by chunk, so this only reports
      // that it was queued — Settings shows the progress.
      setNote(
        !r.enqueued
          ? r.reason === "already_running"
            ? "A history read is already queued or running — see Settings for progress."
            : "Couldn't start the backfill — connect COROS in Settings and try again."
          : "Queued — runs, lifts, yoga, and adventures land chunk by chunk. Progress is in Settings.",
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
        <CorosCheck state={corosCheck.state} />
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
                    {a.distanceMeters ? <span>{formatDistance(a.distanceMeters, units)}</span> : null}
                    {a.avgPaceSecPerKm ? <span>{formatPace(a.avgPaceSecPerKm, units)}</span> : null}
                  </div>
                  {a.laps || a.trainingLoad != null || a.feel != null ? (
                    <div className="act-glance">
                      {a.laps ? (
                        <PaceShape laps={a.laps} units={units} durationSeconds={a.durationSeconds} />
                      ) : null}
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
