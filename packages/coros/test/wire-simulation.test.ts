/**
 * WHAT THE WATCH ACTUALLY RECEIVES.
 *
 * Every assertion here is on the PAYLOAD the executor would send, or on what
 * comes back out of the real `normalizeCorosSchedule` after a round trip
 * through the stateful mock — never on the shape of the code that built it.
 * The audit of 2026-08-17 found four prescriptions arriving as something else
 * (a walk as a run, an interval as a warm-up, a hold as one rep, a circuit as
 * straight sets), all of which type-checked and all of which passed the tests
 * that existed.
 *
 * UNITS: schedule programs speak PLAIN SECONDS in `targetValue` and
 * MILLISECONDS PER KM in the pace bounds. The mock's inverted seconds /
 * centiseconds contract belongs to the ACTIVITY endpoints (list = seconds,
 * detail = centiseconds) and has nothing to do with this file.
 */

import { describe, expect, it } from "vitest";
import type { CoachSession } from "@rg/domain";
import { normalizeCorosSchedule, type RawCorosExercise } from "@rg/providers";
import { CorosClient } from "../src/client.js";
import {
  buildRunProgram,
  buildStrengthProgram,
  createWorkout,
  missingPaceTargets,
  runBlockRoles,
  type CreateWorkoutSpec,
} from "../src/create-executor.js";
import { mockCorosServer, nextMonday, type MockCorosServer } from "./mock-coros-server.js";

import { createHash } from "node:crypto";

const noop = (): void => undefined;
const TODAY = new Date().toISOString().slice(0, 10);
/** The athlete's real COROS threshold (prod: 289 s/km since 2026-08-13). */
const THRESHOLD = 289;

/** The two entries the mock's /training/exercise/query?sportType=4 returns. */
const SQUAT_ID = "425898928110747648";
const BENCH_ID = "426109589008859137";
const CATALOG = new Map([
  [SQUAT_ID, "Back Squat"],
  [BENCH_ID, "Bench Press"],
]);

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const corosDay = (iso: string): string => iso.replaceAll("-", "");

async function setup(): Promise<{ server: MockCorosServer; client: CorosClient }> {
  const server = mockCorosServer({ baseMonday: nextMonday() });
  const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
  await client.loginWithHash(
    server.email,
    createHash("md5").update(server.password, "utf8").digest("hex"),
  );
  return { server, client };
}

/** Push `spec` through the mock and read it back through the REAL normalizer. */
async function roundTrip(spec: CreateWorkoutSpec, catalog = CATALOG) {
  const { server, client } = await setup();
  const date = spec.happenDay.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  const result = await createWorkout(client, spec, { today: TODAY, catalog, log: noop });
  expect(result.ok, result.error).toBe(true);
  const raw = await client.getRawSchedule(addDaysIso(date, -1), addDaysIso(date, 1));
  const normalized = normalizeCorosSchedule(raw);
  const workout = normalized.workouts.find((w) => w.title === spec.name);
  expect(workout, "the pushed workout must come back out of the normalizer").toBeDefined();
  const sent = server.programByIdInPlan(result.serverIdInPlan!)!;
  return { result, workout: workout!, sent, server };
}

/** A run block payload as a bag of wire fields. */
const wire = (p: { exercises?: RawCorosExercise[] }, i: number): Record<string, unknown> =>
  p.exercises![i] as unknown as Record<string, unknown>;

// ── 1. A "walk back down" is a walk ─────────────────────────────────────────

describe("run blocks carry all four roles the wire has always had", () => {
  /** 15 easy / 3 × (4 threshold + 2 walk) / 10 easy — the shape COROS's own
   * programs use (warmup T1120, work T3001, recover T1123, cooldown T1122). */
  const intervalsWithRest: CoachSession = {
    category: "quality",
    title: "Threshold 3×4 with walk-backs",
    durationMinutes: 43,
    run: {
      blocks: [
        { kind: "duration", value: 15, intensity: "easy" },
        { kind: "duration", value: 4, intensity: "threshold" },
        { kind: "duration", value: 2, intensity: "rest" },
        { kind: "duration", value: 4, intensity: "threshold" },
        { kind: "duration", value: 2, intensity: "rest" },
        { kind: "duration", value: 10, intensity: "easy" },
      ],
    },
  };

  it("emits exerciseType 1/2/3/4 — not just {1, 2}", () => {
    const program = buildRunProgram({
      happenDay: corosDay(addDaysIso(TODAY, 20)),
      name: "n",
      session: intervalsWithRest,
      thresholdPaceSecPerKm: THRESHOLD,
    });
    const types = program.exercises!.map((e) => e.exerciseType);
    // BEFORE: [1, 2, 2, 2, 2, 2] — every walk was "Run" and the closing easy
    // block was work. AFTER: warmup, work, recovery, work, recovery, cooldown.
    expect(types).toEqual([1, 2, 4, 2, 4, 3]);
    expect(program.exercises!.map((e) => e.name)).toEqual([
      "Warm up",
      "Run",
      "Recover",
      "Run",
      "Recover",
      "Cool down",
    ]);
  });

  it("a walk block gets no pace target and keeps its duration", () => {
    const program = buildRunProgram({
      happenDay: corosDay(addDaysIso(TODAY, 20)),
      name: "n",
      session: intervalsWithRest,
      thresholdPaceSecPerKm: THRESHOLD,
    });
    // The recovery block: 2 minutes, no invented pace band ("walk at 5:49/km"
    // would be a fiction), the wire's own "none".
    expect(wire(program, 2)).toMatchObject({
      exerciseType: 4,
      targetType: 2,
      targetValue: 120,
      intensityType: 5,
      intensityValue: 0,
    });
    // The threshold block still carries the band COROS itself prescribes.
    expect(wire(program, 1)).toMatchObject({
      intensityType: 3,
      intensityValue: 289_000,
      intensityValueExtend: 313_000,
    });
  });

  it("survives the round trip: the normalizer reads every role back", async () => {
    const { workout } = await roundTrip({
      happenDay: corosDay(addDaysIso(TODAY, 20)),
      name: "Threshold 3×4 with walk-backs — round trip",
      session: intervalsWithRest,
      thresholdPaceSecPerKm: THRESHOLD,
    });

    expect(workout.stages.map((s) => s.kind)).toEqual([
      "warmup",
      "work",
      "recovery",
      "work",
      "recovery",
      "cooldown",
    ]);
    // Target type, target value and the pace band all survive.
    const [, work, recovery] = workout.stages;
    expect(work).toMatchObject({
      durationType: "time",
      durationSeconds: 240,
      targetType: "pace",
      targetLow: 289,
      targetHigh: 313,
    });
    expect(recovery).toMatchObject({
      durationType: "time",
      durationSeconds: 120,
      targetType: "none",
    });
  });
});

// ── 2. The first block is not automatically a warm-up ───────────────────────

describe("a block's role comes from what it IS, not where it sits", () => {
  /** The athlete warmed up separately; the session opens on the first rep. */
  const hardFromTheGun: CoachSession = {
    category: "quality",
    title: "VO2 5×3",
    durationMinutes: 27,
    run: {
      blocks: [
        { kind: "duration", value: 3, intensity: "interval" },
        { kind: "duration", value: 2, intensity: "rest" },
        { kind: "duration", value: 3, intensity: "interval" },
      ],
    },
  };

  it("does NOT label an opening VO2 rep 'Warm up'", () => {
    const program = buildRunProgram({
      happenDay: corosDay(addDaysIso(TODAY, 21)),
      name: "n",
      session: hardFromTheGun,
      thresholdPaceSecPerKm: THRESHOLD,
    });
    const first = wire(program, 0);
    // BEFORE (verified live): exerciseType 1, name "Warm up", 3:58–4:13/km —
    // a watch telling the athlete to warm up at interval pace.
    expect(first).toMatchObject({ exerciseType: 2, name: "Run" });
    // The pace band is unchanged: it really is an interval.
    expect(first).toMatchObject({ intensityType: 3, intensityValue: 269_000 });
  });

  it("is internally consistent: one block behaves like the first of many", () => {
    const one = buildRunProgram({
      happenDay: corosDay(addDaysIso(TODAY, 21)),
      name: "n",
      session: {
        category: "easy",
        title: "Easy 40",
        durationMinutes: 40,
        run: { blocks: [{ kind: "duration", value: 40, intensity: "easy" }] },
      },
    });
    // The old rule made this `work` and the same block in a 2-block session
    // `warmup`; both are now decided by the same question.
    expect(one.exercises![0]!.exerciseType).toBe(2);
    expect(runBlockRoles([{ intensity: "easy" }])).toEqual(["work"]);
  });

  it("only calls an easy block a warm-up when there is harder work after it", () => {
    // Easy → threshold: the opener is a warm-up, the closer a cool-down.
    expect(
      runBlockRoles([{ intensity: "easy" }, { intensity: "threshold" }, { intensity: "easy" }]),
    ).toEqual(["warmup", "work", "cooldown"]);
    // Two easy blocks and nothing hard: neither is a warm-up. A session with
    // no hard work has nothing to warm up FOR, and inventing the label is the
    // same guess the position rule was making.
    expect(runBlockRoles([{ intensity: "easy" }, { intensity: "easy" }])).toEqual([
      "work",
      "work",
    ]);
    // An unstated intensity is run by feel — not silently promoted.
    expect(runBlockRoles([{ intensity: undefined }, { intensity: "interval" }])).toEqual([
      "work",
      "work",
    ]);
  });

  it("an explicit upstream role wins over every inference", () => {
    // `coachRunBlockSchema` has no `role` today (zod strips what it does not
    // declare), so this is the seam the field would land in: the moment the
    // coach vocabulary carries one, the derivation stops guessing.
    const withRole = [
      { intensity: "interval" as const, role: "warmup" },
      { intensity: "easy" as const, role: "cool down" },
    ];
    expect(runBlockRoles(withRole)).toEqual(["warmup", "cooldown"]);
  });
});

// ── 3 + 4. Holds, per-side work and circuits ────────────────────────────────

describe("a lift reaches the wire in the coach's own vocabulary", () => {
  /** Wall sits and Copenhagens: holds, per-side work, a slow eccentric. */
  const skiPrep: CoachSession = {
    category: "strength",
    title: "Ski legs",
    durationMinutes: 30,
    lift: {
      exercises: [
        {
          name: "Wall sit",
          originId: SQUAT_ID,
          sets: 3,
          holdSeconds: 45,
          weight: { type: "bodyweight" },
          restSeconds: 30,
        },
        {
          name: "Copenhagen plank",
          originId: BENCH_ID,
          sets: 2,
          holdSeconds: 30,
          perSide: true,
          weight: { type: "bodyweight" },
          restSeconds: 20,
        },
        {
          name: "Tempo squat",
          originId: SQUAT_ID,
          sets: 3,
          reps: 8,
          eccentricSeconds: 4,
          weight: { type: "kg", value: 40 },
          restSeconds: 90,
        },
      ],
    },
  } as CoachSession;

  it("accepts the coach session at all — the studio schema rejected it outright", () => {
    // BEFORE: `studioSessionSchema.safeParse` is .strict() and this session is
    // not a studio session, so the parse failed with "Unrecognized key(s) in
    // object: 'holdSeconds'" and the executor threw before any wire call. The
    // `targetType: 2` hold branch added the day before could never run.
    const program = buildStrengthProgram(
      { happenDay: corosDay(addDaysIso(TODAY, 22)), name: "Ski legs — wk 1", session: skiPrep },
      CATALOG,
    );
    expect(program.sportType).toBe(4);
    expect(program.exercises!.length).toBeGreaterThan(0);
  });

  it("a 45-second hold is a TIME target, not one rep", () => {
    const program = buildStrengthProgram(
      { happenDay: corosDay(addDaysIso(TODAY, 22)), name: "Ski legs — wk 1", session: skiPrep },
      CATALOG,
    );
    // [container(3), wall sit] — the hold rides targetType 2 in seconds.
    expect(wire(program, 0)).toMatchObject({ exerciseType: 0, isGroup: true, sets: 3 });
    expect(wire(program, 1)).toMatchObject({ targetType: 2, targetValue: 45, exerciseType: 2 });
    // BEFORE it could only be `targetType: 3, targetValue: 1` — "3 × 1 rep".
    expect(wire(program, 1).targetType).not.toBe(3);
  });

  it("per-side work is TWO steps, so the watch prescribes both legs", () => {
    const program = buildStrengthProgram(
      { happenDay: corosDay(addDaysIso(TODAY, 22)), name: "Ski legs — wk 1", session: skiPrep },
      CATALOG,
    );
    // container(2) + two 30s children: 2 sets × 30s per side is 4 holds, and a
    // single child would have prescribed exactly half the work.
    const container = wire(program, 2);
    expect(container).toMatchObject({ isGroup: true, sets: 2 });
    expect(wire(program, 3)).toMatchObject({
      targetType: 2,
      targetValue: 30,
      groupId: String(container.id),
      overview: "each side",
    });
    expect(wire(program, 4)).toMatchObject({
      targetType: 2,
      targetValue: 30,
      groupId: String(container.id),
    });
    // Distinct ids and distinct sub-sort slots (§5.3 groupSort + 2^16·(j+1)).
    expect(wire(program, 3).id).not.toBe(wire(program, 4).id);
    expect(Number(wire(program, 4).sortNo) - Number(wire(program, 3).sortNo)).toBe(65_536);
  });

  it("carries the tempo as disclosure, because the wire has no tempo field", () => {
    const program = buildStrengthProgram(
      { happenDay: corosDay(addDaysIso(TODAY, 22)), name: "Ski legs — wk 1", session: skiPrep },
      CATALOG,
    );
    const squat = wire(program, 6);
    expect(squat).toMatchObject({ targetType: 3, targetValue: 8, overview: "4s down" });
    // The load still encodes as kg × 1000 with the "6" display unit.
    expect(squat).toMatchObject({ intensityType: 1, intensityValue: 40_000, intensityDisplayUnit: "6" });
  });

  it("counts real steps and sets with the per-side expansion included", () => {
    const program = buildStrengthProgram(
      { happenDay: corosDay(addDaysIso(TODAY, 22)), name: "Ski legs — wk 1", session: skiPrep },
      CATALOG,
    );
    expect(program.exerciseNum).toBe(4); // wall sit, 2 × Copenhagen, squat
    expect(program.totalSets).toBe(3 + 2 * 2 + 3);
    // Containers are never counted as steps (§5.4).
    expect(program.exercises!.filter((e) => e.isGroup)).toHaveLength(3);
  });

  it("refuses a coach exercise the catalog could not resolve", () => {
    const unresolved: CoachSession = {
      category: "strength",
      title: "Ski legs",
      durationMinutes: 30,
      lift: {
        exercises: [
          { name: "Nordic curl", sets: 3, reps: 6, weight: { type: "bodyweight" }, restSeconds: 60 },
        ],
      },
    } as CoachSession;
    expect(() =>
      buildStrengthProgram(
        { happenDay: corosDay(addDaysIso(TODAY, 22)), name: "n", session: unresolved },
        CATALOG,
      ),
    ).toThrow(/Nordic curl.*no COROS catalog id/s);
  });

  it("a hold survives the round trip as seconds, and a rep count as a rep count", async () => {
    const { workout } = await roundTrip({
      happenDay: corosDay(addDaysIso(TODAY, 22)),
      name: "Ski legs — round trip",
      session: skiPrep,
    });
    expect(workout.sport).toBe("strength");
    const holds = workout.stages.filter((s) => s.durationType === "time" && s.kind === "work");
    expect(holds.map((s) => s.durationSeconds)).toEqual([45, 30, 30]);
    // Rep-based work reads back as a rep step (durationType "none"), not a timer.
    const reps = workout.stages.filter((s) => s.kind === "work" && s.durationType === "none");
    expect(reps).toHaveLength(1);
  });
});

describe("a circuit crosses as a repeat group", () => {
  /** The athlete's literal ask: 12 minutes of wall-sit-and-core fillers. */
  const circuit: CoachSession = {
    category: "strength",
    title: "Isometric circuit",
    durationMinutes: 12,
    lift: {
      rounds: 3,
      exercises: [
        {
          name: "Wall sit",
          originId: SQUAT_ID,
          sets: 1,
          holdSeconds: 45,
          weight: { type: "bodyweight" },
          restSeconds: 15,
        },
        {
          name: "Plank",
          originId: BENCH_ID,
          sets: 1,
          holdSeconds: 45,
          weight: { type: "bodyweight" },
          restSeconds: 15,
        },
        {
          name: "Side plank",
          originId: BENCH_ID,
          sets: 1,
          holdSeconds: 30,
          perSide: true,
          weight: { type: "bodyweight" },
          restSeconds: 15,
        },
      ],
    },
  } as CoachSession;

  it("emits ONE container of sets: rounds with every exercise as its child", () => {
    const program = buildStrengthProgram(
      { happenDay: corosDay(addDaysIso(TODAY, 23)), name: "Isometric circuit — wk 1", session: circuit },
      CATALOG,
    );
    // BEFORE: three separate containers, one per exercise — "3 rounds" was
    // nowhere on the wire and the watch prescribed three unrelated blocks.
    const groups = program.exercises!.filter((e) => e.isGroup);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ exerciseType: 0, isGroup: true, sets: 3, groupId: "0" });

    const children = program.exercises!.filter((e) => !e.isGroup);
    expect(children).toHaveLength(4); // wall sit, plank, side plank × 2 sides
    for (const child of children) expect(String(child.groupId)).toBe(String(groups[0]!.id));
    expect(children.map((c) => c.targetValue)).toEqual([45, 45, 30, 30]);
    expect(children.every((c) => c.targetType === 2)).toBe(true);
    // 3 rounds × 4 steps of work.
    expect(program.totalSets).toBe(12);
    expect(program.exerciseNum).toBe(4);
  });

  it("survives the round trip as repeatCount, the way 370 of the athlete's own stages do", async () => {
    const { workout } = await roundTrip({
      happenDay: corosDay(addDaysIso(TODAY, 23)),
      name: "Isometric circuit — round trip",
      session: circuit,
    });
    const repeats = workout.stages.filter((s) => s.kind === "repeat");
    expect(repeats).toHaveLength(1);
    expect(repeats[0]!.repeatCount).toBe(3);
    // Every hold hangs off that repeat, so the app and the watch agree it is
    // one circuit rather than four straight-set blocks.
    const children = workout.stages.filter((s) => s.parentStageId === repeats[0]!.id);
    expect(children).toHaveLength(4);
    expect(children.map((s) => s.durationSeconds)).toEqual([45, 45, 30, 30]);
  });

  it("straight sets are untouched: one container per exercise", () => {
    const straight = buildStrengthProgram(
      {
        happenDay: corosDay(addDaysIso(TODAY, 23)),
        name: "Straight sets",
        session: {
          ...circuit,
          lift: { exercises: (circuit as { lift: { exercises: unknown[] } }).lift.exercises },
        } as CoachSession,
      },
      CATALOG,
    );
    expect(straight.exercises!.filter((e) => e.isGroup)).toHaveLength(3);
  });
});

// ── 6. Pace debt is reported, never swallowed ───────────────────────────────

describe("a session pushed without a threshold says so", () => {
  const easy: CoachSession = {
    category: "easy",
    title: "Legs-back jog",
    durationMinutes: 30,
    run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] },
  };

  it("counts the blocks that wanted a band and did not get one", () => {
    expect(missingPaceTargets(easy, undefined)).toBe(1);
    expect(missingPaceTargets(easy, THRESHOLD)).toBe(0);
    // An implausible reading is not a band (paceBandFor's own guard).
    expect(missingPaceTargets(easy, 3)).toBe(1);
    // A walk is not owed anything — it has no honest band, ever.
    expect(
      missingPaceTargets(
        { ...easy, run: { blocks: [{ kind: "duration", value: 5, intensity: "rest" }] } },
        undefined,
      ),
    ).toBe(0);
  });

  it("reports the debt on a VERIFIED create — the live failure mode", async () => {
    // Exactly what happened to the three sessions on the watch: pushed fine,
    // every block a bare timer, nothing anywhere recording that fact.
    const bare = await roundTrip({
      happenDay: corosDay(addDaysIso(TODAY, 24)),
      name: "Legs-back jog — no threshold",
      session: easy,
    });
    expect(bare.result.ok).toBe(true);
    expect(bare.result.paceTargetsOwed).toBe(1);
    expect(bare.workout.stages[0]!.targetType).toBe("none");

    const paced = await roundTrip({
      happenDay: corosDay(addDaysIso(TODAY, 24)),
      name: "Legs-back jog — with threshold",
      session: easy,
      thresholdPaceSecPerKm: THRESHOLD,
    });
    expect(paced.result.paceTargetsOwed).toBeUndefined();
    expect(paced.workout.stages[0]).toMatchObject({
      targetType: "pace",
      targetLow: 349,
      targetHigh: 409,
    });
  });
});

// ── THE WHOLE COACH VOCABULARY, pushed and read back ────────────────────────

/**
 * THE CLAIM THIS BLOCK EXISTS TO SETTLE, because a false version of it is
 * quoted in `coach-apply.ts` and has already been copied into new code:
 *
 *   "the coach create executor builds a structured RUN program and nothing
 *    else (coros-write-cloud.ts → buildRunProgram)"
 *
 * That is not true and has not been since lift/mobility joined the vocabulary.
 * `createWorkout` dispatches through `buildProgramFor`: a session with a `run`
 * body builds a run program, a session with a `lift` OR `mobility` body builds a
 * structured strength program. Every case below goes through the REAL
 * `createWorkout` against the stateful mock and comes back out of the REAL
 * `normalizeCorosSchedule` — push, wire, read. Nothing here is app-only for any
 * reason on the executor's side of the boundary.
 */
describe("every shape the coach can write reaches the watch and comes back", () => {
  const lift = (
    exercises: unknown[],
    over: { rounds?: number; mobility?: boolean; category?: string } = {},
  ): CoachSession =>
    ({
      category: over.category ?? (over.mobility ? "yoga" : "strength"),
      title: "Vocabulary",
      durationMinutes: 30,
      ...(over.mobility
        ? { mobility: { exercises, ...(over.rounds ? { rounds: over.rounds } : {}) } }
        : { lift: { exercises, ...(over.rounds ? { rounds: over.rounds } : {}) } }),
    }) as CoachSession;

  const cases: Array<{
    what: string;
    session: CoachSession;
    /** Asserted on the stages the real normalizer produced. */
    expect: (stages: ReturnType<typeof normalizeCorosSchedule>["workouts"][number]["stages"]) => void;
  }> = [
    {
      what: "sets, reps, load and rest",
      session: lift([
        { name: "Back Squat", originId: SQUAT_ID, sets: 3, reps: 10, weight: { type: "kg", value: 60 }, restSeconds: 120 },
      ]),
      expect: (stages) => {
        expect(stages.find((s) => s.kind === "repeat")!.repeatCount).toBe(3);
        expect(stages.find((s) => s.kind === "work")).toMatchObject({
          reps: 10,
          loadKg: 60,
          restSeconds: 120,
          durationType: "none",
        });
      },
    },
    {
      what: "a timed hold, bodyweight",
      session: lift([
        { name: "Wall sit", originId: SQUAT_ID, sets: 3, holdSeconds: 45, weight: { type: "bodyweight" }, restSeconds: 30 },
      ]),
      expect: (stages) => {
        expect(stages.find((s) => s.kind === "work")).toMatchObject({
          durationType: "time",
          durationSeconds: 45,
          loadBodyweight: true,
          restSeconds: 30,
        });
      },
    },
    {
      what: "per-side work, as both sides",
      session: lift([
        { name: "Copenhagen plank", originId: BENCH_ID, sets: 2, holdSeconds: 30, perSide: true, weight: { type: "bodyweight" }, restSeconds: 20 },
      ]),
      expect: (stages) => {
        const work = stages.filter((s) => s.kind === "work");
        expect(work).toHaveLength(2); // one child per side, not half the work
        expect(work.map((s) => s.durationSeconds)).toEqual([30, 30]);
        expect(work[0]!.note).toBe("each side");
      },
    },
    {
      what: "an eccentric tempo, as disclosure",
      session: lift([
        { name: "Tempo squat", originId: SQUAT_ID, sets: 3, reps: 8, eccentricSeconds: 4, weight: { type: "kg", value: 40 }, restSeconds: 90 },
      ]),
      expect: (stages) => {
        // The wire has no tempo field at all, so it rides in the step's prose.
        expect(stages.find((s) => s.kind === "work")).toMatchObject({ reps: 8, loadKg: 40, note: "4s down" });
      },
    },
    {
      what: "sets alone — three ramping sets, stop when it gets heavy",
      session: lift([{ name: "Trap bar deadlift", originId: SQUAT_ID, sets: 3, restSeconds: 120 }]),
      expect: (stages) => {
        expect(stages.find((s) => s.kind === "repeat")!.repeatCount).toBe(3);
        const work = stages.find((s) => s.kind === "work")!;
        expect(work.durationType).toBe("open"); // no invented rep count
        expect(work.reps).toBeUndefined();
        expect(work.restSeconds).toBe(120);
      },
    },
    {
      what: "a circuit of rounds",
      session: lift(
        [
          { name: "Wall sit", originId: SQUAT_ID, sets: 1, holdSeconds: 45, weight: { type: "bodyweight" }, restSeconds: 15 },
          { name: "Plank", originId: BENCH_ID, sets: 1, holdSeconds: 45, weight: { type: "bodyweight" }, restSeconds: 15 },
        ],
        { rounds: 3 },
      ),
      expect: (stages) => {
        const repeats = stages.filter((s) => s.kind === "repeat");
        expect(repeats).toHaveLength(1);
        expect(repeats[0]!.repeatCount).toBe(3);
        expect(stages.filter((s) => s.parentStageId === repeats[0]!.id)).toHaveLength(2);
      },
    },
    {
      what: "a mobility session",
      session: lift(
        [
          { name: "Couch stretch", originId: BENCH_ID, sets: 2, holdSeconds: 60, perSide: true, weight: { type: "bodyweight" }, restSeconds: 0 },
        ],
        { mobility: true },
      ),
      expect: (stages) => {
        const work = stages.filter((s) => s.kind === "work");
        expect(work).toHaveLength(2);
        expect(work.map((s) => s.durationSeconds)).toEqual([60, 60]);
        // restSeconds 0 is "skip rests" on the wire — an absence, not a zero.
        expect(work[0]!.restSeconds).toBeUndefined();
      },
    },
    {
      what: "a mobility circuit with per-side holds",
      session: lift(
        [
          { name: "Side plank", originId: BENCH_ID, sets: 1, holdSeconds: 30, perSide: true, weight: { type: "bodyweight" }, restSeconds: 15 },
        ],
        { mobility: true, rounds: 2 },
      ),
      expect: (stages) => {
        const repeat = stages.find((s) => s.kind === "repeat")!;
        expect(repeat.repeatCount).toBe(2);
        const children = stages.filter((s) => s.parentStageId === repeat.id);
        expect(children).toHaveLength(2);
        expect(children.every((s) => s.durationSeconds === 30)).toBe(true);
      },
    },
    {
      what: "the coach's own cue",
      session: lift([
        { name: "Back Squat", originId: SQUAT_ID, sets: 3, reps: 5, weight: { type: "kg", value: 70 }, restSeconds: 150, note: "pause at the bottom" },
      ]),
      expect: (stages) => {
        expect(stages.find((s) => s.kind === "work")!.note).toBe("pause at the bottom");
      },
    },
  ];

  cases.forEach(({ what, session, expect: assert }, i) => {
    it(`pushes and reads back ${what}`, async () => {
      const { workout, result } = await roundTrip({
        happenDay: corosDay(addDaysIso(TODAY, 30 + i)),
        name: `Vocabulary ${i} — round trip`,
        session,
      });
      // Verified on the wire by the executor itself, not just accepted.
      expect(result.ok).toBe(true);
      // Every one of these files as strength on the watch (the program
      // namespace has no mobility sport); the app keeps the honest discipline.
      expect(workout.sport).toBe("strength");
      assert(workout.stages);
    });
  });

  it("a run session still builds a run program — the dispatch, both ways", async () => {
    const { workout } = await roundTrip({
      happenDay: corosDay(addDaysIso(TODAY, 45)),
      name: "Dispatch — run",
      session: {
        category: "easy",
        title: "Easy 30",
        durationMinutes: 30,
        run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] },
      } as CoachSession,
      thresholdPaceSecPerKm: THRESHOLD,
    });
    expect(workout.sport).toBe("run");
    expect(workout.stages[0]).toMatchObject({ durationType: "time", targetType: "pace" });
  });
});

// ── A sub-minute block is whole seconds on the wire ─────────────────────────

describe("fractional minutes land as whole seconds", () => {
  it("a 15-second stride is targetValue 15, not 14.999999999999998", () => {
    const program = buildRunProgram({
      happenDay: corosDay(addDaysIso(TODAY, 25)),
      name: "n",
      session: {
        category: "quality",
        title: "Easy + strides",
        durationMinutes: 45,
        run: {
          blocks: [
            { kind: "duration", value: 40, intensity: "easy" },
            // 15s and 45s as the domain's quantiser stores them: round(sec)/60.
            { kind: "duration", value: 15 / 60, intensity: "interval" },
            { kind: "duration", value: 45 / 60, intensity: "rest" },
          ],
        },
      } as CoachSession,
      thresholdPaceSecPerKm: THRESHOLD,
    });
    const values = program.exercises!.map((e) => e.targetValue);
    expect(values).toEqual([2400, 15, 45]);
    for (const v of values) expect(Number.isInteger(v)).toBe(true);
  });

  it("every whole second between 1 and 3600 survives the minutes round trip", () => {
    // `seconds / 60` is binary-exact for whole minutes and 5-second steps, but
    // ~4% of whole seconds (125, 245, 485…) come back ~2.3e-13 off. The wire
    // is the one consumer that cannot shrug that off.
    const off: number[] = [];
    // 5s is the schema's own floor for "a piece of work"; 720 min its ceiling.
    for (let sec = 5; sec <= 3600; sec++) {
      const program = buildRunProgram({
        happenDay: corosDay(addDaysIso(TODAY, 25)),
        name: "n",
        session: {
          category: "easy",
          title: "t",
          durationMinutes: 60,
          run: { blocks: [{ kind: "duration", value: sec / 60 }] },
        } as CoachSession,
      });
      if (program.exercises![0]!.targetValue !== sec) off.push(sec);
    }
    expect(off).toEqual([]);
  });

  it("a value carrying a distance unit is refused, not pushed as minutes", () => {
    // Upstream now reads `{kind: "duration", value: "5km"}` as a DISTANCE
    // block. Distance targets are not spike-verified on this wire, so the
    // session stays app-only rather than going to the watch as 5 minutes.
    expect(() =>
      buildRunProgram({
        happenDay: corosDay(addDaysIso(TODAY, 25)),
        name: "Five k",
        session: {
          category: "quality",
          title: "Five k",
          durationMinutes: 25,
          run: { blocks: [{ kind: "distance", value: 5000, intensity: "threshold" }] },
        } as CoachSession,
        thresholdPaceSecPerKm: THRESHOLD,
      }),
    ).toThrow(/distance targets are not spike-verified/);
  });
});
