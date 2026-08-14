/**
 * The botanical card: one shared detail layout for "tap a plant in the scene"
 * and "tap a species in the collection". Portrait on the living-green ground,
 * family/rarity chips, then quiet fact rows — including true provenance: the
 * actual workout that planted this plant, fetched by id.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import type { GardenPlant } from "@rg/domain";
import { SPECIES_BY_ID } from "@rg/garden-engine";
import { describePlant } from "@rg/garden-renderer";
import { formatDayLong } from "../components.js";
import {
  ProgressBar,
  progressText,
  RARITY_LABEL,
  SpeciesSpriteCard,
  type CodexEntry,
} from "./codex.js";
import { useUnits } from "../use-units.js";

const FAMILY_LABEL: Record<string, string> = {
  tree: "Tree",
  shrub: "Shrub",
  flower: "Flower",
  fern: "Fern",
  vine: "Vine",
  grass: "Grass",
  groundcover: "Ground cover",
  fungus: "Fungus",
};

function HabitatNote({ plant }: { plant: GardenPlant }) {
  if (plant.state !== "dead") return null;
  const role =
    plant.habitatRole === "perch"
      ? "a perch for birds"
      : plant.habitatRole === "nurse_log"
        ? "a nurse log for new growth"
        : "habitat for mushrooms";
  return <li>It has died back, but stays as {role}.</li>;
}

export function BotanicalCard({
  speciesId,
  plant,
  entry,
  chainWeeks,
}: {
  speciesId: string;
  /** A live plant from the scene — shows its real state and provenance. */
  plant?: GardenPlant;
  /** The species' codex entry — shows collection facts and earn progress. */
  entry?: CodexEntry;
  /** Current consecutive-consistent-weeks chain — vines climb with it. */
  chainWeeks?: number;
}) {
  const units = useUnits();
  const sp = SPECIES_BY_ID.get(speciesId);
  const workoutId =
    plant?.sourceWorkoutId && !plant.sourceWorkoutId.startsWith("genesis")
      ? plant.sourceWorkoutId
      : null;
  // Provenance: the plant remembers which workout planted it. A purged or
  // unknown workout falls back to the date-only line — never an error state.
  const workout = useQuery({
    queryKey: ["workout", workoutId],
    queryFn: () => api.workout(workoutId!),
    enabled: !!workoutId,
    staleTime: Infinity,
    retry: false,
  });
  if (!sp) return null;
  const rarity = entry?.rarity ?? "common";
  const w = workout.data?.workout;

  return (
    <div className="bot-card">
      <div className={`bot-portrait${plant?.state === "dead" ? " bot-portrait-dead" : ""}`}>
        <SpeciesSpriteCard speciesId={speciesId} plant={plant} locked={entry ? !entry.unlocked : false} />
      </div>
      <div className="bot-body">
        <div className="bot-chips">
          <span className="pill pill-neutral">{FAMILY_LABEL[sp.category] ?? sp.category}</span>
          {rarity !== "common" ? (
            <span className={`rarity rarity-${rarity}`}>{RARITY_LABEL[rarity]}</span>
          ) : null}
        </div>
        {plant ? <p className="muted">{describePlant(plant)}</p> : null}
        <ul className="bot-facts">
          {plant ? (
            <li>
              {w
                ? `Planted by “${w.title}”`
                : "Planted"}{" "}
              · {formatDayLong(plant.plantedAt)}
            </li>
          ) : null}
          {plant?.hostPlantId ? (
            <li>It grows on a neighbour — part of the garden's little ecosystem.</li>
          ) : null}
          {sp.category === "vine" && chainWeeks !== undefined ? (
            <li>
              {chainWeeks > 0
                ? `Climbs with your consistency — ${chainWeeks} week${chainWeeks === 1 ? "" : "s"} and rising.`
                : "Its climb has drawn back — consistent weeks regrow it."}
            </li>
          ) : null}
          {plant ? <HabitatNote plant={plant} /> : null}
          {entry && !plant && entry.unlocked && entry.livingCount > 0 ? (
            <li>{entry.livingCount} living in the garden.</li>
          ) : null}
          {entry?.unlocked && entry.unlockedOn ? (
            <li>In your collection since {formatDayLong(entry.unlockedOn)}.</li>
          ) : null}
          {entry && !entry.unlocked ? (
            <li>
              <span className="bot-earn-label">How it's earned</span>
              {entry.hint}
              {entry.progress ? (
                <>
                  <ProgressBar current={entry.progress.current} target={entry.progress.target} />
                  <span className="codex-sub faint">{progressText(entry.progress, units)}</span>
                </>
              ) : null}
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}
