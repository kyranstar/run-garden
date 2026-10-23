import { addDays } from "@rg/domain";
import { TMJ, type ExerciseRecord, type Mode } from "@rg/exercise-library";
import { describe, expect, test } from "vitest";
import { Blocks, Builder, Proposal, Rng, type Block, type BuildResult, type HistorySession } from "../src/index.js";
import { data, gym, home, place } from "./builder-fixtures.js";

// THE JAW-CARE BLOCK'S CONTENT (2026-10-23, after the TMJ evidence review): the block keeps its size, and leans on what
// the review supported — neck and posture training (chin nods / deep-neck-flexor endurance, shoulder-blade retraction
// and the lower traps, thoracic extension) and breathing / down-regulation, with a 2–5 minute breathing piece — beside
// jaw exercise. It is done through the care config: the block takes the moves with its role (`TMJ.care.block.roles`),
// and the library's own moves of those kinds carry that role. No move was authored for it.

const careRole = (ex: ExerciseRecord): boolean => ex.roles.some(r => TMJ.care!.block.roles.includes(r));
const POSTURE_MUSCLES = new Set<string>(["deep-neck-flexors", "lower-traps", "middle-traps", "rhomboids", "thoracic-extensors", "serratus-anterior"]);
/** Neck and posture training: the move works the deep neck flexors, the shoulder-blade muscles or the upper-back extensors. */
const postureWork = (ex: ExerciseRecord): boolean => ex.muscles.primary.some(m => POSTURE_MUSCLES.has(m));
const breathing = (ex: ExerciseRecord): boolean => ex.patterns.includes("breathe");
/** A breathing piece of 2–5 minutes as the care block plays it (a timed window at its range's middle). */
const longBreathing = (ex: ExerciseRecord): boolean => breathing(ex) && ex.dose.type === "time" && (ex.dose.range[0] + ex.dose.range[1]) / 2 >= 120 && (ex.dose.range[0] + ex.dose.range[1]) / 2 <= 300;

describe("the care pool holds each kind the review supports", () => {
  const pool = data.exercises.filter(careRole);
  const has = (ids: string[]) => expect(pool.map(e => e.id)).toEqual(expect.arrayContaining(ids));

  test("chin nods and deep-neck-flexor work", () => {
    has(["chinNodHold", "chinTuck"]);
    expect(pool.filter(e => e.muscles.primary.includes("deep-neck-flexors")).length).toBeGreaterThanOrEqual(2);
  });
  test("shoulder-blade retraction and the lower traps", () => {
    has(["wallAngels", "doorOpeners", "bandPullApart"]);
    expect(pool.some(e => e.muscles.primary.includes("lower-traps"))).toBe(true);
  });
  test("thoracic extension", () => {
    has(["chairThoracicExtension", "thoracicTowel", "thoracicBlock"]);
  });
  test("breathing and down-regulation, a 2–5 minute piece among them", () => {
    has(["downRegulationFlow", "breath", "supine9090Breathing"]);
    expect(pool.filter(longBreathing).map(e => e.id)).toContain("downRegulationFlow");
  });
  test("jaw exercise stays", () => {
    has(["jawOpen", "lateralExcursion", "jawIsoOpen", "jawIsoLateral", "goldfishOpening"]);
  });
  test("the block keeps its size", () => {
    expect(TMJ.care!.block).toMatchObject({
      formats: ["holds"],
      share: { recovery: 0.27, consistent: 0.1, build: 0.07 },
      min: { recovery: 3, consistent: 1, build: 1 },
      max: { recovery: 6, consistent: 3, build: 3 },
    });
  });
});

/** Twelve weeks of plausible use, four seeds: varied modes, places, lengths and checks, each plan "done". */
function weeks(): Array<{ mode: Mode; plan: BuildResult }> {
  const out: Array<{ mode: Mode; plan: BuildResult }> = [];
  for (const seed of ["alpha", "bravo", "charlie", "delta"]) {
    const rng = Rng.create(`care-block|${seed}`);
    const prefs = { ratings: {}, excluded: [], pinned: [] };
    const sessions: HistorySession[] = [];
    let block: Block | null = null;
    for (let d = 0; d < 84; d++) {
      const today = addDays("2026-06-01", d);
      const pre = rng() < 0.15 ? 5 : Math.floor(rng() * 4);
      if (rng() > 0.6) continue;
      block = Blocks.ensure(data, block, { today, equipment: home.equipment, prefs, weeks: 5, sessions }).block;
      const r = rng();
      const mode: Mode = pre >= 5 || r < 0.2 ? "recovery" : r < 0.6 ? "consistent" : "build";
      const theme = Proposal.theme(data, { mode, sessions, today }).theme;
      const location = rng() < 0.2 ? gym : rng() < 0.2 ? place("mat") : home;
      const minutes = [20, 30, 40, 60][Math.floor(rng() * 4)]!;
      const checks = { tmj: { pre, post: null, feelingOff: false } };
      const plan = Builder.build(data, { today, mode, theme, minutes, location, unit: "lb", sessions, prefs, block, checks, swaps: {} });
      out.push({ mode, plan });
      sessions.push({
        id: `care-${seed}-${d}`, date: today, startedAt: `${today}T18:00:00`, mode, theme: theme ? theme.id : null, blockNumber: null,
        checks: { tmj: { pre, post: pre, feelingOff: false } }, done: plan.items.map(it => ({ id: it.exercise.id, secs: 0 })), entries: [],
      });
    }
  }
  return out;
}

describe("the block as the engine plans it leans on neck and posture work and breathing", () => {
  const runs = weeks();
  const careOf = (plan: BuildResult) => plan.items.filter(i => i.block === "care").map(i => i.exercise);
  const training = runs.filter(r => r.mode !== "recovery");

  // Before (2026-10-22's pool), the same weeks ran: neck and posture work or breathing 16–22% of a consistent or build
  // care block's moves, and neck and posture work in 25–31% of those blocks; no 2–5 minute breathing piece at all.
  test("in consistent and build, at least 40% of the care moves are neck and posture work or breathing", () => {
    const moves = training.flatMap(r => careOf(r.plan));
    expect(moves.length).toBeGreaterThan(150);
    const leaning = moves.filter(ex => postureWork(ex) || breathing(ex)).length / moves.length;
    expect(leaning, `${(leaning * 100).toFixed(0)}%`).toBeGreaterThanOrEqual(0.4);
  });

  test("most consistent and build care blocks hold neck and posture work; nearly every recovery one does", () => {
    const share = (rs: typeof runs) => rs.filter(r => careOf(r.plan).some(postureWork)).length / rs.length;
    expect(share(training), "consistent and build").toBeGreaterThanOrEqual(0.5);
    expect(share(runs.filter(r => r.mode === "recovery")), "recovery").toBeGreaterThanOrEqual(0.75);
  });

  test("the 2–5 minute breathing piece comes up in the care block, as a 2–5 minute window", () => {
    const placed = runs.flatMap(r => r.plan.items.filter(i => i.block === "care" && longBreathing(i.exercise)).map(i => ({ plan: r.plan, slot: i.slotKey })));
    expect(placed.length).toBeGreaterThan(5);
    for (const { plan, slot } of placed) {
      const secs = plan.steps.filter(s => s.slotKey === slot && s.kind !== "rest").reduce((n, s) => n + s.seconds, 0);
      expect(secs, slot).toBeGreaterThanOrEqual(120);
      expect(secs, slot).toBeLessThanOrEqual(300);
    }
  });

  test("jaw exercise is still part of it", () => {
    const moves = runs.flatMap(r => careOf(r.plan));
    expect(moves.some(ex => ex.regions.includes("jaw") && !breathing(ex) && !postureWork(ex))).toBe(true);
  });
});
