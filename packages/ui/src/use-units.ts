import { useQuery } from "@tanstack/react-query";
import { api } from "@rg/api-client";
import type { Units } from "./components.js";

/** The athlete's display-unit preference, shared-cache with Settings.
 * Every screen that renders a distance or pace reads it through this one
 * hook — that's the consistency guarantee (units sweep 2026-08-14). */
export function useUnits(): Units {
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings, staleTime: 60_000 });
  return settings.data?.prefs.units ?? "km";
}
