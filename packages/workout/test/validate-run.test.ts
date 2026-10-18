/**
 * THE VALIDATOR'S RUN RULES (§8 §3, designed runs): a run is a document of its own — run segments and rests, never
 * among moves (`run_mixed`) — that the watch can hold (`run_open`, `run_too_long`); a pace the coach wrote is near its
 * effort's (`run_pace_far`); and, given the athlete's running (`ctx.run`), what code can count: no threshold yet
 * (`run_pace_owed`), hard running or hard leg strength within 48 hours (`run_hard_close`), a long run out of proportion
 * to the week (`run_long_share`), and a week well over the last four's average (`run_volume_jump`).
 */
import { describe, expect, it } from "vitest";
import { addDays, type WorkoutDoc, type WorkoutItem, type WorkoutPart } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { validateWorkoutDoc, type DocIssue, type RunCtx, type ValidateCtx } from "../src/index.js";

const DAY = "2026-03-10";
const run = (effort: string, target: Record<string, unknown>, extra: Record<string, unknown> = {}): WorkoutItem =>
  ({ kind: "run", effort, target, ...extra }) as WorkoutItem;
const part = (purpose: string, format: string, items: WorkoutItem[], extra: Record<string, unknown> = {}): WorkoutPart =>
  ({ purpose, format, items, ...extra }) as WorkoutPart;
const docOf = (parts: WorkoutPart[], effort: WorkoutDoc["intent"]["effort"] = "develop"): WorkoutDoc =>
  ({ version: 1, title: "Run", intent: { summary: "A run.", goals: [], focus: [], effort }, parts, source: { kind: "coach" } }) as WorkoutDoc;

/** A tempo session: 10 min easy, 3 × (8 min tempo, 2 min jog), 10 min easy — 50 minutes. */
const TEMPO = docOf([
  part("warmup", "steady", [run("easy", { durationSec: 600 })]),
  part("run", "intervals", [run("tempo", { durationSec: 480 }), run("recovery", { durationSec: 120 })], { rounds: 3 }),
  part("cooldown", "steady", [run("easy", { durationSec: 600 })]),
]);
/** A long run: 100 minutes. */
const LONG = docOf([part("run", "steady", [run("long", { durationSec: 6000 })])], "maintain");
/** An easy run: 40 minutes. */
const EASY = docOf([part("run", "steady", [run("easy", { durationSec: 2400 })])], "maintain");

const RUN: RunCtx = { thresholdSecPerKm: 289, nearby: [], weekMinutes: 120, fourWeekAvgMinutes: 200 };
function check(doc: WorkoutDoc, runCtx?: Partial<RunCtx> | null): DocIssue[] {
  const ctx: ValidateCtx = {
    library: EXERCISES,
    activeProfiles: [],
    day: { date: DAY, today: DAY, readings: {} },
    ...(runCtx === null ? {} : { run: { ...RUN, ...runCtx } }),
  };
  return validateWorkoutDoc(doc, ctx);
}
const codes = (issues: readonly DocIssue[]): string[] => issues.map((i) => `${i.severity}:${i.code}@${i.path}`);

describe("a designed run that the rules raise nothing on", () => {
  it("a tempo session, an easy run and a long run in proportion, with the athlete's running known", () => {
    expect(check(TEMPO)).toEqual([]);
    expect(check(EASY)).toEqual([]);
    expect(check(LONG, { weekMinutes: 300, fourWeekAvgMinutes: 400 })).toEqual([]);
    // Without the athlete's running, only the document's own rules.
    expect(check(TEMPO, null)).toEqual([]);
  });
});

describe("run_mixed", () => {
  it("run segments among moves are an error at each segment; a move in a run, at the move", () => {
    const strength = docOf([
      part("main", "straight", [{ kind: "exercise", libraryId: "gobletSquat", dose: { sets: 3, reps: 8 } } as WorkoutItem, { kind: "exercise", libraryId: "deadBug", dose: { sets: 2, reps: 8 } } as WorkoutItem]),
      part("run", "steady", [run("easy", { durationSec: 600 })]),
    ], "maintain");
    expect(codes(check(strength, null).filter((i) => i.code === "run_mixed"))).toEqual(["error:run_mixed@parts[1].items[0]"]);
    const runWithMove = docOf([...TEMPO.parts, part("cooldown", "straight", [{ kind: "exercise", libraryId: "figureFour", dose: { holdSec: 30 } } as WorkoutItem])]);
    const issues = check(runWithMove).filter((i) => i.code === "run_mixed");
    expect(codes(issues)).toEqual(["error:run_mixed@parts[3].items[0]"]);
    expect(issues[0]!.message).toBe("Runs and moves go in workouts of their own: this one mixes run segments with exercises.");
  });

  it("a rest is neither: a run with standing rests is a run", () => {
    expect(check(docOf([part("run", "intervals", [run("interval", { durationSec: 180 }), { kind: "rest", seconds: 90 }], { rounds: 5 })]))).toEqual([]);
  });
});

describe("the watch's own limits on a run", () => {
  it("run_open: an open segment can't go to the watch", () => {
    const open = docOf([part("run", "steady", [run("easy", { open: true })])], "maintain");
    expect(codes(check(open))).toEqual(["error:run_open@parts[0].items[0].target"]);
  });

  it("run_too_long: more than 60 steps once the repeats are written out", () => {
    const reps = (rounds: number) => docOf([part("run", "intervals", [run("interval", { durationSec: 60 }), run("recovery", { durationSec: 60 })], { rounds })]);
    expect(check(reps(30))).toEqual([]);
    const issues = check(reps(31));
    expect(codes(issues)).toEqual(["error:run_too_long@parts"]);
    expect(issues[0]!.message).toBe("This run has 62 steps once its repeats are written out, and the watch takes 60: fewer repeats, or longer ones.");
  });
});

describe("run_pace_far", () => {
  const paced = (effort: string, fast: number, slow: number) =>
    docOf([part("run", "steady", [run(effort, { durationSec: 1200, pace: { fastSecPerKm: fast, slowSecPerKm: slow } })])]);

  it("a pace the coach wrote far from its effort's band is an error; near it, none", () => {
    // Tempo at 289: 4:59–5:14/km. 4:00–4:10 is a different effort.
    const far = check(paced("tempo", 240, 250));
    expect(codes(far)).toEqual(["error:run_pace_far@parts[0].items[0].target.pace"]);
    expect(far[0]!.message).toBe("This pace, 4:00–4:10/km, is far from a tempo effort's 4:59–5:14/km: name the effort it is, or leave the pace to the app.");
    expect(check(paced("tempo", 295, 305))).toEqual([]);
    // Within 30 s of either edge is near.
    expect(check(paced("tempo", 330, 340))).toEqual([]);
    expect(codes(check(paced("tempo", 340, 350)))).toEqual(["error:run_pace_far@parts[0].items[0].target.pace"]);
    // The edges themselves: a middle exactly 30 s past either edge of the band is near; a second more is far.
    expect(check(paced("tempo", 339, 349))).toEqual([]);
    expect(check(paced("tempo", 264, 274))).toEqual([]);
    expect(codes(check(paced("tempo", 263, 273)))).toEqual(["error:run_pace_far@parts[0].items[0].target.pace"]);
  });

  it("an effort with no band, or no threshold known, is not judged", () => {
    expect(check(paced("by_feel", 240, 250))).toEqual([]);
    expect(check(paced("strides", 200, 210))).toEqual([]);
    // A pace written is no pace owed.
    expect(check(paced("tempo", 240, 250), { thresholdSecPerKm: null })).toEqual([]);
  });

  it("race pace is judged against the race's own distance", () => {
    const race = (fast: number, slow: number) => docOf([part("run", "steady", [run("race", { distanceM: 10000, pace: { fastSecPerKm: fast, slowSecPerKm: slow } })])], "peak");
    expect(check(race(280, 285))).toEqual([]);
    expect(codes(check(race(230, 235)))).toEqual(["error:run_pace_far@parts[0].items[0].target.pace"]);
  });
});

describe("run_pace_owed", () => {
  it("with no threshold known, a warning: the watch shows time only", () => {
    const issues = check(TEMPO, { thresholdSecPerKm: null });
    expect(codes(issues)).toEqual(["warning:run_pace_owed@parts"]);
    expect(issues[0]!.message).toBe("No threshold pace is known yet, so the watch shows this run's time with no pace targets.");
  });

  it("a distance can't be timed without one: it says the run stays off the watch", () => {
    const issues = check(docOf([part("run", "steady", [run("easy", { distanceM: 5000 })])], "maintain"), { thresholdSecPerKm: null });
    expect(issues[0]!.message).toBe("No threshold pace is known yet, so the watch can't time this run's distances: it stays off the watch until one is.");
  });

  it("efforts with no band owe none", () => {
    expect(check(docOf([part("run", "steady", [run("by_feel", { durationSec: 1800 }), run("strides", { durationSec: 20 })])], "maintain"), { thresholdSecPerKm: null })).toEqual([]);
  });
});

describe("run_hard_close", () => {
  it("a hard run the day before or after another hard run, or hard leg strength, is a cost", () => {
    const before = check(TEMPO, { nearby: [{ date: addDays(DAY, -1), kind: "quality_run", title: "Intervals" }] });
    expect(codes(before)).toEqual(["warning:run_hard_close@intent.effort"]);
    expect(before[0]!.message).toBe("Intervals is the day before: hard running wants 48 hours from other hard running and hard leg strength.");
    const legs = check(TEMPO, { nearby: [{ date: DAY, kind: "hard_legs", title: "Lower body" }] });
    expect(legs[0]!.message).toBe("Lower body is the same day: hard running wants 48 hours from other hard running and hard leg strength.");
    expect(check(TEMPO, { nearby: [{ date: addDays(DAY, 1), kind: "hard_legs", title: "Legs" }] })[0]!.message).toMatch(/^Legs is the day after:/);
  });

  it("two days apart is clear, and an easy run is never hard", () => {
    expect(check(TEMPO, { nearby: [{ date: addDays(DAY, 2), kind: "quality_run", title: "Intervals" }] })).toEqual([]);
    expect(check(EASY, { nearby: [{ date: addDays(DAY, -1), kind: "quality_run", title: "Intervals" }] })).toEqual([]);
  });
});

describe("run_long_share", () => {
  it("a long run past about 30% of the week's running is a cost", () => {
    const issues = check(LONG, { weekMinutes: 150, fourWeekAvgMinutes: 400 });
    expect(codes(issues)).toEqual(["warning:run_long_share@parts"]);
    expect(issues[0]!.message).toBe("This long run is 40% of the week's running (100 of 250 minutes); about 30% keeps it in proportion.");
    // Nothing else planned that week yet: no proportion to judge.
    expect(check(LONG, { weekMinutes: 0, fourWeekAvgMinutes: 400 })).toEqual([]);
    // A tempo run is no long run.
    expect(check(TEMPO, { weekMinutes: 30, fourWeekAvgMinutes: 400 })).toEqual([]);
  });
});

describe("run_volume_jump", () => {
  it("a week more than about 10% over the last four weeks' average is a cost", () => {
    const issues = check(TEMPO, { weekMinutes: 200, fourWeekAvgMinutes: 200 });
    expect(codes(issues)).toEqual(["warning:run_volume_jump@parts"]);
    expect(issues[0]!.message).toBe("With this run the week's running comes to 250 minutes, 25% over your last four weeks' average of 200 a week.");
    expect(check(TEMPO, { weekMinutes: 170, fourWeekAvgMinutes: 200 })).toEqual([]);
    // Just past 10% (221 of 200) is a cost; 10% itself (220, above) is not.
    expect(codes(check(TEMPO, { weekMinutes: 171, fourWeekAvgMinutes: 200 }))).toEqual(["warning:run_volume_jump@parts"]);
    expect(check(TEMPO, { weekMinutes: 500, fourWeekAvgMinutes: null })).toEqual([]);
    expect(check(TEMPO, { weekMinutes: 500, fourWeekAvgMinutes: 0 })).toEqual([]);
  });
});
