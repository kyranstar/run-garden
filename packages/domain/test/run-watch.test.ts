/**
 * A designed run on the watch (§8 §3, phase 1): the document's run parts become the job's `run_watch` session, and
 * `runWatchSteps` resolves it — the one function the run card and the wire builder both read ("the preview is the
 * wire").
 */
import { describe, expect, it } from "vitest";
import {
  isRunDoc,
  isRunWatchSession,
  RUN_EFFORT_LABELS,
  RUN_EFFORTS,
  RUN_WATCH_MAX_STEPS,
  runWatchSessionOf,
  runWatchSessionSchema,
  runWatchSteps,
  type RunWatchSession,
  type WorkoutDoc,
} from "../src/index.js";

const tempoRun = (): WorkoutDoc => ({
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks to lift the threshold.", goals: ["speed"], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 }, why: "Ease in." }] },
    {
      purpose: "run",
      format: "intervals",
      rounds: 3,
      items: [
        { kind: "run", effort: "tempo", target: { durationSec: 480 }, why: "Comfortably hard." },
        { kind: "run", effort: "recovery", target: { durationSec: 120 } },
      ],
    },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { distanceM: 2000 } }] },
  ],
  source: { kind: "coach", ref: "run:r1" },
});

const sessionOf = (doc: WorkoutDoc): RunWatchSession => {
  const made = runWatchSessionOf(doc);
  if (!("session" in made)) throw new Error(`refused: ${made.refused}`);
  return made.session;
};

describe("RUN_EFFORT_LABELS", () => {
  it("names every effort in plain words", () => {
    expect(Object.keys(RUN_EFFORT_LABELS).sort()).toEqual([...RUN_EFFORTS].sort());
    expect(RUN_EFFORT_LABELS.by_feel).toBe("By feel");
    expect(RUN_EFFORT_LABELS.race).toBe("Race pace");
  });
});

describe("isRunDoc", () => {
  it("is a document of run segments (and rests) only", () => {
    expect(isRunDoc(tempoRun())).toBe(true);
    const mixed = tempoRun();
    mixed.parts[0]!.items.push({ kind: "exercise", libraryId: "glute-bridge", dose: { reps: 10 } });
    expect(isRunDoc(mixed)).toBe(false);
    const rests: WorkoutDoc = { ...tempoRun(), parts: [{ purpose: "main", format: "straight", items: [{ kind: "rest", seconds: 60 }] }] };
    expect(isRunDoc(rests)).toBe(false);
  });
});

describe("runWatchSessionOf", () => {
  it("makes one segment per part: its rounds, and each item's role, effort and target", () => {
    expect(sessionOf(tempoRun())).toEqual({
      kind: "run_watch",
      title: "Tempo blocks",
      segments: [
        { rounds: 1, steps: [{ role: "warmup", effort: "easy", target: { kind: "time", seconds: 600 } }] },
        {
          rounds: 3,
          steps: [
            { role: "work", effort: "tempo", target: { kind: "time", seconds: 480 } },
            { role: "recovery", effort: "recovery", target: { kind: "time", seconds: 120 } },
          ],
        },
        { rounds: 1, steps: [{ role: "cooldown", effort: "easy", target: { kind: "distance", meters: 2000 } }] },
      ],
    });
    expect(runWatchSessionSchema.safeParse(sessionOf(tempoRun())).success).toBe(true);
  });

  it("keeps a pace the coach wrote (asked for) and a standing rest", () => {
    const doc = tempoRun();
    doc.parts[1] = {
      purpose: "run",
      format: "intervals",
      rounds: 2,
      restBetweenRoundsSec: 90,
      items: [
        { kind: "run", effort: "race", target: { distanceM: 1000, pace: { fastSecPerKm: 280, slowSecPerKm: 285 } } },
        { kind: "rest", seconds: 60 },
      ],
    };
    expect(sessionOf(doc).segments[1]).toEqual({
      rounds: 2,
      restBetweenRoundsSec: 90,
      steps: [
        { role: "work", effort: "race", target: { kind: "distance", meters: 1000 }, pace: { fastSecPerKm: 280, slowSecPerKm: 285 } },
        { role: "recovery", target: { kind: "time", seconds: 60 } },
      ],
    });
  });

  it("refuses what the wire can't hold: a move among the runs, an open segment, more than the watch's steps", () => {
    const mixed = tempoRun();
    mixed.parts[0]!.items.push({ kind: "exercise", libraryId: "glute-bridge", dose: { reps: 10 } });
    expect(runWatchSessionOf(mixed)).toEqual({ refused: "mixed" });
    const open = tempoRun();
    open.parts[2]!.items[0] = { kind: "run", effort: "easy", target: { open: true } };
    expect(runWatchSessionOf(open)).toEqual({ refused: "open" });
    const long = tempoRun();
    long.parts[1]!.rounds = 29; // 1 + 58 + 1 = 60: the most
    expect("session" in runWatchSessionOf(long)).toBe(true);
    long.parts[1]!.rounds = 30; // 62
    expect(runWatchSessionOf(long)).toEqual({ refused: "too_many_steps" });
    expect(RUN_WATCH_MAX_STEPS).toBe(60);
  });

  it("counts the rests between rounds among the steps", () => {
    const doc = tempoRun();
    doc.parts[1]!.rounds = 20;
    doc.parts[1]!.restBetweenRoundsSec = 30; // 1 + 40 + 19 + 1 = 61
    expect(runWatchSessionOf(doc)).toEqual({ refused: "too_many_steps" });
  });
});

describe("runWatchSteps — the steps on the watch, from the freshest threshold", () => {
  it("writes the repeats out, each step's pace band from its effort, a distance at its band's middle", () => {
    const r = runWatchSteps(sessionOf(tempoRun()), 289);
    expect(r.steps.map((s) => [s.role, s.effort, s.seconds])).toEqual([
      ["warmup", "easy", 600],
      ["work", "tempo", 480],
      ["recovery", "recovery", 120],
      ["work", "tempo", 480],
      ["recovery", "recovery", 120],
      ["work", "tempo", 480],
      ["recovery", "recovery", 120],
      // 2 km at easy's middle (379 s/km).
      ["cooldown", "easy", 758],
    ]);
    expect(r.steps[1]!.pace).toEqual({ fastSecPerKm: 299, slowSecPerKm: 314 });
    expect(r.steps[1]!.paceFrom).toBe("threshold");
    expect(r.steps[7]).toMatchObject({ meters: 2000, pace: { fastSecPerKm: 349, slowSecPerKm: 409 } });
    expect(r.totalSeconds).toBe(600 + 3 * 600 + 758);
    expect(r.distanceAsTime).toBe(1);
    expect(r.paceOwed).toBe(0);
    expect(r.unresolved).toBe(0);
    // Each timed step at its band's middle, the distance as asked.
    const meters = (600 / 379 + 3 * (480 / 306.5 + 120 / 409)) * 1000 + 2000;
    expect(r.totalMeters).toBe(Math.round(meters));
  });

  it("puts a standing rest between rounds, never after the last", () => {
    const doc = tempoRun();
    doc.parts[1]!.restBetweenRoundsSec = 45;
    const steps = runWatchSteps(sessionOf(doc), 289).steps;
    expect(steps.map((s) => s.seconds)).toEqual([600, 480, 120, 45, 480, 120, 45, 480, 120, 758]);
    expect(steps[3]).toEqual({ role: "recovery", seconds: 45, pace: null, paceFrom: null });
  });

  it("an asked pace wins over the effort's; strides and by feel carry none", () => {
    const doc = tempoRun();
    doc.parts[1] = {
      purpose: "run",
      format: "intervals",
      rounds: 1,
      items: [
        { kind: "run", effort: "race", target: { distanceM: 1000, pace: { fastSecPerKm: 280, slowSecPerKm: 290 } } },
        { kind: "run", effort: "strides", target: { distanceM: 100 } },
        { kind: "run", effort: "by_feel", target: { durationSec: 300 } },
      ],
    };
    const [, race, strides, feel] = runWatchSteps(sessionOf(doc), 289).steps;
    expect(race).toMatchObject({ seconds: 285, pace: { fastSecPerKm: 280, slowSecPerKm: 290 }, paceFrom: "asked" });
    // 100 m at interval's middle (276.5 s/km), with no target of its own.
    expect(strides).toMatchObject({ seconds: 28, meters: 100, pace: null, paceFrom: null });
    expect(feel).toMatchObject({ seconds: 300, pace: null });
  });

  it("with no threshold: no step carries a pace (each owed one), and a distance can't be timed", () => {
    const r = runWatchSteps(sessionOf(tempoRun()), null);
    expect(r.steps.every((s) => s.pace === null)).toBe(true);
    expect(r.paceOwed).toBe(8);
    expect(r.unresolved).toBe(1);
    expect(r.steps[7]).toMatchObject({ seconds: null, meters: 2000 });
    expect(r.totalMeters).toBeNull();
    expect(r.totalSeconds).toBeNull();
  });
});

describe("isRunWatchSession", () => {
  it("knows the job's run session by its kind", () => {
    expect(isRunWatchSession(sessionOf(tempoRun()))).toBe(true);
    expect(isRunWatchSession({ kind: "program_watch" })).toBe(false);
    expect(isRunWatchSession({ title: "Easy", run: { blocks: [] } })).toBe(false);
  });
});
