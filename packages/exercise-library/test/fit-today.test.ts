/**
 * TODAY'S CONDITION FIT (`fitToday`, eligibility.ts): a move against every switched-on profile for today's reading —
 * fits (safe even on a flare day) · care (allowed today, within the profile's limits) · not today, with the reason in
 * plain words. The Studio's list and the coach's library search both read this one rule.
 */
import { describe, expect, it } from "vitest";
import { EXERCISES, FIT_RANK, fitToday, PROFILES, type ExerciseRecord } from "../src/index.js";

const rec = (id: string): ExerciseRecord => EXERCISES.find((e) => e.id === id)!;
const reading = (pre: number | null, feelingOff = false) => ({ tmj: { pre, post: null, feelingOff } });
const tmj = [PROFILES.tmj];

describe("today's condition fit", () => {
  it("nothing to say with no profile on", () => {
    expect(fitToday(rec("gobletSquat"), [], {})).toBeNull();
  });

  it("a move safe even on a flare day fits, whatever the reading", () => {
    for (const r of [reading(null), reading(1), reading(8), reading(1, true)]) {
      expect(fitToday(rec("gobletSquat"), tmj, r)).toEqual({ state: "fits", reason: "Safe for TMJ, even on a flare day." });
    }
  });

  it("a move allowed with limits is care on any day above recovery — answered or not — and not today on a flare day", () => {
    // Overhead pressing: no calm check any more (2026-10-23), only never in recovery.
    const press = rec("halfKneelingPress");
    for (const r of [reading(1), reading(4), reading(null)]) expect(fitToday(press, tmj, r)).toEqual({ state: "care", reason: "Fine today, within TMJ limits." });
    expect(fitToday(press, tmj, reading(8))).toEqual({ state: "not", reason: "Overhead pressing sits out a flare day." });
    expect(fitToday(press, tmj, reading(5))).toEqual({ state: "not", reason: "Overhead pressing sits out a flare day." });
    expect(fitToday(press, tmj, reading(1, true))!.state).toBe("not");
    // No reading for the profile at all is unanswered.
    expect(fitToday(press, tmj, {})).toEqual(fitToday(press, tmj, reading(null)));
  });

  it("a flare day, or feeling off, is a recovery day: a move allowed only in harder sessions is not for today", () => {
    // Farmer carry: fine for TMJ in a consistent or build session, never in recovery.
    const carry = rec("farmerCarry");
    expect(fitToday(carry, tmj, reading(1))!.state).toBe("care");
    expect(fitToday(carry, tmj, reading(8))).toEqual({ state: "not", reason: "Not with jaw / head at 8 today." });
    expect(fitToday(carry, tmj, reading(1, true))).toEqual({ state: "not", reason: "Not while you're feeling off." });
  });

  it("a jump says why it is not for today, in the profile's own words", () => {
    const jump = rec("landingStick");
    const f = fitToday(jump, tmj, reading(1, true))!;
    expect(f.state).toBe("not");
    expect(f.reason).toBe(PROFILES.tmj.recordReason!(jump, "build", { pre: 1, post: null, feelingOff: true }));
    expect(f.reason).toBe("Jumps sit out while you're feeling off.");
    // No calm check any more: answered or not, a jump is fine above recovery.
    expect(fitToday(jump, tmj, reading(1))!.state).toBe("care");
    expect(fitToday(jump, tmj, reading(null))!.state).toBe("care");
    expect(fitToday(jump, tmj, reading(4))!.state).toBe("care");
    // A flare day: the jumps sit it out (review M1).
    expect(fitToday(jump, tmj, reading(5))).toEqual({ state: "not", reason: "Jumps sit out a flare day." });
    expect(fitToday(jump, tmj, reading(8))).toEqual({ state: "not", reason: "Jumps sit out a flare day." });
  });

  it("a top-clench move is fine with limits (build's sets) on a calm day, not on a flare day", () => {
    const clenching = { ...rec("gobletSquat"), conditions: { tmj: { clench: 3, neckLoad: 0, faceDown: false } } };
    expect(fitToday(clenching, tmj, reading(0))).toEqual({ state: "care", reason: "Fine today, within TMJ limits." });
    expect(fitToday(clenching, tmj, reading(8))!.state).toBe("not");
  });

  it("a move the profile never allows says so by name; an unrated move fails closed and says so", () => {
    const unreadable = { ...rec("gobletSquat"), conditions: { tmj: { clench: 4, neckLoad: 0, faceDown: false } } };
    expect(fitToday(unreadable, tmj, reading(0))).toEqual({ state: "not", reason: "TMJ rules this move out." });
    expect(fitToday({ ...rec("gobletSquat"), conditions: {} }, tmj, reading(0))).toEqual({ state: "not", reason: "TMJ rules this move out." });
  });

  it("with more than one profile on, the worst decides, whatever their order", () => {
    // A stricter profile that rates no move: every move fails closed for it.
    const strict = { ...PROFILES.tmj, id: "strict", label: "Strict" };
    const goblet = rec("gobletSquat");
    expect(fitToday(goblet, [PROFILES.tmj, strict], reading(1))).toEqual({ state: "not", reason: "Strict rules this move out." });
    expect(fitToday(goblet, [strict, PROFILES.tmj], reading(1))).toEqual({ state: "not", reason: "Strict rules this move out." });
  });

  it("ranks fits before care before not", () => {
    expect(FIT_RANK.fits).toBeLessThan(FIT_RANK.care);
    expect(FIT_RANK.care).toBeLessThan(FIT_RANK.not);
  });
});
