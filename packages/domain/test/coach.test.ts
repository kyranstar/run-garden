/**
 * Coach domain schemas (Plan A Task A2): every op parses in its valid form
 * and rejects its characteristic malformation; wake output honors restraint.
 */
import { describe, expect, it } from "vitest";
import {
  coachOpSchema,
  coachSessionSchema,
  wakeOutputSchema,
} from "../src/coach.js";

const easyRun = {
  category: "easy",
  title: "Steady 40min Z2",
  durationMinutes: 40,
  run: { blocks: [{ kind: "duration", value: 40, intensity: "easy" }] },
};

const liftSession = {
  category: "strength",
  title: "Pull day",
  durationMinutes: 45,
  lift: {
    exercises: [
      {
        originId: "coros-dl",
        name: "Deadlift",
        sets: 3,
        reps: 5,
        weight: { type: "kg", value: 100 },
        restSeconds: 180,
      },
    ],
  },
};

describe("coachSessionSchema", () => {
  it("accepts run and lift sessions", () => {
    expect(coachSessionSchema.parse(easyRun).run?.blocks).toHaveLength(1);
    expect(coachSessionSchema.parse(liftSession).lift?.exercises[0]!.name).toBe("Deadlift");
  });
  it("rejects a session claiming both disciplines", () => {
    expect(() =>
      coachSessionSchema.parse({ ...easyRun, lift: liftSession.lift }),
    ).toThrow();
  });
});

describe("coachOpSchema", () => {
  it("parses each op kind", () => {
    const ops = [
      { kind: "ease", workoutId: "w1", session: easyRun },
      { kind: "move", workoutId: "w1", toDate: "2026-08-10" },
      { kind: "swap", dayA: "2026-08-10", dayB: "2026-08-11" },
      { kind: "skip", workoutId: "w1", reason: "three short nights" },
      { kind: "add", date: "2026-08-10", session: liftSession },
      {
        kind: "firmUp",
        planId: "cp1",
        weekStart: "2026-09-07",
        sessions: [{ date: "2026-09-08", session: easyRun }],
      },
      {
        kind: "extendPlan",
        planId: "cp1",
        shapeWeeks: [{ weekStart: "2026-10-12", volumeTarget: "35k", keySessions: ["long 16k"] }],
      },
      { kind: "retirePlan", planId: "cp1" },
    ];
    for (const op of ops) expect(coachOpSchema.parse(op).kind).toBe(op.kind);
  });
  it("rejects unknown kinds and malformed dates", () => {
    expect(() => coachOpSchema.parse({ kind: "delete_everything" })).toThrow();
    expect(() =>
      coachOpSchema.parse({ kind: "move", workoutId: "w1", toDate: "next tuesday" }),
    ).toThrow();
  });
});

describe("wakeOutputSchema", () => {
  it("accepts a full wake and the restraint wake", () => {
    const full = wakeOutputSchema.parse({
      briefing: "Rough sleep — easing tomorrow.",
      proposals: [
        {
          title: "Ease tomorrow",
          evidence: "slept 5h avg · HRV −9%",
          rationale: "Three short nights before quality work.",
          expiresAt: "2026-08-07",
          flags: [],
          ops: [{ kind: "ease", workoutId: "w1", session: easyRun }],
        },
      ],
      question: { text: "Finish strong or chase a time?", chips: ["Finish strong", "Sub 1:45"] },
      memoryOps: [{ op: "add", kind: "note", text: "travel Aug 13–16", expiresAt: "2026-08-17" }],
    });
    expect(full.proposals).toHaveLength(1);

    const restraint = wakeOutputSchema.parse({
      briefing: null,
      proposals: [],
      question: null,
      memoryOps: [],
    });
    expect(restraint.briefing).toBeNull();
  });
  it("rejects a proposal with zero ops", () => {
    expect(() =>
      wakeOutputSchema.parse({
        briefing: "x",
        proposals: [
          { title: "t", evidence: "e", rationale: "r", expiresAt: "2026-08-07", flags: [], ops: [] },
        ],
        question: null,
        memoryOps: [],
      }),
    ).toThrow();
  });
});
