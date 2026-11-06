/**
 * Read it again's CPU at its worst case (phase 5a): an old post's 12 links (the cap readings had before extract-6) lined
 * up with a 30-move re-read by close names only (every row scores every move), with corrections to re-apply. The
 * relay's request holds it beside the call's own work. And 30 links, which no old post has, stays in reach.
 */
import { describe, expect, it } from "vitest";
import { PROFILES } from "@rg/exercise-library";
import { extractionSchema } from "@rg/saves";
import { alignReading, type KeptRow } from "../src/services/saves-reread.js";

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

describe("alignReading's CPU", () => {
  const bench = (links: number) => {
    const fresh = extractionSchema.parse({ kind: "routine", summary: "s", themes: [], moves: Array.from({ length: 30 }, (_, i) => move(`Slow Zorbex ${word(i)} drift hold`)).reverse() });
    const rows: KeptRow[] = Array.from({ length: links }, (_, i) => ({ position: i, moveId: `my${i}`, moveKind: "personal", status: "saved", name: `Zorbex ${word(i)} drift hold` }));
    const earlier = { moves: Array.from({ length: links }, (_, i) => ({ name: `Zorbex ${word(i)} drift hold`, aliases: ["Old alias"] })) };
    const fixes = Array.from({ length: links }, (_, i) => ({ position: i, field: "why" as const, after: "the post says so" }));
    const run = () => alignReading(fresh, { earlier, rows, fixes, keepInsights: true });
    expect(run().ok).toBe(true);
    for (let i = 0; i < 5; i++) run();
    const n = 40;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) run();
    return (performance.now() - t0) / n;
  };
  it("an old post's 12 links against a 30-move re-read: well inside the request's 10 ms", () => {
    // REBASED 2026-11-06 (phase 5 backfill): measured 0.83 ms on the build Mac (schema parse ~0.45 of it); 3 ms leaves
    // room for a loaded machine and the Worker's slower CPU, inside the request's 10 ms beside the reading's own work.
    expect(bench(12)).toBeLessThan(3);
  });
  it("30 links against 30 moves (no old post has them): still in reach", () => {
    // REBASED 2026-11-06 (phase 5 backfill): measured 0.84 ms; the same 3 ms.
    expect(bench(30)).toBeLessThan(3);
  });
});
