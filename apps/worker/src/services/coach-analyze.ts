import { and, desc, eq, sql } from "drizzle-orm";
import { coachMessages } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import type { Env } from "../env.js";
import type { Db } from "./db.js";
import { llmBudgetStatus } from "./llm.js";
import { chatCompletion, DEFAULT_MODEL_STRONG, recordUsage } from "./studio-llm.js";
import { buildEffortPackage } from "./coach-effort.js";

/**
 * Trigger-only effort analysis (effort-analysis spec §§4–5): ONE completed
 * effort → one short encouraging read. Strictly read-only — no proposals, no
 * memory writes, no questions; the result is an ordinary coach message keyed
 * to the activity so it caches and shows in the thread.
 */

const MAX_OUTPUT_TOKENS_ANALYSIS = 16_000; // ~140-word answer; cap never meant to be hit

export const ANALYSIS_SYSTEM_PROMPT = `You are the athlete's running/strength coach, reading ONE completed effort. This is a post-workout debrief, not a planning session: you cannot change the plan, save notes, or ask questions — just give your read.

Shape (~140 words, plain prose, no headers or bullet lists):
1. One-line verdict on the effort.
2. Two or three observations, each citing a specific number from the package (pace, HR, cadence, zone time, split, temperature…).
3. At most TWO concrete next-time improvements — small and doable, not a lecture. Skip them entirely if nothing is genuinely worth changing.
4. Close with one earned, specific encouragement tied to something they actually did.

Honesty rules:
- Never invent data. If something is unknown in the package, it is unknown — say so plainly if it matters, otherwise leave it out.
- Conditions come before conclusions: heat, humidity, and hills explain elevated HR or slow pace before fitness does. Credit them.
- No cardiac-drift claims unless duration and temperature actually support them.
- A rough day gets context, never judgment. You are encouraging because you are honest, not instead of it.
- HISTORY and MEMORY are context for comparison — reference them when they sharpen the read.
- At most one light garden reference, and only if it lands naturally.

Reply with the analysis text only — no JSON, no preamble.`;

export interface AnalyzeResult {
  status: "ok" | "cached" | "resting" | "error" | "not_found";
  message?: { id: string; body: string; at: string };
}

async function cachedAnalysis(
  db: Db,
  userId: string,
  activityId: string,
): Promise<{ id: string; body: string; at: string } | undefined> {
  const [row] = await db
    .select()
    .from(coachMessages)
    .where(
      and(
        eq(coachMessages.userId, userId),
        sql`json_extract(${coachMessages.refs}, '$.activityId') = ${activityId}`,
        sql`json_extract(${coachMessages.refs}, '$.kind') = 'analysis'`,
      ),
    )
    .orderBy(desc(coachMessages.at))
    .limit(1);
  return row ? { id: row.id, body: row.body, at: row.at } : undefined;
}

export async function analyzeEffort(
  db: Db,
  env: Env,
  userId: string,
  activityId: string,
  force = false,
  fetchImpl: typeof fetch = fetch,
): Promise<AnalyzeResult> {
  if (!force) {
    const cached = await cachedAnalysis(db, userId, activityId);
    if (cached) return { status: "cached", message: cached };
  }

  const pkg = await buildEffortPackage(db, userId, activityId);
  if (!pkg) return { status: "not_found" };

  // User-triggered, so the budget stop is loud, not silent (spec §5).
  const budget = await llmBudgetStatus(db, userId);
  if (budget.cutoff) return { status: "resting" };

  const model = env.AI_STUDIO_MODEL_STRONG || DEFAULT_MODEL_STRONG;
  const chat = await chatCompletion(env, fetchImpl, model, MAX_OUTPUT_TOKENS_ANALYSIS, [
    { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
    { role: "user", content: pkg.text },
  ]);
  if (!chat.ok) return { status: "error" };
  await recordUsage(db, userId, "coach_analysis", model, "strong", chat, `analysis:${activityId}:${nowInstant()}`);

  const body = chat.content.trim();
  if (!body) return { status: "error" };
  const id = newId();
  const at = nowInstant();
  await db.insert(coachMessages).values({
    id,
    userId,
    role: "coach",
    body,
    refs: { kind: "analysis", activityId },
    at,
  });
  return { status: "ok", message: { id, body, at } };
}
