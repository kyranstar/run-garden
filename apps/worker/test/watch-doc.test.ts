/**
 * THE DOCUMENT YIELDS THE SAME WATCH STEPS AS TODAY'S BUILDER (programme spec §3.3, Amendment A). Fifty builds made by
 * the worker's own `composeBuild` from the engine differential's seeded history — every mode, themes, places, minutes,
 * checks, and swaps from the offered alternatives on every other build — each sent to the watch two ways:
 *   today:        watchStepsFromBuild(build)
 *   the document: watchStepsFromDoc(docFromBuild(build)) = playerStepsFromDoc → watchStepsFromBuild
 * and the two step lists are equal, field for field (names, catalog ids, targets, grams, rests, overviews, sides).
 * Synthetic history and the live COROS catalog's T-codes under synthesized ids; no personal data.
 */
import { describe, expect, it, vi } from "vitest";
import { adaptiveConfigSchema, addDays, workoutDocSchema } from "@rg/domain";
import { EXERCISES, type Mode } from "@rg/exercise-library";
import { Rng } from "@rg/session-engine";
import { docFromBuild } from "@rg/workout";
import { LOCATIONS, WORLDS, seededHistory } from "../../../packages/session-engine/test/seeded-history.js";
import { liveExerciseCatalog } from "../../../packages/domain/test/coach-survival/catalog.js";
import { corosKeyOf } from "../src/services/coros-exercise-map.js";
import type { EngineContext } from "../src/services/engine-inputs.js";
import { composeBuild, type ComposeInput } from "../src/services/session-build.js";
import { watchStepsFromDoc } from "../src/services/watch-doc.js";
import { catalogIdsByKey, watchStepsFromBuild, type WatchPlanDeps } from "../src/services/watch-push.js";

// Fifty builds and their swapped rebuilds on a loaded runner: a per-file timeout, not a cost question.
vi.setConfig({ testTimeout: 120_000 });

const world = WORLDS[0]!;
const MODES: Mode[] = ["recovery", "consistent", "build"];

/** The athlete's catalog holds every live T-code (synthesized ids): moves go as catalog steps wherever they can. */
const deps: WatchPlanDeps = { catalogIdByKey: catalogIdsByKey(liveExerciseCatalog()), keyOf: (id) => corosKeyOf(id) };
/** No catalog at all: every move goes as free text, its name cut and made unique. */
const noCatalog: WatchPlanDeps = { catalogIdByKey: new Map(), keyOf: () => null };

function seededInputs(n: number): Array<{ label: string; input: ComposeInput }> {
  const h = seededHistory(world.data, world.renamed, "watch-doc", 120);
  const rng = Rng.create("watch-doc|inputs");
  const out: Array<{ label: string; input: ComposeInput }> = [];
  for (let i = 0; out.length < n; i++) {
    const cut = 3 + Math.floor(rng() * (h.sessions.length - 3));
    const date = addDays(h.sessions[cut - 1]!.date, 1 + Math.floor(rng() * 3));
    const mode = MODES[i % 3]!;
    const themes = mode === "build" && rng() < 0.7 ? world.data.themes.filter((t) => t.formats.includes("circuit")) : world.data.themes;
    const context: EngineContext = {
      prefs: rng() < 0.5 ? h.prefs : { ratings: {}, excluded: [], pinned: [] },
      savedIds: [],
      location: LOCATIONS[i % 3]!,
      locations: LOCATIONS,
      unit: rng() < 0.5 ? "lb" : "kg",
      activeProfiles: ["tmj"],
      careProfiles: ["tmj"],
      config: adaptiveConfigSchema.parse({ defaultMinutes: [20, 30, 45][i % 3], careProfiles: ["tmj"] }),
    };
    const overrides: ComposeInput["overrides"] = { mode };
    if (rng() < 0.7) overrides.theme = themes[Math.floor(rng() * themes.length)]!.id;
    if (rng() < 0.6) overrides.minutes = (mode === "build" ? [40, 45, 60] : [15, 25, 30, 40, 60])[Math.floor(rng() * (mode === "build" ? 3 : 5))]!;
    const input: ComposeInput = {
      date, programId: "p-watch-doc", context, block: h.blocks[Math.min(cut, h.blocks.length - 1)] ?? null, history: h.sessions.slice(0, cut),
      checks: { tmj: { pre: Math.floor(rng() * 4), feelingOff: false } }, overrides, swaps: {},
    };
    let label = `build ${i} (${mode}, ${overrides.theme ?? "no theme"}, ${date})`;
    if (i % 2 === 1) {
      const { build } = composeBuild(input);
      const swaps: Record<string, { from: string; to: string }> = {};
      for (const [slotKey, alts] of Object.entries(build.alternatives).filter(([, a]) => a.length)) {
        if (rng() < 0.5 || Object.keys(swaps).length >= 3) continue;
        swaps[slotKey] = { from: build.items.find((it) => it.slotKey === slotKey)!.exerciseId, to: alts[Math.floor(rng() * alts.length)]!.id };
      }
      if (Object.keys(swaps).length) {
        input.swaps = swaps;
        label += ` with ${Object.keys(swaps).length} swap(s)`;
      }
    }
    out.push({ label, input });
  }
  return out;
}

describe("watchStepsFromDoc(docFromBuild(b)) equals today's watchStepsFromBuild(b) — 50 seeded builds", () => {
  const cases = seededInputs(50).map(({ label, input }) => ({ label, build: composeBuild(input).build }));

  it("with the athlete's catalog (catalog steps and one-sided free text)", () => {
    let steps = 0;
    for (const { label, build } of cases) {
      const doc = docFromBuild(build);
      expect(workoutDocSchema.safeParse(doc).success, label).toBe(true);
      const today = watchStepsFromBuild(build, deps);
      expect(watchStepsFromDoc(doc, EXERCISES, deps), label).toEqual(today);
      steps += today.steps.length;
    }
    expect(steps).toBeGreaterThan(1000);
  });

  it("with no catalog (every move free text)", () => {
    for (const { label, build } of cases) expect(watchStepsFromDoc(docFromBuild(build), EXERCISES, noCatalog), label).toEqual(watchStepsFromBuild(build, noCatalog));
  });

  it("the builds reach every format, both sides, catalog and free-text steps, weights, rests and swaps", () => {
    const steps = cases.flatMap((c) => c.build.steps);
    expect(new Set(steps.map((s) => s.format.id))).toEqual(new Set(["straight", "superset", "circuit", "ladder", "flow", "holds"]));
    const watch = cases.flatMap((c) => watchStepsFromBuild(c.build, deps).steps);
    expect(watch.some((s) => s.side === "left")).toBe(true);
    expect(watch.some((s) => s.originId !== "0")).toBe(true);
    expect(watch.some((s) => s.originId === "0")).toBe(true);
    expect(watch.some((s) => s.grams !== null)).toBe(true);
    expect(watch.some((s) => s.restSeconds > 0)).toBe(true);
    expect(cases.filter((c) => c.label.includes("swap")).length).toBeGreaterThan(5);
  });
});
