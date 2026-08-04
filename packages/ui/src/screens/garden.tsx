import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type DisciplineBalance, type WorkoutDto } from "@rg/api-client";
import {
  addDays,
  GARDEN_CONDITION_LABELS,
  type GardenConditionWord,
  type GardenEvent,
  type GardenWeatherState,
} from "@rg/domain";
import type { GardenSnapshot } from "@rg/garden-engine";
import { DAMAGE_NOTCH, gardenForecast, projectedBalance, SPECIES_BY_ID } from "@rg/garden-engine";
import { GardenScene } from "@rg/garden-renderer";
import { IconClock, IconClose } from "../icons.js";
import {
  Banner,
  Card,
  EmptyState,
  formatDayShort,
  Sheet,
  Spinner,
} from "../components.js";
import { BotanicalCard } from "./botanical.js";
import { EvidenceCard, NextWorkout, Readiness, SyncPanel, UnresolvedCard } from "./today.js";
import {
  NextUnlockNudges,
  SpeciesCodex,
  WildlifeShelf,
  type CodexEntry,
  type WildlifeEntry,
} from "./codex.js";

/** One point on the timeline scrubber — either a replayed past day (from
 * `api.gardenTimeline()`) or the live "today" view already loaded above. */
interface TimelinePoint {
  date: string;
  snapshot: GardenSnapshot;
  condition: GardenConditionWord;
}

function usePrefersReducedMotion(): boolean {
  return useMemo(
    () =>
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function eventSentence(e: GardenEvent): string | null {
  switch (e.kind) {
    case "run_completed": {
      const catg = e.workoutCategory ?? "";
      // Strength/yoga sessions ride the same run_completed event as runs (see
      // applyRun), so route them to discipline-true copy before falling
      // through to the generic run sentences below.
      if (catg === "strength") {
        return e.detail === "unplanned"
          ? "An extra strength session fed the soil."
          : "A strength session fed the soil.";
      }
      if (catg === "yoga") {
        return e.detail === "unplanned"
          ? "An extra yoga session tended the meadow."
          : "A yoga session tended the meadow.";
      }
      if (e.detail === "unplanned") return "An extra run gave the garden a light watering.";
      const article = /^[aeiou]/i.test(catg) ? "An" : "A";
      return catg ? `${article} ${catg} run watered the garden.` : "A run watered the garden.";
    }
    case "plant_added": {
      const name = e.speciesId ? (SPECIES_BY_ID.get(e.speciesId)?.name ?? "plant") : "plant";
      return e.detail === "tree_seed" ? `A ${name} seed was planted.` : `A ${name} took root.`;
    }
    case "species_unlocked": {
      const name = e.speciesId ? (SPECIES_BY_ID.get(e.speciesId)?.name ?? e.speciesId) : "";
      return `New species unlocked: ${name}.`;
    }
    case "wildlife_arrived":
      return `${cap(e.wildlifeId ?? "wildlife")} arrived in the garden.`;
    case "wildlife_departed":
      return `${cap(e.wildlifeId ?? "wildlife")} moved on for now.`;
    case "plant_died":
      return "A plant died back — it stays as habitat.";
    case "region_unlocked":
      return "The garden expanded into new ground.";
    case "rest_mode_started":
      return "Garden rest mode began.";
    case "rest_mode_ended":
      return "Garden rest mode ended.";
    case "missed_run":
      return "A missed run left the soil a little drier.";
    case "rest_observed":
      return "A rest day — soil health improved.";
    case "soil_tended":
      return "Strength work fed the soil.";
    case "life_tended":
      return "Yoga brought the meadow back to life.";
    default:
      return null;
  }
}

const WEATHER_LABEL: Record<GardenWeatherState, string> = {
  fresh_rain: "fresh rain",
  recovery_rain: "recovery rain",
  soft_sun: "soft sun",
  clear_sun: "clear sun",
  seasonal_breeze: "a seasonal breeze",
  light_clouds: "light clouds",
  dry_spell: "a dry spell",
  mild_drought: "drought",
};

const WEATHER_WHY: Record<GardenWeatherState, string> = {
  fresh_rain: "a planned run landed today, so rain is watering everything.",
  recovery_rain: "you're back after a dry stretch — recovery rain is restoring the soil.",
  soft_sun: "a rest day, so gentle sun while the soil recovers.",
  clear_sun: "warm and steady between runs.",
  seasonal_breeze: "calm and seasonal — all is well.",
  light_clouds: "a few days without a run — the air is starting to dry.",
  dry_spell: "a few days without a run — the air is starting to dry.",
  mild_drought: "about two weeks without a run, so the garden is in drought.",
};

const CATEGORY_ORDER: Array<{ key: string; label: string; color: string }> = [
  { key: "tree", label: "Trees", color: "#4e7a5a" },
  { key: "shrub", label: "Shrubs", color: "#6f9a58" },
  { key: "flower", label: "Flowers", color: "#c98bb0" },
  { key: "fern", label: "Ferns", color: "#5f8f6a" },
  { key: "vine", label: "Vines", color: "#7fa173" },
  { key: "grass", label: "Grasses", color: "#9fb26a" },
  { key: "groundcover", label: "Ground", color: "#8aa06a" },
  { key: "fungus", label: "Fungi", color: "#b0895f" },
];

/** Unobtrusive breakdown of plant-family diversity in the garden. */
function DiversityStrip({ snapshot }: { snapshot: GardenSnapshot }) {
  const counts = new Map<string, number>();
  let total = 0;
  for (const pl of snapshot.plants) {
    if (pl.state === "dead") continue;
    counts.set(pl.category, (counts.get(pl.category) ?? 0) + 1);
    total += 1;
  }
  if (total === 0) return null;
  const present = CATEGORY_ORDER.filter((c) => (counts.get(c.key) ?? 0) > 0);
  return (
    <div className="diversity">
      <div className="diversity-bar" role="img" aria-label={`${present.length} of 8 plant families`}>
        {present.map((c) => (
          <span
            key={c.key}
            className="diversity-seg"
            style={{ flexGrow: counts.get(c.key)!, background: c.color }}
            title={`${c.label}: ${counts.get(c.key)}`}
          />
        ))}
      </div>
      <div className="diversity-legend">
        <span className="faint">
          {present.length} of 8 plant families · {total} plants
        </span>
        {present.map((c) => (
          <span key={c.key} className="diversity-tag">
            <span className="dot" style={{ background: c.color }} /> {c.label} {counts.get(c.key)}
          </span>
        ))}
      </div>
    </div>
  );
}

type DisciplineKey = "run" | "strength" | "yoga";

const BALANCE_BARS: Array<{ key: DisciplineKey; label: string }> = [
  { key: "run", label: "Run" },
  { key: "strength", label: "Lift" },
  { key: "yoga", label: "Yoga" },
];

const WEAKEST_COPY: Record<DisciplineKey, string> = {
  run: "The garden misses your runs.",
  strength: "The garden misses your lifting.",
  yoga: "The garden misses your yoga.",
};

function healthDescriptor(health: number): string {
  if (health >= 2 / 3) return "healthy";
  if (health >= 1 / 3) return "fading";
  return "wilting";
}

function daysCaption(days: number | null): string {
  if (days === null) return "not yet";
  return days === 0 ? "today" : `${days} d ago`;
}

/** The lowest-health *practiced* discipline; ties broken run > strength > yoga. */
function weakestDiscipline(balance: DisciplineBalance): DisciplineKey {
  let weakest: DisciplineKey = "run";
  for (const { key } of BALANCE_BARS) {
    if (balance[key].days === null) continue;
    if (balance[key].health < balance[weakest].health) weakest = key;
  }
  return weakest;
}

/**
 * Three mini-bars for run/lift/yoga health. Each track carries a notch at the
 * point where neglect starts visibly damaging the garden; a fill that has
 * shrunk past its notch turns amber. `variant="hud"` renders the on-scene
 * treatment for the desktop stage.
 */
function BalanceStrip({
  balance,
  runPaused,
  quiet,
  variant,
}: {
  balance: DisciplineBalance;
  /** No active plan — the run clock is paused, say so instead of a count. */
  runPaused?: boolean;
  /** A forecast line is already speaking for the garden — stay visual only. */
  quiet?: boolean;
  variant?: "hud";
}) {
  return (
    <div className={`balance-strip${variant === "hud" ? " balance-strip-hud" : ""}`}>
      <div className="balance-bars">
        {BALANCE_BARS.map(({ key, label }) => {
          const { days, health } = balance[key];
          const notch = DAMAGE_NOTCH[key];
          const low = days !== null && health < notch;
          const caption = key === "run" && runPaused ? "plan paused" : daysCaption(days);
          return (
            <div
              key={key}
              className="balance-bar"
              role="img"
              aria-label={`${label}: ${healthDescriptor(health)}${low ? ", the garden is paying for it" : ""}, ${days === null ? `no ${label.toLowerCase()} yet` : `last ${label.toLowerCase()} ${daysCaption(days)}`}`}
            >
              <div className="balance-bar-label" aria-hidden="true">
                {label}
              </div>
              <div className="balance-bar-track" aria-hidden="true">
                <div
                  className={`balance-bar-fill balance-${key}${low ? " balance-low" : ""}`}
                  style={{ width: `${Math.round(health * 100)}%` }}
                />
                <span className="balance-notch" style={{ left: `${notch * 100}%` }} />
              </div>
              <div className="balance-bar-caption faint" aria-hidden="true">
                {caption}
              </div>
            </div>
          );
        })}
      </div>
      {!quiet && balance.overall < 0.5 ? (
        <p className="balance-copy muted">{WEAKEST_COPY[weakestDiscipline(balance)]}</p>
      ) : null}
    </div>
  );
}

/** Whole days from `a` to `b` (ISO dates, b ≥ a). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

const RUN_CATEGORIES = new Set(["easy", "long", "quality", "recovery", "race", "unknown"]);

/**
 * The garden's one-sentence forecast — the countdown, spoken as weather.
 * Exactly one loss-flavored line at a time; rest mode and plan gaps silence
 * it; a taper (no run due before the threshold) flips it to reassurance.
 */
function ForecastLine({
  snapshot,
  todayDate,
  daysAhead,
  nextWorkout,
  className,
}: {
  snapshot: GardenSnapshot;
  todayDate: string;
  daysAhead: number;
  nextWorkout: WorkoutDto | null | undefined;
  className?: string;
}) {
  const f = gardenForecast(snapshot, daysAhead);
  let line: ReactNode = null;
  if (f.recovering) {
    line = <>Recovery rain — the garden is drinking it in.</>;
  } else if (f.next) {
    const threshold = addDays(todayDate, f.next.inDays);
    // No plan at all: the run clock is paused, a countdown would over-alarm.
    if (!nextWorkout) return null;
    const runComing =
      RUN_CATEGORIES.has(nextWorkout.category) && nextWorkout.effectiveDate <= threshold;
    if (!runComing && nextWorkout.category === "rest") {
      line = <>Taper week — the garden holds its water.</>;
    } else if (f.next.stage === "dry") {
      line = (
        <>
          Rain needed by <strong>{formatDayShort(threshold).split(" ")[0]}</strong> — after that
          the soil starts to dry.
        </>
      );
    } else if (f.next.stage === "drought") {
      line = (
        <>
          <strong>{f.next.inDays === 1 ? "Drought tomorrow" : `Drought in ${f.next.inDays} days`}</strong>{" "}
          — your next run turns it around.
        </>
      );
    } else {
      const name = f.victim ? SPECIES_BY_ID.get(f.victim.speciesId)?.name : null;
      line = name ? (
        <>
          If the dry spell holds, the <strong>{name.toLowerCase()}</strong> goes dormant soon — one
          run brings it back.
        </>
      ) : (
        <>The dry spell is deepening — one run turns it around.</>
      );
    }
  } else if (f.victim) {
    line = <>Deep drought — your next run begins the recovery.</>;
  }
  if (!line) return null;
  return <p className={`forecast-line${className ? ` ${className}` : ""}`}>{line}</p>;
}

function conditionStory(
  condition: GardenConditionWord,
  snapshot: GardenSnapshot,
  plants: number,
  speciesCount: number,
): string {
  const days = snapshot.state.daysSinceCompletedRun;
  const base: Record<GardenConditionWord, string> = {
    flourishing: "Your running has been steady, so it's lush and flowering.",
    well_watered: "Recent runs are keeping the soil moist and growing.",
    growing: "It's coming along — keep running to fill it in.",
    a_little_dry: `It's been ${days} day${days === 1 ? "" : "s"} since a run, so it's drying out — a run brings the rain.`,
    in_drought: `${days} days without a run, so it's in drought. Your next run starts the recovery.`,
    recovering: "You're back — it's drinking in recovery rain.",
    dormant: "Rest mode is on, so it's peacefully dormant and won't decline.",
  };
  const counts = `${plants} plant${plants === 1 ? "" : "s"}${speciesCount ? `, ${speciesCount} species` : ""}.`;
  return `${base[condition] ?? ""} ${counts}`;
}

export function GardenScreen() {
  const garden = useQuery({ queryKey: ["garden"], queryFn: api.garden });
  const today = useQuery({ queryKey: ["today"], queryFn: api.today });
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  const [showWeather, setShowWeather] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [dayIndexOverride, setDayIndexOverride] = useState<number | null>(null);
  const reducedMotion = usePrefersReducedMotion();
  const hourOfDay = new Date().getHours() + new Date().getMinutes() / 60;

  // Fetched only once the scrubber is opened, then cached — scrubbing itself
  // is then all client-side (no per-frame requests).
  const timeline = useQuery({
    queryKey: ["garden-timeline"],
    queryFn: api.gardenTimeline,
    enabled: timelineOpen,
    staleTime: 5 * 60_000,
  });

  // App-open freshness: this is the actual "/" landing screen (Today's
  // content lives here — see the garden-lower section below), so this is
  // where a mount-time COROS read nudge belongs. Server-deduped, errors
  // ignored, safe on every mount.
  useEffect(() => {
    void api.readNow().catch(() => undefined);
  }, []);

  if (garden.isLoading) return <Spinner label="Loading the garden" />;
  if (!garden.data) return <EmptyState title="Couldn't load the garden" />;

  const snapshot = garden.data.snapshot as unknown as GardenSnapshot;
  const condition = garden.data.condition as GardenConditionWord;
  const events = (garden.data.events as GardenEvent[]) ?? [];
  const species = (garden.data.species as Array<Record<string, unknown>>) ?? [];
  const restMode = garden.data.restMode as { active: boolean; until: string | null };
  // Old cached payloads (pre-balance) may not carry this field — guard rather than crash.
  const balance = garden.data.balance as DisciplineBalance | undefined;

  // Timeline: every replayed past day, plus the live view already loaded
  // above standing in for "today" (its date is always later than the last
  // replayed day, since `buildGardenTimeline` never includes the in-progress
  // preview day — see the route).
  const pastDays: TimelinePoint[] = (timeline.data?.days ?? []).map((d) => ({
    date: d.date,
    snapshot: d.view.snapshot as unknown as GardenSnapshot,
    condition: d.view.condition,
  }));
  const liveDate = today.data?.today ?? snapshot.state.lastSimulatedDate;
  const timelinePoints: TimelinePoint[] = [...pastDays, { date: liveDate, snapshot, condition }];
  const maxDayIndex = Math.max(0, timelinePoints.length - 1);
  const dayIndex = Math.min(dayIndexOverride ?? maxDayIndex, maxDayIndex);
  const dayView = timelinePoints[dayIndex] ?? timelinePoints[timelinePoints.length - 1]!;
  const viewingLive = !timelineOpen || dayIndex === maxDayIndex;
  const timelineLoading = timelineOpen && timeline.isLoading;

  function closeTimeline() {
    setTimelineOpen(false);
    setDayIndexOverride(null);
  }

  // What's actually drawn: the live garden, or the scrubbed day. Disabling
  // the canvas atmosphere layer while the scrubber is open keeps dragging
  // instant — its particle systems re-key on every weather/light change
  // (see AtmosphereLayer), which would otherwise re-init on every step.
  const displaySnapshot = timelineOpen ? dayView.snapshot : snapshot;
  const displayCondition = timelineOpen ? dayView.condition : condition;

  const selectedPlant = displaySnapshot.plants.find((p) => p.id === selectedPlantId);
  const livingPlantsCount = displaySnapshot.plants.filter((p) => p.state !== "dead").length;
  const weather = displaySnapshot.state.weatherState;

  const historyItems = events
    .map((e) => ({ e, text: eventSentence(e) }))
    .filter((x): x is { e: GardenEvent; text: string } => !!x.text)
    .slice(0, 12);

  // Today's previewed happenings (rain, plantings) — the same-day feedback
  // line. Only meaningful while looking at the live garden, not a past day.
  const todayLines = viewingLive
    ? events
        .filter((e) => (e as { preview?: boolean }).preview)
        .map((e) => eventSentence(e))
        .filter((t): t is string => !!t)
        .slice(0, 2)
    : [];

  const codex = (garden.data.codex as CodexEntry[]) ?? [];
  const nudges = (garden.data.nextUnlocks as CodexEntry[]) ?? [];
  const wildlife = (garden.data.wildlife as WildlifeEntry[]) ?? [];
  const unlockedCount = codex.filter((c) => c.unlocked).length;

  const d = today.data;

  // The clocks are as-of the end of `lastSimulatedDate` (≤ yesterday). Project
  // wall-clock elapsed time on top so the bars keep shrinking between visits
  // and the day captions stop calling yesterday's run "today". Display-only.
  const todayDate = d?.today ?? liveDate;
  const daysSinceSimulated = Math.max(
    0,
    daysBetween(snapshot.state.lastSimulatedDate, todayDate) - 1 + hourOfDay / 24,
  );
  const planActive = !!d?.nextWorkout;
  const liveBalance = balance
    ? projectedBalance(snapshot.state, {
        daysSinceSimulated,
        freezeRun: !planActive,
        freezeAll: restMode.active,
      })
    : undefined;
  // One loss voice at a time: when the forecast line is speaking a decay
  // stage, the balance strip stays purely visual.
  const fc = gardenForecast(snapshot, daysSinceSimulated);
  const lossVoiced =
    viewingLive && !restMode.active && !fc.recovering && (fc.next !== null || fc.victim !== null);

  return (
    <div className="garden-home">
      <h1 className="visually-hidden">Garden</h1>

      {/* The garden itself — big and central. */}
      <div className="garden-scene-wrap garden-scene-big">
        <GardenScene
          snapshot={displaySnapshot}
          reducedMotion={reducedMotion}
          selectedPlantId={selectedPlantId}
          onSelectPlant={setSelectedPlantId}
          timeOfDay={hourOfDay}
          atmosphere={!timelineOpen}
        />
      </div>

      {/* Drag through the garden's history: one fetch, then the scrubber is
          all client-side re-renders of already-loaded days. */}
      <div className="timeline-bar">
        {timelineOpen ? (
          <div className="timeline-panel">
            <div className="timeline-panel-head">
              <span className="timeline-label">
                {timelineLoading
                  ? "Loading timeline…"
                  : `${formatDayShort(dayView.date)} — day ${dayIndex}${viewingLive ? " (today)" : ""}`}
              </span>
              <button
                type="button"
                className="btn btn-small"
                onClick={closeTimeline}
                aria-label="Close timeline"
              >
                <IconClose size={14} />
              </button>
            </div>
            {!timelineLoading ? (
              <input
                type="range"
                className="timeline-slider"
                min={0}
                max={maxDayIndex}
                step={1}
                value={dayIndex}
                disabled={maxDayIndex === 0}
                onChange={(e) => setDayIndexOverride(Number(e.target.value))}
                aria-label="Day in the garden's history"
              />
            ) : null}
          </div>
        ) : (
          <button type="button" className="btn btn-small" onClick={() => setTimelineOpen(true)}>
            <IconClock size={14} /> Timeline
          </button>
        )}
      </div>

      {liveBalance ? (
        <BalanceStrip balance={liveBalance} runPaused={!planActive} quiet={lossVoiced} />
      ) : null}

      {/* What the garden is telling you, and why it looks this way. */}
      <div className="garden-readout">
        <h2 className="garden-condition">{GARDEN_CONDITION_LABELS[displayCondition]}</h2>
        {viewingLive && !restMode.active ? (
          <ForecastLine
            snapshot={snapshot}
            todayDate={todayDate}
            daysAhead={daysSinceSimulated}
            nextWorkout={d?.nextWorkout}
          />
        ) : null}
        {todayLines.length > 0 ? (
          <p className="garden-nowline">
            <span className="now-chip">today</span>
            {todayLines.join(" ")}
          </p>
        ) : null}
        <p className="muted">
          {conditionStory(
            displayCondition,
            displaySnapshot,
            livingPlantsCount,
            viewingLive ? species.length : displaySnapshot.unlockedSpeciesIds.length,
          )}
        </p>
        <p className="faint">
          {viewingLive ? "Weather right now is" : "Weather that day was"}{" "}
          <strong>{WEATHER_LABEL[weather]}</strong> — {WEATHER_WHY[weather]}{" "}
          {viewingLive ? (
            <button type="button" className="linklike" onClick={() => setShowWeather((v) => !v)}>
              {showWeather ? "Hide" : "How the garden works"}
            </button>
          ) : null}
        </p>
        {showWeather ? (
          <Banner kind="info">
            Completing a planned run brings <strong>rain</strong>, which waters the garden and grows
            new plants; a rest day brings gentle <strong>sun</strong>. Go a few days without running
            and clouds gather, then a dry spell, then <strong>drought</strong> after about two weeks —
            your next run turns it back to recovery rain. Consistency unlocks new species; the same
            running history always grows the exact same garden. Tap any plant to see what it came
            from.
          </Banner>
        ) : null}
        {restMode.active ? (
          <Banner kind="info">Rest mode is on — nothing declines while you're away.</Banner>
        ) : null}
      </div>

      {/* The pull forward: what arrives next and exactly how to earn it. */}
      {nudges.length > 0 ? (
        <Card title="Growing next">
          <NextUnlockNudges nudges={nudges} />
        </Card>
      ) : null}

      {/* Today's actionable elements (formerly the Today page). */}
      {d?.nextWorkout ? (
        <NextWorkout w={d.nextWorkout} today={d.today} />
      ) : d ? (
        <EmptyState art="🌿" title="No active COROS training plan was found">
          Start a plan in COROS, then refresh from the desktop app.
        </EmptyState>
      ) : null}
      {d ? (
        d.sync.calendarConnected ? (
          <SyncPanel />
        ) : (
          <Banner kind="info">Your training plan is safe, but Calendar mirroring is paused.</Banner>
        )
      ) : null}
      {d?.sync.stravaStatus === "error" ? (
        <Banner kind="info">
          Strava access has stopped (its subscription may have lapsed). Completed runs still sync from
          COROS — just a little slower. <Link to="/settings">Reconnect Strava</Link> when you can.
        </Banner>
      ) : null}
      {d && d.needsAttention.length > 0 ? (
        <Banner kind="warn">
          {d.needsAttention.length === 1
            ? `“${d.needsAttention[0]!.title}” needs attention — COROS and Run Garden disagree.`
            : `${d.needsAttention.length} workouts need attention.`}{" "}
          <Link to="/plan">Review</Link>
        </Banner>
      ) : null}
      {d?.unresolved.map((w) => (
        <UnresolvedCard key={w.id} w={w} />
      ))}
      {d ? <Readiness readiness={d.readiness} /> : null}
      <EvidenceCard />

      {/* The event log — trace what happened, and your species. */}
      <div className="garden-lower">
        <Card title="Garden log">
          {historyItems.length === 0 ? (
            <p className="muted">Complete your first planned run to bring the rain.</p>
          ) : (
            <ul className="garden-history">
              {historyItems.map(({ e, text }) => (
                <li key={e.id}>
                  <span className="date">{formatDayShort(e.date)}</span>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Species collection · ${unlockedCount} of ${codex.length}`}>
          <DiversityStrip snapshot={snapshot} />
          <SpeciesCodex codex={codex} />
          <WildlifeShelf wildlife={wildlife} />
        </Card>
      </div>

      {selectedPlant ? (
        <Sheet
          open
          onClose={() => setSelectedPlantId(null)}
          title={SPECIES_BY_ID.get(selectedPlant.speciesId)?.name ?? "Plant"}
        >
          <BotanicalCard
            speciesId={selectedPlant.speciesId}
            plant={selectedPlant}
            entry={codex.find((c) => c.speciesId === selectedPlant.speciesId)}
          />
        </Sheet>
      ) : null}
    </div>
  );
}
