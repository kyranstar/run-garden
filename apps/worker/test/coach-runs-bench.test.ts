/**
 * A STEP'S STATE CPU (Stage 3 Task 2, fix round 1, item 15). Every step reads its run's state (JSON.parse of up to
 * STATE_MAX_BYTES), measures it, and writes it back once (one JSON.stringify, one byte count). On the Workers free
 * plan a request has 10 ms of CPU, and the model call's own stream parsing comes on top, so this must stay well under
 * it at a nearly full state (150–200 KB).
 *
 * Timed like session-build-bench.test.ts: a fixed calibration loop before and after, the p50 scaled to the reference
 * machine (`× reference / calibration`); a runner far from the reference, or CI, prints and skips with the reason.
 * Synthetic data only.
 */
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import { Rng } from "@rg/session-engine";
import { newRunState, readRunState, STATE_LAST_CALL_BYTES, STATE_MAX_BYTES, type RunState } from "../src/services/coach-runs.js";

const ON_CI = process.env.CI === "true";
/** The calibration loop's median on the reference machine (session-build-bench.test.ts: Apple silicon, Node 21). */
const REFERENCE_CALIBRATION_MS = 6.2;
const MAX_RUNNER_RATIO = 1.5;
/** Measured ~1 ms scaled p50 at ~190 KB (see the report); the ceiling leaves the model call's parsing the rest. */
const STATE_CPU_CEILING_MS = 3;

function calibrationLoop(): number {
  const rng = Rng.create("calibration");
  const items = Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}`, score: rng(), tags: [i % 7, i % 11] }));
  items.sort((a, b) => b.score - a.score);
  let total = 0;
  for (const it of items) total += it.tags[0]! * it.score + (it.id.length > 4 ? 1 : 0);
  return total + JSON.stringify(items.slice(0, 2000)).length;
}

function times(f: () => unknown, runs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    out.push(performance.now() - t);
  }
  return out;
}

const p50 = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** A run near its cap: a 20 KB system, then turns of three ~7 KB tool results each, as a long design builds up. */
function nearlyFullState(): { state: RunState; text: string } {
  const state = newRunState("main", { kind: "now" });
  state.system = [
    { type: "text", text: "principles ".repeat(1_500) },
    { type: "text", text: "profile summary ".repeat(200), cache_control: { type: "ephemeral" } },
  ];
  state.messages = [{ role: "user", content: [{ type: "text", text: "Scope: one workout, to do now.\n".repeat(40) }] }];
  for (let turn = 0; JSON.stringify(state).length < 185_000; turn++) {
    const ids = [0, 1, 2].map((k) => `toolu_${turn}_${k}`);
    state.messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "s".repeat(300) },
        { type: "text", text: "Checking the week's balance and the library." },
        ...ids.map((id) => ({ type: "tool_use" as const, id, name: "search_library", input: { query: "single-leg", limit: 10 } })),
      ],
    });
    state.messages.push({
      role: "user",
      content: ids.map((id) => ({
        type: "tool_result" as const,
        tool_use_id: id,
        content: JSON.stringify({ data: Array.from({ length: 40 }, (_, i) => ({ id: `move-${i}`, name: `Move ${i}`, why: "fits today" })) }).slice(0, 7_000),
      })),
    });
    state.calls += 1;
  }
  return { state, text: JSON.stringify(state) };
}

/** What a step does with its state: parse the stored text, count it, and write it back once. */
function stepStateWork(text: string): number {
  const state = readRunState(text)!;
  const before = new TextEncoder().encode(text).length;
  const json = JSON.stringify(state);
  return before + new TextEncoder().encode(json).length;
}

let calibration = 0;
let measured: number[] = [];
let size = 0;

beforeAll(() => {
  const { text } = nearlyFullState();
  size = new TextEncoder().encode(text).length;
  const before = p50(times(calibrationLoop, 7));
  times(() => stepStateWork(text), 5); // warm-up
  measured = times(() => stepStateWork(text), 25);
  const after = p50(times(calibrationLoop, 7));
  calibration = (before + after) / 2;
  console.log(
    `coach run state: ${(size / 1000).toFixed(0)} KB; parse + count + stringify p50 ${p50(measured).toFixed(2)} ms raw, ` +
      `${scaled(p50(measured)).toFixed(2)} ms scaled (calibration ${before.toFixed(1)} / ${after.toFixed(1)} ms vs ${REFERENCE_CALIBRATION_MS})`,
  );
});

const scaled = (ms: number) => ms * (REFERENCE_CALIBRATION_MS / (calibration || REFERENCE_CALIBRATION_MS));

describe("a step's state CPU at a nearly full state", () => {
  it("the fixture is the size the bound is about (150–200 KB)", () => {
    expect(size).toBeGreaterThanOrEqual(STATE_LAST_CALL_BYTES);
    expect(size).toBeLessThanOrEqual(STATE_MAX_BYTES);
  });

  it(`parse, count and stringify stay under ${STATE_CPU_CEILING_MS} ms scaled p50 (Workers free: 10 ms a request)`, (ctx) => {
    const ratio = calibration / REFERENCE_CALIBRATION_MS;
    if (ON_CI) ctx.skip("on CI: timings printed, not asserted");
    if (ratio > MAX_RUNNER_RATIO || ratio < 1 / MAX_RUNNER_RATIO) {
      ctx.skip(`runner at ${ratio.toFixed(2)}× the reference machine's speed: a CPU timing here would measure the runner`);
    }
    expect(scaled(p50(measured))).toBeLessThan(STATE_CPU_CEILING_MS);
  });
});
