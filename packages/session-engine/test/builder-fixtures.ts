import { LOCATION_PRESETS, type Mode, type Theme } from "@rg/exercise-library";
import { Blocks, type BuildInput, type EngineLocation } from "../src/index.js";
import { realData } from "./fixtures.js";

// Shared setup for the tests that build real sessions from the real library (TMJ active and cared for),
// as the standalone builder, formats and recorder tests did.

export const data = realData();

/** A library preset as a place: its gear and no implement weights (presets never carry weights). */
export const place = (id: string): EngineLocation => {
  const p = LOCATION_PRESETS.find(l => l.id === id)!;
  return { id: p.id, name: p.name, equipment: p.equipment, implements: {} };
};
export const PLACES = LOCATION_PRESETS.map(p => place(p.id));
export const home = place("home");
export const gym = place("gym");

export const block = Blocks.ensure(data, null, { today: "2026-09-15", equipment: home.equipment, prefs: {}, weeks: 5, sessions: [] }).block;
export const themeFor = (mode: Mode): Theme => data.themes.find(t => t.modes.includes(mode))!;
export const themeById = (id: string): Theme => data.themes.find(t => t.id === id)!;
/** A made-up theme that prefers the given formats. */
export const themed = (formats: Theme["formats"], modes: Theme["modes"] = ["build"]): Theme =>
  ({ id: `t-${formats.join("-")}`, name: "Test", blurb: "", modes, emphasis: { patterns: {}, regions: {} }, formats, coreBias: [] });

/** Today's check for the TMJ profile (the standalone `pre`). */
export const checksFor = (pre: number | null) => ({ tmj: { pre, post: null, feelingOff: false } });

export type InputOverrides = Partial<BuildInput> & { pre?: number | null };

export function makeInput(defaults: Partial<BuildInput>) {
  return (o: InputOverrides = {}): BuildInput => {
    const { pre = 1, ...rest } = o;
    return {
      today: "2026-09-29", mode: "consistent", theme: themeById("hipsPosture"), minutes: 30, location: home, unit: "lb",
      sessions: [], prefs: {}, block, checks: checksFor(pre), swaps: {},
      ...defaults,
      ...rest,
    };
  };
}
