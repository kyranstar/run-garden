/**
 * A DESIGNED RUN ON THE WIRE (§8 §3, phase 1): `buildRunWatchProgram` writes the `run_watch` session the job carries —
 * the steps `runWatchSteps` resolves from the freshest threshold, the card's own (the preview is the wire) — inside the
 * envelope the app already writes and verifies: a run program (sportType 1) of flat time steps, each its role
 * (`exerciseType` 1/2/3/4) and, when it has one, its pace band in ms/km (multiplier 1000, display unit 2). Byte tests,
 * the dispatch, and the round trip through a COROS that re-encodes what it stores and the real normalizer.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runWatchSteps, type CoachSession, type RunWatchSession } from "@rg/domain";
import { normalizeCorosSchedule, type RawCorosExercise, type RawCorosProgram } from "@rg/providers";
import { CorosClient } from "../src/client.js";
import {
  buildProgramFor,
  buildRunProgram,
  buildRunWatchProgram,
  createWorkout,
  missingPaceTargets,
  storedContentDelta,
  type CreateWorkoutSpec,
} from "../src/create-executor.js";
import { nextMonday } from "./mock-coros-server.js";
import { renormalizingCoros } from "./renormalizing-coros.js";

const THRESHOLD = 289;
const noop = (): void => undefined;

/** 10 min easy / 3 × (8 min tempo + 2 min jog) / 2 km easy. */
const TEMPO: RunWatchSession = {
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
};
/** `threshold` null: none known. */
const spec = (session: RunWatchSession = TEMPO, threshold: number | null = THRESHOLD) => ({
  happenDay: "20261020",
  name: "Tempo blocks — 2026-10-20",
  session,
  ...(threshold !== null ? { thresholdPaceSecPerKm: threshold } : {}),
});
const wire = (e: RawCorosExercise): Record<string, unknown> => e as unknown as Record<string, unknown>;

describe("buildRunWatchProgram — the bytes", () => {
  it("one flat time step per step written out, each its role and its pace band from the threshold", () => {
    const p = buildRunWatchProgram(spec());
    expect(p).toMatchObject({ sportType: 1, subType: 65535, name: "Tempo blocks — 2026-10-20", exerciseNum: 8, fastIntensityTypeName: "pace" });
    expect(p.referExercise).toMatchObject({ intensityType: 3 });
    const steps = p.exercises!.map(wire);
    expect(steps.map((s) => s.exerciseType)).toEqual([1, 2, 4, 2, 4, 2, 4, 3]);
    expect(steps.map((s) => s.name)).toEqual(["Warm up", "Run", "Recover", "Run", "Recover", "Run", "Recover", "Cool down"]);
    expect(steps.map((s) => s.targetType)).toEqual(Array(8).fill(2));
    // Whole seconds; the 2 km cool-down at easy's middle (379 s/km): 758 s.
    expect(steps.map((s) => s.targetValue)).toEqual([600, 480, 120, 480, 120, 480, 120, 758]);
    expect(steps.map((s) => s.isGroup)).toEqual(Array(8).fill(false));
    expect(steps.map((s) => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Tempo at 289: 4:59–5:14/km, in ms/km with the multiplier the watch reads them by.
    expect(steps[1]).toMatchObject({ intensityType: 3, intensityValue: 299_000, intensityValueExtend: 314_000, intensityMultiplier: 1000, intensityDisplayUnit: 2 });
    // A recovery goes bare (review-2 M1).
    expect(steps[2]).toMatchObject({ intensityType: 5, intensityValue: 0 });
    expect(steps[7]).toMatchObject({ intensityType: 3, intensityValue: 349_000, intensityValueExtend: 409_000 });
  });

  it("a recovery step goes bare — no exerciseType 4 step carries a band, as the thread coach's rests never have (review-2 M1)", () => {
    const steps = buildRunWatchProgram(spec()).exercises!.map(wire);
    const recoveries = steps.filter((s) => s.exerciseType === 4);
    expect(recoveries).toHaveLength(3);
    for (const r of recoveries) expect(r).toMatchObject({ intensityType: 5, intensityValue: 0 });
  });

  it("is the card's steps, byte for byte: seconds and bands from `runWatchSteps`", () => {
    const resolved = runWatchSteps(TEMPO, THRESHOLD).steps;
    const steps = buildRunWatchProgram(spec()).exercises!.map(wire);
    expect(steps.map((s) => s.targetValue)).toEqual(resolved.map((s) => s.seconds));
    expect(steps.map((s) => (s.intensityType === 3 ? [Number(s.intensityValue) / 1000, Number(s.intensityValueExtend) / 1000] : null))).toEqual(
      resolved.map((s) => (s.pace ? [s.pace.fastSecPerKm, s.pace.slowSecPerKm] : null)),
    );
  });

  it("writes exactly what the thread coach's verified builder writes for the same run", () => {
    const blocks: CoachSession = {
      category: "quality",
      title: "Threshold",
      durationMinutes: 40,
      run: { blocks: [{ kind: "duration", value: 10, intensity: "easy" }, { kind: "duration", value: 20, intensity: "threshold" }, { kind: "duration", value: 10, intensity: "easy" }] },
    };
    const doc: RunWatchSession = {
      kind: "run_watch",
      title: "Threshold",
      segments: [
        { rounds: 1, steps: [{ role: "warmup", effort: "easy", target: { kind: "time", seconds: 600 } }] },
        { rounds: 1, steps: [{ role: "work", effort: "threshold", target: { kind: "time", seconds: 1200 } }] },
        { rounds: 1, steps: [{ role: "cooldown", effort: "easy", target: { kind: "time", seconds: 600 } }] },
      ],
    };
    const base = { happenDay: "20261020", name: "Threshold — 2026-10-20", thresholdPaceSecPerKm: THRESHOLD };
    expect(buildRunWatchProgram({ ...base, session: doc })).toEqual(buildRunProgram({ ...base, session: blocks }));
  });

  it("a standing rest and an effort with no band carry no pace; a pace asked for is the step's", () => {
    const session: RunWatchSession = {
      kind: "run_watch",
      title: "Strides",
      segments: [
        { rounds: 2, restBetweenRoundsSec: 60, steps: [{ role: "work", effort: "strides", target: { kind: "time", seconds: 20 } }, { role: "recovery", target: { kind: "time", seconds: 40 } }] },
        { rounds: 1, steps: [{ role: "work", effort: "race", target: { kind: "distance", meters: 1000 }, pace: { fastSecPerKm: 280, slowSecPerKm: 290 } }] },
      ],
    };
    const steps = buildRunWatchProgram(spec(session)).exercises!.map(wire);
    expect(steps.map((s) => [s.exerciseType, s.targetValue, s.intensityType])).toEqual([
      [2, 20, 5], [4, 40, 5], [4, 60, 5], [2, 20, 5], [4, 40, 5], [2, 285, 3],
    ]);
    expect(steps[5]).toMatchObject({ intensityValue: 280_000, intensityValueExtend: 290_000 });
  });

  it("a pace the athlete named goes on the wire in whole seconds × 1000 — even from a session that still holds the fraction (review-2 I1)", () => {
    // 8:00–8:20 /mi: 298.258–310.686 s/km. A job queued before the session rounded it still carries the fraction.
    const named: RunWatchSession = {
      kind: "run_watch",
      title: "Marathon pace",
      segments: [{ rounds: 1, steps: [{ role: "work", effort: "steady", target: { kind: "time", seconds: 1200 }, pace: { fastSecPerKm: 480 / 1.609344, slowSecPerKm: 500 / 1.609344 } }] }],
    };
    const [step] = buildRunWatchProgram(spec(named)).exercises!.map(wire);
    expect(step).toMatchObject({ intensityType: 3, intensityValue: 298_000, intensityValueExtend: 311_000, intensityMultiplier: 1000 });
    expect(Number.isInteger(step!.intensityValue) && Number.isInteger(step!.intensityValueExtend)).toBe(true);
  });

  it("with no threshold: time steps go as bare timers, and a distance with no pace is refused before any wire call", () => {
    const timed: RunWatchSession = { ...TEMPO, segments: TEMPO.segments.slice(0, 2) };
    const steps = buildRunWatchProgram(spec(timed, null)).exercises!.map(wire);
    expect(steps.every((s) => s.intensityType === 5 && s.intensityValue === 0)).toBe(true);
    expect(buildRunWatchProgram(spec(timed, null)).referExercise).toMatchObject({ intensityType: 1 });
    expect(() => buildRunWatchProgram(spec(TEMPO, null))).toThrow(/distance.*pace/);
    // And a session that isn't one.
    expect(() => buildRunWatchProgram(spec({ ...TEMPO, segments: [] } as RunWatchSession))).toThrow(/invalid session/);
  });
});

describe("the dispatch and the pace owed", () => {
  it("buildProgramFor sends a run_watch session to its own builder", () => {
    expect(buildProgramFor(spec(), new Map())).toEqual(buildRunWatchProgram(spec()));
  });

  it("missingPaceTargets counts a run_watch session's steps with no band for want of a threshold", () => {
    const timed: RunWatchSession = { ...TEMPO, segments: TEMPO.segments.slice(0, 2) };
    expect(missingPaceTargets(timed, undefined)).toBe(4);
    expect(missingPaceTargets(timed, THRESHOLD)).toBe(0);
  });
});

describe("the round trip: a COROS that re-encodes what it stores, read back by the real normalizer", () => {
  it("every role, every time and every band comes back as the card said it", async () => {
    const server = renormalizingCoros({ baseMonday: nextMonday() });
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
    await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
    const today = new Date().toISOString().slice(0, 10);
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 10);
    const iso = day.toISOString().slice(0, 10);
    const s: CreateWorkoutSpec = { ...spec(), happenDay: iso.replaceAll("-", "") };
    const result = await createWorkout(client, s, { today, catalog: new Map(), log: noop });
    expect(result.ok, result.error).toBe(true);
    expect(server.reencoded).toBe(1);
    const raw = await client.getRawSchedule(iso, iso);
    const workout = normalizeCorosSchedule(raw).workouts.find((w) => w.title === s.name)!;
    expect(workout).toBeDefined();
    const resolved = runWatchSteps(TEMPO, THRESHOLD).steps;
    expect(workout.stages.map((st) => st.kind)).toEqual(["warmup", "work", "recovery", "work", "recovery", "work", "recovery", "cooldown"]);
    expect(workout.stages.map((st) => st.durationSeconds)).toEqual(resolved.map((st) => st.seconds));
    expect(workout.stages.map((st) => (st.targetType === "pace" ? [st.targetLow, st.targetHigh] : null))).toEqual(
      resolved.map((st) => (st.pace ? [st.pace.fastSecPerKm, st.pace.slowSecPerKm] : null)),
    );
  });
});

describe("the create's read-back of a designed run: what COROS changed on save, said (review-2 I2)", () => {
  /** A logged-in client on `server`, and a spec dated ten days out. */
  async function on(server: ReturnType<typeof renormalizingCoros>, session: RunWatchSession | CoachSession = TEMPO) {
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: noop });
    await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
    const today = new Date().toISOString().slice(0, 10);
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 10);
    const s = { ...spec(), session, happenDay: day.toISOString().slice(0, 10).replaceAll("-", "") } as CreateWorkoutSpec;
    return createWorkout(client, s, { today, catalog: new Map(), log: noop });
  }
  /** A COROS that also changes what it stores: `change` rewrites each program written, after the re-encoding. */
  function changing(change: (p: RawCorosProgram) => void) {
    const server = renormalizingCoros({ baseMonday: nextMonday() });
    const inner = server.fetchImpl;
    server.fetchImpl = async function (input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/training/schedule/update" && typeof init?.body === "string") {
        const body = JSON.parse(init.body) as { programs?: RawCorosProgram[] };
        for (const p of body.programs ?? []) change(p);
        return inner(input, { ...init, body: JSON.stringify(body) });
      }
      return inner(input, init);
    } as typeof fetch;
    return server;
  }

  it("COROS's own estimates and re-encoding are not a change: against the renormalizing mock, nothing to say", async () => {
    const server = renormalizingCoros({ baseMonday: nextMonday() });
    const result = await on(server);
    expect(result.ok, result.error).toBe(true);
    expect(server.reencoded).toBe(1);
    expect(result.contentDelta).toBeUndefined();
  });

  it("a recovery stored as work, a band dropped: the create still lands, and says what differs, field by field", async () => {
    const result = await on(
      changing((p) => {
        const steps = (p.exercises ?? []) as Array<RawCorosExercise & Record<string, unknown>>;
        steps[2]!.exerciseType = 2;
        steps[1]!.intensityType = 5;
        steps[1]!.intensityValue = 0;
        delete steps[1]!.intensityValueExtend;
      }),
    );
    expect(result.ok, result.error).toBe(true);
    expect(result.contentDelta).toContain("ex[2].exerciseType 4→2");
    expect(result.contentDelta).toContain("ex[1].intensityType 3→5");
    expect(result.contentDelta).toContain("ex[1].intensityValue 299000→0");
  });

  it("only a designed run is compared on its create: a thread-coach run lands as it always has", async () => {
    const blocks: CoachSession = { category: "easy", title: "Easy", durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] } };
    const result = await on(changing((p) => void ((p.exercises ?? [])[0]!.exerciseType = 3)), blocks);
    expect(result.ok, result.error).toBe(true);
    expect(result.contentDelta).toBeUndefined();
  });
});

describe("storedContentDelta — COROS's own estimates are never a difference (review-2 I2)", () => {
  it("a stored duration, time estimate and distance of the server's own say nothing; a step that differs is named", () => {
    const sent = { ...buildRunWatchProgram(spec()), duration: 3158, estimatedTime: 3158, distance: "957900.00", estimatedDistance: 957900 };
    expect(storedContentDelta(sent, { ...sent, duration: 3175, estimatedTime: 3175, distance: 961234, estimatedDistance: 961234 })).toBeUndefined();
    const moved = structuredClone(sent);
    (moved.exercises![2] as unknown as Record<string, unknown>).targetValue = 150;
    expect(storedContentDelta(sent, moved)).toBe("ex[2].targetValue 120→150");
  });
});
