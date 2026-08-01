import type { GardenEvent, GardenPlant, LocalDate, WildlifeKind } from "@rg/domain";
import { addDays, daysBetween } from "@rg/domain";
import { conditionWord, deriveWeather, seasonOf } from "./condition.js";
import { choosePosition, chooseDeadWoodHost, chooseHostTree } from "./layout.js";
import { pick, roll } from "./prng.js";
import { SPECIES, speciesOrThrow, type Species, type UnlockGate } from "./species.js";
import {
  DEFAULT_GARDEN_CONFIG,
  SIMULATION_VERSION,
  type CompletedRunInput,
  type DayResult,
  type EngineGardenState,
  type GardenConfig,
  type GardenDayInput,
  type GardenSnapshot,
} from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Genesis

export function initialSnapshot(createdDate: LocalDate): GardenSnapshot {
  const state: EngineGardenState = {
    moisture: 0.7,
    soilHealth: 0.6,
    biodiversity: 0,
    canopy: 0,
    floweringDensity: 0,
    droughtDays: 0,
    daysSinceCompletedRun: 0,
    weatherState: "soft_sun",
    season: seasonOf(createdDate),
    // One day before genesis so the created date itself can be simulated.
    lastSimulatedDate: addDays(createdDate, -1),
    restMode: false,
    unlockedRegions: 1,
    qualityRunCount: 0,
    easyRunCount: 0,
    longRunCount: 0,
    recoveryRunCount: 0,
    eveningRunCount: 0,
    totalCompletedRuns: 0,
    consecutiveConsistentWeeks: 0,
    comebackStreak: 0,
    inComeback: false,
    lastPlantDeathDate: null,
    createdDate,
  };
  const snapshot: GardenSnapshot = {
    version: SIMULATION_VERSION,
    state,
    plants: [],
    unlockedSpeciesIds: SPECIES.filter((s) => s.unlock.kind === "start").map((s) => s.id),
    wildlife: {
      birds: false,
      bees: false,
      butterflies: false,
      fireflies: false,
      squirrels: false,
      rabbits: false,
      frogs: false,
      dragonflies: false,
      ladybugs: false,
    },
  };
  // The garden begins with a small starter meadow so day one is not bare dirt.
  seedStarterPlants(snapshot, createdDate);
  return snapshot;
}

function seedStarterPlants(snapshot: GardenSnapshot, date: LocalDate): void {
  const starters = ["meadow_grass", "meadow_grass", "clover", "meadow_grass", "clover"];
  starters.forEach((speciesId, i) => {
    addPlant(snapshot, speciesId, date, `genesis-${i}`, undefined, 0.35 + 0.1 * (i % 3));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Plant helpers

function livingPlants(plants: GardenPlant[]): GardenPlant[] {
  return plants.filter((p) => p.state !== "dead");
}

function addPlant(
  snapshot: GardenSnapshot,
  speciesId: string,
  date: LocalDate,
  seedSuffix: string,
  sourceWorkoutId: string | undefined,
  initialMaturity = 0,
): GardenPlant {
  const species = speciesOrThrow(speciesId);
  const id = `pl-${speciesId}-${date}-${seedSuffix}`;
  let hostPlantId: string | undefined;
  if (species.needsHost === "tree") hostPlantId = chooseHostTree(snapshot.plants)?.id;
  if (species.needsHost === "dead_wood") hostPlantId = chooseDeadWoodHost(snapshot.plants)?.id;

  const host = hostPlantId ? snapshot.plants.find((p) => p.id === hostPlantId) : undefined;
  const position = host
    ? { x: host.position.x + (roll(`hostpos:${id}`) - 0.5) * 0.02, y: host.position.y + 0.01, region: host.position.region }
    : choosePosition(id, species, snapshot.plants, snapshot.state.unlockedRegions);

  const plant: GardenPlant = {
    id,
    speciesId,
    category: species.category,
    plantedAt: date,
    sourceWorkoutId,
    health: 0.9,
    hydration: 0.8,
    maturity: initialMaturity,
    bloomProgress: 0,
    state: initialMaturity >= 0.7 ? "mature" : initialMaturity > 0.05 ? "growing" : "seed",
    position,
    hostPlantId,
  };
  snapshot.plants.push(plant);
  return plant;
}

function refreshLivingState(p: GardenPlant, state: EngineGardenState, cfg: GardenConfig): void {
  if (p.state === "dead") return;
  if (state.restMode) {
    p.state = p.maturity >= 0.7 ? "dormant" : p.state;
    return;
  }
  if (p.bloomProgress >= 1 && p.hydration > 0.4) {
    p.state = "flowering";
    return;
  }
  if (state.daysSinceCompletedRun >= cfg.dormancyStartDays && p.state === "dormant") return;
  if (state.daysSinceCompletedRun >= cfg.droughtStartDays && p.health < 0.55) {
    p.state = "wilted";
    return;
  }
  if (p.hydration < 0.35) {
    p.state = "thirsty";
    return;
  }
  p.state = p.maturity >= 0.7 ? "mature" : p.maturity > 0.05 ? "growing" : "seed";
}

// ─────────────────────────────────────────────────────────────────────────────
// Day simulation

export function simulateDay(
  prev: GardenSnapshot,
  input: GardenDayInput,
  cfg: GardenConfig = DEFAULT_GARDEN_CONFIG,
): DayResult {
  // Idempotency: each calendar date is applied at most once, in order.
  if (input.date <= prev.state.lastSimulatedDate) return { snapshot: prev, events: [] };
  if (input.date < prev.state.createdDate) return { snapshot: prev, events: [] };

  const snapshot: GardenSnapshot = structuredClone(prev);
  const { state } = snapshot;
  const events: GardenEvent[] = [];
  let seq = 0;
  const emit = (e: Omit<GardenEvent, "id" | "date" | "seq" | "simulationVersion">): void => {
    events.push({
      id: `ge-${input.date}-${seq}`,
      date: input.date,
      seq: seq++,
      simulationVersion: SIMULATION_VERSION,
      ...e,
    });
  };

  state.season = seasonOf(input.date);

  // Rest-mode transitions.
  if (input.restModeActive && !state.restMode) {
    state.restMode = true;
    emit({ kind: "rest_mode_started" });
  } else if (!input.restModeActive && state.restMode) {
    state.restMode = false;
    emit({ kind: "rest_mode_ended" });
  }

  const runs = [...input.completedRuns].sort((a, b) => a.workoutId.localeCompare(b.workoutId));
  const plannedRuns = runs.filter((r) => !r.unplanned);
  const comebackToday =
    plannedRuns.length > 0 && state.daysSinceCompletedRun >= cfg.droughtStartDays;

  // 1. Missed runs resolved today (explicit skips / aged-out) — dryness debt only.
  if (!state.restMode) {
    for (const missed of input.missedRuns) {
      state.moisture = Math.max(0.05, state.moisture - 0.06);
      for (const p of livingPlants(snapshot.plants)) {
        p.hydration = Math.max(0, p.hydration - 0.1);
      }
      emit({ kind: "missed_run", workoutId: missed.workoutId });
    }
  }

  // 2. Completed runs.
  for (const run of runs) {
    applyRun(snapshot, run, input.date, cfg, emit, comebackToday);
  }
  if (runs.length > 0) {
    if (plannedRuns.length > 0) {
      state.daysSinceCompletedRun = 0;
      state.droughtDays = 0;
    }
  } else if (!state.restMode) {
    // 3. A day with no completed run.
    if (input.restObserved) {
      state.soilHealth = Math.min(1, state.soilHealth + 0.01);
      emit({ kind: "rest_observed" });
    } else if (!input.planGap) {
      state.daysSinceCompletedRun += 1;
      applyDailyDecay(snapshot, input.date, cfg, emit);
    }
    // Plan gaps: the plan ended — never an endless penalty.
  }

  // 4. Passive growth for hydrated plants (rain lingers between runs).
  if (!state.restMode && state.daysSinceCompletedRun < cfg.droughtStartDays) {
    for (const p of livingPlants(snapshot.plants)) {
      if (p.hydration > 0.5 && p.maturity < 1) {
        const species = speciesOrThrow(p.speciesId);
        p.maturity = Math.min(1, p.maturity + 0.5 / species.growthDays);
      }
    }
  }

  // 5. Bloom decay without water; dryness closes flowers.
  for (const p of livingPlants(snapshot.plants)) {
    if (p.bloomProgress > 0 && runs.length === 0) {
      const dry = state.daysSinceCompletedRun >= cfg.drynessStartDays;
      p.bloomProgress = Math.max(0, p.bloomProgress - (dry ? 0.5 : 0.1));
    }
  }

  // 6. Weekly adherence feeds long-term consistency unlocks.
  if (input.weekAdherence !== undefined && !state.restMode) {
    if (input.weekAdherence >= 0.75) state.consecutiveConsistentWeeks += 1;
    else state.consecutiveConsistentWeeks = 0;
  }

  // 7. Unlocks, wildlife, regions, derived metrics.
  evaluateUnlocks(snapshot, input.date, emit);
  recomputeDerived(snapshot);
  evaluateWildlife(snapshot, cfg, emit);
  evaluateRegions(snapshot, cfg, emit);
  for (const p of snapshot.plants) refreshLivingState(p, state, cfg);
  recomputeDerived(snapshot);

  // 8. Weather.
  const weather = deriveWeather(
    state,
    cfg,
    plannedRuns.length > 0,
    input.restObserved,
    comebackToday,
    input.date,
  );
  if (weather !== state.weatherState) {
    state.weatherState = weather;
    emit({ kind: "weather_changed", detail: weather });
  }

  state.lastSimulatedDate = input.date;
  return { snapshot, events };
}

// ─────────────────────────────────────────────────────────────────────────────
// Run effects

function applyRun(
  snapshot: GardenSnapshot,
  run: CompletedRunInput,
  date: LocalDate,
  cfg: GardenConfig,
  emit: (e: Omit<GardenEvent, "id" | "date" | "seq" | "simulationVersion">) => void,
  comebackToday: boolean,
): void {
  const { state } = snapshot;
  const living = livingPlants(snapshot.plants);

  emit({
    kind: "run_completed",
    workoutId: run.workoutId,
    activityId: run.activityId,
    workoutCategory: run.category,
    detail: run.unplanned ? "unplanned" : undefined,
  });

  if (run.unplanned) {
    // Modest ambient benefit only; never rare species, never extra-intensity rewards.
    state.moisture = Math.min(1, state.moisture + 0.1);
    for (const p of living) p.hydration = Math.min(1, p.hydration + 0.15);
    return;
  }

  // Every completed planned run waters the whole garden.
  state.moisture = Math.min(1, state.moisture + (comebackToday ? 0.4 : 0.25));
  for (const p of living) {
    p.hydration = Math.min(1, p.hydration + (comebackToday ? 0.5 : 0.35));
    p.health = Math.min(1, p.health + 0.08);
    if (p.state === "dormant") p.state = p.maturity >= 0.7 ? "mature" : "growing";
    const species = speciesOrThrow(p.speciesId);
    if (p.maturity < 1) p.maturity = Math.min(1, p.maturity + 2 / species.growthDays);
  }

  if (comebackToday) {
    state.inComeback = true;
    state.comebackStreak = 0;
  }
  if (state.inComeback) {
    state.comebackStreak += 1;
    if (state.comebackStreak >= 2) {
      // Flowers reopen as the comeback takes hold.
      for (const p of living) {
        const species = speciesOrThrow(p.speciesId);
        if (species.flowers && p.maturity >= 0.9) p.bloomProgress = 1;
      }
    }
    if (state.comebackStreak >= 5 || (state.comebackStreak >= 3 && state.moisture > 0.85)) {
      state.inComeback = false;
      state.comebackStreak = 0;
    }
  }

  // Counters (planned runs only).
  state.totalCompletedRuns += 1;
  if (run.window === "evening") state.eveningRunCount += 1;

  switch (run.category) {
    case "quality":
    case "race": {
      state.qualityRunCount += 1;
      plantForQualityRun(snapshot, run, date, emit);
      // A hard effort can push mature flowering species into bloom.
      for (const p of livingPlants(snapshot.plants)) {
        const species = speciesOrThrow(p.speciesId);
        if (species.flowers && p.maturity >= 0.95 && p.hydration > 0.6) p.bloomProgress = 1;
      }
      break;
    }
    case "long": {
      state.longRunCount += 1;
      applyLongRun(snapshot, run, date, emit);
      break;
    }
    case "easy":
    case "unknown": {
      state.easyRunCount += 1;
      for (const p of livingPlants(snapshot.plants)) {
        p.hydration = Math.min(1, p.hydration + 0.1);
        if (p.maturity < 0.4) {
          const species = speciesOrThrow(p.speciesId);
          p.maturity = Math.min(1, p.maturity + 1 / species.growthDays);
        }
      }
      if (state.easyRunCount % 2 === 0) {
        plantFromPool(snapshot, ["groundcover", "grass"], run, date, emit, "easy");
      }
      break;
    }
    case "recovery": {
      state.recoveryRunCount += 1;
      state.soilHealth = Math.min(1, state.soilHealth + 0.03);
      for (const p of livingPlants(snapshot.plants)) {
        p.hydration = Math.min(1, p.hydration + 0.2);
      }
      const hasDeadWood = snapshot.plants.some((p) => p.state === "dead" && p.habitatRole);
      if (hasDeadWood && roll(`fungi:${run.workoutId}`) < 0.6) {
        plantFromPool(snapshot, ["fungus"], run, date, emit, "recovery");
      } else if (state.recoveryRunCount % 2 === 0) {
        plantFromPool(snapshot, ["groundcover"], run, date, emit, "recovery");
      }
      break;
    }
    case "cross_training":
    case "strength":
      // Supports the ecosystem modestly: hydration only (already applied).
      break;
    case "rest":
      break;
  }
}

function eligibleSpecies(
  snapshot: GardenSnapshot,
  categories: Array<Species["category"]>,
): Species[] {
  const living = livingPlants(snapshot.plants);
  const countBySpecies = new Map<string, number>();
  for (const p of living) countBySpecies.set(p.speciesId, (countBySpecies.get(p.speciesId) ?? 0) + 1);
  const caps: Record<string, number> = {
    flower: 5,
    shrub: 3,
    fern: 4,
    vine: 2,
    groundcover: 6,
    grass: 8,
    fungus: 3,
    tree: 2,
  };
  return SPECIES.filter((s) => {
    if (!categories.includes(s.category)) return false;
    // Gate check is live (not the unlocked list) so a run that satisfies a gate
    // can plant that species the same day; the unlock event still fires once.
    if (!gateSatisfied(s.unlock, snapshot)) return false;
    if ((countBySpecies.get(s.id) ?? 0) >= (caps[s.category] ?? 4)) return false;
    if (s.needsHost === "tree" && !chooseHostTree(snapshot.plants)) return false;
    if (s.needsHost === "dead_wood" && !chooseDeadWoodHost(snapshot.plants)) return false;
    return true;
  });
}

function plantForQualityRun(
  snapshot: GardenSnapshot,
  run: CompletedRunInput,
  date: LocalDate,
  emit: (e: Omit<GardenEvent, "id" | "date" | "seq" | "simulationVersion">) => void,
): void {
  // Prefer flowering plants, shrubs, unusual ferns, vines. When the scene is
  // dense, shift to understory so full-sized plants never endlessly overlap.
  const dense =
    livingPlants(snapshot.plants).length >
    snapshot.state.unlockedRegions * 12;
  const pools: Array<Array<Species["category"]>> = dense
    ? [["vine", "fern", "groundcover", "flower"], ["flower", "shrub"]]
    : [["flower", "shrub"], ["fern", "vine"], ["groundcover"]];
  for (const pool of pools) {
    if (plantFromPool(snapshot, pool, run, date, emit, "quality")) return;
  }
}

function plantFromPool(
  snapshot: GardenSnapshot,
  categories: Array<Species["category"]>,
  run: CompletedRunInput,
  date: LocalDate,
  emit: (e: Omit<GardenEvent, "id" | "date" | "seq" | "simulationVersion">) => void,
  seedTag: string,
): boolean {
  const eligible = eligibleSpecies(snapshot, categories);
  if (eligible.length === 0) return false;
  // Rarity-weighted deterministic pick.
  const weights = eligible.map((s) => (s.rarity === "rare" ? 1 : s.rarity === "uncommon" ? 2 : 4));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = roll(`species:${seedTag}:${run.workoutId}`) * total;
  let chosen = eligible[0]!;
  for (let i = 0; i < eligible.length; i++) {
    r -= weights[i]!;
    if (r <= 0) {
      chosen = eligible[i]!;
      break;
    }
  }
  const plant = addPlant(snapshot, chosen.id, date, run.workoutId, run.workoutId);
  emit({
    kind: "plant_added",
    plantId: plant.id,
    speciesId: chosen.id,
    workoutId: run.workoutId,
    workoutCategory: run.category,
  });
  return true;
}

function applyLongRun(
  snapshot: GardenSnapshot,
  run: CompletedRunInput,
  date: LocalDate,
  emit: (e: Omit<GardenEvent, "id" | "date" | "seq" | "simulationVersion">) => void,
): void {
  const { state } = snapshot;
  const livingTrees = livingPlants(snapshot.plants).filter((p) => p.category === "tree");

  // Strongly advance the least-mature sapling.
  const sapling = [...livingTrees]
    .filter((t) => t.maturity < 1)
    .sort((a, b) => a.maturity - b.maturity || a.id.localeCompare(b.id))[0];
  if (sapling) {
    const species = speciesOrThrow(sapling.speciesId);
    sapling.maturity = Math.min(1, sapling.maturity + Math.max(0.1, 4 / species.growthDays));
  }

  // Tree-placement milestones: the first long run plants the first tree; after
  // that a new tree arrives every third long run while there is visual room.
  const maxTrees = state.unlockedRegions * 2 + 1;
  const milestone = state.longRunCount === 1 || state.longRunCount % 3 === 0;
  if ((livingTrees.length === 0 || milestone) && livingTrees.length < maxTrees) {
    const eligible = eligibleSpecies(snapshot, ["tree"]);
    if (eligible.length > 0) {
      const chosen = pick(`tree:${run.workoutId}`, eligible);
      const plant = addPlant(snapshot, chosen.id, date, run.workoutId, run.workoutId);
      emit({
        kind: "plant_added",
        plantId: plant.id,
        speciesId: chosen.id,
        workoutId: run.workoutId,
        workoutCategory: run.category,
        detail: "tree_seed",
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Decay, drought, death

function applyDailyDecay(
  snapshot: GardenSnapshot,
  date: LocalDate,
  cfg: GardenConfig,
  emit: (e: Omit<GardenEvent, "id" | "date" | "seq" | "simulationVersion">) => void,
): void {
  const { state } = snapshot;
  const d = state.daysSinceCompletedRun;
  state.moisture = Math.max(0.05, state.moisture - 0.035);
  if (d >= cfg.droughtStartDays) state.droughtDays += 1;

  for (const p of livingPlants(snapshot.plants)) {
    p.hydration = Math.max(0, p.hydration - 0.05);
    if (p.hydration < 0.2) p.health = Math.max(0.05, p.health - 0.025);
  }

  // Dormancy phase: plants shut down gradually; groundcover contracts.
  if (d >= cfg.dormancyStartDays) {
    const candidates = livingPlants(snapshot.plants)
      .filter((p) => p.state !== "dormant" && p.category !== "tree")
      .sort((a, b) => a.hydration - b.hydration || a.id.localeCompare(b.id))
      .slice(0, 2);
    for (const p of candidates) {
      p.state = "dormant";
      emit({ kind: "plant_state_changed", plantId: p.id, detail: "dormant" });
    }
    for (const p of livingPlants(snapshot.plants)) {
      if (p.category === "groundcover" || p.category === "grass") {
        p.maturity = Math.max(0.2, p.maturity - 0.01);
      }
    }
  }

  // Death phase: slow, bounded, trees last, never the whole garden at once.
  if (d >= cfg.deathStartDays) {
    const canDieToday =
      state.lastPlantDeathDate == null ||
      daysBetween(state.lastPlantDeathDate, date) >= cfg.deathIntervalDays;
    if (canDieToday) {
      const living = livingPlants(snapshot.plants);
      const nonTrees = living
        .filter((p) => p.category !== "tree")
        .sort((a, b) => a.health - b.health || a.id.localeCompare(b.id));
      let victim: GardenPlant | undefined = nonTrees[0];
      if (!victim && d >= cfg.treeDeathStartDays) {
        // Only trees remain; immature trees die before mature ones.
        victim = living
          .filter((p) => p.category === "tree")
          .sort((a, b) => a.maturity - b.maturity || a.id.localeCompare(b.id))[0];
      }
      if (victim && living.length > 1) {
        killPlant(snapshot, victim, date, emit);
      } else if (victim && d >= cfg.treeDeathStartDays + 30) {
        // The very last plant only dies after a truly prolonged absence.
        killPlant(snapshot, victim, date, emit);
      }
    }
  }
}

function killPlant(
  snapshot: GardenSnapshot,
  plant: GardenPlant,
  date: LocalDate,
  emit: (e: Omit<GardenEvent, "id" | "date" | "seq" | "simulationVersion">) => void,
): void {
  plant.state = "dead";
  plant.health = 0;
  plant.diedAt = date;
  // Dead plants stay in the scene as habitat — history is preserved.
  plant.habitatRole =
    plant.category === "tree"
      ? pick(`habitat:${plant.id}`, ["perch", "nurse_log"] as const)
      : plant.category === "shrub"
        ? "nurse_log"
        : pick(`habitat:${plant.id}`, ["mushroom_host", "nurse_log"] as const);
  snapshot.state.lastPlantDeathDate = date;
  emit({ kind: "plant_died", plantId: plant.id, speciesId: plant.speciesId, detail: plant.habitatRole ?? undefined });
}

// ─────────────────────────────────────────────────────────────────────────────
// Unlocks, wildlife, regions, derived state

function gateSatisfied(gate: UnlockGate, snapshot: GardenSnapshot): boolean {
  const s = snapshot.state;
  switch (gate.kind) {
    case "start":
      return true;
    case "quality_runs":
      return s.qualityRunCount >= gate.count;
    case "easy_runs":
      return s.easyRunCount >= gate.count;
    case "long_runs":
      return s.longRunCount >= gate.count;
    case "recovery_runs":
      return s.recoveryRunCount >= gate.count;
    case "consistent_weeks":
      return s.consecutiveConsistentWeeks >= gate.count;
    case "mature_trees":
      return matureTreeCount(snapshot) >= gate.count;
    case "comeback":
      return s.inComeback || s.comebackStreak > 0;
    case "dead_wood":
      return snapshot.plants.some((p) => p.state === "dead" && p.habitatRole);
  }
}

function evaluateUnlocks(
  snapshot: GardenSnapshot,
  _date: LocalDate,
  emit: (e: Omit<GardenEvent, "id" | "date" | "seq" | "simulationVersion">) => void,
): void {
  for (const species of SPECIES) {
    if (snapshot.unlockedSpeciesIds.includes(species.id)) continue;
    if (gateSatisfied(species.unlock, snapshot)) {
      snapshot.unlockedSpeciesIds.push(species.id);
      emit({ kind: "species_unlocked", speciesId: species.id });
    }
  }
}

function matureTreeCount(snapshot: GardenSnapshot): number {
  return livingPlants(snapshot.plants).filter((p) => p.category === "tree" && p.maturity >= 0.7)
    .length;
}

function evaluateWildlife(
  snapshot: GardenSnapshot,
  cfg: GardenConfig,
  emit: (e: Omit<GardenEvent, "id" | "date" | "seq" | "simulationVersion">) => void,
): void {
  const s = snapshot.state;
  const living = livingPlants(snapshot.plants);
  const bloomingSpecies = new Set(
    living.filter((p) => p.state === "flowering").map((p) => p.speciesId),
  );
  const floweringSpecies = new Set(
    living
      .filter((p) => speciesOrThrow(p.speciesId).flowers && p.maturity >= 0.7)
      .map((p) => p.speciesId),
  );
  const inDecline = s.daysSinceCompletedRun >= cfg.dormancyStartDays || s.restMode;

  const desired: Record<WildlifeKind, boolean> = {
    birds: !inDecline && matureTreeCount(snapshot) >= 2 && s.canopy >= 0.25,
    bees: !inDecline && floweringSpecies.size >= 3 && bloomingSpecies.size >= 1,
    butterflies: !inDecline && s.biodiversity >= 0.5,
    fireflies:
      !inDecline &&
      s.eveningRunCount >= 10 &&
      (matureTreeCount(snapshot) >= 1 || floweringSpecies.size >= 2),
    // Earned by an increasingly rich ecosystem.
    squirrels: !inDecline && matureTreeCount(snapshot) >= 1,
    rabbits:
      !inDecline &&
      s.moisture > 0.6 &&
      living.some((p) => p.category === "groundcover" || p.category === "grass"),
    frogs: !inDecline && s.moisture > 0.5 && living.some((p) => p.category === "fern"),
    dragonflies: !inDecline && s.floweringDensity >= 0.3,
    ladybugs: !inDecline && bloomingSpecies.size >= 1,
  };

  for (const kind of Object.keys(desired) as WildlifeKind[]) {
    if (desired[kind] && !snapshot.wildlife[kind]) {
      snapshot.wildlife[kind] = true;
      emit({ kind: "wildlife_arrived", wildlifeId: kind });
    } else if (!desired[kind] && snapshot.wildlife[kind]) {
      snapshot.wildlife[kind] = false;
      emit({ kind: "wildlife_departed", wildlifeId: kind });
    }
  }
}

function evaluateRegions(
  snapshot: GardenSnapshot,
  cfg: GardenConfig,
  emit: (e: Omit<GardenEvent, "id" | "date" | "seq" | "simulationVersion">) => void,
): void {
  const living = livingPlants(snapshot.plants).length;
  const capacity = snapshot.state.unlockedRegions * cfg.regionCapacity;
  if (living > capacity * 0.75 && snapshot.state.unlockedRegions < cfg.maxRegions) {
    snapshot.state.unlockedRegions += 1;
    emit({ kind: "region_unlocked", detail: String(snapshot.state.unlockedRegions) });
  }
}

function recomputeDerived(snapshot: GardenSnapshot): void {
  const s = snapshot.state;
  const living = livingPlants(snapshot.plants);
  const speciesCount = new Set(living.map((p) => p.speciesId)).size;
  s.biodiversity = Math.min(1, speciesCount / 20);
  s.canopy = Math.min(1, matureTreeCount(snapshot) * 0.15);
  const floweringCapable = living.filter((p) => speciesOrThrow(p.speciesId).flowers);
  const inBloom = floweringCapable.filter((p) => p.state === "flowering");
  s.floweringDensity =
    floweringCapable.length === 0 ? 0 : inBloom.length / Math.max(6, floweringCapable.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Replay

export function replay(
  createdDate: LocalDate,
  days: GardenDayInput[],
  cfg: GardenConfig = DEFAULT_GARDEN_CONFIG,
): { snapshot: GardenSnapshot; events: GardenEvent[] } {
  let snapshot = initialSnapshot(createdDate);
  const events: GardenEvent[] = [];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of sorted) {
    const result = simulateDay(snapshot, day, cfg);
    snapshot = result.snapshot;
    events.push(...result.events);
  }
  return { snapshot, events };
}

export { conditionWord } from "./condition.js";
