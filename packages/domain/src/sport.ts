/**
 * The canonical sport registry: every COROS activity code the app admits, its
 * stored `sport` id, UI label, and whether it counts as an "adventure" — a
 * sport the garden welcomes but never demands. The three disciplines
 * (run/strength/yoga) are the only sports with decay clocks; everything else
 * is adventure-flagged and the effort threshold (garden-engine) is the gate,
 * not the sport.
 *
 * Ids are stored in activities.sport — existing values (run, strength, yoga,
 * ski) must never change. Codes from docs/research/coros-community-clients.md
 * §7.4.
 */
export interface SportDef {
  id: string;
  label: string;
  corosCodes: number[];
  adventure: boolean;
}

export const SPORTS: readonly SportDef[] = [
  { id: "run", label: "Run", corosCodes: [100, 101, 102, 103], adventure: false },
  { id: "strength", label: "Strength", corosCodes: [402], adventure: false },
  { id: "yoga", label: "Yoga", corosCodes: [403, 904], adventure: false },
  { id: "hike", label: "Hike", corosCodes: [104, 105], adventure: true },
  { id: "climb", label: "Climb", corosCodes: [106, 800, 801, 802, 10003], adventure: true },
  { id: "bike", label: "Ride", corosCodes: [200, 201, 202, 203, 204, 205, 299, 9807], adventure: true },
  { id: "swim", label: "Swim", corosCodes: [300, 301], adventure: true },
  { id: "cardio", label: "Cardio", corosCodes: [400, 401], adventure: true },
  { id: "ski", label: "Ski", corosCodes: [500], adventure: true },
  { id: "snowboard", label: "Snowboard", corosCodes: [501], adventure: true },
  { id: "xc-ski", label: "XC Ski", corosCodes: [502], adventure: true },
  { id: "ski-touring", label: "Ski Touring", corosCodes: [503, 10002], adventure: true },
  { id: "row", label: "Row", corosCodes: [700, 701], adventure: true },
  { id: "paddle", label: "Paddle", corosCodes: [702, 704], adventure: true },
  { id: "windsurf", label: "Windsurf", corosCodes: [705, 706], adventure: true },
  { id: "walk", label: "Walk", corosCodes: [900], adventure: true },
  { id: "jump-rope", label: "Jump Rope", corosCodes: [901], adventure: true },
  { id: "stairs", label: "Stairs", corosCodes: [902], adventure: true },
  { id: "elliptical", label: "Elliptical", corosCodes: [903], adventure: true },
  { id: "triathlon", label: "Triathlon", corosCodes: [10000], adventure: true },
  { id: "multisport", label: "Multisport", corosCodes: [10001], adventure: true },
  { id: "custom", label: "Custom", corosCodes: [98], adventure: true },
  { id: "other", label: "Other", corosCodes: [], adventure: true },
] as const;

export const SPORT_BY_ID: ReadonlyMap<string, SportDef> = new Map(SPORTS.map((s) => [s.id, s]));

const BY_CODE: ReadonlyMap<number, string> = new Map(
  SPORTS.flatMap((s) => s.corosCodes.map((c) => [c, s.id] as const)),
);

/** Stored `sport` id for a COROS activity sportType. Total — unknown → "other". */
export function sportIdForCorosCode(code: number): string {
  const hit = BY_CODE.get(code);
  if (hit) return hit;
  if (code >= 200 && code < 300) return "bike";
  if (code >= 300 && code < 400) return "swim";
  return "other";
}

/** UI label for a sport id; unknown ids get a capitalized fallback, never crash. */
export function sportLabel(id: string): string {
  return SPORT_BY_ID.get(id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** Adventure = any sport that is not one of the three disciplines. */
export function isAdventureSport(id: string): boolean {
  return SPORT_BY_ID.get(id)?.adventure ?? (id !== "run" && id !== "strength" && id !== "yoga");
}
