/**
 * When a plan asks what comes next (plans with a purpose §4): one rule, read by today's chip and by the plan's row.
 * Synthetic names and dates only.
 */
import { describe, expect, it } from "vitest";
import { addDays, planPrompt, PLAN_PROMPT_DAYS, PLAN_PROMPT_KINDS, PROGRAM_KINDS, type PlanPromptInput } from "../src/index.js";

const today = "2026-03-10";
const plan = (over: Partial<PlanPromptInput> = {}): PlanPromptInput => ({
  kind: "coach",
  onEnd: "ask",
  status: "active",
  pausedUntil: null,
  name: "Zorbex build",
  discipline: "run",
  lastSessionDate: addDays(today, 12),
  hasDraft: false,
  ...over,
});

describe("planPrompt", () => {
  it.each([
    ["coach", "ask", 12, "whats_next"],
    ["coach", "ask", 22, null],
    ["coach", "ask", 21, "whats_next"],
    ["coach", "ask", 0, "whats_next"],
    ["coach", "ask", -1, "whats_next"],
    ["coach", "ask", -21, "whats_next"],
    ["coach", "ask", -22, null],
    ["coach", "continue", 5, "whats_next"],
    ["coach", "continue", 0, "whats_next"],
    ["coach", "continue", -1, null],
    ["coach", "continue", -3, null],
    ["coach", "continue", -21, null],
    ["coach", "finish", -3, null],
    ["course", "continue", -3, null],
    ["coros_import", "ask", -3, "whats_next"],
    ["coach", "finish", 12, null],
    ["coach", "continue", 12, "whats_next"],
    ["course", "continue", 12, null],
    ["course", "finish", 12, null],
    ["adaptive", "continue", 12, null],
    ["coros_import", "ask", 12, "whats_next"],
    ["coros_import", "finish", 12, null],
    ["studio", "finish", 12, null],
  ] as const)("%s %s, last session in %i days: %s", (kind, onEnd, days, expected) => {
    expect(planPrompt(plan({ kind, onEnd, lastSessionDate: addDays(today, days) }), today)?.kind ?? null).toBe(expected);
  });

  it("the horizon is 21 days, today's chip's", () => {
    expect(PLAN_PROMPT_DAYS).toBe(21);
  });

  it("the chip's words for a running plan are unchanged, and the request says when it ends", () => {
    const at = (days: number) => planPrompt(plan({ lastSessionDate: addDays(today, days) }), today);
    expect(at(12)).toEqual({ kind: "whats_next", label: "Plan what comes after my running plan", request: "Plan what comes after my running plan — it ends in 12 days." });
    expect(at(0)?.request).toBe("Plan what comes after my running plan — it ends today.");
    expect(at(1)?.request).toBe("Plan what comes after my running plan — it ends tomorrow.");
    expect(planPrompt(plan({ discipline: "lift" }), today)?.label).toBe("Plan what comes after my lifting plan");
    expect(planPrompt(plan({ discipline: "mobility" }), today)?.label).toBe("Plan what comes after my mobility plan");
  });

  it("a plan that has run out stays available for 21 days, plainly: it ended, and nothing is marked missed", () => {
    const ended = (days: number) => planPrompt(plan({ lastSessionDate: addDays(today, -days) }), today);
    expect(ended(1)).toEqual({ kind: "whats_next", label: "Plan what comes after my running plan", request: "Plan what comes after my running plan — it ended yesterday." });
    expect(ended(3)?.request).toBe("Plan what comes after my running plan — it ended 3 days ago.");
    expect(ended(21)?.request).toBe("Plan what comes after my running plan — it ended 21 days ago.");
    expect(ended(22)).toBeNull();
    // Stopped, paused, finishing: still nothing, run out or not.
    expect(planPrompt(plan({ lastSessionDate: addDays(today, -3), status: "retired" }), today)).toBeNull();
    expect(planPrompt(plan({ lastSessionDate: addDays(today, -3), pausedUntil: addDays(today, 2) }), today)).toBeNull();
  });

  it("a plan that something follows stops asking: its last session is the later one's", () => {
    // Run out 3 days ago, then a new phase placed to 40 days: no prompt now; a phase to 10 days: it ends in 10 days.
    expect(planPrompt(plan({ lastSessionDate: addDays(today, 40) }), today)).toBeNull();
    expect(planPrompt(plan({ lastSessionDate: addDays(today, 10) }), today)?.request).toBe("Plan what comes after my running plan — it ends in 10 days.");
  });

  it("every kind of plan is decided: those that prompt are listed once, and a new kind fails here until it is placed", () => {
    expect([...PLAN_PROMPT_KINDS].sort()).toEqual(["coach", "coros_import"]);
    const never = PROGRAM_KINDS.filter((k) => !(PLAN_PROMPT_KINDS as readonly string[]).includes(k));
    expect(never.sort()).toEqual(["adaptive", "course", "studio"]);
  });

  it("a plan of no known sport is called by its own name", () => {
    expect(planPrompt(plan({ discipline: null, name: "Zorbex build" }), today)?.label).toBe("Plan what comes after Zorbex build");
  });

  it("a retired plan never prompts, however near its end", () => {
    expect(planPrompt(plan({ status: "retired" }), today)).toBeNull();
    expect(planPrompt(plan({ status: "retired", hasDraft: true }), today)).toBeNull();
  });

  it("a paused plan doesn't prompt; one whose pause has passed does", () => {
    expect(planPrompt(plan({ pausedUntil: addDays(today, 3) }), today)).toBeNull();
    expect(planPrompt(plan({ pausedUntil: today }), today)).toBeNull();
    expect(planPrompt(plan({ pausedUntil: addDays(today, -1) }), today)?.kind).toBe("whats_next");
  });

  it("a plan with a phase following on doesn't prompt: its last session is the later phase's", () => {
    // The first phase ends in 3 days, a second runs on to 59: the plan's last session is the 59th day.
    expect(planPrompt(plan({ lastSessionDate: addDays(today, 59) }), today)).toBeNull();
  });

  it("a plan with no session at all, ahead or behind, doesn't prompt; nor does a date that isn't one", () => {
    expect(planPrompt(plan({ lastSessionDate: null }), today)).toBeNull();
    // Sorts inside the window as text, so only reading it as a date refuses it.
    expect(planPrompt(plan({ lastSessionDate: "2026-03-2x" }), today)).toBeNull();
  });

  it("an ending the kind doesn't allow never prompts: a COROS plan's sessions aren't ours to continue", () => {
    expect(planPrompt(plan({ kind: "coros_import", onEnd: "continue" }), today)).toBeNull();
    expect(planPrompt(plan({ kind: "coros_import", onEnd: "continue", hasDraft: true }), today)).toBeNull();
  });

  it("a draft ready prompts for a plan that asks or continues, whatever its end; never for a course, a programme, a finish or a stopped plan", () => {
    const ready = planPrompt(plan({ hasDraft: true, onEnd: "continue", lastSessionDate: addDays(today, 40) }), today);
    expect(ready).toEqual({ kind: "draft_ready", label: "Review the draft for my running plan", request: "Review the draft for my running plan." });
    expect(planPrompt(plan({ hasDraft: true, lastSessionDate: null }), today)?.kind).toBe("draft_ready");
    expect(planPrompt(plan({ hasDraft: true, kind: "course", onEnd: "continue" }), today)).toBeNull();
    expect(planPrompt(plan({ hasDraft: true, kind: "adaptive", onEnd: "continue" }), today)).toBeNull();
    expect(planPrompt(plan({ hasDraft: true, onEnd: "finish" }), today)).toBeNull();
    expect(planPrompt(plan({ hasDraft: true, pausedUntil: addDays(today, 2) }), today)).toBeNull();
  });

  it("a draft ready outranks the question what comes next", () => {
    expect(planPrompt(plan({ hasDraft: true }), today)?.kind).toBe("draft_ready");
  });
});
