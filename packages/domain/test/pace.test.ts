/**
 * Threshold-anchored pace bands (2026-08-14). The threshold band must
 * reproduce what COROS itself prescribes on this account — that agreement is
 * the whole justification for deriving rather than inventing.
 */
import { describe, expect, it } from "vitest";
import { conversionPaceFor, paceBandFor } from "../src/pace.js";

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

/**
 * Designed runs (§8 §3): every one of the document's 11 efforts reads through the one function — the card, the
 * validator and the wire share it. By feel and strides get no band (an effort, not a pace), nor do hills (a pace on a
 * hill misleads: the climb sets it), nor race pace without a distance to scale the threshold to.
 */
describe("paceBandFor — the document's efforts", () => {
  it("bands each effort that has a pace from the threshold, faster edge first", () => {
    expect(paceBandFor("recovery", 289)).toEqual({ fastSecPerKm: 379, slowSecPerKm: 439 });
    expect(paceBandFor("long", 289)).toEqual({ fastSecPerKm: 334, slowSecPerKm: 394 });
    expect(paceBandFor("tempo", 289)).toEqual({ fastSecPerKm: 299, slowSecPerKm: 314 });
    // The four the thread coach already writes are unchanged.
    expect(paceBandFor("easy", 289)).toEqual({ fastSecPerKm: 349, slowSecPerKm: 409 });
    expect(paceBandFor("steady", 289)).toEqual({ fastSecPerKm: 314, slowSecPerKm: 334 });
    expect(paceBandFor("threshold", 289)).toEqual({ fastSecPerKm: 289, slowSecPerKm: 313 });
    expect(paceBandFor("interval", 289)).toEqual({ fastSecPerKm: 269, slowSecPerKm: 284 });
  });

  it("orders the efforts from slowest to fastest by their bands' middles", () => {
    const mid = (e: Parameters<typeof paceBandFor>[0]) => {
      const b = paceBandFor(e, 289)!;
      return (b.fastSecPerKm + b.slowSecPerKm) / 2;
    };
    const order = (["recovery", "easy", "long", "steady", "tempo", "threshold", "interval"] as const).map(mid);
    expect([...order].sort((a, b) => b - a)).toEqual(order);
  });

  it("gives by feel, strides and hills no band", () => {
    expect(paceBandFor("by_feel", 289)).toBeNull();
    expect(paceBandFor("strides", 289)).toBeNull();
    expect(paceBandFor("hills", 289)).toBeNull();
  });

  it("race pace is the threshold scaled to the race's distance, none without one", () => {
    expect(paceBandFor("race", 289)).toBeNull();
    // A 10K at a 289 s/km threshold (about 12.46 km in an hour): Riegel's curve, eight seconds wide.
    expect(paceBandFor("race", 289, { distanceM: 10000 })).toEqual({ fastSecPerKm: 285, slowSecPerKm: 293 });
    expect(paceBandFor("race", 289, { distanceM: 42195 })!.fastSecPerKm).toBeGreaterThan(300);
    expect(paceBandFor("race", null, { distanceM: 10000 })).toBeNull();
  });
});

describe("conversionPaceFor — a distance's time on the watch", () => {
  it("is the band's middle when the effort has one", () => {
    expect(conversionPaceFor("easy", 289)).toBe(379);
    expect(conversionPaceFor("threshold", 289)).toBe(301);
  });
  it("borrows the nearest effort's band for one without its own", () => {
    expect(conversionPaceFor("strides", 289)).toBe(conversionPaceFor("interval", 289));
    expect(conversionPaceFor("hills", 289)).toBe(conversionPaceFor("threshold", 289));
    expect(conversionPaceFor("by_feel", 289)).toBe(conversionPaceFor("easy", 289));
    expect(conversionPaceFor("race", 289)).toBe(conversionPaceFor("threshold", 289));
    expect(conversionPaceFor("race", 289, { distanceM: 10000 })).toBe(289);
  });
  it("is null with no threshold to read", () => {
    expect(conversionPaceFor("easy", null)).toBeNull();
    expect(conversionPaceFor("strides", undefined)).toBeNull();
  });
});
