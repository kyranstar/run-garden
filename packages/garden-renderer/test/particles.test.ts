import { describe, expect, it } from "vitest";
import { activeSystems, atmosphereKey, initSystem, sampleSystem, type GateInputs, type SystemKind } from "../src/particles";

const gate = (extra: Partial<GateInputs> = {}): GateInputs => ({
  weather: "soft_sun",
  period: "midday",
  fireflies: false,
  hasFlowering: true,
  ...extra,
});

describe("activeSystems", () => {
  it("gust fringe is always on; airborne systems are gated", () => {
    expect(activeSystems(gate())).toContain("gustFringe");
    expect(activeSystems(gate({ weather: "fresh_rain" }))).toContain("rainSplash");
    expect(activeSystems(gate())).not.toContain("rainSplash");
    expect(activeSystems(gate({ weather: "soft_sun", period: "morning" }))).toContain("pollen");
    expect(activeSystems(gate({ weather: "soft_sun", period: "night" }))).not.toContain("pollen");
    expect(activeSystems(gate({ weather: "dry_spell", period: "midday" }))).toContain("pollen");
    expect(activeSystems(gate({ weather: "dry_spell", period: "night" }))).not.toContain("pollen");
    expect(activeSystems(gate({ period: "dawn" }))).toContain("mist");
    expect(activeSystems(gate({ weather: "light_clouds" }))).toContain("cloudShadow");
    expect(activeSystems(gate({ period: "night", fireflies: true }))).toContain("fireflyGlow");
    expect(activeSystems(gate({ period: "night", fireflies: false }))).not.toContain("fireflyGlow");
    expect(activeSystems(gate({ weather: "seasonal_breeze" }))).toContain("petals");
    expect(activeSystems(gate({ weather: "seasonal_breeze", hasFlowering: false }))).not.toContain("petals");
    expect(activeSystems(gate({ weather: "mild_drought", period: "midday" }))).toContain("shimmer");
    expect(activeSystems(gate({ weather: "mild_drought", period: "golden" }))).not.toContain("shimmer");
  });

  it("airborne particle budget never exceeds 120", () => {
    const AIRBORNE: SystemKind[] = ["rainSplash", "pollen", "petals", "shimmer", "mist", "fireflyGlow"];
    const weathers = ["fresh_rain", "clear_sun", "light_clouds", "dry_spell", "mild_drought", "recovery_rain", "seasonal_breeze", "soft_sun"] as const;
    const periods = ["night", "dawn", "morning", "midday", "golden", "dusk"] as const;
    for (const weather of weathers) {
      for (const period of periods) {
        const active = activeSystems({ weather, period, fireflies: true, hasFlowering: true });
        const total = active
          .filter((k) => AIRBORNE.includes(k))
          .reduce((sum, k) => sum + initSystem(k, "t").params.length, 0);
        expect(total).toBeLessThanOrEqual(120);
      }
    }
  });
});

describe("systems are deterministic, analytic, and bounded", () => {
  const kinds: SystemKind[] = ["pollen", "mist", "cloudShadow", "gustFringe"];
  for (const kind of kinds) {
    it(`${kind}: same key + t → same sprites; bounded`, () => {
      const a = initSystem(kind, "seed:x");
      const b = initSystem(kind, "seed:x");
      expect(a.params).toEqual(b.params);
      const s1 = sampleSystem(a, 12.34);
      const s2 = sampleSystem(b, 12.34);
      expect(s1).toEqual(s2);
      for (const s of s1) {
        expect(s.x).toBeGreaterThan(-0.4);
        expect(s.x).toBeLessThan(1.7);
        expect(s.y).toBeGreaterThan(-0.3);
        expect(s.y).toBeLessThan(1.3);
        expect(s.alpha).toBeGreaterThanOrEqual(0);
        expect(s.alpha).toBeLessThanOrEqual(0.35);
      }
      // Analytic: sampling t=5 then t=2 equals sampling t=2 fresh.
      expect(sampleSystem(a, 2)).toEqual(sampleSystem(initSystem(kind, "seed:x"), 2));
    });
  }

  it("gustFringe has ≤ 180 blades; airborne systems have their spec counts", () => {
    expect(initSystem("gustFringe", "k").params.length).toBeLessThanOrEqual(180);
    expect(initSystem("pollen", "k").params.length).toBe(40);
    expect(initSystem("mist", "k").params.length).toBe(3);
    expect(initSystem("cloudShadow", "k").params.length).toBe(2);
  });
});

describe("weather-signature systems", () => {
  const kinds: SystemKind[] = ["rainSplash", "petals", "shimmer", "fireflyGlow"];
  for (const kind of kinds) {
    it(`${kind}: deterministic, analytic, bounded`, () => {
      const sys = initSystem(kind, "seed:y");
      const s1 = sampleSystem(sys, 7.7);
      expect(s1).toEqual(sampleSystem(initSystem(kind, "seed:y"), 7.7));
      for (const s of s1) {
        expect(s.alpha).toBeLessThanOrEqual(0.35);
        expect(s.x).toBeGreaterThan(-0.4);
        expect(s.x).toBeLessThan(1.7);
      }
    });
  }

  it("rain splash rings expand and fade over their cycle", () => {
    const sys = initSystem("rainSplash", "z");
    const early = sampleSystem(sys, 0.05)[0]!;
    const later = sampleSystem(sys, 0.4)[0]!;
    // Not asserting exact values — only that size and alpha both change.
    expect(early.size).not.toBe(later.size);
    expect(early.alpha).not.toBe(later.alpha);
  });
});

describe("atmosphereKey", () => {
  it("identical inputs produce identical keys", () => {
    expect(atmosphereKey(gate())).toBe(atmosphereKey(gate()));
  });

  it("changing any one field changes the key", () => {
    const base = atmosphereKey(gate());
    expect(atmosphereKey(gate({ weather: "fresh_rain" }))).not.toBe(base);
    expect(atmosphereKey(gate({ period: "night" }))).not.toBe(base);
    expect(atmosphereKey(gate({ fireflies: true }))).not.toBe(base);
    expect(atmosphereKey(gate({ hasFlowering: false }))).not.toBe(base);
  });
});
