import { addDays } from "@rg/domain";
import { EXERCISES, makeEngineData, type EngineData, type ExerciseRecord } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import {
  Blocks, Builder, Coverage, Hist, Planner, Prog, Proposal, Recorder, Rng, Select,
  type Block, type DayState, type EngineLocation, type HistorySession, type Mode, type ProgramState, type TodayView,
} from "../src/index.js";
import * as Ref from "./reference/index.js";
import { PLACES } from "./builder-fixtures.js";

// DIFFERENTIAL (ruling 2a-R6): the optimised engine plans byte-identically to the engine as it was before the
// performance work (frozen in ./reference). Seeded histories of up to 200 sessions, made the way people use the
// app — planned sessions logged with flags, skipped sets and edits; imports with no mode or theme; moves the
// library no longer has and renamed (legacy) ids; two sessions on one day; a session dated after the build — and,
// at many points along each, a day's build with varied checks, overrides, places, prefs, blocks and swaps. Every
// output is compared as JSON: the view (proposal, block, steps, items, targets, reasons, alternatives, swap
// state) and the block update, plus the history helpers each module reads.

/** The real library with one move renamed (its old id kept as a legacy id), so renamed ids are exercised. */
function libraryWithRename(): { data: EngineData; renamed: { from: string; to: string }[] } {
  // Every core lift and every sixth other move: history may name any of them by their old id.
  const renamed = EXERCISES.filter((e, i) => e.roles.includes("core") || i % 6 === 0).map(e => ({ from: `old-${e.id}`, to: e.id }));
  const exercises: ExerciseRecord[] = EXERCISES.map(e => {
    const r = renamed.find(x => x.to === e.id);
    return r ? { ...e, legacyIds: [...e.legacyIds, r.from] } : e;
  });
  return { data: makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises }), renamed };
}

const WORLDS = (() => {
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
const LOCATIONS = [kb("home"), kb("gym"), kb("mat")];

interface Seeded {
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
function seededHistory(data: EngineData, renamed: readonly { from: string; to: string }[], seed: string, n: number): Seeded {
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

/** The first difference between two JSON strings, with context, for a failure message. */
function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `at ${i}: …${a.slice(Math.max(0, i - 120), i + 80)}… vs …${b.slice(Math.max(0, i - 120), i + 80)}…`;
}
function same(label: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got, (_k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v));
  const w = JSON.stringify(want, (_k, v) => (v instanceof Map ? [...v] : v instanceof Set ? [...v] : v));
  if (g !== w) expect.fail(`${label}: differs ${firstDiff(g, w)}`);
}

const MODES: Mode[] = ["recovery", "consistent", "build"];

/** The program with its history trimmed to what a build on `today` reads, plus the summary of the rest (ruling 2a-R6). */
const trimmedOf = (program: ProgramState, today: string): ProgramState =>
  ({ ...program, sessions: Hist.trim(program.sessions, today, program.block), summary: Hist.summarize(program.sessions, today) });
/** A plan without the history it was given (a trimmed history and its summary differ from the whole one by design). */
const planOnly = (r: { view: TodayView; blockUpdate: unknown }) =>
  ({ ...r, view: { ...r.view, input: { ...r.view.input, sessions: undefined, summary: undefined } } });

for (const world of WORLDS) {
  describe(`differential vs the frozen engine (${world.name})`, () => {
    const { data, renamed } = world;
    const histories = ["alpha", "bravo", "charlie"].map(seed => ({ seed, ...seededHistory(data, renamed, `${world.name}|${seed}`, seed === "charlie" ? 200 : 140) }));

    test("the planned history is varied enough to mean something", () => {
      const all = histories.flatMap(h => h.sessions);
      expect(all.some(s => s.mode === null && s.theme === null)).toBe(true);
      expect(all.some(s => s.startedAt === null)).toBe(true);
      expect(all.some(s => s.done.some(d => d.id === "retired-move"))).toBe(true);
      expect(all.some(s => s.entries.some(e => e.format === "ladder" || e.format === "circuit"))).toBe(true);
      expect(all.some(s => s.entries.some(e => e.flags.length > 0))).toBe(true);
      expect(all.some(s => all.some(o => o !== s && o.date === s.date))).toBe(true);
      if (renamed.length) expect(all.some(s => s.entries.some(e => renamed.some(r => r.from === e.id)))).toBe(true);
      expect(histories.some(h => h.sessions.length >= 200)).toBe(true);
      // Long reads come up: a lift rotated out mid-block on its log since the block started, a run of imports.
      expect(histories.some(h => h.blocks.some(b => b?.rotations.some(r => r.why === "no progress in 3 sessions")))).toBe(true);
      expect(all.some((s, i) => i >= 3 && all.slice(i - 3, i + 1).every(x => x.theme === null))).toBe(true);
    });

    for (const h of histories) {
      test(`${h.seed}: every day's build, its alternatives and graduation offers are byte-identical`, () => {
        const rng = Rng.create(`cases|${world.name}|${h.seed}`);
        let cases = 0;
        const kept: number[] = [];
        for (let cut = 3; cut <= h.sessions.length; cut += 4 + Math.floor(rng() * 5)) {
          const last = h.sessions[cut - 1]!;
          const today = addDays(last.date, [0, 1, 1, 2, 3, 5, 9, 40][Math.floor(rng() * 8)]!);
          // Sometimes a session dated after the build (a device in another time zone).
          const sessions = rng() < 0.1 && h.sessions[cut] ? [...h.sessions.slice(0, cut), { ...h.sessions[cut]!, date: addDays(today, 1) }] : h.sessions.slice(0, cut);
          const stored = h.blocks[Math.min(cut, h.blocks.length - 1)] ?? null;
          const blockRoll = rng();
          const block: Block | null = blockRoll < 0.1 ? null
            : blockRoll < 0.18 && stored ? { ...stored, startedAt: addDays(today, -60) }
            : stored;
          const program: ProgramState = {
            ...(rng() < 0.8 ? { programId: `p-${h.seed}` } : {}),
            settings: {
              unit: rng() < 0.5 ? "lb" : "kg", weeklyGoal: 3 + Math.floor(rng() * 3), blockWeeks: 4 + Math.floor(rng() * 3),
              defaultMinutes: [15, 20, 30, 40, 45][Math.floor(rng() * 5)]!, location: LOCATIONS[Math.floor(rng() * 3)]!.id,
            },
            locations: rng() < 0.2 ? [LOCATIONS[1]!, LOCATIONS[2]!] : LOCATIONS,
            prefs: rng() < 0.5 ? h.prefs : { ratings: {}, excluded: [], pinned: [] },
            savedIds: rng() < 0.3 ? data.exercises.filter((_, i) => i % 9 === 0).map(e => e.id) : [],
            block,
            sessions,
          };
          const pre = rng() < 0.2 ? null : Math.floor(rng() * 8);
          const override: DayState["override"] = {};
          if (rng() < 0.25) override.mode = MODES[Math.floor(rng() * 3)]!;
          if (rng() < 0.15) override.theme = data.themes[Math.floor(rng() * data.themes.length)]!.id;
          if (rng() < 0.3) override.minutes = [15, 25, 30, 40, 60][Math.floor(rng() * 5)]!;
          if (rng() < 0.2) override.location = LOCATIONS[Math.floor(rng() * 3)]!.id;
          const day: DayState = { date: today, checks: { tmj: { pre, post: null, feelingOff: rng() < 0.05 } }, feelingOff: rng() < 0.03, override, swaps: {} };
          const label = `${h.seed} cut ${cut} on ${today}`;

          const want = Ref.Planner.planToday(data, { today, day }, program);
          const got = Planner.planToday(data, { today, day }, program);
          same(`${label}: planToday`, got, want);
          const trimmed = trimmedOf(program, today);
          kept.push(trimmed.sessions.length / Math.max(1, sessions.length));
          same(`${label}: planToday from a trimmed history`, planOnly(Planner.planToday(data, { today, day }, trimmed)), planOnly(want));

          // Swaps taken from the offered alternatives (and one stale one), applied in the order made.
          const slots = Object.entries(want.view.plan.alternatives).filter(([, alts]) => alts.length);
          if (slots.length) {
            const swaps: Record<string, { from: string; to: string }> = {};
            for (const [slotKey, alts] of slots.filter(() => rng() < 0.35).slice(0, 3)) {
              const from = want.view.plan.items.find(it => it.slotKey === slotKey)!.exercise.id;
              swaps[slotKey] = { from, to: alts[Math.floor(rng() * alts.length)]!.id };
            }
            if (rng() < 0.3) swaps["prep:0"] = { from: "not-in-the-slot", to: data.exercises[0]!.id };
            const swapped: DayState = { ...day, swaps };
            const wantSwapped = Ref.Planner.planToday(data, { today, day: swapped }, program);
            same(`${label}: planToday with swaps`, Planner.planToday(data, { today, day: swapped }, program), wantSwapped);
            same(`${label}: planToday with swaps, trimmed`, planOnly(Planner.planToday(data, { today, day: swapped }, trimmed)), planOnly(wantSwapped));
            const slotKey = slots[Math.floor(rng() * slots.length)]![0];
            const wantAlts = Ref.Planner.alternatives(data, { today, day: swapped }, program, slotKey, 5);
            same(`${label}: alternatives(${slotKey})`, Planner.alternatives(data, { today, day: swapped }, program, slotKey, 5), wantAlts);
            same(`${label}: alternatives(${slotKey}), trimmed`, Planner.alternatives(data, { today, day: swapped }, trimmed, slotKey, 5), wantAlts);
          }
          const performed = h.sessions[cut];
          if (performed && program.block) {
            const wantOffers = Ref.Planner.graduationOffers(data, program, performed);
            same(`${label}: graduationOffers`, Planner.graduationOffers(data, program, performed), wantOffers);
            same(`${label}: graduationOffers, trimmed`, Planner.graduationOffers(data, trimmed, performed), wantOffers);
          }
          cases += 1;
        }
        expect(cases).toBeGreaterThanOrEqual(12);
        // Trimming is worth it on a long history, even this one, which logs moves from the whole library under two ids each
        // (each move's two newest entries keep their sessions): the bench's history keeps about a quarter.
        if (h.sessions.length >= 200) expect(Math.min(...kept.slice(-3))).toBeLessThan(0.7);
      });

      test(`${h.seed}: the history helpers each module reads answer identically`, () => {
        const rng = Rng.create(`helpers|${world.name}|${h.seed}`);
        const ids = [...new Set([...data.exercises.map(e => e.id), ...h.sessions.flatMap(s => Hist.idsIn(s)), "retired-move", ...renamed.map(r => r.from)])];
        for (let cut = 0; cut <= h.sessions.length; cut += 9 + Math.floor(rng() * 9)) {
          const sessions = h.sessions.slice(0, cut);
          const today = addDays(sessions[sessions.length - 1]?.date ?? "2025-11-03", Math.floor(rng() * 4));
          const label = `${h.seed} cut ${cut} on ${today}`;
          same(`${label}: exposures`, Coverage.exposures(data, sessions, today), Ref.Coverage.exposures(data, sessions, today));
          same(`${label}: exposures 14`, Coverage.exposures(data, sessions, today, 14), Ref.Coverage.exposures(data, sessions, today, 14));
          same(`${label}: debt`, Coverage.debt(data, sessions, today), Ref.Coverage.debt(data, sessions, today));
          same(`${label}: stats`, Select.stats(data, sessions, today), Ref.Select.stats(data, sessions, today));
          same(`${label}: firstDone`, Hist.firstDone(data, sessions), Ref.Hist.firstDone(data, sessions));
          same(`${label}: newMoveThisWeek`, Hist.newMoveThisWeek(data, sessions, today), Ref.Hist.newMoveThisWeek(data, sessions, today));
          for (const f of data.coreFamilies) same(`${label}: lastFamilyDate ${f.id}`, Hist.lastFamilyDate(data, sessions, f.id, today), Ref.Hist.lastFamilyDate(data, sessions, f.id, today));
          for (const id of ids) same(`${label}: historyFor ${id}`, Prog.historyFor(data, sessions, id), Ref.Prog.historyFor(data, sessions, id));
          const checks = { tmj: { pre: Math.floor(rng() * 7), post: null, feelingOff: false } };
          const mode = Proposal.mode(data, { checks, sessions, today, weeklyGoal: 4 });
          same(`${label}: mode`, mode, Ref.Proposal.mode(data, { checks, sessions, today, weeklyGoal: 4 }));
          same(`${label}: theme`, Proposal.theme(data, { mode: mode.mode, sessions, today }), Ref.Proposal.theme(data, { mode: mode.mode, sessions, today }));
          const block = h.blocks[Math.min(cut, h.blocks.length - 1)] ?? null;
          const ctx = { today, equipment: LOCATIONS[0]!.equipment, prefs: h.prefs, weeks: 5, sessions, kbWeights: [{ v: 12, u: "kg" as const }], unit: "kg" as const };
          same(`${label}: ensure`, Blocks.ensure(data, block, ctx), Ref.Blocks.ensure(data, block, ctx));
          if (block) {
            const famArgs = (r: () => number) => ({ mode: mode.mode, sessions, today, theme: data.themes[0]!, rng: r });
            same(`${label}: familiesForSession`, Blocks.familiesForSession(data, block, famArgs(Rng.create(label))), Ref.Blocks.familiesForSession(data, block, famArgs(Rng.create(label))));
          }
          const input = {
            today, mode: mode.mode, theme: Proposal.theme(data, { mode: mode.mode, sessions, today }).theme, minutes: 30, location: LOCATIONS[0]!,
            unit: "lb" as const, sessions, prefs: h.prefs, savedIds: [], block, checks, swaps: {},
          };
          same(`${label}: Builder.build`, Builder.build(data, input), Ref.Builder.build(data, input));
        }
      });
    }
  });
}
