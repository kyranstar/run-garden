/** The words a plan's sheet says of it (plans with a purpose §4.3): pure shaping from a plan summary. Synthetic data. */
import { describe, expect, it } from "vitest";
import type { PlanSummaryDto } from "@rg/api-client";
import { changePlanRequest, planSheetWords } from "../src/screens/plan-words.js";

const plan = (over: Partial<PlanSummaryDto> = {}): PlanSummaryDto => ({
  id: "p1",
  kind: "coach",
  name: "Base",
  purpose: null,
  brief: null,
  onEnd: "ask",
  pausedUntil: null,
  objectiveIds: [],
  status: "active",
  lineKey: null,
  listedAs: null,
  course: null,
  prompt: null,
  ...over,
});

describe("planSheetWords", () => {
  it("says how each ending works, in the athlete's words", () => {
    expect(planSheetWords(plan({ onEnd: "ask" })).ending).toBe("Asks you when it ends");
    expect(planSheetWords(plan({ onEnd: "continue" })).ending).toBe("Continues on its own");
    expect(planSheetWords(plan({ onEnd: "finish" })).ending).toBe("Ends when its sessions do");
  });
  it("carries the purpose, the brief and the pause as written; a blank purpose or brief is none", () => {
    expect(planSheetWords(plan({ purpose: "Keep the habit", brief: "Ten sessions, then easier.", pausedUntil: "2026-12-01" }))).toEqual({
      purpose: "Keep the habit",
      ending: "Asks you when it ends",
      brief: "Ten sessions, then easier.",
      pausedUntil: "2026-12-01",
    });
    expect(planSheetWords(plan({ purpose: "   ", brief: "" }))).toMatchObject({ purpose: null, brief: null });
  });
});

describe("changePlanRequest", () => {
  it("opens the coach with the words written and the rest the athlete's to finish", () => {
    expect(changePlanRequest("Base")).toBe("Change how my Base plan works: ");
  });
});
