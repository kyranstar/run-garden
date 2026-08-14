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
      .$type<{
        proposalId?: string;
        memoryIds?: string[];
        questionId?: string;
        kind?: "analysis";
        activityId?: string;
        /** The race narrative line (race hub 2026-08-14) — the race-scale
         * sibling of `focus` below. */
        raceLine?: string;
        /** Marks an inert "couldn't think" / "resting" receipt so the wake
         * pipeline can dedupe consecutive failures and back off wakeAdvised
         * without a fragile body-text match. */
        wakeFailure?: boolean;
        /** The briefing's one action line (rework spec §3) — surfaced on the
         * plan page's weekly brief. */
        focus?: string;
      }>(),
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

/** The perception ledger: exactly one LLM read per activity (rework spec §1).
 * Reads live HERE, not in coach_messages — an analysis stored as a coach
 * message resets the briefing-staleness clock and crowds the thread/dossier. */
export const coachReads = sqliteTable(
  "coach_reads",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** Activity id, or `digest:<backfillRunId>` for a backfill batch digest. */
    activityId: text("activity_id").notNull(),
    status: text("status").notNull(), // queued | running | done | failed | skipped
    attempt: integer("attempt").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    claimToken: text("claim_token"),
    claimedAt: text("claimed_at"),
    glance: text("glance"),
    body: text("body"),
    flags: text("flags", { mode: "json" }).notNull().$type<string[]>(),
    model: text("model"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => [
    uniqueIndex("coach_reads_user_activity_unique").on(t.userId, t.activityId),
    index("coach_reads_user_status_idx").on(t.userId, t.status, t.nextAttemptAt),
  ],
);

/** Single-flight claims for per-user LLM work (rework spec R2): claim by
 * stamping a fresh token, then read back and check the token is yours. */
export const coachLocks = sqliteTable(
  "coach_locks",
  {
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(), // 'wake'
    token: text("token").notNull(),
    claimedAt: text("claimed_at").notNull(),
  },
  (t) => [uniqueIndex("coach_locks_user_kind_unique").on(t.userId, t.kind)],
);

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
