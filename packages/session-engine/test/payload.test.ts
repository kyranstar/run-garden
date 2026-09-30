import { describe, expect, test } from "vitest";
import { Builder, Payload, Swapping, type BuildInput, type BuildResult } from "../src/index.js";
import { data, gym, home, makeInput, themeById, themeFor } from "./builder-fixtures.js";

// The stored build payload (re-review: payload size): everything the player and how-to sheet render, without what
// the player can derive, and it decodes to the exact build.

const input = makeInput({ today: "2026-09-29" });
const roundTrip = (b: BuildResult) => Payload.decode(JSON.parse(JSON.stringify(Payload.encode(b))));

/**
 * The payload of a 40-minute build may not grow past this: the largest of the four builds below measured
 * 387,294 bytes (the whole build object is 549–647 KB; before this payload, 399–462 KB went out), + 10%.
 */
const BUDGET_40_MIN_BYTES = 426_000;

describe("the build payload", () => {
  test("decodes to exactly the build, before and after swaps", () => {
    const cases: BuildInput[] = [
      input({ mode: "build", minutes: 40, theme: themeFor("build") }),
      input({ mode: "consistent", minutes: 30, location: gym, theme: themeById("deskUnwind") }),
      input({ mode: "recovery", minutes: 15, theme: themeFor("recovery") }),
    ];
    for (const i of cases) {
      const plan = Builder.build(data, i);
      expect(roundTrip(plan)).toEqual(plan);
      // With two swaps applied, the payload still holds and restores the swapped state and its lists.
      const [a, b] = plan.items.filter(it => plan.alternatives[it.slotKey]!.length);
      let state = { state: plan.swapState, steps: plan.steps };
      const swaps: Record<string, { from: string; to: string }> = {};
      for (const it of [a, b]) {
        if (!it) continue;
        const choice = Swapping.offered(state.state, state.steps, it.slotKey)[0]!;
        swaps[it.slotKey] = { from: it.exercise.id, to: choice.id };
        state = Swapping.apply(state.state, state.steps, it.slotKey, choice);
      }
      const swapped = Builder.build(data, { ...i, swaps });
      expect(roundTrip(swapped)).toEqual(swapped);
    }
  });

  test("a 40-minute build's payload stays within its byte budget", () => {
    const sizes = [home, gym].flatMap(location => (["consistent", "build"] as const).map(mode => {
      const plan = Builder.build(data, input({ mode, minutes: 40, location, theme: themeById("deskUnwind") }));
      return { full: JSON.stringify(plan).length, payload: JSON.stringify(Payload.encode(plan)).length };
    }));
    console.log(`40-minute builds, bytes (whole build → payload): ${sizes.map(s => `${s.full} → ${s.payload}`).join(", ")}`);
    for (const s of sizes) expect(s.payload).toBeLessThanOrEqual(BUDGET_40_MIN_BYTES);
  });
});
