/**
 * THE OUTPUT CEILING AND THE WEEK'S CUTOFF (R1; DESIGN-3 §3.8; the lead's v0.20 ruling: "32k is a ceiling, not never
 * truncate… keep the $20 cutoff; no automatic increase").
 *
 * Pinned: every role's call asks for at most 32,000 output tokens, and a new run keeps that ceiling in its settings; the
 * worst case a call reserves before it is made is what 32,000 output tokens and its prompt cost at the design model's price
 * (about $0.80 of output) — and a call is admitted only while that worst case fits under the $20 cutoff, which stays
 * $20 (warn $5, never past $25); the per-run ceilings stay $1.50 for one workout and $10 for a set; the step caps bound the
 * retries of a cut-off step (12, 10, 3 calls) and a failed call's (3). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { COACH_CEILING_DEFAULTS_USD } from "@rg/domain";
import { MAX_RETRIES, newRunState, RUN_CEILING_MICROS } from "../src/services/coach-runs.js";
import { MAX_OUTPUT_TOKENS, RUN_LIMITS } from "../src/services/design-limits.js";
import { designModel, messagesCostMicros } from "../src/services/llm-messages.js";
import { LLM_BUDGET } from "../src/services/llm.js";

describe("the output ceiling", () => {
  it("is 32,000 per call for every role, and a new run keeps it", () => {
    expect(MAX_OUTPUT_TOKENS).toBe(32_000);
    for (const role of ["main", "designer", "reviewer"] as const) expect([role, RUN_LIMITS[role].maxTokens]).toEqual([role, 32_000]);
    expect(newRunState("main", { kind: "later_today" }, {}).settings.maxTokens).toBe(32_000);
    // The step caps bound how far a cut-off step goes on, and a failed call's retries are three.
    expect([RUN_LIMITS.main.maxCalls, RUN_LIMITS.designer.maxCalls, MAX_RETRIES]).toEqual([12, 10, 3]);
  });

  it("a call's worst case — 32,000 output tokens — fits the $20 cutoff with room, and the cutoff stays $20", () => {
    const model = designModel({} as never);
    const output = messagesCostMicros(model, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 32_000 });
    // About $0.80 at the design model's output price: twice 16,000's, still a small part of the week.
    expect(output).toBe(2 * messagesCostMicros(model, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 16_000 }));
    expect(output).toBeLessThanOrEqual(1_000_000);
    expect(LLM_BUDGET).toEqual({ warnMicros: 5_000_000, cutoffMicros: 20_000_000, absoluteMaxMicros: 25_000_000 });
    // Near the cutoff a call is admitted only when its worst case fits: at $19.50 spent, one more 32k call with a large
    // prompt does not.
    const prompt = 100_000;
    const worst = messagesCostMicros(model, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: prompt, outputTokens: 32_000 });
    expect(19_500_000 + worst).toBeGreaterThan(LLM_BUDGET.cutoffMicros);
  });

  it("the per-run ceilings are unchanged: $1.50 for one workout, $10 for a set", () => {
    expect(COACH_CEILING_DEFAULTS_USD.day).toBe(1.5);
    expect(COACH_CEILING_DEFAULTS_USD.set).toBe(10);
    expect([RUN_CEILING_MICROS.now, RUN_CEILING_MICROS.later_today, RUN_CEILING_MICROS.week]).toEqual([1_500_000, 1_500_000, 10_000_000]);
  });
});
