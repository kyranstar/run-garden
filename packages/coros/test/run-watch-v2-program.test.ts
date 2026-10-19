/**
 * A DESIGNED RUN ON THE v2 WIRE (§8 phase 2, `RUN_WIRE_V2`): a distance as a distance (`targetType 5`, metres × 100) and
 * a part's rounds as one repeat group (an `exerciseType 0` container with `isGroup`, `sets` = its rounds, its children
 * linked by `groupId`) — golden-tested field for field against COROS's own captured run programs
 * (docs/reports/coros-inspect-2026-08-02.json: a "Group" program of 3 × (6 min hard, 3 min easy) between 10-minute
 * warm-up and cool-down; a 3 mi step at 5:47–6:52 /km; a 6 × (½ mi, 90 s) group at 4:49–5:13 /km). Pace bands and roles
 * as on v1 (a recovery bare, whole seconds × 1000). Off — no wire asked, or v1 — is phase 1, byte for byte.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runWatchSteps, type RunWatchSession } from "@rg/domain";
import type { RawCorosExercise } from "@rg/providers";
import { CorosClient } from "../src/client.js";
import { updateWorkoutContent } from "../src/content-executor.js";
import { buildProgramFor, buildRunWatchProgram, createWorkout, type CreateWorkoutSpec } from "../src/create-executor.js";
import { mockCorosServer, nextMonday } from "./mock-coros-server.js";

const THRESHOLD = 289;
const spec = (session: RunWatchSession, wire?: "v1" | "v2", threshold: number | null = THRESHOLD) => ({
  happenDay: "20261102",
  name: "Run — 2026-11-02",
  session,
  ...(threshold !== null ? { thresholdPaceSecPerKm: threshold } : {}),
  ...(wire ? { runWire: wire } : {}),
});
const wire = (e: RawCorosExercise): Record<string, unknown> => e as unknown as Record<string, unknown>;
const pick = (e: RawCorosExercise, keys: string[]) => Object.fromEntries(keys.map((k) => [k, wire(e)[k]]));

/** The capture's "Group" program: 10 min warm-up, 3 × (6 min hard, 3 min easy), 10 min cool-down. */
const GROUPED: RunWatchSession = {
  kind: "run_watch",
  title: "Threshold reps",
  segments: [
    { rounds: 1, steps: [{ role: "warmup", effort: "easy", target: { kind: "time", seconds: 600 } }] },
    {
      rounds: 3,
      steps: [
        { role: "work", effort: "threshold", target: { kind: "time", seconds: 360 } },
        { role: "recovery", effort: "recovery", target: { kind: "time", seconds: 180 } },
      ],
    },
    { rounds: 1, steps: [{ role: "cooldown", effort: "easy", target: { kind: "time", seconds: 600 } }] },
  ],
};

describe("v2's repeat group, as COROS's own captured program carries one", () => {
  it("the container and its children: roles, links, sets, sort numbers, targets and rests field for field", () => {
    const p = buildRunWatchProgram(spec(GROUPED, "v2"));
    const steps = p.exercises!;
    // The capture, in order: Warm up, Group (sets 3), its two children, Cool Down.
    expect(steps.map((e) => [e.exerciseType, e.isGroup, e.sets])).toEqual([[1, false, 1], [0, true, 3], [2, false, 1], [4, false, 1], [3, false, 1]]);
    expect(steps.map((e) => wire(e).sortNo)).toEqual([16777216, 33554432, 33619968, 33685504, 50331648]);
    const container = steps[1]!;
    expect(steps.map((e) => String(e.groupId))).toEqual(["0", "0", String(container.id), String(container.id), "0"]);
    expect(steps.map((e) => [e.targetType, e.targetValue])).toEqual([[2, 600], [2, 540], [2, 360], [2, 180], [2, 600]]);
    expect(steps.map((e) => [wire(e).restType, wire(e).restValue])).toEqual(Array(5).fill([3, 0]));
    expect(pick(container, ["name", "exerciseType", "sportType", "isGroup", "groupId", "originId", "intensityType", "intensityValue", "sets"])).toEqual({
      name: "Group", exerciseType: 0, sportType: 1, isGroup: true, groupId: "0", originId: "0", intensityType: 0, intensityValue: 0, sets: 3,
    });
    // The children: their roles' names, sport and pace — a recovery bare (review-2 M1), as on v1.
    expect(pick(steps[2]!, ["name", "sportType", "intensityType", "intensityValue", "intensityValueExtend", "intensityMultiplier", "intensityDisplayUnit"])).toEqual({
      name: "Run", sportType: 1, intensityType: 3, intensityValue: 289_000, intensityValueExtend: 313_000, intensityMultiplier: 1000, intensityDisplayUnit: 2,
    });
    expect(pick(steps[3]!, ["name", "intensityType", "intensityValue"])).toEqual({ name: "Recover", intensityType: 5, intensityValue: 0 });
    // The program counts its real steps (no container), and every step a round runs: the capture's 4 and 8.
    expect(p).toMatchObject({ sportType: 1, exerciseNum: 4, totalSets: 8 });
  });
});

describe("v2's distance step, as COROS's own captured steps carry one", () => {
  it("3 mi at 5:47–6:52 /km: targetType 5, metres × 100, the capture's display unit, the pace as on v1", () => {
    const threeMiles: RunWatchSession = {
      kind: "run_watch",
      title: "Steady",
      segments: [{ rounds: 1, steps: [{ role: "work", effort: "steady", target: { kind: "distance", meters: 4828.03 }, pace: { fastSecPerKm: 347, slowSecPerKm: 412 } }] }],
    };
    const [step] = buildRunWatchProgram(spec(threeMiles, "v2")).exercises!;
    expect(pick(step!, ["exerciseType", "targetType", "targetValue", "targetDisplayUnit", "intensityType", "intensityValue", "intensityValueExtend", "intensityMultiplier", "intensityDisplayUnit"])).toEqual({
      exerciseType: 2, targetType: 5, targetValue: 482803, targetDisplayUnit: 3, intensityType: 3, intensityValue: 347_000, intensityValueExtend: 412_000, intensityMultiplier: 1000, intensityDisplayUnit: 2,
    });
  });

  it("6 × (½ mi at threshold, 90 s): a group of a distance and a bare recovery; with no threshold, a distance still goes, bare", () => {
    const halves: RunWatchSession = {
      kind: "run_watch",
      title: "Half miles",
      segments: [{ rounds: 6, steps: [{ role: "work", effort: "threshold", target: { kind: "distance", meters: 804.67 } }, { role: "recovery", effort: "recovery", target: { kind: "time", seconds: 90 } }] }],
    };
    const steps = buildRunWatchProgram(spec(halves, "v2")).exercises!;
    expect(steps.map((e) => [e.exerciseType, e.isGroup, e.sets, e.targetType, e.targetValue])).toEqual([
      [0, true, 6, 2, Math.round(0.80467 * 301) + 90],
      [2, false, 1, 5, 80467],
      [4, false, 1, 2, 90],
    ]);
    expect(pick(steps[1]!, ["intensityType", "intensityValue", "intensityValueExtend", "targetDisplayUnit"])).toEqual({ intensityType: 3, intensityValue: 289_000, intensityValueExtend: 313_000, targetDisplayUnit: 3 });
    const bare = buildRunWatchProgram(spec(halves, "v2", null)).exercises!;
    expect(bare.map((e) => [e.targetType, e.targetValue, e.intensityType])).toEqual([[0, 0, 0], [5, 80467, 5], [2, 90, 5]]);
  });
});

describe("v2 writes out what a group can't hold, and the preview is the wire", () => {
  it("a part with a rest between its rounds goes round by round, flat, as v1 writes it", () => {
    const rested: RunWatchSession = { ...GROUPED, segments: [GROUPED.segments[0]!, { ...GROUPED.segments[1]!, restBetweenRoundsSec: 60 }, GROUPED.segments[2]!] };
    const steps = buildRunWatchProgram(spec(rested, "v2")).exercises!;
    expect(steps.every((e) => e.isGroup === false && String(e.groupId) === "0")).toBe(true);
    expect(steps.map((e) => e.targetValue)).toEqual([600, 360, 180, 60, 360, 180, 60, 360, 180, 600]);
  });

  it("each group's children are the card's part, byte for byte: seconds or metres, and bands, from `runWatchSteps` on v2", () => {
    const steps = buildRunWatchProgram(spec(GROUPED, "v2")).exercises!;
    const card = runWatchSteps({ segments: [{ rounds: 1, steps: GROUPED.segments[1]!.steps }] }, THRESHOLD, "v2").steps;
    expect(steps.slice(2, 4).map((e) => [e.targetValue, e.intensityType === 3 ? [Number(e.intensityValue) / 1000, Number(e.intensityValueExtend) / 1000] : null])).toEqual(
      card.map((s) => [s.seconds, s.pace ? [s.pace.fastSecPerKm, s.pace.slowSecPerKm] : null]),
    );
  });
});

describe("off is phase 1, byte for byte", () => {
  it("no wire asked, or v1: the same program, and the dispatch passes the wire", () => {
    expect(buildRunWatchProgram(spec(GROUPED))).toEqual(buildRunWatchProgram(spec(GROUPED, "v1")));
    expect(buildRunWatchProgram(spec(GROUPED)).exercises!.every((e) => e.isGroup === false && e.targetType === 2)).toBe(true);
    expect(buildProgramFor(spec(GROUPED), new Map())).toEqual(buildRunWatchProgram(spec(GROUPED, "v1")));
    expect(buildProgramFor(spec(GROUPED, "v2"), new Map())).toEqual(buildRunWatchProgram(spec(GROUPED, "v2")));
  });
});

describe("the create and the rewrite write the wire they are given", () => {
  it("a v2 create lands its group; its v2 rewrite (an Undo) writes one too, in place", async () => {
    const server = mockCorosServer({ baseMonday: nextMonday() });
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: () => undefined });
    await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
    const today = new Date().toISOString().slice(0, 10);
    const day = new Date(`${today}T00:00:00Z`);
    day.setUTCDate(day.getUTCDate() + 10);
    const happenDay = day.toISOString().slice(0, 10).replaceAll("-", "");
    const made = await createWorkout(client, { ...spec(GROUPED, "v2"), happenDay } as CreateWorkoutSpec, { today, catalog: new Map(), log: () => undefined });
    expect(made.ok, made.error).toBe(true);
    const stored = () => server.programByIdInPlan(made.serverIdInPlan!)!.exercises!;
    expect(stored().map((e) => e.isGroup)).toEqual([false, true, false, false, false]);
    const four: RunWatchSession = { ...GROUPED, segments: [GROUPED.segments[0]!, { ...GROUPED.segments[1]!, rounds: 4 }, GROUPED.segments[2]!] };
    const rewritten = await updateWorkoutContent(
      client,
      { target: { happenDay, name: "Run — 2026-11-02", idInPlan: made.serverIdInPlan!, programId: made.serverProgramId!, planId: made.serverPlanId! }, session: four, thresholdPaceSecPerKm: THRESHOLD, runWire: "v2" },
      { catalog: new Map(), today, log: () => undefined },
    );
    expect(rewritten.ok, rewritten.error).toBe(true);
    expect(stored().map((e) => [e.isGroup, e.sets])).toEqual([[false, 1], [true, 4], [false, 1], [false, 1], [false, 1]]);
  });
});
