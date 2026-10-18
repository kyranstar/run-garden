/**
 * THE RUN CARD'S FACTS (§8 §3): a designed run's line in the proposal's manifest carries its steps as the watch will
 * get them — each part's steps once (its rounds beside them), each step its role, effort, time or distance, the pace
 * band from the athlete's threshold (or the one asked for), and a distance's time on the watch — computed by the same
 * function the wire builds from (`runWatchSteps`: the preview is the wire); its totals; and what the watch will do when it
 * is approved. The conversation's card of it says it is a run. Synthetic data.
 */
import { describe, expect, it } from "vitest";
import { runWatchSteps, runWatchSessionOf, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { userPreferencesSchema } from "@rg/domain";
import { cardsOf } from "../src/services/coach-conversation.js";
import type { DesignedOp } from "../src/services/design-approve.js";
import { docWorkoutLines } from "../src/services/design-manifest.js";
import { designedRunStages } from "../src/services/designed-runs.js";
import { buildProgramFor } from "@rg/coros";

const NOW = new Date("2026-03-10T16:00:00Z");
const prefs: UserPreferences = userPreferencesSchema.parse({ timezone: "UTC" });
const DOC: WorkoutDoc = {
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 }, why: "Ease in." }] },
    { purpose: "run", format: "intervals", rounds: 3, items: [
      { kind: "run", effort: "tempo", target: { durationSec: 480 }, why: "Comfortably hard." },
      { kind: "run", effort: "recovery", target: { durationSec: 120 } },
    ] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { distanceM: 2000 }, why: "Settle." }] },
  ],
  source: { kind: "coach" },
};
const op = (doc: WorkoutDoc): DesignedOp =>
  ({ kind: "doc_workout", target: { kind: "new", date: "2026-03-12" }, date: "2026-03-12", doc, issues: [], derived: {}, review: null, by: { runId: "r-1", role: "main" }, toolUseId: "t-1", round: 1 }) as unknown as DesignedOp;
const place = () => "Home";

describe("a designed run's line", () => {
  it("its steps, each part once with its rounds, as the watch gets them — the wire's own numbers", () => {
    const [line] = docWorkoutLines([op(DOC)], place, { now: NOW, prefs }, { thresholdSecPerKm: 289, corosWritesEnabled: true });
    expect(line!.run).toEqual({
      segments: [
        { rounds: 1, steps: [{ role: "warmup", effort: "easy", seconds: 600, meters: null, pace: { fastSecPerKm: 349, slowSecPerKm: 409 }, asked: false, why: "Ease in." }] },
        {
          rounds: 3,
          steps: [
            { role: "work", effort: "tempo", seconds: 480, meters: null, pace: { fastSecPerKm: 299, slowSecPerKm: 314 }, asked: false, why: "Comfortably hard." },
            { role: "recovery", effort: "recovery", seconds: 120, meters: null, pace: { fastSecPerKm: 379, slowSecPerKm: 439 }, asked: false, why: null },
          ],
        },
        { rounds: 1, steps: [{ role: "cooldown", effort: "easy", seconds: 758, meters: 2000, pace: { fastSecPerKm: 349, slowSecPerKm: 409 }, asked: false, why: "Settle." }] },
      ],
      totalSeconds: 600 + 3 * 600 + 758,
      totalMeters: runWatchSteps((runWatchSessionOf(DOC) as { session: never }).session, 289).totalMeters,
      watch: "goes",
    });
    // Its minutes are the watch's: the distance at its pace, not a guessed one.
    expect(line!.minutes).toBe(Math.round((600 + 3 * 600 + 758) / 60));
  });

  it("what the watch does when it's approved: time only with no threshold, not yet when a distance can't be timed, nothing said with writes off", () => {
    const timed: WorkoutDoc = { ...DOC, parts: DOC.parts.slice(0, 2) };
    expect(docWorkoutLines([op(timed)], place, { now: NOW, prefs }, { thresholdSecPerKm: null, corosWritesEnabled: true })[0]!.run!.watch).toBe("time_only");
    // One step owing its pace is time only; a run whose efforts take no band (by feel) owes none: it goes as designed.
    const one: WorkoutDoc = { ...DOC, parts: DOC.parts.slice(0, 1) };
    expect(docWorkoutLines([op(one)], place, { now: NOW, prefs }, { thresholdSecPerKm: null, corosWritesEnabled: true })[0]!.run!.watch).toBe("time_only");
    const byFeel: WorkoutDoc = { ...DOC, parts: [{ purpose: "run", format: "steady", items: [{ kind: "run", effort: "by_feel", target: { durationSec: 1800 } }] }] };
    expect(docWorkoutLines([op(byFeel)], place, { now: NOW, prefs }, { thresholdSecPerKm: null, corosWritesEnabled: true })[0]!.run!.watch).toBe("goes");
    expect(docWorkoutLines([op(DOC)], place, { now: NOW, prefs }, { thresholdSecPerKm: null, corosWritesEnabled: true })[0]!.run!.watch).toBe("needs_threshold");
    expect(docWorkoutLines([op(DOC)], place, { now: NOW, prefs }, { thresholdSecPerKm: 289, corosWritesEnabled: false })[0]!.run!.watch).toBeNull();
  });

  it("a workout that isn't a run has none", () => {
    const strength: WorkoutDoc = { ...DOC, parts: [{ purpose: "main", format: "straight", items: [{ kind: "exercise", libraryId: "bridge", dose: { sets: 2, reps: 10 } }] }] };
    expect(docWorkoutLines([op(strength)], place, { now: NOW, prefs }, { thresholdSecPerKm: 289, corosWritesEnabled: true })[0]!.run).toBeUndefined();
  });
});

describe("the conversation's card of a run", () => {
  it("says it is a run (`sport: \"run\"`, the seam), and nothing for a workout", () => {
    const brief = (discipline: string) => ({ kind: "doc_workout" as const, date: "2026-03-12", time: null, atNow: null, title: "Tempo blocks", minutes: 50, effort: "develop", by: "main", change: null, row: null, outcome: null, reason: null, discipline });
    const [run] = cardsOf(null, { id: "dp-1", title: "Tempo blocks", status: "pending", ops: [brief("run")] }, "2026-03-10");
    expect(run).toMatchObject({ kind: "workout", sport: "run", title: "Tempo blocks" });
    const [lift] = cardsOf(null, { id: "dp-2", title: "Hips", status: "pending", ops: [brief("strength")] }, "2026-03-10");
    expect(lift).not.toHaveProperty("sport");
  });
});

describe("a pace the athlete named, in whole seconds everywhere (review-2 I1)", () => {
  it("the card, the stage rows and the wire agree: 8:00–8:20 /mi is 298–311 s/km, 298000–311000 on the wire", () => {
    const named: WorkoutDoc = {
      ...DOC,
      parts: [{ purpose: "run", format: "steady", items: [{ kind: "run", effort: "steady", target: { durationSec: 1200, pace: { fastSecPerKm: 480 / 1.609344, slowSecPerKm: 500 / 1.609344 } } }] }],
    };
    const [line] = docWorkoutLines([op(named)], place, { now: NOW, prefs }, { thresholdSecPerKm: 289, corosWritesEnabled: true });
    expect(line!.run!.segments[0]!.steps[0]).toMatchObject({ pace: { fastSecPerKm: 298, slowSecPerKm: 311 }, asked: true });
    const [stage] = designedRunStages("wo-1", named, 289);
    expect(stage).toMatchObject({ targetType: "pace", targetLow: 298, targetHigh: 311 });
    const session = (runWatchSessionOf(named) as { session: never }).session;
    const [step] = buildProgramFor({ happenDay: "20260312", name: "Steady", session, thresholdPaceSecPerKm: 289 }, new Map()).exercises!;
    expect(step).toMatchObject({ intensityValue: 298_000, intensityValueExtend: 311_000 });
  });
});
