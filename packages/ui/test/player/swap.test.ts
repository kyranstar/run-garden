/**
 * REVIEW FOCUS 4 — a swap offered offline after an earlier swap applies exactly as offered (Phase 2b Task 5).
 *
 * The player has only what the build stored: each slot's steps and the alternatives it offered (never the engine's
 * whole swap pool, which is ~420 KB a build and not stored). `player/swap.ts` rebuilds the swap state from that and
 * recomputes what ⇄ offers after each swap with the engine's own rules (`Swapping.offered`). These tests play real
 * builds of the real library: swap slot A, then for every other slot B every alternative offered offline is applied
 * and compared with the server's rebuild with the same two swaps — the same move in B, the same steps, everywhere.
 */
import { addDays } from "@rg/domain";
import { EXERCISES, LOCATION_PRESETS, makeEngineData, type ExerciseRecord, type Mode } from "@rg/exercise-library";
import {
  Blocks, Builder, Planner, Proposal, Recorder, Rng, Swapping,
  type Block, type BuildInput, type BuildResult, type EngineLocation, type HistorySession,
} from "@rg/session-engine";
import type { SessionBuildDto, SessionExerciseDto } from "@rg/api-client";
import { describe, expect, it } from "vitest";
import { offeredNow, planAfter } from "../../src/player/swap.js";
import { beginPlayer, playerData, swapSlot } from "../../src/player/run.js";

const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });
const place = (id: string): EngineLocation => {
  const p = LOCATION_PRESETS.find((l) => l.id === id)!;
  return { id: p.id, name: p.name, equipment: p.equipment, implements: {} };
};

/** Seeded build inputs with a growing history, as a person would use the app (as the engine's own swap tests). */
function seeded(seed: string, n: number): BuildInput[] {
  const rng = Rng.create(seed);
  const out: BuildInput[] = [];
  const sessions: HistorySession[] = [];
  let block: Block | null = null;
  for (let d = 0; d < 300 && out.length < n; d++) {
    const today = addDays("2026-06-01", d);
    if (rng() > 0.6) continue;
    const pre = Math.floor(rng() * 4);
    const checks = { tmj: { pre, post: null, feelingOff: false } };
    block = Blocks.ensure(data, block, { today, equipment: place("home").equipment, prefs: {}, weeks: 5, sessions }).block;
    let mode: Mode = Proposal.mode(data, { checks, sessions, today }).mode;
    if (rng() < 0.3) mode = (["recovery", "consistent", "build"] as Mode[])[Math.floor(rng() * 3)]!;
    const theme = Proposal.theme(data, { mode, sessions, today }).theme;
    const minutes = [20, 30, 40, 45][Math.floor(rng() * 4)]!;
    const location = place(["home", "home", "gym", "mat"][Math.floor(rng() * 4)]!);
    const input: BuildInput = { today, mode, theme, minutes, location, unit: "lb", sessions: [...sessions], prefs: {}, savedIds: [], block, checks, swaps: {} };
    out.push(input);
    const plan = Builder.build(data, input);
    const live = Recorder.create(data, plan, {
      id: `${seed}-${d}`, startedAt: `${today}T18:00:00.000Z`, date: today, mode, theme: theme ? theme.id : null, locationId: location.id,
      minutes, block, checks, equipment: location.equipment, plannedSeconds: plan.plannedSeconds, newMove: plan.newMove,
    });
    plan.steps.forEach((_, k) => Recorder.reach(live, k));
    sessions.push(Recorder.toSession(live, { endedAt: `${today}T18:40:00.000Z`, post: { tmj: pre }, completed: true }));
  }
  return out;
}

const slice = (id: string): SessionExerciseDto => {
  const { providers: _p, ...rest } = EXERCISES.find((e) => e.id === id) as ExerciseRecord;
  return rest as SessionExerciseDto;
};

/** What the server stores and sends for a build (services/session-build.ts composeBuild): never the swap state. */
function stored(input: BuildInput, plan: BuildResult, swaps: BuildInput["swaps"] = {}): SessionBuildDto {
  const ids = new Set([...plan.items.map((i) => i.exercise.id), ...Object.values(plan.alternatives).flat().map((a) => a.id)]);
  return {
    buildId: "b1", version: 1, engineVersion: "test", inputsHash: "h", builtAt: `${input.today}T17:00:00.000Z`, date: input.today,
    mode: plan.mode, modeReasons: [], theme: plan.theme?.id ?? null, themeReasons: [], minutes: input.minutes, locationId: input.location.id,
    blockRef: null, weekOfBlock: null, plannedSeconds: plan.plannedSeconds, steps: plan.steps,
    items: plan.items.map((it) => ({
      slotKey: it.slotKey, block: it.block, exerciseId: it.exercise.id, format: it.format, sets: it.sets, group: it.group,
      coreFamily: it.coreFamily, isNew: it.isNew, why: it.why,
    })),
    exercises: Object.fromEntries([...ids].map((id) => [id, slice(id)])),
    alternatives: plan.alternatives,
    targets: {},
    newMove: plan.newMove,
    params: { checks: {}, overrides: {}, swaps: swaps as Record<string, { from?: string | null; to?: string | null }> },
  } as unknown as SessionBuildDto;
}

const INPUTS = ["alpha", "bravo", "charlie"].flatMap((s) => seeded(s, 20));
const slotSteps = (steps: BuildResult["steps"], slotKey: string) => steps.filter((s) => s.kind !== "rest" && s.slotKey === slotKey);

describe("Review Focus 4 — a swap offered offline after an earlier swap", () => {
  it("before any swap, ⇄ offers exactly what the build offered", () => {
    for (const input of INPUTS.slice(0, 10)) {
      const plan = Builder.build(data, input);
      const b = stored(input, plan);
      for (const it of plan.items) expect(offeredNow(b, [], it.slotKey).map((c) => c.id)).toEqual(plan.alternatives[it.slotKey]!.map((c) => c.id));
    }
  });

  it("swap slot A, then every alternative offered offline for every other slot B is exactly the server's rebuild with both swaps", () => {
    let checked = 0;
    let differs = 0;
    for (const input of INPUTS) {
      const prepared = Builder.prepare(data, input);
      const plan = Builder.finish(prepared, {});
      const b = stored(input, plan);
      const a = plan.items.find((i) => plan.alternatives[i.slotKey]!.length > 0);
      if (!a) continue;
      const y = offeredNow(b, [], a.slotKey)[0]!;
      const day1 = Planner.swap(null, input.today, a.slotKey, a.exercise.id, y.id);
      const server1 = Builder.finish(prepared, day1.swaps);
      const after1 = [{ slotKey: a.slotKey, to: y.id }];
      expect(planAfter(b, after1).steps).toEqual(server1.steps);
      for (const it of plan.items) {
        if (it.slotKey === a.slotKey) {
          // The planned move comes back first, to swap back.
          expect(offeredNow(b, after1, a.slotKey)[0]?.id).toBe(a.exercise.id);
          continue;
        }
        const offered = offeredNow(b, after1, it.slotKey);
        // Never a move the session already holds, nor another version of it.
        expect(offered.map((c) => c.id)).not.toContain(y.id);
        expect(offered.map((c) => c.moveKey)).not.toContain(y.moveKey);
        // The server's full swap state agrees each one fits the plan as it now stands (the server may list others
        // first: it holds moves the build never offered).
        for (const z of offered) expect(Swapping.fits(server1.swapState, server1.steps, it.slotKey, z)).toBe(true);
        if (offered.map((c) => c.id).join() !== plan.alternatives[it.slotKey]!.map((c) => c.id).join()) differs++;
        for (const z of offered) {
          const day2 = Planner.swap(day1, input.today, it.slotKey, it.exercise.id, z.id);
          const server2 = Builder.finish(prepared, day2.swaps);
          const offline = planAfter(b, [...after1, { slotKey: it.slotKey, to: z.id }]);
          expect(server2.items.find((i) => i.slotKey === it.slotKey)!.exercise.id).toBe(z.id);
          expect(slotSteps(offline.steps, it.slotKey)).toEqual(z.steps);
          expect(offline.steps).toEqual(server2.steps);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(200);
    // The recomputation matters: after the first swap some slot offers something other than the build's list.
    expect(differs).toBeGreaterThan(0);
  }, 120_000);

  it("a build the day already swapped (the sheet's ⇄ before Start) offers the planned move back, and later swaps still rebuild exactly", () => {
    let checked = 0;
    for (const input of INPUTS) {
      const prepared = Builder.prepare(data, input);
      const plan = Builder.finish(prepared, {});
      const a = plan.items.find((i) => plan.alternatives[i.slotKey]!.length > 0);
      if (!a) continue;
      const day = Planner.swap(null, input.today, a.slotKey, a.exercise.id, plan.alternatives[a.slotKey]![0]!.id);
      const built = Builder.finish(prepared, day.swaps);
      const b = stored(input, built, day.swaps);
      expect(offeredNow(b, [], a.slotKey)[0]?.id).toBe(a.exercise.id);
      for (const it of built.items) {
        if (it.slotKey === a.slotKey) continue;
        for (const z of offeredNow(b, [], it.slotKey)) {
          const server = Builder.finish(prepared, Planner.swap(day, input.today, it.slotKey, it.exercise.id, z.id).swaps);
          expect(planAfter(b, [{ slotKey: it.slotKey, to: z.id }]).steps).toEqual(server.steps);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  }, 120_000);

  it("swapped back to the planned move, the slot plays the plan's own steps again, as the server's rebuild does", () => {
    let checked = 0;
    for (const input of INPUTS) {
      const prepared = Builder.prepare(data, input);
      const plan = Builder.finish(prepared, {});
      const b = stored(input, plan);
      const a = plan.items.find((i) => plan.alternatives[i.slotKey]!.length > 0);
      if (!a) continue;
      const y = offeredNow(b, [], a.slotKey)[0]!;
      const made = [{ slotKey: a.slotKey, to: y.id }];
      const back = offeredNow(b, made, a.slotKey)[0]!;
      expect(back.id).toBe(a.exercise.id);
      const day1 = Planner.swap(null, input.today, a.slotKey, a.exercise.id, y.id);
      const server = Builder.finish(prepared, Planner.swap(day1, input.today, a.slotKey, y.id, back.id).swaps);
      const offline = planAfter(b, [...made, { slotKey: a.slotKey, to: back.id }]);
      expect(slotSteps(offline.steps, a.slotKey)).toEqual(back.steps);
      expect(offline.steps).toEqual(server.steps);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  }, 120_000);

  it("superset partners: after one partner is swapped, the other is offered only moves that pair with it", () => {
    let pairs = 0;
    for (const input of INPUTS) {
      const plan = Builder.build(data, input);
      const b = stored(input, plan);
      for (const it of plan.items.filter((i) => i.format === "superset")) {
        const partner = plan.items.find((o) => o !== it && o.block === it.block && o.format === "superset")!;
        const y = offeredNow(b, [], it.slotKey)[0];
        if (!y) continue;
        for (const z of offeredNow(b, [{ slotKey: it.slotKey, to: y.id }], partner.slotKey)) {
          expect(Swapping.pairable(y.pairing, z.pairing)).toBe(true);
          pairs++;
        }
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });

  it("mid-session, the player plays the second swap's steps exactly as offered for the slot's remaining sets", () => {
    const input = INPUTS.find((i) => {
      const plan = Builder.build(data, i);
      return plan.items.filter((it) => plan.alternatives[it.slotKey]!.length > 0).length >= 2;
    })!;
    const plan = Builder.build(data, input);
    const b = stored(input, plan);
    const view = { location: { id: input.location.id, name: "x", equipment: [...input.location.equipment], implements: {} }, block: null } as never;
    const src = { workoutId: "w", build: b, view, profiles: ["tmj"] };
    const pd = playerData(src);
    const [a, bSlot] = plan.items.filter((it) => plan.alternatives[it.slotKey]!.length > 0);
    let s = beginPlayer(src, pd, { performedId: "p", now: 0 });
    s = swapSlot(s, pd, a!.slotKey, offeredNow(b, s.swaps, a!.slotKey)[0]!, 0);
    const z = offeredNow(b, s.swaps, bSlot!.slotKey)[0]!;
    s = swapSlot(s, pd, bSlot!.slotKey, z, 0);
    expect(slotSteps(s.live.steps, bSlot!.slotKey)).toEqual(z.steps);
    expect(s.live.steps).toEqual(planAfter(b, s.swaps).steps);
  });
});
