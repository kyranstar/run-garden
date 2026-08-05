import { describe, expect, it } from "vitest";
import { addDays } from "@rg/domain";
import type { WorkoutCategory } from "@rg/domain";
import {
  DEFAULT_GARDEN_CONFIG,
  SPECIES,
  describeGate,
  disciplineBalance,
  gateProgress,
  gateSatisfied,
  groundKindFor,
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

type Discipline = "run" | "strength" | "yoga";

/** A single unplanned session of one discipline (the shape the worker sends). */
function sessionDay(
  date: string,
  discipline: Discipline,
  extra: Partial<GardenDayInput> = {},
): GardenDayInput {
  const category: WorkoutCategory =
    discipline === "strength" ? "strength" : discipline === "yoga" ? "yoga" : "easy";
  return {
    ...emptyDay(date),
    completedRuns: [{ workoutId: `${discipline}-${date}`, category, discipline, unplanned: true }],
    ...extra,
  };
}

/** A week that touches all three disciplines. */
function mixedWeeks(startMonday: string, weeks: number): GardenDayInput[] {
  const days: GardenDayInput[] = [];
  for (let w = 0; w < weeks; w++) {
    const mon = addDays(startMonday, w * 7);
    days.push(sessionDay(mon, "strength"));
    days.push(runDay(addDays(mon, 1), "quality"));
    days.push(sessionDay(addDays(mon, 2), "yoga"));
    days.push(runDay(addDays(mon, 3), "easy"));
    days.push(sessionDay(addDays(mon, 4), "strength"));
    days.push(runDay(addDays(mon, 5), "long"));
    days.push(runDay(addDays(mon, 6), "recovery"));
  }
  return days;
}

function advanceDays(
  snapshot: GardenSnapshot,
  from: string,
  count: number,
  make: (date: string) => GardenDayInput,
) {
  let s = snapshot;
  let date = from;
  for (let i = 0; i < count; i++) {
    s = simulateDay(s, make(date)).snapshot;
    date = addDays(date, 1);
  }
  return { snapshot: s, nextDate: date };
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

describe("tri-discipline ecosystem", () => {
  it("a strength session feeds the soil without watering the garden", () => {
    const g = initialSnapshot(START);
    const idle = advanceEmptyDays(g, START, 3);
    const before = idle.snapshot.state;
    const beforeHydration = idle.snapshot.plants[0]!.hydration;

    const { snapshot } = simulateDay(idle.snapshot, sessionDay(idle.nextDate, "strength"));

    expect(snapshot.state.daysSinceStrength).toBe(0);
    expect(snapshot.state.strengthSessionCount).toBe(1);
    // The first-ever session flips the has-flag: balance now reports a real
    // recency instead of "not yet".
    expect(snapshot.state.hasStrength).toBe(true);
    expect(disciplineBalance(snapshot.state).strength.days).toBe(0);
    expect(snapshot.state.soilHealth).toBeCloseTo(before.soilHealth + 0.05, 6);
    // Lifting is not running: the run clock keeps ticking and no rain falls.
    expect(snapshot.state.daysSinceCompletedRun).toBe(before.daysSinceCompletedRun + 1);
    expect(snapshot.state.weatherState).not.toBe("fresh_rain");
    expect(snapshot.state.weatherState).not.toBe("recovery_rain");
    expect(snapshot.plants[0]!.hydration).toBeLessThan(beforeHydration);
    // Modest hydration support all the same.
    expect(snapshot.state.moisture).toBeGreaterThan(before.moisture);
  });

  it("a planned strength workout tends the soil instead of watering the garden", () => {
    const g = initialSnapshot(START);
    const idle = advanceEmptyDays(g, START, 3);
    const before = idle.snapshot.state;

    // No discipline tag at all: the category alone marks this as lifting.
    const { snapshot } = simulateDay(idle.snapshot, {
      ...emptyDay(idle.nextDate),
      completedRuns: [{ workoutId: "planned-lift", category: "strength" }],
    });

    expect(snapshot.state.strengthSessionCount).toBe(1);
    // Exactly one helping of soil — the session is counted once, not per path.
    expect(snapshot.state.soilHealth).toBeCloseTo(before.soilHealth + 0.05, 6);
    expect(snapshot.state.daysSinceCompletedRun).toBe(before.daysSinceCompletedRun + 1);
    expect(snapshot.state.totalCompletedRuns).toBe(before.totalCompletedRuns);
    expect(snapshot.state.weatherState).not.toBe("fresh_rain");
  });

  it("a yoga session lifts the life axis, which fades again when yoga lapses", () => {
    const g = initialSnapshot(START);
    const idle = advanceEmptyDays(g, START, 3);
    const control = simulateDay(idle.snapshot, emptyDay(idle.nextDate)).snapshot;
    const { snapshot } = simulateDay(idle.snapshot, sessionDay(idle.nextDate, "yoga"));

    expect(snapshot.state.yogaSessionCount).toBe(1);
    expect(snapshot.state.daysSinceYoga).toBe(0);
    expect(snapshot.state.biodiversity).toBeCloseTo(control.state.biodiversity + 0.04, 6);
    expect(snapshot.state.floweringDensity).toBeCloseTo(control.state.floweringDensity + 0.03, 6);
    // Yoga is not running either.
    expect(snapshot.state.daysSinceCompletedRun).toBe(control.state.daysSinceCompletedRun);

    // Ten quiet days later the yoga-earned life has faded back to the garden's own.
    const after = advanceEmptyDays(snapshot, addDays(idle.nextDate, 1), 10);
    const afterControl = advanceEmptyDays(control, addDays(idle.nextDate, 1), 10);
    expect(after.snapshot.state.daysSinceYoga).toBe(10);
    expect(after.snapshot.state.biodiversity).toBeCloseTo(
      afterControl.snapshot.state.biodiversity,
      6,
    );
  });

  it("never claws back banked life credit when the garden grows, then thins", () => {
    // Bank credit while the garden is sparse.
    const banked = advanceDays(initialSnapshot(START), START, 10, (d) =>
      sessionDay(d, "yoga"),
    ).snapshot;
    expect(banked.state.lifeBonusBiodiversity).toBeCloseTo(0.4, 6);

    // The garden's own variety then grows well past that credit's headroom.
    const grown = structuredClone(banked);
    const template = banked.plants[0]!;
    grown.plants = SPECIES.slice(0, 18).map((sp, i) => ({
      ...template,
      id: `fx-${i}`,
      speciesId: sp.id,
      category: sp.category,
    }));

    const nextDate = addDays(START, 10);
    const withYoga = simulateDay(grown, sessionDay(nextDate, "yoga")).snapshot;
    const withoutYoga = simulateDay(grown, emptyDay(nextDate)).snapshot;
    expect(withYoga.state.lifeBonusBiodiversity).toBeGreaterThanOrEqual(
      withoutYoga.state.lifeBonusBiodiversity,
    );

    // And when the garden thins again, the extra session must never have left
    // the meadow poorer than skipping it would have.
    const thin = (snap: GardenSnapshot): GardenSnapshot => {
      const t = structuredClone(snap);
      for (const p of t.plants.slice(3)) {
        p.state = "dead";
        p.health = 0;
      }
      return t;
    };
    const later = addDays(nextDate, 1);
    const afterWith = simulateDay(thin(withYoga), emptyDay(later)).snapshot;
    const afterWithout = simulateDay(thin(withoutYoga), emptyDay(later)).snapshot;
    expect(afterWith.state.biodiversity).toBeGreaterThanOrEqual(afterWithout.state.biodiversity);
  });

  it("caps how far yoga alone can tint the garden", () => {
    const devoted = advanceDays(initialSnapshot(START), START, 200, (d) =>
      sessionDay(d, "yoga"),
    ).snapshot;
    expect(devoted.state.lifeBonusBiodiversity).toBe(0.5);
    expect(devoted.state.lifeBonusFlowering).toBe(0.35);
  });

  it("neglected strength wilts the soil; rest mode and plan gaps pause it", () => {
    const g = initialSnapshot(START);
    const soil0 = g.state.soilHealth;

    const ten = advanceEmptyDays(g, START, 10);
    expect(ten.snapshot.state.daysSinceStrength).toBe(10);
    // Decay starts once the clock passes 7: days 8, 9, 10.
    expect(ten.snapshot.state.soilHealth).toBeCloseTo(soil0 - 0.06, 6);

    // Floors at 0.2 no matter how long the neglect runs.
    const long = advanceEmptyDays(g, START, 60);
    expect(long.snapshot.state.soilHealth).toBeCloseTo(0.2, 6);

    // Rest mode freezes the clock and the decay.
    const rested = advanceDays(ten.snapshot, ten.nextDate, 5, (date) => ({
      ...emptyDay(date),
      restModeActive: true,
    }));
    expect(rested.snapshot.state.daysSinceStrength).toBe(10);
    expect(rested.snapshot.state.soilHealth).toBeCloseTo(ten.snapshot.state.soilHealth, 6);

    // Plan gaps skip the penalty, but time still passes.
    const gapped = advanceDays(ten.snapshot, ten.nextDate, 5, (date) => ({
      ...emptyDay(date),
      planGap: true,
    }));
    expect(gapped.snapshot.state.daysSinceStrength).toBe(15);
    expect(gapped.snapshot.state.soilHealth).toBeCloseTo(ten.snapshot.state.soilHealth, 6);
  });

  it("inputs without a discipline still behave exactly like runs", () => {
    const plain = trainingWeeks(START, 3);
    const tagged = plain.map((d) => ({
      ...d,
      completedRuns: d.completedRuns.map((r) => ({ ...r, discipline: "run" as const })),
    }));
    const a = replay(START, plain);
    const b = replay(START, tagged);
    expect(b.snapshot).toEqual(a.snapshot);
    expect(b.events).toEqual(a.events);
  });

  it("long-run tree growth scales with soil health", () => {
    const built = replay(START, trainingWeeks(START, 2)).snapshot;
    const longRunDate = addDays(START, 14);
    const sapling = [...built.plants]
      .filter((p) => p.category === "tree" && p.maturity < 1)
      .sort((x, y) => x.maturity - y.maturity || x.id.localeCompare(y.id))[0]!;

    const growthAt = (soilHealth: number): number => {
      const seeded = structuredClone(built);
      seeded.state.soilHealth = soilHealth;
      const { snapshot } = simulateDay(seeded, runDay(longRunDate, "long"));
      return snapshot.plants.find((p) => p.id === sapling.id)!.maturity - sapling.maturity;
    };

    expect(growthAt(1)).toBeGreaterThan(growthAt(0.2));
  });

  it("wildlife stays in the garden while any discipline is fresh", () => {
    const built = replay(START, trainingWeeks(START, 8)).snapshot;
    expect(built.wildlife.squirrels).toBe(true);
    const quietFrom = addDays(START, 8 * 7);

    // Lifting every day: the run clock goes stale but the garden is still tended.
    const lifting = advanceDays(built, quietFrom, 32, (date) => sessionDay(date, "strength"));
    expect(lifting.snapshot.state.daysSinceCompletedRun).toBeGreaterThanOrEqual(
      DEFAULT_GARDEN_CONFIG.dormancyStartDays,
    );
    expect(lifting.snapshot.state.daysSinceStrength).toBe(0);
    expect(lifting.snapshot.wildlife.squirrels).toBe(true);

    // Nothing at all for the same stretch: the visitors leave.
    const idle = advanceEmptyDays(built, quietFrom, 32);
    expect(idle.snapshot.wildlife.squirrels).toBe(false);
  });

  it("counts a balanced Mon–Sun week only when all three disciplines land", () => {
    const week = (mon: string, withYoga: boolean): GardenDayInput[] => [
      runDay(mon, "easy"),
      sessionDay(addDays(mon, 1), "strength"),
      withYoga ? sessionDay(addDays(mon, 2), "yoga") : emptyDay(addDays(mon, 2)),
      emptyDay(addDays(mon, 3)),
      emptyDay(addDays(mon, 4)),
      emptyDay(addDays(mon, 5)),
      emptyDay(addDays(mon, 6)),
    ];

    // The week is only counted once the next week starts.
    expect(replay(START, week(START, true)).snapshot.state.balancedWeekCount).toBe(0);
    const balanced = replay(START, [...week(START, true), emptyDay(addDays(START, 7))]);
    expect(balanced.snapshot.state.balancedWeekCount).toBe(1);
    expect(balanced.snapshot.state.weekDisciplines.weekStart).toBe(addDays(START, 7));

    const missingYoga = replay(START, [...week(START, false), emptyDay(addDays(START, 7))]);
    expect(missingYoga.snapshot.state.balancedWeekCount).toBe(0);
  });

  it("replays mixed-discipline histories deterministically", () => {
    const days = mixedWeeks(START, 4);
    const a = replay(START, days);
    const b = replay(START, days);
    expect(b.snapshot).toEqual(a.snapshot);
    expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id));
    expect(a.snapshot.state.strengthSessionCount).toBe(8);
    expect(a.snapshot.state.yogaSessionCount).toBe(4);
    expect(a.snapshot.state.balancedWeekCount).toBe(3);
  });

  it("emits soil_tended once when a strength session lands after a real gap", () => {
    const g = initialSnapshot(START);
    const idle = advanceEmptyDays(g, START, 4);
    expect(idle.snapshot.state.daysSinceStrength).toBe(4);

    const { events } = simulateDay(idle.snapshot, sessionDay(idle.nextDate, "strength"));
    expect(events.filter((e) => e.kind === "soil_tended")).toHaveLength(1);
  });

  it("does not emit soil_tended for a strength session the very next day", () => {
    const g = initialSnapshot(START);
    const idle = advanceEmptyDays(g, START, 4);
    const first = simulateDay(idle.snapshot, sessionDay(idle.nextDate, "strength"));
    const second = simulateDay(
      first.snapshot,
      sessionDay(addDays(idle.nextDate, 1), "strength"),
    );
    expect(second.events.filter((e) => e.kind === "soil_tended")).toHaveLength(0);
  });

  it("stays quiet when strength lands inside its own grace period", () => {
    const g = initialSnapshot(START);
    const idle = advanceEmptyDays(g, START, 2); // daysSinceStrength -> 2, below the grace of 3
    const { events } = simulateDay(idle.snapshot, sessionDay(idle.nextDate, "strength"));
    expect(events.filter((e) => e.kind === "soil_tended")).toHaveLength(0);
  });

  it("emits life_tended once when a yoga session lands after a real gap", () => {
    const g = initialSnapshot(START);
    const idle = advanceEmptyDays(g, START, 4);
    const { events } = simulateDay(idle.snapshot, sessionDay(idle.nextDate, "yoga"));
    expect(events.filter((e) => e.kind === "life_tended")).toHaveLength(1);
  });

  it("does not emit life_tended for a yoga session the very next day", () => {
    const g = initialSnapshot(START);
    const idle = advanceEmptyDays(g, START, 4);
    const first = simulateDay(idle.snapshot, sessionDay(idle.nextDate, "yoga"));
    const second = simulateDay(first.snapshot, sessionDay(addDays(idle.nextDate, 1), "yoga"));
    expect(second.events.filter((e) => e.kind === "life_tended")).toHaveLength(0);
  });
});

describe("discipline balance", () => {
  it("is fully healthy when every clock is at zero — and honest that lift/yoga never happened", () => {
    const balance = disciplineBalance(initialSnapshot(START).state);
    expect(balance.run).toEqual({ days: 0, health: 1 });
    // days: null = never recorded; the UI renders "not yet" instead of
    // fabricating a recency for a discipline the user has never done.
    expect(balance.strength).toEqual({ days: null, health: 1 });
    expect(balance.yoga).toEqual({ days: null, health: 1 });
    expect(balance.overall).toBe(1);
  });

  it("fades run health to zero once sixteen days have passed", () => {
    const state = { ...initialSnapshot(START).state, daysSinceCompletedRun: 16 };
    const balance = disciplineBalance(state);
    // (16 − 2) / 14 = 1 → clamp01(1 − 1) = 0
    expect(balance.run.health).toBeCloseTo(0, 6);
    expect(balance.overall).toBeCloseTo(0, 6);
  });

  it("respects each discipline's grace period", () => {
    const state = { ...initialSnapshot(START).state, daysSinceStrength: 3 };
    expect(disciplineBalance(state).strength.health).toBe(1);
  });

  it("every expansion earns a ground, and the ceremony event names its kind", () => {
    const built = replay(START, trainingWeeks(START, 10));
    const state = built.snapshot.state;
    expect(state.unlockedRegions).toBeGreaterThan(1); // the trigger fired at least once
    const grounds = state.grounds ?? [];
    expect(grounds.length).toBe(state.unlockedRegions - 1);
    const kinds = new Set(["meadow", "stream", "terrace", "glade"]);
    for (const [i, g] of grounds.entries()) {
      expect(kinds.has(g.kind)).toBe(true);
      expect(g.region).toBe(i + 1); // 0-based band index, region 0 is genesis
      expect(g.earnedDate >= START).toBe(true);
    }
    // Events and ledger agree, in order.
    const regionEvents = built.events.filter((e) => e.kind === "region_unlocked");
    expect(regionEvents.map((e) => e.detail)).toEqual(grounds.map((g) => g.kind));
    // Deterministic: the same replay grows the same grounds.
    expect(replay(START, trainingWeeks(START, 10)).snapshot.state.grounds).toEqual(grounds);
  });

  it("groundKindFor honors the discipline that led the block", () => {
    const base = initialSnapshot(START).state;
    const mk = (over: Partial<typeof base>) => ({ ...base, ...over });
    expect(groundKindFor(mk({ strengthSessionCount: 5, longRunCount: 2 }))).toBe("terrace");
    expect(groundKindFor(mk({ yogaSessionCount: 6, longRunCount: 3 }))).toBe("glade");
    expect(groundKindFor(mk({ longRunCount: 4, strengthSessionCount: 2 }))).toBe("stream");
    expect(groundKindFor(mk({ easyRunCount: 9 }))).toBe("meadow");
    // Deltas are measured from the last expansion's watermark.
    expect(
      groundKindFor(
        mk({
          longRunCount: 10,
          countersAtExpansion: { long: 8, strength: 0, yoga: 0, balanced: 0 },
        }),
      ),
    ).toBe("meadow");
  });

  it("takes the overall score from the weakest practiced discipline", () => {
    const state = {
      ...initialSnapshot(START).state,
      daysSinceCompletedRun: 0,
      daysSinceStrength: 10, // (10 − 3) / 14 = 0.5 → health 0.5
      daysSinceYoga: 0,
      hasStrength: true, // practiced — a never-practiced axis is excluded from overall
    };
    const balance = disciplineBalance(state);
    expect(balance.strength.health).toBeCloseTo(0.5, 6);
    expect(balance.overall).toBeCloseTo(0.5, 6);
  });
});

describe("discipline unlock gates", () => {
  const snapshotWith = (patch: Partial<GardenSnapshot["state"]>): GardenSnapshot => {
    const base = initialSnapshot(START);
    return { ...base, state: { ...base.state, ...patch } };
  };

  it("strength_sessions gate is satisfied only at or past the count", () => {
    const gate = { kind: "strength_sessions", count: 5 } as const;
    expect(gateSatisfied(gate, snapshotWith({ strengthSessionCount: 4 }))).toBe(false);
    expect(gateSatisfied(gate, snapshotWith({ strengthSessionCount: 5 }))).toBe(true);
  });

  it("yoga_sessions gate is satisfied only at or past the count", () => {
    const gate = { kind: "yoga_sessions", count: 10 } as const;
    expect(gateSatisfied(gate, snapshotWith({ yogaSessionCount: 9 }))).toBe(false);
    expect(gateSatisfied(gate, snapshotWith({ yogaSessionCount: 10 }))).toBe(true);
  });

  it("balanced_weeks gate is satisfied only at or past the count", () => {
    const gate = { kind: "balanced_weeks", count: 3 } as const;
    expect(gateSatisfied(gate, snapshotWith({ balancedWeekCount: 2 }))).toBe(false);
    expect(gateSatisfied(gate, snapshotWith({ balancedWeekCount: 3 }))).toBe(true);
  });

  it("gateProgress returns count-based fractions for the new gates", () => {
    expect(
      gateProgress({ kind: "strength_sessions", count: 5 }, snapshotWith({ strengthSessionCount: 3 })),
    ).toEqual({ current: 3, target: 5 });
    expect(
      gateProgress({ kind: "yoga_sessions", count: 10 }, snapshotWith({ yogaSessionCount: 6 })),
    ).toEqual({ current: 6, target: 10 });
    expect(
      gateProgress({ kind: "balanced_weeks", count: 3 }, snapshotWith({ balancedWeekCount: 1 })),
    ).toEqual({ current: 1, target: 3 });
  });

  it("describes the new gates in plain language", () => {
    expect(describeGate({ kind: "strength_sessions", count: 5 })).toBe("Complete 5 strength sessions");
    expect(describeGate({ kind: "strength_sessions", count: 1 })).toBe("Complete 1 strength session");
    expect(describeGate({ kind: "yoga_sessions", count: 10 })).toBe("Complete 10 yoga sessions");
    expect(describeGate({ kind: "yoga_sessions", count: 1 })).toBe("Complete 1 yoga session");
    expect(describeGate({ kind: "balanced_weeks", count: 3 })).toBe(
      "3 balanced weeks — run, lift, and yoga in the same week",
    );
  });

  it("unlocks the strength-gated species once enough strength sessions land", () => {
    let snapshot = initialSnapshot(START);
    let date = START;
    for (let i = 0; i < 5; i++) {
      ({ snapshot } = simulateDay(snapshot, sessionDay(date, "strength")));
      date = addDays(date, 1);
    }
    expect(snapshot.state.strengthSessionCount).toBe(5);
    expect(snapshot.unlockedSpeciesIds).toContain("stonecrop");
    expect(snapshot.unlockedSpeciesIds).not.toContain("ironwood"); // needs 12
  });

  it("unlocks the yoga-gated species once enough yoga sessions land", () => {
    let snapshot = initialSnapshot(START);
    let date = START;
    for (let i = 0; i < 5; i++) {
      ({ snapshot } = simulateDay(snapshot, sessionDay(date, "yoga")));
      date = addDays(date, 1);
    }
    expect(snapshot.state.yogaSessionCount).toBe(5);
    expect(snapshot.unlockedSpeciesIds).toContain("moon_lotus");
    expect(snapshot.unlockedSpeciesIds).not.toContain("meditation_moss"); // needs 10
  });

  it("unlocks harmony_willow after three balanced Mon–Sun weeks", () => {
    const week = (mon: string): GardenDayInput[] => [
      runDay(mon, "easy"),
      sessionDay(addDays(mon, 1), "strength"),
      sessionDay(addDays(mon, 2), "yoga"),
      emptyDay(addDays(mon, 3)),
      emptyDay(addDays(mon, 4)),
      emptyDay(addDays(mon, 5)),
      emptyDay(addDays(mon, 6)),
    ];
    const days = [
      ...week(START),
      ...week(addDays(START, 7)),
      ...week(addDays(START, 14)),
      emptyDay(addDays(START, 21)), // closes the third balanced week
    ];
    const { snapshot } = replay(START, days);
    expect(snapshot.state.balancedWeekCount).toBe(3);
    expect(snapshot.unlockedSpeciesIds).toContain("harmony_willow");
  });
});

describe("v1 snapshot self-healing (missing tri-discipline fields)", () => {
  /**
   * Snapshots persisted before the tri-discipline engine shipped are plain
   * JSON on disk without the five new state fields at all — not just
   * `undefined` at the type level. The read path (buildGardenView calling
   * disciplineBalance/gateProgress on the persisted snapshot, before any day
   * has simulated and self-healed it) must never NaN on them.
   */
  it("disciplineBalance and gateProgress stay finite when the new fields are absent", () => {
    const healthy = initialSnapshot(START);
    const v1State = { ...healthy.state } as Record<string, unknown>;
    delete v1State.daysSinceStrength;
    delete v1State.daysSinceYoga;
    delete v1State.strengthSessionCount;
    delete v1State.yogaSessionCount;
    delete v1State.balancedWeekCount;
    const v1Snapshot: GardenSnapshot = {
      ...healthy,
      state: v1State as unknown as GardenSnapshot["state"],
    };

    const balance = disciplineBalance(v1Snapshot.state);
    expect(Number.isFinite(balance.run.health)).toBe(true);
    expect(Number.isFinite(balance.strength.health)).toBe(true);
    expect(Number.isFinite(balance.yoga.health)).toBe(true);
    expect(Number.isFinite(balance.overall)).toBe(true);
    // Migrated v1 snapshots have no strength/yoga history — the honest answer
    // is "never" (days: null), not "0 days ago".
    expect(balance.strength).toEqual({ days: null, health: 1 });
    expect(balance.yoga).toEqual({ days: null, health: 1 });

    const newGates = [
      { kind: "strength_sessions", count: 5 } as const,
      { kind: "yoga_sessions", count: 10 } as const,
      { kind: "balanced_weeks", count: 3 } as const,
    ];
    for (const gate of newGates) {
      const progress = gateProgress(gate, v1Snapshot);
      expect(progress).toEqual({ current: 0, target: gate.count });
      expect(Number.isNaN(progress?.current)).toBe(false);
      expect(gateSatisfied(gate, v1Snapshot)).toBe(false);
    }
  });
});

/* ── Bundle 3: life in the water (2026-08-05 spec) ─────────────────────── */

describe("ground gates + aquatic species", () => {
  it("ground gates are satisfied only once that ground is carved", () => {
    const fresh = initialSnapshot(START);
    expect(gateSatisfied({ kind: "ground", ground: "stream" }, fresh)).toBe(false);
    const carved: GardenSnapshot = structuredClone(fresh);
    carved.state.grounds = [{ region: 1, kind: "stream", earnedDate: START }];
    expect(gateSatisfied({ kind: "ground", ground: "stream" }, carved)).toBe(true);
    expect(gateSatisfied({ kind: "ground", ground: "terrace" }, carved)).toBe(false);
  });

  it("aquatic species never plant before their stream exists", () => {
    // 8 weeks of steady training but no stream ground: no waterlily/cattail.
    const built = replay(START, trainingWeeks(START, 8));
    const streamless = built.snapshot.state.grounds?.every((g) => g.kind !== "stream") ?? true;
    if (streamless) {
      expect(built.snapshot.plants.some((p) => p.speciesId === "waterlily")).toBe(false);
      expect(built.snapshot.plants.some((p) => p.speciesId === "cattail")).toBe(false);
    }
  });
});

describe("race + evening + best-chain counters", () => {
  it("a race day counts the race AND the quality effects", () => {
    const one = simulateDay(initialSnapshot(START), runDay(START, "race"));
    expect(one.snapshot.state.raceCount).toBe(1);
    expect(one.snapshot.state.qualityRunCount).toBe(1);
  });

  it("evening_runs gate exposes progress", () => {
    const p = gateProgress({ kind: "evening_runs", count: 10 }, initialSnapshot(START));
    expect(p).toEqual({ current: 0, target: 10 });
  });

  it("bestConsistentWeeks survives a chain reset", () => {
    let snap = initialSnapshot(START);
    snap = simulateDay(snap, { ...emptyDay(START), weekAdherence: 1 }).snapshot;
    snap = simulateDay(snap, { ...emptyDay(addDays(START, 1)), weekAdherence: 1 }).snapshot;
    expect(snap.state.consecutiveConsistentWeeks).toBe(2);
    snap = simulateDay(snap, { ...emptyDay(addDays(START, 2)), weekAdherence: 0.2 }).snapshot;
    expect(snap.state.consecutiveConsistentWeeks).toBe(0);
    expect(snap.state.bestConsistentWeeks).toBe(2);
  });

  it("a v3-shaped snapshot (fields missing) simulates without crashing", () => {
    const snap = initialSnapshot(START);
    const looseState = snap.state as unknown as Record<string, unknown>;
    delete looseState.raceCount;
    delete looseState.bestConsistentWeeks;
    delete (snap.wildlife as unknown as Record<string, unknown>).ducks;
    const out = simulateDay(snap as GardenSnapshot, runDay(START, "race"));
    expect(out.snapshot.state.raceCount).toBe(1);
  });
});

describe("ducks", () => {
  it("arrive with a stream and moisture, and depart in decline", () => {
    const base = initialSnapshot(START);
    const withStream: GardenSnapshot = structuredClone(base);
    withStream.state.grounds = [{ region: 1, kind: "stream", earnedDate: START }];
    const wet = simulateDay(withStream, runDay(START, "easy"));
    expect(wet.snapshot.wildlife.ducks).toBe(true);
    expect(wet.events.some((e) => e.kind === "wildlife_arrived" && e.wildlifeId === "ducks")).toBe(
      true,
    );
    // No stream → never.
    const dry = simulateDay(base, runDay(START, "easy"));
    expect(dry.snapshot.wildlife.ducks).toBe(false);
  });
});
