import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const computedMetrics = sqliteTable(
  "computed_metrics",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    metricKey: text("metric_key").notNull(),
    computedAt: text("computed_at").notNull(),
    inputFingerprint: text("input_fingerprint").notNull(),
    status: text("status").notNull(), // ok | insufficient_data
    sampleSize: integer("sample_size"),
    value: text("value", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex("metrics_key_unique").on(t.userId, t.metricKey)],
);

export const motivationEvidence = sqliteTable(
  "motivation_evidence",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    cardId: text("card_id").notNull(),
    text: text("text").notNull(),
    sampleNote: text("sample_note"),
    createdAt: text("created_at").notNull(),
    dismissedAt: text("dismissed_at"),
  },
  (t) => [uniqueIndex("evidence_card_unique").on(t.userId, t.cardId)],
);

export const weeklyReviews = sqliteTable(
  "weekly_reviews",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    weekStart: text("week_start").notNull(),
    facts: text("facts", { mode: "json" }).notNull().$type<Record<string, unknown>>(),
    narrative: text("narrative"),
    llmModel: text("llm_model"),
    llmCostMicros: integer("llm_cost_micros"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("weekly_reviews_unique").on(t.userId, t.weekStart)],
);

export const dismissedInsights = sqliteTable(
  "dismissed_insights",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    cardId: text("card_id").notNull(),
    dismissedAt: text("dismissed_at").notNull(),
  },
  (t) => [uniqueIndex("dismissed_unique").on(t.userId, t.cardId)],
);

export const llmUsage = sqliteTable(
  "llm_usage",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(), // weekly_review | metric_explanation | workout_summary | studio_generate | studio_edit
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costMicros: integer("cost_micros").notNull(),
    cacheHit: integer("cache_hit", { mode: "boolean" }).notNull().default(false),
    requestFingerprint: text("request_fingerprint"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("llm_usage_time_idx").on(t.userId, t.createdAt)],
);
