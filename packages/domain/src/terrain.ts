/**
 * Terrain awareness (2026-08-14): how hilly the athlete's running actually
 * is, against how hilly the race will be. Every figure is measured — climb
 * per kilometre from stored activities, and the race's own published climb —
 * so nothing here is an opinion about difficulty.
 */

export type CourseProfile = "flat" | "rolling" | "hilly";

/** Typical climb per km for each named profile, used ONLY when the athlete
 * picks a category without knowing the race's total climb. Ranges are the
 * conventional ones race directors use, taken at their midpoint. */
export const PROFILE_METRES_PER_KM: Record<CourseProfile, number> = {
  flat: 4,
  rolling: 12,
  hilly: 25,
};

export interface TerrainComparison {
  /** The athlete's recent climb per km. */
  recentMetresPerKm: number;
  /** What the race asks for. */
  raceMetresPerKm: number;
  /** race ÷ recent, capped for display sanity. Null when recent is ~0. */
  ratio: number | null;
  /** How the two relate, in the honest middle band nothing is flagged. */
  verdict: "under_prepared" | "matched" | "over_prepared";
}

/** Below this, climb differences are noise rather than terrain. */
const FLAT_FLOOR_METRES_PER_KM = 1.5;
/** The race must ask for meaningfully more before we say "under-prepared". */
const UNDER_RATIO = 1.5;
const OVER_RATIO = 0.6;

export function metresPerKm(climbMetres: number, distanceMetres: number): number | null {
  if (!Number.isFinite(climbMetres) || !Number.isFinite(distanceMetres) || distanceMetres < 500) {
    return null;
  }
  return climbMetres / (distanceMetres / 1000);
}

/**
 * The race's climb per km from whatever the athlete told us: an explicit
 * total climb wins over the category, because it is a real number about a
 * real course.
 */
export function raceMetresPerKm(
  climbMetres: number | null | undefined,
  profile: CourseProfile | null | undefined,
  distanceKm: number | null | undefined,
): number | null {
  if (climbMetres != null && distanceKm != null && distanceKm > 0 && Number.isFinite(climbMetres)) {
    return climbMetres / distanceKm;
  }
  if (profile) return PROFILE_METRES_PER_KM[profile];
  return null;
}

export function compareTerrain(
  recentMetresPerKm: number | null,
  raceMPK: number | null,
): TerrainComparison | null {
  if (recentMetresPerKm == null || raceMPK == null) return null;
  // Two flat things are matched, however their ratio behaves.
  if (recentMetresPerKm < FLAT_FLOOR_METRES_PER_KM && raceMPK < FLAT_FLOOR_METRES_PER_KM) {
    return { recentMetresPerKm, raceMetresPerKm: raceMPK, ratio: null, verdict: "matched" };
  }
  const ratio =
    recentMetresPerKm < FLAT_FLOOR_METRES_PER_KM
      ? null
      : Math.round((raceMPK / recentMetresPerKm) * 10) / 10;
  const verdict =
    ratio === null
      ? // Training on the flat for a course that climbs is the clearest
        // version of under-prepared there is.
        raceMPK >= FLAT_FLOOR_METRES_PER_KM
        ? ("under_prepared" as const)
        : ("matched" as const)
      : ratio >= UNDER_RATIO
        ? ("under_prepared" as const)
        : ratio <= OVER_RATIO
          ? ("over_prepared" as const)
          : ("matched" as const);
  return { recentMetresPerKm, raceMetresPerKm: raceMPK, ratio, verdict };
}
