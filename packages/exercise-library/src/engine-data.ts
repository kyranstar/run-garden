import { profileById } from "./conditions/index.js";
import type { ConditionProfile } from "./conditions/types.js";
import { FORMATS, type Format } from "./formats.js";
import type { ExerciseRecord } from "./record.js";
import { composeSkeleton, type SkeletonSpec } from "./skeletons.js";
import { CORE_FAMILIES, COVERAGE_TARGETS, MODES, type CoreFamily, type CoverageTargets, type ModeSpec } from "./targets.js";
import { THEMES, type Theme } from "./themes.js";
import type { Mode } from "./vocab.js";

// Everything the session engine reads, passed explicitly (the standalone tool read a global registry).
// Built once per build from the person's active and cared-for condition profiles.

export interface EngineData {
  exercises: readonly ExerciseRecord[];
  formats: readonly Format[];
  themes: readonly Theme[];
  coreFamilies: readonly CoreFamily[];
  /** Base targets ∪ the care targets of cared-for profiles. */
  targets: CoverageTargets;
  modes: Readonly<Record<Mode, ModeSpec>>;
  /** Composed for the cared-for profiles (Phase 1 spec §4.4). */
  skeleton: SkeletonSpec;
  profiles: {
    /** Rules apply everywhere while a profile is active. */
    active: readonly ConditionProfile[];
    /** Care content (block, targets, themes) for the profiles this program cares for. */
    care: readonly ConditionProfile[];
  };
}

export interface MakeEngineDataOptions {
  activeProfiles: readonly string[];
  careProfiles: readonly string[];
  exercises: readonly ExerciseRecord[];
}

/** Union of two target maps; a key in both keeps the larger target. Care keys come first. */
function mergeTargets(base: Readonly<Record<string, number>>, extra: Readonly<Record<string, number>> | undefined): Record<string, number> {
  const out: Record<string, number> = { ...(extra ?? {}) };
  for (const [k, v] of Object.entries(base)) out[k] = Math.max(out[k] ?? 0, v);
  return out;
}

export function makeEngineData({ activeProfiles, careProfiles, exercises }: MakeEngineDataOptions): EngineData {
  const active = [...new Set(activeProfiles)].map(profileById);
  const care = [...new Set(careProfiles)].map(profileById);
  // Care content without the profile's rules would plan care moves with none of its limits.
  for (const p of care) {
    if (!active.includes(p)) throw new Error(`The program cares for condition profile "${p.id}", which isn't active: activate it first.`);
  }
  const skeleton = composeSkeleton(care);   // throws for more than one cared-for profile
  const careIds = new Set(care.map(p => p.id));
  let targets: CoverageTargets = { patterns: { ...COVERAGE_TARGETS.patterns }, regions: { ...COVERAGE_TARGETS.regions } };
  for (const p of care) {
    const t = p.care?.coverageTargets ?? {};
    targets = { patterns: mergeTargets(targets.patterns, t.patterns), regions: mergeTargets(targets.regions, t.regions) };
  }
  return {
    exercises,
    formats: FORMATS,
    themes: THEMES.filter(t => !t.profile || careIds.has(t.profile)),
    coreFamilies: CORE_FAMILIES,
    targets,
    modes: MODES,
    skeleton,
    profiles: { active, care },
  };
}
