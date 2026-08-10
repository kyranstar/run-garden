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

  it("normalizes dossier-decorated ids ([wo:…], plan:, bare brackets)", () => {
    const skip = coachOpSchema.parse({ kind: "skip", workoutId: "[wo:abc123]", reason: "backpacking" });
    expect(skip.kind === "skip" && skip.workoutId).toBe("abc123");
    const move = coachOpSchema.parse({ kind: "move", workoutId: "wo:abc123", toDate: "2026-08-10" });
    expect(move.kind === "move" && move.workoutId).toBe("abc123");
    const retire = coachOpSchema.parse({ kind: "retirePlan", planId: "[cp1]" });
    expect(retire.kind === "retirePlan" && retire.planId).toBe("cp1");
  });

  it("accepts timestamps where dates belong, truncating to the day", () => {
    const move = coachOpSchema.parse({
      kind: "move",
      workoutId: "w1",
      toDate: "2026-08-10T23:59:59Z",
    });
    expect(move.kind === "move" && move.toDate).toBe("2026-08-10");
  });

  it("truncates overlong prose instead of rejecting the wake", () => {
    const skip = coachOpSchema.parse({ kind: "skip", workoutId: "w1", reason: "x".repeat(500) });
    expect(skip.kind === "skip" && skip.reason.length).toBe(200);
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

    // The live failure shape: a proposal whose expiresAt is an "end of day"
    // timestamp must parse, truncated to the date.
    const timestamped = wakeOutputSchema.parse({
      briefing: null,
      proposals: [
        {
          title: "Skip Saturday's long run",
          evidence: "backpacking Fri–Sun",
          rationale: "Three days under a pack is the weekend's training.",
          expiresAt: "2026-08-08T23:59:59Z",
          flags: [],
          ops: [{ kind: "skip", workoutId: "[wo:up1]", reason: "backpacking weekend" }],
        },
      ],
      question: null,
      memoryOps: [],
    });
    expect(timestamped.proposals[0]!.expiresAt).toBe("2026-08-08");
    const op = timestamped.proposals[0]!.ops[0]!;
    expect(op.kind === "skip" && op.workoutId).toBe("up1");

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
