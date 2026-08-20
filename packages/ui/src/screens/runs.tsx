import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ActivityDto, type InsightsResponse, type WorkoutDto } from "@rg/api-client";
import { addDays, isAdventureSport, sportLabel } from "@rg/domain";
import type { Discipline } from "@rg/analytics";
import { useMeasuredWidth } from "../chart-kit.js";
import { IconCoachSmall } from "../icons.js";
import {
  Banner,
  CategoryDot,
  CATEGORY_LABELS,
  countNoun,
  EmptyState,
  formatDayLong,
  formatDistance,
  formatShortDate,
  formatMinutes,
  formatPace,
  localTodayGuess,
  settling,
  Sheet,
  Spinner,
  type Units,
} from "../components.js";
import { ConsistencyHeatmap, ChartFrame, WeeklyDurationChart } from "../charts.js";
import { formatHours, isRecentRecord } from "../charts-math.js";
import { firstSentence, SignalTile } from "../signal-tiles.js";
import { MetricDrilldown, RENDERED_METRIC_IDS, ReviewBody, SignalsPanel } from "./signals-panel.js";
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

/** CSS pixels — this figure's viewBox is built at its measured width, so its
 * units ARE pixels (System 4 F6; they used to be 1/100ths of a box rendered at
 * 187–230px, i.e. 1.2 units meant 2.2px on a phone and 2.8 on a desktop). A
 * bar narrower than this is a hairline nobody can see or tap, so every lap
 * gets at least this much — width that has to come out of the laps that
 * earned it, which is why the caption names them. */
const MIN_BAR_W = 2.2;

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
export function PaceShape({
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
  const boxRef = useRef<HTMLSpanElement>(null);
  const measured = useMeasuredWidth(boxRef);
  const paced = laps.filter((l) => l.p != null && l.p > 0);
  const speeds = laps.map((l) => (l.p && l.p > 0 ? 1000 / l.p : null));
  const known = speeds.filter((v): v is number => v != null);
  const vMean = known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 0;
  const totalS = laps.reduce((acc, l) => acc + Math.max(1, l.s), 0);
  // The figure builds its geometry at the width it actually occupies, so one
  // viewBox unit is one CSS pixel (System 3 §B, System 4 F6). It shipped with
  // a fixed `W = 100` inside a box CSS sizes at `min(230px, 55–60%)`, which
  // rendered it at scale 1.872 on a phone and 2.300 on a desktop — every
  // stroke width and every `rx` in here silently meaning something different
  // per width, and the responsive suite blind to it because its chart
  // assertions read source patterns in the two chart FILES and this figure
  // lives in a screen.
  //
  // `useMeasuredWidth` — the app's one measurement — but NOT `chartWidth`:
  // that helper floors at `CHART_MIN_WIDTH` (240px) to protect a 40-unit left
  // gutter and 10px axis labels, and this figure has neither, so the floor
  // sits ABOVE its 230px design cap and would pin every instance back to 230
  // and re-introduce the exact scale it is here to remove. A text-free
  // sparkline's honest cap is the box.
  const W = measured && measured > 0 ? Math.round(measured) : 230;
  const H = 30;
  if (paced.length < 2) return null;
  // Pixels now, like everything else in here: the old 0.35/0.7 viewBox units
  // rendered at 0.65/1.31px on a phone.
  const GAP = laps.length > 24 ? 0.7 : 1.3;
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
        rx={1.5}
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
      {/* The box the figure measures itself against. `useMeasuredWidth` reads
          `clientWidth`, which an inline box reports as 0, so this carries the
          `display: block` and the width rule and the SVG fills it. */}
      <span className="act-shape-box" ref={boxRef}>
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
      </span>
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

/** Monday of the ISO week containing `date`. */
function mondayOf(date: string): string {
  const dow = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -dow);
}

type InterpretedMetric = InsightsResponse["interpreted"][number];

/**
 * The flagged tiles — the SAME eligibility gates the old status strip used
 * (rendered id, confident, not stale), then band high|watch. These are the
 * dashboard's alarm; everything in range lives behind "All N signals".
 */
export function flaggedSignals(interpreted: readonly InterpretedMetric[]): InterpretedMetric[] {
  return interpreted.filter(
    (m) =>
      RENDERED_METRIC_IDS.has(m.id) &&
      m.status === "ok" &&
      !m.bandNote &&
      !m.staleNote &&
      (m.band === "high" || m.band === "watch"),
  );
}

/**
 * Where a run sits on the athlete's efficiency trend, in one plain clause —
 * this run's metres-per-beat against the median of the five scored runs
 * before it. Null when the run isn't scored or has nothing to compare to.
 */
export function efficiencyClause(
  efficiency: InsightsResponse["efficiency"],
  activityId: string,
): string | null {
  if (!efficiency || efficiency.status !== "ok") return null;
  const runs = efficiency.value.perRun;
  const i = runs.findIndex((r) => r.activityId === activityId);
  if (i < 0) return null;
  const prior = runs.slice(Math.max(0, i - 5), i).map((r) => r.efficiency);
  if (prior.length < 3) return null;
  const median = [...prior].sort((a, b) => a - b)[Math.floor(prior.length / 2)]!;
  if (median <= 0) return null;
  const r = runs[i]!.efficiency / median;
  if (r >= 1.02) return "Above your efficiency trend — easier speed than usual.";
  if (r <= 0.98) return "Below your efficiency trend — a harder-won pace than usual.";
  return "Right on your efficiency trend.";
}

/** The feed, grouped by ISO week, newest first. */
export function groupByWeek(items: ActivityDto[]): Array<{ monday: string; items: ActivityDto[] }> {
  const map = new Map<string, ActivityDto[]>();
  for (const a of items) {
    const wk = mondayOf(a.date);
    const list = map.get(wk);
    if (list) list.push(a);
    else map.set(wk, [a]);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([monday, list]) => ({
      monday,
      items: list.sort((a, b) => (a.date < b.date ? 1 : -1)),
    }));
}

/** An expanded session's insights, in place (System 2). */
function ActivityDetail({
  a,
  units,
  efficiency,
  onLink,
}: {
  a: ActivityDto;
  units: Units;
  efficiency: InsightsResponse["efficiency"];
  onLink: (a: ActivityDto) => void;
}) {
  // A CACHED read renders automatically — the peek never generates and never
  // spends. Generation stays the explicit, priced tap below (CoachRead).
  const peek = useQuery({
    queryKey: ["coach-read-peek", a.id],
    queryFn: () => api.coachReadPeek(a.id),
    staleTime: 5 * 60_000,
  });
  const [generating, setGenerating] = useState(false);
  const clause = efficiencyClause(efficiency, a.id);
  return (
    <div className="fw-detail">
      {a.laps ? <PaceShape laps={a.laps} units={units} durationSeconds={a.durationSeconds} /> : null}
      <p className="fw-statline">
        <EffortChip load={a.trainingLoad} feel={a.feel} />
        {a.matched ? (
          <span className="pill pill-ok" title={`Counted as your ${a.matched.title}`}>
            ✓ {a.matched.title}
          </span>
        ) : (
          <button type="button" className="btn btn-small" onClick={() => onLink(a)}>
            Link to a workout
          </button>
        )}
      </p>
      {clause ? <p className="fw-trend">{clause}</p> : null}
      {peek.data?.read && !generating ? (
        <div className="fw-coach">
          <span className="fw-coach-mark" aria-hidden="true">
            <IconCoachSmall size={16} />
          </span>
          <div>
            <p className="fw-coach-body">
              <span className="fw-coach-who">Coach</span> — {peek.data.read.glance}{" "}
              {peek.data.read.body}
            </p>
            <button type="button" className="linklike fw-fresh" onClick={() => setGenerating(true)}>
              ↻ Fresh read
            </button>
          </div>
        </div>
      ) : generating || peek.data?.read === null ? (
        generating ? (
          <CoachRead activityId={a.id} force={peek.data?.read != null} />
        ) : (
          <button type="button" className="btn btn-small" onClick={() => setGenerating(true)}>
            ✨ Get the coach&rsquo;s read
          </button>
        )
      ) : null}
      {a.matched ? (
        <p className="fw-open">
          <Link to={`/plan?workout=${a.matched.workoutId}`}>Open in Plan ›</Link>
        </p>
      ) : null}
    </div>
  );
}

export function RunsScreen() {
  const corosCheck = useCorosReadNow();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.activities(40) });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  const units: Units = settings.data?.prefs.units ?? "km";
  const [filter, setFilter] = useState<DisciplineFilter>("all");
  // The overview reads insights for the chip's discipline; All and Adventures
  // show running — the default discipline and the product's center.
  const insightsDiscipline: Discipline =
    filter === "strength" ? "strength" : filter === "yoga" ? "yoga" : "run";
  const insights = useQuery({
    queryKey: ["insights", insightsDiscipline],
    queryFn: () => api.insights(insightsDiscipline),
    staleTime: 60_000,
  });
  const [linking, setLinking] = useState<ActivityDto | null>(null);
  const [drill, setDrill] = useState<InterpretedMetric | null>(null);
  const [signalsOpen, setSignalsOpen] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openStory, setOpenStory] = useState<string | null>(null);
  const [weeksShown, setWeeksShown] = useState(3);

  // The weekly review's client-side seen mark (earned-moments spec §2) —
  // the dashboard is now where reviews live, so it writes the mark the old
  // Insights page wrote; home's ReviewPull goes quiet after a visit here.
  useEffect(() => {
    const latest = insights.data?.reviews?.[0];
    if (!latest) return;
    try {
      window.localStorage.setItem("rg-review-seen", latest.weekStart);
    } catch {
      // Storage unavailable — the pull will simply show again.
    }
  }, [insights.data]);

  // First-paint gate: the overview's blocks and the feed arrive together —
  // a page that paints its feed and then grows charts above it is the
  // layout-shift defect the gate exists to prevent.
  if (settling(runs, insights)) return <Spinner label="Loading activity" />;
  if (runs.isError || !runs.data) {
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

  const items = (runs.data.activities ?? []).filter((a) =>
    filter === "all" ? true : filter === "adventure" ? isAdventureSport(a.sport) : a.sport === filter,
  );
  const empty = EMPTY_COPY[filter];
  const data = insights.data ?? null;
  const flagged = data ? flaggedSignals(data.interpreted) : [];
  const signalCount = data
    ? data.interpreted.filter((m) => RENDERED_METRIC_IDS.has(m.id)).length
    : 0;
  const resolved = data
    ? data.consistency.completed + data.consistency.skipped + data.consistency.missed
    : 0;
  const adherencePct = data ? Math.round(data.consistency.adherenceRate * 100) : 0;
  const recentTraining = data ? data.weekly.weeks.slice(-8) : [];
  const records = data?.records ?? [];
  const todayMonday = mondayOf(localTodayGuess());
  const weeks = groupByWeek(items);

  return (
    <div className="stack">
      <div className="row-between screen-title">
        <h1>Activity</h1>
        <CorosCheck state={corosCheck.state} />
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

      {data ? (
        <>
          <section className="dash-sect" aria-label="Training">
            {recentTraining.length === 0 ? (
              <p className="muted">Completed sessions will appear here.</p>
            ) : (
              <ChartFrame
                title="Training time per week"
                legend={[
                  { label: "Easy time", colorVar: "--chart-1" },
                  { label: "Hard time", colorVar: "--chart-2" },
                ]}
                summary={recentTraining
                  .map((w) => `Week of ${w.weekStart}: ${formatHours(w.durationSeconds)}.`)
                  .join(" ")}
              >
                <WeeklyDurationChart
                  weeks={recentTraining}
                  avgSeconds={data.weekly.fourWeekAvgDuration}
                  avgLabel="4-wk avg"
                />
              </ChartFrame>
            )}
          </section>

          <section className="dash-sect" aria-label="Consistency">
            <h2 className="dash-eyebrow">Consistency</h2>
            {data.consistency.planned > 0 ? (
              <>
                {resolved > 0 ? (
                  <p className="dash-consline">
                    <b>{adherencePct}%</b> of planned workouts done.
                  </p>
                ) : (
                  <p className="muted">
                    Nothing has resolved yet — {countNoun(data.consistency.pending, "workout")}{" "}
                    still waiting on an answer.
                  </p>
                )}
                <ConsistencyHeatmap days={data.consistency.days} title="" />
              </>
            ) : (
              <p className="muted">Plan consistency appears once the plan has workouts in it.</p>
            )}
          </section>

          <section className="dash-sect" aria-label="Signals">
            <h2 className="dash-eyebrow">Signals</h2>
            {flagged.length > 0 ? (
              <div className="signal-grid">
                {flagged.map((m) => (
                  <SignalTile key={m.id} m={m} onDrill={setDrill} compact />
                ))}
              </div>
            ) : (
              <p className="dash-allclear">All {signalCount} signals in range.</p>
            )}
            <button
              type="button"
              className="linklike dash-more"
              aria-expanded={signalsOpen}
              onClick={() => setSignalsOpen((v) => !v)}
            >
              All {signalCount} signals
              <span className="disclosure-caret" aria-hidden>
                {signalsOpen ? "▾" : "▸"}
              </span>
            </button>
            {signalsOpen ? <SignalsPanel data={data} onDrill={setDrill} /> : null}
          </section>

          {records.length > 0 ? (
            <section className="dash-sect" aria-label="Records">
              <h2 className="dash-eyebrow">Records</h2>
              <ul className="dash-recs">
                {(recordsOpen ? records : records.slice(0, 3)).map((r) => (
                  <li key={r.id} className="dash-rec">
                    <b>{r.title}</b> — {r.value}
                    <span className="dash-rec-when">
                      {formatShortDate(r.achievedOn)}
                      {isRecentRecord(r.achievedOn, localTodayGuess()) ? (
                        <span className="new-ring">New</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {records.length > 3 ? (
                <button
                  type="button"
                  className="linklike dash-more"
                  aria-expanded={recordsOpen}
                  onClick={() => setRecordsOpen((v) => !v)}
                >
                  All {records.length} records
                  <span className="disclosure-caret" aria-hidden>
                    {recordsOpen ? "▾" : "▸"}
                  </span>
                </button>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}

      <h2 className="visually-hidden">Every session</h2>
      {items.length === 0 ? (
        <EmptyState art={empty.art} title={empty.title}>
          {empty.body}
        </EmptyState>
      ) : (
        <>
          {weeks.slice(0, weeksShown).map((wk) => {
            const total = wk.items.reduce((s2, a) => s2 + (a.durationSeconds ?? 0), 0);
            const review = data?.reviews.find((r) => r.weekStart === wk.monday) ?? null;
            const storyOpen = openStory === wk.monday;
            return (
              <section key={wk.monday} className="fw-week" aria-label={`Week of ${wk.monday}`}>
                <div className="fw-head">
                  <h3 className="fw-title">
                    {wk.monday === todayMonday ? "This week" : `Week of ${formatShortDate(wk.monday)}`}
                  </h3>
                  <span className="fw-stats">
                    {countNoun(wk.items.length, "session")} · {formatHours(total)}
                  </span>
                </div>
                {review?.narrative ? (
                  <p className="fw-story">
                    “{firstSentence(review.narrative)}”{" "}
                    <button
                      type="button"
                      className="linklike fw-story-more"
                      aria-expanded={storyOpen}
                      onClick={() => setOpenStory(storyOpen ? null : wk.monday)}
                    >
                      Full review
                      <span className="disclosure-caret" aria-hidden>
                        {storyOpen ? "▾" : "▸"}
                      </span>
                    </button>
                  </p>
                ) : null}
                {storyOpen && review ? <ReviewBody r={review} /> : null}
                {wk.items.map((a) => {
                  const catKey =
                    a.matched?.category ?? (isAdventureSport(a.sport) ? "adventure" : a.sport);
                  const open = openId === a.id;
                  const dow = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"][
                    new Date(`${a.date}T12:00:00Z`).getUTCDay()
                  ];
                  // Duration, distance, pace — never load: the expansion's
                  // effort line owns that number (one voice per fact).
                  const statBits = [
                    formatMinutes(a.durationSeconds),
                    a.distanceMeters ? formatDistance(a.distanceMeters, units) : null,
                    a.avgPaceSecPerKm ? formatPace(a.avgPaceSecPerKm, units) : null,
                  ].filter(Boolean);
                  return (
                    <article key={a.id} className={`fw-act act-hue-${catKey}${open ? " fw-act-open" : ""}`}>
                      <button
                        type="button"
                        className="fw-row"
                        aria-expanded={open}
                        onClick={() => setOpenId(open ? null : a.id)}
                      >
                        <span className="fw-when">
                          <b>{Number(a.date.slice(8, 10))}</b>
                          <small>{dow}</small>
                        </span>
                        <span className="fw-what">
                          <b>{a.title || sportLabel(a.sport)}</b>
                          <small>
                            {isAdventureSport(a.sport) ? `${sportLabel(a.sport)} · ` : ""}
                            {statBits.join(" · ")}
                            {a.elevationGainMeters != null && a.elevationGainMeters >= 20
                              ? ` · ↑ ${Math.round(a.elevationGainMeters)} m`
                              : ""}
                          </small>
                        </span>
                        <span className="fw-caret" aria-hidden="true">
                          ›
                        </span>
                      </button>
                      {open ? (
                        <ActivityDetail a={a} units={units} efficiency={data?.efficiency} onLink={setLinking} />
                      ) : null}
                    </article>
                  );
                })}
              </section>
            );
          })}
          {weeks.length > weeksShown ? (
            <p className="fw-earlier">
              <button type="button" className="linklike" onClick={() => setWeeksShown((n) => n + 3)}>
                Earlier weeks ›
              </button>
            </p>
          ) : null}
        </>
      )}

      {linking ? <LinkSheet activity={linking} onClose={() => setLinking(null)} /> : null}
      {drill ? <MetricDrilldown m={drill} onClose={() => setDrill(null)} /> : null}
    </div>
  );
}
