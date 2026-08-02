import { describe, expect, it } from "vitest";
import { lightingFor, moonPhase, type LightingInputs } from "../src/lighting";
import { hexToRgb } from "../src/color";

const HEX = /^#[0-9a-f]{6}$/;

function inputs(extra: Partial<LightingInputs> = {}): LightingInputs {
  return {
    hour: 13,
    season: "summer",
    weather: "soft_sun",
    moisture: 0.7,
    inComeback: false,
    restMode: false,
    ...extra,
  };
}

describe("lightingFor — periods and interpolation", () => {
  it("is deterministic", () => {
    expect(lightingFor(inputs())).toEqual(lightingFor(inputs()));
  });

  it("returns valid hex colors and clamped numerics at every hour", () => {
    for (let h = 0; h <= 24; h += 0.5) {
      const l = lightingFor(inputs({ hour: h }));
      for (const c of [l.skyTop, l.skyMid, l.skyHorizon, l.sunColor, l.ambient, l.grassNear, l.grassFar, l.soil, l.hill, l.hazeColor, l.cloudColor, l.moteColor, l.foliageTint]) {
        expect(c).toMatch(HEX);
      }
      expect(l.ambientStrength).toBeGreaterThanOrEqual(0);
      expect(l.ambientStrength).toBeLessThanOrEqual(0.45);
      expect(l.shadowOpacity).toBeGreaterThanOrEqual(0);
      expect(l.shadowOpacity).toBeLessThanOrEqual(0.16);
      expect(l.swayAmpDeg).toBeGreaterThanOrEqual(0);
      expect(l.swayAmpDeg).toBeLessThanOrEqual(1.5);
      expect(l.beamStrength).toBeGreaterThanOrEqual(0);
      expect(l.beamStrength).toBeLessThanOrEqual(1);
    }
  });

  it("is continuous across period boundaries (no palette jumps)", () => {
    for (let h = 0; h < 24; h += 0.1) {
      const a = lightingFor(inputs({ hour: h }));
      const b = lightingFor(inputs({ hour: h + 0.1 }));
      expect(Math.abs(a.ambientStrength - b.ambientStrength)).toBeLessThan(0.08);
      expect(Math.abs(a.shadowLen - b.shadowLen)).toBeLessThan(0.35);
      expect(Math.abs(a.beamStrength - b.beamStrength)).toBeLessThan(0.2);
    }
  });

  it("night has stars and a moon, midday has a sun and no stars", () => {
    const night = lightingFor(inputs({ hour: 23.5 }));
    expect(night.period).toBe("night");
    expect(night.starDensity).toBeGreaterThan(0.8);
    expect(night.sunX).toBeNull();
    expect(night.moonX).not.toBeNull();

    const midday = lightingFor(inputs({ hour: 13 }));
    expect(midday.period).toBe("midday");
    expect(midday.starDensity).toBe(0);
    expect(midday.sunX).not.toBeNull();
    expect(midday.moonX).toBeNull();
  });

  it("night land is darker than midday land (dusked down with the stars)", () => {
    const sum = (hex: string) => hexToRgb(hex).reduce((a, b) => a + b, 0);
    const night = lightingFor(inputs({ hour: 23.5 }));
    const midday = lightingFor(inputs({ hour: 13 }));
    expect(sum(night.grassNear)).toBeLessThan(sum(midday.grassNear));
  });

  it("golden-hour shadows are longer than midday shadows", () => {
    const midday = lightingFor(inputs({ hour: 13 }));
    const golden = lightingFor(inputs({ hour: 18.9 })); // summer sunset 19.9 − 1.2
    expect(golden.period).toBe("golden");
    expect(golden.shadowLen).toBeGreaterThan(midday.shadowLen);
  });

  it("winter daylight is shorter than summer daylight", () => {
    // 07:00 is day in summer, still night in winter.
    expect(lightingFor(inputs({ hour: 7, season: "summer" })).sunX).not.toBeNull();
    expect(lightingFor(inputs({ hour: 7, season: "winter" })).sunX).toBeNull();
  });

  it("wetter gardens have greener grass", () => {
    const dry = lightingFor(inputs({ moisture: 0.1 }));
    const wet = lightingFor(inputs({ moisture: 0.9 }));
    expect(dry.grassNear).not.toBe(wet.grassNear);
  });
});

describe("moonPhase", () => {
  it("is in [0,1) and deterministic", () => {
    const p = moonPhase("2026-08-02");
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(1);
    expect(moonPhase("2026-08-02")).toBe(p);
  });

  it("moves ~0.034 per day", () => {
    const a = moonPhase("2026-08-02");
    const b = moonPhase("2026-08-03");
    const d = Math.abs(b - a);
    expect(Math.min(d, 1 - d)).toBeCloseTo(1 / 29.5306, 2);
  });
});

describe("lightingFor — season and weather composition", () => {
  it("every weather × season × sample hour yields valid colors", () => {
    const weathers = ["fresh_rain", "clear_sun", "light_clouds", "dry_spell", "mild_drought", "recovery_rain", "seasonal_breeze", "soft_sun"] as const;
    const seasons = ["spring", "summer", "autumn", "winter"] as const;
    for (const weather of weathers) {
      for (const season of seasons) {
        for (const hour of [2, 6.5, 9, 13, 17.5, 20.5]) {
          const l = lightingFor(inputs({ weather, season, hour }));
          expect(l.skyTop).toMatch(HEX);
          expect(l.grassNear).toMatch(HEX);
          expect(l.swayAmpDeg).toBeLessThanOrEqual(1.5);
          expect(l.meadowAccents.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("weather signatures are distinct", () => {
    const at = (weather: LightingInputs["weather"]) => lightingFor(inputs({ weather }));
    expect(at("seasonal_breeze").swayAmpDeg).toBeGreaterThan(at("soft_sun").swayAmpDeg);
    expect(at("mild_drought").swayAmpDeg).toBeLessThan(at("soft_sun").swayAmpDeg);
    expect(at("dry_spell").cloudShape).toBe("wisp");
    expect(at("light_clouds").cloudCount).toBeGreaterThan(at("clear_sun").cloudCount);
    expect(at("fresh_rain").skyTop).not.toBe(at("clear_sun").skyTop);
  });

  it("seasons shift the meadow accents", () => {
    const spring = lightingFor(inputs({ season: "spring" }));
    const autumn = lightingFor(inputs({ season: "autumn" }));
    expect(spring.meadowAccents).not.toEqual(autumn.meadowAccents);
  });

  it("rainbow appears only for recovery_rain + inComeback + low sun", () => {
    const golden = { hour: 18.9, weather: "recovery_rain" as const };
    expect(lightingFor(inputs({ ...golden, inComeback: true })).rainbow).toBe(true);
    expect(lightingFor(inputs({ ...golden, inComeback: false })).rainbow).toBe(false);
    expect(lightingFor(inputs({ hour: 13, weather: "recovery_rain", inComeback: true })).rainbow).toBe(false);
    expect(lightingFor(inputs({ ...golden, weather: "fresh_rain", inComeback: true })).rainbow).toBe(false);
  });

  it("restMode becalms motion and light", () => {
    const on = lightingFor(inputs({ restMode: true }));
    const off = lightingFor(inputs({ restMode: false }));
    expect(on.swayAmpDeg).toBeLessThan(off.swayAmpDeg);
    expect(on.beamStrength).toBeLessThanOrEqual(off.beamStrength);
  });
});
