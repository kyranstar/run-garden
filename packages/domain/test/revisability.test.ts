import { describe, expect, it } from "vitest";
import { REVISABILITY_WORDS, revisability, type RevisabilityInput } from "../src/revisability.js";

const TODAY = "2026-10-27";
const base: RevisabilityInput = {
  origin: "coros", category: "strength", sport: "strength", completionState: "pending", contentState: null,
  effectiveDate: TODAY, hasDoc: false, isRun: null,
};
const refused = (over: Partial<RevisabilityInput>) => revisability({ ...base, ...over }, TODAY);

describe("revisability", () => {
  it("a plain future-or-today session is revisable", () => {
    expect(refused({})).toEqual({ ok: true, adopts: true });
  });

  it("adopts is true for a null or coros origin, false for studio and template", () => {
    expect(refused({ origin: null })).toEqual({ ok: true, adopts: true });
    expect(refused({ origin: "coros" })).toEqual({ ok: true, adopts: true });
    expect(refused({ origin: "studio" })).toEqual({ ok: true, adopts: false });
    expect(refused({ origin: "template" })).toEqual({ ok: true, adopts: false });
  });

  it("programme: program and on_demand", () => {
    for (const origin of ["program", "on_demand"]) {
      expect(refused({ origin })).toEqual({
        ok: false, reason: "programme",
        why: "It's a programme's session: the programme builds it on the day.",
        instead: "Put moves in its pool with pin_moves, change the programme with change_programme, or propose a new workout for that day and skip the slot with adjust_plan.",
      });
    }
  });

  it("a course's outline is refused for the same reason, in words of what a course can do", () => {
    expect(refused({ origin: "program", courseOutline: true })).toEqual({
      ok: false, reason: "programme",
      why: "It's a course's session: the course writes it on the day, from its fixed sequence.",
      instead: "Ease the next session or pause the plan with change_plan, skip or move this one with adjust_plan, or propose a new workout for that day and skip the slot with adjust_plan.",
    });
  });

  it("the course's words only ever replace a programme's: what comes first still does, and a written session is revisable", () => {
    expect(refused({ origin: "program", courseOutline: true, completionState: "completed" })).toMatchObject({ reason: "resolved", instead: "Propose a new workout." });
    expect(refused({ origin: "studio", courseOutline: true })).toEqual({ ok: true, adopts: false });
  });

  it("resolved: the why follows the state", () => {
    const instead = "Propose a new workout.";
    expect(refused({ completionState: "completed" })).toEqual({ ok: false, reason: "resolved", why: "It's already done.", instead });
    expect(refused({ completionState: "skipped" })).toEqual({ ok: false, reason: "resolved", why: "It was skipped.", instead });
    expect(refused({ completionState: "missed" })).toEqual({ ok: false, reason: "resolved", why: "It was missed.", instead });
  });

  it("under_way: content started or done", () => {
    for (const contentState of ["started", "done"]) {
      expect(refused({ contentState })).toEqual({
        ok: false, reason: "under_way", why: "It's under way.", instead: "Propose one for later.",
      });
    }
  });

  it("run: from the document, or from sport/category with none", () => {
    const want = {
      ok: false, reason: "run", why: "It's a run: runs are re-planned, not revised.",
      instead: "adjust_plan changes its length or eases it; propose a new run to replace it.",
    };
    expect(refused({ hasDoc: true, isRun: true, origin: "studio" })).toEqual(want);
    expect(refused({ origin: null, hasDoc: false, isRun: null, sport: "run" })).toEqual(want);
    expect(refused({ hasDoc: false, isRun: null, sport: null, category: "easy" })).toEqual(want);
    expect(refused({ hasDoc: true, isRun: false, sport: "run", category: "easy" })).toEqual({ ok: true, adopts: true });
  });

  it("rest", () => {
    expect(refused({ category: "rest" })).toEqual({
      ok: false, reason: "rest", why: "It's a rest day.", instead: "Propose a new workout for that day.",
    });
  });

  it("race, and it beats programme", () => {
    const want = { ok: false, reason: "race", why: "It's race day.", instead: "Leave it; design around it." };
    expect(refused({ category: "race" })).toEqual(want);
    expect(refused({ category: "race", origin: "program" })).toEqual(want);
  });

  it("past, and it beats resolved", () => {
    const want = { ok: false, reason: "past", why: "Its day has passed.", instead: "Propose for today or later." };
    expect(refused({ effectiveDate: "2026-10-26" })).toEqual(want);
    expect(refused({ effectiveDate: "2026-10-26", completionState: "completed" })).toEqual(want);
  });

  it("archived is not a reason here", () => {
    expect(refused({ archived: true })).toEqual({ ok: true, adopts: true });
  });

  it("the words table is exported", () => {
    expect(Object.keys(REVISABILITY_WORDS).sort()).toEqual(["past", "programme", "race", "resolved", "rest", "run", "under_way"]);
  });
});
