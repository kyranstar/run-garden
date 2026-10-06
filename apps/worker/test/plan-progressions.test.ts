/**
 * Plan progressions — the kg claim (audit 2026-08-14).
 *
 * The deployed plan card read "Push-ups 12 → 20 kg" and "BURPEES 30 → 65 kg",
 * and the weeks list read "pull-ups 12kg, cardio kickboxing 12kg". Those rows
 * come from the live studio plan e081d202, generated 2026-08-03 — eight days
 * before the generator's catalog started handing the model English names
 * instead of COROS i18n keys ("T1004"). The model picked originIds blind and
 * recorded its intent only in the note ("DB bench press", "+2 kg from W4"), so
 * the kilograms are genuine and the NAME is what's wrong. No unit label can
 * repair a row whose exercise identity is unknown, so a catalog-identified
 * bodyweight/cardio movement is excluded from weight series exactly as a
 * self-declared `weight.type === "bodyweight"` entry already is.
 */

import { describe, expect, it } from "vitest";
import type { LiftingPlan, StudioExercise, StudioSession } from "@rg/domain";
import {
  carriesNoExternalLoad,
  liftProgressions,
  liftWeekSummary,
} from "../src/services/plan-progressions.js";

function kg(name: string, value: number, sets = 3, reps = 10): StudioExercise {
  return { originId: `id-${name}`, name, sets, reps, weight: { type: "kg", value }, restSeconds: 90 };
}

function bw(name: string, sets = 3, reps = 10): StudioExercise {
  return { originId: `id-${name}`, name, sets, reps, weight: { type: "bodyweight" }, restSeconds: 60 };
}

function plan(weeks: StudioExercise[][]): Pick<LiftingPlan, "weeks"> {
  return {
    weeks: weeks.map((exercises) => ({
      sessions: [{ title: "Session", weekday: 1, exercises } as StudioSession],
    })),
  };
}

describe("carriesNoExternalLoad", () => {
  it("catches the movements the audit found labelled in kilograms", () => {
    for (const name of ["Push-ups", "Burpees", "Pull-ups", "Cardio Kickboxing"]) {
      expect(carriesNoExternalLoad(name)).toBe(true);
    }
  });

  it("also catches holds, stretches and conditioning", () => {
    for (const name of ["Planks", "Side Plank", "Wall Sit", "Dead Hang", "Cat-Cow Stretch", "Mountain Climbers", "Jumping Jacks", "Box Jumps", "Bird Dog"]) {
      expect(carriesNoExternalLoad(name)).toBe(true);
    }
  });

  it("leaves genuinely loaded lifts alone", () => {
    for (const name of ["Back Squat", "Trap Bar Deadlift", "Bench Press", "Hip Thrust", "Farmer's Walk", "Standing Calf Raises", "Bent-Over Row"]) {
      expect(carriesNoExternalLoad(name)).toBe(false);
    }
  });

  it("re-admits the loaded variants of a bodyweight movement", () => {
    for (const name of ["Decline Weighted Crunch", "Machine Crunches", "High Pulley Crunches", "Plank Row", "Dumbbell Side Plank Rotations"]) {
      expect(carriesNoExternalLoad(name)).toBe(false);
    }
  });
});

describe("liftProgressions", () => {
  it("never graphs a kg series for a bodyweight or cardio movement", () => {
    // The prod shape: a kg value that rises week over week on an exercise
    // the catalog says carries no load.
    const out = liftProgressions(
      plan([
        [kg("Push-ups", 12), kg("Burpees", 30), kg("Trap Bar Deadlift", 40)],
        [kg("Push-ups", 16), kg("Burpees", 50), kg("Trap Bar Deadlift", 60)],
        [kg("Push-ups", 20), kg("Burpees", 65), kg("Trap Bar Deadlift", 75)],
      ]),
      new Set<number>(),
      3,
    );
    expect(out.filter((p) => p.unit === "kg").map((p) => p.label)).toEqual(["Trap Bar Deadlift"]);
    expect(out.find((p) => p.label === "Trap Bar Deadlift")).toMatchObject({
      unit: "kg",
      from: 40,
      to: 75,
      now: 75,
    });
  });

  it("still counts the excluded movements toward weekly sets", () => {
    const out = liftProgressions(
      plan([
        [kg("Push-ups", 12, 3), kg("Trap Bar Deadlift", 40, 3)],
        [kg("Push-ups", 20, 5), kg("Trap Bar Deadlift", 60, 3)],
      ]),
      new Set<number>(),
      null,
    );
    const sets = out.find((p) => p.key === "lift:weekly-sets")!;
    expect(sets.series.map((s) => s.value)).toEqual([6, 8]);
  });

  it("treats a self-declared bodyweight entry the same as a catalog-identified one", () => {
    const out = liftProgressions(
      plan([
        [bw("Back Squat"), kg("Bench Press", 50)],
        [bw("Back Squat"), kg("Bench Press", 60)],
      ]),
      new Set<number>(),
      null,
    );
    expect(out.filter((p) => p.unit === "kg").map((p) => p.label)).toEqual(["Bench Press"]);
  });
});

describe("liftProgressions — logged top sets (Phase 2a+ Task 3)", () => {
  const deadlift = plan([[kg("Trap Bar Deadlift", 40)], [kg("Trap Bar Deadlift", 60)], [kg("Trap Bar Deadlift", 75)]]);

  it("fills `actual` per week from the heaviest logged set, to a tenth of a kilo", () => {
    const actual = new Map([["id-Trap Bar Deadlift", new Map([[1, 42.18], [3, 70]])]]);
    const [lift] = liftProgressions(deadlift, new Set<number>(), 3, 3, actual);
    expect(lift!.series).toEqual([
      { week: 1, value: 40, actual: 42.2 },
      { week: 2, value: 60 },
      { week: 3, value: 75, actual: 70 },
    ]);
  });

  it("adds no point for a logged week the plan prescribes nothing in, and nothing to weekly sets", () => {
    const actual = new Map([["id-Trap Bar Deadlift", new Map([[5, 90]])]]);
    const out = liftProgressions(deadlift, new Set<number>(), 3, 3, actual);
    expect(out.find((p) => p.key.startsWith("lift:id-"))!.series.map((p) => p.week)).toEqual([1, 2, 3]);
    expect(out.flatMap((p) => p.series).some((p) => p.actual !== undefined)).toBe(false);
  });

  it("leaves every series as it was when nothing was logged", () => {
    expect(liftProgressions(deadlift, new Set<number>(), 3, 3, new Map())).toEqual(liftProgressions(deadlift, new Set<number>(), 3));
  });
});

describe("liftWeekSummary", () => {
  it("omits bodyweight and cardio movements from the heaviest-lift line", () => {
    const full = {
      ...plan([[kg("Cardio Kickboxing", 12), kg("Pull-ups", 12), kg("Bench Press", 6)]]),
      name: "P",
      brief: { durationWeeks: 1 },
    } as unknown as LiftingPlan;
    const summary = liftWeekSummary(full, 1);
    expect(summary).not.toContain("kickboxing");
    expect(summary).not.toContain("pull-ups");
    expect(summary).toBe("bench press 6kg · 9 sets");
  });
});
