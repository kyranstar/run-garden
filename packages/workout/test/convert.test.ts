/**
 * CONVERTERS IN (programme spec §3.3; principles §3.2): every workout format becomes one document, and anything the
 * document cannot say is kept beside it — never dropped. Synthetic fixtures only: the COROS schedule fixture and the
 * strength program shape from the normalizer's own tests, coach sessions written in the coach's dialect and parsed by
 * the real schema, Studio sessions, and seeded engine builds.
 */
import { describe, expect, it } from "vitest";
import {
  coachSessionSchema,
  studioSessionSchema,
  workoutDocSchema,
  type CoachSession,
  type PlannedStage,
  type StudioSession,
  type WorkoutDoc,
  type WorkoutItem,
} from "@rg/domain";
import { EXERCISES } from "@rg/exercise-library";
import { COROS_EXERCISE_NAMES, fixtureRawSchedule, normalizeCorosSchedule } from "../../providers/src/index.js";
import {
  deriveDoc,
  docFromBuild,
  docFromCoachSession,
  docFromStages,
  docFromStudioSession,
  stagesFromDoc,
  type KeptEntry,
} from "../src/index.js";
import { LIBRARY, seededBuilds, stored } from "./seeded-builds.js";

const valid = (doc: WorkoutDoc): WorkoutDoc => workoutDocSchema.parse(doc);
const items = (doc: WorkoutDoc): WorkoutItem[] => doc.parts.flatMap((p) => p.items);
const exercisesOf = (doc: WorkoutDoc) => items(doc).filter((i) => i.kind === "exercise" || i.kind === "free_exercise");

/** Exact, case-folded library names → ids: what a caller's resolver might do. */
const byName = new Map(EXERCISES.map((e) => [e.name.toLowerCase(), e.id]));
const resolveName = (name: string): string | null => byName.get(name.trim().toLowerCase()) ?? null;

// ── COROS stages ──────────────────────────────────────────────────────────────────────────────────────────────────

const names = (key: string): string | undefined => COROS_EXERCISE_NAMES[key];
const corosRuns = normalizeCorosSchedule(fixtureRawSchedule("2026-08-03"), names).workouts.filter((w) => w.stages.length > 0);
const run = (title: string) => corosRuns.find((w) => w.title === title)!;

/** The normalizer's own strength program (providers' coros-normalize test): sets, reps, load, bodyweight, rest, prose. */
const liftProgram = {
  idInPlan: 1, planId: "111", name: "Ski legs", sportType: 4, subType: 65535, duration: 1500,
  exercises: [
    { id: 1, name: "Group", exerciseType: 0, isGroup: true, groupId: "0", sets: 3, targetType: 2, targetValue: 40, intensityType: 0, intensityValue: 0, restType: 3, restValue: 0, sortNo: 16777216 },
    { id: 2, name: "Goblet Squat", exerciseType: 2, isGroup: false, groupId: "1", sets: 1, targetType: 3, targetValue: 10, intensityType: 1, intensityValue: 24000, intensityCustom: 0, intensityDisplayUnit: 6, restType: 1, restValue: 90, sortNo: 16842752 },
    { id: 3, name: "Group", exerciseType: 0, isGroup: true, groupId: "0", sets: 2, targetType: 2, targetValue: 60, intensityType: 0, intensityValue: 0, restType: 3, restValue: 0, sortNo: 33554432 },
    { id: 4, name: "Wall sit", exerciseType: 2, isGroup: false, groupId: "3", sets: 1, targetType: 2, targetValue: 45, intensityType: 1, intensityCustom: 1, intensityDisplayUnit: 6, restType: 3, restValue: 0, overview: "each side · 4s down", sortNo: 33619968 },
    { id: 5, name: "Group", exerciseType: 0, isGroup: true, groupId: "0", sets: 3, targetType: 2, targetValue: 60, intensityType: 0, intensityValue: 0, restType: 3, restValue: 0, sortNo: 50331648 },
    { id: 6, name: "Trap bar deadlift", exerciseType: 2, isGroup: false, groupId: "5", sets: 1, targetType: 0, targetValue: 0, intensityType: 1, intensityValue: 0, intensityCustom: 0, restType: 1, restValue: 120, sortNo: 50397184 },
  ],
};
const lift = normalizeCorosSchedule({
  id: "111", name: "Strength", entities: [{ idInPlan: 1, planId: "111", planProgramId: 1, happenDay: 20260817 }], programs: [liftProgram],
} as never).workouts[0]!;

/** "Goblet Squat" (the COROS name) → the library's goblet squat; nothing else maps. */
const GOBLET = EXERCISES.find((e) => e.name === "Goblet squat")!.id;
const corosKeyToLibraryId = (key: string): string | null => (key.toLowerCase() === "goblet squat" ? GOBLET : null);

/** A stage tree as a comparable shape: children nested, ids and order replaced by position; `_drop` lists what to leave out. */
type Shape = Record<string, unknown> & { children?: Shape[]; _drop?: readonly string[] };
function shape(stages: readonly PlannedStage[], drop: (s: PlannedStage) => readonly string[] = () => []): Shape[] {
  const ids = new Set(stages.map((s) => s.id));
  const kids = (parent: string | null) =>
    stages.filter((s) => (s.parentStageId && ids.has(s.parentStageId) ? s.parentStageId : null) === parent).sort((a, b) => a.order - b.order);
  const node = (s: PlannedStage): Shape | null => {
    const dropped = drop(s);
    if (dropped.includes("stage")) return null;
    const { id: _id, parentStageId: _p, order: _o, ...rest } = s;
    const out: Shape = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null) out[k] = v;
    // "No target" is one fact whether it was written down or not.
    if (out.targetType === "none") delete out.targetType;
    if (s.kind === "repeat") out.children = kids(s.id).map(node).filter((n): n is Shape => n !== null);
    if (dropped.length) out._drop = dropped;
    return out;
  };
  return kids(null).map(node).filter((n): n is Shape => n !== null);
}
/** Both trees, each without the fields `kept` holds for the original's stage at the same place. */
function comparable(back: readonly PlannedStage[], original: readonly PlannedStage[], kept: readonly KeptEntry[]): [Shape[], Shape[]] {
  const orig = shape(original, (s) => kept.filter((k) => k.at === `stage ${s.id}`).map((k) => k.field));
  const prune = (tree: Shape[], like: Shape[]): Shape[] =>
    tree.map((n, i) => {
      const out: Shape = { ...n };
      for (const f of like[i]?._drop ?? []) delete out[f];
      delete out._drop;
      if (n.children) out.children = prune(n.children, like[i]?.children ?? []);
      return out;
    });
  return [prune(shape(back), orig), prune(orig, orig)];
}

describe("docFromStages — COROS runs", () => {
  it("warm-up, a repeat of work and recovery, cool-down: parts with purposes, the repeat a part with rounds", () => {
    const w = run("Threshold 5x5");
    const { doc, kept } = docFromStages(w.stages, { title: w.title, sport: w.sport, corosKeyToLibraryId, category: "quality", qualitySubtype: "threshold" });
    valid(doc);
    expect(doc.source.kind).toBe("coros_import");
    expect(doc.parts.map((p) => [p.purpose, p.format, p.rounds])).toEqual([
      ["warmup", "steady", undefined],
      ["run", "intervals", 5],
      ["cooldown", "steady", undefined],
    ]);
    expect(doc.parts[0]!.items).toEqual([{ kind: "run", target: { durationSec: 900 }, effort: "easy" }]);
    expect(doc.parts[1]!.items).toEqual([
      { kind: "run", target: { durationSec: 300, pace: { fastSecPerKm: 255, slowSecPerKm: 266 } }, effort: "threshold" },
      // Amendment A: a recovery stage is a jog, not a rest — a run item with its own duration.
      { kind: "run", target: { durationSec: 120 }, effort: "recovery" },
    ]);
    // The watch's step names ("Warm Up", "Rest", …) have no place in the document: kept, never dropped.
    expect(kept.filter((k) => k.field === "label").length).toBeGreaterThan(0);
    expect(deriveDoc(doc, LIBRARY).category).toBe("quality");
  });

  it("heart-rate targets and distances carry into the target; a short repeat is strides", () => {
    const strides = run("Easy + Strides");
    const { doc } = docFromStages(strides.stages, { title: strides.title, sport: "run", corosKeyToLibraryId, category: "easy" });
    valid(doc);
    expect(doc.parts[1]).toMatchObject({ purpose: "run", rounds: 6 });
    expect(doc.parts[1]!.items[0]).toEqual({ kind: "run", target: { distanceM: 100, pace: { fastSecPerKm: 220, slowSecPerKm: 240 } }, effort: "strides" });
    expect(deriveDoc(doc, LIBRARY).category).toBe("easy");

    const easy = corosRuns.find((w) => w.title.startsWith("Easy Run"))!;
    const e = docFromStages(easy.stages, { title: easy.title, sport: "run", corosKeyToLibraryId, category: "easy" }).doc;
    expect(e.parts[0]!.items[0]).toMatchObject({ kind: "run", effort: "easy", target: { hr: { low: 120, high: 145 } } });
  });

  it("a recovery stage keeps a distance, pace, heart rate and zone (Amendment A); a nested repeat goes to kept", () => {
    const stages: PlannedStage[] = [
      { id: "r", order: 1, kind: "repeat", repeatCount: 4, durationType: "none" },
      { id: "w", parentStageId: "r", order: 2, kind: "work", durationType: "distance", distanceMeters: 400, targetType: "pace", targetLow: 230, targetHigh: 240 },
      { id: "j", parentStageId: "r", order: 3, kind: "recovery", durationType: "distance", distanceMeters: 200, targetType: "heart_rate", targetLow: 120, targetHigh: 140, hrZone: 2 },
      { id: "n", parentStageId: "r", order: 4, kind: "repeat", repeatCount: 2, durationType: "none" },
      { id: "n1", parentStageId: "n", order: 5, kind: "work", durationType: "time", durationSeconds: 20 },
    ];
    const { doc, kept } = docFromStages(stages, { title: "400s", sport: "run", corosKeyToLibraryId });
    valid(doc);
    expect(doc.parts[0]!.items).toEqual([
      { kind: "run", target: { distanceM: 400, pace: { fastSecPerKm: 230, slowSecPerKm: 240 } }, effort: "interval" },
      { kind: "run", target: { distanceM: 200, hr: { low: 120, high: 140 }, zone: { kind: "hr", index: 2 } }, effort: "recovery" },
    ]);
    const nested = kept.find((k) => k.at === "stage n" && k.field === "stage")!;
    expect(nested.value).toEqual([stages[3], stages[4]]);
  });

  it("what the document cannot hold is kept, never dropped: power targets, a lap-button end, a second zone, an effort word", () => {
    const stages: PlannedStage[] = [
      { id: "1", order: 1, kind: "work", durationType: "lap_button", targetType: "power", targetLow: 200, targetHigh: 250, paceZone: 3, hrZone: 2, label: "Ride it" },
    ];
    const { doc, kept } = docFromStages(stages, { title: "Odd", sport: "run", corosKeyToLibraryId });
    valid(doc);
    expect(doc.parts[0]!.items[0]).toEqual({ kind: "run", target: { open: true, zone: { kind: "pace", index: 3 } }, effort: "by_feel" });
    expect(kept.map((k) => k.field).sort()).toEqual(["durationType", "hrZone", "label", "targetHigh", "targetLow", "targetType"]);
  });

  it("a ride's segments are kept as the sport they are", () => {
    const { kept } = docFromStages(run("Threshold 5x5").stages, { title: "Ride", sport: "bike", corosKeyToLibraryId });
    expect(kept).toContainEqual(expect.objectContaining({ at: "workout", field: "sport", value: "bike" }));
  });
});

describe("docFromStages — COROS strength", () => {
  const { doc, kept } = docFromStages(lift.stages, { title: lift.title, sport: "strength", corosKeyToLibraryId });

  it("sets, reps, load, bodyweight, rest and the step's prose all arrive", () => {
    valid(doc);
    expect(doc.parts).toHaveLength(1);
    expect(doc.parts[0]).toMatchObject({ purpose: "main", format: "straight" });
    const [goblet, wallSit, trapBar] = doc.parts[0]!.items;
    // Review Focus 1: a COROS name the mapping knows becomes the library id; Review Focus 3: kg as typed plus kg.
    expect(goblet).toEqual({ kind: "exercise", libraryId: GOBLET, dose: { sets: 3, reps: 10, load: { typed: "24 kg", kg: 24 }, restSec: 90 } });
    // The prose is the only carrier of per-side work and the slow lowering: both read, the words kept as the cue.
    expect(wallSit).toEqual({
      kind: "free_exercise", name: "Wall sit",
      dose: { sets: 2, holdSec: 45, load: "bodyweight", perSide: true, tempo: { eccentricSec: 4 } },
      cue: "each side · 4s down",
    });
    // An unknown name stays free text; an explicit 0 kg is a load of 0 kg, not bodyweight; an open step stays open.
    expect(trapBar).toEqual({ kind: "free_exercise", name: "Trap bar deadlift", dose: { sets: 3, load: { typed: "0 kg", kg: 0 }, restSec: 120 } });
  });

  it("keeps the COROS name of a mapped move and the containers' names", () => {
    expect(kept).toContainEqual(expect.objectContaining({ at: "stage 2", field: "label", value: "Goblet Squat" }));
    expect(kept.filter((k) => k.field === "label" && k.value === "Group")).toHaveLength(3);
  });

  it("files as strength", () => {
    expect(deriveDoc(doc, LIBRARY).category).toBe("strength");
  });

  it("a multi-move repeat is a circuit with rounds, a COROS rest a rest item; a yoga import is a flow", () => {
    const stages: PlannedStage[] = [
      { id: "g", order: 1, kind: "repeat", repeatCount: 3, durationType: "none" },
      { id: "a", parentStageId: "g", order: 2, kind: "work", durationType: "time", durationSeconds: 40, label: "Plank" },
      { id: "r", parentStageId: "g", order: 3, kind: "recovery", durationType: "time", durationSeconds: 20, label: "Rest" },
      { id: "b", parentStageId: "g", order: 4, kind: "work", durationType: "none", reps: 12, label: "Air squat" },
    ];
    const strength = docFromStages(stages, { title: "Circuit", sport: "strength", corosKeyToLibraryId }).doc;
    valid(strength);
    expect(strength.parts[0]).toMatchObject({ purpose: "main", format: "circuit", rounds: 3 });
    expect(strength.parts[0]!.items.map((i) => i.kind)).toEqual(["free_exercise", "rest", "free_exercise"]);
    expect(docFromStages(stages, { title: "Flow", sport: "yoga", corosKeyToLibraryId }).doc.parts[0]!.format).toBe("flow");
  });
});

describe("stagesFromDoc(docFromStages(s)) equals s on every field the document carries; the rest is in kept", () => {
  const cases: Array<[string, PlannedStage[], string]> = [
    ...corosRuns.map((w) => [w.title, w.stages, w.sport] as [string, PlannedStage[], string]),
    ["Ski legs", lift.stages, "strength"],
  ];
  for (const [title, stages, sport] of cases) {
    it(title, () => {
      const { doc, kept } = docFromStages(stages, { title, sport, corosKeyToLibraryId });
      const back = stagesFromDoc(valid(doc), EXERCISES);
      // A mapped move comes back under the library's name (its COROS name is in kept), and a step name the document
      // has no place for is in kept: every other field comes back exactly.
      const [mine, original] = comparable(back, stages, kept);
      expect(mine).toEqual(original);
    });
  }

  it("every stage entry in kept is a field the round trip really loses: the ledger is not a blanket", () => {
    for (const [title, stages, sport] of cases) {
      const { doc, kept } = docFromStages(stages, { title, sport, corosKeyToLibraryId });
      const back = stagesFromDoc(doc, EXERCISES);
      for (const entry of kept.filter((k) => k.at.startsWith("stage ") && k.field !== "stage")) {
        const [mine, original] = comparable(back, stages, kept.filter((k) => k !== entry));
        expect(mine, `${title}: ${entry.at} ${entry.field}`).not.toEqual(original);
      }
    }
  });
});

// ── Coach sessions ────────────────────────────────────────────────────────────────────────────────────────────────

const coach = (raw: unknown): { session: CoachSession; raw: unknown } => ({ session: coachSessionSchema.parse(raw), raw });

describe("docFromCoachSession", () => {
  const skiRaw = {
    category: "strength", title: "Ski legs", durationMinutes: 40,
    lift: {
      exercises: [
        { name: "Wall sit", sets: 3, holdSeconds: "45s", restSeconds: "2 min" },
        { name: "Copenhagen plank", sets: "2", holdSeconds: "1:30", perSide: true, restSeconds: 20, note: "keep the hips stacked", originId: "425898928110747648" },
        { name: "Goblet squat", sets: 3, reps: "8-12", eccentricSeconds: 4, weight: "25 lb", restSeconds: 90 },
        { name: "Split squat", sets: 3, reps: 8, perSide: true, weight: "2×20kg" },
      ],
    },
  };

  it("lift → main, straight; names resolve where they can (Review Focus 1), else free text", () => {
    const { session, raw } = coach(skiRaw);
    const { doc, kept } = docFromCoachSession(session, { resolveName, raw })!;
    valid(doc);
    expect(doc.source.kind).toBe("coach");
    expect(doc.setting).toEqual({ targetMinutes: 40 });
    expect(doc.parts.map((p) => [p.purpose, p.format])).toEqual([["main", "straight"]]);
    const [wallSit, copenhagen, goblet] = doc.parts[0]!.items;
    expect(wallSit).toEqual({ kind: "exercise", libraryId: resolveName("Wall sit"), dose: { sets: 3, holdSec: 45, load: "bodyweight", restSec: 120 } });
    // A coach note is a cue; the catalog id has no place in the document and is kept.
    expect(copenhagen).toEqual({
      kind: "free_exercise", name: "Copenhagen plank",
      dose: { sets: 2, holdSec: 90, perSide: true, load: "bodyweight", restSec: 20 }, cue: "keep the hips stacked",
    });
    expect(kept).toContainEqual(expect.objectContaining({ at: "exercise 2", field: "originId", value: "425898928110747648" }));
    expect(goblet).toMatchObject({ kind: "exercise", libraryId: GOBLET, dose: { sets: 3, reps: 8, tempo: { eccentricSec: 4 }, restSec: 90 } });
  });

  it("Review Focus 3: pounds as typed with their kilograms; a pair of kilos as typed; bodyweight as bodyweight", () => {
    const { session, raw } = coach(skiRaw);
    const ex = exercisesOf(docFromCoachSession(session, { resolveName, raw })!.doc);
    expect(ex[2]!.dose.load).toEqual({ typed: "25 lb", kg: 11.34 });
    expect(ex[3]!.dose.load).toEqual({ typed: "2×20kg", kg: 20 });
    expect(ex[0]!.dose.load).toBe("bodyweight");
    // Without the coach's own words only the stored kilos remain (the schema keeps them to a tenth): typed as kilos.
    const stored = exercisesOf(docFromCoachSession(session, { resolveName })!.doc);
    expect(stored[2]!.dose.load).toEqual({ typed: "11.3 kg", kg: 11.3 });
    expect(stored[3]!.dose.load).toEqual({ typed: "20 kg", kg: 20 });
  });

  it("a word that is not a load (\"heavy\") is not bodyweight when the coach's words are known: kept, no load", () => {
    const { session, raw } = coach({ category: "lift", title: "Ramping squats", durationMinutes: 35, lift: { exercises: [{ name: "Back squat", sets: 3, weight: "heavy" }] } });
    const { doc, kept } = docFromCoachSession(session, { resolveName, raw })!;
    expect(exercisesOf(doc)[0]!.dose.load).toBeUndefined();
    expect(kept).toContainEqual(expect.objectContaining({ at: "exercise 1", field: "weight", value: "heavy" }));
    expect(deriveDoc(doc, LIBRARY).category).toBe("strength");
  });

  it("run blocks → run items with efforts as given; an opening easy block before hard work is the warm-up, a closing one the cool-down; a walk is a rest", () => {
    const { session } = coach({
      category: "quality", title: "Threshold with walk-backs", durationMinutes: 60,
      run: { blocks: [
        { kind: "duration", value: 15, intensity: "easy" },
        { kind: "duration", value: 6, intensity: "tempo" },
        { kind: "duration", value: "90s", intensity: "interval" },
        { kind: "duration", value: 2, intensity: "walk" },
        { kind: "km", value: 1, intensity: "walk" },
        { kind: "minutes", value: 5 },
        { kind: "duration", value: 10, intensity: "easy" },
      ] },
    });
    const { doc, kept } = docFromCoachSession(session, { resolveName })!;
    valid(doc);
    expect(doc.parts.map((p) => [p.purpose, p.format])).toEqual([["warmup", "steady"], ["run", "intervals"], ["cooldown", "steady"]]);
    expect(doc.parts[1]!.items).toEqual([
      { kind: "run", target: { durationSec: 360 }, effort: "threshold" },
      { kind: "run", target: { durationSec: 90 }, effort: "interval" },
      { kind: "rest", seconds: 120 },
      { kind: "run", target: { distanceM: 1000 }, effort: "recovery" },
      { kind: "run", target: { durationSec: 300 }, effort: "by_feel" },
    ]);
    expect(kept).toContainEqual(expect.objectContaining({ at: "block 5", field: "intensity", value: "rest" }));
    expect(deriveDoc(doc, LIBRARY).category).toBe("quality");
  });

  it("mobility → main as a flow; rounds make a circuit; an empty body is an open block of the session's length", () => {
    const flow = coach({ category: "mobility", title: "Hip and ankle flow", durationMinutes: 15, mobility: { exercises: [
      { name: "Couch stretch", sets: 2, holdSeconds: "1:30", perSide: true, restSeconds: 0 },
      { name: "Ankle rocks", sets: 2, reps: 12, restSeconds: 0 },
    ] } });
    const f = docFromCoachSession(flow.session, { resolveName })!.doc;
    expect(f.parts[0]).toMatchObject({ purpose: "main", format: "flow" });
    expect(deriveDoc(f, LIBRARY).category).toBe("yoga");

    const circuit = coach({ category: "strength", title: "Isometric circuit", durationMinutes: 12, lift: { rounds: "3", exercises: [
      { name: "Wall sit", sets: 1, holdSeconds: 45, restSeconds: 15 },
      { name: "Side plank", sets: 1, holdSeconds: 30, perSide: true, restSeconds: 15 },
    ] } });
    const c = docFromCoachSession(circuit.session, { resolveName })!.doc;
    expect(c.parts[0]).toMatchObject({ purpose: "main", format: "circuit", rounds: 3 });

    for (const [raw, category] of [
      [{ category: "S&C", title: "Gym, movements on the day", durationMinutes: 30 }, "strength"],
      [{ category: "mobility", title: "Mobility, by feel", durationMinutes: 20, mobility: { exercises: [] } }, "yoga"],
      [{ category: "easy", title: "Forty by feel", durationMinutes: 40, run: { blocks: [] } }, "easy"],
    ] as const) {
      const { doc, kept } = docFromCoachSession(coach(raw).session, { resolveName })!;
      valid(doc);
      expect(items(doc)).toHaveLength(1);
      expect(deriveDoc(doc, LIBRARY).category).toBe(category);
      expect(deriveDoc(doc, LIBRARY).estimatedMinutes).toBe(raw.durationMinutes);
      expect(kept.some((k) => k.why.includes("no"))).toBe(true);
    }
  });

  it("a number past the document's bounds is clamped to them and the coach's own kept", () => {
    const { session } = coach({ category: "strength", title: "Big", durationMinutes: 45, lift: { exercises: [
      { name: "Air squat", sets: 25, reps: 300, eccentricSeconds: 25, restSeconds: 1200 },
    ] } });
    const { doc, kept } = docFromCoachSession(session, { resolveName })!;
    valid(doc);
    expect(exercisesOf(doc)[0]!.dose).toMatchObject({ sets: 20, reps: 200, tempo: { eccentricSec: 20 }, restSec: 900 });
    expect(kept.filter((k) => k.at === "exercise 1").map((k) => [k.field, k.value])).toEqual([
      ["sets", 25], ["reps", 300], ["eccentricSeconds", 25], ["restSeconds", 1200],
    ]);
  });

  it("a rest day carries no document", () => {
    expect(docFromCoachSession(coach({ category: "rest day", title: "Off", durationMinutes: 0 }).session, { resolveName })).toBeNull();
  });

  it("the coach's own category is kept beside the derived one", () => {
    const { session } = coach({ category: "long", title: "Long", durationMinutes: 90, run: { blocks: [{ kind: "duration", value: 90 }] } });
    const { doc, kept } = docFromCoachSession(session, { resolveName })!;
    expect(kept).toContainEqual(expect.objectContaining({ at: "session", field: "category", value: "long" }));
    expect(deriveDoc(doc, LIBRARY).category).toBe("long");
  });
});

// ── Old Studio sessions ───────────────────────────────────────────────────────────────────────────────────────────

describe("docFromStudioSession", () => {
  const session: StudioSession = studioSessionSchema.parse({
    title: "Lower A", weekday: 2,
    exercises: [
      { originId: "c-1", name: "Goblet Squat", sets: 3, reps: 8, weight: { type: "kg", value: 16 }, restSeconds: 90 },
      { originId: "c-2", name: "Hanging Knee Raise", sets: 3, reps: 10, weight: { type: "bodyweight" }, restSeconds: 60, note: "slow" },
    ],
  });
  const originIdToLibraryId = (id: string) => (id === "c-1" ? GOBLET : null);

  it("originId → library id where the mapping is exact; else free text; kilos typed as kilos; the weekday and catalog ids kept", () => {
    const { doc, kept } = docFromStudioSession(session, { originIdToLibraryId });
    valid(doc);
    expect(doc.source.kind).toBe("studio");
    expect(doc.parts).toEqual([{ purpose: "main", format: "straight", items: [
      { kind: "exercise", libraryId: GOBLET, dose: { sets: 3, reps: 8, load: { typed: "16 kg", kg: 16 }, restSec: 90 } },
      { kind: "free_exercise", name: "Hanging Knee Raise", dose: { sets: 3, reps: 10, load: "bodyweight", restSec: 60 }, cue: "slow" },
    ] }]);
    expect(kept).toContainEqual(expect.objectContaining({ at: "session", field: "weekday", value: 2 }));
    expect(kept.filter((k) => k.field === "originId").map((k) => k.value)).toEqual(["c-1", "c-2"]);
    expect(deriveDoc(doc, LIBRARY).category).toBe("strength");
  });
});

// ── Engine builds ─────────────────────────────────────────────────────────────────────────────────────────────────

describe("docFromBuild", () => {
  const builds = seededBuilds(50);

  it("every seeded build becomes a valid document: blocks → parts, the build's mode → the effort", () => {
    for (const { label, plan } of builds) {
      const doc = docFromBuild(stored(plan));
      expect(workoutDocSchema.safeParse(doc).success, label).toBe(true);
      expect(doc.source.kind, label).toBe("engine");
      expect(doc.intent.effort, label).toBe(plan.mode === "recovery" ? "recover" : plan.mode === "consistent" ? "maintain" : "develop");
      expect(doc.setting?.targetMinutes, label).toBe(plan.minutes);
      // Every move, in play order, by its own id.
      expect(exercisesOf(doc).map((i) => (i.kind === "exercise" ? i.libraryId : i.name)), label).toEqual(plan.items.map((it) => it.exercise.id));
    }
  });

  it("each block maps to its purpose; activation moves in prep go to an activation part", () => {
    const purposes = new Set<string>();
    for (const { plan } of builds) {
      const doc = docFromBuild(stored(plan));
      for (const p of doc.parts) purposes.add(p.purpose);
      const want = { arrive: ["arrive"], prep: ["warmup", "activation"], core: ["main"], accessory: ["accessory"], care: ["care"], cooldown: ["cooldown"] };
      const blocksInOrder = [...new Set(plan.items.map((it) => it.block))];
      const docBlocks = [...new Set(doc.parts.map((p) => Object.entries(want).find(([, ps]) => ps.includes(p.purpose))![0]))];
      expect(docBlocks).toEqual(blocksInOrder);
    }
    expect([...purposes].sort()).toEqual(["accessory", "activation", "arrive", "care", "cooldown", "main", "warmup"]);
  });

  it("the swap alternatives become alternates (at most 3), the reasons the why, the progression note the progression", () => {
    let alternates = 0;
    for (const { plan } of builds) {
      const doc = docFromBuild(stored(plan));
      const ex = exercisesOf(doc);
      plan.items.forEach((it, i) => {
        const item = ex[i]!;
        if (item.kind !== "exercise") throw new Error("engine moves are library moves");
        const alts = plan.alternatives[it.slotKey] ?? [];
        expect(item.alternates?.map((a) => a.libraryId) ?? []).toEqual(alts.slice(0, 3).map((a) => a.id));
        alternates += item.alternates?.length ?? 0;
        if (it.why.length) expect(item.why).toBe(it.why.join("; "));
        if (it.target?.note) expect(item.progression).toBe(it.target.note.length <= 120 ? it.target.note : expect.any(String));
      });
    }
    expect(alternates).toBeGreaterThan(50);
  });

  it("loads: a suggested weight as typed plus kg; bodyweight moves as bodyweight; unloaded moves carry none", () => {
    const loads = new Set<string>();
    for (const { plan } of builds) {
      const ex = exercisesOf(docFromBuild(stored(plan)));
      plan.items.forEach((it, i) => {
        const load = ex[i]!.dose.load;
        if (it.target?.w) {
          expect(load).toEqual({ typed: `${Number(it.target.w.v.toFixed(2))} ${it.target.w.u}`, kg: expect.any(Number) });
          loads.add(it.target.w.u);
        } else if (it.target) expect(load).toBe("bodyweight");
        else expect(load).toBeUndefined();
      });
    }
    expect([...loads].sort()).toEqual(["kg", "lb"]);
  });
});
