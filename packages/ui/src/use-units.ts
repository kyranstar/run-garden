import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import type { WeightUnit } from "@rg/domain";
import type { Units } from "./components.js";

/** The athlete's display-unit preference, shared-cache with Settings.
 * Every screen that renders a distance or pace reads it through this one
 * hook — that's the consistency guarantee (units sweep 2026-08-14). */
export function useUnits(): Units {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  return settings.data?.prefs.units ?? "km";
}

/** The athlete's weight unit (Settings → Units → Weights), from the same shared cache. Plan prescriptions stay in
 * kilograms; screens convert them for display with the domain's weight helpers (Audit 2c-A MINOR-5). Until the
 * settings have loaded it is kilograms — the plan's own unit, so nothing is converted on a guess. */
export function useWeightUnit(): WeightUnit {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  return settings.data?.prefs.weightUnit ?? "kg";
}
