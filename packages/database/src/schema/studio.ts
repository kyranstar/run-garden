import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Plan Studio tables (spec docs/superpowers/specs/2026-08-03-plan-studio-design.md §2).
 * The repo's first schema addition since the 0000 baseline migration.
 */

export const studioPlans = sqliteTable(
  "studio_plans",
  {
    id: text("id").primaryKey(),
    // Not in the spec's terse field list, but every other user-owned table in
    // this schema carries userId (see trainingPlans, activities, ...); without
    // it a second user's plan would collide with or overwrite the first's.
    userId: text("user_id").notNull(),
    brief: text("brief", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    plan: text("plan", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    /** Bumped on every accepted edit (generate = 1, each applied edit +1). */
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("studio_plans_user_idx").on(t.userId)],
);

export const studioPlanPushes = sqliteTable(
  "studio_plan_pushes",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    /** LocalDate the session is pushed onto. */
    happenDay: text("happen_day").notNull(),
    /** The stamp: session workout name as written to COROS, recorded before push. */
    sessionTitle: text("session_title").notNull(),
    corosIdInPlan: text("coros_id_in_plan"),
    corosProgramId: text("coros_program_id"),
    corosEntityId: text("coros_entity_id"),
    status: text("status").notNull().default("pending"), // pending | verified | failed | deleted
    error: text("error"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    index("studio_plan_pushes_plan_idx").on(t.planId),
    // The read-after-write verify identity triple (spec §5): plan + day + stamp.
    uniqueIndex("studio_plan_pushes_stamp_unique").on(t.planId, t.happenDay, t.sessionTitle),
  ],
);

export const corosExercises = sqliteTable(
  "coros_exercises",
  {
    /** originId — stable across the whole COROS catalog, not per-user. */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    raw: text("raw", { mode: "json" }).$type<Record<string, unknown>>(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("coros_exercises_updated_idx").on(t.updatedAt)],
);
