import { describe, expect, it } from "vitest";
import {
  FORMAT_IDS, MODE_IDS, PATTERNS, PROFILES, TMJ,
  type Attrs, type CheckReading, type ExerciseRecord, type HistorySession, type Mode, type ProposalCtx,
} from "../src/index.js";

// The TMJ profile reproduces the standalone tool's thresholds and sentences exactly.

const a = (clench: number, neckLoad = 0, faceDown = false): Attrs => ({ clench, neckLoad, faceDown });
const reading = (pre: number | null, extra: Partial<CheckReading> = {}): CheckReading => ({ pre, post: null, feelingOff: false, ...extra });

function session(date: string, o: { pre?: number | null; post?: number | null; flags?: string[][]; mode?: Mode | null } = {}): HistorySession {
  return {
    id: `s-${date}`, date, startedAt: `${date}T18:00:00`, mode: o.mode ?? null, theme: null, blockNumber: null,
    checks: { tmj: { pre: o.pre === undefined ? 1 : o.pre, post: o.post === undefined ? 1 : o.post, feelingOff: false } },
    done: [],
    entries: (o.flags ?? []).map((flags, i) => ({ id: `e${i}`, implement: null, perSide: false, format: null, flags, sets: [] })),
  };
}

function ctx(o: { pre?: number | null; feelingOff?: boolean; last?: HistorySession | null; week?: HistorySession[] } = {}): ProposalCtx {
  const last = o.last === undefined ? session("2026-09-28") : o.last;
  const week = o.week ?? (last ? [last] : []);
  return { today: "2026-09-29", reading: reading(o.pre ?? null, { feelingOff: o.feelingOff ?? false }), past: week, last, week };
}

describe("TMJ profile — exercise rules", () => {
  it("is registered under its id", () => {
    expect(PROFILES.tmj).toBe(TMJ);
    expect(TMJ.id).toBe("tmj");
    expect(TMJ.check).toEqual({ label: "Jaw / head", min: 0, max: 10 });
    expect(TMJ.setFlag).toEqual({ id: "clenched", label: "Clenched", pastTense: "You clenched" });
    expect(TMJ.attributes).toEqual({ clench: { kind: "scale", min: 0, max: 3 }, neckLoad: { kind: "scale", min: 0, max: 3 }, faceDown: { kind: "flag" } });
  });

  it.each([[0, false], [1, false], [2, false], [3, true]])("never: clench %i → %s", (clench, expected) => {
    expect(TMJ.never(a(clench))).toBe(expected);
  });

  // recovery: clench ≤ 1, neck ≤ 1, no face-down; consistent and build: clench ≤ 2, neck ≤ 2.
  it.each<[Mode, number, number, boolean, boolean]>([
    ["recovery", 1, 1, false, true],
    ["recovery", 2, 0, false, false],
    ["recovery", 0, 2, false, false],
    ["recovery", 0, 0, true, false],
    ["consistent", 2, 2, true, true],
    ["consistent", 3, 0, false, false],
    ["consistent", 0, 3, false, false],
    ["build", 2, 2, true, true],
    ["build", 3, 0, false, false],
    ["build", 2, 3, false, false],
  ])("fitsMode %s: clench %i, neck %i, faceDown %s → %s", (mode, clench, neck, faceDown, expected) => {
    expect(TMJ.fitsMode(a(clench, neck, faceDown), mode)).toBe(expected);
  });

  // The standalone formats' maxClench: circuit, ladder and flow 1; straight, superset and holds 2.
  it("fitsFormat applies each format's clench cap", () => {
    const caps: Record<string, number> = { straight: 2, superset: 2, circuit: 1, ladder: 1, flow: 1, holds: 2 };
    for (const f of FORMAT_IDS) {
      for (const clench of [0, 1, 2, 3]) expect(TMJ.fitsFormat(a(clench), f), `${f} ${clench}`).toBe(clench <= (caps[f] ?? -1));
    }
  });

  it("allowPattern: overhead pressing only in build, and only with an answered pre-check of 2 or less", () => {
    for (const mode of MODE_IDS) {
      for (const pre of [null, 0, 1, 2, 3, 5]) {
        const ok = mode === "build" && pre != null && pre <= 2;
        expect(TMJ.allowPattern("push-v", mode, reading(pre)), `${mode} ${pre}`).toBe(ok);
        for (const p of PATTERNS.filter(x => x !== "push-v")) expect(TMJ.allowPattern(p, mode, reading(pre))).toBe(true);
      }
    }
  });

  it("coreCandidate: clench ≤ 2; flareSafe: clench ≤ 1, neck ≤ 1, not face down", () => {
    expect([0, 1, 2, 3].map(c => TMJ.coreCandidate(a(c)))).toEqual([true, true, true, false]);
    expect(TMJ.flareSafe(a(1, 1, false))).toBe(true);
    expect(TMJ.flareSafe(a(2, 0, false))).toBe(false);
    expect(TMJ.flareSafe(a(0, 2, false))).toBe(false);
    expect(TMJ.flareSafe(a(0, 0, true))).toBe(false);
  });

  it("blockAssignable: overhead pressing is never a block's core lift", () => {
    const rec = (patterns: string[]) => ({ patterns }) as unknown as ExerciseRecord;
    expect(TMJ.blockAssignable(rec(["push-v"]))).toBe(false);
    expect(TMJ.blockAssignable(rec(["push-h"]))).toBe(true);
  });

  it("a missing or malformed rating reads as the worst case, never as safe", () => {
    expect(TMJ.never({})).toBe(true);
    expect(TMJ.flareSafe({})).toBe(false);
    expect(TMJ.fitsMode({ clench: 0 }, "recovery")).toBe(false);
    expect(TMJ.coreCandidate({ clench: true })).toBe(false);
  });
});

describe("TMJ profile — proposal", () => {
  it("recovery reasons, in the standalone order and words", () => {
    expect(TMJ.recoveryReason(ctx({ feelingOff: true, pre: 6 }))).toBe("You said you're feeling off.");
    expect(TMJ.recoveryReason(ctx({ pre: 6 }))).toBe("Jaw/head is at 6 right now.");
    expect(TMJ.recoveryReason(ctx({ pre: 4 }))).toBe(null);
    expect(TMJ.recoveryReason(ctx({ pre: 1, last: session("2026-09-28", { pre: 1, post: 3 }) }))).toBe("Symptoms rose 1 → 3 last session.");
    expect(TMJ.recoveryReason(ctx({ pre: 1, last: session("2026-09-28", { flags: [["clenched"], ["clenched"], []] }) }))).toBe("You clenched on 2 lifts last session.");
    expect(TMJ.recoveryReason(ctx({ pre: 1, last: session("2026-09-28", { flags: [["clenched"]] }) }))).toBe(null);
    expect(TMJ.recoveryReason(ctx({ pre: null, last: null }))).toBe(null);
  });

  it("build checks 1–3 with the standalone reasons", () => {
    const failing = (c: ProposalCtx) => TMJ.buildChecks(c).filter(([ok]) => !ok).map(([, r]) => r);
    expect(failing(ctx({ pre: 1 }))).toEqual([]);
    expect(failing(ctx({ pre: 3 }))).toEqual(["Build needs a calm jaw (2 or less) — you're at 3."]);
    expect(failing(ctx({ pre: null, last: session("2026-09-28", { post: null }) }))).toEqual(["Build needs a jaw check first."]);
    const flared = [session("2026-09-24", { pre: 6, post: 5 }), session("2026-09-28")];
    expect(failing(ctx({ pre: 1, week: flared, last: flared[1] }))).toEqual(["Your jaw has flared in the last 7 days."]);
    expect(failing(ctx({ pre: 1, last: session("2026-09-28", { flags: [["clenched"]] }) }))).toEqual(["Last session wasn't clean."]);
    expect(failing(ctx({ pre: 1, last: session("2026-09-28", { pre: 1, post: 3 }) }))).toContain("Last session wasn't clean.");
  });

  it("build label names today's level, falling back to how the last session ended", () => {
    expect(TMJ.buildLabel(ctx({ pre: 1 }))).toBe("Jaw calm (1)");
    expect(TMJ.buildLabel(ctx({ pre: null, last: session("2026-09-28", { post: 2 }) }))).toBe("Jaw calm (2)");
  });
});

describe("TMJ profile — progression, selection, milestones, care", () => {
  const e = (flags: string[] = []) => ({ flags });
  const s = (pre: number | null, post: number | null) => ({ checks: { tmj: { pre, post, feelingOff: false } } });

  it("entryClean and stepDownCause: a flag, then a symptom rise of 2 or more", () => {
    expect(TMJ.entryClean(e(), s(1, 2))).toBe(true);
    expect(TMJ.entryClean(e(["clenched"]), s(1, 1))).toBe(false);
    expect(TMJ.entryClean(e(), s(2, 4))).toBe(false);
    expect(TMJ.stepDownCause(e(["clenched"]), s(2, 4))).toBe("flag");
    expect(TMJ.stepDownCause(e(), s(2, 4))).toBe("symptom");
    expect(TMJ.stepDownCause(e(), s(2, 3))).toBe(null);
    expect(TMJ.stepDownCause(e(), { checks: {} })).toBe(null);
  });

  it("holdReason: a high check today, or a rise since last session", () => {
    expect(TMJ.holdReason(reading(null), s(0, 0))).toBe(null);
    expect(TMJ.holdReason(reading(5), null)).toBe("Jaw/head is up today — hold here and keep it easy.");
    expect(TMJ.holdReason(reading(3), s(1, 1))).toBe("Symptoms are higher than last session — hold here.");
    expect(TMJ.holdReason(reading(2), s(1, 1))).toBe(null);
    expect(TMJ.holdReason(reading(3), null)).toBe(null);
  });

  it("quiet phrase, flag penalty, rotation and calm streak words", () => {
    expect(TMJ.quietPhrase).toBe("with a quiet jaw");
    expect(TMJ.flagPenaltyWeight).toBe(2);
    expect(TMJ.rotateReason([e(["clenched"]), e(), e(["clenched"])])).toBe("clenched in 2 of the last 3 sessions");
    expect(TMJ.rotateReason([e(["clenched"]), e(), e(), e(["clenched"])])).toBe(null);
    expect(TMJ.calmStreakLabel).toBe("calm-jaw");
  });

  it("care: the jaw-care block and the jaw coverage target", () => {
    expect(TMJ.care).toEqual({
      block: {
        label: "Jaw care", roles: ["jaw-care"], formats: ["holds"],
        share: { recovery: 0.27, consistent: 0.1, build: 0.07 },
        min: { recovery: 3, consistent: 1, build: 1 },
        max: { recovery: 6, consistent: 3, build: 3 },
      },
      coverageTargets: { regions: { jaw: 4 } },
    });
  });
});
