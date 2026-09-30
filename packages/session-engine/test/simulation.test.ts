import { addDays, startOfIsoWeek } from "@rg/domain";
import { Vocab, type ExerciseRecord } from "@rg/exercise-library";
import { expect, test } from "vitest";
import { Blocks, Builder, Hist, Lib, Proposal, Rng, type Block, type BuildResult, type Group, type HistorySession, type Mode } from "../src/index.js";
import { data, gym, home } from "./builder-fixtures.js";

// Ported from the standalone tests/simulation.test.js: 12 weeks of plausible use with TMJ active and cared for.

const pairable = (a: ExerciseRecord, b: ExerciseRecord) => a.dose.type === "reps" && b.dose.type === "reps" &&
  !a.patterns.some(p => b.patterns.includes(p)) && Vocab.positionGroup(a.position) === Vocab.positionGroup(b.position);

interface Run { today: string; mode: Mode; minutes: number; plan: BuildResult; equipment: readonly string[]; blockNumber: number; blockStart: string }

// 12 weeks of plausible use: 2–5 sessions a week, occasional 2–3 day flares, a few ratings.
function simulate(seed: string): { sessions: HistorySession[]; runs: Run[] } {
  const rng = Rng.create(seed);
  const ratings: Record<string, number> = {};
  const prefs = { ratings, excluded: [], pinned: [] };
  const sessions: HistorySession[] = [];
  const runs: Run[] = [];
  let block: Block | null = null;
  let flare = 0;
  for (let d = 0; d < 84; d++) {
    const today = addDays("2026-06-01", d);
    if (!flare && rng() < 0.04) flare = 2 + Math.floor(rng() * 2);
    const pre = flare ? 5 + Math.floor(rng() * 2) : Math.floor(rng() * 3);
    if (flare) flare -= 1;
    if (rng() > 0.55) continue;
    block = Blocks.ensure(data, block, { today, equipment: home.equipment, prefs, weeks: 5, sessions }).block;
    const checks = { tmj: { pre, post: null, feelingOff: false } };
    const mode = Proposal.mode(data, { checks, sessions, today, weeklyGoal: 4 }).mode;
    const theme = Proposal.theme(data, { mode, sessions, today }).theme;
    const location = rng() < 0.2 ? gym : home;
    const minutes = [15, 30, 30, 40][Math.floor(rng() * 4)]!;
    const plan = Builder.build(data, { today, mode, theme, minutes, location, unit: "lb", sessions, prefs, block, checks, swaps: {} });
    runs.push({ today, mode, minutes, plan, equipment: location.equipment, blockNumber: block.number, blockStart: block.startedAt });
    const entries = plan.items.filter(it => it.target).map(it => ({
      id: it.exercise.id, implement: null, perSide: false, format: it.format,
      flags: rng() < 0.04 ? ["clenched"] : [],
      sets: Array.from({ length: Math.max(1, it.sets) }, () => ({
        w: it.target!.w,
        reps: it.target!.reps != null ? Math.min(it.target!.hi, it.target!.reps + (rng() < 0.6 ? 1 : 0)) : null,
        secs: it.target!.secs,
      })),
    }));
    if (rng() < 0.15) ratings[plan.items[Math.floor(rng() * plan.items.length)]!.exercise.id] = rng() < 0.6 ? 1 : -1;
    const post = Math.max(0, pre - 1 + (rng() < 0.08 ? 3 : 0));
    sessions.push({
      id: `sim-${d}`, date: today, startedAt: `${today}T18:00:00`, mode, theme: theme ? theme.id : null, blockNumber: null,
      checks: { tmj: { pre, post, feelingOff: false } },
      done: plan.items.map(it => ({ id: it.exercise.id, secs: 0 })), entries,
    });
  }
  return { sessions, runs };
}

for (const seed of ["alpha", "bravo", "charlie"]) {
  const { sessions, runs } = simulate(seed);

  test(`simulation ${seed}: every session fits its time and recovery stays flare-safe`, () => {
    expect(runs.length, `${runs.length} sessions`).toBeGreaterThanOrEqual(30);
    for (const r of runs) {
      expect(r.plan.plannedSeconds, `${r.today} over budget`).toBeLessThanOrEqual(r.minutes * 60);
      if (r.mode === "recovery") expect(r.plan.items.every(i => Lib.flareSafe(data, i.exercise)), `${r.today} recovery has a non-flare-safe move`).toBe(true);
    }
  });

  test(`simulation ${seed}: each core family comes up about twice per four training sessions`, () => {
    // "About twice a week at a weekly goal of 4", measured per non-recovery session so flare weeks don't skew it.
    const training = runs.filter(r => r.mode !== "recovery");
    expect(training.length, `${training.length} training sessions`).toBeGreaterThanOrEqual(20);
    for (const fam of data.coreFamilies) {
      const n = training.reduce((sum, r) => sum + r.plan.items.filter(i => i.block === "core" && i.coreFamily === fam.id).length, 0);
      const perFour = (n / training.length) * 4;
      expect(perFour >= 1 && perFour <= 3, `${fam.id}: ${perFour.toFixed(2)} per 4 sessions`).toBe(true);
    }
  });

  test(`simulation ${seed}: a new move lands every week while there are unseen ones`, () => {
    const first = new Map<string, string>();
    for (const s of sessions) for (const d of s.done) if (!first.has(d.id)) first.set(d.id, s.date);
    const weekStarts = [...new Set(sessions.map(s => startOfIsoWeek(s.date)))];
    for (const wk of weekStarts) {
      const end = addDays(wk, 6);
      const newThisWeek = [...first.values()].some(date => date >= wk && date <= end);
      // Only moves that one of this week's sessions (its mode and location) could have scheduled.
      const week = runs.filter(r => r.today >= wk && r.today <= end);
      // A move could have been the new move if some non-core slot that week accepted it (role and format limits).
      const fits = (ex: ExerciseRecord, g: Group, r: Run) => {
        const f = data.formats.find(x => x.id === g.format)!;
        const roles = data.skeleton.blocks[g.block]?.roles ?? [];
        return ex.roles.some(x => roles.includes(x) && f.roles.includes(x)) &&
          data.profiles.active.every(p => p.fitsFormat(ex.conditions[p.id]!, g.format)) && f.loads.includes(ex.load) && f.doseTypes.includes(ex.dose.type) &&
          Lib.eligible(data, ex, { equipment: r.equipment, mode: r.mode }) &&
          (g.format !== "superset" || g.items.some(partner => pairable(partner.exercise, ex)));
      };
      const couldSchedule = (ex: ExerciseRecord) => week.some(r => r.plan.groups.some(g => g.block !== "core" && fits(ex, g, r)));
      const unseen = data.exercises.filter(ex => couldSchedule(ex) && !(first.has(ex.id) && first.get(ex.id)! < wk));
      expect(newThisWeek || unseen.length === 0, `week of ${wk}: nothing new, ${unseen.length} unseen`).toBe(true);
    }
  });

  const repeats = (limit: number) => () => {
    const lists = runs.map(r => new Set(r.plan.items.filter(i => i.block === "prep" || i.block === "accessory").map(i => i.exercise.id)));
    for (let i = 0; i + 7 <= lists.length; i++) {
      const counts: Record<string, number> = {};
      for (const set of lists.slice(i, i + 7)) for (const id of set) counts[id] = (counts[id] || 0) + 1;
      for (const [id, n] of Object.entries(counts)) expect(n, `${id} appears in ${n} of sessions ${i + 1}–${i + 7}`).toBeLessThanOrEqual(limit);
    }
  };
  test(`simulation ${seed}: prep and accessory moves don't repeat in more than 4 of any 7 sessions (current library)`, repeats(4));
  // Spec target (§13). Holds since the Plan 4 library expansion (120 exercises, ~47 prep candidates at Home).
  test(`simulation ${seed}: prep and accessory moves don't repeat in more than 3 of any 7 sessions`, repeats(3));

  test(`simulation ${seed}: blocks last their five weeks, then rotate`, () => {
    const starts = [...new Set(runs.map(r => r.blockStart))];
    expect(starts.length, "never rotated").toBeGreaterThanOrEqual(2);
    for (let i = 1; i < starts.length; i++) expect(Hist.daysBetween(starts[i - 1]!, starts[i]!)).toBeGreaterThanOrEqual(35);
    expect([...new Set(runs.map(r => r.blockNumber))]).toEqual(starts.map((_, i) => i + 1));
  });

  test(`simulation ${seed}: the same seed replays the same 12 weeks`, () => {
    const again = simulate(seed);
    expect(JSON.stringify(again.sessions)).toBe(JSON.stringify(sessions));
  });
}
