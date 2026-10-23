import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXERCISES, FORMAT_IDS, LOCATION_PRESETS, MODE_IDS, PATTERNS, PROFILES, TMJ, eligible, fitToday, flareSafe, isDoneCleanly, makeEngineData,
  recordFlareSafe,
  type Attrs, type CheckReading, type ConditionProfile, type EngineData, type ExerciseRecord, type HistorySession, type Mode, type ProposalCtx,
} from "../src/index.js";

// The TMJ profile: the standalone tool's rules as relaxed on 2026-10-23 after an evidence review — top-clench moves in
// build's sets with rest, overhead pressing and jumps outside recovery with no calm check, face-down positions in
// recovery (a flare day stays flare-safe), and build on a 24-hour response rule.

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

  // No rating on the scale is ruled out any more (a top-clench move is build's, in sets with rest): only a rating the
  // profile can't read is.
  it.each([[0, false], [1, false], [2, false], [3, false]])("never: clench %i → %s", (clench, expected) => {
    expect(TMJ.never(a(clench))).toBe(expected);
  });

  it("never: only a rating the profile can't read — missing, off its scale, or the wrong kind", () => {
    expect(TMJ.never({ clench: 4, neckLoad: 0, faceDown: false })).toBe(true);
    expect(TMJ.never({ clench: 1, neckLoad: -1, faceDown: false })).toBe(true);
    expect(TMJ.never({ clench: 1.5, neckLoad: 0, faceDown: false })).toBe(true);
    expect(TMJ.never({ clench: 1, neckLoad: 0, faceDown: 1 })).toBe(true);
    expect(TMJ.never({ clench: 1, neckLoad: 0 })).toBe(true);
    expect(TMJ.never(a(3, 3, true))).toBe(false);
  });

  // recovery: clench ≤ 1, neck ≤ 1, face-down allowed; consistent: clench ≤ 2, neck ≤ 2; build: clench ≤ 3, neck ≤ 2.
  it.each<[Mode, number, number, boolean, boolean]>([
    ["recovery", 1, 1, false, true],
    ["recovery", 2, 0, false, false],
    ["recovery", 0, 2, false, false],
    ["recovery", 0, 0, true, true],
    ["recovery", 1, 1, true, true],
    ["consistent", 2, 2, true, true],
    ["consistent", 3, 0, false, false],
    ["consistent", 0, 3, false, false],
    ["build", 2, 2, true, true],
    ["build", 3, 0, false, true],
    ["build", 3, 2, true, true],
    ["build", 2, 3, false, false],
  ])("fitsMode %s: clench %i, neck %i, faceDown %s → %s", (mode, clench, neck, faceDown, expected) => {
    expect(TMJ.fitsMode(a(clench, neck, faceDown), mode)).toBe(expected);
  });

  it("fitsMode: neck and posture care work is never held to the neck-load caps; everything else is", () => {
    const rec = (roles: string[], primary: string[]) => ({ roles, muscles: { primary, secondary: [] } }) as unknown as ExerciseRecord;
    const careRole = rec(["jaw-care"], ["upper-traps"]);
    const neckFlexors = rec(["activation"], ["deep-neck-flexors"]);
    const other = rec(["accessory"], ["upper-traps"]);
    for (const mode of MODE_IDS) {
      for (const neck of [0, 1, 2, 3]) {
        expect(TMJ.fitsMode(a(0, neck), mode, careRole), `${mode} care ${neck}`).toBe(true);
        expect(TMJ.fitsMode(a(0, neck), mode, neckFlexors), `${mode} flexors ${neck}`).toBe(true);
        expect(TMJ.fitsMode(a(0, neck), mode, other), `${mode} other ${neck}`).toBe(TMJ.fitsMode(a(0, neck), mode));
      }
      // Only the neck cap: clenching still counts.
      expect(TMJ.fitsMode(a(3, 0), "consistent", careRole)).toBe(false);
    }
    expect(TMJ.fitsMode(a(0, 2), "recovery", other)).toBe(false);
    // Not on a flare day: flare-safe keeps its neck cap.
    expect(TMJ.flareSafe(a(0, 2))).toBe(false);
  });

  it("the library's neck and posture care work fits every mode's neck-load cap", () => {
    const care = EXERCISES.filter(e => e.roles.includes("jaw-care") || e.muscles.primary.includes("deep-neck-flexors"));
    expect(care.map(e => e.id)).toEqual(expect.arrayContaining(["chinTuck", "chinNodHold", "rocabado"]));
    for (const ex of care) {
      for (const mode of MODE_IDS) {
        for (const neckLoad of [0, 1, 2, 3]) expect(TMJ.fitsMode({ clench: 0, neckLoad, faceDown: false }, mode, ex), `${ex.id} ${mode} ${neckLoad}`).toBe(true);
      }
    }
  });

  // Circuits, ladders and flows tolerate the least clenching; holds 2; straight sets and supersets, with their rest, 3.
  it("fitsFormat applies each format's clench cap", () => {
    const caps: Record<string, number> = { straight: 3, superset: 3, circuit: 1, ladder: 1, flow: 1, holds: 2 };
    for (const f of FORMAT_IDS) {
      for (const clench of [0, 1, 2, 3]) expect(TMJ.fitsFormat(a(clench), f), `${f} ${clench}`).toBe(clench <= (caps[f] ?? -1));
    }
  });

  it("a top-clench move: only in build, and only in straight sets or a superset", () => {
    for (const mode of MODE_IDS) expect(TMJ.fitsMode(a(3), mode), mode).toBe(mode === "build");
    for (const f of FORMAT_IDS) expect(TMJ.fitsFormat(a(3), f), f).toBe(f === "straight" || f === "superset");
  });

  it("allowPattern: overhead pressing in consistent and build below the flare line, answered or not; never in recovery, never on a flare day", () => {
    for (const mode of MODE_IDS) {
      for (const pre of [null, 0, 1, 2, 3, 4, 5, 9, 10]) {
        for (const feelingOff of [false, true]) {
          const today = reading(pre, { feelingOff });
          expect(TMJ.allowPattern("push-v", mode, today), `${mode} ${pre} ${feelingOff}`).toBe(mode !== "recovery" && (pre === null || pre < 5));
          for (const p of PATTERNS.filter(x => x !== "push-v")) expect(TMJ.allowPattern(p, mode, today)).toBe(true);
        }
      }
    }
  });

  it("allowRecord: a plyometric move never in recovery, never when feeling off, never on a flare day, otherwise allowed — the check answered or not", () => {
    const rec = (contraction: string[]) => ({ contraction }) as unknown as ExerciseRecord;
    for (const mode of MODE_IDS) {
      for (const pre of [null, 0, 1, 2, 3, 4, 5, 9, 10]) {
        for (const feelingOff of [false, true]) {
          const ok = mode !== "recovery" && !feelingOff && (pre === null || pre < 5);
          const today = reading(pre, { feelingOff });
          expect(TMJ.allowRecord!(rec(["plyometric"]), mode, today), `${mode} ${pre} ${feelingOff}`).toBe(ok);
          expect(TMJ.allowRecord!(rec(["eccentric", "plyometric"]), mode, today), `${mode} ${pre} ${feelingOff} mixed`).toBe(ok);
          for (const c of ["isometric", "isotonic", "eccentric", "passive"]) expect(TMJ.allowRecord!(rec([c]), mode, today)).toBe(true);
        }
      }
    }
  });

  it("recordReason: the profile's words exactly when allowRecord holds a jump back or allowPattern an overhead press, and nothing otherwise", () => {
    const rec = (contraction: string[], patterns: string[] = ["squat"]) => ({ contraction, patterns }) as unknown as ExerciseRecord;
    for (const mode of MODE_IDS) {
      for (const pre of [null, 0, 1, 2, 3, 4, 5, 9]) {
        for (const feelingOff of [false, true]) {
          const today = reading(pre, { feelingOff });
          const why = TMJ.recordReason!(rec(["plyometric"]), mode, today);
          expect(why === null, `${mode} ${pre} ${feelingOff}`).toBe(TMJ.allowRecord!(rec(["plyometric"]), mode, today));
          const press = TMJ.recordReason!(rec(["isotonic"], ["push-v"]), mode, today);
          expect(press === null, `press ${mode} ${pre} ${feelingOff}`).toBe(TMJ.allowPattern("push-v", mode, today));
          expect(TMJ.recordReason!(rec(["isotonic"]), mode, today)).toBe(null);
        }
      }
    }
    expect(TMJ.recordReason!(rec(["plyometric"]), "build", reading(4))).toBe(null);
    expect(TMJ.recordReason!(rec(["plyometric"]), "build", reading(null))).toBe(null);
    expect(TMJ.recordReason!(rec(["plyometric"]), "consistent", reading(1, { feelingOff: true }))).toBe("Jumps sit out while you're feeling off.");
    expect(TMJ.recordReason!(rec(["plyometric"]), "recovery", reading(1))).toBe("Jumps sit out a recovery day.");
    expect(TMJ.recordReason!(rec(["plyometric"]), "build", reading(7))).toBe("Jumps sit out a flare day.");
    expect(TMJ.recordReason!(rec(["isotonic"], ["push-v"]), "build", reading(7))).toBe("Overhead pressing sits out a flare day.");
    expect(TMJ.recordReason!(rec(["isotonic"], ["push-v"]), "recovery", reading(1))).toBe("Overhead pressing sits out a recovery day.");
    expect(TMJ.recordReason!(rec(["isotonic"], ["push-v"]), "build", reading(null))).toBe(null);
  });

  it("profiles read the record type, not eligibility (layering): no profile imports the eligibility rules", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "conditions");
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/from "\.\.\/eligibility/);
  });

  // A block's lift plays on consistent days too, so a top-clench (build-only) move is no block lift.
  it("coreCandidate: clench ≤ 2; flareSafe: clench ≤ 1, neck ≤ 1, not face down", () => {
    expect([0, 1, 2, 3].map(c => TMJ.coreCandidate(a(c)))).toEqual([true, true, true, false]);
    expect(TMJ.flareSafe(a(1, 1, false))).toBe(true);
    expect(TMJ.flareSafe(a(2, 0, false))).toBe(false);
    expect(TMJ.flareSafe(a(0, 2, false))).toBe(false);
    expect(TMJ.flareSafe(a(0, 0, true))).toBe(false);
  });

  // It held overhead pressing out of blocks only because the press was build-only behind a calm check; a block's lift now
  // plays in every mode overhead pressing does.
  it("blockAssignable: overhead pressing may be a block's core lift", () => {
    const rec = (patterns: string[]) => ({ patterns }) as unknown as ExerciseRecord;
    expect(TMJ.blockAssignable(rec(["push-v"]))).toBe(true);
    expect(TMJ.blockAssignable(rec(["push-h"]))).toBe(true);
  });

  it("a missing or malformed rating reads as the worst case, never as safe", () => {
    expect(TMJ.never({})).toBe(true);
    expect(TMJ.flareSafe({})).toBe(false);
    expect(TMJ.fitsMode({ clench: 0 }, "recovery")).toBe(false);
    expect(TMJ.coreCandidate({ clench: true })).toBe(false);
  });
});

describe("TMJ profile — the plyometric gate through eligibility (Task 5)", () => {
  const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });
  const gym = LOCATION_PRESETS.find(l => l.id === "gym")!.equipment;
  const plyometric = EXERCISES.filter(e => e.contraction.includes("plyometric"));
  const checks = (pre: number | null) => ({ tmj: reading(pre) });

  it("the library has a graded plyometric ladder to gate", () => {
    expect(plyometric.length).toBeGreaterThanOrEqual(12);
  });

  it("no plyometric move is eligible in recovery, whatever the check, or on its calmest day", () => {
    for (const ex of plyometric) {
      expect(eligible(data, ex, { equipment: gym, mode: "recovery" }), ex.id).toBe(false);
      for (const pre of [null, 0, 1, 2]) expect(eligible(data, ex, { equipment: gym, mode: "recovery", checks: checks(pre) }), `${ex.id} ${pre}`).toBe(false);
    }
  });

  it("in consistent and build below the flare line — answered or not — up to the mode's difficulty cap", () => {
    for (const ex of plyometric) {
      for (const mode of ["consistent", "build"] as const) {
        const cap = data.modes[mode].maxDifficulty;
        for (const pre of [null, 0, 1, 2, 3, 4]) expect(eligible(data, ex, { equipment: gym, mode, checks: checks(pre) }), `${ex.id} ${mode} ${pre}`).toBe(ex.difficulty <= cap);
      }
    }
  });

  // A flare day proposes recovery, but a mode chosen above it (or a planned day) is still a flare day (review M1).
  it("a flare day denies every plyometric move in every mode — an answered check of 5 or more", () => {
    for (const ex of plyometric) {
      for (const mode of MODE_IDS) {
        for (const pre of [5, 7, 10]) expect(eligible(data, ex, { equipment: gym, mode, checks: checks(pre) }), `${ex.id} ${mode} ${pre}`).toBe(false);
      }
    }
  });

  it("overhead pressing: in consistent and build below the flare line, answered or not; never in recovery, never on a flare day", () => {
    const presses = EXERCISES.filter(e => e.patterns.includes("push-v"));
    expect(presses.map(e => e.id)).toContain("halfKneelingPress");
    for (const ex of presses) {
      for (const mode of MODE_IDS) {
        for (const pre of [null, 0, 4, 5, 7, 10]) {
          const open = mode !== "recovery" && (pre === null || pre < 5) && ex.difficulty <= data.modes[mode].maxDifficulty;
          expect(eligible(data, ex, { equipment: gym, mode, checks: checks(pre) }), `${ex.id} ${mode} ${pre}`).toBe(open);
        }
      }
    }
  });

  it("feeling off denies every plyometric move, even on a calm check", () => {
    const feelingOff = { tmj: reading(1, { feelingOff: true }) };
    for (const ex of plyometric) {
      for (const mode of ["consistent", "build"] as const) expect(eligible(data, ex, { equipment: gym, mode, checks: feelingOff }), `${ex.id} ${mode}`).toBe(false);
    }
  });

  it("no plyometric move reads flare-safe, the low-clench ones included; other flare-safe ratings still do", () => {
    const lowClench = plyometric.filter(e => TMJ.flareSafe(e.conditions.tmj!));
    expect(lowClench.map(e => e.id).sort()).toEqual(["landingStick", "lineHopForwardBack", "lineHopLateral", "pogoHop", "skaterBoundLow", "snapDown"]);
    for (const ex of plyometric) {
      expect(recordFlareSafe(TMJ, ex), ex.id).toBe(false);
      expect(flareSafe(data, ex), ex.id).toBe(false);
    }
    const breath = EXERCISES.find(e => e.id === "breath")!;
    expect(recordFlareSafe(TMJ, breath)).toBe(true);
    expect(flareSafe(data, breath)).toBe(true);
  });

  it("no overhead press reads flare-safe either, however gently rated: a flare day leaves it out", () => {
    const press = EXERCISES.find(e => e.id === "halfKneelingPress")!;
    const gentle = { ...press, conditions: { ...press.conditions, tmj: { clench: 0, neckLoad: 0, faceDown: false } } };
    expect(TMJ.flareSafe(gentle.conditions.tmj)).toBe(true);
    expect(recordFlareSafe(TMJ, gentle)).toBe(false);
    expect(flareSafe(data, gentle)).toBe(false);
  });

  it("a profile without the hook allows the record (the hook is optional; absent means allow)", () => {
    const { allowRecord: _dropped, ...rest } = TMJ;
    const hookless: ConditionProfile = rest;
    const loose: EngineData = { ...data, profiles: { active: [hookless], care: [hookless] } };
    const tuck = EXERCISES.find(e => e.id === "tuckJump")!;
    const feelingOff = { tmj: reading(1, { feelingOff: true }) };
    expect(eligible(data, tuck, { equipment: gym, mode: "build", checks: feelingOff })).toBe(false);
    expect(eligible(loose, tuck, { equipment: gym, mode: "build", checks: feelingOff })).toBe(true);
  });
});

describe("TMJ profile — face-down in recovery, and a flare day stays flare-safe (through eligibility)", () => {
  const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });
  const gym = LOCATION_PRESETS.find(l => l.id === "gym")!.equipment;
  const proneYTW = EXERCISES.find(e => e.id === "proneYTW")!;
  const breath = EXERCISES.find(e => e.id === "breath")!;
  const checks = (pre: number | null, feelingOff = false) => ({ tmj: reading(pre, { feelingOff }) });

  it("the library's face-down move is otherwise flare-safe, so face-down alone decides it", () => {
    expect(proneYTW.conditions.tmj).toMatchObject({ faceDown: true });
    expect(TMJ.flareSafe({ ...proneYTW.conditions.tmj!, faceDown: false })).toBe(true);
  });

  it("a recovery day takes a face-down move — on its calmest day, below the flare line, or while feeling off", () => {
    expect(eligible(data, proneYTW, { equipment: gym, mode: "recovery" })).toBe(true);
    for (const pre of [null, 0, 2, 4]) expect(eligible(data, proneYTW, { equipment: gym, mode: "recovery", checks: checks(pre) }), String(pre)).toBe(true);
    expect(eligible(data, proneYTW, { equipment: gym, mode: "recovery", checks: checks(1, true) })).toBe(true);
  });

  it("a flare day's recovery takes flare-safe moves only: no face-down; flare-safe moves stay", () => {
    for (const pre of [5, 6, 10]) {
      expect(eligible(data, proneYTW, { equipment: gym, mode: "recovery", checks: checks(pre) }), String(pre)).toBe(false);
      expect(eligible(data, breath, { equipment: gym, mode: "recovery", checks: checks(pre) }), String(pre)).toBe(true);
    }
    // Every move a flare day's recovery takes is flare-safe.
    for (const ex of EXERCISES) {
      if (eligible(data, ex, { equipment: gym, mode: "recovery", checks: checks(6) })) expect(flareSafe(data, ex), ex.id).toBe(true);
    }
  });

  it("the Studio's fit for today agrees: a flare day rules the face-down move out, a recovery-feeling day does not", () => {
    expect(fitToday(proneYTW, [TMJ], { tmj: reading(6) })).toEqual({ state: "not", reason: "Not with jaw / head at 6 today." });
    expect(fitToday(breath, [TMJ], { tmj: reading(6) })?.state).toBe("fits");
    expect(fitToday(proneYTW, [TMJ], { tmj: reading(1, { feelingOff: true }) })?.state).toBe("care");
    expect(fitToday(proneYTW, [TMJ], { tmj: reading(1) })?.state).toBe("care");
  });
});

describe("TMJ profile — proposal", () => {
  it("recovery reasons, in order, in calm words", () => {
    expect(TMJ.recoveryReason(ctx({ feelingOff: true, pre: 6 }))).toBe("You said you're feeling off.");
    expect(TMJ.recoveryReason(ctx({ pre: 6 }))).toBe("Jaw/head is at 6 today — an easy day helps it settle.");
    expect(TMJ.recoveryReason(ctx({ pre: 4 }))).toBe(null);
    expect(TMJ.recoveryReason(ctx({ pre: 1, last: session("2026-09-28", { pre: 1, post: 3 }) }))).toBe("Jaw/head went 1 → 3 last session — an easy day helps it settle.");
    expect(TMJ.recoveryReason(ctx({ pre: 1, last: session("2026-09-28", { flags: [["clenched"], ["clenched"], []] }) }))).toBe("Clenched on 2 lifts last session — an easy day, jaw soft.");
    expect(TMJ.recoveryReason(ctx({ pre: 1, last: session("2026-09-28", { flags: [["clenched"]] }) }))).toBe(null);
    expect(TMJ.recoveryReason(ctx({ pre: null, last: null }))).toBe(null);
  });

  describe("build checks: the 24-hour response rule", () => {
    const failing = (c: ProposalCtx) => TMJ.buildChecks(c).filter(([ok]) => !ok).map(([, r]) => r);

    it("(a) the jaw level — today's check, else how the last session ended — answered and under the flare line", () => {
      expect(failing(ctx({ pre: 1 }))).toEqual([]);
      expect(failing(ctx({ pre: 3 }))).toEqual([]);
      expect(failing(ctx({ pre: 3, last: session("2026-09-28", { pre: 2, post: 2 }) }))).toEqual([]);
      expect(failing(ctx({ pre: 4, last: session("2026-09-28", { pre: 3, post: 3 }) }))).toEqual([]);
      expect(failing(ctx({ pre: 5, last: session("2026-09-28", { pre: 4, post: 4 }) }))).toEqual(["Jaw/head is at 5 — a steady day today; Develop and Peak open below 5."]);
      expect(failing(ctx({ pre: null, last: session("2026-09-28", { pre: 3, post: 4 }) }))).toEqual([]);
      expect(failing(ctx({ pre: null, last: session("2026-09-28", { pre: 4, post: 5 }) }))).toEqual(["Jaw/head is at 5 — a steady day today; Develop and Peak open below 5."]);
      expect(failing(ctx({ pre: null, last: session("2026-09-28", { post: null }) }))).toEqual(["Log today's jaw check to open a Develop or Peak day."]);
      expect(failing(ctx({ pre: null, last: null }))).toEqual(["Log today's jaw check to open a Develop or Peak day."]);
      expect(failing(ctx({ pre: 2, last: null }))).toEqual([]);
    });

    it("(b) the last session didn't make things worse: today against its before-check, else its own rise", () => {
      // Today's check answered: today − the last session's before-check.
      expect(failing(ctx({ pre: 3, last: session("2026-09-28", { pre: 1, post: 0 }) }))).toEqual([]);
      expect(failing(ctx({ pre: 4, last: session("2026-09-28", { pre: 1, post: 0 }) }))).toEqual(["Jaw/head is up 3 since last session — a steady day lets it settle."]);
      // …even when the last session ended high: today's answer is what counts.
      expect(failing(ctx({ pre: 1, last: session("2026-09-28", { pre: 0, post: 4 }) }))).toEqual([]);
      // No answer today: the last session's after-check − its before-check.
      expect(failing(ctx({ pre: null, last: session("2026-09-28", { pre: 1, post: 3 }) }))).toEqual([]);
      expect(failing(ctx({ pre: null, last: session("2026-09-28", { pre: 1, post: 4 }) }))).toEqual(["Jaw/head went 1 → 4 last session — a steady day lets it settle."]);
      // Nothing to compare against: nothing made worse.
      expect(failing(ctx({ pre: 3, last: session("2026-09-28", { pre: null, post: 3 }) }))).toEqual([]);
    });

    it("no week-long lockout, no weekly average, no clean-session rule any more", () => {
      const flared = [session("2026-09-24", { pre: 6, post: 5 }), session("2026-09-28")];
      expect(failing(ctx({ pre: 1, week: flared, last: flared[1] }))).toEqual([]);
      const highPosts = [session("2026-09-25", { pre: 3, post: 4 }), session("2026-09-28", { pre: 3, post: 4 })];
      expect(failing(ctx({ pre: 3, week: highPosts, last: highPosts[1] }))).toEqual([]);
      expect(failing(ctx({ pre: 1, last: session("2026-09-28", { flags: [["clenched"]] }) }))).toEqual([]);
    });

    it("every line is the athlete's effort's words, never the engine's mode", () => {
      for (const c of [ctx({ pre: null, last: null }), ctx({ pre: 5 }), ctx({ pre: 4, last: session("2026-09-28", { pre: 0 }) }), ctx({ pre: null, last: session("2026-09-28", { pre: 0, post: 4 }) })]) {
        const lines = failing(c);
        expect(lines.length).toBeGreaterThan(0);
        for (const why of lines) expect(why).not.toMatch(/\bbuild\b/i);
      }
    });
  });

  it("build label names today's level, falling back to how the last session ended", () => {
    expect(TMJ.buildLabel(ctx({ pre: 1 }))).toBe("Jaw steady (1)");
    expect(TMJ.buildLabel(ctx({ pre: null, last: session("2026-09-28", { post: 2 }) }))).toBe("Jaw steady (2)");
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

  it("holdReason: a high check today, or a rise since last session — in calm words", () => {
    expect(TMJ.holdReason(reading(null), s(0, 0))).toBe(null);
    expect(TMJ.holdReason(reading(5), null)).toBe("Jaw/head is up today — hold this weight, jaw soft.");
    expect(TMJ.holdReason(reading(3), s(1, 1))).toBe("Jaw/head is up on last session — hold this weight today.");
    expect(TMJ.holdReason(reading(2), s(1, 1))).toBe(null);
    expect(TMJ.holdReason(reading(3), null)).toBe(null);
  });

  it("quiet phrase leads with a soft jaw; flag penalty, rotation and calm streak words", () => {
    expect(TMJ.quietPhrase).toBe("with the jaw soft");
    expect(TMJ.flagPenaltyWeight).toBe(2);
    expect(TMJ.rotateReason([e(["clenched"]), e(), e(["clenched"])])).toBe("clenched in 2 of the last 3 sessions");
    expect(TMJ.rotateReason([e(["clenched"]), e(), e(), e(["clenched"])])).toBe(null);
    expect(TMJ.calmStreakLabel).toBe("calm-jaw");
  });

  it("no profile sentence frames movement as a danger", () => {
    const sentences = [
      TMJ.quietPhrase,
      ...TMJ.describeRules().map(l => l.text),
      TMJ.recoveryReason(ctx({ pre: 6 }))!, TMJ.recoveryReason(ctx({ pre: 1, last: session("2026-09-28", { pre: 1, post: 3 }) }))!,
      TMJ.recoveryReason(ctx({ pre: 1, last: session("2026-09-28", { flags: [["clenched"], ["clenched"]] }) }))!,
      ...TMJ.buildChecks(ctx({ pre: 5 })).map(([, r]) => r), ...TMJ.buildChecks(ctx({ pre: null, last: null })).map(([, r]) => r),
      TMJ.holdReason(reading(5), null)!, TMJ.holdReason(reading(3), s(1, 1))!,
    ];
    for (const t of sentences) expect(t, t).not.toMatch(/\b(danger|dangerous|unsafe|risk|risky|harm|damage|injur\w*|never allowed|avoid)\b/i);
  });

  it("care: the jaw-care block and its coverage targets", () => {
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

describe("TMJ profile — the flare definition (Phase 2d: flare days on the condition tile)", () => {
  // The day's reading at the profile's "up today" line (5): the same line recovery and the hold rule draw.
  it.each([[null, false], [0, false], [4, false], [5, true], [9, true]] as const)("flare: a reading of %s → %s", (pre, expected) => {
    expect(TMJ.flare(reading(pre))).toBe(expected);
  });

  it("feeling off is a reason for recovery, not a flare", () => {
    expect(TMJ.flare(reading(null, { feelingOff: true }))).toBe(false);
    expect(TMJ.recoveryReason(ctx({ feelingOff: true }))).not.toBeNull();
  });

  it("agrees with recovery's own threshold: a flare reading always proposes recovery", () => {
    for (const pre of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(TMJ.recoveryReason(ctx({ pre, last: null })) !== null).toBe(TMJ.flare(reading(pre)));
    }
  });

  it("agrees with build's level line: the level build opens below is the flare line", () => {
    for (const pre of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(TMJ.buildChecks(ctx({ pre, last: null })).every(([ok]) => ok)).toBe(!TMJ.flare(reading(pre)));
    }
  });
});

describe("done cleanly (final review I3): the one rule the engine's ladder and every DayContext.done use", () => {
  const tally = (lastDate: string | null, logged: number, flags: Record<string, number> = {}) => ({ lastDate, logged, flags });

  it("done and never logged (a timed move only started): clean — no flag could be set", () => {
    expect(isDoneCleanly(tally("2026-10-01", 0), [TMJ])).toBe(true);
  });

  it("never done: not clean, whatever the counts say", () => {
    expect(isDoneCleanly(tally(null, 0), [TMJ])).toBe(false);
    expect(isDoneCleanly(tally(null, 2), [TMJ])).toBe(false);
    expect(isDoneCleanly(undefined, [TMJ])).toBe(false);
    expect(isDoneCleanly(null, [TMJ])).toBe(false);
  });

  it("logged with the profile's set flag every time: not clean; once without it: clean", () => {
    expect(isDoneCleanly(tally("2026-10-01", 2, { clenched: 2 }), [TMJ])).toBe(false);
    expect(isDoneCleanly(tally("2026-10-01", 3, { clenched: 2 }), [TMJ])).toBe(true);
  });

  it("a flag no active profile sets doesn't count; with no profile active, done is clean", () => {
    expect(isDoneCleanly(tally("2026-10-01", 1, { other: 1 }), [TMJ])).toBe(true);
    expect(isDoneCleanly(tally("2026-10-01", 1, { clenched: 1 }), [])).toBe(true);
  });
});
