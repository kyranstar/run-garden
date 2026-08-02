import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { addDays, GARDEN_CONDITION_LABELS } from "@rg/domain";
import type { GardenPlant, PlantState, WorkoutCategory } from "@rg/domain";
import {
  replay,
  simulateDay,
  SPECIES,
  speciesOrThrow,
  type GardenDayInput,
  type GardenSnapshot,
  type Species,
} from "@rg/garden-engine";
import { conditionWord, DEFAULT_GARDEN_CONFIG } from "@rg/garden-engine";
import { describeGarden, describePlant, GardenScene, PlantSprite } from "../src/index";

const START = "2026-03-02"; // a Monday

function emptyDay(date: string): GardenDayInput {
  return {
    date,
    completedRuns: [],
    restObserved: false,
    missedRuns: [],
    restModeActive: false,
    planGap: false,
  };
}

function runDay(
  date: string,
  category: WorkoutCategory,
  extra: Partial<GardenDayInput> = {},
): GardenDayInput {
  return {
    ...emptyDay(date),
    completedRuns: [{ workoutId: `w-${date}`, category }],
    ...extra,
  };
}

/** Simulate a standard training pattern for n weeks: Tue quality, Thu easy, Sat long, Sun recovery. */
function trainingWeeks(startMonday: string, weeks: number): GardenDayInput[] {
  const days: GardenDayInput[] = [];
  for (let w = 0; w < weeks; w++) {
    const mon = addDays(startMonday, w * 7);
    days.push({ ...emptyDay(mon), restObserved: true, weekAdherence: w > 0 ? 1 : undefined });
    days.push(runDay(addDays(mon, 1), "quality"));
    days.push({ ...emptyDay(addDays(mon, 2)), restObserved: true });
    days.push(runDay(addDays(mon, 3), "easy"));
    days.push({ ...emptyDay(addDays(mon, 4)), restObserved: true });
    days.push(runDay(addDays(mon, 5), "long"));
    days.push(runDay(addDays(mon, 6), "recovery"));
  }
  return days;
}

function advanceEmptyDays(snapshot: GardenSnapshot, from: string, count: number): GardenSnapshot {
  let s = snapshot;
  let date = from;
  for (let i = 0; i < count; i++) {
    s = simulateDay(s, emptyDay(date)).snapshot;
    date = addDays(date, 1);
  }
  return s;
}

/** 6 training weeks ending on a Sunday recovery run → fresh_rain, healthy garden. */
function healthySnapshot(): GardenSnapshot {
  return replay(START, trainingWeeks(START, 6)).snapshot;
}

function droughtSnapshot(): GardenSnapshot {
  const built = replay(START, trainingWeeks(START, 4));
  return advanceEmptyDays(built.snapshot, addDays(START, 28), 16);
}

function renderScene(snapshot: GardenSnapshot, extra: Partial<Parameters<typeof GardenScene>[0]> = {}) {
  return renderToStaticMarkup(<GardenScene snapshot={snapshot} {...extra} />);
}

function syntheticPlant(species: Species, state: PlantState): GardenPlant {
  return {
    id: `syn-${species.id}-${state}`,
    speciesId: species.id,
    category: species.category,
    plantedAt: START,
    health: state === "dead" ? 0 : 1,
    hydration: 0.9,
    maturity: state === "dead" ? 0.8 : 1,
    bloomProgress: state === "flowering" ? 1 : 0,
    state,
    position: { x: 0.5, y: 0.5, region: 0 },
    ...(state === "dead" ? { habitatRole: "nurse_log" as const } : {}),
  };
}

function groundFill(markup: string): string {
  const tag = markup.match(/<path[^>]*data-ground="true"[^>]*>/)?.[0];
  expect(tag).toBeTruthy();
  const fill = tag!.match(/fill="([^"]+)"/)?.[1];
  expect(fill).toBeTruthy();
  return fill!;
}

describe("GardenScene", () => {
  it("renders byte-identical SVG for the same snapshot (determinism)", () => {
    const snapshot = healthySnapshot();
    const a = renderScene(snapshot);
    const b = renderScene(snapshot);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(2000);
  });

  it("renders every living plant with a data-plant-id attribute", () => {
    const snapshot = healthySnapshot();
    const markup = renderScene(snapshot);
    const living = snapshot.plants.filter((p) => p.state !== "dead");
    expect(living.length).toBeGreaterThan(5);
    for (const plant of living) {
      expect(markup).toContain(`data-plant-id="${plant.id}"`);
    }
  });

  it("reducedMotion strips all <style> animation content", () => {
    const snapshot = healthySnapshot();
    const animated = renderScene(snapshot);
    expect(animated).toContain("@keyframes");
    expect(animated).toContain("<style>");

    const still = renderScene(snapshot, { reducedMotion: true });
    expect(still).not.toContain("@keyframes");
    expect(still).not.toContain("<style>");
    expect(still).not.toContain("animation");
  });

  it("drought ground color differs from healthy ground color", () => {
    const healthy = groundFill(renderScene(healthySnapshot()));
    const drought = groundFill(renderScene(droughtSnapshot()));
    expect(drought).not.toBe(healthy);
  });

  it("shows a rain overlay when weatherState is fresh_rain", () => {
    const snapshot = healthySnapshot();
    expect(snapshot.state.weatherState).toBe("fresh_rain");
    const markup = renderScene(snapshot);
    expect(markup).toContain('data-overlay="rain"');

    const dry = droughtSnapshot();
    expect(dry.state.weatherState).toBe("mild_drought");
    expect(renderScene(dry)).not.toContain('data-overlay="rain"');
  });

  it("gives every plant group a role and an aria label with species name and state", () => {
    const snapshot = healthySnapshot();
    const markup = renderScene(snapshot);
    expect(markup).toContain('role="button"');
    expect(markup).toContain('tabindex="0"');
    for (const plant of snapshot.plants.slice(0, 5)) {
      const species = speciesOrThrow(plant.speciesId);
      expect(markup).toContain(`aria-label="${species.name},`);
    }
  });

  it("highlights the selected plant with an ellipse under it", () => {
    const snapshot = healthySnapshot();
    const target = snapshot.plants[0]!;
    const without = renderScene(snapshot);
    const withSel = renderScene(snapshot, { selectedPlantId: target.id });
    expect(withSel).not.toBe(without);
    expect((withSel.match(/<ellipse/g) ?? []).length).toBeGreaterThan(
      (without.match(/<ellipse/g) ?? []).length,
    );
  });

  it("embeds the garden description as aria-label and <desc>", () => {
    const snapshot = healthySnapshot();
    const markup = renderScene(snapshot);
    expect(markup).toContain('role="img"');
    expect(markup).toContain("<desc>");
    const label = GARDEN_CONDITION_LABELS[conditionWord(snapshot.state, DEFAULT_GARDEN_CONFIG)];
    expect(markup.toLowerCase()).toContain(label.toLowerCase());
  });
});

describe("PlantSprite archetypes", () => {
  it("covers all 20 archetypes across the species catalog", () => {
    const archetypes = new Set(SPECIES.map((s) => s.archetype));
    expect(archetypes.size).toBe(20);
    expect(SPECIES.length).toBe(39); // 34 + 5 achievement species
  });

  it("renders every species in mature, flowering, and dead states without throwing", () => {
    const states: PlantState[] = ["mature", "flowering", "dead"];
    for (const species of SPECIES) {
      for (const state of states) {
        const plant = syntheticPlant(species, state);
        const markup = renderToStaticMarkup(
          <svg>
            <PlantSprite plant={plant} />
          </svg>,
        );
        expect(markup).toContain(`data-archetype="${species.archetype}"`);
        expect(markup.length).toBeGreaterThan(80);
      }
    }
  });

  it("renders the same plant id identically across calls", () => {
    const species = SPECIES.find((s) => s.archetype === "tree_birch")!;
    const plant = syntheticPlant(species, "mature");
    const a = renderToStaticMarkup(<svg><PlantSprite plant={plant} /></svg>);
    const b = renderToStaticMarkup(<svg><PlantSprite plant={plant} /></svg>);
    expect(a).toBe(b);
  });

  it("two plants of the same species differ slightly (per-id variation)", () => {
    const species = SPECIES.find((s) => s.archetype === "tree_round")!;
    const a = renderToStaticMarkup(
      <svg><PlantSprite plant={{ ...syntheticPlant(species, "mature"), id: "var-a" }} /></svg>,
    );
    const b = renderToStaticMarkup(
      <svg><PlantSprite plant={{ ...syntheticPlant(species, "mature"), id: "var-b" }} /></svg>,
    );
    expect(a).not.toBe(b);
  });
});

describe("sky layer", () => {
  it("renders stars and a moon at night, sun by day", () => {
    const snapshot = healthySnapshot();
    const night = renderScene(snapshot, { timeOfDay: 23.5 });
    expect(night).toContain('data-sky="stars"');
    expect(night).toContain('data-celestial="moon"');
    expect(night).not.toContain('data-celestial="sun"');
    const day = renderScene(snapshot, { timeOfDay: 13 });
    expect(day).toContain('data-celestial="sun"');
    expect(day).not.toContain('data-sky="stars"');
  });

  it("sky gradient has three stops driven by the color script", () => {
    const markup = renderScene(healthySnapshot(), { timeOfDay: 13 });
    const stops = markup.match(/<stop offset/g) ?? [];
    expect(stops.length).toBeGreaterThanOrEqual(3);
  });

  it("dawn and midday skies differ", () => {
    const snapshot = healthySnapshot();
    expect(renderScene(snapshot, { timeOfDay: 6.5 })).not.toBe(renderScene(snapshot, { timeOfDay: 13 }));
  });
});

describe("describeGarden / describePlant", () => {
  it("mentions the condition word and plant counts", () => {
    const snapshot = healthySnapshot();
    const text = describeGarden(snapshot);
    const label = GARDEN_CONDITION_LABELS[conditionWord(snapshot.state, DEFAULT_GARDEN_CONFIG)];
    expect(text.toLowerCase()).toContain(label.toLowerCase());
    expect(text).toMatch(/\d+ (tree|flower|shrub|fern|grass tuft|vine|groundcover patch|fungus)/);
    const sentences = text.split(". ").length;
    expect(sentences).toBeGreaterThanOrEqual(2);
    expect(sentences).toBeLessThanOrEqual(4);
  });

  it("mentions weather and notable states", () => {
    const dry = droughtSnapshot();
    const text = describeGarden(dry);
    expect(text).toContain("dry");
    expect(text.toLowerCase()).toMatch(/thirsty|wilted|dormant/);
  });

  it("describes a single plant with species name, state, and planted date", () => {
    const snapshot = healthySnapshot();
    const plant = snapshot.plants[0]!;
    const species = speciesOrThrow(plant.speciesId);
    const text = describePlant(plant);
    expect(text).toContain(species.name);
    expect(text).toContain(plant.plantedAt);
  });
});
