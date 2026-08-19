/**
 * buildReadiness gains a band and a 7-night row (sleep/recovery 0020). The
 * laws: the band is COROS's own base ± sd, rounded once here so every surface
 * prints the same two integers; nights anchor at TODAY (not the newest row)
 * so a stale feed shows trailing gaps; a date without a usable reading is a
 * gap, never a guess.
 */
import { describe, expect, it } from "vitest";
import { buildReadiness } from "../src/services/readiness.js";

const row = (
  date: string,
  over: Partial<{
    restingHeartRate: number | null;
    hrv: number | null;
    recoveryScore: number | null;
    sleepHrvBase: number | null;
    sleepHrvSd: number | null;
  }> = {},
) => ({
  date,
  restingHeartRate: 46,
  hrv: 66,
  recoveryScore: null,
  sleepHrvBase: 68,
  sleepHrvSd: 6,
  ...over,
});

describe("buildReadiness band + nights", () => {
  it("band = newest COROS base ± sd, rounded", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`2026-08-${18 - i}`));
    const v = buildReadiness(rows, "2026-08-18");
    expect(v.band).toEqual({ lo: 62, hi: 74 });
  });

  it("no real sd, no printed band — the 10% stand-in classifies but is never dressed as the watch's", () => {
    // (Verify round 1, findings 3/6/7: every surface that says "your band"
    // must mean the same two integers.)
    const noSd = Array.from({ length: 8 }, (_, i) => row(`2026-08-${18 - i}`, { sleepHrvSd: null }));
    expect(buildReadiness(noSd, "2026-08-18").band).toBeNull();
    const zeroSd = Array.from({ length: 8 }, (_, i) => row(`2026-08-${18 - i}`, { sleepHrvSd: 0 }));
    expect(buildReadiness(zeroSd, "2026-08-18").band).toBeNull();
    const bare = Array.from({ length: 8 }, (_, i) =>
      row(`2026-08-${18 - i}`, { sleepHrvBase: null, sleepHrvSd: null }),
    );
    expect(buildReadiness(bare, "2026-08-18").band).toBeNull();
  });

  it("nights: 7 cells ending TODAY, gaps where nothing was read", () => {
    // Rows for 18th (settled), 16th (low), 15th (settled) — 17th missing
    // entirely, 12th–14th present but unread (nulls).
    const rows = [
      row("2026-08-18"),
      row("2026-08-16", { hrv: 55 }),
      row("2026-08-15"),
      row("2026-08-14", { hrv: null, sleepHrvBase: null }),
      row("2026-08-13", { hrv: null, sleepHrvBase: null }),
      row("2026-08-12", { hrv: null, sleepHrvBase: null }),
      row("2026-08-11"),
      row("2026-08-10"),
    ];
    const v = buildReadiness(rows, "2026-08-18");
    expect(v.nights.map((n) => n.state)).toEqual([
      "gap", // 12
      "gap", // 13
      "gap", // 14
      "settled", // 15
      "low", // 16
      "gap", // 17 — no row at all
      "settled", // 18
    ]);
    expect(v.nights[0]!.date).toBe("2026-08-12");
    expect(v.nights[6]!.date).toBe("2026-08-18");
  });

  it("a stale feed shows trailing gaps because nights anchor at today", () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`2026-08-${12 - i}`));
    const v = buildReadiness(rows, "2026-08-18");
    expect(v.nights.slice(-6).every((n) => n.state === "gap")).toBe(true);
    expect(v.nights[0]!.state).toBe("settled"); // the 12th still shows
  });
});
