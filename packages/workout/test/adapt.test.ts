/**
 * ADAPTERS OUT (programme spec §3.3): the document back to the calendar's stages and to the player's steps. The player's
 * steps are the document's steps (principles §3.2, one builder per output): for 50 seeded engine builds, the steps the
 * document plays are the steps the build plays — order, moves, sides, sets, seconds, reps, weights, rests, formats and
 * reasons.
 */
import { describe, expect, it } from "vitest";
import { WATCH_MAX_STEPS, workoutDocSchema, type PlannedStage, type WorkoutDoc } from "@rg/domain";
import { isPlyometric, type ExerciseRecord } from "@rg/exercise-library";
import type { Step } from "@rg/session-engine";
import { DocTooLargeError, deriveDoc, docFromBuild, docSlotKeys, placementFor, playerStepsFromDoc, stagesFromDoc } from "../src/index.js";
import { LIBRARY, jumpDayBuilds, seededBuilds, stored } from "./seeded-builds.js";

/** A circuit station: it plays the circuit's work window, whatever hold its move's target suggests. */
const circuitStation = (s: Step): boolean => s.kind === "timed" && s.format.id === "circuit";

/**
 * What a step plays: everything but its slot key (the document numbers slots by play order), the new-move flag, the
 * target's history (the last session's summary and date, the progression action, the move it graduates to), and a
 * circuit station's suggested hold — the document's known gaps (from-build.ts), the last pinned on its own below.
 */
function played(s: Step) {
  return {
    kind: s.kind, block: s.block, exerciseId: s.exerciseId, side: s.side, setIndex: s.setIndex, setCount: s.setCount,
    seconds: s.seconds, prepGap: s.prepGap, log: s.log, format: s.format, why: s.why,
    target: s.target === null ? null : {
      lo: s.target.lo ?? null, hi: s.target.hi ?? null, type: s.target.type ?? null,
      reps: s.target.reps ?? null, w: s.target.w ?? null, note: s.target.note ?? "",
      ...(circuitStation(s) ? {} : { secs: s.target.secs ?? null }),
    },
  };
}

describe("playerStepsFromDoc(docFromBuild(b)) is the build's own steps — 50 seeded builds", () => {
  const builds = seededBuilds(50);

  it("every build, step for step", () => {
    for (const { label, plan } of builds) {
      const doc = docFromBuild(stored(plan));
      expect(workoutDocSchema.safeParse(doc).success, label).toBe(true);
      expect(playerStepsFromDoc(doc, LIBRARY).map(played), label).toEqual(plan.steps.map(played));
    }
  });

  it("the builds cover every format, both sides, swaps, loads in both units, and rests", () => {
    const steps = builds.flatMap((b) => b.plan.steps);
    expect(new Set(steps.map((s) => s.format.id))).toEqual(new Set(["straight", "superset", "circuit", "ladder", "flow", "holds"]));
    expect(steps.some((s) => s.side === "Left")).toBe(true);
    expect(steps.some((s) => s.kind === "rest")).toBe(true);
    expect(new Set(steps.flatMap((s) => (s.target?.w ? [s.target.w.u] : [])))).toEqual(new Set(["lb", "kg"]));
    expect(builds.some((b) => b.label.includes("swap"))).toBe(true);
  });

  it("the one target the document cannot give back: a held move's suggested hold in a circuit, which plays the window", () => {
    // The part has no work window of its own, so a station's hold is the window the circuit plays (what the athlete
    // does); the hold the move's progression suggested, which the circuit does not play, has no place in the document.
    let differ = 0;
    for (const { plan } of builds) {
      const mine = playerStepsFromDoc(docFromBuild(stored(plan)), LIBRARY);
      plan.steps.forEach((s, i) => {
        if ((s.target?.secs ?? null) === (mine[i]!.target?.secs ?? null)) return;
        differ += 1;
        expect([circuitStation(s), s.target?.type, mine[i]!.target?.secs]).toEqual([true, "time", s.seconds]);
      });
    }
    expect(differ).toBeGreaterThan(0);
  });

  it("a slot's steps keep play order slot keys within each block", () => {
    const { plan } = builds[0]!;
    const steps = playerStepsFromDoc(docFromBuild(stored(plan)), LIBRARY);
    const work = steps.filter((s) => s.kind !== "rest");
    for (const s of work) expect(s.slotKey.startsWith(`${s.block}:`)).toBe(true);
  });
});

describe("jumps live in one place (final review I1): an engine jumping day → the document → the player", () => {
  const builds = jumpDayBuilds(12);
  const byId = new Map(LIBRARY.map((e) => [e.id, e]));
  const jumpy = (id: string | null) => Boolean(id && byId.get(id) && isPlyometric(byId.get(id)!));

  it("the jumps block is a power part in the document, and plays back as the build's own steps, in the accessory block", () => {
    let withJumps = 0;
    for (const { label, plan } of builds) {
      const doc = docFromBuild(stored(plan));
      expect(workoutDocSchema.safeParse(doc).success, label).toBe(true);
      const jumpParts = doc.parts.filter((p) => p.items.some((i) => i.kind === "exercise" && jumpy(i.libraryId)));
      if (plan.items.some((it) => isPlyometric(it.exercise))) {
        withJumps += 1;
        expect(jumpParts.map((p) => [p.purpose, p.format === "straight" || p.format === "superset"]), label).toEqual([["power", true]]);
        // Only jumps in it, as the engine's block holds.
        expect(jumpParts[0]!.items.every((i) => i.kind === "exercise" && jumpy(i.libraryId)), label).toBe(true);
      }
      const steps = playerStepsFromDoc(doc, LIBRARY);
      expect(steps.map(played), label).toEqual(plan.steps.map(played));
      // Never the core block: the worker counts any core block as a core lift.
      expect(steps.filter((s) => jumpy(s.exerciseId)).every((s) => s.block === "accessory"), label).toBe(true);
    }
    expect(withJumps, "jumping days that held jumps").toBeGreaterThanOrEqual(8);
  });

  it("the Studio puts a jump in the power part too, whatever else it is for", () => {
    for (const rec of LIBRARY.filter(isPlyometric)) expect(placementFor(rec), rec.id).toBe("power");
    const jump = LIBRARY.find((e) => e.id === "pogoHop")!;
    expect(placementFor({ ...jump, purposes: ["activation", "power"] })).toBe("power");
  });
});

describe("a document's size is bounded (final review I4): it is refused before a step is built", () => {
  const big = (parts: number, items: number): WorkoutDoc =>
    workoutDocSchema.parse({
      version: 1, title: "Huge", intent: { summary: "S", goals: [], focus: [], effort: "maintain" }, source: { kind: "coach" },
      parts: Array.from({ length: parts }, () => ({
        purpose: "main", format: "straight", rounds: 50,
        items: Array.from({ length: items }, () => ({ kind: "exercise", libraryId: "gobletSquat", dose: { sets: 20, reps: 8, perSide: true, restSec: 900 } })),
      })),
    });

  it("1,200 items (20 parts of 60) are refused with a typed error, quickly", () => {
    const doc = big(20, 60);
    const started = Date.now();
    expect(() => playerStepsFromDoc(doc, LIBRARY)).toThrow(DocTooLargeError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("past the watch's steps or 600 minutes it is refused; at the limit it plays", () => {
    const steps = (n: number): WorkoutDoc => workoutDocSchema.parse({
      version: 1, title: "T", intent: { summary: "S", goals: [], focus: [], effort: "maintain" }, source: { kind: "coach" },
      parts: [{ purpose: "main", format: "circuit", rounds: n / 5, items: Array.from({ length: 5 }, () => ({ kind: "exercise", libraryId: "deadBug", dose: { sets: 1, holdSec: 5 } })) }],
    });
    expect(deriveDoc(steps(WATCH_MAX_STEPS), LIBRARY).watchStepCount).toBe(WATCH_MAX_STEPS);
    expect(playerStepsFromDoc(steps(WATCH_MAX_STEPS), LIBRARY).length).toBeGreaterThan(0);
    expect(() => playerStepsFromDoc(steps(WATCH_MAX_STEPS + 5), LIBRARY)).toThrow(DocTooLargeError);
    const long = workoutDocSchema.parse({
      version: 1, title: "T", intent: { summary: "S", goals: [], focus: [], effort: "maintain" }, source: { kind: "coach" },
      parts: [{ purpose: "main", format: "holds", items: [{ kind: "exercise", libraryId: "deadBug", dose: { sets: 11, holdSec: 3600 } }] }],
    });
    expect(deriveDoc(long, LIBRARY).estimatedMinutes).toBeGreaterThan(600);
    expect(() => playerStepsFromDoc(long, LIBRARY)).toThrow(DocTooLargeError);
  });
});

// ── Any document, not only an engine build ────────────────────────────────────────────────────────────────────────

const rec = (over: Partial<ExerciseRecord> & { id: string }): ExerciseRecord =>
  ({
    legacyIds: [], name: over.id, family: over.id, patterns: [], regions: [], roles: [], equipment: { all: [], oneOf: [] },
    position: "standing", laterality: "bilateral", load: "external", dose: { type: "reps", range: [8, 12], restSec: 60 }, difficulty: 2,
    easier: [], harder: [], tags: [], contraction: ["isotonic"], muscles: { primary: [], secondary: [] }, purposes: ["strength"], themes: [],
    text: { summary: "", setup: [], steps: [], focus: ["Focus."], mistakes: [], breathing: "", why: "", conditions: {} }, conditions: {},
    ...over,
  }) as ExerciseRecord;

const LIB: ExerciseRecord[] = [
  rec({ id: "gobletSquat", name: "Goblet squat", legacyIds: ["kbGobletSquat"] }),
  rec({ id: "sidePlank", name: "Side plank", laterality: "unilateral", load: "bodyweight", dose: { type: "time", range: [20, 40] } }),
];

const doc = (parts: WorkoutDoc["parts"]): WorkoutDoc =>
  workoutDocSchema.parse({ version: 1, title: "T", intent: { summary: "S", goals: [], focus: [], effort: "maintain" }, parts, source: { kind: "coach" } });

describe("playerStepsFromDoc — any document", () => {
  it("a legacy id plays as the move it now is (Review Focus 1)", () => {
    const steps = playerStepsFromDoc(doc([{ purpose: "main", format: "straight", items: [
      { kind: "exercise", libraryId: "kbGobletSquat", dose: { sets: 2, reps: 8, load: { typed: "35 lb", kg: 15.88 }, restSec: 90 } },
    ] }]), LIB);
    expect(steps.map((s) => [s.kind, s.exerciseId, s.seconds])).toEqual([["set", "gobletSquat", 8 * 3 + 10], ["rest", null, 90], ["set", "gobletSquat", 34]]);
    // Review Focus 3: the weight comes back as typed.
    expect(steps[0]!.target).toMatchObject({ reps: 8, w: { v: 35, u: "lb" } });
  });

  it("a load typed in words no unit reads plays as its kilograms (\"2 x 20kg\", \"20kg each\", …)", () => {
    const typed: Array<[string, number]> = [["2 x 20kg", 20], ["20kg each", 20], ["20 kg per hand", 20], ["16kg kettlebell", 16], ["35 lb", 15.88]];
    const steps = playerStepsFromDoc(doc([{ purpose: "main", format: "straight", items: typed.map(([t, kg]) => (
      { kind: "exercise" as const, libraryId: "gobletSquat", dose: { sets: 1, reps: 8, load: { typed: t, kg }, restSec: 0 } }
    )) }]), LIB);
    // What a unit reads stays as typed ("35 lb"); the rest is the load's own kilograms.
    expect(steps.map((s) => s.target?.w)).toEqual([{ v: 20, u: "kg" }, { v: 20, u: "kg" }, { v: 20, u: "kg" }, { v: 16, u: "kg" }, { v: 35, u: "lb" }]);
  });

  it("seconds with no hold are the engine's own, read from the document's reps, tempo and sides", () => {
    const steps = playerStepsFromDoc(doc([
      { purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 1, reps: 8, tempo: { eccentricSec: 3, pauseSec: 1, concentricSec: 1 }, perSide: true, restSec: 0 } },
      ] },
      { purpose: "accessory", format: "holds", items: [
        { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 1, reps: 15 } },
        { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 1 } },
      ] },
    ]), LIB);
    // A set: 8 reps x 5 s (the tempo) x 2 sides + 10 s to log. A window: 15 reps x 4 s; with no reps, the record's 10.
    expect(steps.map((s) => [s.kind, s.seconds])).toEqual([["set", 90], ["timed", 60], ["timed", 40]]);
  });

  it("a timed window's target holds seconds only for a move held by time: a reps move's window is the format's", () => {
    const steps = playerStepsFromDoc(doc([{ purpose: "main", format: "holds", items: [
      { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 1, holdSec: 40, load: { typed: "16 kg", kg: 16 } } },
      { kind: "exercise", libraryId: "sidePlank", dose: { sets: 1, holdSec: 30, perSide: true, load: "bodyweight" } },
      { kind: "free_exercise", name: "Wall sit", dose: { sets: 1, holdSec: 45, load: "bodyweight" } },
    ] }]), LIB);
    expect(steps.map((s) => [s.exerciseId, s.seconds, s.target?.secs])).toEqual([
      ["gobletSquat", 40, null], ["sidePlank", 30, 30], ["sidePlank", 30, 30], [null, 45, 45],
    ]);
  });

  it("a per-side hold plays a left and a right window; a free-text move and a run segment play with no move id", () => {
    const steps = playerStepsFromDoc(doc([
      { purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "sidePlank", dose: { sets: 1, holdSec: 30, perSide: true, load: "bodyweight" } },
        { kind: "free_exercise", name: "Copenhagen plank", dose: { sets: 1, holdSec: 20 } },
      ] },
      { purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: 600 }, effort: "easy" }] },
    ]), LIB);
    expect(steps.map((s) => [s.kind, s.exerciseId, s.side, s.seconds])).toEqual([
      ["timed", "sidePlank", "Left", 30], ["timed", "sidePlank", "Right", 30], ["rest", null, null, 60],
      ["timed", null, null, 20],
      ["timed", null, null, 600],
    ]);
  });

  it("a superset plays round by round, resting the part's rest between rounds", () => {
    const steps = playerStepsFromDoc(doc([{ purpose: "main", format: "superset", rounds: 2, restBetweenRoundsSec: 75, items: [
      { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 1, reps: 8, load: { typed: "16 kg", kg: 16 } } },
      { kind: "free_exercise", name: "Push-up", dose: { sets: 1, reps: 10, load: "bodyweight" } },
    ] }]), LIB);
    expect(steps.map((s) => [s.kind, s.exerciseId, s.format.group, s.setIndex, s.seconds])).toEqual([
      ["set", "gobletSquat", "A", 0, 34], ["set", null, "B", 0, 40], ["rest", null, null, null, 75],
      ["set", "gobletSquat", "A", 1, 34], ["set", null, "B", 1, 40],
    ]);
  });

  it("a circuit plays its stations round by round with the document's rests", () => {
    const steps = playerStepsFromDoc(doc([{ purpose: "main", format: "circuit", rounds: 2, restBetweenRoundsSec: 45, items: [
      { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 1, holdSec: 40 } },
      { kind: "rest", seconds: 15 },
      { kind: "free_exercise", name: "Plank", dose: { sets: 1, holdSec: 40 } },
    ] }]), LIB);
    expect(steps.map((s) => [s.kind, s.seconds, s.format.round])).toEqual([
      ["timed", 40, 1], ["rest", 15, null], ["timed", 40, 1], ["rest", 45, null],
      ["timed", 40, 2], ["rest", 15, null], ["timed", 40, 2],
    ]);
  });

  it("docSlotKeys names each item's slot as its steps name it: its block, in play order within the block (rests none)", () => {
    const d = doc([
      { purpose: "warmup", format: "flow", items: [{ kind: "exercise", libraryId: "sidePlank", dose: { sets: 1, holdSec: 30 } }] },
      { purpose: "main", format: "straight", items: [
        { kind: "exercise", libraryId: "gobletSquat", dose: { sets: 2, reps: 8 } },
        { kind: "rest", seconds: 30 },
        { kind: "free_exercise", name: "Wall sit", dose: { sets: 1, holdSec: 45, max: true } },
      ] },
      { purpose: "activation", format: "holds", items: [{ kind: "exercise", libraryId: "sidePlank", dose: { sets: 1, holdSec: 20 } }] },
      { purpose: "run", format: "steady", items: [{ kind: "run", target: { durationSec: 600 }, effort: "easy" }] },
    ]);
    const slots = docSlotKeys(d);
    expect(slots).toEqual([
      { key: "prep:0", part: 0, item: 0 },
      { key: "core:0", part: 1, item: 0 },
      { key: "core:1", part: 1, item: 2 },
      { key: "prep:1", part: 2, item: 0 },
      { key: "core:2", part: 3, item: 0 },
    ]);
    const played = [...new Set(playerStepsFromDoc(d, LIB).filter((s) => s.kind !== "rest").map((s) => s.slotKey))];
    expect(played).toEqual(slots.map((s) => s.key));
  });
});

describe("stagesFromDoc — any document", () => {
  it("an engine build's document as stages: sets as repeats, holds as time, reps, loads and rests", () => {
    const { plan } = seededBuilds(2)[1]!;
    const stages = stagesFromDoc(docFromBuild(stored(plan)), LIBRARY);
    const top = stages.filter((s) => !s.parentStageId);
    expect(top.length).toBeGreaterThan(0);
    for (const s of stages) {
      if (s.kind === "repeat") expect(s.repeatCount).toBeGreaterThanOrEqual(1);
      if (s.parentStageId) expect(stages.some((p) => p.id === s.parentStageId && p.kind === "repeat")).toBe(true);
    }
    expect(stages.some((s) => s.reps !== undefined || s.durationType === "time")).toBe(true);
  });

  it("a legacy id comes back under the library's own name; per-side and a slow lowering ride the note", () => {
    const stages = stagesFromDoc(doc([{ purpose: "main", format: "straight", items: [
      { kind: "exercise", libraryId: "kbGobletSquat", dose: { sets: 3, reps: 8, perSide: true, tempo: { eccentricSec: 4 }, load: { typed: "35 lb", kg: 15.88 }, restSec: 90 }, cue: "chest tall" },
      { kind: "free_exercise", name: "Wall sit", dose: { holdSec: 45, load: "bodyweight" } },
    ] }]), LIB);
    const [repeat, goblet, wallSit] = stages as [PlannedStage, PlannedStage, PlannedStage];
    expect(repeat).toMatchObject({ kind: "repeat", repeatCount: 3 });
    expect(goblet).toMatchObject({
      parentStageId: repeat.id, kind: "work", label: "Goblet squat", durationType: "none", reps: 8, loadKg: 15.88, restSeconds: 90,
      note: "4s down · each side · chest tall",
    });
    expect(wallSit).toMatchObject({ parentStageId: null, label: "Wall sit", durationType: "time", durationSeconds: 45, loadBodyweight: true });
  });
});
