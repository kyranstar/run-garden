import { describe, expect, it } from "vitest";
import {
  EXERCISES, FORMAT_IDS, MODE_IDS, PROFILES, TMJ,
  type Attrs, type CheckReading, type FormatId, type HistoryEntry, type Mode, type SessionChecks,
} from "../src/index.js";

// A profile's rules, written out for the coach designer's prompt (Stage 3 spec §3): generated from the constants the
// rules themselves read, so the prompt and the code cannot disagree.

const a = (clench: number, neckLoad = 0, faceDown = false): Attrs => ({ clench, neckLoad, faceDown });
const reading = (pre: number | null, extra: Partial<CheckReading> = {}): CheckReading => ({ pre, post: null, feelingOff: false, ...extra });
const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
const lineStarting = (lines: readonly string[], head: string): string => {
  const hit = lines.filter((l) => l.startsWith(head));
  expect(hit, `one line starting "${head}"`).toHaveLength(1);
  return hit[0]!;
};

describe("describeRules — every profile", () => {
  it.each(Object.values(PROFILES))("$id describes its rules in plain sentences, the same every time", (p) => {
    const lines = p.describeRules();
    expect(lines.length).toBeGreaterThan(0);
    expect(new Set(lines).size).toBe(lines.length);
    for (const l of lines) {
      expect(l.trim(), l).toBe(l);
      expect(l, l).toMatch(/[.]$/);
      expect(l, l).not.toMatch(/\n/);
    }
    expect(p.describeRules()).toEqual(lines);
  });
});

describe("describeRules — TMJ", () => {
  const lines = TMJ.describeRules();

  it("reads, exactly", () => {
    expect(lines).toEqual([
      "Ratings: every library move is rated clench 0–3, neckLoad 0–3 and faceDown (yes or no); a move without a rating can't be placed.",
      "Never: a move rated clench 3 or more — refused in every workout.",
      "Overhead pressing (the push-v pattern): only in build mode, and only with today's check answered at 2 or less — refused otherwise.",
      "Plyometric moves (jumps, hops, bounds, landings): never in recovery mode, never while the athlete feels off, otherwise only with today's check answered at 2 or less — refused otherwise.",
      "Mode caps, a cost when exceeded: recovery — clench ≤ 1, neckLoad ≤ 1, no face-down positions; consistent — clench ≤ 2, neckLoad ≤ 2, face-down allowed; build — clench ≤ 2, neckLoad ≤ 2, face-down allowed.",
      "Format caps, a cost when exceeded: clench ≤ 2 in straight sets, supersets and holds; clench ≤ 1 in circuits, ladders and flows.",
      "Flare: a check of 5 or more. On a flare day keep to flare-safe moves: clench ≤ 1, neckLoad ≤ 1, no face-down positions.",
      "Recovery mode is called for (a harder mode is a cost) when the athlete feels off, today's check is 5 or more, the last session's check rose by 2 or more, or 2 or more moves were flagged \"Clenched\" last session.",
      "Build mode needs (otherwise it is a cost): a check of 2 or less — today's, else how the last session ended; no check of 5 or more in the past 7 days, and after-session checks averaging 3 or less; a clean last session — no move flagged \"Clenched\" and a rise of 1 or less.",
      "Progression: a move flagged \"Clenched\", or every move of a session whose check rose by 2 or more, steps down next time; hold rather than progress when today's check is 5 or more, or 2 or more above the last session's before-check.",
      "Rotation: a move flagged \"Clenched\" in 2 of its last 3 sessions rotates out.",
      "Check: \"Jaw / head\", 0–10, before and after a session or on its own; during a session a move can be flagged \"Clenched\".",
      "Care: a \"Jaw care\" part in holds — about 27% of a recovery session (3–6 moves), 10% of a consistent one (1–3), 7% of a build one (1–3).",
    ]);
  });

  // Each number the text states is found again by probing the rule it describes: a hand-written line would go stale
  // the day its constant changes; a generated one follows it.
  it("states the never line the rule draws", () => {
    const first = range(0, 3).find((c) => TMJ.never(a(c)))!;
    expect(lineStarting(lines, "Never:")).toContain(`clench ${first} or more`);
  });

  it("states the calm line overhead pressing and jumps draw", () => {
    const plyo = EXERCISES.find((e) => e.contraction.includes("plyometric"))!;
    const pressCalm = Math.max(...range(0, 10).filter((pre) => TMJ.allowPattern("push-v", "build", reading(pre))));
    const jumpCalm = Math.max(...range(0, 10).filter((pre) => TMJ.allowRecord!(plyo, "build", reading(pre))));
    expect(lineStarting(lines, "Overhead pressing")).toContain(`answered at ${pressCalm} or less`);
    expect(lineStarting(lines, "Plyometric moves")).toContain(`answered at ${jumpCalm} or less`);
    expect(TMJ.allowPattern("push-v", "consistent", reading(0))).toBe(false);
    expect(TMJ.allowRecord!(plyo, "recovery", reading(0))).toBe(false);
  });

  it("states each mode's caps as fitsMode reads them", () => {
    const line = lineStarting(lines, "Mode caps");
    for (const mode of MODE_IDS as readonly Mode[]) {
      const clench = Math.max(...range(0, 3).filter((c) => TMJ.fitsMode(a(c), mode)));
      const neck = Math.max(...range(0, 3).filter((n) => TMJ.fitsMode(a(0, n), mode)));
      const faceDown = TMJ.fitsMode(a(0, 0, true), mode) ? "face-down allowed" : "no face-down positions";
      expect(line, mode).toContain(`${mode} — clench ≤ ${clench}, neckLoad ≤ ${neck}, ${faceDown}`);
    }
  });

  it("states each format's cap as fitsFormat reads it", () => {
    const words: Record<FormatId, string> = { straight: "straight sets", superset: "supersets", circuit: "circuits", ladder: "ladders", flow: "flows", holds: "holds" };
    const segments = lineStarting(lines, "Format caps").replace(/^[^:]*: /, "").replace(/\.$/, "").split("; ");
    for (const f of FORMAT_IDS) {
      const cap = Math.max(...range(0, 3).filter((c) => TMJ.fitsFormat(a(c), f)));
      const segment = segments.find((s) => new RegExp(`(in |, | and )${words[f]}(,| and|$)`).test(s));
      expect(segment, f).toBeDefined();
      expect(segment, f).toMatch(new RegExp(`^clench ≤ ${cap} in `));
    }
  });

  it("states the flare line and the flare-safe caps", () => {
    const flareAt = range(0, 10).find((pre) => TMJ.flare(reading(pre)))!;
    const safeClench = Math.max(...range(0, 3).filter((c) => TMJ.flareSafe(a(c))));
    const safeNeck = Math.max(...range(0, 3).filter((n) => TMJ.flareSafe(a(0, n))));
    const line = lineStarting(lines, "Flare:");
    expect(line).toContain(`a check of ${flareAt} or more`);
    expect(line).toContain(`clench ≤ ${safeClench}, neckLoad ≤ ${safeNeck}, ${TMJ.flareSafe(a(0, 0, true)) ? "face-down allowed" : "no face-down positions"}`);
  });

  it("states the rise that steps a session's moves down", () => {
    const entry: Pick<HistoryEntry, "flags"> = { flags: [] };
    const session = (pre: number, post: number): SessionChecks => ({ checks: { tmj: { pre, post, feelingOff: false } } });
    const rise = range(0, 10).find((r) => TMJ.stepDownCause(entry, session(0, r)) === "symptom")!;
    expect(lineStarting(lines, "Progression:")).toContain(`rose by ${rise} or more`);
    expect(lineStarting(lines, "Progression:")).toContain(`"${TMJ.setFlag!.label}"`);
  });

  it("states the check, the flag and the care block in the profile's own words", () => {
    expect(lineStarting(lines, "Check:")).toContain(`"${TMJ.check.label}", ${TMJ.check.min}–${TMJ.check.max}`);
    expect(lineStarting(lines, "Care:")).toContain(`"${TMJ.care!.block.label}"`);
  });
});
