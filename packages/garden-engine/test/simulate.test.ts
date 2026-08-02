import { describe, expect, it } from "vitest";
import { addDays } from "@rg/domain";
import type { WorkoutCategory } from "@rg/domain";
import {
  DEFAULT_GARDEN_CONFIG,
  initialSnapshot,
  replay,
  simulateDay,
  type GardenDayInput,
  type GardenSnapshot,
} from "../src/index.js";

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

function advanceEmptyDays(snapshot: GardenSnapshot, from: string, count: number) {
  let s = snapshot;
  let date = from;
  const allEvents = [];
  for (let i = 0; i < count; i++) {
    const r = simulateDay(s, emptyDay(date));
    s = r.snapshot;
    allEvents.push(...r.events);
    date = addDays(date, 1);
  }
  return { snapshot: s, events: allEvents, nextDate: date };
}

describe("garden basics", () => {
  it("starts with a small living meadow", () => {
    const g = initialSnapshot(START);
    expect(g.plants.length).toBeGreaterThanOrEqual(4);
    expect(g.plants.every((p) => p.state !== "dead")).toBe(true);
  });

  it("a completed run waters every living plant and raises moisture", () => {
    const g = initialSnapshot(START);
    const before = g.state.moisture;
    const { snapshot, events } = simulateDay(g, runDay(START, "easy"));
    expect(snapshot.state.moisture).toBeGreaterThan(before);
    for (const p of snapshot.plants) expect(p.hydration).toBeGreaterThan(0.7);
    expect(events.some((e) => e.kind === "run_completed")).toBe(true);
    expect(snapshot.state.weatherState).toBe("fresh_rain");
  });

  it("is idempotent per date and deterministic on replay", () => {
    const days = trainingWeeks(START, 4);
    const a = replay(START, days);
    const b = replay(START, days);
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
    expect(a.events.map((e) => e.id)).toEqual(b.events.map((e) => e.id));

    // Re-applying an already-simulated date is a no-op.
    const again = simulateDay(a.snapshot, runDay(days[days.length - 1]!.date, "easy"));
    expect(again.events).toHaveLength(0);
    expect(again.snapshot).toBe(a.snapshot);
  });

  it("quality runs add a new plant; unplanned runs never do", () => {
    const g = initialSnapshot(START);
    const q = simulateDay(g, runDay(START, "quality"));
    expect(q.events.some((e) => e.kind === "plant_added")).toBe(true);

    const g2 = initialSnapshot(START);
    const unplanned = simulateDay(g2, {
      ...emptyDay(START),
      completedRuns: [{ workoutId: "x", category: "quality", unplanned: true }],
    });
    expect(unplanned.events.some((e) => e.kind === "plant_added")).toBe(false);
    expect(unplanned.snapshot.plants.length).toBe(g2.plants.length);
  });

  it("the first long run plants the first tree", () => {
    const g = initialSnapshot(START);
    const { snapshot, events } = simulateDay(g, runDay(START, "long"));
    const treeEvent = events.find((e) => e.kind === "plant_added" && e.detail === "tree_seed");
    expect(treeEvent).toBeDefined();
    expect(snapshot.plants.some((p) => p.category === "tree")).toBe(true);
  });

  it("observed rest days improve soil and never dry the garden", () => {
    const g = initialSnapshot(START);
    const { snapshot } = simulateDay(g, { ...emptyDay(START), restObserved: true });
    expect(snapshot.state.moisture).toBe(g.state.moisture);
    expect(snapshot.state.soilHealth).toBeGreaterThan(g.state.soilHealth);
    expect(snapshot.state.daysSinceCompletedRun).toBe(0);
  });

  it("plan gaps cause no decay", () => {
    const g = initialSnapshot(START);
    let s = g;
    for (let i = 0; i < 30; i++) {
      s = simulateDay(s, { ...emptyDay(addDays(START, i)), planGap: true }).snapshot;
    }
    expect(s.state.daysSinceCompletedRun).toBe(0);
    expect(s.state.moisture).toBe(g.state.moisture);
  });
});

describe("dryness and drought progression", () => {
  it("one or two missed days are mild and fully reversible by one run", () => {
    const built = replay(START, trainingWeeks(START, 2));
    let s = built.snapshot;
    const lastDate = "2026-03-16";
    const a = advanceEmptyDays(s, lastDate, 2);
    expect(a.snapshot.state.daysSinceCompletedRun).toBe(2);
    expect(a.snapshot.plants.every((p) => p.state !== "dead")).toBe(true);

    const back = simulateDay(a.snapshot, runDay(a.nextDate, "easy"));
    expect(back.snapshot.state.daysSinceCompletedRun).toBe(0);
    expect(back.snapshot.state.moisture).toBeGreaterThan(0.6);
  });

  it("two weeks off → mild drought with wilting but no deaths", () => {
    const built = replay(START, trainingWeeks(START, 4));
    const a = advanceEmptyDays(built.snapshot, "2026-03-30", 16);
    expect(a.snapshot.state.weatherState).toBe("mild_drought");
    expect(a.snapshot.plants.every((p) => p.state !== "dead")).toBe(true);
    expect(a.events.filter((e) => e.kind === "plant_died")).toHaveLength(0);
  });

  it("a month off → dormancy and wildlife departure, still no deaths", () => {
    const days = trainingWeeks(START, 8);
    const built = replay(START, days);
    const afterDate = addDays(START, 8 * 7);
    const a = advanceEmptyDays(built.snapshot, afterDate, 35);
    expect(a.snapshot.plants.some((p) => p.state === "dormant")).toBe(true);
    expect(a.events.filter((e) => e.kind === "plant_died")).toHaveLength(0);
  });

  it("deaths start only after ~60 days, at most one per interval, trees last", () => {
    const built = replay(START, trainingWeeks(START, 8));
    const afterDate = addDays(START, 8 * 7);

    const at59 = advanceEmptyDays(built.snapshot, afterDate, 59);
    expect(at59.events.filter((e) => e.kind === "plant_died")).toHaveLength(0);

    const at90 = advanceEmptyDays(built.snapshot, afterDate, 90);
    const deaths = at90.events.filter((e) => e.kind === "plant_died");
    expect(deaths.length).toBeGreaterThan(0);
    // Bounded rate: (90-60) days at 1 per 4-day interval ⇒ ≤ 9, and garden survives.
    expect(deaths.length).toBeLessThanOrEqual(
      Math.ceil(31 / DEFAULT_GARDEN_CONFIG.deathIntervalDays) + 1,
    );
    const living = at90.snapshot.plants.filter((p) => p.state !== "dead");
    expect(living.length).toBeGreaterThan(0);
    // No tree dies before treeDeathStartDays.
    const deadTrees = at90.snapshot.plants.filter(
      (p) => p.category === "tree" && p.state === "dead",
    );
    expect(deadTrees).toHaveLength(0);
  });

  it("full extinction is impossible before several months", () => {
    const built = replay(START, trainingWeeks(START, 8));
    const afterDate = addDays(START, 8 * 7);
    const at120 = advanceEmptyDays(built.snapshot, afterDate, 120);
    const living = at120.snapshot.plants.filter((p) => p.state !== "dead");
    expect(living.length).toBeGreaterThan(0);
  });

  it("dead plants remain in the scene as habitat", () => {
    const built = replay(START, trainingWeeks(START, 8));
    const a = advanceEmptyDays(built.snapshot, addDays(START, 56), 80);
    const dead = a.snapshot.plants.filter((p) => p.state === "dead");
    expect(dead.length).toBeGreaterThan(0);
    for (const p of dead) expect(p.habitatRole).toBeTruthy();
  });
});

describe("comeback", () => {
  it("the first run after a drought brings recovery rain and stops decline", () => {
    const built = replay(START, trainingWeeks(START, 4));
    const a = advanceEmptyDays(built.snapshot, addDays(START, 28), 20);
    const comeback = simulateDay(a.snapshot, runDay(a.nextDate, "easy"));
    expect(comeback.snapshot.state.weatherState).toBe("recovery_rain");
    expect(comeback.snapshot.state.daysSinceCompletedRun).toBe(0);
    expect(comeback.snapshot.state.moisture).toBeGreaterThan(a.snapshot.state.moisture + 0.3);
    expect(comeback.snapshot.state.inComeback).toBe(true);
  });

  it("several comeback runs reopen flowers and bring wildlife back", () => {
    // Build a mature garden with flowers and trees.
    const built = replay(START, trainingWeeks(START, 10));
    const droughted = advanceEmptyDays(built.snapshot, addDays(START, 70), 20);
    let s = droughted.snapshot;
    let date = droughted.nextDate;
    for (let i = 0; i < 5; i++) {
      s = simulateDay(s, runDay(date, i % 2 === 0 ? "easy" : "quality")).snapshot;
      date = addDays(date, 1);
    }
    expect(s.plants.some((p) => p.state === "flowering")).toBe(true);
  });

  it("mushrooms can appear on dead wood after recovery runs", () => {
    const built = replay(START, trainingWeeks(START, 8));
    // Long enough for deaths (dead wood), then recover.
    const droughted = advanceEmptyDays(built.snapshot, addDays(START, 56), 80);
    let s = droughted.snapshot;
    let date = droughted.nextDate;
    const events = [];
    for (let i = 0; i < 6; i++) {
      const r = simulateDay(s, runDay(date, "recovery"));
      s = r.snapshot;
      events.push(...r.events);
      date = addDays(date, 1);
    }
    const fungi = s.plants.filter((p) => p.category === "fungus");
    expect(fungi.length).toBeGreaterThan(0);
  });
});

describe("rest mode", () => {
  it("pauses all degradation and penalties", () => {
    const built = replay(START, trainingWeeks(START, 4));
    let s = built.snapshot;
    let date = addDays(START, 28);
    const moistureBefore = s.state.moisture;
    for (let i = 0; i < 45; i++) {
      s = simulateDay(s, { ...emptyDay(date), restModeActive: true }).snapshot;
      date = addDays(date, 1);
    }
    expect(s.state.moisture).toBe(moistureBefore);
    expect(s.state.daysSinceCompletedRun).toBe(built.snapshot.state.daysSinceCompletedRun);
    expect(s.plants.filter((p) => p.state === "dead")).toHaveLength(0);
    // Missed runs during rest mode do not create dryness debt.
    const withMissed = simulateDay(s, {
      ...emptyDay(date),
      restModeActive: true,
      missedRuns: [{ workoutId: "m1" }],
    });
    expect(withMissed.snapshot.state.moisture).toBe(moistureBefore);
  });
});

describe("unlocks and ecosystem dependencies", () => {
  it("unlocks species progressively and emits events once", () => {
    const { events } = replay(START, trainingWeeks(START, 12));
    const unlocks = events.filter((e) => e.kind === "species_unlocked");
    const ids = unlocks.map((e) => e.speciesId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toContain("poppy"); // first quality run
    expect(ids).toContain("birch"); // first long run
    expect(ids).toContain("ivy"); // 4 consistent weeks
  });

  it("vines only appear once a mature tree exists, and attach to it", () => {
    const { snapshot } = replay(START, trainingWeeks(START, 14));
    const vines = snapshot.plants.filter((p) => p.category === "vine");
    for (const v of vines) {
      expect(v.hostPlantId).toBeTruthy();
      const host = snapshot.plants.find((p) => p.id === v.hostPlantId);
      expect(host?.category).toBe("tree");
    }
  });

  it("wildlife arrives with canopy, flowers, and biodiversity", () => {
    const { snapshot, events } = replay(START, trainingWeeks(START, 16));
    const arrived = events.filter((e) => e.kind === "wildlife_arrived").map((e) => e.wildlifeId);
    expect(arrived).toContain("bees");
    expect(snapshot.state.biodiversity).toBeGreaterThan(0.3);
  });

  it("keeps positions stable across replays (deterministic layout)", () => {
    const a = replay(START, trainingWeeks(START, 10));
    const b = replay(START, trainingWeeks(START, 10));
    const posA = a.snapshot.plants.map((p) => `${p.id}:${p.position.x.toFixed(6)},${p.position.y.toFixed(6)}`);
    const posB = b.snapshot.plants.map((p) => `${p.id}:${p.position.x.toFixed(6)},${p.position.y.toFixed(6)}`);
    expect(posA).toEqual(posB);
  });

  it("expands into new regions as the garden grows instead of overcrowding", () => {
    const { snapshot } = replay(START, trainingWeeks(START, 20));
    expect(snapshot.state.unlockedRegions).toBeGreaterThan(1);
  });

  it("garden accumulates substantial diversity over a long consistent period", () => {
    const { snapshot } = replay(START, trainingWeeks(START, 20));
    const species = new Set(snapshot.plants.map((p) => p.speciesId));
    expect(species.size).toBeGreaterThanOrEqual(10);
    expect(snapshot.plants.length).toBeGreaterThanOrEqual(25);
  });
});

describe("missed-run debt", () => {
  it("explicit skips create dryness debt but one run largely reverses it", () => {
    const built = replay(START, trainingWeeks(START, 2));
    const skipped = simulateDay(built.snapshot, {
      ...emptyDay(addDays(START, 14)),
      missedRuns: [{ workoutId: "skip-1" }],
    });
    expect(skipped.snapshot.state.moisture).toBeLessThan(built.snapshot.state.moisture);
    const recovered = simulateDay(skipped.snapshot, runDay(addDays(START, 15), "easy"));
    expect(recovered.snapshot.state.moisture).toBeGreaterThanOrEqual(
      built.snapshot.state.moisture - 0.05,
    );
  });
});

describe("achievement species", () => {
  it("awards the milestone oak for a single 10K (even unplanned)", () => {
    let { snapshot } = replay(START, trainingWeeks(START, 1));
    expect(snapshot.unlockedSpeciesIds).not.toContain("milestone_oak");
    const day = addDays(START, 7);
    ({ snapshot } = simulateDay(snapshot, {
      ...emptyDay(day),
      completedRuns: [
        { workoutId: `u-${day}`, category: "easy", unplanned: true, distanceMeters: 10_400 },
      ],
    }));
    expect(snapshot.state.longestRunMeters).toBe(10_400);
    expect(snapshot.unlockedSpeciesIds).toContain("milestone_oak");
    expect(snapshot.unlockedSpeciesIds).not.toContain("horizon_cedar"); // 21.1k still locked
  });

  it("counts early starts toward the sunrise poppy", () => {
    let { snapshot } = replay(START, []);
    for (let i = 0; i < 5; i++) {
      const day = addDays(START, i);
      ({ snapshot } = simulateDay(snapshot, {
        ...emptyDay(day),
        completedRuns: [
          { workoutId: `w-${day}`, category: "easy", startHourLocal: 6, window: "morning" },
        ],
      }));
    }
    expect(snapshot.state.earlyRunCount).toBe(5);
    expect(snapshot.unlockedSpeciesIds).toContain("sunrise_poppy");
  });

  it("phoenix fern survives the comeback streak's own reset", () => {
    // Build a garden, let it drought, then come back 3 straight days.
    let { snapshot } = replay(START, trainingWeeks(START, 2));
    let date = addDays(START, 14);
    for (let i = 0; i < 16; i++) {
      ({ snapshot } = simulateDay(snapshot, emptyDay(date)));
      date = addDays(date, 1);
    }
    for (let i = 0; i < 3; i++) {
      ({ snapshot } = simulateDay(snapshot, runDay(date, "easy")));
      date = addDays(date, 1);
    }
    expect(snapshot.state.bestComebackStreak).toBeGreaterThanOrEqual(3);
    expect(snapshot.unlockedSpeciesIds).toContain("phoenix_fern");
  });

  it("nextUnlocks nudges the closest locked species with real progress", async () => {
    const { nextUnlocks } = await import("../src/unlocks.js");
    const { snapshot } = replay(START, trainingWeeks(START, 2));
    const next = nextUnlocks(snapshot, 3);
    expect(next.length).toBe(3);
    for (const n of next) {
      expect(n.unlocked).toBe(false);
      expect(n.progress!.current).toBeLessThan(n.progress!.target);
      expect(n.hint.length).toBeGreaterThan(0);
    }
    // Sorted by least remaining first.
    const remaining = next.map((n) => 1 - n.progress!.current / n.progress!.target);
    expect([...remaining].sort((a, b) => a - b)).toEqual(remaining);
  });
});
