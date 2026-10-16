/**
 * A DESIGNED WORKOUT'S LINE CARRIES ITS REVIEW AND ITS COSTS (Stage 3 Task 9; spec §8, §10): the proposal card's
 * expanded line shows the review's scores, notes and what changed between drafts, and the validator's warnings for the
 * day — read from the op, in the rubric's own words (`REVIEW_DIMENSIONS`' labels and order), never a dimension id. A
 * review that couldn't be read says so (`note`); a workout with no review has none. All of it is plain text the card
 * renders as text. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_USER_PREFERENCES } from "@rg/domain";
import { docWorkoutLines, planChangeLines } from "../src/services/design-manifest.js";
import type { DesignedOp } from "../src/services/design-approve.js";
import { calmDoc } from "./doc-workout-fixture.js";

const place = () => "Home";
/** The clock a line's time is read at (B-I1): these lines are about their reviews. */
const CLOCK = { now: new Date("2026-10-14T08:00:00.000Z"), prefs: DEFAULT_USER_PREFERENCES };

function op(over: Partial<DesignedOp> = {}): DesignedOp {
  return {
    kind: "doc_workout",
    target: { kind: "new", date: "2026-10-16" },
    date: "2026-10-16",
    doc: calmDoc(),
    review: null,
    issues: [],
    derived: {},
    by: { runId: "run-d1", role: "designer" },
    toolUseId: "toolu_1",
    at: "2026-10-14T08:00:00.000Z",
    ...over,
  } as DesignedOp;
}

describe("a designed workout's line: its review and its costs", () => {
  it("the review's scores and notes by the rubric's labels, in its order; what changed; must-fix, improvements, kept costs", () => {
    const [line] = docWorkoutLines(
      [
        op({
          review: {
            scores: { sequencing: 5, intent: 4, condition_safety: 2 },
            notes: { intent: "One clear aim.", condition_safety: "Loaded jaw work, as asked." },
            mustFix: [],
            improvements: ["Add a slower tempo on the bridges."],
            rounds: 2,
            changes: ["Swapped the jumps for bridges."],
            accepted: [{ dimension: "condition_safety", why: "the athlete asked for it" }],
          } as DesignedOp["review"],
          issues: [{ path: "parts.0", code: "test_unmeasured", message: "The test move isn't one its key result reads." }],
        }),
      ],
      place,
      CLOCK,
    );
    expect(line!.review).toEqual({
      dimensions: [
        { id: "intent", label: "Intent clarity", score: 4, note: "One clear aim." },
        { id: "sequencing", label: "Sequencing", score: 5, note: null },
        { id: "condition_safety", label: "Condition safety", score: 2, note: "Loaded jaw work, as asked." },
      ],
      mustFix: [],
      improvements: ["Add a slower tempo on the bridges."],
      changes: ["Swapped the jumps for bridges."],
      // A review stored before condition safety could no longer be accepted still renders, in the athlete's words.
      accepted: ["Condition safety — kept as you asked: you asked for it"],
      rounds: 2,
      note: null,
    });
    // A code the shared validator doesn't list (the tool layer's) still reaches the card, with its message.
    expect(line!.issues).toEqual([{ code: "test_unmeasured", message: "The test move isn't one its key result reads." }]);
  });

  it("a review that couldn't be read says so; no review is none", () => {
    const [unread, none] = docWorkoutLines(
      [
        op({ review: { scores: {}, notes: {}, mustFix: [], improvements: [], rounds: 1, changes: [], note: "The review couldn't be read — the app's own checks stand." } }),
        op({ toolUseId: "toolu_2", by: { runId: "run-d2", role: "designer" } }),
      ],
      place,
      CLOCK,
    );
    expect(unread!.review).toMatchObject({ dimensions: [], note: "The review couldn't be read — the app's own checks stand." });
    expect(none!.review).toBeNull();
    expect(none!.issues).toEqual([]);
  });

  it("a change's line carries its advisory notes — a skip past the week's sanctioned rest — for the card to show", () => {
    const sanctioned = { code: "sanctioned_rest", message: "This would be the second sanctioned skip in a rolling week." };
    const [skip, plain] = planChangeLines([
      {
        kind: "plan_adjust", id: "adj-w1", op: { kind: "skip", workoutId: "w1", reason: "Rest." }, why: "A flare day.", issues: [sanctioned],
        date: "2026-10-16", row: { date: "2026-10-16", time: "07:00", title: "Strength", minutes: 35, category: "strength", origin: "program", onWatch: false },
        toolUseId: "t1", at: "2026-10-14T08:00:00.000Z",
      },
      {
        kind: "plan_adjust", id: "adj-w2", op: { kind: "skip", workoutId: "w2", reason: "Rest." }, why: "A flare day.", issues: [],
        date: "2026-10-17", row: { date: "2026-10-17", time: "07:00", title: "Strength", minutes: 35, category: "strength", origin: "program", onWatch: false },
        toolUseId: "t2", at: "2026-10-14T08:00:00.000Z",
      },
    ]);
    expect(skip!.issues).toEqual([sanctioned]);
    expect(plain!.issues).toEqual([]);
  });

  it("a dimension the rubric no longer has comes after the rubric's own, its id in plain words (never raw: Task 13's fix wave, §2.10)", () => {
    const [line] = docWorkoutLines([op({ review: { scores: { pace: 3, intent: 5 }, notes: {}, mustFix: [], improvements: [], rounds: 1, changes: [] } })], place, CLOCK);
    expect(line!.review!.dimensions).toEqual([
      { id: "intent", label: "Intent clarity", score: 5, note: null },
      { id: "pace", label: "Pace", score: 3, note: null },
    ]);
  });
});
