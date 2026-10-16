/**
 * VALIDATION (programme spec §3.2; principles §2.7–§2.8): every workout from every source — the engine, the coach, the
 * Studio, templates — passes one checker, and every rule of every active condition profile applies to it. "Never" and
 * the day's gates are errors; the softer rules are warnings, shown as costs. One test (at least) per issue code, and
 * 600 seeded engine builds that must validate without an error. Synthetic records and histories only.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween, type WorkoutDoc, type WorkoutItem, type WorkoutPart } from "@rg/domain";
import { EXERCISES, TMJ, UNANSWERED, fitsMode, type CheckReading, type ConditionProfile, type ExerciseRecord, type Mode } from "@rg/exercise-library";
import { Planner, Rng, type DayState, type ProgramState } from "@rg/session-engine";
import { LOCATIONS, seededHistory } from "../../session-engine/test/seeded-history.js";
import { DOC_ISSUE_CODES, docFromBuild, validateWorkoutDoc, type DayContext, type DocIssue, type ValidateCtx } from "../src/index.js";
import { WORLD, jumpDayBuilds, seededBuilds, stored } from "./seeded-builds.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────────────────

type Over = Record<string, unknown>;
const record = (id: string): ExerciseRecord => {
  const e = EXERCISES.find((x) => x.id === id);
  if (!e) throw new Error(`no record ${id}`);
  return e;
};
const BRIDGE = record("bridge");
/** A move the profile forbids outright (no real record is rated that high). */
const NEVER_MOVE: ExerciseRecord = { ...BRIDGE, id: "testNeverMove", name: "Test forbidden move", legacyIds: [], conditions: { tmj: { clench: 3, neckLoad: 0, faceDown: false } } };
/** A move with no rating for the active profile: it must fail closed. */
const UNRATED: ExerciseRecord = { ...BRIDGE, id: "testUnratedMove", name: "Test unrated move", legacyIds: [], conditions: {} };
/** A jump whose easier variant is a bridge (no real jump steps down to a move recovery allows). */
const HOP_DOWN_TO_BRIDGE: ExerciseRecord = { ...record("pogoHop"), id: "testHopEasier", name: "Test hop", legacyIds: [], easier: ["bridge"], harder: [] };
/** The library, with the bridge renamed (its old id kept as a legacy id). */
const LIBRARY: ExerciseRecord[] = [
  ...EXERCISES.map((e) => (e.id === "bridge" ? { ...e, legacyIds: [...e.legacyIds, "oldBridge"] } : e)),
  NEVER_MOVE,
  UNRATED,
  HOP_DOWN_TO_BRIDGE,
];

/** A made-up profile whose only rule holds the bridge back on a high reading — and lets an unanswered check through. */
const LENIENT: ConditionProfile = {
  ...TMJ, id: "testLenient", label: "Lenient", attributes: {}, check: { label: "Lenient", min: 0, max: 10 },
  never: () => false, fitsMode: () => true, fitsFormat: () => true, allowPattern: () => true,
  allowRecord: (rec, _mode, today) => rec.id !== "bridge" || (today.pre ?? 0) <= 4,
  flareSafe: () => true, flare: () => false, recoveryReason: () => null, buildChecks: () => [],
};

const ex = (libraryId: string, dose: Over, extra: Over = {}): WorkoutItem => ({ kind: "exercise", libraryId, dose, ...extra }) as WorkoutItem;
const alt = (...ids: string[]): Over => ({ alternates: ids.map((libraryId) => ({ libraryId })) });
const part = (purpose: string, format: string, items: WorkoutItem[], extra: Over = {}): WorkoutPart => ({ purpose, format, items, ...extra }) as WorkoutPart;
const docOf = (parts: WorkoutPart[], effort: WorkoutDoc["intent"]["effort"] = "maintain", extra: Over = {}): WorkoutDoc =>
  ({ version: 1, title: "Test", intent: { summary: "A test workout.", goals: [], focus: [], effort }, parts, source: { kind: "studio" }, ...extra }) as WorkoutDoc;
/** One straight part holding one item. */
const one = (item: WorkoutItem, effort: WorkoutDoc["intent"]["effort"] = "maintain", format = "straight"): WorkoutDoc => docOf([part("main", format, [item])], effort);

const TODAY = "2026-03-10";
const reading = (pre: number | null, feelingOff = false): CheckReading => ({ pre, post: null, feelingOff });
const CALM = reading(1);
const dayOf = (r: CheckReading | null, o: Partial<DayContext> = {}): DayContext => ({ date: TODAY, today: TODAY, readings: { tmj: r }, ...o });
const FUTURE = (r: CheckReading | null = null): DayContext => dayOf(r, { date: addDays(TODAY, 3) });

function check(doc: WorkoutDoc, day: DayContext | null = dayOf(CALM), o: Partial<ValidateCtx> = {}): DocIssue[] {
  return validateWorkoutDoc(doc, { library: LIBRARY, activeProfiles: [TMJ], day, ...o });
}
const codes = (issues: readonly DocIssue[]): string[] => issues.map((i) => `${i.severity}:${i.code}@${i.path}`);
const only = (issues: readonly DocIssue[], code: DocIssue["code"]): DocIssue[] => issues.filter((i) => i.code === code);
const P0 = "parts[0].items[0]";

/** A plain maintain workout: nothing in it should raise anything on a calm, answered day. */
const CLEAN = docOf(
  [
    part("warmup", "flow", [ex("catCow", { reps: 8 })]),
    part("main", "straight", [ex("gobletSquat", { sets: 3, reps: 8, restSec: 60 }), ex("deadBug", { sets: 2, reps: 8 })]),
    part("cooldown", "holds", [ex("figureFour", { holdSec: 30, perSide: true })]),
  ],
  "maintain",
  { intent: { summary: "A test workout.", goals: ["strength"], focus: ["glutes", "quads", "glute-max"], effort: "maintain" }, setting: { equipment: ["kettlebell", "mat"] } },
);

describe("validateWorkoutDoc — a clean workout", () => {
  it("raises nothing on a calm, answered day, in a template (no day), and on a future day", () => {
    expect(check(CLEAN)).toEqual([]);
    expect(check(CLEAN, null)).toEqual([]);
    expect(check(CLEAN, FUTURE())).toEqual([]);
  });

  it("lists every code it can raise, and nothing else", () => {
    expect([...DOC_ISSUE_CODES].sort()).toEqual(
      [
        "bounds", "care_share", "condition_flare", "condition_format", "condition_gate", "condition_gate_pending", "condition_mode", "condition_never",
        "condition_pattern", "dose_mismatch", "equipment_unavailable", "excluded_by_athlete", "format_mismatch", "jump_placement", "legacy_id",
        "mode_above_day", "mode_limits", "progression_jump", "too_large", "too_long_for_watch", "unknown_equipment", "unknown_exercise", "unknown_focus",
      ].sort(),
    );
  });

  it("never names a profile: every condition rule is read through the profile contract", () => {
    // Jumps are the library's own contraction (its frontier rule and its record helper), not a profile's.
    const src = readFileSync(new URL("../src/validate.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/tmj|jaw|clench|neckLoad|faceDown|push-v/i);
  });

  it("accepts anything as input: what does not parse is a bounds error, never a throw", () => {
    for (const junk of [null, undefined, 42, "a workout", { title: "x" }, []]) {
      const issues = validateWorkoutDoc(junk, { library: LIBRARY, activeProfiles: [TMJ], day: null });
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((i) => i.code === "bounds" && i.severity === "error")).toBe(true);
    }
  });
});

// ── The document and the library ──────────────────────────────────────────────────────────────────────────────────

describe("bounds", () => {
  it("a document outside the schema is an error at the offending path", () => {
    const bad = docOf([part("main", "straight", [ex("bridge", { sets: 0, reps: 10 })])], "maintain", { title: "" });
    const issues = check(bad);
    expect(issues.every((i) => i.code === "bounds" && i.severity === "error")).toBe(true);
    expect(issues.map((i) => i.path).sort()).toEqual([`${P0}.dose.sets`, "title"]);
  });

  it("says what is wrong in plain words, not the schema library's", () => {
    const bad = docOf([part("main", "straight", [ex("bridge", { sets: 0, reps: 10, holdSec: 5000 })])], "maintain", { title: "" });
    const issues = check({ ...bad, intent: { ...bad.intent, effort: "max" } } as unknown as WorkoutDoc);
    const message = (path: string) => issues.find((i) => i.path === path)?.message;
    expect(message("title")).toBe("The title can't be empty.");
    expect(message(`${P0}.dose.sets`)).toBe("Sets must be at least 1.");
    expect(message(`${P0}.dose.holdSec`)).toBe("Hold time (seconds) must be at most 3600.");
    expect(message("intent.effort")).toBe("Effort must be one of: recover, maintain, develop, peak.");
    expect(validateWorkoutDoc(null, { library: LIBRARY, activeProfiles: [], day: null })[0]!.message).toBe("The workout is missing.");
    for (const i of issues) expect(i.message).not.toMatch(/String must|Number must|Expected|Invalid enum|Required/);
  });
});

describe("unknown_exercise and legacy_id", () => {
  it("an id the library does not hold is an error, with the likely id as the fix when the spelling is close", () => {
    expect(check(one(ex("goblet-squat", { sets: 3, reps: 8 })))).toEqual([
      expect.objectContaining({ path: `${P0}.libraryId`, code: "unknown_exercise", severity: "error", fix: "gobletSquat" }),
    ]);
    const [noGuess] = check(one(ex("noSuchMove", { sets: 3, reps: 8 })));
    expect(noGuess).toMatchObject({ code: "unknown_exercise", severity: "error" });
    expect(noGuess!.fix).toBeUndefined();
  });

  it("an alternate the library does not hold is an error too", () => {
    expect(codes(check(one(ex("bridge", { sets: 2, reps: 10 }, alt("deadBug", "noSuchMove")))))).toEqual([`error:unknown_exercise@${P0}.alternates[1].libraryId`]);
  });

  it("a legacy id is accepted with a warning whose fix is the current id — for items and alternates", () => {
    const issues = check(one(ex("oldBridge", { sets: 2, reps: 10 }, alt("oldBridge"))));
    expect(issues).toEqual([
      expect.objectContaining({ path: `${P0}.libraryId`, code: "legacy_id", severity: "warning", fix: "bridge" }),
      expect.objectContaining({ path: `${P0}.alternates[0].libraryId`, code: "legacy_id", severity: "warning", fix: "bridge" }),
    ]);
    // The message names the move, not the old id.
    expect(issues[0]!.message).toBe("Glute bridge is listed under an old id.");
  });
});

describe("unknown_focus and unknown_equipment", () => {
  it("a focus id that is neither a region nor a muscle is a warning, with the id it most likely meant", () => {
    const d = { ...CLEAN, intent: { ...CLEAN.intent, focus: ["glutes", "upper back", "abs"] } };
    const issues = check(d);
    expect(codes(issues)).toEqual(["warning:unknown_focus@intent.focus[1]", "warning:unknown_focus@intent.focus[2]"]);
    expect(issues.map((i) => i.fix)).toEqual(["upper-back", undefined]);
  });

  it("a setting's equipment id the library does not know is a warning", () => {
    const d = { ...CLEAN, setting: { equipment: ["mat", "Kettlebells", "trampoline"] } };
    const issues = check(d);
    expect(codes(issues)).toEqual(["warning:unknown_equipment@setting.equipment[1]", "warning:unknown_equipment@setting.equipment[2]"]);
    expect(issues.map((i) => i.fix)).toEqual(["kettlebell", undefined]);
  });
});

describe("format_mismatch", () => {
  const sq = ex("gobletSquat", { sets: 1, reps: 8 });
  const row = ex("bandRow", { sets: 1, reps: 12 });
  const dead = ex("deadBug", { sets: 1, reps: 8 });

  it("a superset pairs exactly two moves (error otherwise)", () => {
    expect(check(docOf([part("main", "superset", [sq, row], { rounds: 3 })]))).toEqual([]);
    expect(codes(check(docOf([part("main", "superset", [sq, row, dead], { rounds: 3 })])))).toEqual(["error:format_mismatch@parts[0].format"]);
    const [single] = check(docOf([part("main", "superset", [sq], { rounds: 3 })]));
    expect(single).toMatchObject({ code: "format_mismatch", severity: "error", fix: "straight" });
  });

  it("a circuit outside 3–6 moves is a warning (the engine's own circuits must stay clean)", () => {
    const station = (id: string) => ex(id, { sets: 1, holdSec: 40 });
    const circuit = (n: number) => docOf([part("main", "circuit", ["bridge", "deadBug", "birdDog", "tempoSquat", "bwSplitSquat", "wallPushup", "chinTuck"].slice(0, n).map(station), { rounds: 2 })], "develop");
    expect(check(circuit(3))).toEqual([]);
    expect(check(circuit(6))).toEqual([]);
    expect(codes(check(circuit(2)))).toEqual(["warning:format_mismatch@parts[0].format"]);
    expect(codes(check(circuit(7)))).toEqual(["warning:format_mismatch@parts[0].format"]);
  });

  it("intervals need a run or a timed move (error otherwise)", () => {
    const run: WorkoutItem = { kind: "run", effort: "strides", target: { durationSec: 20 } } as WorkoutItem;
    expect(check(docOf([part("run", "intervals", [run, { kind: "rest", seconds: 40 }], { rounds: 4 })]))).toEqual([]);
    expect(check(docOf([part("conditioning", "intervals", [ex("tempoSquat", { holdSec: 30 }), { kind: "rest", seconds: 30 }], { rounds: 4 })], "develop"))).toEqual([]);
    expect(codes(check(docOf([part("conditioning", "intervals", [ex("tempoSquat", { reps: 10 }), dead], { rounds: 4 })], "develop")))).toEqual(["error:format_mismatch@parts[0].format"]);
  });
});

describe("dose_mismatch", () => {
  it("an exercise with no amount is a warning, with the move's own dose as the fix", () => {
    const [issue] = check(one(ex("gobletSquat", { sets: 3 })));
    expect(issue).toMatchObject({ path: `${P0}.dose`, code: "dose_mismatch", severity: "warning" });
    expect(JSON.parse(issue!.fix!)).toEqual({ sets: 3, reps: { min: 5, max: 8 } });
    // "To max" is an amount.
    expect(check(one(ex("wallSit", { sets: 2, max: true })))).toEqual([]);
  });

  it("a carry with no amount is fixed as a timed carry: the library's carry range is seconds, not metres", () => {
    const [issue] = check(one(ex("farmerCarry", { sets: 2 }), "maintain"));
    expect(issue).toMatchObject({ code: "dose_mismatch", severity: "warning" });
    const fix = JSON.parse(issue!.fix!) as Record<string, unknown>;
    expect(fix.holdSec).toBeGreaterThan(0);
    expect(fix.carryM).toBeUndefined();
  });

  it("a free-text move with no amount is a warning too (no fix: the library cannot say)", () => {
    const [issue] = check(one({ kind: "free_exercise", name: "Something", dose: { sets: 2 } } as WorkoutItem));
    expect(issue).toMatchObject({ code: "dose_mismatch", severity: "warning" });
    expect(issue!.fix).toBeUndefined();
  });

  it("reps on a timed move, and seconds on a counted move in straight sets, are warnings with the matching dose", () => {
    const [timed] = check(one(ex("wallSit", { sets: 2, reps: 10 })));
    expect(timed).toMatchObject({ code: "dose_mismatch", severity: "warning" });
    expect(JSON.parse(timed!.fix!)).toEqual({ sets: 2, holdSec: 45 });
    const [counted] = check(one(ex("gobletSquat", { sets: 3, holdSec: 30, restSec: 60 })));
    expect(counted).toMatchObject({ code: "dose_mismatch", severity: "warning" });
    expect(JSON.parse(counted!.fix!)).toEqual({ sets: 3, reps: { min: 5, max: 8 }, restSec: 60 });
  });

  it("a timed window of a counted move in a circuit, intervals or a flow is the format's way, not a mismatch", () => {
    for (const format of ["circuit", "intervals", "flow"]) {
      const d = docOf([part("main", format, ["tempoSquat", "bridge", "deadBug"].map((id) => ex(id, { sets: 1, holdSec: 40 })), { rounds: 2 })]);
      expect(only(check(d), "dose_mismatch")).toEqual([]);
    }
  });

  it("reps on a carry (timed) or a breathing record (counted in breaths) are warnings, fixed to the record's own amount", () => {
    const [carry] = only(check(one(ex("farmerCarry", { sets: 2, reps: 10 }))), "dose_mismatch");
    expect(carry).toMatchObject({ path: `${P0}.dose`, code: "dose_mismatch", severity: "warning" });
    expect(carry!.message).toMatch(/carried for time/);
    expect(JSON.parse(carry!.fix!)).toEqual({ sets: 2, holdSec: 45 });
    const [breaths] = only(check(one(ex("physiologicalSigh", { sets: 1, reps: 6 }), "recover", "holds")), "dose_mismatch");
    expect(breaths).toMatchObject({ code: "dose_mismatch", severity: "warning" });
    expect(breaths!.message).toMatch(/breaths/);
    expect(JSON.parse(breaths!.fix!)).toEqual({ sets: 1, breaths: 7 });
    // Their own amounts raise nothing.
    expect(only(check(one(ex("farmerCarry", { sets: 2, holdSec: 40 }))), "dose_mismatch")).toEqual([]);
    expect(only(check(one(ex("physiologicalSigh", { sets: 1, breaths: 6 }), "recover", "holds")), "dose_mismatch")).toEqual([]);
  });
});

describe("jump_placement (final review I2): power while fresh — one jumps part, straight sets or a superset, before the lifting", () => {
  const hop = (extra: Over = {}) => ex("snapDown", { sets: 2, reps: 5, restSec: 60 }, extra);
  const stick = () => ex("landingStick", { sets: 2, reps: 5, restSec: 60 });
  const squat = () => ex("gobletSquat", { sets: 3, reps: 8, restSec: 60 });
  const warm = () => part("warmup", "flow", [ex("catCow", { reps: 8 })]);
  const jumpIssues = (d: WorkoutDoc) => only(check(d), "jump_placement").map((i) => `${i.severity}@${i.path}`);

  it("the engine's own shape raises nothing: a warm-up, then the jumps (straight or a superset), then the lifts", () => {
    expect(jumpIssues(docOf([warm(), part("power", "straight", [hop(), stick()]), part("main", "straight", [squat()])], "develop"))).toEqual([]);
    expect(jumpIssues(docOf([warm(), part("power", "superset", [hop(), stick()]), part("main", "straight", [squat()])], "develop"))).toEqual([]);
    // Activation before the jumps is preparation, not lifting.
    expect(jumpIssues(docOf([warm(), part("activation", "straight", [ex("bridge", { sets: 1, reps: 10 })]), part("power", "straight", [hop()]), part("main", "straight", [squat()])], "develop"))).toEqual([]);
  });

  it("a jump in a circuit, a ladder, a flow or holds is a warning at the part's format, fixed to straight sets", () => {
    for (const format of ["circuit", "ladder", "flow", "holds"]) {
      const d = docOf([warm(), part("power", format, [hop(), stick(), ex("catCow", { reps: 8 })], { rounds: 2 })], "develop");
      const [issue] = only(check(d), "jump_placement");
      expect(issue, format).toMatchObject({ path: "parts[1].format", severity: "warning", fix: "straight" });
      expect(only(check(d), "jump_placement"), format).toHaveLength(1);
    }
  });

  it("a jump after a part holding a lift is a warning at the jump: the legs are no longer fresh", () => {
    const d = docOf([warm(), part("main", "straight", [squat()]), part("power", "straight", [hop()])], "develop");
    expect(jumpIssues(d)).toEqual(["warning@parts[2].items[0].libraryId"]);
    expect(only(check(d), "jump_placement")[0]!.message).toMatch(/fresh/);
    // Jumps beside a lift in the same part play after it too.
    expect(jumpIssues(docOf([warm(), part("main", "straight", [squat(), hop()])], "develop"))).toEqual(["warning@parts[1].items[1].libraryId"]);
  });

  it("a second jumps part is a warning at its jumps: the session's jumps live in one part", () => {
    const d = docOf([warm(), part("power", "straight", [hop()]), part("accessory", "straight", [stick()])], "develop");
    expect(jumpIssues(d)).toEqual(["warning@parts[2].items[0].libraryId"]);
    expect(only(check(d), "jump_placement")[0]!.message).toMatch(/one part/);
  });

  it("jumping-day builds from the engine raise no placement warning", () => {
    for (const { label, plan } of jumpDayBuilds(8)) {
      const issues = validateWorkoutDoc(docFromBuild(stored(plan)), { library: WORLD.data.exercises, activeProfiles: WORLD.data.profiles.active, day: null });
      expect(only(issues, "jump_placement"), label).toEqual([]);
    }
  });
});

describe("too_large (final review I4): a document a Worker cannot afford is refused before anything else is read", () => {
  const huge = (parts: number, items: number): WorkoutDoc =>
    docOf(Array.from({ length: parts }, () => part("main", "straight", Array.from({ length: items }, () => ex("gobletSquat", { sets: 20, reps: 8, perSide: true, restSec: 900 })), { rounds: 50 })));

  it("1,200 items: one error, fast — no other rule runs on it", () => {
    const started = Date.now();
    const issues = check(huge(20, 60));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(codes(issues)).toEqual(["error:too_large@parts"]);
    expect(issues[0]!.message).toMatch(/too large/i);
  });

  it("more steps than the app plays (600), or more than 600 minutes, is an error; at the limits it is not", () => {
    const moves = ["tempoSquat", "bridge", "deadBug", "catCow", "birdDog", "wallSit"];
    const steps = (items: number) => docOf([part("main", "holds", Array.from({ length: items }, (_, i) => ex(moves[i % moves.length]!, { sets: 1, holdSec: 5 })), { rounds: 50 })], "develop");
    expect(only(check(steps(12)), "too_large")).toEqual([]); // 600 steps
    const past = check(steps(13)); // 650 steps
    expect(codes(past)).toEqual(["error:too_large@parts"]);
    expect(past[0]!.message).toBe("This workout is too large: 650 steps, and the most is 600.");
    const long = (sets: number) => docOf([part("main", "holds", [ex("wallSit", { sets, holdSec: 3600 })])]);
    expect(only(check(long(9)), "too_large")).toEqual([]); // 540 minutes and a little
    expect(codes(only(check(long(11)), "too_large"))).toEqual(["error:too_large@parts"]);
  });

  it("more steps than a watch takes (200) is a warning, once, at the parts: the app plays it all, the watch can't take it whole", () => {
    const steps = (rounds: number) => docOf([part("main", "circuit", ["tempoSquat", "bridge", "deadBug", "catCow", "birdDog"].map((id) => ex(id, { sets: 1, holdSec: 5 })), { rounds })], "develop");
    expect(only(check(steps(40)), "too_long_for_watch")).toEqual([]); // 200 steps
    const over = check(steps(41)); // 205 steps
    expect(only(over, "too_large")).toEqual([]);
    expect(only(over, "too_long_for_watch")).toEqual([
      { path: "parts", code: "too_long_for_watch", severity: "warning", message: "This workout has 205 steps and a watch takes 200, so it can't go to the watch whole." },
    ]);
    // Every other rule still reads it (a long document is judged like any other).
    expect(codes(check(steps(41), dayOf(reading(3))))).toContain("warning:mode_above_day@intent.effort");
    // A template is the same document: its size is its own, whatever the day.
    expect(codes(only(check(steps(41), null), "too_long_for_watch"))).toEqual(["warning:too_long_for_watch@parts"]);
  });

  it("only the steps that go to the watch count: free-text moves and run segments never do, so a mixed workout that fits is not warned", () => {
    const free = (name: string): WorkoutItem => ({ kind: "free_exercise", name, dose: { sets: 1, holdSec: 5 } }) as WorkoutItem;
    const run: WorkoutItem = { kind: "run", target: { durationSec: 60 }, effort: "easy" } as WorkoutItem;
    const moves = ["tempoSquat", "bridge", "deadBug"].map((id) => ex(id, { sets: 1, holdSec: 5 }));
    // 3 library moves, 3 free-text moves and a run segment, 40 rounds: 280 steps played, 120 to the watch.
    const mixed = docOf([part("main", "holds", [...moves, free("Wall angels"), free("Toe yoga"), free("Neck rolls"), run], { rounds: 40 })]);
    expect(only(check(mixed), "too_large")).toEqual([]);
    expect(only(check(mixed), "too_long_for_watch")).toEqual([]);
    // 6 library moves and a free-text one, 35 rounds: 210 to the watch — warned with the watch's own count.
    const six = ["tempoSquat", "bridge", "deadBug", "catCow", "birdDog", "wallSit"].map((id) => ex(id, { sets: 1, holdSec: 5 }));
    const over = only(check(docOf([part("main", "holds", [...six, free("Wall angels")], { rounds: 35 })])), "too_long_for_watch");
    expect(over.map((i) => i.message)).toEqual(["This workout has 210 steps and a watch takes 200, so it can't go to the watch whole."]);
  });
});

// ── The condition profiles' rules (parity with the engine) ─────────────────────────────────────────────────────────

describe("condition_never", () => {
  it("a move the profile never allows is an error on any day and in a template, as an item or an alternate", () => {
    for (const day of [dayOf(CALM), dayOf(null), FUTURE(), null]) {
      expect(codes(check(one(ex("testNeverMove", { sets: 2, reps: 10 })), day))).toEqual([`error:condition_never@${P0}.libraryId`]);
    }
    expect(codes(check(one(ex("bridge", { sets: 2, reps: 10 }, alt("deadBug", "testNeverMove")))))).toEqual([`error:condition_never@${P0}.alternates[1].libraryId`]);
  });

  it("a move with no rating for an active profile fails closed", () => {
    expect(codes(check(one(ex("testUnratedMove", { sets: 2, reps: 10 }))))).toEqual([`error:condition_never@${P0}.libraryId`]);
  });

  it("is read through each active profile's own rule (a second profile, rating its own attribute)", () => {
    const knee: ConditionProfile = {
      ...TMJ, id: "testKnee", label: "Knee", attributes: { kneeLoad: { kind: "scale", min: 0, max: 3 } },
      never: (a) => a.kneeLoad === 3, fitsMode: () => true, fitsFormat: () => true, allowPattern: () => true, allowRecord: undefined,
      flareSafe: () => true, flare: () => false, recoveryReason: () => null, buildChecks: () => [],
    };
    const lib = LIBRARY.map((e) => ({ ...e, conditions: { ...e.conditions, testKnee: { kneeLoad: e.id === "gobletSquat" ? 3 : 0 } } }));
    const issues = validateWorkoutDoc(CLEAN, { library: lib, activeProfiles: [TMJ, knee], day: dayOf(CALM, { readings: { tmj: CALM, testKnee: CALM } }) });
    expect(codes(issues)).toEqual(["error:condition_never@parts[1].items[0].libraryId"]);
  });
});

describe("condition_pattern", () => {
  const press = (effort: WorkoutDoc["intent"]["effort"]) => one(ex("halfKneelingPress", { sets: 3, reps: 6 }), effort);

  it("a push-v item in a maintain workout at a calm reading of 1 is an error (the profile allows it only in build)", () => {
    expect(codes(check(press("maintain"), dayOf(reading(1))))).toContain(`error:condition_pattern@${P0}.libraryId`);
    // The same in a template: no day opens it in this mode.
    expect(codes(check(press("maintain"), null))).toContain(`error:condition_pattern@${P0}.libraryId`);
  });

  it("in a develop workout it follows the day: allowed when calm, an error unanswered or above the line", () => {
    expect(only(check(press("develop"), dayOf(reading(1))), "condition_pattern")).toEqual([]);
    expect(only(check(press("develop"), dayOf(null)), "condition_pattern")).toHaveLength(1);
    expect(only(check(press("develop"), dayOf(reading(3))), "condition_pattern")).toHaveLength(1);
    // A template is judged on the calmest day.
    expect(only(check(press("develop"), null), "condition_pattern")).toEqual([]);
  });
});

describe("condition_gate", () => {
  const hop = (effort: WorkoutDoc["intent"]["effort"] = "maintain", extra: Over = {}) => one(ex("pogoHop", { sets: 3, reps: 10 }, extra), effort);

  it("a plyometric item with a null reading is an error: unanswered means not allowed", () => {
    const [issue] = check(hop(), dayOf(null));
    expect(issue).toMatchObject({ path: `${P0}.libraryId`, code: "condition_gate", severity: "error" });
    expect(issue!.message).toMatch(/Jaw \/ head/);
    // A missing reading is the same as a null one.
    expect(codes(check(hop(), dayOf(null, { readings: {} })))).toEqual([`error:condition_gate@${P0}.libraryId`]);
  });

  it("allowed with an answered, calm reading; an error above it, or in a recovery workout whatever the reading", () => {
    expect(check(hop(), dayOf(reading(2)))).toEqual([]);
    expect(codes(check(hop(), dayOf(reading(3))))).toEqual([`error:condition_gate@${P0}.libraryId`]);
    expect(only(check(hop("recover"), dayOf(reading(0))), "condition_gate")).toHaveLength(1);
    expect(only(check(hop("recover"), null), "condition_gate")).toHaveLength(1);
  });

  it("unanswered means not allowed even when a profile's own rule would let an unanswered check through", () => {
    // A made-up profile whose record rule only refuses a high reading: unanswered, the validator still refuses.
    const lib = LIBRARY.map((e) => ({ ...e, conditions: { ...e.conditions, testLenient: {} } }));
    const run = (r: CheckReading | null) =>
      validateWorkoutDoc(one(ex("bridge", { sets: 2, reps: 10 })), { library: lib, activeProfiles: [LENIENT], day: dayOf(null, { readings: { testLenient: r } }) });
    expect(codes(run(null))).toEqual([`error:condition_gate@${P0}.libraryId`]);
    expect(run(null)[0]!.message).toBe("Glute bridge needs today's Lenient check answered first.");
    expect(run(reading(3))).toEqual([]);
    expect(codes(run(reading(6)))).toEqual([`error:condition_gate@${P0}.libraryId`]);
    // A reading with no "before" number and no "feeling off" is unanswered too.
    expect(codes(run({ pre: null, post: 2, feelingOff: false }))).toEqual([`error:condition_gate@${P0}.libraryId`]);
  });

  it("the fix is an alternate the day allows", () => {
    const [issue] = check(hop("maintain", alt("lineHopForwardBack", "bridge")), dayOf(null));
    expect(issue).toMatchObject({ code: "condition_gate", fix: "bridge" });
  });
});

describe("condition_gate_pending", () => {
  const hop = (extra: Over = {}) => one(ex("pogoHop", { sets: 3, reps: 10 }, extra));

  it("a gated item on a future date with no alternate is an error", () => {
    expect(codes(check(hop(), FUTURE()))).toEqual([`error:condition_gate_pending@${P0}.libraryId`]);
  });

  it("with no alternate or easier variant to offer, the fix is a library move for the same slot that passes in recovery and is no jump", () => {
    const [issue] = check(hop(), FUTURE());
    const fix = LIBRARY.find((e) => e.id === issue!.fix);
    const hopRec = record("pogoHop");
    expect(fix).toBeDefined();
    expect(fix!.contraction).not.toContain("plyometric");
    expect(TMJ.fitsMode(fix!.conditions.tmj!, "recovery")).toBe(true);
    expect(fix!.difficulty).toBeLessThanOrEqual(2);
    expect(fix!.load).not.toBe("external");
    expect(fix!.patterns.some((p) => hopRec.patterns.includes(p)) || fix!.regions.some((r) => hopRec.regions.includes(r))).toBe(true);
    // The athlete's set-aside moves and the place's gear are honoured.
    const [aside] = check(hop(), FUTURE(), { excluded: [issue!.fix!] });
    expect(aside!.fix).toBeDefined();
    expect(aside!.fix).not.toBe(issue!.fix);
  });

  it("the library stand-in is never a jump, even where a profile would let one through in recovery", () => {
    const jumpingBridge: ExerciseRecord = { ...BRIDGE, id: "testJumpingBridge", name: "Test jumping bridge", legacyIds: [], contraction: ["plyometric"], easier: [], harder: [] };
    const lib = [jumpingBridge, ...LIBRARY].map((e) => ({ ...e, conditions: { ...e.conditions, testLenient: {} } }));
    const [issue] = validateWorkoutDoc(one(ex("bridge", { sets: 2, reps: 10 })), { library: lib, activeProfiles: [LENIENT], day: FUTURE() });
    expect(issue).toMatchObject({ code: "condition_gate_pending", severity: "error" });
    expect(issue!.fix).toBeDefined();
    expect(issue!.fix).not.toBe("testJumpingBridge");
  });

  it("with an alternate that passes in recovery mode it is a warning, the alternate its fix", () => {
    const [issue] = check(hop(alt("bridge")), FUTURE());
    expect(issue).toMatchObject({ path: `${P0}.libraryId`, code: "condition_gate_pending", severity: "warning", fix: "bridge" });
  });

  it("an alternate that is itself gated (or fails recovery) does not count", () => {
    expect(codes(check(hop(alt("lineHopForwardBack")), FUTURE()))).toEqual([`error:condition_gate_pending@${P0}.libraryId`]);
    expect(codes(check(hop(alt("farmerCarry")), FUTURE()))).toEqual([`error:condition_gate_pending@${P0}.libraryId`]);
  });

  it("an easier variant is not an alternate the item carries: still an error, the variant offered as the fix", () => {
    const [issue] = check(one(ex("testHopEasier", { sets: 3, reps: 10 })), FUTURE());
    expect(issue).toMatchObject({ code: "condition_gate_pending", severity: "error", fix: "bridge" });
  });

  it("a future date ignores today's reading (it is not that day's)", () => {
    expect(codes(check(hop(), FUTURE(reading(0))))).toEqual([`error:condition_gate_pending@${P0}.libraryId`]);
  });
});

describe("condition_mode", () => {
  it("a move the profile caps out of the workout's mode is a warning", () => {
    // Lying face down is out of recovery; farmer carry is rated above what recovery allows (and is loaded: mode_limits).
    expect(codes(check(one(ex("proneYTW", { sets: 2, reps: 8 }), "recover", "holds")))).toEqual([`warning:condition_mode@${P0}.libraryId`]);
    expect(codes(check(one(ex("farmerCarry", { sets: 2, carryM: 40 }), "recover", "holds")))).toEqual([
      `warning:condition_mode@${P0}.libraryId`,
      `warning:mode_limits@${P0}.libraryId`,
    ]);
    expect(check(one(ex("farmerCarry", { sets: 2, carryM: 40 }), "maintain"))).toEqual([]);
  });
});

describe("condition_format", () => {
  it("a circuit holding a clench-2 move is a warning; so is intervals (read as a circuit); straight sets are fine", () => {
    const stations = (format: string) =>
      docOf([part("main", format, [ex("nordicCurlAssisted", { sets: 1, holdSec: 40 }), ex("bridge", { sets: 1, holdSec: 40 }), ex("deadBug", { sets: 1, holdSec: 40 })], { rounds: 2 })], "develop");
    expect(codes(check(stations("circuit")))).toEqual([`warning:condition_format@${P0}.libraryId`]);
    expect(codes(check(stations("intervals")))).toEqual([`warning:condition_format@${P0}.libraryId`]);
    expect(check(one(ex("nordicCurlAssisted", { sets: 2, reps: 5 }), "develop"))).toEqual([]);
    // steady reads as straight.
    expect(check(one(ex("nordicCurlAssisted", { sets: 2, reps: 5 }), "develop", "steady"))).toEqual([]);
  });

  it("the fix is an alternate that suits the format", () => {
    const d = docOf([part("main", "circuit", [ex("nordicCurlAssisted", { sets: 1, holdSec: 40 }, alt("hamstringBridgeChair")), ex("bridge", { sets: 1, holdSec: 40 }), ex("deadBug", { sets: 1, holdSec: 40 })])], "develop");
    expect(check(d)).toEqual([expect.objectContaining({ code: "condition_format", fix: "hamstringBridgeChair" })]);
  });
});

describe("condition_flare", () => {
  it("on a flare day a move that is not flare-safe is a warning; a flare-safe one is not", () => {
    const flare = dayOf(reading(6));
    expect(only(check(one(ex("farmerCarry", { sets: 2, carryM: 40 }), "recover"), flare), "condition_flare").map((i) => i.path)).toEqual([`${P0}.libraryId`]);
    expect(only(check(one(ex("bridge", { sets: 2, reps: 10 }), "recover"), flare), "condition_flare")).toEqual([]);
    // Not a flare day: nothing.
    expect(only(check(one(ex("farmerCarry", { sets: 2, carryM: 40 }), "maintain"), dayOf(reading(3))), "condition_flare")).toEqual([]);
  });
});

describe("mode_above_day", () => {
  it("a high reading with a develop workout is a warning carrying the profile's own sentence", () => {
    const [issue] = only(check(one(ex("bridge", { sets: 2, reps: 10 }), "develop"), dayOf(reading(6))), "mode_above_day");
    expect(issue).toMatchObject({ path: "intent.effort", severity: "warning", message: "Jaw/head is at 6 right now.", fix: "recover" });
  });

  it("a develop workout on a day the profile's build checks fail carries the failed check's words", () => {
    expect(check(one(ex("bridge", { sets: 2, reps: 10 }), "develop"), dayOf(reading(3)))).toEqual([
      expect.objectContaining({ code: "mode_above_day", message: "A Develop or Peak day needs a calm jaw (2 or less) — you're at 3.", fix: "maintain" }),
    ]);
    // The recent sessions are read too: a flare in the last week.
    const flared = { id: "s1", date: addDays(TODAY, -2), startedAt: null, mode: "consistent" as const, theme: null, blockNumber: null, checks: { tmj: reading(6) }, done: [], entries: [] };
    const issues = check(one(ex("bridge", { sets: 2, reps: 10 }), "develop"), dayOf(reading(1), { recent: { last: flared, week: [flared] } }));
    expect(issues).toEqual([expect.objectContaining({ code: "mode_above_day", message: "Your jaw has flared in the last 7 days." })]);
  });

  it("a maintain workout on a calm day, a recover workout on a flare day, a template and a future day raise nothing", () => {
    expect(only(check(one(ex("bridge", { sets: 2, reps: 10 }), "maintain"), dayOf(reading(3))), "mode_above_day")).toEqual([]);
    expect(only(check(one(ex("bridge", { sets: 2, reps: 10 }), "recover"), dayOf(reading(7))), "mode_above_day")).toEqual([]);
    expect(only(check(one(ex("bridge", { sets: 2, reps: 10 }), "develop"), null), "mode_above_day")).toEqual([]);
    expect(only(check(one(ex("bridge", { sets: 2, reps: 10 }), "develop"), FUTURE(reading(8))), "mode_above_day")).toEqual([]);
  });
});

describe("excluded_by_athlete and equipment_unavailable", () => {
  it("a move the athlete set aside is a warning, the fix an alternate they did not", () => {
    const d = one(ex("bridge", { sets: 2, reps: 10 }, alt("singleLegBridge", "deadBug")));
    expect(check(d, dayOf(CALM), { excluded: ["bridge", "singleLegBridge"] })).toEqual([
      expect.objectContaining({ path: `${P0}.libraryId`, code: "excluded_by_athlete", severity: "warning", fix: "deadBug" }),
      // An alternate set aside is a cost too.
      expect.objectContaining({ path: `${P0}.alternates[0].libraryId`, code: "excluded_by_athlete", severity: "warning" }),
    ]);
    // A legacy id in the list still names the move.
    expect(only(check(d, dayOf(CALM), { excluded: ["oldBridge"] }), "excluded_by_athlete")).toHaveLength(1);
  });

  it("a move that needs gear the place lacks is a warning, the fix an alternate that fits the place", () => {
    const d = one(ex("gobletSquat", { sets: 3, reps: 8 }, alt("boxSquat", "tempoSquat")));
    expect(check(d, dayOf(CALM), { equipment: ["mat"] })).toEqual([
      expect.objectContaining({ path: `${P0}.libraryId`, code: "equipment_unavailable", severity: "warning", fix: "tempoSquat" }),
      // The box squat alternate needs a bench or a chair.
      expect.objectContaining({ path: `${P0}.alternates[0].libraryId`, code: "equipment_unavailable", severity: "warning" }),
    ]);
    expect(codes(check(d, dayOf(CALM), { equipment: ["mat", "kettlebell"] }))).toEqual([`warning:equipment_unavailable@${P0}.alternates[0].libraryId`]);
    expect(check(d, dayOf(CALM), { equipment: ["mat", "kettlebell", "chair"] })).toEqual([]);
    // No place given: nothing to check against.
    expect(check(d)).toEqual([]);
  });
});

// ── Fix round 1: alternates, the mode's limits, the jump frontier, feeling off ─────────────────────────────────────

describe("alternates meet the same rules as the move they stand in for", () => {
  const withAlt = (id: string, effort: WorkoutDoc["intent"]["effort"] = "maintain", format = "straight") =>
    one(ex("bridge", { sets: 2, reps: 10 }, alt(id)), effort, format);
  const A0 = `${P0}.alternates[0].libraryId`;

  it("a jump offered in a recovery workout is an error at the alternate", () => {
    expect(codes(check(withAlt("pogoHop", "recover", "holds")))).toEqual([`error:condition_gate@${A0}`]);
  });

  it("an overhead press offered in a maintain workout is an error at the alternate", () => {
    expect(codes(check(withAlt("halfKneelingPress")))).toEqual([`error:condition_pattern@${A0}`]);
  });

  it("a jump offered on an unanswered day is an error at the alternate; allowed on a calm, answered one", () => {
    expect(codes(check(withAlt("pogoHop"), dayOf(null)))).toEqual([`error:condition_gate@${A0}`]);
    expect(check(withAlt("pogoHop"), dayOf(CALM))).toEqual([]);
  });

  it("on a future day an alternate's gate adds nothing (the item's own pending rule covers the day)", () => {
    expect(check(withAlt("pogoHop"), FUTURE())).toEqual([]);
  });

  it("the soft rules warn at the alternate: mode, format, the mode's limits", () => {
    expect(codes(check(withAlt("farmerCarry", "recover", "holds")))).toEqual([`warning:condition_mode@${A0}`, `warning:mode_limits@${A0}`]);
    const circuit = docOf([part("main", "circuit", [ex("bridge", { sets: 1, holdSec: 40 }, alt("nordicCurlAssisted")), ex("deadBug", { sets: 1, holdSec: 40 }), ex("birdDog", { sets: 1, holdSec: 40 })])], "develop");
    expect(codes(check(circuit))).toEqual([`warning:condition_format@${A0}`]);
  });
});

describe("mode_limits", () => {
  const none = { activeProfiles: [] as ConditionProfile[] };

  it("works with no active profile: a difficulty-5 move in a recovery workout is a warning", () => {
    const [issue] = check(one(ex("tuckJump", { sets: 2, reps: 3 }), "recover", "holds"), dayOf(CALM), none);
    expect(issue).toMatchObject({ path: `${P0}.libraryId`, code: "mode_limits", severity: "warning", message: "Tuck jump is harder than a Recover day takes." });
  });

  it("a loaded move in a recovery workout is a warning; the same move on a maintain day is not", () => {
    expect(check(one(ex("gobletSquat", { sets: 2, reps: 8 }), "recover", "holds"), dayOf(CALM), none)).toEqual([
      expect.objectContaining({ code: "mode_limits", message: "Goblet squat uses added weight, which a Recover day leaves out." }),
    ]);
    expect(check(one(ex("gobletSquat", { sets: 2, reps: 8 }), "maintain"), dayOf(CALM), none)).toEqual([]);
  });

  it("names the day in the document's own effort words — a Maintain day — never the engine's mode name", () => {
    // A move the profile keeps out of this effort whatever the reading, and a format it does not use.
    expect(only(check(one(ex("halfKneelingPress", { sets: 2, reps: 6 }), "maintain")), "condition_pattern")[0]!.message).toBe(
      "Half-kneeling one-arm press isn't allowed on a Maintain day with TMJ.",
    );
    const circuit = docOf([part("main", "circuit", ["bridge", "deadBug", "birdDog"].map((id) => ex(id, { sets: 1, holdSec: 40 })), { rounds: 2 })], "maintain");
    expect(only(check(circuit), "mode_limits")[0]!.message).toBe("A Maintain day doesn't use a circuit.");
    // A loaded move on a Recover day, and a hard one: the effort's word, not "recovery".
    expect(only(check(one(ex("gobletSquat", { sets: 2, reps: 8 }), "recover", "holds")), "mode_limits")[0]!.message).toBe(
      "Goblet squat uses added weight, which a Recover day leaves out.",
    );
    const all = [
      ...check(one(ex("halfKneelingPress", { sets: 2, reps: 6 }), "maintain")),
      ...check(circuit),
      ...check(one(ex("tuckJump", { sets: 2, reps: 3 }), "recover", "holds")),
    ].map((i) => i.message);
    for (const m of all) expect(m).not.toMatch(/\b(consistent|recovery|build) day\b/);
  });

  it("a part whose format the mode does not use is a warning — only when it holds exercises", () => {
    const stations = (format: string, effort: WorkoutDoc["intent"]["effort"]) =>
      docOf([part("main", format, ["bridge", "deadBug", "birdDog"].map((id) => ex(id, { sets: 1, holdSec: 40 })), { rounds: 2 })], effort);
    expect(check(stations("circuit", "maintain"))).toEqual([
      expect.objectContaining({ path: "parts[0].format", code: "mode_limits", severity: "warning", fix: "straight" }),
    ]);
    expect(codes(check(stations("intervals", "maintain")))).toEqual(["warning:mode_limits@parts[0].format"]);
    expect(check(stations("circuit", "develop"))).toEqual([]);
    expect(check(one(ex("bridge", { sets: 2, reps: 10 }), "recover"))).toEqual([expect.objectContaining({ path: "parts[0].format", code: "mode_limits", fix: "holds" })]);
    const runIntervals = docOf([part("run", "intervals", [{ kind: "run", effort: "strides", target: { durationSec: 20 } } as WorkoutItem, { kind: "rest", seconds: 40 }], { rounds: 4 })]);
    expect(check(runIntervals)).toEqual([]);
  });

  it("a loaded move never passes in recovery as a future day's alternate, nor is offered as a fix there", () => {
    // Goblet carry suits the profile in recovery but is loaded.
    expect(codes(check(one(ex("pogoHop", { sets: 3, reps: 10 }, alt("gobletCarry"))), FUTURE()))).toEqual([`error:condition_gate_pending@${P0}.libraryId`]);
    const [issue] = check(one(ex("pogoHop", { sets: 3, reps: 10 }, alt("gobletCarry", "bridge")), "recover", "holds"));
    expect(issue).toMatchObject({ code: "condition_gate", fix: "bridge" });
  });

  it("a Recover day takes one straight set of an easy activation or mobility move (Task 13, A15): no strength work in it", () => {
    const recover = (items: WorkoutItem[], extra: Over = {}) => docOf([part("activation", "straight", items, extra)], "recover");
    // One set of hip lifts with a pause, the activation the audit saw flagged.
    expect(check(recover([ex("bridge", { sets: 1, reps: 6, tempo: { pauseSec: 2 } })]))).toEqual([]);
    // A set count left to the record's own (the bridge names none: one set), and a part of several such moves.
    expect(check(recover([ex("bridge", { reps: 8 }), ex("catCow", { sets: 1, reps: 8 })]))).toEqual([]);
    expect(check(recover([ex("bridge", { sets: 1, reps: 8 })]), null, { activeProfiles: [] })).toEqual([]);
    // Still the format's cost: a second set, a second round, a strength move, a move past the easy line, a free-text move.
    const formatCost = (doc: WorkoutDoc) => only(check(doc, dayOf(CALM), { activeProfiles: [] }), "mode_limits").filter((i) => i.path === "parts[0].format");
    expect(formatCost(recover([ex("bridge", { sets: 2, reps: 8 })]))).toEqual([expect.objectContaining({ code: "mode_limits", fix: "holds", message: "A Recover day doesn't use straight sets." })]);
    // A dose that names no sets plays the record's own low count: two for the dead bug.
    expect(formatCost(recover([ex("deadBug", { reps: 8 })]))).toHaveLength(1);
    expect(formatCost(recover([ex("deadBug", { sets: 1, reps: 8 })]))).toEqual([]);
    expect(formatCost(recover([ex("bridge", { sets: 1, reps: 8 })], { rounds: 2 }))).toHaveLength(1);
    expect(formatCost(recover([ex("bridge", { sets: 1, reps: 8 }), ex("boxSquat", { sets: 1, reps: 8 })]))).toHaveLength(1);
    expect(formatCost(recover([ex("reversePlank", { sets: 1, holdSec: 20 })]))).toHaveLength(1);
    expect(formatCost(recover([ex("cableFacePull", { sets: 1, reps: 12 })]))).toHaveLength(1);
    // Only straight sets: the same two single sets as a superset are still the format's cost.
    expect(formatCost(docOf([part("activation", "superset", [ex("bridge", { sets: 1, reps: 8 }), ex("catCow", { sets: 1, reps: 8 })])], "recover"))).toEqual([
      expect.objectContaining({ message: "A Recover day doesn't use a superset." }),
    ]);
    expect(formatCost(recover([ex("bridge", { sets: 1, reps: 8 }), { kind: "free_exercise", name: "Hip lift", dose: { sets: 1, reps: 8 } } as WorkoutItem]))).toHaveLength(1);
    // The rule is the Recover day's: a Maintain day's straight sets were never a cost.
    expect(formatCost(docOf([part("main", "straight", [ex("boxSquat", { sets: 3, reps: 8 })])], "maintain"))).toEqual([]);
  });
});

describe("care_share (Task 13, A10): a cared-for profile's care part, measured against its share of the minutes", () => {
  // Timed holds, one set each: every item plays its seconds plus the 15 s transition (derive.ts).
  const hold = (id: string, holdSec: number): WorkoutItem => ex(id, { sets: 1, holdSec });
  /** 20 minutes of easy work that is no care: four 285 s holds, each with its 15 s transition. */
  const OTHER: WorkoutPart[] = [
    part("warmup", "holds", [hold("childBlock", 285), hold("catCow", 285)]),
    part("cooldown", "holds", [hold("figureFour", 285), hold("legsUp", 285)]),
  ];
  const recoverWith = (care: WorkoutItem[], effort: WorkoutDoc["intent"]["effort"] = "recover", other: WorkoutPart[] = OTHER): WorkoutDoc =>
    docOf([...other.slice(0, 1), part("care", "holds", care), ...other.slice(1)], effort);
  const share = (doc: WorkoutDoc, o: Partial<ValidateCtx> = {}) => only(check(doc, dayOf(CALM), o), "care_share");

  it("a Recover draft with about a tenth of its minutes in care is a warning at the care part; one at about 27% is not", () => {
    // 2 of 22 minutes (9%).
    const thin = recoverWith([hold("rocabado", 105)]);
    expect(share(thin)).toEqual([
      {
        path: "parts[1]", code: "care_share", severity: "warning",
        message: "Jaw care is 2 of 22 minutes (9%); a Recover day gives it about 27% — about 6 minutes, 3–6 moves.",
      },
    ]);
    // 8 of 28 minutes (29%).
    const full = recoverWith([hold("rocabado", 165), hold("tongueRest", 90), hold("jawMassage", 105), hold("suboccipitalRelease", 45)]);
    expect(share(full)).toEqual([]);
    // Nothing else in either draft is a cost: the share is the only thing between them.
    expect(check(full)).toEqual([]);
    expect(codes(check(thin))).toEqual(["warning:care_share@parts[1]"]);
  });

  it("allows about a third under the share — the engine's short sessions round a one-minute care move — and not more", () => {
    // 20 + 4 = 24 minutes: the share is about 6.5 minutes; 4 is at its floor (two thirds, in whole minutes), 3 is under.
    expect(share(recoverWith([hold("rocabado", 225)]))).toEqual([]);
    expect(share(recoverWith([hold("rocabado", 165)]))).toHaveLength(1);
  });

  it("each effort reads its own share: a tenth on a Maintain day, 7% on a Develop or Peak day", () => {
    // 20 + 1 = 21 minutes: a one-minute care move is under a Recover day's share, and within a Maintain or Develop day's.
    const one1 = (effort: WorkoutDoc["intent"]["effort"]) => recoverWith([hold("rocabado", 45)], effort);
    expect(share(one1("recover"))).toHaveLength(1);
    expect(share(one1("maintain"))).toEqual([]);
    expect(share(one1("develop"))).toEqual([]);
    // 41 minutes with no care move in the care part: under every effort's share, each named.
    const long = [...OTHER, part("main", "holds", [hold("childHands", 285), hold("catCow", 285), hold("figureFour", 285), hold("legsUp", 285)])];
    const none = (effort: WorkoutDoc["intent"]["effort"]) => share(recoverWith([hold("breath", 45)], effort, long))[0]?.message;
    expect(none("maintain")).toMatch(/^Jaw care is 0 of 41 minutes \(0%\); a Maintain day gives it about 10% — about 4 minutes, 1–3 moves\./);
    expect(none("peak")).toMatch(/^Jaw care is 0 of 41 minutes \(0%\); a Peak day gives it about 7% — about 3 minutes, 1–3 moves\./);
  });

  it("counts only the moves made for that care, wherever they are — and says which in the care part are not", () => {
    // Breathing for the jaw in the care part is no care move: it isn't counted, and it is named.
    const breathOnly = recoverWith([hold("breath", 105), hold("rocabado", 45)]);
    expect(share(breathOnly)[0]!.message).toBe(
      "Jaw care is 1 of 23 minutes (4%); a Recover day gives it about 27% — about 6 minutes, 3–6 moves. Only jaw care moves count: Jaw reset breathing isn't one.",
    );
    // A care move in the cool-down counts toward the share: 2 in the care part and 4 there, of 21 minutes (2 alone is under).
    const spread = docOf([OTHER[0]!, part("care", "holds", [hold("rocabado", 105)]), part("cooldown", "holds", [hold("figureFour", 285), hold("jawMassage", 225)])], "recover");
    expect(share(spread)).toEqual([]);
    expect(share({ ...spread, parts: [...spread.parts.slice(0, 2), part("cooldown", "holds", [hold("figureFour", 285), hold("legsUp", 225)])] })).toHaveLength(1);
  });

  it("is judged only for a document with a care part, and only for a profile with care", () => {
    expect(share(docOf(OTHER, "recover"))).toEqual([]);
    expect(share(recoverWith([hold("rocabado", 45)]), { activeProfiles: [] })).toEqual([]);
    expect(share(recoverWith([hold("rocabado", 45)]), { activeProfiles: [{ ...TMJ, care: null }] })).toEqual([]);
    // A care move in a workout with no care part — one chin tuck in the athlete's own Studio session — sets out no care
    // block, so its share isn't judged (round 2, Minor 4).
    expect(share(docOf([...OTHER, part("cooldown", "holds", [hold("rocabado", 45)])], "recover"))).toEqual([]);
    expect(share(docOf([part("main", "straight", [ex("boxSquat", { sets: 3, reps: 8 }), ex("chinTuck", { sets: 1, reps: 8 })])], "develop"))).toEqual([]);
  });

  it("counts a rest between care moves as care, as the session's minutes count every rest (round 2, Minor 4)", () => {
    const rest = (seconds: number): WorkoutItem => ({ kind: "rest", seconds }) as WorkoutItem;
    const minutesIn = (doc: WorkoutDoc) => /^Jaw care is (\d+) of (\d+) minutes/.exec(share(doc)[0]?.message ?? "")?.slice(1).map(Number);
    // Three one-minute care moves with a minute's rest between each: 5 of 25 minutes, within a Recover day's share.
    expect(share(recoverWith([hold("rocabado", 45), rest(60), hold("jawMassage", 45), rest(60), hold("tongueRest", 45)]))).toEqual([]);
    // Counted, not left out: two care moves and the rest between them, 3 of 23; a rest at the care part's end is its own.
    expect(minutesIn(recoverWith([hold("rocabado", 45), rest(60), hold("jawMassage", 45)]))).toEqual([3, 23]);
    expect(minutesIn(recoverWith([hold("rocabado", 45), hold("jawMassage", 45), rest(60)]))).toEqual([3, 23]);
    // A rest that leads into a move that is no care, or that opens the part, is not care's.
    expect(minutesIn(recoverWith([hold("rocabado", 45), rest(60), hold("breath", 45)]))).toEqual([1, 23]);
    expect(minutesIn(recoverWith([rest(60), hold("rocabado", 45)]))).toEqual([1, 22]);
  });

  it("measures the share against the session's minutes without its runs", () => {
    // A 30-minute run, then 8 minutes of mobility holding 3 of care: 3 of 8 is the share; 3 of 38 would not be.
    const run: WorkoutPart = part("run", "steady", [{ kind: "run", effort: "easy", target: { durationSec: 1800 } } as WorkoutItem]);
    const doc = docOf([run, part("warmup", "holds", [hold("catCow", 285)]), part("care", "holds", [hold("rocabado", 165)])], "recover");
    expect(share(doc)).toEqual([]);
    expect(share({ ...doc, parts: [part("warmup", "holds", [hold("catCow", 285), hold("childBlock", 1500)]), doc.parts[2]!] })).toHaveLength(1);
  });

  it("the engine's own builds give care and keep within the share (every mode)", () => {
    const builds = seededBuilds(50);
    const care = builds.filter(({ plan }) => docFromBuild(stored(plan)).parts.some((p) => p.purpose === "care"));
    expect(care.length).toBeGreaterThan(40);
    for (const { label, plan } of builds) {
      const doc = docFromBuild(stored(plan));
      expect(only(validateWorkoutDoc(doc, { library: WORLD.data.exercises, activeProfiles: WORLD.data.profiles.active, day: null }), "care_share"), label).toEqual([]);
    }
  });
});

describe("progression_jump", () => {
  const hop = (id: string, effort: WorkoutDoc["intent"]["effort"] = "maintain") => one(ex(id, { sets: 3, reps: 4 }), effort);
  const done = (...ids: string[]) => dayOf(CALM, { done: new Set(ids) });

  it("a jump past the athlete's frontier is a warning, the frontier move its fix", () => {
    const [issue] = check(hop("pogoHop"), done());
    expect(issue).toMatchObject({ path: `${P0}.libraryId`, code: "progression_jump", severity: "warning", fix: "snapDown" });
    expect(issue!.message).toBe("Pogo hops is a step past the jumps you've done; Snap-down comes first.");
    expect(check(hop("pogoHop"), done("snapDown"))).toEqual([]);
  });

  it("walks down to the first move on the frontier", () => {
    expect(check(hop("tuckJump", "develop"), done())[0]).toMatchObject({ code: "progression_jump", fix: "snapDown" });
    expect(check(hop("tuckJump", "develop"), done("snapDown"))[0]).toMatchObject({ code: "progression_jump", fix: "broadJumpStick" });
    expect(check(hop("tuckJump", "develop"), done("broadJumpStick"))).toEqual([]);
  });

  it("its fix is never a move the day refuses: at a jaw of 6 the snap-down is a jump kept out too, so it is not offered (CUJ re-walk)", () => {
    const gated = dayOf(reading(6), { done: new Set<string>() });
    const refused = (id: string) => check(hop(id), gated).some((i) => i.severity === "error" && i.path === `${P0}.libraryId`);
    expect(refused("snapDown")).toBe(true);
    const jump = check(hop("pogoHop"), gated).find((i) => i.code === "progression_jump")!;
    expect(jump).toBeDefined();
    expect(jump.fix).not.toBe("snapDown");
    expect(jump.message).not.toContain("Snap-down");
    if (jump.fix) expect(refused(jump.fix)).toBe(false);
    // On a calm day it is still the frontier move.
    expect(check(hop("pogoHop"), done())[0]).toMatchObject({ code: "progression_jump", fix: "snapDown" });
  });

  it("reads a done move by any id it has gone by", () => {
    const lib = LIBRARY.map((e) => (e.id === "snapDown" ? { ...e, legacyIds: [...e.legacyIds, "oldSnapDown"] } : e));
    const issues = validateWorkoutDoc(hop("pogoHop"), { library: lib, activeProfiles: [TMJ], day: dayOf(CALM, { done: new Set(["oldSnapDown"]) }) });
    expect(issues).toEqual([]);
  });

  it("is not checked without the athlete's done moves, and never for a move that is no jump", () => {
    expect(check(hop("pogoHop"))).toEqual([]);
    expect(check(one(ex("bwBulgarianSplitSquat", { sets: 3, reps: 8 })), done())).toEqual([]);
  });
});

describe("feeling off, for the day", () => {
  it("is seen with no active profile: a workout above recovery carries the warning", () => {
    const issues = validateWorkoutDoc(one(ex("bridge", { sets: 2, reps: 10 })), { library: LIBRARY, activeProfiles: [], day: dayOf(null, { readings: {}, feelingOff: true }) });
    expect(issues).toEqual([{ path: "intent.effort", code: "mode_above_day", message: "You said you're feeling off.", fix: "recover", severity: "warning" }]);
    expect(validateWorkoutDoc(one(ex("bridge", { sets: 2, reps: 10 }), "recover", "holds"), { library: LIBRARY, activeProfiles: [], day: dayOf(null, { readings: {}, feelingOff: true }) })).toEqual([]);
  });

  it("applies to every profile's reading: a jump on a feeling-off day is an error, and the day's warning comes once", () => {
    const issues = check(one(ex("pogoHop", { sets: 3, reps: 10 })), dayOf(CALM, { feelingOff: true }));
    expect(codes(issues)).toEqual(["warning:mode_above_day@intent.effort", `error:condition_gate@${P0}.libraryId`]);
    expect(issues[1]!.message).toBe("Pogo hops isn't allowed while you're feeling off.");
  });
});

describe("condition_flare reads the shared flare-safe verdict", () => {
  it("a jump rated gently is still not flare-safe: on a flare day it warns", () => {
    expect(only(check(one(ex("pogoHop", { sets: 3, reps: 10 }), "recover", "holds"), dayOf(reading(6))), "condition_flare")).toHaveLength(1);
  });
});

// ── The engine and the validator agree ─────────────────────────────────────────────────────────────────────────────

describe("the engine's own builds validate", () => {
  interface EngineCase {
    label: string;
    /** At the reading the engine built with. */
    issues: DocIssue[];
    /** Item and alternate paths the engine's own eligibility (`fitsMode` with the day's checks) refuses on an unanswered day. */
    engineRefusesUnanswered: string[];
    /** The same, items only. */
    engineRefusesItems: string[];
    /** The same day, unanswered: the items and alternates the validator refuses by a pattern or record rule. */
    validatorRefusesUnanswered: string[];
    /** Two days ahead: the items the validator holds pending (an alternate's gate adds nothing ahead). */
    pendingAhead: string[];
  }

  /** Engine builds at calm readings (0–2), every mode, the world's history, places, themes and swaps. */
  function engineCases(mode: Mode, n: number): EngineCase[] {
    const { data, renamed } = WORLD;
    const h = seededHistory(data, renamed, `validate-${mode}`, 120);
    const rng = Rng.create(`validate|${mode}`);
    const out: EngineCase[] = [];
    for (let i = 0; i < n; i++) {
      const cut = 3 + Math.floor(rng() * (h.sessions.length - 3));
      const today = addDays(h.sessions[cut - 1]!.date, 1 + Math.floor(rng() * 3));
      const place = LOCATIONS[i % 3]!;
      const past = h.sessions.slice(0, cut);
      const program: ProgramState = {
        programId: "p-validate",
        settings: { unit: rng() < 0.5 ? "lb" : "kg", weeklyGoal: 3 + Math.floor(rng() * 3), blockWeeks: 5, defaultMinutes: [15, 20, 30, 40, 45, 60][Math.floor(rng() * 6)]!, location: place.id },
        locations: LOCATIONS,
        prefs: h.prefs,
        savedIds: [],
        block: h.blocks[Math.min(cut, h.blocks.length - 1)] ?? null,
        sessions: past,
      };
      // Any theme of the mode, the Studio-only ones too: their moves (jumps, overhead presses) are the gated ones.
      const override: DayState["override"] = { mode };
      const themes = data.themes.filter((t) => t.modes.includes(mode));
      if (rng() < 0.7 && themes.length) override.theme = themes[Math.floor(rng() * themes.length)]!.id;
      if (rng() < 0.6) override.minutes = [15, 25, 30, 40, 45, 60][Math.floor(rng() * 6)]!;
      const calm = reading(Math.floor(rng() * 3));
      const day: DayState = { date: today, checks: { tmj: calm }, feelingOff: false, override, swaps: {} };
      let plan = Planner.planToday(data, { today, day }, program).view.plan;
      if (i % 2 === 1) {
        const swaps: Record<string, { from: string; to: string }> = {};
        for (const [slotKey, alts] of Object.entries(plan.alternatives).filter(([, a]) => a.length)) {
          if (rng() < 0.5 || Object.keys(swaps).length >= 3) continue;
          swaps[slotKey] = { from: plan.items.find((it) => it.slotKey === slotKey)!.exercise.id, to: alts[Math.floor(rng() * alts.length)]!.id };
        }
        if (Object.keys(swaps).length) plan = Planner.planToday(data, { today, day: { ...day, swaps } }, program).view.plan;
      }
      const doc = docFromBuild(stored(plan));
      const week = past.filter((s) => daysBetween(s.date, today) < 7);
      const recent = { last: past.at(-1) ?? null, week };
      const base = { library: data.exercises, activeProfiles: data.profiles.active, excluded: h.prefs.excluded, equipment: place.equipment };
      const issues = validateWorkoutDoc(doc, { ...base, day: { date: today, today, readings: { tmj: calm }, recent } });
      const unanswered = validateWorkoutDoc(doc, { ...base, day: { date: today, today, readings: { tmj: null }, recent } });
      const ahead = validateWorkoutDoc(doc, { ...base, day: { date: addDays(today, 2), today, readings: { tmj: calm }, recent } });
      const engineRefusesUnanswered: string[] = [];
      const engineRefusesItems: string[] = [];
      const refuses = (id: string): boolean => !fitsMode(data, data.exercises.find((e) => e.id === id)!, plan.mode, { tmj: UNANSWERED });
      doc.parts.forEach((p, pi) =>
        p.items.forEach((it, ii) => {
          if (it.kind !== "exercise") return;
          const at = `parts[${pi}].items[${ii}]`;
          if (refuses(it.libraryId)) engineRefusesUnanswered.push(`${at}.libraryId`), engineRefusesItems.push(`${at}.libraryId`);
          (it.alternates ?? []).forEach((a, ai) => {
            if (refuses(a.libraryId)) engineRefusesUnanswered.push(`${at}.alternates[${ai}].libraryId`);
          });
        }),
      );
      const pathsOf = (list: DocIssue[], keep: (i: DocIssue) => boolean): string[] => [...new Set(list.filter(keep).map((i) => i.path))];
      out.push({
        label: `${mode} build ${i} (${override.theme ?? "no theme"}, ${today}, pre ${calm.pre}, ${place.id})`,
        issues,
        engineRefusesUnanswered,
        engineRefusesItems,
        validatorRefusesUnanswered: pathsOf(unanswered, (i) => i.severity === "error" && (i.code === "condition_gate" || i.code === "condition_pattern")),
        pendingAhead: pathsOf(ahead, (i) => i.code === "condition_gate_pending"),
      });
    }
    return out;
  }

  for (const mode of ["recovery", "consistent", "build"] as const) {
    it(`200 seeded ${mode} builds at a calm reading carry no error; unanswered or ahead, the validator gates exactly what the engine would`, () => {
      const cases = engineCases(mode, 200);
      const errors = cases.flatMap((r) => r.issues.filter((i) => i.severity === "error").map((i) => `${r.label}: ${i.code} ${i.path} — ${i.message}`));
      expect(errors).toEqual([]);
      // The engine places by these rules, so the validator must not disagree even softly. (Only mode_above_day may
      // warn: the builds force the mode, which the profile's own proposal may not have chosen.)
      const engineRules = new Set<string>(DOC_ISSUE_CODES.filter((c) => c !== "mode_above_day"));
      const disagreements = cases.flatMap((r) => r.issues.filter((i) => engineRules.has(i.code)).map((i) => `${r.label}: ${i.code} ${i.path} — ${i.message}`));
      expect(disagreements).toEqual([]);
      // Unanswered, the validator refuses exactly what the engine's eligibility refuses, items and alternates alike; two
      // days ahead, exactly the items wait on the day.
      for (const c of cases) {
        expect(c.validatorRefusesUnanswered, c.label).toEqual(c.engineRefusesUnanswered);
        expect(c.pendingAhead, c.label).toEqual(c.engineRefusesItems);
      }
      // Not vacuous: the builds hold gated moves (jumps on plyometric days; overhead presses in build).
      if (mode !== "recovery") expect(cases.reduce((n, c) => n + c.engineRefusesItems.length, 0)).toBeGreaterThan(10);
    });
  }
});
