/**
 * WHAT GOES ON THE WATCH, FROM REAL BUILDS (Phase 3; audit 3-A W-1, W-6, W-7). The engine and the shipped library
 * build the fixture athlete's session (`buildToday`, default mode), and the watch steps, the wire program and the
 * preview are read off it — no hand-made step. Synthetic athlete, library names only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXERCISES } from "@rg/exercise-library";
import { adaptiveConfigSchema, type UserPreferences } from "@rg/domain";
import { schema } from "@rg/database";
import { buildProgramWatchProgram } from "@rg/coros";
import type { Step } from "@rg/session-engine";
import type { Db } from "../src/services/db.js";
import { buildSession, type BuildPayload } from "../src/services/session-build.js";
import { exerciseNameMap } from "../src/services/exercise-catalog.js";
import { corosKeyOf } from "../src/services/coros-exercise-map.js";
import { catalogIdsByKey, watchPreview, watchStepsFromBuild, type WatchPlanDeps } from "../src/services/watch-push.js";
import { connectTestCoros, makeTestDb, makeTestUser } from "./helpers.js";
import { buildToday, DAY, NOON, PROGRAM_NAME, seedCatalog, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

vi.setConfig({ testTimeout: 60_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgramAs(PROGRAM_ID);
});
afterEach(() => vi.useRealTimers());

/** The build's seed is the date and the program id, so a fixed id makes the build the same every run. */
const PROGRAM_ID = "prog-0";

/** `seedProgram`'s program, under a fixed id. */
async function seedProgramAs(id: string): Promise<string> {
  await db.insert(schema.programs).values({
    id, userId, kind: "adaptive", name: PROGRAM_NAME, status: "active", disciplines: ["strength", "yoga"],
    startDate: null, endDate: null, raceDate: null, source: null,
    config: adaptiveConfigSchema.parse({ defaultMinutes: 30 }), createdAt: NOON, updatedAt: NOON, archivedAt: null,
  });
  return id;
}

const lateralityOf = new Map(EXERCISES.map((e) => [e.id, e.laterality]));

/** A set the engine prices as both sides (`setSeconds` × 2) but leaves unsided: one watch step per side. */
const oneSidedSets = (build: BuildPayload): Step[] =>
  build.steps.filter((s) => s.kind === "set" && s.side === null && s.exerciseId && lateralityOf.get(s.exerciseId) === "unilateral");

async function realDeps(): Promise<{ catalog: Map<string, string>; deps: WatchPlanDeps }> {
  const catalog = await exerciseNameMap(db);
  return { catalog, deps: { catalogIdByKey: catalogIdsByKey(catalog), keyOf: (id) => corosKeyOf(id) } };
}

describe("weights on the watch are kg; the preview carries the athlete's pounds beside them (W-7, ruling 3-R14)", () => {
  it("a pounds athlete's 25 lb set: 11340 g in kg on the wire, and the preview row carries 25 lb beside it", async () => {
    // The sheet renders "11.3 kg · 25 lb" (Task 8) from `grams` and `load`; the wire stays kg-only (owner decision).
    expect(prefs.weightUnit).toBe("lb");
    const workoutId = await seedSlot(db, userId, programId, DAY);
    const build = (await buildToday(db, userId, prefs, workoutId)).build!;
    const typed = build.steps.flatMap((s) => (s.target?.w ? [s.target.w] : []));
    expect(typed).toContainEqual({ v: 25, u: "lb" }); // supportedRow in the fixed-seed build
    expect(typed.every((w) => w.u === "lb")).toBe(true);

    const preview = await watchPreview(db, switchOn(), userId, workoutId, { today: DAY, now: NOON, prefs });
    const row = preview.steps.find((s) => s.grams === 11_340)!;
    expect(row).toMatchObject({ name: "One Arm Dumbbell Row", grams: 11_340, load: { v: 25, u: "lb" } });
    const weighted = preview.steps.filter((s) => s.grams !== null);
    expect(weighted.length).toBe(typed.length + oneSidedSets(build).filter((s) => s.target?.w).length); // a pair weighs twice
    for (const s of weighted) {
      expect(s.load?.u).toBe("lb");
      expect(Math.abs(s.load!.v * 453.59237 - s.grams!)).toBeLessThan(0.5 * 453.59237); // the same weight, to the half pound
    }
    expect(preview.steps.filter((s) => s.grams === null).every((s) => s.load === null)).toBe(true);

    // On the wire: kg × 1000, display unit "6" (kg) — never pounds (ruling 3-R14).
    const { catalog, deps } = await realDeps();
    const steps = watchStepsFromBuild(build, deps).steps;
    const program = buildProgramWatchProgram({ happenDay: "20261009", name: preview.stamp, session: { kind: "program_watch", title: PROGRAM_NAME, steps } }, catalog);
    const wire = (program.exercises as Array<Record<string, unknown>>).filter((e) => e.exerciseType !== 0 && Number(e.intensityCustom) === 0);
    expect(wire.length).toBe(weighted.length);
    expect(wire.every((e) => String(e.intensityDisplayUnit) === "6")).toBe(true);
    expect(wire.filter((e) => e.intensityValue === 11_340).length).toBe(preview.steps.filter((s) => s.grams === 11_340).length);

    // A kilos athlete sees the same grams, and kilos beside them.
    const kilos = await watchPreview(db, switchOn(), userId, workoutId, { today: DAY, now: NOON, prefs: { ...prefs, weightUnit: "kg" } });
    expect(kilos.steps.find((s) => s.grams === 11_340)!.load).toEqual({ v: 11.34, u: "kg" });
  });
});

describe("a one-sided set on the watch (W-1)", () => {
  it("the fixture's build: each one-sided set is a left/right pair in one container, the rest on the right", async () => {
    const workoutId = await seedSlot(db, userId, programId, DAY);
    const build = (await buildToday(db, userId, prefs, workoutId)).build!;
    const oneSided = oneSidedSets(build);
    expect(oneSided.length).toBeGreaterThanOrEqual(3); // supportedRow / doorframeRow / singleLegBridge, 3–6 a build

    const { catalog, deps } = await realDeps();
    const plan = watchStepsFromBuild(build, deps);
    const work = build.steps.filter((s) => s.kind !== "rest" && s.exerciseId && build.exercises[s.exerciseId]);
    expect(plan.steps).toHaveLength(work.length + oneSided.length);
    const lefts = plan.steps.flatMap((s, i) => (s.side === "left" ? [i] : []));
    for (const i of lefts) {
      const [left, right] = [plan.steps[i]!, plan.steps[i + 1]!];
      expect(right.side).toBe("right");
      // The same move, target and weight; only the side differs — in the overview, and in a free-text step's name.
      const same = (s: typeof left, label: RegExp) => ({ ...s, name: s.name.replace(label, ""), side: null, overview: "", restSeconds: 0 });
      expect(same(right, / \(R\)$/)).toEqual(same(left, / \(L\)$/));
      if (left.originId === "0") expect([left.name.endsWith(" (L)"), right.name.endsWith(" (R)")]).toEqual([true, true]);
      expect(left.overview.startsWith("left side")).toBe(true);
      expect(right.overview.startsWith("right side")).toBe(true);
    }

    // The wire: one sets-1 container per pair, two children (the spike-proven per-side shape).
    const program = buildProgramWatchProgram(
      { happenDay: "20261009", name: "Strength program — 2026-10-09", session: { kind: "program_watch", title: "Strength program", steps: plan.steps } },
      catalog,
    );
    const exercises = program.exercises as Array<Record<string, unknown>>;
    const containers = exercises.filter((e) => e.exerciseType === 0);
    const childrenOf = (id: unknown) => exercises.filter((e) => e.exerciseType !== 0 && String(e.groupId) === String(id));
    expect(containers).toHaveLength(plan.steps.length - lefts.length);
    expect(containers.filter((c) => childrenOf(c.id).length === 2)).toHaveLength(lefts.length);
    expect(containers.every((c) => Number(c.sets) === 1)).toBe(true);

    // The preview is the wire: the pair shows as two rows, the rest only under the right one.
    const preview = await watchPreview(db, switchOn(), userId, workoutId, { today: DAY, now: NOON, prefs });
    expect(preview.steps).toHaveLength(plan.steps.length);
    for (const i of lefts) {
      expect(preview.steps[i]!.overview.startsWith("left side")).toBe(true);
      expect(preview.steps[i]!.restSeconds).toBe(0);
      expect(preview.steps[i + 1]!.overview.startsWith("right side")).toBe(true);
    }
  });

  it("across 200 real builds (40 programs × 20–90 minutes) the watch holds at most 39 steps, far under the 200 limit", async () => {
    // Measured when the pairs went in: 22–39 steps, 2–6 one-sided sets a build; a 45+ minute session tops out at 39.
    const { deps } = await realDeps();
    let most = 0;
    let fewestOneSided = Infinity;
    for (let p = 1; p <= 40; p++) {
      const program = await seedProgramAs(`prog-${p}`);
      for (const minutes of [20, 30, 45, 60, 90]) {
        const workoutId = await seedSlot(db, userId, program, DAY, `slot-${p}-${minutes}`);
        const s = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } }, overrides: { minutes } }, { today: DAY, now: NOON, prefs });
        const plan = watchStepsFromBuild(s.build!, deps);
        expect(plan.refusal).toBeNull();
        const work = s.build!.steps.filter((x) => x.kind !== "rest" && x.exerciseId && s.build!.exercises[x.exerciseId]);
        expect(plan.steps).toHaveLength(work.length + oneSidedSets(s.build!).length);
        most = Math.max(most, plan.steps.length);
        fewestOneSided = Math.min(fewestOneSided, oneSidedSets(s.build!).length);
        // W-6: one watch name per move — its side label aside — and never one name for two moves.
        const oneSided = new Set(oneSidedSets(s.build!));
        const stepMoves = work.flatMap((x) => (oneSided.has(x) ? [x.exerciseId!, x.exerciseId!] : [x.exerciseId!]));
        const movesOf = new Map<string, Set<string>>();
        const namesOf = new Map<string, Set<string>>();
        plan.steps.forEach((x, i) => {
          const name = x.name.toLowerCase();
          movesOf.set(name, (movesOf.get(name) ?? new Set()).add(stepMoves[i]!));
          namesOf.set(stepMoves[i]!, (namesOf.get(stepMoves[i]!) ?? new Set()).add(name.replace(/ \((l|r)\)$/, "")));
        });
        expect([...movesOf.values()].every((m) => m.size === 1)).toBe(true);
        expect([...namesOf.values()].every((n) => n.size === 1)).toBe(true);
        expect(namesOf.size).toBe(new Set(work.map((x) => x.exerciseId)).size);
      }
    }
    expect(fewestOneSided).toBeGreaterThanOrEqual(1); // every build carries the case W-1 is about
    expect(most).toBeLessThanOrEqual(39);
  });
});
