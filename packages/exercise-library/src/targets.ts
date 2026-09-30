import type { FormatId, Mode, Pattern } from "./vocab.js";

// Core families, weekly exposure targets, and mode limits. Condition-specific caps and care targets
// live in the condition profiles.

export interface CoreFamily {
  id: string;
  label: string;
  patterns: readonly Pattern[];
}

/** Core families are tag queries: a core-role exercise with one of these patterns. */
export const CORE_FAMILIES: readonly CoreFamily[] = [
  { id: "squat", label: "Squat", patterns: ["squat", "lunge"] },
  { id: "hinge", label: "Hinge", patterns: ["hinge"] },
  { id: "row", label: "Row", patterns: ["pull-h"] },
  { id: "press", label: "Press", patterns: ["push-h", "push-v"] },
  { id: "carry", label: "Carry", patterns: ["carry", "anti-lateral"] },
];

export interface CoverageTargets {
  patterns: Readonly<Record<string, number>>;
  regions: Readonly<Record<string, number>>;
}

/** Exposures wanted per trailing 7 days (one per exercise per session). Care targets are added per profile. */
export const COVERAGE_TARGETS: CoverageTargets = {
  patterns: { squat: 2, lunge: 1, hinge: 2, "pull-h": 2, "push-h": 1, carry: 2, "anti-lateral": 1, "anti-rotate": 1, "anti-extend": 1, rotate: 2, mobility: 4, breathe: 4, release: 2 },
  regions: { neck: 3, thoracic: 3, hips: 3, "upper-back": 2, glutes: 2, hamstrings: 2, shoulders: 2, core: 2, ankles: 1, quads: 2 },
};

export interface ModeSpec {
  label: string;
  maxDifficulty: number;
  /** Whether externally loaded moves may appear at all in this mode. */
  allowExternalLoad: boolean;
  /** [min, max] core lifts per session. */
  coreCount: readonly [number, number];
  progression: "none" | "small" | "full";
  formats: readonly FormatId[];
}

export const MODES: Readonly<Record<Mode, ModeSpec>> = {
  recovery: { label: "Recovery", maxDifficulty: 2, allowExternalLoad: false, coreCount: [0, 0], progression: "none", formats: ["flow", "holds"] },
  consistent: { label: "Consistent", maxDifficulty: 4, allowExternalLoad: true, coreCount: [2, 2], progression: "small", formats: ["straight", "superset", "flow", "holds"] },
  build: { label: "Build", maxDifficulty: 5, allowExternalLoad: true, coreCount: [2, 3], progression: "full", formats: ["straight", "superset", "circuit", "ladder", "flow", "holds"] },
};
