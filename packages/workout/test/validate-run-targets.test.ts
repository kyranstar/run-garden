/**
 * A RUN STEP'S TARGET, AS THE WATCH WILL RUN IT (2026-10-18, decision guidance): the validator says what a step's own
 * target would silently lose — a race step set by time carries no pace (race pace is worked out for a distance:
 * `run_race_by_time`), and a step with both a time and a distance runs by its time (`run_time_and_distance`). Both are
 * notes, never refusals. And a stored document whose run target holds a heart-rate range or a zone (no longer offered
 * to the model) still validates, plays and goes to the watch: the domain's schema is unchanged.
 */
import { describe, expect, it } from "vitest";
import { parseStoredWorkoutDoc, runWatchSessionOf, type WorkoutDoc, type WorkoutItem, type WorkoutPart } from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { playerStepsFromDoc, validateWorkoutDoc, type DocIssue, type RunCtx, type ValidateCtx } from "../src/index.js";

const DAY = "2026-03-10";
const run = (effort: string, target: Record<string, unknown>): WorkoutItem => ({ kind: "run", effort, target }) as WorkoutItem;
const docOf = (items: WorkoutItem[]): WorkoutDoc =>
  ({
    version: 1,
    title: "Run",
    intent: { summary: "A run.", goals: [], focus: [], effort: "develop" },
    parts: [
      { purpose: "warmup", format: "steady", items: [run("easy", { durationSec: 600 })] },
      { purpose: "run", format: "steady", items } as WorkoutPart,
      { purpose: "cooldown", format: "steady", items: [run("easy", { durationSec: 600 })] },
    ],
    source: { kind: "coach" },
  }) as WorkoutDoc;

const RUN: RunCtx = { thresholdSecPerKm: 289, nearby: [], weekMinutes: 0, fourWeekAvgMinutes: null };
function check(doc: WorkoutDoc, runCtx: RunCtx | null = RUN): DocIssue[] {
  const ctx: ValidateCtx = { library: EXERCISES, activeProfiles: [], day: { date: DAY, today: DAY, readings: {} }, ...(runCtx ? { run: runCtx } : {}) };
  return validateWorkoutDoc(doc, ctx);
}
const codes = (issues: readonly DocIssue[]): string[] => issues.map((i) => `${i.severity}:${i.code}@${i.path}`);

describe("run_race_by_time: a race step set by time has no pace on the watch", () => {
  it("is a note at the step's target — with or without the athlete's running, with or without a threshold", () => {
    const doc = docOf([run("race", { durationSec: 1200 })]);
    const issues = check(doc);
    expect(codes(issues)).toEqual(["warning:run_race_by_time@parts[1].items[0].target"]);
    expect(issues[0]!.message).toBe("Race pace is worked out for a distance, so this race step, set by time, has no pace on the watch: give it its distance, or a pace.");
    expect(codes(check(doc, null))).toEqual(["warning:run_race_by_time@parts[1].items[0].target"]);
    expect(codes(check(doc, { ...RUN, thresholdSecPerKm: null }))).toContain("warning:run_race_by_time@parts[1].items[0].target");
  });

  it("says nothing of a race step by distance, one with a pace written, or another effort by time", () => {
    expect(check(docOf([run("race", { distanceM: 5000 })]))).toEqual([]);
    expect(check(docOf([run("race", { durationSec: 1200, pace: { fastSecPerKm: 240, slowSecPerKm: 248 } })]))).toEqual([]);
    expect(check(docOf([run("threshold", { durationSec: 1200 })]))).toEqual([]);
  });
});

describe("run_time_and_distance: a step with both runs by its time", () => {
  it("is a note at the step's target; a race step with both is by time too, so it has no pace either", () => {
    const both = check(docOf([run("tempo", { durationSec: 1200, distanceM: 4000 })]));
    expect(codes(both)).toEqual(["warning:run_time_and_distance@parts[1].items[0].target"]);
    expect(both[0]!.message).toBe("This step has both a time and a distance; the watch runs it by its time.");
    expect(codes(check(docOf([run("race", { durationSec: 1200, distanceM: 5000 })])))).toEqual([
      "warning:run_time_and_distance@parts[1].items[0].target",
      "warning:run_race_by_time@parts[1].items[0].target",
    ]);
  });
});

describe("a stored run target with a heart-rate range or a zone (no longer offered to the model)", () => {
  it("still parses, validates clean, plays, and goes to the watch by its time and effort", () => {
    const stored = JSON.stringify(docOf([run("easy", { durationSec: 1800, hr: { low: 120, high: 145 }, zone: { kind: "hr", index: 2 }, typed: "30 min" })]));
    const doc = parseStoredWorkoutDoc(stored);
    expect(doc).not.toBeNull();
    expect(check(doc!)).toEqual([]);
    expect(playerStepsFromDoc(doc!, EXERCISES).length).toBe(3);
    const made = runWatchSessionOf(doc!);
    expect("session" in made && made.session.segments[1]!.steps[0]).toEqual({ role: "work", effort: "easy", target: { kind: "time", seconds: 1800 } });
  });
});
