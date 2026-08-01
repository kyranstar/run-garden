import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte } from "drizzle-orm";
import { llmUsage, weeklyReviews } from "@rg/database";
import { fingerprint, newId, nowInstant } from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "./db.js";

/**
 * The only place the app talks to an LLM. Constraints (product spec):
 *  - server-side only, structured input (deterministic facts, never raw streams)
 *  - Haiku-class model, token ceiling, timeout, at most one retry
 *  - cached by input fingerprint, cost recorded, hard weekly budget
 *  - the app remains fully useful with AI disabled or over budget
 * Strava-derived fields are deliberately excluded from LLM inputs
 * (Strava API agreement caution — see docs/research/strava-api.md).
 */

const MODEL = "claude-haiku-4-5";
const INPUT_MICROS_PER_TOKEN = 1; // $1 / 1M tokens
const OUTPUT_MICROS_PER_TOKEN = 5; // $5 / 1M tokens
const MAX_OUTPUT_TOKENS = 400;
const TIMEOUT_MS = 20_000;

export const LLM_BUDGET = {
  warnMicros: 2_000_000, // $2 / rolling 7 days
  cutoffMicros: 8_000_000, // $8 — AI calls disabled automatically
  absoluteMaxMicros: 10_000_000, // $10 — never exceeded
};

export interface LlmBudgetStatus {
  spentMicros: number;
  warn: boolean;
  cutoff: boolean;
}

export async function llmBudgetStatus(db: Db, userId: string): Promise<LlmBudgetStatus> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const rows = await db
    .select({ costMicros: llmUsage.costMicros })
    .from(llmUsage)
    .where(and(eq(llmUsage.userId, userId), gte(llmUsage.createdAt, since)));
  const spentMicros = rows.reduce((sum, r) => sum + r.costMicros, 0);
  return {
    spentMicros,
    warn: spentMicros >= LLM_BUDGET.warnMicros,
    cutoff: spentMicros >= LLM_BUDGET.cutoffMicros,
  };
}

export interface WeeklyReviewFactsInput {
  weekStart: string;
  facts: Record<string, unknown>;
}

/**
 * Generate the weekly narrative from deterministic facts. Returns null (and
 * stores facts without narrative) whenever AI is unavailable — never throws
 * into the caller's sync path.
 */
export async function generateWeeklyReview(
  db: Db,
  env: Env,
  userId: string,
  input: WeeklyReviewFactsInput,
  aiEnabled: boolean,
): Promise<{ narrative: string | null; cached: boolean; reason?: string }> {
  const now = nowInstant();
  const factsFingerprint = fingerprint(input.facts);

  const existing = await db
    .select()
    .from(weeklyReviews)
    .where(and(eq(weeklyReviews.userId, userId), eq(weeklyReviews.weekStart, input.weekStart)))
    .limit(1);

  // Cache: same facts already narrated → reuse.
  if (existing[0]?.narrative && fingerprint(existing[0].facts) === factsFingerprint) {
    return { narrative: existing[0].narrative, cached: true };
  }

  const persist = async (narrative: string | null, llmCostMicros: number | null): Promise<void> => {
    if (existing[0]) {
      await db
        .update(weeklyReviews)
        .set({ facts: input.facts, narrative, llmModel: narrative ? MODEL : null, llmCostMicros })
        .where(eq(weeklyReviews.id, existing[0].id));
    } else {
      await db.insert(weeklyReviews).values({
        id: newId(),
        userId,
        weekStart: input.weekStart,
        facts: input.facts,
        narrative,
        llmModel: narrative ? MODEL : null,
        llmCostMicros,
        createdAt: now,
      });
    }
  };

  if (!aiEnabled) {
    await persist(null, null);
    return { narrative: null, cached: false, reason: "ai_disabled" };
  }
  if (!env.ANTHROPIC_API_KEY) {
    await persist(null, null);
    return { narrative: null, cached: false, reason: "no_api_key" };
  }
  const budget = await llmBudgetStatus(db, userId);
  if (budget.cutoff) {
    await persist(null, null);
    return { narrative: null, cached: false, reason: "budget_cutoff" };
  }

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    timeout: TIMEOUT_MS,
    maxRetries: 1,
  });

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [
        "You turn a runner's weekly training facts into a short, calm review.",
        "Structure: 1) What happened. 2) What went well. 3) What changed.",
        "4) One useful thing to notice. 5) What changed in the garden.",
        "Hard rules: maximum 200 words total. Use ONLY numbers and facts present",
        "in the provided JSON — never invent metrics, diagnoses, causal",
        "explanations, training-plan changes, or injury advice. Neutral,",
        "encouraging tone without hype. Moving a workout is not a failure.",
      ].join(" "),
      messages: [
        {
          role: "user",
          content: `Weekly training facts (JSON):\n${JSON.stringify(input.facts, null, 2)}`,
        },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { narrative: { type: "string" } },
            required: ["narrative"],
            additionalProperties: false,
          },
        },
      },
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const costMicros = Math.ceil(
      inputTokens * INPUT_MICROS_PER_TOKEN + outputTokens * OUTPUT_MICROS_PER_TOKEN,
    );
    await db.insert(llmUsage).values({
      id: newId(),
      userId,
      kind: "weekly_review",
      model: MODEL,
      inputTokens,
      outputTokens,
      costMicros,
      cacheHit: false,
      requestFingerprint: factsFingerprint,
      createdAt: now,
    });

    let narrative: string | null = null;
    const block = response.content[0];
    if (response.stop_reason !== "refusal" && block?.type === "text") {
      try {
        const parsed = JSON.parse(block.text) as { narrative?: string };
        if (typeof parsed.narrative === "string" && parsed.narrative.trim().length > 0) {
          narrative = parsed.narrative.trim();
          // Enforce the word ceiling defensively.
          const words = narrative.split(/\s+/);
          if (words.length > 220) narrative = words.slice(0, 220).join(" ") + "…";
        }
      } catch {
        narrative = null;
      }
    }
    await persist(narrative, costMicros);
    return { narrative, cached: false, reason: narrative ? undefined : "invalid_output" };
  } catch {
    // Fail harmlessly: facts are stored; the UI shows the deterministic view.
    await persist(null, null);
    return { narrative: null, cached: false, reason: "llm_error" };
  }
}
