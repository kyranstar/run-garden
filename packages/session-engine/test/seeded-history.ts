import { addDays } from "@rg/domain";
import { EXERCISES, makeEngineData, type EngineData, type ExerciseRecord } from "@rg/exercise-library";
import { Planner, Recorder, Rng, type Block, type EngineLocation, type HistorySession } from "../src/index.js";
import { PLACES } from "./builder-fixtures.js";

// Seeded histories made the way people use the app, for the build differential (engine-differential.test.ts) and the
// worker's trimmed-history load (apps/worker/test/build-history.test.ts).

/** The real library with moves renamed (their old ids kept as legacy ids), so renamed ids are exercised. */
export function libraryWithRename(): { data: EngineData; renamed: { from: string; to: string }[] } {
  // Every core lift and every sixth other move: history may name any of them by their old id.
  const renamed = EXERCISES.filter((e, i) => e.roles.includes("core") || i % 6 === 0).map(e => ({ from: `old-${e.id}`, to: e.id }));
  const exercises: ExerciseRecord[] = EXERCISES.map(e => {
    const r = renamed.find(x => x.to === e.id);
    return r ? { ...e, legacyIds: [...e.legacyIds, r.from] } : e;
  });
  return { data: makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises }), renamed };
}

export const WORLDS = (() => {
  const { data, renamed } = libraryWithRename();
  return [
    { name: "tmj + renamed ids", data, renamed },
    { name: "no profile", data: makeEngineData({ activeProfiles: [], careProfiles: [], exercises: EXERCISES }), renamed: [] },
  ];
})();

const kb = (id: string): EngineLocation => {
  const p = PLACES.find(l => l.id === id)!;
  return id === "home" ? { ...p, implements: { kettlebell: [{ v: 8, u: "kg" }, { v: 12, u: "kg" }, { v: 16, u: "kg" }, { v: 35, u: "lb" }] } } : p;
};
export const LOCATIONS = [kb("home"), kb("gym"), kb("mat")];

export interface Seeded {
  sessions: HistorySession[];
  /** The stored block after each session (index i: before session i was planned). */
  blocks: Array<Block | null>;
  prefs: { ratings: Record<string, number>; excluded: string[]; pinned: string[] };
}

/**
 * A plausible history: planned sessions logged with variations, imports, retired and renamed ids, odd dates — in
 * phases, so the rules that read far back come up: stalls and flares (a block's lift rotating out mid-block on its
 * log since the block started), runs of imports (no theme; core lifts done but not logged), and breaks.
 */
export function seededHistory(data: EngineData, renamed: readonly { from: string; to: string }[], seed: string, n: number): Seeded {
  const rng = Rng.create(seed);
  const sessions: HistorySession[] = [];
  const blocks: Array<Block | null> = [];
  const prefs: Seeded["prefs"] = { ratings: {}, excluded: [], pinned: [] };
  let block: Block | null = null;
  const raw = (id: string) => {
    const r = renamed.find(x => x.to === id);
    return r && rng() < 0.5 ? r.from : id;
  };
  let phase: "normal" | "stall" | "flare" | "imports" = "normal";
  let phaseLeft = 0;
  let d = 0;
  while (sessions.length < n) {
    d += 1;
    if (phaseLeft <= 0) {
      const p = rng();
      phase = p < 0.5 ? "normal" : p < 0.68 ? "stall" : p < 0.82 ? "flare" : "imports";
      phaseLeft = 3 + Math.floor(rng() * 6);
      if (rng() < 0.12) d += 14 + Math.floor(rng() * 20);   // a break
    }
    const today = addDays("2025-11-03", d);
    if (rng() > 0.62) continue;
    phaseLeft -= 1;
    blocks.push(block);
    if (phase === "imports" || rng() < 0.05) {
      // An import (or a watch review): no mode, theme or block; sometimes no start time; ids as the source wrote
      // them; the block's lifts often done but not logged.
      const lifts = block ? Object.values(block.core).filter((x): x is string => Boolean(x) && rng() < 0.5) : [];
      const ids = [...new Set([...lifts, ...Array.from({ length: 2 + Math.floor(rng() * 4) }, () => data.exercises[Math.floor(rng() * data.exercises.length)]!.id)])];
      sessions.push({
        id: `${seed}-imp-${d}`, date: today, startedAt: rng() < 0.4 ? null : `${today}T07:${String(10 + Math.floor(rng() * 40))}:00.000Z`,
        mode: null, theme: null, blockNumber: null, checks: rng() < 0.5 ? {} : { tmj: { pre: Math.floor(rng() * 6), post: null, feelingOff: false } },
        done: [...ids.map(id => ({ id: raw(id), secs: 60 })), ...(rng() < 0.4 ? [{ id: "retired-move", secs: 30 }] : [])],
        entries: ids.slice(lifts.length, lifts.length + 2).map(id => ({
          id: raw(id), implement: null, perSide: false, format: rng() < 0.3 ? "ladder" : null, flags: rng() < 0.2 ? ["clenched"] : [],
          sets: [{ w: rng() < 0.5 ? { v: 20 + 5 * Math.floor(rng() * 4), u: rng() < 0.5 ? "lb" : "kg" } : null, reps: 5 + Math.floor(rng() * 6), secs: null }],
        })),
      });
      continue;
    }
    const pre = rng() < 0.1 ? null : rng() < 0.12 ? 5 + Math.floor(rng() * 3) : Math.floor(rng() * 4);
    const checks = { tmj: { pre, post: null, feelingOff: rng() < 0.03 } };
    const location = LOCATIONS[Math.floor(rng() * LOCATIONS.length)]!;
    const minutes = [15, 20, 30, 40, 45][Math.floor(rng() * 5)]!;
    const { view, blockUpdate } = Planner.planToday(data, { today, day: { date: today, checks, override: { minutes, location: location.id }, swaps: {} } }, {
      programId: seed, settings: { unit: rng() < 0.5 ? "lb" : "kg", weeklyGoal: 4, blockWeeks: 5, defaultMinutes: 30, location: "home" },
      locations: LOCATIONS, prefs, savedIds: [], block, sessions,
    });
    if (blockUpdate) block = blockUpdate.block;
    const plan = view.plan;
    const live = Recorder.create(data, plan, {
      id: `${seed}-${d}`, startedAt: `${today}T18:${String(10 + Math.floor(rng() * 40))}:00.000Z`, date: today, mode: view.mode,
      theme: view.theme ? view.theme.id : null, locationId: location.id, minutes, block: view.block, checks,
      equipment: location.equipment, plannedSeconds: plan.plannedSeconds, newMove: plan.newMove,
    });
    const stopAt = rng() < 0.15 ? Math.floor(plan.steps.length * rng()) : plan.steps.length;
    for (let k = 0; k < stopAt; k++) {
      const step = plan.steps[k]!;
      if (step.kind === "timed") Recorder.finishTimed(live, k, rng() < 0.9 ? step.seconds : step.seconds / 3);
      else Recorder.reach(live, k);
    }
    const core = new Set(plan.items.filter(it => it.block === "core").map(it => it.exercise.id));
    for (const id of live.order) {
      const first = live.entries[id]!.sets[0];
      if (rng() < (phase === "flare" && core.has(id) ? 0.7 : 0.06)) Recorder.setFlag(live, id, "clenched", true);
      // A stall: one rep short of the target, every time (no progress).
      if (phase === "stall" && first?.reps != null) Recorder.update(live, id, 0, "reps", Math.max(1, first.reps - 1));
      else if (rng() < 0.3 && first?.reps != null) Recorder.update(live, id, 0, "reps", first.reps + (rng() < 0.7 ? 1 : -1));
      if (rng() < 0.05) Recorder.addSet(live, id);
    }
    const saved = Recorder.toSession(live, {
      endedAt: `${today}T19:00:00.000Z`, post: { tmj: pre == null ? null : Math.max(0, pre - 1 + (rng() < 0.1 ? 3 : 0)) }, completed: stopAt === plan.steps.length,
    });
    const session: HistorySession = {
      id: saved.id, date: saved.date, startedAt: saved.startedAt, mode: saved.mode, theme: saved.theme, blockNumber: saved.blockNumber,
      checks: saved.checks, done: saved.done.map(m => ({ id: raw(m.id), secs: m.secs })),
      entries: saved.entries.map(e => ({ id: raw(e.id), implement: e.implement, perSide: e.perSide, format: e.format, flags: e.flags, sets: e.sets })),
    };
    sessions.push(session);
    // A second session the same day, now and then.
    if (rng() < 0.05) {
      blocks.push(block);
      sessions.push({ ...session, id: `${session.id}-b`, startedAt: `${today}T20:00:00.000Z`, mode: "recovery", entries: session.entries.slice(0, 1) });
    }
    if (rng() < 0.05 && plan.items[0]) prefs.ratings[plan.items[0].exercise.id] = rng() < 0.6 ? 1 : -1;
    if (rng() < 0.02 && plan.items[1]) prefs.excluded.push(plan.items[1].exercise.id);
  }
  const lift = block ? Object.values(block.core).find((x): x is string => Boolean(x)) : undefined;
  if (lift) prefs.pinned.push(lift);
  return { sessions, blocks, prefs };
}

