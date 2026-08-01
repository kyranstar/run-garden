import { and, eq, gte } from "drizzle-orm";
import { llmUsage, weeklyReviews } from "@rg/database";
import { fingerprint, newId, nowInstant } from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "./db.js";

/**
 * The only place the app talks to an LLM. Routed through the Vercel AI Gateway
 * (OpenAI-compatible endpoint) so the same key serves other projects; the model
 * is a Haiku-class Claude model behind the gateway. Constraints (product spec):
 *  - server-side only, structured input (deterministic facts, never raw streams)
 *  - token ceiling, timeout, at most one retry
 *  - cached by input fingerprint, cost recorded, hard weekly budget
 *  - the app remains fully useful with AI disabled or over budget
 * Strava-derived fields are deliberately excluded from LLM inputs
 * (Strava API agreement caution — see docs/research/strava-api.md).
 */

const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
const DEFAULT_GATEWAY = "https://ai-gateway.vercel.sh/v1";
// Haiku-class pricing; the gateway adds a small margin but the $8 rolling
// cutoff protects regardless. Slight over-estimate is intentionally safe.
const INPUT_MICROS_PER_TOKEN = 1; // ≈ $1 / 1M input tokens
const OUTPUT_MICROS_PER_TOKEN = 5; // ≈ $5 / 1M output tokens
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
  const model = env.AI_GATEWAY_MODEL || DEFAULT_MODEL;

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
        .set({ facts: input.facts, narrative, llmModel: narrative ? model : null, llmCostMicros })
        .where(eq(weeklyReviews.id, existing[0].id));
    } else {
      await db.insert(weeklyReviews).values({
        id: newId(),
        userId,
        weekStart: input.weekStart,
        facts: input.facts,
        narrative,
        llmModel: narrative ? model : null,
        llmCostMicros,
        createdAt: now,
      });
    }
  };

  if (!aiEnabled) {
    await persist(null, null);
    return { narrative: null, cached: false, reason: "ai_disabled" };
  }
  if (!env.AI_GATEWAY_API_KEY) {
    await persist(null, null);
    return { narrative: null, cached: false, reason: "no_api_key" };
  }
  const budget = await llmBudgetStatus(db, userId);
  if (budget.cutoff) {
    await persist(null, null);
    return { narrative: null, cached: false, reason: "budget_cutoff" };
  }

  const system = [
    "You turn a runner's weekly training facts into a short, calm review.",
    "Structure: 1) What happened. 2) What went well. 3) What changed.",
    "4) One useful thing to notice. 5) What changed in the garden.",
    "Hard rules: maximum 200 words total. Use ONLY numbers and facts present",
    "in the provided JSON — never invent metrics, diagnoses, causal",
    "explanations, training-plan changes, or injury advice. Neutral,",
    "encouraging tone without hype. Moving a workout is not a failure.",
    'Reply with ONLY a JSON object of the form {"narrative": "..."} and nothing else.',
  ].join(" ");

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${env.AI_GATEWAY_BASE_URL || DEFAULT_GATEWAY}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${env.AI_GATEWAY_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: `Weekly training facts (JSON):\n${JSON.stringify(input.facts, null, 2)}`,
            },
          ],
          response_format: { type: "json_object" },
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      await persist(null, null);
      return { narrative: null, cached: false, reason: `gateway_${response.status}` };
    }

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const inputTokens = body.usage?.prompt_tokens ?? 0;
    const outputTokens = body.usage?.completion_tokens ?? 0;
    const costMicros = Math.ceil(
      inputTokens * INPUT_MICROS_PER_TOKEN + outputTokens * OUTPUT_MICROS_PER_TOKEN,
    );
    await db.insert(llmUsage).values({
      id: newId(),
      userId,
      kind: "weekly_review",
      model,
      inputTokens,
      outputTokens,
      costMicros,
      cacheHit: false,
      requestFingerprint: factsFingerprint,
      createdAt: now,
    });

    let narrative: string | null = null;
    const raw = body.choices?.[0]?.message?.content ?? "";
    if (raw) {
      try {
        // Tolerate a fenced ```json block or leading prose.
        const jsonText = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
        const start = jsonText.indexOf("{");
        const end = jsonText.lastIndexOf("}");
        const slice = start >= 0 && end > start ? jsonText.slice(start, end + 1) : jsonText;
        const parsed = JSON.parse(slice) as { narrative?: string };
        if (typeof parsed.narrative === "string" && parsed.narrative.trim().length > 0) {
          narrative = parsed.narrative.trim();
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
