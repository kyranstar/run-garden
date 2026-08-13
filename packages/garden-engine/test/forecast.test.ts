import { describe, expect, it } from "vitest";
import type { GardenPlant } from "@rg/domain";
import { gardenForecast, initialSnapshot, type GardenSnapshot } from "../src/index.js";

function plant(id: string, over: Partial<GardenPlant>): GardenPlant {
  return {
    id,
    speciesId: "meadow_grass",
    category: "grass",
    plantedAt: "2026-03-02",
    health: 0.9,
    hydration: 0.8,
    maturity: 0.5,
    bloomProgress: 0,
    state: "growing",
    position: { x: 0.5, y: 0.5, region: 0 },
    ...over,
  } as GardenPlant;
}

function snap(over: {
  daysSinceCompletedRun?: number;
  restMode?: boolean;
  inComeback?: boolean;
  plants?: GardenPlant[];
}): GardenSnapshot {
  const s = initialSnapshot("2026-03-02");
  s.state.daysSinceCompletedRun = over.daysSinceCompletedRun ?? 0;
  s.state.restMode = over.restMode ?? false;
  s.state.inComeback = over.inComeback ?? false;
  if (over.plants) s.plants = over.plants;
  return s;
}

describe("gardenForecast", () => {
  it("counts down to the dry stage before day 4", () => {
    const f = gardenForecast(snap({ daysSinceCompletedRun: 1 }));
    expect(f.next).toEqual({ stage: "dry", inDays: 3 });
    expect(f.recovering).toBe(false);
  });

  it("counts down to drought between days 4 and 13", () => {
    expect(gardenForecast(snap({ daysSinceCompletedRun: 4 })).next).toEqual({
      stage: "drought",
      inDays: 10,
    });
  });

  it("counts down to dormancy inside drought, naming the deterministic victim", () => {
    const plants = [
      plant("b-dry", { hydration: 0.1 }),
      plant("a-dry", { hydration: 0.1 }), // same hydration → id tiebreak picks "a-dry"
      plant("tree", { category: "tree", hydration: 0.01, speciesId: "paper_birch" }),
      plant("dead", { state: "dead", hydration: 0 }),
    ];
    const f = gardenForecast(snap({ daysSinceCompletedRun: 14, plants }));
    expect(f.next).toEqual({ stage: "dormancy", inDays: 16 });
    expect(f.victim?.plantId).toBe("a-dry"); // never the tree, never the dead plant
  });

  it("never names an already-dormant plant — the sim's pick skips them (audit#2 #21)", () => {
    const plants = [
      plant("a-dormant", { state: "dormant", hydration: 0 }), // driest, but already dormant
      plant("b-live", { hydration: 0.3 }),
    ];
    const f = gardenForecast(snap({ daysSinceCompletedRun: 20, plants }));
    expect(f.victim?.plantId).toBe("b-live");
  });

  it("past dormancy there is no next stage but the victim is still known", () => {
    const f = gardenForecast(snap({ daysSinceCompletedRun: 35, plants: [plant("p1", {})] }));
    expect(f.next).toBeNull();
    expect(f.victim?.plantId).toBe("p1");
  });

  it("rest mode silences the forecast entirely", () => {
    const f = gardenForecast(snap({ daysSinceCompletedRun: 10, restMode: true }));
    expect(f.next).toBeNull();
    expect(f.victim).toBeNull();
  });

  it("daysAhead shifts the projected clock", () => {
    expect(gardenForecast(snap({ daysSinceCompletedRun: 1 }), 2).next).toEqual({
      stage: "dry",
      inDays: 1,
    });
  });

  it("reports recovery", () => {
    expect(gardenForecast(snap({ inComeback: true })).recovering).toBe(true);
  });
});
