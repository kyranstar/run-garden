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

  it("refuses a unit-ambiguous block kind rather than guessing metres", () => {
    // `{kind:"km", value:5}` would prescribe five metres. "time"/"meters" are
    // unit-neutral and map; "km"/"miles" are not and do not.
    expect(() =>
      coachSessionSchema.parse({ category: "easy", title: "5k", durationMinutes: 25, run: { blocks: [{ kind: "km", value: 5 }] } }),
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
