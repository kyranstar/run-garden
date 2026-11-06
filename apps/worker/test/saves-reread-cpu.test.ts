/**
 * Read it again's CPU at its worst case (phase 5a): an old post's 12 links (the cap readings had before extract-6) lined
 * up with a 30-move re-read by close names only (every row scores every move), with corrections to re-apply — and 30
 * links, which no old post has. The relay's request holds it beside the call's own work. Timed as the other benches are
 * (quotes-bench.test.ts): a calibration loop before and after, times scaled to the reference machine; skipped on a runner
 * too far from it, printed on CI.
 */
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { PROFILES } from "@rg/exercise-library";
import { Rng } from "@rg/session-engine";
import { extractionSchema } from "@rg/saves";
import { alignReading, type KeptRow } from "../src/services/saves-reread.js";

const ON_CI = process.env.CI === "true";
const REFERENCE_CALIBRATION_MS = 6.2;
const MAX_RUNNER_RATIO = 1.5;
const RUNS = 21;
/**
 * REBASED 2026-11-06 (phase 5 backfill): measured 0.63-0.70 ms scaled p50 (0.8-1.1 ms raw; the schema parse ~0.45); 3 ms
 * scaled p50 leaves room inside the request's 10 ms beside the reading's own parse, quote checks and matching.
 */
const CEILING_MS = 3;

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

const conditions = Object.fromEntries(
  Object.values(PROFILES).map((p) => [p.id, { attrs: Object.fromEntries(Object.entries(p.attributes).map(([k, s]) => [k, s.kind === "scale" ? s.min : false])), note: "ok" }]),
);
const move = (name: string) => ({
  name, aliases: ["Zorbex alias one", "Zorbex alias two"], summary: "s", steps: ["a"], cues: [], mistakes: [], purpose: "p",
  dose: { text: "10", type: "reps", range: [10, 10] }, patterns: ["mobility"], regions: ["hips"], equipment: ["mat"], position: "seated",
  laterality: "alternating", load: "bodyweight", contraction: ["isotonic"], difficulty: 2, conditions,
  evidence: { name: "stated", dose: "stated", steps: "stated" }, confidence: "high",
});
const word = (i: number) => String.fromCharCode(97 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26));

describe("alignReading within the Workers free plan's CPU", () => {
  for (const links of [12, 30]) {
    it(`${links} links by close names against a 30-move re-read, corrections again: under ${CEILING_MS} ms scaled p50`, (ctx) => {
      const fresh = extractionSchema.parse({ kind: "routine", summary: "s", themes: [], moves: Array.from({ length: 30 }, (_, i) => move(`Slow Zorbex ${word(i)} drift hold`)).reverse() });
      const rows: KeptRow[] = Array.from({ length: links }, (_, i) => ({ position: i, moveId: `my${i}`, moveKind: "personal", status: "saved", name: `Zorbex ${word(i)} drift hold` }));
      const earlier = { moves: Array.from({ length: links }, (_, i) => ({ name: `Zorbex ${word(i)} drift hold`, aliases: ["Old alias"] })) };
      const fixes = Array.from({ length: links }, (_, i) => ({ position: i, field: "why" as const, after: "the post says so" }));
      const run = () => alignReading(fresh, { earlier, rows, fixes, keepInsights: true });
      expect(run().ok).toBe(true);
      for (let i = 0; i < 5; i++) run();
      const before = calibrate();
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const t = performance.now();
        run();
        times.push(performance.now() - t);
      }
      const calibration = (before + calibrate()) / 2;
      const ratio = calibration / REFERENCE_CALIBRATION_MS;
      const scaled = p50(times) * (REFERENCE_CALIBRATION_MS / calibration);
      console.log(`re-read bench (${links} links): p50 ${p50(times).toFixed(2)} ms raw, ${scaled.toFixed(2)} scaled (runner ${ratio.toFixed(2)}×)`);
      if (ON_CI) ctx.skip("on CI: timings printed, not asserted");
      if (ratio > MAX_RUNNER_RATIO || ratio < 1 / MAX_RUNNER_RATIO) {
        ctx.skip(`runner at ${ratio.toFixed(2)}× the reference machine's speed: a CPU timing here would measure the runner`);
      }
      expect(scaled).toBeLessThan(CEILING_MS);
    }, 120_000);
  }
});
