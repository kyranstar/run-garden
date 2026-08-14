/**
 * Threshold-anchored pace bands (2026-08-14). The threshold band must
 * reproduce what COROS itself prescribes on this account — that agreement is
 * the whole justification for deriving rather than inventing.
 */
import { describe, expect, it } from "vitest";
import { paceBandFor } from "../src/pace.js";

describe("paceBandFor", () => {
  it("reproduces COROS's own threshold prescription", () => {
    // Live prod: ltsp 289 s/km, and the imported plan's threshold work
    // blocks target 289–313 s/km.
    expect(paceBandFor("threshold", 289)).toEqual({ fastSecPerKm: 289, slowSecPerKm: 313 });
  });

  it("spaces the other intensities around threshold", () => {
    expect(paceBandFor("easy", 289)).toEqual({ fastSecPerKm: 349, slowSecPerKm: 409 });
    expect(paceBandFor("steady", 289)).toEqual({ fastSecPerKm: 314, slowSecPerKm: 334 });
    expect(paceBandFor("interval", 289)).toEqual({ fastSecPerKm: 269, slowSecPerKm: 284 });
    // Faster edge is always the smaller number — the wire depends on it.
    for (const i of ["easy", "steady", "threshold", "interval"] as const) {
      const b = paceBandFor(i, 289)!;
      expect(b.fastSecPerKm).toBeLessThan(b.slowSecPerKm);
    }
  });

  it("bands track the threshold as fitness moves", () => {
    expect(paceBandFor("threshold", 270)).toEqual({ fastSecPerKm: 270, slowSecPerKm: 294 });
  });

  it("returns null rather than a fabricated prescription", () => {
    expect(paceBandFor("rest", 289)).toBeNull();
    expect(paceBandFor("easy", null)).toBeNull();
    expect(paceBandFor("easy", undefined)).toBeNull();
    expect(paceBandFor(undefined, 289)).toBeNull();
    // Implausible readings (a centisecond bug, a corrupted row) never
    // become a workout target.
    expect(paceBandFor("easy", 12)).toBeNull();
    expect(paceBandFor("easy", 5000)).toBeNull();
    expect(paceBandFor("easy", Number.NaN)).toBeNull();
  });
});
