/**
 * The body map's words (the new shape §7), pure: what carried the period, the area gone quiet, the request the quiet
 * area's button writes for the coach, and each area's facts — plain words, never a colour alone.
 */
import type { BodyArea, BodyAreaExposure, BodyAreaLevel, GrowthBodyDto, GrowthPeriod } from "@rg/domain";

export const AREA_LABEL: Record<BodyArea, string> = {
  neck: "Neck",
  shoulders: "Shoulders",
  chest: "Chest",
  arms: "Arms",
  back: "Back",
  core: "Core",
  hips: "Hips",
  glutes: "Glutes",
  quads: "Quads",
  hamstrings: "Hamstrings",
  calves: "Calves",
};

/** How much an area was worked, in words (the legend's and each area's). */
export const LEVEL_WORD: Record<BodyAreaLevel, string> = { 0: "Not worked", 1: "A little", 2: "Steadily", 3: "A lot" };

const lower = (a: BodyArea): string => AREA_LABEL[a].toLowerCase();
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** Nothing at all logged in the period. */
export const nothingLogged = (b: Pick<GrowthBodyDto, "sessions" | "runs" | "other">): boolean => b.sessions === 0 && b.runs === 0 && b.other === 0;

/** "Core and hips carried the month." — or, with nothing logged, "Nothing logged this month."; null when only other sports were. */
export function carriedLine(b: Pick<GrowthBodyDto, "carried" | "sessions" | "runs" | "other">, period: GrowthPeriod): string | null {
  if (nothingLogged(b)) return `Nothing logged this ${period}.`;
  if (b.carried.length === 0) return null;
  return `${cap(b.carried.map(lower).join(" and "))} carried the ${period}.`;
}

/** "Hips quiet for 6 days." — or "Hips quiet all month." for an area not worked at all in it. */
export function quietLine(q: GrowthBodyDto["quiet"], period: GrowthPeriod): string | null {
  if (!q) return null;
  return q.daysAgo === null ? `${AREA_LABEL[q.area]} quiet all ${period}.` : `${AREA_LABEL[q.area]} quiet for ${q.daysAgo} days.`;
}

/** The words the quiet area's button writes in the coach's box: the athlete's to send. */
export const quietRequest = (area: BodyArea): string => `15 minutes for my ${lower(area)}`;

/** An area's facts: "12 sets · 3 runs", "3 runs", "Not worked". */
export function areaFacts(a: Pick<BodyAreaExposure, "sets" | "runs">): string {
  const sets = Math.round(a.sets);
  const parts = [sets > 0 ? `${sets} ${sets === 1 ? "set" : "sets"}` : null, a.runs > 0 ? `${a.runs} ${a.runs === 1 ? "run" : "runs"}` : null].filter(
    (p): p is string => p !== null,
  );
  return parts.length ? parts.join(" · ") : LEVEL_WORD[0];
}

/** The figure's name for a screen reader: each level's areas, most first ("Worked a lot: core. Steadily: quads, calves. …"). */
export function figureLabel(areas: readonly BodyAreaExposure[]): string {
  const at = (l: BodyAreaLevel) => areas.filter((a) => a.level === l).map((a) => lower(a.area));
  const parts = ([3, 2, 1] as const).flatMap((l) => {
    const names = at(l);
    return names.length ? [`${LEVEL_WORD[l]}: ${names.join(", ")}.`] : [];
  });
  return parts.length ? `Body map. ${parts.join(" ")}` : "Body map. Nothing worked yet.";
}
