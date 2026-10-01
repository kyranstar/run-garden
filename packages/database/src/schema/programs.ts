import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Programs — the one registry of plans (migration 0024; one-workout-system
 * spec §8.1). Additive in Phase 1: nothing reads these until Phase 2.
 */
export const programs = sqliteTable(
  "programs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** adaptive | coros_import | coach | studio (`programKindSchema`). */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    /** draft | active | completed | retired | archived (`programStatusSchema`). */
    status: text("status").notNull(),
    /** Sport disciplines the program schedules, e.g. `["strength"]`. */
    disciplines: text("disciplines", { mode: "json" }).$type<string[]>().notNull(),
    startDate: text("start_date"),
    endDate: text("end_date"),
    raceDate: text("race_date"),
    /** Kind-specific references (COROS plan id + pb_version, stamp prefix, …). */
    source: text("source", { mode: "json" }).$type<Record<string, unknown> | null>(),
    /** Validated per kind: `adaptiveConfigSchema` for adaptive programs. */
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    archivedAt: text("archived_at"),
  },
  (t) => [index("programs_user_idx").on(t.userId, t.status)],
);

export const programVersions = sqliteTable(
  "program_versions",
  {
    id: text("id").primaryKey(),
    programId: text("program_id").notNull(),
    versionNum: integer("version_num").notNull(),
    capturedAt: text("captured_at").notNull(),
    fingerprint: text("fingerprint").notNull(),
    summary: text("summary", { mode: "json" }).$type<Record<string, unknown> | null>(),
  },
  (t) => [index("program_versions_program_idx").on(t.programId)],
);

export const programBlocks = sqliteTable(
  "program_blocks",
  {
    id: text("id").primaryKey(),
    programId: text("program_id").notNull(),
    number: integer("number").notNull(),
    /** core_block | firm_week | shape_week (`blockKindSchema`). */
    kind: text("kind").notNull(),
    startDate: text("start_date").notNull(),
    weeks: integer("weeks").notNull(),
    /** `blockIntentSchema` for the row's kind. */
    intent: text("intent", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("program_blocks_number_unique").on(t.programId, t.number)],
);
