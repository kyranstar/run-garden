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
import { WORLD, stored } from "./seeded-builds.js";

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
        "bounds", "condition_flare", "condition_format", "condition_gate", "condition_gate_pending", "condition_mode", "condition_never",
        "condition_pattern", "dose_mismatch", "equipment_unavailable", "excluded_by_athlete", "format_mismatch", "legacy_id", "mode_above_day",
        "unknown_equipment", "unknown_exercise", "unknown_focus",
      ].sort(),
    );
  });

  it("never names a profile: every condition rule is read through the profile contract", () => {
    const src = readFileSync(new URL("../src/validate.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/tmj|jaw|clench|neckLoad|faceDown|plyometric|push-v/i);
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
    const circuit = (n: number) => docOf([part("main", "circuit", ["bridge", "deadBug", "birdDog", "tempoSquat", "bwSplitSquat", "wallPushup", "chinTuck"].slice(0, n).map(station), { rounds: 2 })]);
    expect(check(circuit(3))).toEqual([]);
    expect(check(circuit(6))).toEqual([]);
    expect(codes(check(circuit(2)))).toEqual(["warning:format_mismatch@parts[0].format"]);
    expect(codes(check(circuit(7)))).toEqual(["warning:format_mismatch@parts[0].format"]);
  });

  it("intervals need a run or a timed move (error otherwise)", () => {
    const run: WorkoutItem = { kind: "run", effort: "strides", target: { durationSec: 20 } } as WorkoutItem;
    expect(check(docOf([part("run", "intervals", [run, { kind: "rest", seconds: 40 }], { rounds: 4 })]))).toEqual([]);
    expect(check(docOf([part("conditioning", "intervals", [ex("tempoSquat", { holdSec: 30 }), { kind: "rest", seconds: 30 }], { rounds: 4 })]))).toEqual([]);
    expect(codes(check(docOf([part("conditioning", "intervals", [ex("tempoSquat", { reps: 10 }), dead], { rounds: 4 })])))).toEqual(["error:format_mismatch@parts[0].format"]);
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
    const lenient: ConditionProfile = {
      ...TMJ, id: "testLenient", label: "Lenient", attributes: {}, check: { label: "Lenient", min: 0, max: 10 },
      never: () => false, fitsMode: () => true, fitsFormat: () => true, allowPattern: () => true,
      allowRecord: (rec, _mode, today) => rec.id !== "bridge" || (today.pre ?? 0) <= 4,
      flareSafe: () => true, flare: () => false, recoveryReason: () => null, buildChecks: () => [],
    };
    const lib = LIBRARY.map((e) => ({ ...e, conditions: { ...e.conditions, testLenient: {} } }));
    const run = (r: CheckReading | null) =>
      validateWorkoutDoc(one(ex("bridge", { sets: 2, reps: 10 })), { library: lib, activeProfiles: [lenient], day: dayOf(null, { readings: { testLenient: r } }) });
    expect(codes(run(null))).toEqual([`error:condition_gate@${P0}.libraryId`]);
    expect(run(null)[0]!.message).toBe("Glute bridge needs today's Lenient check answered first.");
    expect(run(reading(3))).toEqual([]);
    expect(codes(run(reading(6)))).toEqual([`error:condition_gate@${P0}.libraryId`]);
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
    // Farmer carry is rated above what recovery allows; lying face down is out of recovery too.
    expect(codes(check(one(ex("farmerCarry", { sets: 2, carryM: 40 }), "recover")))).toEqual([`warning:condition_mode@${P0}.libraryId`]);
    expect(codes(check(one(ex("proneYTW", { sets: 2, reps: 8 }), "recover")))).toEqual([`warning:condition_mode@${P0}.libraryId`]);
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
      expect.objectContaining({ code: "mode_above_day", message: "Build needs a calm jaw (2 or less) — you're at 3.", fix: "maintain" }),
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
    ]);
    // A legacy id in the list still names the move.
    expect(only(check(d, dayOf(CALM), { excluded: ["oldBridge"] }), "excluded_by_athlete")).toHaveLength(1);
  });

  it("a move that needs gear the place lacks is a warning, the fix an alternate that fits the place", () => {
    const d = one(ex("gobletSquat", { sets: 3, reps: 8 }, alt("boxSquat", "tempoSquat")));
    expect(check(d, dayOf(CALM), { equipment: ["mat"] })).toEqual([
      expect.objectContaining({ path: `${P0}.libraryId`, code: "equipment_unavailable", severity: "warning", fix: "tempoSquat" }),
    ]);
    expect(check(d, dayOf(CALM), { equipment: ["mat", "kettlebell"] })).toEqual([]);
    // No place given: nothing to check against.
    expect(check(d)).toEqual([]);
  });
});

// ── The engine and the validator agree ─────────────────────────────────────────────────────────────────────────────

describe("the engine's own builds validate", () => {
  interface EngineCase {
    label: string;
    /** At the reading the engine built with. */
    issues: DocIssue[];
    /** Item paths the engine's own eligibility (`fitsMode` with the day's checks) refuses on an unanswered day. */
    engineRefusesUnanswered: string[];
    /** The same day, unanswered: the items the validator refuses by a pattern or record rule. */
    validatorRefusesUnanswered: string[];
    /** Two days ahead: the items the validator holds pending. */
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
      doc.parts.forEach((p, pi) =>
        p.items.forEach((it, ii) => {
          if (it.kind !== "exercise") return;
          const rec = data.exercises.find((e) => e.id === it.libraryId)!;
          if (!fitsMode(data, rec, plan.mode, { tmj: UNANSWERED })) engineRefusesUnanswered.push(`parts[${pi}].items[${ii}].libraryId`);
        }),
      );
      const pathsOf = (list: DocIssue[], keep: (i: DocIssue) => boolean): string[] => [...new Set(list.filter(keep).map((i) => i.path))];
      out.push({
        label: `${mode} build ${i} (${override.theme ?? "no theme"}, ${today}, pre ${calm.pre}, ${place.id})`,
        issues,
        engineRefusesUnanswered,
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
      // Unanswered, the validator refuses exactly what the engine's eligibility refuses; two days ahead, exactly those wait on the day.
      for (const c of cases) {
        expect(c.validatorRefusesUnanswered, c.label).toEqual(c.engineRefusesUnanswered);
        expect(c.pendingAhead, c.label).toEqual(c.engineRefusesUnanswered);
      }
      // Not vacuous: the builds hold gated moves (jumps on plyometric days; overhead presses in build).
      if (mode !== "recovery") expect(cases.reduce((n, c) => n + c.engineRefusesUnanswered.length, 0)).toBeGreaterThan(10);
    });
  }
});
