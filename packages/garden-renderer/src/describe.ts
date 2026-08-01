import type {
  GardenPlant,
  GardenWeatherState,
  PlantCategory,
  PlantState,
  WildlifeKind,
} from "@rg/domain";
import { GARDEN_CONDITION_LABELS, WILDLIFE_KINDS } from "@rg/domain";
import type { GardenSnapshot } from "@rg/garden-engine";
import { conditionWord, DEFAULT_GARDEN_CONFIG, speciesOrThrow } from "@rg/garden-engine";

const CATEGORY_LABELS: Record<PlantCategory, [singular: string, plural: string]> = {
  tree: ["tree", "trees"],
  shrub: ["shrub", "shrubs"],
  flower: ["flower", "flowers"],
  fern: ["fern", "ferns"],
  grass: ["grass tuft", "grass tufts"],
  vine: ["vine", "vines"],
  groundcover: ["groundcover patch", "groundcover patches"],
  fungus: ["fungus", "fungi"],
};

const CATEGORY_ORDER: PlantCategory[] = [
  "tree",
  "shrub",
  "flower",
  "fern",
  "grass",
  "vine",
  "groundcover",
  "fungus",
];

const WEATHER_PHRASES: Record<GardenWeatherState, string> = {
  fresh_rain: "Fresh rain is falling.",
  recovery_rain: "Recovery rain is soaking the soil.",
  clear_sun: "The sun is out.",
  soft_sun: "Soft sunlight rests on the garden.",
  light_clouds: "Light clouds drift overhead.",
  dry_spell: "A dry spell lingers.",
  mild_drought: "The air is dry and hazy.",
  seasonal_breeze: "A seasonal breeze stirs the leaves.",
};

const STATE_LABELS: Record<PlantState, string> = {
  seed: "newly planted",
  growing: "growing",
  mature: "mature",
  flowering: "in bloom",
  thirsty: "thirsty",
  wilted: "wilted",
  dormant: "dormant",
  dead: "dead",
};

const WILDLIFE_LABELS: Record<WildlifeKind, string> = {
  birds: "birds",
  bees: "bees",
  butterflies: "butterflies",
  fireflies: "fireflies",
};

const HABITAT_LABELS = {
  nurse_log: "nurse log",
  perch: "perch for birds",
  mushroom_host: "home for mushrooms",
} as const;

/** Short state description used for per-plant aria labels. */
export function plantStateLabel(plant: GardenPlant): string {
  return STATE_LABELS[plant.state];
}

function joinWithAnd(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0]!;
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

/** 2-4 sentence textual scene for screen readers. */
export function describeGarden(snapshot: GardenSnapshot): string {
  const label = GARDEN_CONDITION_LABELS[conditionWord(snapshot.state, DEFAULT_GARDEN_CONFIG)];
  const living = snapshot.plants.filter((p) => p.state !== "dead");

  const counts = new Map<PlantCategory, number>();
  for (const p of living) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  const countParts = CATEGORY_ORDER.filter((c) => (counts.get(c) ?? 0) > 0).map((c) => {
    const n = counts.get(c)!;
    return `${n} ${CATEGORY_LABELS[c][n === 1 ? 0 : 1]}`;
  });
  const countsText = countParts.length > 0 ? joinWithAnd(countParts) : "no plants yet";

  const sentences: string[] = [
    `The garden is ${label.toLowerCase()}, with ${countsText}.`,
    WEATHER_PHRASES[snapshot.state.weatherState],
  ];

  const visitors = WILDLIFE_KINDS.filter((k) => snapshot.wildlife[k]).map(
    (k) => WILDLIFE_LABELS[k],
  );
  if (visitors.length > 0) {
    const list = joinWithAnd(visitors);
    sentences.push(`${list.charAt(0).toUpperCase()}${list.slice(1)} are visiting.`);
  }

  const notable: string[] = [];
  const tally = (state: PlantState) => snapshot.plants.filter((p) => p.state === state).length;
  const thirsty = tally("thirsty");
  const wilted = tally("wilted");
  const dormant = tally("dormant");
  const dead = tally("dead");
  if (thirsty > 0) notable.push(`${thirsty} ${thirsty === 1 ? "plant is" : "plants are"} thirsty`);
  if (wilted > 0) notable.push(`${wilted} ${wilted === 1 ? "is" : "are"} wilted`);
  if (dormant > 0) notable.push(`${dormant} ${dormant === 1 ? "lies" : "lie"} dormant`);
  if (dead > 0) notable.push(`${dead} ${dead === 1 ? "has" : "have"} died and now shelter new life`);
  if (notable.length > 0) {
    const text = joinWithAnd(notable);
    sentences.push(`${text.charAt(0).toUpperCase()}${text.slice(1)}.`);
  }

  return sentences.join(" ");
}

/** One-plant description: species name + state + planted date. */
export function describePlant(plant: GardenPlant): string {
  const species = speciesOrThrow(plant.speciesId);
  let text = `${species.name}, ${STATE_LABELS[plant.state]}. Planted ${plant.plantedAt}.`;
  if (plant.state === "dead" && plant.habitatRole) {
    text += ` Now a ${HABITAT_LABELS[plant.habitatRole]}.`;
  }
  return text;
}
