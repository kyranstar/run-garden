import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import { GARDEN_CONDITION_LABELS, type GardenConditionWord, type GardenEvent } from "@rg/domain";
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

function usePrefersReducedMotion(): boolean {
  return useMemo(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );
}

function eventSentence(e: GardenEvent): string | null {
  switch (e.kind) {
    case "run_completed":
      return e.detail === "unplanned"
        ? "An extra run gave the garden a light watering."
        : `A ${e.workoutCategory ?? ""} run watered the garden.`;
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
    default:
      return null;
  }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function RestModeControls({ active, until }: { active: boolean; until: string | null }) {
  const qc = useQueryClient();
  const [untilDate, setUntilDate] = useState<string>("");
  const toggle = useMutation({
    mutationFn: (next: boolean) => api.gardenRestMode(next, next ? untilDate || null : null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["garden"] }),
  });
  return (
    <Card title="Garden rest mode">
      {active ? (
        <div className="stack">
          <Banner kind="info">
            Garden rest mode is active. Your garden is peacefully dormant and will not decline.
            {until ? ` Ends ${formatDayLong(until)}.` : ""}
          </Banner>
          <button className="btn" disabled={toggle.isPending} onClick={() => toggle.mutate(false)}>
            End rest mode
          </button>
        </div>
      ) : (
        <div className="stack">
          <p className="muted">
            For injury, illness, travel, or a planned break: pause all garden decline. No reasons
            asked.
          </p>
          <div className="field">
            <label htmlFor="rest-until">Optional end date</label>
            <input
              id="rest-until"
              type="date"
              value={untilDate}
              onChange={(e) => setUntilDate(e.target.value)}
            />
          </div>
          <button className="btn" disabled={toggle.isPending} onClick={() => toggle.mutate(true)}>
            Start rest mode
          </button>
        </div>
      )}
    </Card>
  );
}

export function GardenScreen() {
  const garden = useQuery({ queryKey: ["garden"], queryFn: api.garden });
  const [selectedPlantId, setSelectedPlantId] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  if (garden.isLoading) return <Spinner label="Loading the garden" />;
  if (!garden.data) return <EmptyState title="Couldn't load the garden" />;

  const snapshot = garden.data.snapshot as unknown as GardenSnapshot;
  const condition = garden.data.condition as GardenConditionWord;
  const events = (garden.data.events as GardenEvent[]) ?? [];
  const species = (garden.data.species as Array<Record<string, unknown>>) ?? [];
  const restMode = garden.data.restMode as { active: boolean; until: string | null };
  const selectedPlant = snapshot.plants.find((p) => p.id === selectedPlantId);

  const historyItems = events
    .map((e) => ({ e, text: eventSentence(e) }))
    .filter((x): x is { e: GardenEvent; text: string } => !!x.text)
    .slice(0, 14);

  const recentText = historyItems[0]?.text ?? "The garden is waiting for its first run.";

  return (
    <div className="garden-layout">
      <div className="stack">
        <div className="row-between">
          <h1 className="garden-condition">{GARDEN_CONDITION_LABELS[condition]}</h1>
        </div>
        <div className="garden-scene-wrap">
          <GardenScene
            snapshot={snapshot}
            reducedMotion={reducedMotion}
            selectedPlantId={selectedPlantId}
            onSelectPlant={setSelectedPlantId}
          />
        </div>
        <p className="muted">{recentText}</p>
        {restMode.active ? (
          <Banner kind="info">Garden rest mode is active — nothing declines while you're away.</Banner>
        ) : null}
      </div>

      <div className="stack">
        <RestModeControls active={restMode.active} until={restMode.until} />
        <Card title="Recent garden history">
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
        <Card title={`Species collection (${species.length})`}>
          {species.length === 0 ? (
            <p className="muted">Species unlock as you train — hard runs bring flowers, long runs bring trees.</p>
          ) : (
            <div className="species-grid">
              {species.map((s) => (
                <div className="species-tile" key={s.speciesId as string}>
                  <div className="name">{s.name as string}</div>
                  <div className="faint">
                    {s.category as string}
                    {(s.livingCount as number) > 0 ? ` · ${s.livingCount as number} living` : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
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
                It has died back, but stays as {selectedPlant.habitatRole === "perch" ? "a perch for birds" : selectedPlant.habitatRole === "nurse_log" ? "a nurse log for new growth" : "habitat for mushrooms"}.
              </p>
            ) : null}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
