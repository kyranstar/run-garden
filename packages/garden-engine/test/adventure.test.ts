import { describe, expect, it } from "vitest";
import {
  ADVENTURE_TUNING,
  adventureGraceDay,
  isBigAdventure,
  qualifiesAsAdventure,
  recoveryScoreFrom,
} from "../src/index.js";

const base = { lastAdventureDate: "2026-06-06", adventureGraceDays: 0 };
const day = (date: string, over: Partial<Parameters<typeof adventureGraceDay>[1]> = {}) => ({
  date,
  hasSession: false,
  adventureToday: false,
  restMode: false,
  planGap: false,
  ...over,
});

describe("qualifying threshold", () => {
  it("qualifies on load OR duration, at the boundary", () => {
    expect(qualifiesAsAdventure({ sport: "hike", trainingLoad: 40 })).toBe(true);
    expect(qualifiesAsAdventure({ sport: "hike", trainingLoad: 39 })).toBe(false);
    expect(qualifiesAsAdventure({ sport: "walk", durationMin: 45 })).toBe(true);
    expect(qualifiesAsAdventure({ sport: "walk", durationMin: 44 })).toBe(false);
    expect(qualifiesAsAdventure({ sport: "walk" })).toBe(false); // no data → neutral
  });
  it("big days at the boundary", () => {
    expect(isBigAdventure({ sport: "hike", durationMin: 150 })).toBe(true);
    expect(isBigAdventure({ sport: "hike", durationMin: 149, trainingLoad: 79 })).toBe(false);
    expect(isBigAdventure({ sport: "ski", trainingLoad: 80 })).toBe(true);
  });
});

describe("recoveryScoreFrom", () => {
  it("prefers the true recovery score, falls back to 100 - fatigue, else undefined", () => {
    expect(recoveryScoreFrom(72, 90)).toBe(72);
    expect(recoveryScoreFrom(null, 30)).toBe(70);
    expect(recoveryScoreFrom(undefined, undefined)).toBeUndefined();
    expect(recoveryScoreFrom(null, 130)).toBe(0); // clamped
  });
});

describe("adventureGraceDay", () => {
  it("recovery path: grace while under the threshold, inside the window", () => {
    expect(adventureGraceDay(base, day("2026-06-07", { recoveryScore: 59 }))).toBe(true);
    expect(adventureGraceDay(base, day("2026-06-08", { recoveryScore: 59 }))).toBe(true);
    expect(adventureGraceDay(base, day("2026-06-07", { recoveryScore: 60 }))).toBe(false);
    // outside the graceCap window: never, however tired
    expect(adventureGraceDay(base, day("2026-06-09", { recoveryScore: 10 }))).toBe(false);
  });
  it("heuristic path: spends the bank only when no recovery data exists", () => {
    const banked = { ...base, adventureGraceDays: 1 };
    expect(adventureGraceDay(banked, day("2026-06-07"))).toBe(true);
    expect(adventureGraceDay(base, day("2026-06-07"))).toBe(false); // empty bank
    // recovery data present and fine → bank is irrelevant
    expect(adventureGraceDay(banked, day("2026-06-07", { recoveryScore: 95 }))).toBe(false);
  });
  it("never a grace day when something else already explains the day", () => {
    const banked = { ...base, adventureGraceDays: 2 };
    expect(adventureGraceDay(banked, day("2026-06-07", { hasSession: true }))).toBe(false);
    expect(adventureGraceDay(banked, day("2026-06-07", { adventureToday: true }))).toBe(false);
    expect(adventureGraceDay(banked, day("2026-06-07", { restMode: true }))).toBe(false);
    expect(adventureGraceDay(banked, day("2026-06-07", { planGap: true }))).toBe(false);
    expect(adventureGraceDay({ lastAdventureDate: null, adventureGraceDays: 2 }, day("2026-06-07"))).toBe(false);
  });
});
