import type { GardenPlant, GardenPosition } from "@rg/domain";
import { rng } from "./prng.js";
import type { Species } from "./species.js";

/**
 * Deterministic scene placement with collision avoidance. Positions are chosen
 * once at planting time (seeded by plant id) and stored forever; layout is
 * never recomputed on render.
 *
 * The scene is a 0..1 × 0..1 field. The garden starts in the center band and
 * expands outward into fixed region bands as it grows.
 */
export const REGION_BANDS: Array<[number, number]> = [
  [0.32, 0.68],
  [0.14, 0.34],
  [0.66, 0.86],
  [0.02, 0.16],
  [0.84, 0.98],
  [0.2, 0.8], // final region: dense understory across the middle
];

export function choosePosition(
  plantId: string,
  species: Species,
  existing: GardenPlant[],
  unlockedRegions: number,
): GardenPosition {
  const rand = rng(`pos:${plantId}`);
  const usable = Math.min(unlockedRegions, REGION_BANDS.length);

  // Prefer the least-crowded unlocked region (ties → lowest index).
  const counts = new Array(usable).fill(0);
  for (const p of existing) {
    if (p.state !== "dead" && p.position.region < usable) counts[p.position.region]++;
  }
  const regionOrder = [...counts.keys()].sort((a, b) => counts[a]! - counts[b]! || a - b);

  for (const region of regionOrder) {
    const [x0, x1] = REGION_BANDS[region]!;
    const [y0, y1] = species.depthBand;
    for (let attempt = 0; attempt < 14; attempt++) {
      const x = x0 + rand() * (x1 - x0);
      const y = y0 + rand() * (y1 - y0);
      const collides = existing.some((p) => {
        if (p.state === "dead" && p.habitatRole == null) return false;
        const dx = p.position.x - x;
        const dy = (p.position.y - y) * 0.6; // depth counts less than lateral distance
        const minDist = species.spacing * 0.9;
        return dx * dx + dy * dy < minDist * minDist;
      });
      if (!collides) return { x, y, region };
    }
  }

  // Dense garden: accept a softly-jittered spot in the fullest allowed region.
  const region = regionOrder[regionOrder.length - 1] ?? 0;
  const [x0, x1] = REGION_BANDS[region]!;
  const [y0, y1] = species.depthBand;
  return { x: x0 + rand() * (x1 - x0), y: y0 + rand() * (y1 - y0), region };
}

/** Vines climb the mature tree that has the fewest vines already. */
export function chooseHostTree(plants: GardenPlant[]): GardenPlant | undefined {
  const trees = plants.filter(
    (p) => p.category === "tree" && p.state !== "dead" && p.maturity >= 0.6,
  );
  if (trees.length === 0) return undefined;
  const vineCount = new Map<string, number>();
  for (const p of plants) {
    if (p.category === "vine" && p.hostPlantId) {
      vineCount.set(p.hostPlantId, (vineCount.get(p.hostPlantId) ?? 0) + 1);
    }
  }
  return [...trees].sort(
    (a, b) => (vineCount.get(a.id) ?? 0) - (vineCount.get(b.id) ?? 0) || a.id.localeCompare(b.id),
  )[0];
}

/** Fungi that need dead wood attach to a dead plant acting as habitat. */
export function chooseDeadWoodHost(plants: GardenPlant[]): GardenPlant | undefined {
  return plants
    .filter((p) => p.state === "dead" && p.habitatRole != null)
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}
