/**
 * Fifty seeded engine builds, made the way the app makes them (`Planner.planToday`, as the worker's `composeBuild`
 * does): the engine differential's seeded history (renamed ids, imports, flags), every mode, themes, places, minutes,
 * units and checks, and offered swaps on every other build. Synthetic only.
 */
import { addDays } from "@rg/domain";
import type { ExerciseRecord } from "@rg/exercise-library";
import { Planner, Rng, type BuildResult, type DayState, type Mode, type ProgramState } from "@rg/session-engine";
import { LOCATIONS, WORLDS, seededHistory } from "../../session-engine/test/seeded-history.js";
import type { BuildPayload } from "../src/index.js";

export const WORLD = WORLDS[0]!;
/** The world's library (its renamed moves keep their old ids as legacy ids). */
export const LIBRARY = WORLD.data.exercises;

const MODES: Mode[] = ["recovery", "consistent", "build"];

export interface SeededBuild {
  label: string;
  plan: BuildResult;
}

export function seededBuilds(n = 50): SeededBuild[] {
  const { data, renamed } = WORLD;
  const h = seededHistory(data, renamed, "workout-doc", 120);
  const rng = Rng.create("workout-doc|builds");
  const out: SeededBuild[] = [];
  for (let i = 0; out.length < n; i++) {
    const cut = 3 + Math.floor(rng() * (h.sessions.length - 3));
    const today = addDays(h.sessions[cut - 1]!.date, 1 + Math.floor(rng() * 3));
    const program: ProgramState = {
      programId: "p-workout-doc",
      settings: {
        unit: rng() < 0.5 ? "lb" : "kg", weeklyGoal: 3 + Math.floor(rng() * 3), blockWeeks: 5,
        defaultMinutes: [15, 20, 30, 40, 45, 60][Math.floor(rng() * 6)]!, location: LOCATIONS[i % 3]!.id,
      },
      locations: LOCATIONS,
      prefs: h.prefs,
      savedIds: [],
      block: h.blocks[Math.min(cut, h.blocks.length - 1)] ?? null,
      sessions: h.sessions.slice(0, cut),
    };
    const mode = MODES[i % 3]!;
    const override: DayState["override"] = { mode };
    // Build days lean on the themes that take a circuit or a ladder, so every format comes up.
    const themes = mode === "build" && rng() < 0.7 ? data.themes.filter((t) => t.formats.includes("circuit")) : data.themes;
    if (rng() < 0.7) override.theme = themes[Math.floor(rng() * themes.length)]!.id;
    if (rng() < 0.6) override.minutes = (mode === "build" ? [40, 45, 60] : [15, 25, 30, 40, 60])[Math.floor(rng() * (mode === "build" ? 3 : 5))]!;
    const day: DayState = { date: today, checks: { tmj: { pre: Math.floor(rng() * 4), post: null, feelingOff: false } }, feelingOff: false, override, swaps: {} };
    let plan = Planner.planToday(data, { today, day }, program).view.plan;
    let label = `build ${i} (${override.mode}, ${override.theme ?? "no theme"}, ${today})`;
    if (i % 2 === 1) {
      // Swaps from the offered alternatives: a swapped slot keeps the rests its first move set.
      const swaps: Record<string, { from: string; to: string }> = {};
      for (const [slotKey, alts] of Object.entries(plan.alternatives).filter(([, a]) => a.length)) {
        if (rng() < 0.5 || Object.keys(swaps).length >= 3) continue;
        swaps[slotKey] = { from: plan.items.find((it) => it.slotKey === slotKey)!.exercise.id, to: alts[Math.floor(rng() * alts.length)]!.id };
      }
      if (Object.keys(swaps).length) {
        plan = Planner.planToday(data, { today, day: { ...day, swaps } }, program).view.plan;
        label += ` with ${Object.keys(swaps).length} swap(s)`;
      }
    }
    out.push({ label, plan });
  }
  return out;
}

/** The build as the worker stores it (`composeBuild`): the fields `docFromBuild` reads. */
export function stored(plan: BuildResult): BuildPayload {
  const exercises: Record<string, ExerciseRecord> = {};
  for (const it of plan.items) exercises[it.exercise.id] = it.exercise;
  return {
    mode: plan.mode,
    theme: plan.theme?.id ?? null,
    modeReasons: [],
    themeReasons: [],
    minutes: plan.minutes,
    steps: plan.steps,
    items: plan.items.map((it) => ({
      slotKey: it.slotKey, block: it.block, exerciseId: it.exercise.id, format: it.format, sets: it.sets, group: it.group, why: it.why,
    })),
    exercises,
    alternatives: plan.alternatives,
  };
}
