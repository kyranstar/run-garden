import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * The coach's substrate (spec: docs/superpowers/specs/2026-08-06-coach-
 * intelligence-design.md). Proposals are STATE with a strict lifecycle —
 * pending rows are the only live surface; everything else is history.
 * Memory is the single long-term knowledge store; the thread is not.
 */

/** One learned item: fact (durable), rule (standing), note (time-boxed). */
export const coachMemory = sqliteTable(
  "coach_memory",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(), // 'fact' | 'rule' | 'note'
    body: text("body").notNull(),
    provenance: text("provenance", { mode: "json" })
      .notNull()
      .$type<{ source: string; messageId?: string; at: string }>(),
    learnedAt: text("learned_at").notNull(),
    expiresAt: text("expires_at"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
  },
  (t) => [index("coach_memory_user_idx").on(t.userId, t.active)],
);

/** The never-ask-twice ledger. At most one row per user with answeredAt null. */
export const coachQuestions = sqliteTable(
  "coach_questions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    body: text("body").notNull(),
    chips: text("chips", { mode: "json" }).notNull().$type<string[]>(),
    askedAt: text("asked_at").notNull(),
    answeredAt: text("answered_at"),
    memoryId: text("memory_id"),
  },
  (t) => [index("coach_questions_user_idx").on(t.userId, t.answeredAt)],
);

/** Thread rows: coach prose, user messages, and inert receipts. */
export const coachMessages = sqliteTable(
  "coach_messages",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(), // 'coach' | 'user' | 'receipt'
    body: text("body").notNull(),
    refs: text("refs", { mode: "json" })
      .notNull()
      .$type<{ proposalId?: string; memoryIds?: string[]; questionId?: string }>(),
    at: text("at").notNull(),
  },
  (t) => [index("coach_messages_user_at_idx").on(t.userId, t.at)],
);

/** Live coach proposals + their frozen history. */
export const coachProposals = sqliteTable(
  "coach_proposals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    planId: text("plan_id"),
    title: text("title").notNull(),
    evidence: text("evidence").notNull(),
    rationale: text("rationale").notNull(),
    flags: text("flags", { mode: "json" }).notNull().$type<string[]>(),
    ops: text("ops", { mode: "json" }).notNull().$type<unknown[]>(),
    status: text("status").notNull(), // pending | approved | declined | superseded | expired
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    resolvedAt: text("resolved_at"),
    supersededBy: text("superseded_by"),
  },
  (t) => [index("coach_proposals_user_status_idx").on(t.userId, t.status)],
);

/** Deterministic trigger marks — cheap to write, consumed by the next wake. */
export const coachTriggers = sqliteTable(
  "coach_triggers",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    evidence: text("evidence", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    firedAt: text("fired_at").notNull(),
    consumedAt: text("consumed_at"),
  },
  (t) => [index("coach_triggers_user_idx").on(t.userId, t.consumedAt)],
);

/** A coached plan (either discipline); firm sessions live in plannedWorkouts. */
export const coachPlans = sqliteTable("coach_plans", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  discipline: text("discipline").notNull(), // 'run' | 'lift'
  name: text("name").notNull(),
  status: text("status").notNull(), // draft | active | completed | retired
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  raceDate: text("race_date"),
  stampPrefix: text("stamp_prefix").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Rolling detail: firm weeks are materialized; shape weeks are outlines. */
export const coachPlanWeeks = sqliteTable(
  "coach_plan_weeks",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull(),
    weekStart: text("week_start").notNull(),
    state: text("state").notNull(), // 'firm' | 'shape'
    shape: text("shape", { mode: "json" }).$type<{
      volumeTarget: string;
      keySessions: string[];
    } | null>(),
  },
  (t) => [uniqueIndex("coach_plan_weeks_unique").on(t.planId, t.weekStart)],
);
