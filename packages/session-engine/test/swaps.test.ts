import { addDays } from "@rg/domain";
import { describe, expect, test } from "vitest";
import {
  Blocks, Builder, Planner, Proposal, Recorder, Rng, Swapping,
  type Block, type BuildInput, type BuildResult, type HistorySession, type Mode, type Plan,
} from "../src/index.js";
import { data, place } from "./builder-fixtures.js";

// Swaps are exact (audit I1, I2, M4): every alternative a plan offers for a slot is what applying that swap
// produces — that move in that slot, playing exactly the offered steps, nothing else changed — both on a fresh
// plan and after an earlier swap, and the player's offline recomputation after a mid-session swap equals the
// server's rebuild.

/** Seeded builds with growing history, as a person would use the app. */
function seeded(seed: string, n: number): BuildInput[] {
  const rng = Rng.create(seed);
  const out: BuildInput[] = [];
  const sessions: HistorySession[] = [];
  let block: Block | null = null;
  for (let d = 0; d < 400 && out.length < n; d++) {
    const today = addDays("2026-06-01", d);
    if (rng() > 0.6) continue;
    const pre = Math.floor(rng() * 4);
    const checks = { tmj: { pre, post: null, feelingOff: false } };
    block = Blocks.ensure(data, block, { today, equipment: place("home").equipment, prefs: {}, weeks: 5, sessions }).block;
    let mode: Mode = Proposal.mode(data, { checks, sessions, today }).mode;
    if (rng() < 0.3) mode = (["recovery", "consistent", "build"] as Mode[])[Math.floor(rng() * 3)]!;
    const theme = Proposal.theme(data, { mode, sessions, today }).theme;
    const minutes = [15, 20, 30, 40, 45][Math.floor(rng() * 5)]!;
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

const slotSteps = (plan: Plan, slotKey: string) => plan.steps.filter(s => s.slotKey === slotKey && s.kind !== "rest");
const others = (plan: Plan, slotKey: string) => plan.items.filter(i => i.slotKey !== slotKey).map(i => `${i.slotKey}=${i.exercise.id}x${i.sets}`);
const baseId = (plan: Plan, slotKey: string) => plan.items.find(i => i.slotKey === slotKey)!.exercise.id;

/** Applying `altId` at `slotKey` on top of `swaps` put exactly that move, with the offered steps, in the slot. */
function expectApplied(before: BuildResult, after: BuildResult, slotKey: string, alt: BuildResult["alternatives"][string][number], label: string) {
  const got = after.items.find(i => i.slotKey === slotKey);
  expect(got?.exercise.id, label).toBe(alt.id);
  expect(slotSteps(after, slotKey), label).toEqual(alt.steps);
  expect(others(after, slotKey), label).toEqual(others(before, slotKey));
  // A swap may take the plan up to the slack past its minutes (plans are filled to within seconds of them).
  expect(after.swapState.slack).toBe(60);
  expect(after.plannedSeconds, label).toBeLessThanOrEqual(after.swapState.budget + after.swapState.slack);
}

const INPUTS = ["alpha", "bravo", "charlie", "delta"].flatMap(seed => seeded(seed, 60));

describe("every offered alternative applies exactly", () => {
  test("a few hundred seeded builds: each slot × each alternative, on the fresh plan and after an earlier swap", () => {
    expect(INPUTS.length).toBe(240);
    let single = 0, double = 0;
    for (const [n, input] of INPUTS.entries()) {
      const prepared = Builder.prepare(data, input);
      const plan = Builder.finish(prepared, {});
      if (n % 30 === 0) expect(Builder.build(data, input)).toEqual(plan);   // the build is this same path
      for (const it of plan.items) {
        for (const alt of plan.alternatives[it.slotKey]!) {
          single++;
          expectApplied(plan, Builder.finish(prepared, { [it.slotKey]: { from: it.exercise.id, to: alt.id } }), it.slotKey, alt, `${input.today} ${it.slotKey}->${alt.id}`);
        }
      }
      // One earlier swap (as Planner.swap records it), then every other slot's alternatives on top of it.
      const first = plan.items.find(i => plan.alternatives[i.slotKey]!.length);
      if (!first) continue;
      const day = Planner.swap(null, input.today, first.slotKey, first.exercise.id, plan.alternatives[first.slotKey]![0]!.id);
      const swapped = Builder.finish(prepared, day.swaps);
      expect(swapped.items.find(i => i.slotKey === first.slotKey)!.exercise.id).toBe(plan.alternatives[first.slotKey]![0]!.id);
      for (const it of swapped.items) {
        for (const alt of swapped.alternatives[it.slotKey]!) {
          double++;
          const next = Planner.swap(day, input.today, it.slotKey, it.exercise.id, alt.id);
          const after = Builder.finish(prepared, next.swaps);
          if (it.slotKey === first.slotKey && alt.id === first.exercise.id) {
            expect(after, "swapping back to the planned move restores the plan").toEqual(plan);
            continue;
          }
          expectApplied(swapped, after, it.slotKey, alt, `${input.today} ${first.slotKey} then ${it.slotKey}->${alt.id}`);
        }
      }
    }
    expect(single).toBeGreaterThan(5000);
    expect(double).toBeGreaterThan(5000);
  }, 120_000);

  test("a plan offers alternatives for nearly every slot", () => {
    let slots = 0, empty = 0;
    for (const input of INPUTS.slice(0, 60)) {
      const plan = Builder.build(data, input);
      for (const it of plan.items) { slots++; if (!plan.alternatives[it.slotKey]!.length) empty++; }
    }
    expect(empty / slots).toBeLessThan(0.05);
  });
});

describe("after a mid-session swap the player recomputes the alternatives offline (audit I1)", () => {
  test("the offline state equals the server's rebuild, and no list offers a move already in the session", () => {
    let checked = 0;
    for (const input of INPUTS.filter((_, n) => n % 4 === 0)) {
      const plan = Builder.build(data, input);
      for (const a of plan.items) {
        const y = plan.alternatives[a.slotKey]![0];
        if (!y) continue;
        // The player, offline, with only the payload.
        const offline = Swapping.apply(plan.swapState, plan.steps, a.slotKey, y);
        // The server, rebuilding with the same swap.
        const server = Builder.build(data, { ...input, swaps: { [a.slotKey]: { from: a.exercise.id, to: y.id } } });
        expect(offline.state).toEqual(server.swapState);
        expect(offline.steps).toEqual(server.steps);
        for (const b of server.items) {
          const offered = Swapping.offered(offline.state, offline.steps, b.slotKey);
          expect(offered).toEqual(server.alternatives[b.slotKey]);
          if (b.slotKey === a.slotKey) {
            expect(offered[0]?.id, "the planned move comes back first, to swap back").toBe(a.exercise.id);
            continue;
          }
          expect(offered.map(o => o.id)).not.toContain(y.id);
          expect(offered.map(o => o.moveKey)).not.toContain(y.moveKey);
          if (plan.swapState.slots[b.slotKey]!.partner === a.slotKey) {
            for (const o of offered) expect(Swapping.pairable(y.pairing, o.pairing)).toBe(true);
          }
        }
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  test("a mid-session rebase onto the offline swap plays the offered steps for the rest of the slot", () => {
    const input = INPUTS.find(i => i.mode === "build" && i.minutes >= 30)!;
    const plan = Builder.build(data, input);
    const slot = plan.items.find(i => i.block === "core" || i.block === "accessory")!;
    const y = plan.alternatives[slot.slotKey]![0]!;
    const live = Recorder.create(data, plan, {
      id: "mid", startedAt: `${input.today}T18:00:00.000Z`, date: input.today, mode: input.mode, theme: null, locationId: input.location.id,
      minutes: input.minutes, block: input.block, checks: input.checks ?? {}, equipment: input.location.equipment, plannedSeconds: plan.plannedSeconds, newMove: plan.newMove,
    });
    const first = plan.steps.findIndex(s => s.slotKey === slot.slotKey && s.kind !== "rest");
    // The swap happens at the start of the slot's second set.
    const i = plan.steps.findIndex((s, k) => k > first && s.slotKey === slot.slotKey && s.kind !== "rest" && s.setIndex !== plan.steps[first]!.setIndex);
    expect(i).toBeGreaterThan(first);
    for (let k = 0; k < i; k++) Recorder.reach(live, k);
    const offline = Swapping.apply(plan.swapState, plan.steps, slot.slotKey, y);
    const next = Recorder.rebase(data, live, { steps: offline.steps, plannedSeconds: Swapping.costOf(offline.steps) }, i, slot.slotKey);
    const doneSets = new Set(plan.steps.slice(0, i).filter(s => s.slotKey === slot.slotKey && s.kind !== "rest").map(s => s.setIndex));
    expect(next.steps.slice(i).filter(s => s.slotKey === slot.slotKey && s.kind !== "rest")).toEqual(y.steps.filter(s => !doneSets.has(s.setIndex)));
  });
});

describe("swap sequences rebuild exactly, including plans that already hold two versions of a move (re-review N1)", () => {
  const moveKeysRepeat = (plan: BuildResult) => {
    const keys = Object.values(plan.swapState.current).map(c => c.moveKey);
    return new Set(keys).size < keys.length;
  };
  const withDuplicates = INPUTS.filter(i => moveKeysRepeat(Builder.build(data, i)));

  /** Swaps chosen from the offered lists (re-swaps and swap-backs included), recorded as Planner.swap records them. */
  function runSequence(input: BuildInput, seed: string, steps: number): void {
    const rng = Rng.create(seed);
    const prepared = Builder.prepare(data, input);
    let built = Builder.finish(prepared, {});
    let offline = { state: built.swapState, steps: built.steps };
    let day = Planner.blankDay(input.today);
    for (let n = 0; n < steps; n++) {
      const slots = built.items.filter(i => Swapping.offered(offline.state, offline.steps, i.slotKey).length);
      if (!slots.length) return;
      const slot = slots[Math.floor(rng() * slots.length)]!;
      const offered = Swapping.offered(offline.state, offline.steps, slot.slotKey);
      const choice = offered[Math.floor(rng() * offered.length)]!;
      day = Planner.swap(day, input.today, slot.slotKey, offline.state.current[slot.slotKey]!.id, choice.id);
      offline = Swapping.apply(offline.state, offline.steps, slot.slotKey, choice);
      built = Builder.finish(prepared, day.swaps);
      const label = `${input.today} step ${n}: ${slot.slotKey}->${choice.id} swaps=${JSON.stringify(day.swaps)}`;
      expect(built.items.map(i => i.exercise.id), label).toEqual(built.items.map(i => offline.state.current[i.slotKey]!.id));
      expect(built.steps, label).toEqual(offline.steps);
      expect(built.swapState.current, label).toEqual(offline.state.current);
    }
  }

  test("the seeded inputs include plans that already hold two versions of a move", () => {
    expect(withDuplicates.length).toBeGreaterThanOrEqual(5);
  });

  test("random sequences of offered swaps on those plans rebuild exactly", () => {
    withDuplicates.forEach((input, n) => { for (let r = 0; r < 12; r++) runSequence(input, `dup-${n}-${r}`, 5); });
  });

  test("random sequences of offered swaps on the other plans rebuild exactly", () => {
    INPUTS.filter((_, n) => n % 6 === 0).forEach((input, n) => { for (let r = 0; r < 3; r++) runSequence(input, `plain-${n}-${r}`, 5); });
  });

  test("two slots can exchange their moves (A→Y, B→A's move, A→B's move)", () => {
    let exchanged = 0;
    for (const input of INPUTS) {
      const prepared = Builder.prepare(data, input);
      const plan = Builder.finish(prepared, {});
      const prep = plan.items.filter(i => i.block === "prep");
      for (let a = 0; a < prep.length && !exchanged; a++) for (let b = 0; b < prep.length && !exchanged; b++) {
        if (a === b) continue;
        const A = prep[a]!, B = prep[b]!;
        const y = plan.alternatives[A.slotKey]![0];
        if (!y) continue;
        let day = Planner.swap(null, input.today, A.slotKey, A.exercise.id, y.id);
        let built = Builder.finish(prepared, day.swaps);
        const xa = built.alternatives[B.slotKey]!.find(c => c.id === A.exercise.id);
        if (!xa) continue;
        day = Planner.swap(day, input.today, B.slotKey, B.exercise.id, xa.id);
        built = Builder.finish(prepared, day.swaps);
        const xb = built.alternatives[A.slotKey]!.find(c => c.id === B.exercise.id);
        if (!xb) continue;
        day = Planner.swap(day, input.today, A.slotKey, y.id, xb.id);
        built = Builder.finish(prepared, day.swaps);
        expect(built.items.find(i => i.slotKey === A.slotKey)!.exercise.id).toBe(B.exercise.id);
        expect(built.items.find(i => i.slotKey === B.slotKey)!.exercise.id).toBe(A.exercise.id);
        exchanged++;
      }
      if (exchanged) break;
    }
    expect(exchanged).toBe(1);
  });
});

describe("how many alternatives a slot offers (re-review: short lists)", () => {
  test("a slot offers 3 whenever 3 valid moves exist, and the distribution is recorded", () => {
    const dist = [0, 0, 0, 0];
    const shortWhileThreeExist: string[] = [];
    for (const input of INPUTS.filter((_, n) => n % 2 === 0)) {
      const plan = Builder.build(data, input);
      for (const it of plan.items) {
        const offered = plan.alternatives[it.slotKey]!.length;
        dist[offered]!++;
        if (offered < 3) {
          const valid = Builder.alternatives(data, input, it.slotKey, 1000).length;
          if (valid > offered) shortWhileThreeExist.push(`${input.today} ${input.minutes}m ${it.slotKey}: ${offered} of ${valid}`);
        }
      }
    }
    console.log(`alternatives per slot (0/1/2/3): ${dist.join("/")}`);
    expect(shortWhileThreeExist).toEqual([]);
  });
});
