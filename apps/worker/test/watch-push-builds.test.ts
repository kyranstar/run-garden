/**
 * WHAT GOES ON THE WATCH, FROM REAL BUILDS (Phase 3; audit 3-A W-1, W-6, W-7). The engine and the shipped library
 * build the fixture athlete's session (`buildToday`, default mode), and the watch steps, the wire program and the
 * preview are read off it — no hand-made step. Synthetic athlete, library names only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXERCISES } from "@rg/exercise-library";
import type { UserPreferences } from "@rg/domain";
import { buildProgramWatchProgram } from "@rg/coros";
import type { Step } from "@rg/session-engine";
import type { Db } from "../src/services/db.js";
import { buildSession, type BuildPayload } from "../src/services/session-build.js";
import { exerciseNameMap } from "../src/services/exercise-catalog.js";
import { corosKeyOf } from "../src/services/coros-exercise-map.js";
import { catalogIdsByKey, watchPreview, watchStepsFromBuild, type WatchPlanDeps } from "../src/services/watch-push.js";
import { connectTestCoros, makeTestDb, makeTestUser } from "./helpers.js";
import { buildToday, DAY, NOON, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

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
  programId = await seedProgram(db, userId);
});
afterEach(() => vi.useRealTimers());

const lateralityOf = new Map(EXERCISES.map((e) => [e.id, e.laterality]));

/** A set the engine prices as both sides (`setSeconds` × 2) but leaves unsided: one watch step per side. */
const oneSidedSets = (build: BuildPayload): Step[] =>
  build.steps.filter((s) => s.kind === "set" && s.side === null && s.exerciseId && lateralityOf.get(s.exerciseId) === "unilateral");

async function realDeps(): Promise<{ catalog: Map<string, string>; deps: WatchPlanDeps }> {
  const catalog = await exerciseNameMap(db);
  return { catalog, deps: { catalogIdByKey: catalogIdsByKey(catalog), keyOf: (id) => corosKeyOf(id) } };
}

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
      expect({ ...right, side: "left", overview: "", restSeconds: 0 }).toEqual({ ...left, overview: "", restSeconds: 0 });
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

  it("across real builds of 20–90 minutes the watch holds at most 38 steps, far under the 200 limit", async () => {
    const { deps } = await realDeps();
    let most = 0;
    for (const minutes of [20, 30, 45, 60, 90]) {
      const workoutId = await seedSlot(db, userId, programId, DAY, `slot-${minutes}`);
      const s = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } }, overrides: { minutes } }, { today: DAY, now: NOON, prefs });
      const plan = watchStepsFromBuild(s.build!, deps);
      expect(plan.refusal).toBeNull();
      expect(plan.steps.filter((x) => x.side === "left").length).toBeGreaterThanOrEqual(oneSidedSets(s.build!).length);
      most = Math.max(most, plan.steps.length);
    }
    expect(most).toBeLessThanOrEqual(38);
  });
});
