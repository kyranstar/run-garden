/**
 * The reading's quote checks within the Workers free plan's CPU (final audit G1): a 3-hour, ~400 KB transcript and the
 * cap's 240 quotes, checked after the paid call. Timed as the other benches are (plan-chunk-bench.test.ts): a calibration
 * loop before and after, times scaled to the reference machine; skipped on a runner too far from it, printed on CI.
 */
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { Rng } from "@rg/session-engine";
import { verifyQuotes, type Extraction } from "@rg/saves";

const ON_CI = process.env.CI === "true";
const REFERENCE_CALIBRATION_MS = 6.2;
const MAX_RUNNER_RATIO = 1.5;
const RUNS = 11;
/**
 * The extreme reading (the cap's quotes over a 3-hour transcript) within the request's 10 ms with room to spare. Folding
 * the transcript once is its floor; a reading cut off after its paid call is checked and matched again, alone, by the
 * stale re-match (saves-relay.ts `matchStale`), never paid for again.
 */
const CEILING_MS = 8;

function calibrationLoop(): number {
  const rng = Rng.create("calibration");
  const items = Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}`, score: rng(), tags: [i % 7, i % 11] }));
  items.sort((a, b) => b.score - a.score);
  let total = 0;
  for (const it of items) total += it.tags[0]! * it.score + (it.id.length > 4 ? 1 : 0);
  return total + JSON.stringify(items.slice(0, 2000)).length;
}
const p50 = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
function calibrate(): number {
  const out: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    calibrationLoop();
    out.push(performance.now() - t);
  }
  return p50(out);
}

const segs: [number, string][] = Array.from({ length: 9_000 }, (_, i) => [i * 1.2, `zorbex step ${i} goes here with word${i} and more`]);
const reading = (): Extraction =>
  ({
    kind: "routine", summary: "s", themes: [], insights: [],
    moves: Array.from({ length: 30 }, (_, m) => ({
      name: `Zorbex ${m}`, evidence: { name: "stated", dose: "stated", steps: "stated" },
      quotes: Array.from({ length: 8 }, (_, q) => {
        const i = (m * 8 + q) * 37;
        return q % 2 ? { field: "steps", text: `step ${i} goes here with word${i}`, from: "transcript" } : { field: "dose", text: `step ${i} goes here`, at: i * 1.2, from: "transcript" };
      }),
    })),
  }) as unknown as Extraction;

describe("quote checks within the Workers free plan's CPU", () => {
  it(`400 KB × 240 quotes: under ${CEILING_MS} ms scaled p50`, (ctx) => {
    const before = calibrate();
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const r = reading();
      const t = performance.now();
      verifyQuotes(r, { caption: "", transcript: segs });
      times.push(performance.now() - t);
    }
    const calibration = (before + calibrate()) / 2;
    const ratio = calibration / REFERENCE_CALIBRATION_MS;
    const scaled = p50(times) * (REFERENCE_CALIBRATION_MS / calibration);
    console.log(`quotes bench: p50 ${p50(times).toFixed(2)} ms raw, ${scaled.toFixed(2)} scaled (runner ${ratio.toFixed(2)}×)`);
    if (ON_CI) ctx.skip("on CI: timings printed, not asserted");
    if (ratio > MAX_RUNNER_RATIO || ratio < 1 / MAX_RUNNER_RATIO) {
      ctx.skip(`runner at ${ratio.toFixed(2)}× the reference machine's speed: a CPU timing here would measure the runner`);
    }
    expect(scaled).toBeLessThan(CEILING_MS);
  }, 120_000);
});
