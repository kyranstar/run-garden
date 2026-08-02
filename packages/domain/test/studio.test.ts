import { describe, expect, it } from "vitest";
import {
  liftingPlanSchema,
  planBriefSchema,
  studioExerciseSchema,
  studioSessionSchema,
  studioWeekSchema,
  type LiftingPlan,
  type PlanBrief,
  type StudioExercise,
} from "../src/studio.js";

const validBrief: PlanBrief = {
  goal: "hypertrophy",
  durationWeeks: 8,
  sessionsPerWeek: 3,
  preferredDays: [1, 3, 5],
  sessionMinutes: 60,
  equipment: "full gym",
  constraints: "left knee — avoid deep lunges",
  notes: "",
  startDate: "2026-08-03",
};

const squat: StudioExercise = {
  originId: "425898928110747648",
  name: "Barbell Back Squat",
  sets: 5,
  reps: 5,
  weight: { type: "kg", value: 60 },
  restSeconds: 120,
};

const pushup: StudioExercise = {
  originId: "426109589008859137",
  name: "Push Up",
  sets: 3,
  reps: 15,
  weight: { type: "bodyweight" },
  restSeconds: 60,
  note: "slow eccentric",
};

const validSession = {
  title: "Upper A",
  weekday: 1,
  exercises: [squat, pushup],
};

const validPlan: LiftingPlan = {
  name: "8-Week Hypertrophy Build",
  brief: validBrief,
  weeks: Array.from({ length: 8 }, () => ({ sessions: [validSession] })),
};

describe("planBriefSchema", () => {
  it("accepts a valid brief", () => {
    expect(planBriefSchema.parse(validBrief)).toEqual(validBrief);
  });

  it("rejects durationWeeks out of 2..16", () => {
    expect(() => planBriefSchema.parse({ ...validBrief, durationWeeks: 1 })).toThrow();
    expect(() => planBriefSchema.parse({ ...validBrief, durationWeeks: 17 })).toThrow();
    expect(() => planBriefSchema.parse({ ...validBrief, durationWeeks: 2.5 })).toThrow();
  });

  it("rejects sessionsPerWeek out of 1..6", () => {
    expect(() => planBriefSchema.parse({ ...validBrief, sessionsPerWeek: 0 })).toThrow();
    expect(() => planBriefSchema.parse({ ...validBrief, sessionsPerWeek: 7 })).toThrow();
  });

  it("rejects sessionMinutes out of 20..120", () => {
    expect(() => planBriefSchema.parse({ ...validBrief, sessionMinutes: 19 })).toThrow();
    expect(() => planBriefSchema.parse({ ...validBrief, sessionMinutes: 121 })).toThrow();
  });

  it("rejects preferredDays whose length doesn't match sessionsPerWeek", () => {
    expect(() =>
      planBriefSchema.parse({ ...validBrief, sessionsPerWeek: 3, preferredDays: [1, 3] }),
    ).toThrow();
  });

  it("rejects preferredDays entries outside ISO weekday 1..7", () => {
    expect(() =>
      planBriefSchema.parse({ ...validBrief, preferredDays: [0, 3, 5] }),
    ).toThrow();
    expect(() =>
      planBriefSchema.parse({ ...validBrief, preferredDays: [1, 3, 8] }),
    ).toThrow();
  });

  it("rejects an invalid goal", () => {
    expect(() => planBriefSchema.parse({ ...validBrief, goal: "endurance" })).toThrow();
  });

  it("rejects a malformed startDate", () => {
    expect(() => planBriefSchema.parse({ ...validBrief, startDate: "08/03/2026" })).toThrow();
    expect(() => planBriefSchema.parse({ ...validBrief, startDate: "2026-13-40" })).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => planBriefSchema.parse({ ...validBrief, extra: "nope" })).toThrow();
  });
});

describe("studioExerciseSchema", () => {
  it("accepts bodyweight and kg-weighted exercises", () => {
    expect(studioExerciseSchema.parse(squat)).toEqual(squat);
    expect(studioExerciseSchema.parse(pushup)).toEqual(pushup);
  });

  it("rejects out-of-range reps", () => {
    expect(() => studioExerciseSchema.parse({ ...squat, reps: 0 })).toThrow();
    expect(() => studioExerciseSchema.parse({ ...squat, reps: 51 })).toThrow();
  });

  it("rejects out-of-range sets", () => {
    expect(() => studioExerciseSchema.parse({ ...squat, sets: 0 })).toThrow();
    expect(() => studioExerciseSchema.parse({ ...squat, sets: 11 })).toThrow();
  });

  it("rejects kg weight out of 0..500", () => {
    expect(() =>
      studioExerciseSchema.parse({ ...squat, weight: { type: "kg", value: -1 } }),
    ).toThrow();
    expect(() =>
      studioExerciseSchema.parse({ ...squat, weight: { type: "kg", value: 501 } }),
    ).toThrow();
  });

  it("rejects a bodyweight entry carrying a stray value field", () => {
    expect(() =>
      studioExerciseSchema.parse({ ...squat, weight: { type: "bodyweight", value: 10 } }),
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => studioExerciseSchema.parse({ ...squat, extra: "nope" })).toThrow();
  });
});

describe("studioSessionSchema", () => {
  it("accepts a valid session", () => {
    expect(studioSessionSchema.parse(validSession)).toEqual(validSession);
  });

  it("rejects weekday outside ISO 1..7", () => {
    expect(() => studioSessionSchema.parse({ ...validSession, weekday: 0 })).toThrow();
    expect(() => studioSessionSchema.parse({ ...validSession, weekday: 8 })).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => studioSessionSchema.parse({ ...validSession, extra: "nope" })).toThrow();
  });

  it("accepts exactly 10 exercises but rejects 11 (found unbounded in Task 4 review)", () => {
    const ten = { ...validSession, exercises: Array.from({ length: 10 }, () => squat) };
    const eleven = { ...validSession, exercises: Array.from({ length: 11 }, () => squat) };
    expect(studioSessionSchema.parse(ten).exercises).toHaveLength(10);
    expect(() => studioSessionSchema.parse(eleven)).toThrow();
  });
});

describe("studioWeekSchema", () => {
  it("accepts a valid week", () => {
    const week = { sessions: [validSession] };
    expect(studioWeekSchema.parse(week)).toEqual(week);
  });

  it("rejects unknown fields", () => {
    expect(() => studioWeekSchema.parse({ sessions: [validSession], extra: "nope" })).toThrow();
  });
});

describe("liftingPlanSchema", () => {
  it("accepts a valid plan fixture", () => {
    expect(liftingPlanSchema.parse(validPlan)).toEqual(validPlan);
  });

  it("rejects a plan whose brief has an out-of-range field", () => {
    expect(() =>
      liftingPlanSchema.parse({
        ...validPlan,
        brief: { ...validBrief, durationWeeks: 99 },
      }),
    ).toThrow();
  });

  it("rejects a plan whose session has an out-of-range reps", () => {
    const badSession = {
      ...validSession,
      exercises: [{ ...squat, reps: 999 }],
    };
    expect(() =>
      liftingPlanSchema.parse({
        ...validPlan,
        weeks: Array.from({ length: 8 }, () => ({ sessions: [badSession] })),
      }),
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => liftingPlanSchema.parse({ ...validPlan, extra: "nope" })).toThrow();
  });

  it("rejects a plan whose weeks disagree with its own brief", () => {
    // The brief is what the user approved; a body that says something else is
    // not that plan, and every extra week becomes real calendar writes.
    expect(() =>
      liftingPlanSchema.parse({ ...validPlan, weeks: validPlan.weeks.slice(0, 7) }),
    ).toThrow(/weeks length must equal brief.durationWeeks/);
    expect(() =>
      liftingPlanSchema.parse({
        ...validPlan,
        weeks: [...validPlan.weeks, { sessions: [validSession] }],
      }),
    ).toThrow(/weeks length must equal brief.durationWeeks/);
  });

  it("caps weeks at 16, so a runaway generation cannot become hundreds of writes", () => {
    const runaway = {
      ...validPlan,
      brief: { ...validBrief, durationWeeks: 16 },
      weeks: Array.from({ length: 200 }, () => ({ sessions: [validSession] })),
    };
    expect(() => liftingPlanSchema.parse(runaway)).toThrow();
    // 16 is the boundary and is accepted.
    expect(
      liftingPlanSchema.parse({ ...runaway, weeks: runaway.weeks.slice(0, 16) }).weeks,
    ).toHaveLength(16);
  });
});
