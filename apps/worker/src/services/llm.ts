import { and, eq, gte } from "drizzle-orm";
import { llmUsage, weeklyReviews } from "@rg/database";
import { fingerprint, newId, nowInstant, type UserPreferences } from "@rg/domain";
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
 */

const DEFAULT_MODEL = "anthropic/claude-haiku-4.5";
const DEFAULT_GATEWAY = "https://ai-gateway.vercel.sh/v1";
// Haiku-class pricing; the gateway adds a small margin but the $8 rolling
// cutoff protects regardless. Slight over-estimate is intentionally safe.
const INPUT_MICROS_PER_TOKEN = 1; // ≈ $1 / 1M input tokens
const OUTPUT_MICROS_PER_TOKEN = 5; // ≈ $5 / 1M output tokens
// Generous headroom — the prompt caps the narrative at 200 words, but the
// cap exists to never be hit, and Haiku output costs $5/1M tokens.
const MAX_OUTPUT_TOKENS = 2000;
const TIMEOUT_MS = 20_000;

export const LLM_BUDGET = {
  warnMicros: 5_000_000, // $5 / rolling 7 days
  // $20 — the coach-era posture (2026-08-06 intelligence spec §0): a guard
  // rail that exists to never be hit, not a target. AI disables itself here.
  cutoffMicros: 20_000_000,
  absoluteMaxMicros: 25_000_000, // never exceeded
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

type Units = UserPreferences["units"];

export interface WeeklyReviewFactsInput {
  weekStart: string;
  facts: Record<string, unknown>;
  /** The athlete's display-unit preference. Stored facts stay metric; the
   * prose is written in these units (units sweep 2026-08-14). */
  units: Units;
}

const METERS_PER_MILE = 1609.344;
const round1 = (n: number): number => Math.round(n * 10) / 10;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** "kilometres" / "miles" — the word the narrative must use, spelled out so
 * the model never has to pick between "km"/"K"/"kilometer". */
export function distanceUnitName(units: Units): string {
  return units === "mi" ? "miles" : "kilometres";
}

/**
 * The facts as the MODEL sees them. Models are unreliable at arithmetic, so
 * it never gets a figure it would have to convert: the metric raw values
 * (`totalDistanceMeters`, `totalDurationSeconds`) are replaced by numbers
 * already in the athlete's own units, alongside the unit's name. Everything
 * else passes through untouched.
 *
 * The METRIC facts are still what gets persisted — this shape exists only
 * for the prompt, so a stored review stays canonical and re-narratable.
 */
export function narrationFacts(
  facts: Record<string, unknown>,
  units: Units,
): Record<string, unknown> {
  const { totalDistanceMeters, totalDurationSeconds, ...rest } = facts;
  const meters = num(totalDistanceMeters);
  const seconds = num(totalDurationSeconds);
  return {
    ...rest,
    distanceUnit: distanceUnitName(units),
    ...(meters === null
      ? {}
      : { totalDistance: round1(units === "mi" ? meters / METERS_PER_MILE : meters / 1000) }),
    ...(seconds === null ? {} : { totalHours: round1(seconds / 3600) }),
  };
}

/** Pure so the units instruction is testable without a gateway call. */
export function buildWeeklyReviewSystemPrompt(units: Units): string {
  return [
    "You turn a runner's weekly training facts into a short, calm review.",
    "Structure: 1) What happened. 2) What went well. 3) What changed.",
    "4) One useful thing to notice. 5) What changed in the garden.",
    "Hard rules: maximum 200 words total. Use ONLY numbers and facts present",
    "in the provided JSON — never invent metrics, diagnoses, causal",
    "explanations, training-plan changes, or injury advice. Neutral,",
    "encouraging tone without hype. Moving a workout is not a failure.",
    // The athlete reads one unit system, everywhere. Every figure below is
    // ALREADY in it — the model must never convert, because a converted
    // number is an invented one.
    `This athlete reads distances in ${distanceUnitName(units)}. \`totalDistance\` is already`,
    `in ${distanceUnitName(units)} and \`totalHours\` is already in hours — quote them as given,`,
    `name the unit as "${distanceUnitName(units)}", and never convert or recompute a number.`,
    'Reply with ONLY a JSON object of the form {"narrative": "..."} and nothing else.',
  ].join(" ");
}

/**
 * Generate the weekly narrative from deterministic facts. Returns null (and
 * stores facts without narrative) whenever AI is unavailable — never throws
 * into the caller's sync path.
 *
 * `fetchImpl` follows studio-llm.ts's injection seam (no `vi.stubGlobal`
 * anywhere in this repo) so what actually reaches the gateway is assertable.
 */
export async function generateWeeklyReview(
  db: Db,
  env: Env,
  userId: string,
  input: WeeklyReviewFactsInput,
  aiEnabled: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<{ narrative: string | null; cached: boolean; reason?: string }> {
  const now = nowInstant();
  // `units` rides in the STORED facts so the cache key covers it: the same
  // week narrated in kilometres must not be served back after the athlete
  // switches to miles. Rows written before the sweep carry no `units` key,
  // so they simply miss and re-narrate on their next weekly run — no
  // backfill, and historical prose is left exactly as it was.
  const storedFacts: Record<string, unknown> = { ...input.facts, units: input.units };
  const factsFingerprint = fingerprint(storedFacts);
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
        .set({ facts: storedFacts, narrative, llmModel: narrative ? model : null, llmCostMicros })
        .where(eq(weeklyReviews.id, existing[0].id));
    } else {
      await db.insert(weeklyReviews).values({
        id: newId(),
        userId,
        weekStart: input.weekStart,
        facts: storedFacts,
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

  const system = buildWeeklyReviewSystemPrompt(input.units);
  const promptFacts = narrationFacts(input.facts, input.units);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${env.AI_GATEWAY_BASE_URL || DEFAULT_GATEWAY}/chat/completions`, {
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
              content: `Weekly training facts (JSON):\n${JSON.stringify(promptFacts, null, 2)}`,
            },
          ],
          // No response_format: the Vercel AI Gateway's chat-completions
          // surface only supports json_schema / legacy json — the OpenAI
          // json_object mode is rejected with a 400 (live-verified via
          // sync_runs: every call since launch failed with gateway_400).
          // The system prompt demands JSON-only and extraction tolerates
          // prose/fences, so prompt discipline carries it.
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Surface the gateway's own error message in `wrangler tail` — a bare
      // status code turned out to be undebuggable from the outside.
      const detail = await response.text().catch(() => "");
      console.warn(
        JSON.stringify({
          level: "warn",
          msg: "llm: ai gateway error",
          status: response.status,
          model,
          detail: detail.slice(0, 600),
        }),
      );
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
