import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Current snapshot (authoritative for rendering; rebuilt by replay if lost). */
export const gardenState = sqliteTable("garden_state", {
  userId: text("user_id").primaryKey(),
  snapshot: text("snapshot", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
  simulationVersion: integer("simulation_version").notNull(),
  lastSimulatedDate: text("last_simulated_date").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Queryable projection of the plants inside the snapshot. */
export const gardenPlants = sqliteTable(
  "garden_plants",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    speciesId: text("species_id").notNull(),
    category: text("category").notNull(),
    plantedAt: text("planted_at").notNull(),
    sourceWorkoutId: text("source_workout_id"),
    health: real("health").notNull(),
    hydration: real("hydration").notNull(),
    maturity: real("maturity").notNull(),
    bloomProgress: real("bloom_progress").notNull(),
    state: text("state").notNull(),
    posX: real("pos_x").notNull(),
    posY: real("pos_y").notNull(),
    region: integer("region").notNull(),
    hostPlantId: text("host_plant_id"),
    diedAt: text("died_at"),
    habitatRole: text("habitat_role"),
  },
  (t) => [index("garden_plants_user_idx").on(t.userId)],
);

/** Immutable event log (source of truth for replay). */
export const gardenEvents = sqliteTable(
  "garden_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    date: text("date").notNull(),
    seq: integer("seq").notNull(),
    workoutId: text("workout_id"),
    activityId: text("activity_id"),
    workoutCategory: text("workout_category"),
    plantId: text("plant_id"),
    speciesId: text("species_id"),
    wildlifeId: text("wildlife_id"),
    detail: text("detail"),
    simulationVersion: integer("simulation_version").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("garden_events_unique").on(t.userId, t.date, t.seq),
    index("garden_events_date_idx").on(t.userId, t.date),
  ],
);

/** Species catalog projection (the catalog itself lives in code). */
export const gardenSpecies = sqliteTable("garden_species", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  rarity: text("rarity").notNull(),
  archetype: text("archetype").notNull(),
  catalogVersion: integer("catalog_version").notNull(),
});

export const gardenUnlocks = sqliteTable(
  "garden_unlocks",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    speciesId: text("species_id").notNull(),
    unlockedOn: text("unlocked_on").notNull(),
  },
  (t) => [uniqueIndex("unlocks_unique").on(t.userId, t.speciesId)],
);

export const gardenWildlife = sqliteTable(
  "garden_wildlife",
  {
    id: text("id").primaryKey(), // `${userId}:${kind}`
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    present: integer("present", { mode: "boolean" }).notNull(),
    since: text("since"),
  },
  (t) => [uniqueIndex("wildlife_unique").on(t.userId, t.kind)],
);

/** Renderer/layout versioning for scene migrations. */
export const gardenSceneLayouts = sqliteTable("garden_scene_layouts", {
  userId: text("user_id").primaryKey(),
  layoutVersion: integer("layout_version").notNull(),
  rendererVersion: text("renderer_version"),
  updatedAt: text("updated_at").notNull(),
});

/** Periodic checkpoints so long histories replay fast. */
export const gardenSnapshots = sqliteTable(
  "garden_snapshots",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    date: text("date").notNull(),
    snapshot: text("snapshot", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    simulationVersion: integer("simulation_version").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("garden_snapshots_unique").on(t.userId, t.date)],
);

/** Resolved day inputs fed to the simulation (auditable, replayable). */
export const gardenDayInputs = sqliteTable(
  "garden_day_inputs",
  {
    id: text("id").primaryKey(), // `${userId}:${date}`
    userId: text("user_id").notNull(),
    date: text("date").notNull(),
    input: text("input", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("garden_day_inputs_unique").on(t.userId, t.date)],
);
