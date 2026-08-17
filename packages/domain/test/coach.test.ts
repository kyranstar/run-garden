/**
 * Coach domain schemas (Plan A Task A2): every op parses in its valid form
 * and rejects its characteristic malformation; wake output honors restraint.
 */
import { describe, expect, it } from "vitest";
import {
  coachOpSchema,
  coachSessionSchema,
  formatExercise,
  sessionExercises,
  sessionSport,
  strippedPaths,
  wakeOutputSchema,
  type CoachOp,
} from "../src/coach.js";

const easyRun = {
  category: "easy",
  title: "Steady 40min Z2",
  durationMinutes: 40,
  run: { blocks: [{ kind: "duration", value: 40, intensity: "easy" }] },
};

const liftSession = {
  category: "strength",
  title: "Pull day",
  durationMinutes: 45,
  lift: {
    exercises: [
      {
        originId: "coros-dl",
        name: "Deadlift",
        sets: 3,
        reps: 5,
        weight: { type: "kg", value: 100 },
        restSeconds: 180,
      },
    ],
  },
};

describe("coachSessionSchema", () => {
  it("accepts run and lift sessions", () => {
    expect(coachSessionSchema.parse(easyRun).run?.blocks).toHaveLength(1);
    expect(coachSessionSchema.parse(liftSession).lift?.exercises[0]!.name).toBe("Deadlift");
  });
  it("rejects a session claiming both disciplines", () => {
    expect(() =>
      coachSessionSchema.parse({ ...easyRun, lift: liftSession.lift }),
    ).toThrow();
  });
});

describe("coachOpSchema", () => {
  it("parses each op kind", () => {
    const ops = [
      { kind: "ease", workoutId: "w1", session: easyRun },
      { kind: "move", workoutId: "w1", toDate: "2026-08-10" },
      { kind: "swap", dayA: "2026-08-10", dayB: "2026-08-11" },
      { kind: "skip", workoutId: "w1", reason: "three short nights" },
      { kind: "add", date: "2026-08-10", session: liftSession },
      {
        kind: "firmUp",
        planId: "cp1",
        weekStart: "2026-09-07",
        sessions: [{ date: "2026-09-08", session: easyRun }],
      },
      {
        kind: "extendPlan",
        planId: "cp1",
        shapeWeeks: [{ weekStart: "2026-10-12", volumeTarget: "35k", keySessions: ["long 16k"] }],
      },
      { kind: "retirePlan", planId: "cp1" },
      { kind: "resolveRaceConflict", keep: "settings" },
      { kind: "resolveRaceConflict", keep: "plan" },
    ];
    for (const op of ops) expect(coachOpSchema.parse(op).kind).toBe(op.kind);
  });
  it("rejects resolveRaceConflict with an invalid keep target", () => {
    expect(() => coachOpSchema.parse({ kind: "resolveRaceConflict", keep: "both" })).toThrow();
  });
  it("rejects unknown kinds and malformed dates", () => {
    expect(() => coachOpSchema.parse({ kind: "delete_everything" })).toThrow();
    expect(() =>
      coachOpSchema.parse({ kind: "move", workoutId: "w1", toDate: "next tuesday" }),
    ).toThrow();
  });

  it("normalizes dossier-decorated ids ([wo:…], plan:, bare brackets)", () => {
    const skip = coachOpSchema.parse({ kind: "skip", workoutId: "[wo:abc123]", reason: "backpacking" });
    expect(skip.kind === "skip" && skip.workoutId).toBe("abc123");
    const move = coachOpSchema.parse({ kind: "move", workoutId: "wo:abc123", toDate: "2026-08-10" });
    expect(move.kind === "move" && move.workoutId).toBe("abc123");
    const retire = coachOpSchema.parse({ kind: "retirePlan", planId: "[cp1]" });
    expect(retire.kind === "retirePlan" && retire.planId).toBe("cp1");
  });

  it("accepts timestamps where dates belong, truncating to the day", () => {
    const move = coachOpSchema.parse({
      kind: "move",
      workoutId: "w1",
      toDate: "2026-08-10T23:59:59Z",
    });
    expect(move.kind === "move" && move.toDate).toBe("2026-08-10");
  });

  it("truncates overlong prose instead of rejecting the wake", () => {
    const skip = coachOpSchema.parse({ kind: "skip", workoutId: "w1", reason: "x".repeat(500) });
    expect(skip.kind === "skip" && skip.reason.length).toBe(200);
  });
});

describe("wakeOutputSchema", () => {
  it("accepts a full wake and the restraint wake", () => {
    const full = wakeOutputSchema.parse({
      briefing: "Rough sleep — easing tomorrow.",
      proposals: [
        {
          title: "Ease tomorrow",
          evidence: "slept 5h avg · HRV −9%",
          rationale: "Three short nights before quality work.",
          expiresAt: "2026-08-07",
          flags: [],
          ops: [{ kind: "ease", workoutId: "w1", session: easyRun }],
        },
      ],
      question: { text: "Finish strong or chase a time?", chips: ["Finish strong", "Sub 1:45"] },
      memoryOps: [{ op: "add", kind: "note", text: "travel Aug 13–16", expiresAt: "2026-08-17" }],
    });
    expect(full.proposals).toHaveLength(1);

    // The live failure shape: a proposal whose expiresAt is an "end of day"
    // timestamp must parse, truncated to the date.
    const timestamped = wakeOutputSchema.parse({
      briefing: null,
      proposals: [
        {
          title: "Skip Saturday's long run",
          evidence: "backpacking Fri–Sun",
          rationale: "Three days under a pack is the weekend's training.",
          expiresAt: "2026-08-08T23:59:59Z",
          flags: [],
          ops: [{ kind: "skip", workoutId: "[wo:up1]", reason: "backpacking weekend" }],
        },
      ],
      question: null,
      memoryOps: [],
    });
    expect(timestamped.proposals[0]!.expiresAt).toBe("2026-08-08");
    const op = timestamped.proposals[0]!.ops[0]!;
    expect(op.kind === "skip" && op.workoutId).toBe("up1");

    const restraint = wakeOutputSchema.parse({
      briefing: null,
      proposals: [],
      question: null,
      memoryOps: [],
    });
    expect(restraint.briefing).toBeNull();
  });
  it("rejects a proposal with zero ops", () => {
    expect(() =>
      wakeOutputSchema.parse({
        briefing: "x",
        proposals: [
          { title: "t", evidence: "e", rationale: "r", expiresAt: "2026-08-07", flags: [], ops: [] },
        ],
        question: null,
        memoryOps: [],
      }),
    ).toThrow();
  });
});

/* ==================================================================== *
 * VOCABULARY TOLERANCE (2026-08-17)
 *
 * One test per clause the survival harness proved was killing legitimate
 * plans, each written as the sentence a coach would say. The harness measured
 * 11.3% survival for plans carrying ONE model-natural variation; every case
 * below was one of those variations, and each one used to take the whole wake
 * — briefing included — down with it.
 *
 * The last describe block is the other half: what still refuses, and what
 * protects each clause that was loosened.
 * ==================================================================== */

/** One `add` op through the real op schema, for brevity below. */
const addOp = (session: unknown, over: Record<string, unknown> = {}): Extract<CoachOp, { kind: "add" }> =>
  coachOpSchema.parse({ kind: "add", date: "2026-08-20", session, ...over }) as Extract<CoachOp, { kind: "add" }>;

describe("the schema accepts vocabulary and normalises it", () => {
  it("strips an unknown key instead of killing the wake, at every depth", () => {
    // 32 of 800 plans died on one unexpected key; 22 of those were a
    // `rationale` the model attached to an op because it had a reason for THAT
    // op and the schema only gives it one per proposal.
    const raw = {
      kind: "add",
      date: "2026-08-20",
      rationale: "this is the piece that protects the knee on the descents",
      session: {
        category: "strength",
        title: "Legs",
        durationMinutes: 40,
        notes: "keep it snappy",
        lift: { exercises: [{ name: "Wall sit", sets: 3, holdSeconds: 45, tempo: "3-1-1" }] },
      },
    };
    const op = coachOpSchema.parse(raw);
    expect(op.kind).toBe("add");
    expect((op as unknown as Record<string, unknown>).rationale).toBeUndefined();
    // …and nothing is lost quietly: every stripped path is reportable.
    expect(strippedPaths(raw, op)).toEqual([
      "rationale",
      "session.notes",
      "session.lift.exercises[0].tempo",
    ]);
  });

  it("maps the words a coach writes onto the words the app files", () => {
    // "mobility" is the word the PRODUCT uses; the enum had "yoga".
    expect(coachSessionSchema.parse({ category: "mobility", title: "Sunday reset", durationMinutes: 20 }).category).toBe("yoga");
    // "tempo" is the most common word in running, in both places it appears.
    expect(coachSessionSchema.parse({ category: "Tempo", title: "Tempo 20", durationMinutes: 45 }).category).toBe("quality");
    const tempo = coachSessionSchema.parse({
      category: "quality",
      title: "Tempo 20",
      durationMinutes: 45,
      run: { blocks: [{ kind: "duration", value: 20, intensity: "tempo" }] },
    });
    expect(tempo.run?.blocks[0]!.intensity).toBe("threshold");
    // Case, punctuation and the unit-neutral kind synonyms all fold too.
    const folded = coachSessionSchema.parse({
      category: "Long Run",
      title: "Sunday",
      durationMinutes: 90,
      run: { blocks: [{ kind: "time", value: 90, intensity: "Z2" }] },
    });
    expect(folded.category).toBe("long");
    expect(folded.run?.blocks[0]).toEqual({ kind: "duration", value: 90, intensity: "easy" });
    // A plan's discipline, and a memory's kind.
    const plan = coachOpSchema.parse({
      kind: "createPlan",
      discipline: "strength",
      name: "Winter base",
      startDate: "2026-09-07",
      endDate: "2026-11-29",
      firmSessions: [{ date: "2026-09-08", session: liftSession }],
      shapeWeeks: [],
    });
    expect(plan.kind === "createPlan" && plan.discipline).toBe("lift");
    const mem = wakeOutputSchema.parse({
      memoryOps: [
        { op: "add", kind: "preference", text: "long runs stay on Saturdays" },
        { op: "add", kind: "whatever-this-is", text: "hates the treadmill" },
      ],
    });
    expect(mem.memoryOps.map((m) => m.op === "add" && m.kind)).toEqual(["rule", "note"]);
  });

  it("drops an intensity word it has no mapping for rather than refusing the run", () => {
    // `intensity` is optional by design — a block with none is run by feel —
    // so an unmappable word costs the word, never the session.
    const s = coachSessionSchema.parse({
      category: "quality",
      title: "Fartlek",
      durationMinutes: 40,
      run: { blocks: [{ kind: "duration", value: 40, intensity: "fartlek surges" }] },
    });
    expect(s.run?.blocks[0]!.intensity).toBeUndefined();
    expect(s.run?.blocks[0]!.value).toBe(40);
  });

  it("takes a rest day at zero minutes, and an ultra long run past six hours", () => {
    const rest = coachSessionSchema.parse({ category: "rest", title: "Full rest", durationMinutes: 0 });
    expect(rest.durationMinutes).toBe(0);
    expect(sessionSport(rest)).toBe("run"); // rest has no discipline; see sessionSport
    expect(coachSessionSchema.parse({ category: "long", title: "Big day", durationMinutes: 380 }).durationMinutes).toBe(380);
  });

  it("holds an honest interval session — 26 blocks, not 12", () => {
    const blocks = [
      { kind: "duration", value: 15, intensity: "easy" },
      ...Array.from({ length: 24 }, (_, i) => ({
        kind: "duration",
        value: i % 2 === 0 ? 2 : 1,
        intensity: i % 2 === 0 ? "interval" : "easy",
      })),
      { kind: "duration", value: 10, intensity: "easy" },
    ];
    const s = coachSessionSchema.parse({ category: "quality", title: "12×400m", durationMinutes: 55, run: { blocks } });
    expect(s.run?.blocks).toHaveLength(26);
  });

  it("holds three weeks of a daily piece in one op", () => {
    const dates = Array.from({ length: 20 }, (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`);
    const op = addOp({ category: "yoga", title: "Daily mobility", durationMinutes: 10 }, { dates });
    expect(op.dates).toHaveLength(20);
  });

  it("agrees with itself about empty and absent", () => {
    // Omitting `lift` always worked; `lift: {exercises: []}` was fatal. Both
    // are "strength Friday, movements on the day".
    const empty = coachSessionSchema.parse({ category: "strength", title: "Legs", durationMinutes: 40, lift: { exercises: [] } });
    const absent = coachSessionSchema.parse({ category: "strength", title: "Legs", durationMinutes: 40 });
    expect(sessionSport(empty)).toBe(sessionSport(absent));
    expect(sessionExercises(empty)).toEqual([]);
    // Same for a run with no blocks, and for `dates: []`.
    expect(coachSessionSchema.parse({ category: "easy", title: "Run", durationMinutes: 40, run: { blocks: [] } }).run?.blocks).toEqual([]);
    expect(addOp(easyRun, { dates: [] }).dates).toEqual([]);
    // …and a fourteen-station circuit fits.
    const circuit = coachSessionSchema.parse({
      category: "strength",
      title: "Full body",
      durationMinutes: 45,
      lift: { rounds: 3, exercises: Array.from({ length: 14 }, (_, i) => ({ name: `Move ${i}`, sets: 1, reps: 10 })) },
    });
    expect(circuit.lift?.exercises).toHaveLength(14);
  });

  it("takes a set count as the whole prescription", () => {
    const s = coachSessionSchema.parse({
      category: "strength",
      title: "Squat wave",
      durationMinutes: 40,
      lift: { exercises: [{ name: "Back squat", sets: 3, note: "ramp to a hard triple" }] },
    });
    expect(formatExercise(sessionExercises(s)[0]!)).toBe("Back squat 3 sets");
    // …and the numbers a real programme uses: twelve sets, a long carry, a
    // twenty-second lowering.
    const big = coachSessionSchema.parse({
      category: "strength",
      title: "EMOM",
      durationMinutes: 30,
      lift: {
        exercises: [
          { name: "Clean", sets: 12, reps: 3 },
          { name: "Farmer's carry", sets: 3, holdSeconds: 1800 },
          { name: "Squat", sets: 3, reps: 5, eccentricSeconds: 20 },
        ],
      },
    });
    expect(big.lift?.exercises.map((e) => e.sets)).toEqual([12, 3, 3]);
  });

  it("truncates display lists and optional fields instead of rejecting them", () => {
    const out = wakeOutputSchema.parse({
      briefing: "b",
      proposals: [
        {
          title: "t",
          // no evidence, no rationale, no expiresAt, no flags
          ops: [
            { kind: "skip", workoutId: "w1" }, // no reason
            {
              kind: "extendPlan",
              planId: "cp1",
              shapeWeeks: [
                { weekStart: "2026-10-12", volumeTarget: "35k", keySessions: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] },
              ],
            },
          ],
          flags: Array.from({ length: 14 }, (_, i) => `flag ${i}`),
        },
      ],
    });
    const p = out.proposals[0]!;
    expect(p.evidence).toBe("");
    expect(p.rationale).toBe("");
    expect(p.expiresAt).toBeUndefined();
    expect(p.flags).toHaveLength(10);
    const extend = p.ops[1]!;
    expect(extend.kind === "extendPlan" && extend.shapeWeeks[0]!.keySessions).toHaveLength(8);
    expect(p.ops[0]!.kind === "skip" && p.ops[0]!.reason).toBeUndefined();
  });

  it("understands a wake that only says what it has to say", () => {
    // A model that writes a briefing and nothing else has said everything it
    // had; typing `"question": null, "memoryOps": []` to be understood was a
    // formality with the whole wake riding on it.
    const out = wakeOutputSchema.parse({ briefing: "Nice week. Nothing to change." });
    expect(out.briefing).toBe("Nice week. Nothing to change.");
    expect(out.proposals).toEqual([]);
    expect(out.question).toBeNull();
    expect(out.memoryOps).toEqual([]);
    expect(out.focus).toBeNull();
    // …and an entirely empty object is a valid restraint wake.
    expect(wakeOutputSchema.parse({}).briefing).toBeNull();
  });
});

/* ===================================================================== *
 * UNITS — the spelling the coach wrote, and the PHYSICAL QUANTITY stored.
 *
 * Every case below is asserted as the quantity a CONSUMER computes, never as
 * "it parsed": a duration block is checked as `value * 60` seconds (what
 * coach-apply writes into `durationSeconds` and create-executor puts on the
 * wire as whole-second `targetValue`), a distance block as metres, a weight as
 * kilos. That distinction is the point of this whole file — on 2026-08-17
 * every one of the wrong values in the table below PARSED, and the schema
 * tests passed by construction because they only ever asserted that.
 * ===================================================================== */

/** One run block, as the seconds or metres a consumer would store. The
 * session is given a deliberately long `durationMinutes` so these cases are
 * about the block's unit and never about the block-overrun refinement. */
function blockQuantity(raw: unknown): { seconds: number } | { meters: number } {
  const s = coachSessionSchema.parse({
    category: "quality",
    title: "t",
    durationMinutes: 600,
    run: { blocks: [raw] },
  });
  const b = s.run!.blocks[0]!;
  return b.kind === "duration" ? { seconds: b.value * 60 } : { meters: b.value };
}

const exercise = (over: Record<string, unknown>) =>
  sessionExercises(
    coachSessionSchema.parse({
      category: "strength",
      title: "t",
      durationMinutes: 40,
      lift: { exercises: [{ name: "Back squat", sets: 3, ...over }] },
    }),
  )[0]!;

describe("units: honour it or refuse it, never ignore it", () => {
  it("reads a duration block as the seconds the wire will carry", () => {
    const cases: Array<[unknown, number]> = [
      // The documented dialect: a bare number is MINUTES, unchanged.
      [{ kind: "duration", value: 40 }, 2400],
      [{ kind: "duration", value: "40" }, 2400],
      [{ kind: "time", value: 30 }, 1800],
      // Sub-minute work, which used to be unexpressible: 0.25 killed the wake
      // and 0.5 was rounded up to a whole minute.
      [{ kind: "duration", value: 0.25 }, 15],
      [{ kind: "duration", value: 0.5 }, 30],
      [{ kind: "duration", value: 0.75 }, 45],
      [{ kind: "duration", value: "45s" }, 45],
      [{ kind: "duration", value: "45 sec" }, 45],
      [{ kind: "duration", value: "30 seconds" }, 30],
      [{ kind: "duration", value: "90s" }, 90],
      // …and the unit-bearing kinds, which say the same thing in the other slot.
      [{ kind: "seconds", value: 45 }, 45],
      [{ kind: "minutes", value: 45 }, 2700],
      [{ kind: "hours", value: 1 }, 3600],
      // Bigger units, converted rather than truncated.
      [{ kind: "duration", value: "2 min" }, 120],
      [{ kind: "duration", value: "1.5" }, 90],
      [{ kind: "duration", value: "1h" }, 3600],
      [{ kind: "duration", value: "1h30m" }, 5400],
      [{ kind: "duration", value: "2 min 30 s" }, 150],
    ];
    for (const [raw, seconds] of cases) {
      expect(blockQuantity(raw), JSON.stringify(raw)).toEqual({ seconds });
    }
  });

  it("reads a distance block as metres", () => {
    const cases: Array<[unknown, number]> = [
      [{ kind: "distance", value: 400 }, 400],
      [{ kind: "distance", value: "400" }, 400],
      [{ kind: "distance", value: "400m" }, 400],
      // THE HEADLINE BUG: "1km" stored 1 metre and rendered "0.0km".
      [{ kind: "distance", value: "1km" }, 1000],
      [{ kind: "distance", value: "1 km" }, 1000],
      [{ kind: "distance", value: "1.5km" }, 1500],
      [{ kind: "distance", value: "1,500m" }, 1500],
      [{ kind: "km", value: 5 }, 5000],
      [{ kind: "distance", value: "1 mile" }, 1609],
      [{ kind: "miles", value: 1 }, 1609],
    ];
    for (const [raw, meters] of cases) {
      expect(blockQuantity(raw), JSON.stringify(raw)).toEqual({ meters });
    }
  });

  it("lets the unit overrule the kind, because the unit is the thing stated", () => {
    // A coach who writes kilometres means a distance whatever the kind says,
    // and one who writes minutes means a duration. Both readings used to be a
    // magnitude error: "5km" in a duration block was five minutes.
    expect(blockQuantity({ kind: "duration", value: "5km" })).toEqual({ meters: 5000 });
    expect(blockQuantity({ kind: "distance", value: "30 min" })).toEqual({ seconds: 1800 });
    // "m" is minutes in a time field and metres in a distance one: the kind
    // supplies the namespace, so neither reading is a guess.
    expect(blockQuantity({ kind: "duration", value: "45m" })).toEqual({ seconds: 2700 });
    expect(blockQuantity({ kind: "distance", value: "45m" })).toEqual({ meters: 45 });
  });

  it("reads a session's own length in whole minutes", () => {
    const minutes = (v: unknown): number =>
      coachSessionSchema.parse({ category: "easy", title: "t", durationMinutes: v }).durationMinutes;
    expect(minutes(40)).toBe(40);
    expect(minutes("40")).toBe(40);
    expect(minutes("40 min")).toBe(40);
    expect(minutes("40 minutes")).toBe(40);
    // Stored 2 before this change, while the same row's summary said "90 min".
    expect(minutes("1.5 hours")).toBe(90);
    expect(minutes("1.5h")).toBe(90);
    expect(minutes("1h30m")).toBe(90);
    expect(minutes("2h")).toBe(120);
    expect(minutes(0)).toBe(0);
  });

  it("reads every seconds field as seconds", () => {
    const cases: Array<[unknown, number]> = [
      [45, 45],
      ["45", 45],
      ["45s", 45],
      ["45 sec", 45],
      ["1 min", 60],
      ["2 min", 120],
      ["1:00", 60],
      ["1:30", 90],
      ["0:45", 45],
    ];
    for (const [raw, seconds] of cases) {
      expect(exercise({ holdSeconds: raw }).holdSeconds, `holdSeconds ${JSON.stringify(raw)}`).toBe(seconds);
      expect(exercise({ restSeconds: raw }).restSeconds, `restSeconds ${JSON.stringify(raw)}`).toBe(seconds);
    }
    // …including the two that used to store a two-second rest between sets.
    expect(exercise({ restSeconds: "2 min" }).restSeconds).toBe(120);
    expect(exercise({ restSeconds: "1:00" }).restSeconds).toBe(60);
    // A range keeps its low end, and its unit.
    expect(exercise({ restSeconds: "60-90" }).restSeconds).toBe(60);
    expect(exercise({ restSeconds: "90-120s" }).restSeconds).toBe(90);
    // Absent and null still mean the default.
    expect(exercise({}).restSeconds).toBe(60);
    expect(exercise({ restSeconds: null }).restSeconds).toBe(60);
    // The eccentric, in the two spellings a coach uses for "4s down".
    expect(exercise({ reps: 5, eccentricSeconds: 4 }).eccentricSeconds).toBe(4);
    expect(exercise({ reps: 5, eccentricSeconds: "4s" }).eccentricSeconds).toBe(4);
    expect(exercise({ reps: 5, eccentricSeconds: "0.5 min" }).eccentricSeconds).toBe(30);
  });

  it("reads a load as kilos, and a multiplier as the load rather than the count", () => {
    const kg = (raw: unknown): unknown => exercise({ reps: 5, weight: raw }).weight;
    expect(kg(20)).toEqual({ type: "kg", value: 20 });
    expect(kg("20")).toEqual({ type: "kg", value: 20 });
    expect(kg("20kg")).toEqual({ type: "kg", value: 20 });
    expect(kg("24 kilos")).toEqual({ type: "kg", value: 24 });
    expect(kg("45 lbs")).toEqual({ type: "kg", value: 20.4 });
    expect(kg("30 pounds")).toEqual({ type: "kg", value: 13.6 });
    // Two twenty-kilo dumbbells. Stored 2 kg before this change.
    expect(kg("2×20kg")).toEqual({ type: "kg", value: 20 });
    expect(kg("2 x 20 kg")).toEqual({ type: "kg", value: 20 });
    expect(kg("20kg x 2")).toEqual({ type: "kg", value: 20 });
    expect(kg("20-24kg")).toEqual({ type: "kg", value: 20 });
    // Prose with no number in it is bodyweight, and belongs in `note` — never
    // worth a wake, and the one case where dropping the words is right.
    expect(kg("heavy")).toEqual({ type: "bodyweight" });
    expect(kg(null)).toEqual({ type: "bodyweight" });
    expect(kg(undefined)).toEqual({ type: "bodyweight" });
    expect(kg({ type: "bodyweight" })).toEqual({ type: "bodyweight" });
    expect(kg({ type: "kg", value: 100 })).toEqual({ type: "kg", value: 100 });
  });

  it("refuses a unit it cannot read instead of keeping the number", () => {
    // Each of these stored a plausible-looking wrong number before today. A
    // refusal costs one repair round-trip; the number costs the athlete's week.
    const refused: Array<[string, () => unknown]> = [
      // "%" is not a mass. 70 kg is not what "70% of 1RM" means.
      ["weight 70%", () => exercise({ reps: 5, weight: "70%" })],
      ["weight in reps", () => exercise({ reps: 5, weight: "2 reps" })],
      ["restSeconds in reps", () => exercise({ reps: 5, restSeconds: "8 reps" })],
      ["holdSeconds in kilos", () => exercise({ holdSeconds: "20kg" })],
      // A clock in a MINUTES field: 1h30 to one reader, 90 seconds to another.
      ["durationMinutes 1:30", () => coachSessionSchema.parse({ category: "easy", title: "t", durationMinutes: "1:30" })],
      ["block value 0:45", () => blockQuantity({ kind: "duration", value: "0:45" })],
      // A rep scheme is not one block — collapsing it would drop eleven reps.
      ["block value 12x400m", () => blockQuantity({ kind: "duration", value: "12x400m" })],
      // Two numbers with no structure between them.
      ["block value 1h30", () => blockQuantity({ kind: "duration", value: "1h30" })],
      ["block kind laps", () => blockQuantity({ kind: "laps", value: 4 })],
      ["block value in reps", () => blockQuantity({ kind: "duration", value: "8 reps" })],
    ];
    for (const [name, run] of refused) expect(run, name).toThrow();
  });

  it("refuses a magnitude that is not a prescription in any context", () => {
    // A one-metre rep is a dropped "k", not a judgement the athlete can weigh
    // — which is why this is a schema bound and not an advisory guardrail.
    expect(() => blockQuantity({ kind: "distance", value: 1 })).toThrow();
    expect(() => blockQuantity({ kind: "distance", value: "1m" })).toThrow();
    expect(() => blockQuantity({ kind: "duration", value: 0.05 })).toThrow(); // 3 seconds
    expect(() => blockQuantity({ kind: "duration", value: 800 })).toThrow(); // 13 hours
    expect(() => blockQuantity({ kind: "distance", value: 200_000 })).toThrow();
    // …and the neighbours that ARE prescriptions still pass.
    expect(blockQuantity({ kind: "distance", value: 10 })).toEqual({ meters: 10 });
    expect(blockQuantity({ kind: "duration", value: "5s" })).toEqual({ seconds: 5 });
    expect(blockQuantity({ kind: "duration", value: 380 })).toEqual({ seconds: 22_800 });
  });

  it("refuses a block list that describes a different session from the one it is in", () => {
    // The mis-scale a unit-aware parse still cannot see: eight reps of
    // `value: 45` meaning 45 SECONDS are six hours inside a 50-minute session.
    // The session states its length twice, so the schema can check it.
    const intervals = (value: number, durationMinutes: number) =>
      coachSessionSchema.parse({
        category: "quality",
        title: "8×45s hill sprints",
        durationMinutes,
        run: {
          blocks: [
            { kind: "duration", value: 15, intensity: "easy" },
            ...Array.from({ length: 8 }, () => ({ kind: "duration", value, intensity: "interval" })),
            { kind: "duration", value: 10, intensity: "easy" },
          ],
        },
      });
    expect(() => intervals(45, 50)).toThrow(/wrong unit/);
    // The same session written honestly, in either spelling.
    expect(intervals(0.75, 50).run?.blocks[1]!.value).toBe(0.75);
    // …and a block list merely longer than the session's stated length is
    // ordinary, not a unit error: a 12×400m list on a session whose duration
    // was never updated is 3× and still lands.
    expect(intervals(2, 20).run?.blocks).toHaveLength(10);
  });

  it("stores a number every consumer can multiply by 60", () => {
    // The invariant the whole sub-minute design rests on: `value * 60` is the
    // seconds, for every consumer that computes it (coach-apply's
    // durationSeconds, create-executor's whole-second targetValue,
    // describeOps' formatStageDuration).
    //
    // EXACT for whole minutes — the overwhelming majority of blocks, and
    // untouched by this change — and for every five-second step under a
    // minute, which is every sub-minute stage in the athlete's real library
    // (15s ×10, 30s ×10, 45s ×12).
    const seconds = (v: unknown): number => (blockQuantity({ kind: "duration", value: v }) as { seconds: number }).seconds;
    for (let s = 5; s < 60; s += 5) expect(seconds(`${s}s`), `${s}s`).toBe(s);
    for (let m = 1; m <= 720; m++) expect(seconds(m), `${m} min`).toBe(m * 60);
    // …and for every OTHER whole second, `value * 60` is that second to within
    // a rounding: 125/60 has no exact double, so 125s comes back as
    // 125.00000000000001. The worst case across the whole range is 2.3e-13 of
    // a second, which every consumer rounds or formats away. Making it exact
    // end to end is one `Math.round` in each of the two `* 60` call sites.
    for (let s = 5; s <= 3600; s++) {
      const got = seconds(`${s}s`);
      expect(Math.round(got), `${s}s rounds`).toBe(s);
      expect(Math.abs(got - s), `${s}s dust`).toBeLessThan(1e-9);
    }
    // …and re-parsing what the schema produced changes nothing, because
    // create-executor and the write-job payload both parse the session again.
    const once = coachSessionSchema.parse({
      category: "quality",
      title: "Strides",
      durationMinutes: "40 min",
      run: { blocks: [{ kind: "duration", value: "15s" }, { kind: "distance", value: "1km" }] },
    });
    expect(coachSessionSchema.parse(once)).toEqual(once);
    expect(once.run?.blocks.map((b) => b.value)).toEqual([0.25, 1000]);
  });
});

describe("what the schema still refuses, and what guards what it let go", () => {
  it("refuses a session that is two sessions", () => {
    // Unexecutable, not unusual: one row has one sport and one stage list, and
    // picking a body by precedence would silently throw half of it away.
    expect(() => coachSessionSchema.parse({ ...easyRun, lift: liftSession.lift })).toThrow();
  });

  it("refuses a category it cannot file honestly", () => {
    // The app has three disciplines and none of them is cycling. Filing a bike
    // ride as an easy RUN is the corruption the mobility body was added to
    // stop, so there is deliberately no synonym for it.
    expect(() => coachSessionSchema.parse({ category: "bike", title: "Spin", durationMinutes: 60 })).toThrow();
    expect(() => coachSessionSchema.parse({ category: "swim", title: "Masters", durationMinutes: 60 })).toThrow();
  });

  it("reads a unit-bearing block kind as its unit instead of refusing it", () => {
    // This test used to assert the opposite, and the comment explaining why
    // was the whole bug in one sentence: `{kind:"km", value:5}` was refused
    // because it "would silently prescribe five metres". That was true of a
    // schema that threw the unit away. Now the unit is read, so five
    // kilometres is five thousand metres and there is nothing to refuse.
    const s = coachSessionSchema.parse({
      category: "easy",
      title: "5k",
      durationMinutes: 25,
      run: { blocks: [{ kind: "km", value: 5 }] },
    });
    expect(s.run?.blocks[0]).toEqual({ kind: "distance", value: 5000, intensity: undefined });
    // A kind that names no unit at all still is refused — "laps" has no length
    // until someone says how big the track is.
    expect(() =>
      coachSessionSchema.parse({ category: "easy", title: "Track", durationMinutes: 25, run: { blocks: [{ kind: "laps", value: 12 }] } }),
    ).toThrow();
  });

  it("keeps the binary that moves the athlete's race day strict", () => {
    expect(() => coachOpSchema.parse({ kind: "resolveRaceConflict", keep: "athlete" })).toThrow();
  });

  it("never truncates ops, and still needs at least one", () => {
    // Dropping the tail of a plan would apply half an intention — the one
    // thing worse than refusing it.
    const many = Array.from({ length: 21 }, () => ({ kind: "add", date: "2026-08-20", session: easyRun }));
    expect(() =>
      wakeOutputSchema.parse({ proposals: [{ title: "t", ops: many }] }),
    ).toThrow();
    expect(() => wakeOutputSchema.parse({ proposals: [{ title: "t", ops: [] }] })).toThrow();
  });

  it("still refuses a runaway: the per-op ceiling is generous, not absent", () => {
    // 60 dates is two months of daily work and parses; 61 does not. The number
    // that actually matters — the WHOLE proposal's session count — is enforced
    // by `runaway_size` in coach-guardrails.ts, where refusing costs one
    // proposal instead of the entire wake (see coach-guardrails.test.ts).
    const dates = (n: number, from = 1) =>
      Array.from({ length: n }, (_, i) => `2026-${String(Math.floor((from + i) / 28) + 1).padStart(2, "0")}-${String(((from + i) % 28) + 1).padStart(2, "0")}`);
    expect(addOp(easyRun, { dates: dates(60) }).dates).toHaveLength(60);
    expect(() => addOp(easyRun, { dates: dates(61) })).toThrow();
    // And a firmUp still cannot be empty: its sessions ARE its content, so an
    // empty one is an op that applies cleanly and changes nothing.
    expect(() => coachOpSchema.parse({ kind: "firmUp", planId: "cp1", weekStart: "2026-09-07", sessions: [] })).toThrow();
    expect(() => coachOpSchema.parse({ kind: "extendPlan", planId: "cp1", shapeWeeks: [] })).toThrow();
  });
});

describe("dates as a model writes them", () => {
  it("pads a year-first date and refuses an ambiguous one", () => {
    // Unambiguous: year first, so there is only one reading.
    expect(coachOpSchema.parse({ kind: "move", workoutId: "w1", toDate: "2026-8-5" })).toMatchObject({ toDate: "2026-08-05" });
    expect(coachOpSchema.parse({ kind: "move", workoutId: "w1", toDate: "2026/08/05" })).toMatchObject({ toDate: "2026-08-05" });
    expect(coachOpSchema.parse({ kind: "move", workoutId: "w1", toDate: "2026-08-05 23:59" })).toMatchObject({ toDate: "2026-08-05" });
    // Ambiguous by nationality — guessing would move the session by months.
    expect(() => coachOpSchema.parse({ kind: "move", workoutId: "w1", toDate: "05/08/2026" })).toThrow();
    expect(() => coachOpSchema.parse({ kind: "move", workoutId: "w1", toDate: "next tuesday" })).toThrow();
  });
});
