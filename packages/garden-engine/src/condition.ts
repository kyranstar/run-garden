import type { GardenConditionWord, GardenSeason, GardenWeatherState, LocalDate } from "@rg/domain";
import type { EngineGardenState, GardenConfig } from "./types.js";
import { roll } from "./prng.js";

export function seasonOf(date: LocalDate): GardenSeason {
  const month = Number(date.slice(5, 7));
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

/** Weather is a metaphor for recent consistency, never real meteorology. */
export function deriveWeather(
  state: EngineGardenState,
  cfg: GardenConfig,
  ranToday: boolean,
  restedToday: boolean,
  comebackToday: boolean,
  date: LocalDate,
): GardenWeatherState {
  if (comebackToday) return "recovery_rain";
  if (ranToday) return "fresh_rain";
  if (state.restMode) return "soft_sun";
  if (restedToday) return "soft_sun";
  const d = state.daysSinceCompletedRun;
  if (d >= cfg.droughtStartDays) return "mild_drought";
  if (d >= cfg.drynessStartDays) return roll(`wx:${date}`) < 0.5 ? "dry_spell" : "light_clouds";
  if (state.inComeback) return "clear_sun";
  return roll(`wx:${date}`) < 0.3 ? "seasonal_breeze" : "clear_sun";
}

/** The word shown in primary UI instead of raw numbers. */
export function conditionWord(state: EngineGardenState, cfg: GardenConfig): GardenConditionWord {
  if (state.restMode) return "dormant";
  const d = state.daysSinceCompletedRun;
  if (d >= cfg.droughtStartDays) return "in_drought";
  if (state.inComeback && d <= 2) return "recovering";
  if (d >= cfg.drynessStartDays) return "a_little_dry";
  if (state.moisture > 0.8 && state.floweringDensity > 0.25) return "flourishing";
  if (state.moisture > 0.55) return "well_watered";
  return "growing";
}
