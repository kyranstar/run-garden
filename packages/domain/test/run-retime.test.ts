/**
 * A STRUCTURED RUN RE-TIMED BY THE RULE (the owner's decision, 2026-10-20): the coach states a run's new length, and
 * `retimeRun` does the arithmetic — warm-up and cool-down kept, repeats change their count (closest to the target, never
 * fewer than one, at most half again when longer), a continuous main block scales to fill the rest (whole minutes, or
 * 100 m), reps first then the block when a session has both, the warm-up and cool-down shrunk only when even one rep (or a
 * five-minute block) would not fit — never below five minutes each — and refused past that, or when nothing scales.
 */
import { describe, expect, it } from "vitest";
import {
  expandSegment,
  foldRepeats,
  RETIME_FLOOR_SEC,
  RETIME_REP_GROWTH,
  retimeRun,
  runStructureSeconds,
  segmentSeconds,
  type RetimeSegment,
  type RetimeStep,
  type RunStructure,
} from "../src/index.js";

const t = (role: RetimeStep["role"], minutes: number, label?: string): RetimeStep => ({
  role,
  target: { kind: "time", seconds: Math.round(minutes * 60) },
  ...(label ? { label } : {}),
});
const d = (role: RetimeStep["role"], meters: number, secPerKm: number, label?: string): RetimeStep => ({
  role,
  target: { kind: "distance", meters, seconds: (meters / 1000) * secPerKm },
  ...(label ? { label } : {}),
});
const one = (...steps: RetimeStep[]): RetimeSegment => ({ rounds: 1, repeat: false, steps });
const reps = (n: number, steps: RetimeStep[], o: Partial<RetimeSegment> = {}): RetimeSegment => ({ rounds: n, repeat: true, steps, ...o });
const run = (...segments: RetimeSegment[]): RunStructure => ({ segments });
const wu = (min: number) => one(t("warmup", min, "easy"));
const cd = (min: number) => one(t("cooldown", min, "easy"));

/** The result, or the test fails saying why it was refused. */
function ok(r: ReturnType<typeof retimeRun>) {
  if ("refused" in r) throw new Error(`refused: ${r.refused} — ${r.reason}`);
  return r;
}
const minutes = (r: { seconds: number }) => Math.round(r.seconds / 60);
const roundsOf = (s: RunStructure) => s.segments.map((x) => x.rounds);
const secondsOf = (s: RunStructure) => s.segments.map((x) => x.steps.map((st) => st.target.seconds));

describe("repeated intervals change their count, not their length", () => {
  it("the owner's example: a 35-minute tempo of 5 × 5 min cut to 25 is 3 × 5 min, the warm-up and cool-down kept", () => {
    const s = run(wu(5), reps(5, [t("work", 5, "threshold")]), cd(5));
    const r = ok(retimeRun(s, 25 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 3, 1]);
    expect(secondsOf(r.structure)).toEqual([[300], [300], [300]]);
    expect(r.seconds).toBe(1500);
    expect(r.summary).toBe("3 × 5 min (was 5 × 5)");
    expect(r.changed).toBe(true);
  });

  it("a rep's recovery goes with it, and the count is the one whose total is closest to the target", () => {
    // 10 + 5 × (5 + 2) + 10 = 55 → 40: two reps make 34, three make 41 — 41 is the closer.
    const s = run(wu(10), reps(5, [t("work", 5, "threshold"), t("recovery", 2, "easy")]), cd(10));
    const r = ok(retimeRun(s, 40 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 3, 1]);
    expect(minutes(r)).toBe(41);
    expect(r.summary).toBe("3 × 5 min (was 5 × 5)");
  });

  it("a tie between two counts goes to the fewer", () => {
    // 10 + 4 × 4 + 10 = 36 → 30: two reps make 28, three make 32.
    const r = ok(retimeRun(run(wu(10), reps(4, [t("work", 4)]), cd(10)), 30 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 2, 1]);
    expect(minutes(r)).toBe(28);
  });

  it("never fewer than one", () => {
    // 10 + 5 × 7 + 10 = 55 → 27: one rep makes 27.
    const r = ok(retimeRun(run(wu(10), reps(5, [t("work", 5), t("recovery", 2)]), cd(10)), 27 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 1, 1]);
    expect(minutes(r)).toBe(27);
  });

  it("a written-out set whose last recovery isn't there keeps it off the last round", () => {
    // 10 + (5 × 7 − 2) + 10 = 53 → 39: three reps, the last without its recovery, make 39.
    const s = run(wu(10), reps(5, [t("work", 5), t("recovery", 2)], { lastRoundOmits: 1 }), cd(10));
    const r = ok(retimeRun(s, 39 * 60));
    expect(r.structure.segments[1]).toMatchObject({ rounds: 3, lastRoundOmits: 1 });
    expect(r.seconds).toBe(39 * 60);
  });

  it("a rest between rounds counts between the rounds only", () => {
    // 10 + (4 × 5 + 3 × 1) + 10 = 43 → 32: two reps make 31, three 37.
    const s = run(wu(10), reps(4, [t("work", 5)], { restBetweenRoundsSec: 60 }), cd(10));
    const r = ok(retimeRun(s, 32 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 2, 1]);
    expect(minutes(r)).toBe(31);
  });

  it("two sets of repeats change together, each by the same share", () => {
    // 10 + 6 × (2 + 1) + 6 × (1:30 + 1) + 10 = 53 → 37: three of each make 36.5.
    const s = run(wu(10), reps(6, [t("work", 2, "interval"), t("recovery", 1)]), reps(6, [t("work", 1.5, "interval"), t("recovery", 1)]), cd(10));
    const r = ok(retimeRun(s, 37 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 3, 3, 1]);
    expect(r.summary).toBe("3 × 2 min (was 6 × 2) · 3 × 90s (was 6 × 90)");
  });

  it("distance reps keep their distance: only the count changes", () => {
    const s = run(one(d("warmup", 2000, 380, "easy")), reps(6, [d("work", 1000, 250, "interval"), d("recovery", 400, 400, "easy")]), one(d("cooldown", 2000, 380, "easy")));
    // 760 + 6 × 410 + 760 = 3980 s → 40 min: two reps make 2340 s (39), three 2750 (45.8).
    const r = ok(retimeRun(s, 40 * 60));
    expect(r.structure.segments[1]!.rounds).toBe(2);
    expect(r.structure.segments[1]!.steps.map((x) => x.target)).toEqual(s.segments[1]!.steps.map((x) => x.target));
    expect(r.summary).toBe("2 × 1 km (was 6 × 1)");
  });
});

describe("a continuous main block scales to fill the rest", () => {
  it("easy, steady, tempo or long: the block takes what the warm-up and cool-down leave, in whole minutes", () => {
    const r = ok(retimeRun(run(wu(10), one(t("work", 40, "steady")), cd(10)), 45 * 60));
    expect(secondsOf(r.structure)).toEqual([[600], [1500], [600]]);
    expect(r.seconds).toBe(2700);
    expect(r.summary).toBe("steady 25 min (was 40)");
  });

  it("rounds to the minute that lands nearest the target", () => {
    // 7.5 + 40 + 10 = 57.5 → 50: the block's 32.5 minutes is 32 (49.5 total, rounds to 50), not 33 (50.5 → 51).
    const s = run(one(t("warmup", 7.5, "easy")), one(t("work", 40, "steady")), cd(10));
    const r = ok(retimeRun(s, 50 * 60));
    expect(r.structure.segments[1]!.steps[0]!.target.seconds).toBe(32 * 60);
    expect(minutes(r)).toBe(50);
  });

  it("a distance block scales to the 100 m", () => {
    // 10 min + 15 km at 6:00 + 10 min = 120 min → 90: 70 minutes of it is 11.67 km → 11.7 km.
    const s = run(wu(10), one(d("work", 15000, 360, "long")), cd(10));
    const r = ok(retimeRun(s, 90 * 60));
    expect(r.structure.segments[1]!.steps[0]!.target).toEqual({ kind: "distance", meters: 11700, seconds: 11700 * 0.36 });
    expect(minutes(r)).toBe(90);
    expect(r.summary).toBe("long 11.7 km (was 15)");
  });

  it("a run that is one block says nothing more than its length", () => {
    const r = ok(retimeRun(run(one(t("work", 30, "easy"))), 20 * 60));
    expect(secondsOf(r.structure)).toEqual([[1200]]);
    expect(r.summary).toBe("");
  });

  it("only its work scales: a recovery in it, and a stride under a minute, stay as they are", () => {
    const s = run(wu(10), one(t("work", 20, "steady"), t("recovery", 4, "easy"), t("work", 20, "steady"), t("work", 0.5, "strides")), cd(10));
    const r = ok(retimeRun(s, 53 * 60));
    // 64.5 → 53: the two 20s share the 11.5 minutes taken off, 14 each; the 4-minute recovery and the stride stay.
    expect(secondsOf(r.structure)[1]).toEqual([840, 240, 840, 30]);
    expect(minutes(r)).toBe(53);
  });

  it("lengthening extends it", () => {
    const r = ok(retimeRun(run(wu(10), one(t("work", 20, "steady")), cd(10)), 60 * 60));
    expect(secondsOf(r.structure)).toEqual([[600], [2400], [600]]);
    expect(r.summary).toBe("steady 40 min (was 20)");
  });
});

describe("a session that mixes repeats and a block: reps first, then the block for the remainder", () => {
  // 10 + 20 steady + 4 × (3 + 2) + 10 = 60.
  const mixed = () => run(wu(10), one(t("work", 20, "steady")), reps(4, [t("work", 3, "threshold"), t("recovery", 2)]), cd(10));

  it("shorter: the reps go first, then the block takes up what is left", () => {
    // 60 → 38: one rep with the block as it is makes 45 — the closest the reps get — then the block gives up 7.
    const r = ok(retimeRun(mixed(), 38 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 1, 1, 1]);
    expect(secondsOf(r.structure)[1]).toEqual([13 * 60]);
    expect(r.seconds).toBe(38 * 60);
    expect(r.summary).toBe("steady 13 min (was 20) · 1 × 3 min (was 4 × 3)");
  });

  it("shorter, where the reps alone reach it: the block stays", () => {
    const r = ok(retimeRun(mixed(), 50 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 1, 2, 1]);
    expect(secondsOf(r.structure)[1]).toEqual([1200]);
    expect(r.summary).toBe("2 × 3 min (was 4 × 3)");
  });

  it("longer: reps added up to the target (at most half again), then the block extended for the rest", () => {
    // 60 → 72: six reps (the cap) make 70, the block 22.
    const r = ok(retimeRun(mixed(), 72 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 1, 6, 1]);
    expect(secondsOf(r.structure)[1]).toEqual([22 * 60]);
    expect(r.seconds).toBe(72 * 60);
    expect(r.summary).toBe("steady 22 min (was 20) · 6 × 3 min (was 4 × 3)");
  });

  it("longer, by less than a rep: the block alone extends — the reps never overshoot it", () => {
    // 60 → 63: a fifth rep would make 65; the block extends by 3 instead.
    const r = ok(retimeRun(mixed(), 63 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 1, 4, 1]);
    expect(secondsOf(r.structure)[1]).toEqual([23 * 60]);
  });

  it("shorter with the block near its floor: a rep fewer rather than a block under five minutes", () => {
    // 10 + 6 steady + 3 × 10 + 10 = 56 → 44: two reps, with the block as it is, make 46 — the closest — but would leave the
    // block 4 minutes, under its floor: one rep, the block 14.
    const s = run(wu(10), one(t("work", 6, "steady")), reps(3, [t("work", 10, "threshold")]), cd(10));
    const r = ok(retimeRun(s, 44 * 60));
    expect(r.structure.segments[2]!.rounds).toBe(1);
    expect(r.structure.segments[1]!.steps[0]!.target.seconds).toBe(14 * 60);
    expect(minutes(r)).toBe(44);
  });
});

describe("short reps beside a main set are accessories: kept as they are (the lead's ruling, 2026-10-20)", () => {
  const stride = (seconds: number) => [t("work", seconds / 60, "strides"), t("recovery", 40 / 60, "easy")];

  it("an easy 40 with 6 × 20 s strides, cut to 30: the strides stay 6 × 20 s, the easy block shortens", () => {
    // 34 easy + 6 × (20 s + 40 s) = 40 → 30: the block takes it all, 24.
    const s = run(one(t("work", 34, "easy")), reps(6, stride(20)));
    const r = ok(retimeRun(s, 30 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 6]);
    expect(secondsOf(r.structure)[0]).toEqual([24 * 60]);
    expect(r.seconds).toBe(30 * 60);
    expect(r.summary).toBe("easy 24 min (was 34)");
  });

  it("a tempo session with strides: its tempo reps change their count, the strides stay", () => {
    // 10 + 3 × (8 + 2) + 4 × (20 s + 40 s) + 10 = 54 → 44: two tempo reps make 44, the strides as they are.
    const s = run(wu(10), reps(3, [t("work", 8, "tempo"), t("recovery", 2, "easy")]), reps(4, stride(20)), cd(10));
    const r = ok(retimeRun(s, 44 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 2, 4, 1]);
    expect(r.seconds).toBe(44 * 60);
    expect(r.summary).toBe("2 × 8 min (was 3 × 8)");
    // The count is chosen with the strides counted: → 47 is two reps (44), not three (54) — as it would be were the
    // strides' four minutes left out of the sum.
    expect(roundsOf(ok(retimeRun(s, 47 * 60)).structure)).toEqual([1, 2, 4, 1]);
  });

  it("the edge: a 60 s rep is an accessory and stays; a 61 s rep is an interval and its count changes", () => {
    const at = (seconds: number) => run(one(t("work", 30, "easy")), reps(6, [t("work", seconds / 60, "interval"), t("recovery", 1, "easy")]));
    // 30 + 6 × 2 = 42 → 36: sixty-second reps stay six, the block 24.
    const sixty = ok(retimeRun(at(60), 36 * 60));
    expect(roundsOf(sixty.structure)).toEqual([1, 6]);
    expect(secondsOf(sixty.structure)[0]).toEqual([24 * 60]);
    // 30 + 6 × 2:01 = 42.1 → 36: sixty-one-second reps go first — three of them, the block as it was.
    const sixtyOne = ok(retimeRun(at(61), 36 * 60));
    expect(roundsOf(sixtyOne.structure)).toEqual([1, 3]);
    expect(secondsOf(sixtyOne.structure)[0]).toEqual([30 * 60]);
  });

  it("…and by distance: 200 m is an accessory, 201 m an interval", () => {
    const at = (meters: number) => run(one(t("work", 30, "easy")), reps(6, [d("work", meters, 300, "interval"), t("recovery", 1, "easy")]));
    expect(roundsOf(ok(retimeRun(at(200), 30 * 60)).structure)).toEqual([1, 6]);
    expect(ok(retimeRun(at(201), 30 * 60)).structure.segments[1]!.rounds).toBeLessThan(6);
  });

  it("a rep holding a long piece as well as a short one is an interval: its count changes", () => {
    // 30 + 6 × (30 s + 2 min + 1 min) = 51 → 41: reps first — three make 40.5, the block as it was.
    const s = run(one(t("work", 30, "easy")), reps(6, [t("work", 0.5, "strides"), t("work", 2, "interval"), t("recovery", 1, "easy")]));
    expect(ok(retimeRun(s, 41 * 60)).structure.segments[1]!.rounds).toBe(3);
  });

  it("no block, the reps at one and still too long: the strides give way to the count nearest the target", () => {
    // 10 + 3 × (8 + 2) + 4 × 1 + 10 = 54 → 31: one tempo rep (34 with the strides) — then one stride makes 31.
    const s = run(wu(10), reps(3, [t("work", 8, "tempo"), t("recovery", 2, "easy")]), reps(4, stride(20)), cd(10));
    const r = ok(retimeRun(s, 31 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 1, 1, 1]);
    expect(r.summary).toBe("1 × 8 min (was 3 × 8) · 1 × 20s (was 4 × 20)");
  });

  it("with the block at its floor, the accessory's count gives way — to the fewest that let the block keep five minutes", () => {
    // 6 easy + 6 × 1 = 12 → 9: the block can give only 1, so four strides, the block 5.
    const r = ok(retimeRun(run(one(t("work", 6, "easy")), reps(6, stride(20))), 9 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 4]);
    expect(secondsOf(r.structure)[0]).toEqual([5 * 60]);
    expect(r.summary).toBe("easy 5 min (was 6) · 4 × 20s (was 6 × 20)");
  });

  it("reps and a block with strides: the reps go to one and the block to its floor before the strides give way", () => {
    // 10 + 6 steady + 3 × 10 + 6 × 1 + 10 = 62 → 37: one rep and the block at 5 leave room for two strides.
    const s = run(wu(10), one(t("work", 6, "steady")), reps(3, [t("work", 10, "threshold")]), reps(6, stride(20)), cd(10));
    const r = ok(retimeRun(s, 37 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 1, 1, 2, 1]);
    expect(secondsOf(r.structure)[1]).toEqual([300]);
    expect(r.seconds).toBe(37 * 60);
    expect(r.summary).toBe("steady 5 min (was 6) · 1 × 10 min (was 3 × 10) · 2 × 20s (was 6 × 20)");
  });

  it("…down to one, before the warm-up and cool-down give anything", () => {
    // 10 + 20 + 6 × 1 + 10 = 46 → 25: the block at 5, one stride (1), and the warm-up and cool-down share 19.
    const r = ok(retimeRun(run(wu(10), one(t("work", 20, "easy")), reps(6, stride(20)), cd(10)), 25 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 1, 1, 1]);
    expect(secondsOf(r.structure)[1]).toEqual([300]);
    expect(minutes(r)).toBe(25);
  });

  it("longer: the accessory stays as it is and the block extends", () => {
    const r = ok(retimeRun(run(one(t("work", 34, "easy")), reps(6, stride(20))), 50 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 6]);
    expect(secondsOf(r.structure)[0]).toEqual([44 * 60]);
  });

  it("a session of short reps alone — 10 × 200 m, no block — keeps the rule: its count changes", () => {
    // 10 + 10 × (200 m at 40 s + 200 m jog at 80 s) + 10 = 40 → 30: five reps.
    const s = run(wu(10), reps(10, [d("work", 200, 200, "interval"), d("recovery", 200, 400, "easy")]), cd(10));
    const r = ok(retimeRun(s, 30 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 5, 1]);
    expect(r.summary).toBe("5 × 200 m (was 10 × 200)");
  });
});

describe("too short: the warm-up and cool-down shrink to a floor of five minutes each, then refused", () => {
  const intervals = () => run(wu(10), reps(5, [t("work", 5, "threshold"), t("recovery", 2)]), cd(10));

  it("shrinks them in proportion when even one rep doesn't fit beside them", () => {
    // One rep is 7: 10 + 7 + 10 = 27 > 18, so the 11 left go 6 and 5.
    const r = ok(retimeRun(intervals(), 18 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 1, 1]);
    expect(secondsOf(r.structure)).toEqual([[360], [300, 120], [300]]);
    expect(r.seconds).toBe(18 * 60);
    expect(r.summary).toBe("warm-up 6 min (was 10) · 1 × 5 min (was 5 × 5) · cool-down 5 min (was 10)");
  });

  it("one rep beside them that just fits: nothing shrinks — not even a warm-up of half minutes", () => {
    // 7.5 + 7 + 9.5 = 24: one rep fits exactly, so the warm-up and cool-down stay as they are.
    const s = run(one(t("warmup", 7.5, "easy")), reps(5, [t("work", 5), t("recovery", 2)]), one(t("cooldown", 9.5, "easy")));
    const r = ok(retimeRun(s, 24 * 60));
    expect(secondsOf(r.structure)).toEqual([[450], [300, 120], [570]]);
    expect(r.summary).toBe("1 × 5 min (was 5 × 5)");
  });

  it("in proportion to each: a long cool-down gives up more", () => {
    // 6 + 5 + 12 = 23 → 21: 16 left, 6:12 → 5 and 11.
    const r = ok(retimeRun(run(wu(6), reps(3, [t("work", 5)]), cd(12)), 21 * 60));
    expect(secondsOf(r.structure)).toEqual([[300], [300], [660]]);
  });

  it("a side at its floor keeps it, and the other takes the rest", () => {
    // 5 + 2 × 5 + 15 = 30 → 18: one rep beside them is 25, so 13 are left — the warm-up stays at its 5, the cool-down 8.
    const r = ok(retimeRun(run(wu(5), reps(2, [t("work", 5)]), cd(15)), 18 * 60));
    expect(secondsOf(r.structure)).toEqual([[300], [300], [480]]);
  });

  it("a warm-up already under five minutes is its own floor", () => {
    const r = ok(retimeRun(run(wu(3), reps(4, [t("work", 5)]), cd(10)), 14 * 60));
    expect(secondsOf(r.structure)).toEqual([[180], [300], [360]]);
  });

  it("a block shrinks to five minutes before the warm-up and cool-down give anything", () => {
    // 10 + 30 + 10 → 18: the block at its floor of 5 leaves 13 — 7 and 6.
    const r = ok(retimeRun(run(wu(10), one(t("work", 30, "steady")), cd(10)), 18 * 60));
    expect(secondsOf(r.structure)).toEqual([[420], [300], [360]]);
  });

  it("refused past the floors, with the reason the coach reads: too short for a warm-up, a cool-down and one rep — use ease", () => {
    const r = retimeRun(intervals(), 15 * 60);
    expect(r).toMatchObject({ refused: "too_short" });
    if (!("refused" in r)) throw new Error("expected a refusal");
    expect(r.reason).toContain("too short to keep its warm-up, cool-down and one rep");
    expect(r.reason).toContain("ease");
  });

  it("…and for a block: a five-minute main block", () => {
    const r = retimeRun(run(wu(10), one(t("work", 30, "steady")), cd(10)), 14 * 60);
    expect(r).toMatchObject({ refused: "too_short" });
    if (!("refused" in r)) throw new Error("expected a refusal");
    expect(r.reason).toContain("a 5-minute main block");
  });

  it("a block on its own: under five minutes is refused", () => {
    expect(retimeRun(run(one(t("work", 30, "easy"))), 4 * 60)).toMatchObject({ refused: "too_short" });
  });
});

describe("longer: reps added (at most half again), then the block extended — refused when nothing scales", () => {
  it("adds reps up to half again as many, and no more", () => {
    // 10 + 4 × 5 + 10 = 40 → 60: six reps (the cap) make 50.
    const r = ok(retimeRun(run(wu(10), reps(4, [t("work", 5)]), cd(10)), 60 * 60));
    expect(roundsOf(r.structure)).toEqual([1, 6, 1]);
    expect(minutes(r)).toBe(50);
    expect(r.summary).toBe("6 × 5 min (was 4 × 5)");
    expect(RETIME_REP_GROWTH).toBe(1.5);
  });

  it("the cap rounds down: five reps grow to seven at most", () => {
    const r = ok(retimeRun(run(wu(10), reps(5, [t("work", 5)]), cd(10)), 90 * 60));
    expect(r.structure.segments[1]!.rounds).toBe(7);
  });

  it("a session of one rep stays one: it is unchanged", () => {
    const r = ok(retimeRun(run(wu(10), reps(1, [t("work", 5)]), cd(10)), 40 * 60));
    expect(r.changed).toBe(false);
    expect(r.summary).toBe("");
  });

  it("only a warm-up and a cool-down: nothing scales — refused either way, the coach told to use ease", () => {
    for (const target of [10, 40]) {
      const r = retimeRun(run(wu(10), cd(10)), target * 60);
      expect(r).toMatchObject({ refused: "nothing_to_scale" });
      if (!("refused" in r)) throw new Error("expected a refusal");
      expect(r.reason).toContain("ease");
    }
  });
});

describe("the shape and the no-op", () => {
  it("the target the session already is: nothing changes", () => {
    const s = run(wu(10), reps(5, [t("work", 5), t("recovery", 2)]), cd(10));
    const r = ok(retimeRun(s, 55 * 60));
    expect(r.changed).toBe(false);
    expect(r.structure).toEqual(s);
    expect(r.summary).toBe("");
    expect(r.seconds).toBe(55 * 60);
  });

  it("…to the minute: 46.7 minutes asked as 47 is the session as it is", () => {
    const s = run(wu(10), one(d("work", 5000, 300, "steady")), one(d("cooldown", 2000, 350, "easy")));
    expect(Math.round(runStructureSeconds(s) / 60)).toBe(47);
    expect(ok(retimeRun(s, 47 * 60)).changed).toBe(false);
  });

  it("the structure keeps its shape: the same segments and steps in order, their roles and labels — only counts and lengths move", () => {
    const s = run(wu(10), one(t("work", 20, "steady")), reps(4, [t("work", 3, "threshold"), t("recovery", 2, "easy")], { restBetweenRoundsSec: 30 }), cd(10));
    for (const target of [20, 38, 50, 72, 90]) {
      const r = ok(retimeRun(s, target * 60));
      expect(r.structure.segments.length).toBe(s.segments.length);
      r.structure.segments.forEach((seg, i) => {
        const was = s.segments[i]!;
        expect(seg.steps.map((x) => [x.role, x.label, x.target.kind])).toEqual(was.steps.map((x) => [x.role, x.label, x.target.kind]));
        expect([seg.repeat, seg.restBetweenRoundsSec, seg.lastRoundOmits]).toEqual([was.repeat, was.restBetweenRoundsSec, was.lastRoundOmits]);
      });
    }
  });

  it("never mutates what it was given", () => {
    const s = run(wu(10), reps(5, [t("work", 5)]), cd(10));
    const copy = JSON.parse(JSON.stringify(s));
    retimeRun(s, 20 * 60);
    expect(s).toEqual(copy);
  });

  it("steps are at least a minute, or 100 m", () => {
    const r = ok(retimeRun(run(wu(10), one(d("work", 200, 300, "tempo"), t("work", 1.5, "tempo"), t("work", 20, "steady")), cd(10)), 25 * 60));
    for (const seg of r.structure.segments) {
      for (const st of seg.steps) {
        if (st.target.kind === "distance") expect(st.target.meters).toBeGreaterThanOrEqual(100);
        else expect(st.target.seconds).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it("its floor is five minutes", () => {
    expect(RETIME_FLOOR_SEC).toBe(300);
  });
});

describe("folding a written-out run of reps, and writing one out", () => {
  const W = t("work", 5, "threshold");
  const R = t("recovery", 2, "rest");

  it("work, recovery, work, recovery, work: three reps, the last without its recovery", () => {
    const segs = foldRepeats([t("warmup", 10, "easy"), W, R, W, R, W, t("cooldown", 10, "easy")]);
    expect(segs).toEqual([
      { rounds: 1, repeat: false, steps: [t("warmup", 10, "easy")] },
      { rounds: 3, repeat: true, steps: [W, R], lastRoundOmits: 1 },
      { rounds: 1, repeat: false, steps: [t("cooldown", 10, "easy")] },
    ]);
  });

  it("the same block five times over is five reps", () => {
    expect(foldRepeats([W, W, W, W, W])).toEqual([{ rounds: 5, repeat: true, steps: [W] }]);
  });

  it("every recovery there: full rounds", () => {
    expect(foldRepeats([W, R, W, R])).toEqual([{ rounds: 2, repeat: true, steps: [W, R] }]);
  });

  it("nothing repeated, or a repeat of no work: each step its own", () => {
    const easy = t("warmup", 5, "easy");
    expect(foldRepeats([easy, easy, t("work", 20, "steady"), R])).toEqual([one(easy), one(easy), one(t("work", 20, "steady")), one(R)]);
  });

  it("a block that differs breaks the run: same role, label and length, or not the same", () => {
    expect(foldRepeats([W, t("work", 5, "interval"), W]).every((s) => !s.repeat)).toBe(true);
    expect(foldRepeats([W, t("work", 4, "threshold")]).every((s) => !s.repeat)).toBe(true);
  });

  it("written out again: rounds × steps, the last round without what it omits", () => {
    expect(expandSegment({ rounds: 3, repeat: true, steps: [W, R], lastRoundOmits: 1 })).toEqual([W, R, W, R, W]);
    expect(expandSegment({ rounds: 1, repeat: true, steps: [W, R], lastRoundOmits: 1 })).toEqual([W]);
    expect(expandSegment(one(W))).toEqual([W]);
  });

  it("a segment's seconds: its rounds, less what the last omits, with the rest between rounds", () => {
    expect(segmentSeconds({ rounds: 3, repeat: true, steps: [W, R], lastRoundOmits: 1, restBetweenRoundsSec: 30 })).toBe(3 * 420 - 120 + 60);
    expect(segmentSeconds({ rounds: 3, repeat: true, steps: [W, R] }, 2)).toBe(840);
  });
});
