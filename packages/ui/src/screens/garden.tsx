import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import {
  GARDEN_CONDITION_LABELS,
  type GardenConditionWord,
  type GardenEvent,
  type GardenWeatherState,
} from "@rg/domain";
import type { GardenSnapshot } from "@rg/garden-engine";
import { SPECIES_BY_ID } from "@rg/garden-engine";
import { GardenScene, describePlant } from "@rg/garden-renderer";
import {
  Banner,
  Card,
  EmptyState,
  formatDayLong,
  formatDayShort,
  Sheet,
  Spinner,
} from "../components.js";
import { EvidenceCard, NextWorkout, Readiness, SyncStatusLine, UnresolvedCard } from "./today.js";
import {
  NextUnlockNudges,
  SpeciesCodex,
  WildlifeShelf,
  type CodexEntry,
  type WildlifeEntry,
} from "./codex.js";

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
      if (e.detail === "unplanned") return "An extra run gave the garden a light watering.";
      const catg = e.workoutCategory ?? "";
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
  light_clouds: "a day or two without a run, so clouds are gathering.",
  dry_spell: "a few days without a run, so the air is drying out.",
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
  const reducedMotion = usePrefersReducedMotion();
  const hourOfDay = new Date().getHours() + new Date().getMinutes() / 60;

  if (garden.isLoading) return <Spinner label="Loading the garden" />;
  if (!garden.data) return <EmptyState title="Couldn't load the garden" />;

  const snapshot = garden.data.snapshot as unknown as GardenSnapshot;
  const condition = garden.data.condition as GardenConditionWord;
  const events = (garden.data.events as GardenEvent[]) ?? [];
  const species = (garden.data.species as Array<Record<string, unknown>>) ?? [];
  const restMode = garden.data.restMode as { active: boolean; until: string | null };
  const selectedPlant = snapshot.plants.find((p) => p.id === selectedPlantId);
  const livingPlants = snapshot.plants.filter((p) => p.state !== "dead").length;
  const weather = snapshot.state.weatherState;

  const historyItems = events
    .map((e) => ({ e, text: eventSentence(e) }))
    .filter((x): x is { e: GardenEvent; text: string } => !!x.text)
    .slice(0, 12);

  // Today's previewed happenings (rain, plantings) — the same-day feedback line.
  const todayLines = events
    .filter((e) => (e as { preview?: boolean }).preview)
    .map((e) => eventSentence(e))
    .filter((t): t is string => !!t)
    .slice(0, 2);

  const codex = (garden.data.codex as CodexEntry[]) ?? [];
  const nudges = (garden.data.nextUnlocks as CodexEntry[]) ?? [];
  const wildlife = (garden.data.wildlife as WildlifeEntry[]) ?? [];
  const unlockedCount = codex.filter((c) => c.unlocked).length;

  const d = today.data;

  return (
    <div className="garden-home">
      <h1 className="visually-hidden">Garden</h1>

      {/* The garden itself — big and central. */}
      <div className="garden-scene-wrap garden-scene-big">
        <GardenScene
          snapshot={snapshot}
          reducedMotion={reducedMotion}
          selectedPlantId={selectedPlantId}
          onSelectPlant={setSelectedPlantId}
          timeOfDay={hourOfDay}
          atmosphere
        />
      </div>

      {/* What the garden is telling you, and why it looks this way. */}
      <div className="garden-readout">
        <h2 className="garden-condition">{GARDEN_CONDITION_LABELS[condition]}</h2>
        {todayLines.length > 0 ? (
          <p className="garden-nowline">
            <span className="now-chip">today</span>
            {todayLines.join(" ")}
          </p>
        ) : null}
        <p className="muted">{conditionStory(condition, snapshot, livingPlants, species.length)}</p>
        <p className="faint">
          Weather right now is <strong>{WEATHER_LABEL[weather]}</strong> — {WEATHER_WHY[weather]}{" "}
          <button type="button" className="linklike" onClick={() => setShowWeather((v) => !v)}>
            {showWeather ? "Hide" : "How the garden works"}
          </button>
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
        <div aria-live="polite">
          <SyncStatusLine sync={d.sync} />
        </div>
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
          <div className="stack">
            <p>{describePlant(selectedPlant)}</p>
            <p className="muted">Planted {formatDayLong(selectedPlant.plantedAt)}.</p>
            {selectedPlant.sourceWorkoutId && !selectedPlant.sourceWorkoutId.startsWith("genesis") ? (
              <p className="muted">This plant was planted by one of your workouts.</p>
            ) : null}
            {selectedPlant.hostPlantId ? (
              <p className="muted">It grows on a neighbour — part of the garden's little ecosystem.</p>
            ) : null}
            {selectedPlant.state === "dead" ? (
              <p className="muted">
                It has died back, but stays as{" "}
                {selectedPlant.habitatRole === "perch"
                  ? "a perch for birds"
                  : selectedPlant.habitatRole === "nurse_log"
                    ? "a nurse log for new growth"
                    : "habitat for mushrooms"}
                .
              </p>
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
