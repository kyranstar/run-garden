import { EXERCISES, LOCATION_PRESETS, makeEngineData, type ExerciseRecord, type Mode } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Blocks, Builder, Swapping, type BuildInput, type BuildResult, type EngineLocation, type HistorySession } from "../src/index.js";

// TOP-CLENCH MOVES (2026-10-23, after the TMJ evidence review): a move rated clench 3 is no longer "never". It plays in
// build only, and only in a format with rest — straight sets or a superset — never in a circuit, ladder, flow or holds,
// and never as a block's lift (a block's lift plays on consistent days too). The real library has no clench-3 move, so
// this holds the rule with a clench-3 twin of every move that is no jump: each rated 👍, saved and never done, so
// ranking and the new-move guarantee pick one wherever the rules let it in.

const twinId = (id: string) => `top${id[0]!.toUpperCase()}${id.slice(1)}`;
const twins: ExerciseRecord[] = EXERCISES.filter(e => !e.contraction.includes("plyometric")).map(e => ({
  ...e, id: twinId(e.id), legacyIds: [], family: `top-${e.family}`, name: `Top ${e.name}`, harder: [], easier: [],
  conditions: { ...e.conditions, tmj: { ...e.conditions.tmj!, clench: 3 } },
}));
const TWINS = new Set(twins.map(t => t.id));
const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: [...EXERCISES, ...twins] });

const place = (id: string): EngineLocation => {
  const p = LOCATION_PRESETS.find(l => l.id === id)!;
  return { id: p.id, name: p.name, equipment: p.equipment, implements: {} };
};
const prefs = { ratings: Object.fromEntries([...TWINS].map(id => [id, 1])), excluded: [], pinned: [] as string[] };
const history: HistorySession[] = [{
  id: "h1", date: "2026-09-20", startedAt: "2026-09-20T18:00:00", mode: "build", theme: null, blockNumber: 1,
  checks: { tmj: { pre: 1, post: 1, feelingOff: false } }, done: EXERCISES.map(e => ({ id: e.id, secs: 60 })), entries: [],
}];
const block = Blocks.ensure(data, null, { today: "2026-09-15", equipment: place("gym").equipment, prefs, sessions: [] }).block;
const input = (o: Partial<BuildInput>): BuildInput => ({
  today: "2026-09-29", mode: "build", theme: null, minutes: 40, location: place("gym"), unit: "lb", sessions: history,
  prefs, savedIds: [...TWINS], block, checks: { tmj: { pre: 1, post: null, feelingOff: false } }, swaps: {}, ...o,
});

/** Every twin a plan holds or offers, with where: its items' formats, its alternatives, its swap pools. */
function twinsIn(plan: BuildResult): { items: Array<{ id: string; format: string }>; offered: string[] } {
  return {
    items: plan.items.filter(i => TWINS.has(i.exercise.id)).map(i => ({ id: i.exercise.id, format: i.format })),
    offered: [
      ...Object.values(plan.alternatives).flatMap(alts => alts.filter(a => TWINS.has(a.id)).map(a => a.id)),
      ...Object.values(plan.swapState.slots).flatMap(slot => [slot.original, ...slot.pool].filter(c => TWINS.has(c.id)).map(c => c.id)),
    ],
  };
}

const builds = (mode: Mode): BuildResult[] =>
  ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29"].flatMap(today => data.themes.filter(t => t.modes.includes(mode)).flatMap(theme =>
    ["home", "gym"].flatMap(loc => [30, 60].map(minutes => Builder.build(data, input({ today, mode, theme, minutes, location: place(loc) }))))));

describe("a top-clench move: build only, and only in straight sets or a superset", () => {
  test("never in recovery or consistent: no item, no alternative, no swap pool", () => {
    for (const mode of ["recovery", "consistent"] as const) {
      for (const plan of builds(mode)) expect(twinsIn(plan), mode).toEqual({ items: [], offered: [] });
    }
  });

  test("in build, it plays — and only in straight sets or a superset, never a circuit, ladder, flow or holds", () => {
    const plans = builds("build");
    const placed = plans.flatMap(p => twinsIn(p).items);
    expect(placed.length, "build should take a top-clench move somewhere").toBeGreaterThan(0);
    expect([...new Set(placed.map(p => p.format))].sort()).toEqual(expect.arrayContaining(["straight"]));
    for (const p of placed) expect(["straight", "superset"], `${p.id} in ${p.format}`).toContain(p.format);
    // The accessory block took the formats it tolerates less, too, and no twin went with them.
    const otherFormats = plans.flatMap(p => p.groups.filter(g => g.block === "accessory" && !["straight", "superset"].includes(g.format)));
    expect(otherFormats.length, "some build took a circuit or a ladder").toBeGreaterThan(0);
    for (const g of otherFormats) expect(g.items.filter(i => TWINS.has(i.exercise.id)).map(i => i.exercise.id), g.format).toEqual([]);
  });

  test("a slot of another format never offers one, k = 20", () => {
    for (const plan of builds("build").slice(0, 12)) {
      for (const it of plan.items) {
        if (it.format === "straight" || it.format === "superset") continue;
        expect(Swapping.offered(plan.swapState, plan.steps, it.slotKey, 20).filter(a => TWINS.has(a.id)), `${it.slotKey} (${it.format})`).toEqual([]);
      }
    }
  });

  test("never a block's lift: a fresh block with every twin rated 👍, and graduation to one", () => {
    for (const loc of ["home", "gym"]) {
      const fresh = Blocks.ensure(data, null, { today: "2026-09-29", equipment: place(loc).equipment, prefs, sessions: history }).block;
      expect(Object.values(fresh.core).filter(id => id && TWINS.has(id)), loc).toEqual([]);
    }
    for (const [family, id] of Object.entries(block.core)) {
      if (id && TWINS.has(twinId(id))) expect(Blocks.graduate(data, block, family, twinId(id), "2026-09-29", place("gym").equipment)).toBe(block);
    }
  });
});
