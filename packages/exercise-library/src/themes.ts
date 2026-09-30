import type { FormatId, Mode } from "./vocab.js";

// Themed sessions: what a session emphasizes, which modes it suits, and its preferred formats.
// A theme with `profile` belongs to that condition profile's care content: it is offered only when a
// program cares for that profile.

export interface ThemeEmphasis {
  patterns?: Readonly<Record<string, number>>;
  regions?: Readonly<Record<string, number>>;
  tags?: Readonly<Record<string, number>>;
}

export interface Theme {
  id: string;
  name: string;
  blurb: string;
  modes: readonly Mode[];
  emphasis: ThemeEmphasis;
  formats: readonly FormatId[];
  /** Core families this theme prefers (ids from CORE_FAMILIES). */
  coreBias: readonly string[];
  /** The condition profile whose care this theme belongs to. */
  profile?: string;
}

export const THEMES: readonly Theme[] = [
  {
    id: "deskUnwind", name: "Desk unwind", blurb: "Undo a day of sitting: open the upper back and hips, quiet the jaw.",
    modes: ["recovery", "consistent", "build"],
    emphasis: { patterns: { mobility: 1, rotate: 1.5, "pull-h": 1 }, regions: { thoracic: 2, hips: 1.5, neck: 1, "upper-back": 1 }, tags: { "desk-relief": 2 } },
    formats: ["flow", "superset"], coreBias: ["row", "hinge"],
  },
  {
    id: "hipsPosture", name: "Hips & posture", blurb: "Open the hips, stack the ribs, squat tall.",
    modes: ["consistent", "build"],
    emphasis: { patterns: { squat: 2, lunge: 1.5, mobility: 1 }, regions: { hips: 2, glutes: 1.5, thoracic: 1 } },
    formats: ["superset", "flow"], coreBias: ["squat", "hinge"],
  },
  {
    id: "upperBackNeck", name: "Upper back & neck", blurb: "Strong mid-back, easy neck: rows, scapular work, and neck relief.",
    modes: ["consistent", "build"],
    emphasis: { patterns: { "pull-h": 2, "push-h": 1, mobility: 1 }, regions: { "upper-back": 2, neck: 1.5, shoulders: 1.5, thoracic: 1 } },
    formats: ["superset", "ladder", "flow"], coreBias: ["row", "press"],
  },
  {
    id: "carryDay", name: "Carry day", blurb: "Walk tall under load: carries and side-bend resistance without clenching.",
    modes: ["consistent", "build"],
    emphasis: { patterns: { carry: 2, "anti-lateral": 2, "anti-rotate": 1.5 }, regions: { core: 2, shoulders: 1, "upper-back": 1 } },
    formats: ["straight", "circuit"], coreBias: ["carry", "hinge"],
  },
  {
    id: "fullBody", name: "Full-body strength", blurb: "A little of everything, done well.",
    modes: ["build"],
    emphasis: { patterns: { squat: 1, hinge: 1, "pull-h": 1, "push-h": 1, carry: 1 }, regions: { "full-body": 1 } },
    formats: ["superset", "circuit", "ladder"], coreBias: ["squat", "row", "press"],
  },
  {
    id: "posteriorChain", name: "Posterior chain", blurb: "Glutes and hamstrings to carry the day's sitting.",
    modes: ["consistent", "build"],
    emphasis: { patterns: { hinge: 2, "anti-extend": 1 }, regions: { glutes: 2, hamstrings: 2, "low-back": 1 } },
    formats: ["superset", "ladder", "flow"], coreBias: ["hinge", "carry"],
  },
  {
    id: "jawReset", name: "Jaw reset + easy flow", blurb: "Down-regulate: jaw, neck, and breath first, gentle movement after.",
    modes: ["recovery"],
    emphasis: { patterns: { breathe: 2, release: 2, mobility: 1 }, regions: { jaw: 3, neck: 2 } },
    formats: ["flow", "holds"], coreBias: [], profile: "tmj",
  },
  {
    id: "gentleMobility", name: "Gentle mobility", blurb: "Easy range for hips, spine, and ankles.",
    modes: ["recovery"],
    emphasis: { patterns: { mobility: 2, rotate: 1 }, regions: { hips: 1.5, thoracic: 1.5, ankles: 1 } },
    formats: ["flow", "holds"], coreBias: [],
  },
];
