import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Per-user exercise settings (migration 0027; one-workout-system spec §8.4,
 * §5.5). Additive in Phase 1: Phase 2 writes them.
 *
 * `userConditions` and `exercisePrefs` have a single `id` key — by convention
 * `${userId}:${profileId}` / `${userId}:${exerciseId}`, like dailyHealth —
 * plus a unique index on the pair, not a composite primary key: export,
 * restore and the copier page and match rows on one primary-key column.
 */

/** Which condition profiles a person has switched on. */
export const userConditions = sqliteTable(
  "user_conditions",
  {
    id: text("id").primaryKey(), // `${userId}:${profileId}`
    userId: text("user_id").notNull(),
    profileId: text("profile_id").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    since: text("since").notNull(),
    settings: text("settings", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [uniqueIndex("user_conditions_profile_unique").on(t.userId, t.profileId)],
);

/** Where sessions happen: the gear there and the implement weights as typed. */
export const locations = sqliteTable(
  "locations",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    /** Equipment ids available here. */
    equipment: text("equipment", { mode: "json" }).$type<string[]>().notNull(),
    /** Weights per implement id, as typed: `{ kettlebell: [{v: 10, u: "lb"}, …] }`. */
    implements: text("implements", { mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("locations_user_idx").on(t.userId)],
);

/** A person's ±1 rating, exclusion ("not for me"), pin and first-introduced date per exercise. */
export const exercisePrefs = sqliteTable(
  "exercise_prefs",
  {
    id: text("id").primaryKey(), // `${userId}:${exerciseId}`
    userId: text("user_id").notNull(),
    exerciseId: text("exercise_id").notNull(),
    /** +1 / -1; null = no rating. */
    rating: integer("rating"),
    excluded: integer("excluded", { mode: "boolean" }).notNull().default(false),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    introducedOn: text("introduced_on"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("exercise_prefs_exercise_unique").on(t.userId, t.exerciseId)],
);

/**
 * Where an exercise a person saved came from (source type, URL, creator,
 * source key). Private to the account: imported locally, never committed to
 * the public library.
 */
export const exerciseProvenance = sqliteTable(
  "exercise_provenance",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    exerciseId: text("exercise_id").notNull(),
    sourceType: text("source_type").notNull(),
    url: text("url"),
    creator: text("creator"),
    sourceKey: text("source_key"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("exercise_provenance_key_unique").on(t.userId, t.sourceType, t.sourceKey)],
);
