/**
 * BUILD CPU (Phase 2 spec §2a "CPU budget"; ruling P1-R8): Workers on the free plan allow 10 ms of CPU per
 * request, and the spec budgets a build at p50 < 5 ms after warm-up over a 200-session history, alternatives
 * computed in the same pass. This times `composeBuild` — the engine's proposal, block upkeep, plan and
 * alternatives plus the payload and view — over a synthetic 200-session history (made with the engine itself,
 * TMJ active and cared for: the heavier case), and reports the parts around it.
 *
 * Timing on a shared runner measures the runner, so a fixed calibration loop runs before and after the builds and
 * the p50 is scaled to the reference machine the budgets were measured on (`× reference / calibration`). When the
 * runner is far from the reference (busy, or much faster), scaling is not trustworthy and every timing assertion
 * skips with the reason — never silently.
 *
 * History (ruling 2a-R6): the build cost ~11.5 ms p50 here at 200 sessions, linear in history, because every
 * module rescanned every session for every candidate. The engine now indexes the history once per build
 * (`HistIndex`): ~2.3–2.9 ms p50 here on the reference machine. The budgets are plain tests; the regression
 * ceiling is 1.5× that measurement.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import { adaptiveConfigSchema, addDays, newId } from "@rg/domain";
import { LOCATION_PRESETS, makeEngineData, EXERCISES } from "@rg/exercise-library";
import { Planner, Rng, type Block, type EngineLocation, type HistorySession } from "@rg/session-engine";
import { schema } from "@rg/database";
import { composeBuild, type ComposeInput } from "../src/services/session-build.js";
import type { EngineContext } from "../src/services/engine-inputs.js";
import { loadHistory } from "../src/services/engine-inputs.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

/** The calibration loop's median on the reference machine (Apple silicon, Node 21; measured 5.9–6.4 ms). */
const REFERENCE_CALIBRATION_MS = 6.2;
/** A runner this far from the reference (either way) is not scaled: the timing tests skip. */
const MAX_RUNNER_RATIO = 1.5;
const SPEC_BUDGET_P50_MS = 5;
const WORKERS_CPU_LIMIT_MS = 10;
/** The build measured 2.3–2.9 ms p50 on the reference machine (indexed history); 1.5× that means something got slower. */
const REGRESSION_CEILING_P50_MS = 4;
/** The accepted ceiling for a 40-minute build's payload (session-engine payload test, ruling P1-R8). */
const PAYLOAD_BUDGET_BYTES = 426_000;

const HISTORY_SESSIONS = 200;
const WARMUP = 5;
const MEASURED = 20;

/** Fixed work shaped like the engine's: small objects, property reads, sorting, string building. */
function calibrationLoop(): number {
  const rng = Rng.create("calibration");
  const items = Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}`, score: rng(), tags: [i % 7, i % 11] }));
  items.sort((a, b) => b.score - a.score);
  let total = 0;
  for (const it of items) total += it.tags[0]! * it.score + (it.id.length > 4 ? 1 : 0);
  return total + JSON.stringify(items.slice(0, 2000)).length;
}

function medianMs(f: () => unknown, runs: number): number {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    times.push(performance.now() - t);
  }
  return percentile(times, 50);
}

function percentile(xs: readonly number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const home: EngineLocation = {
  id: "home",
  name: "Home",
  equipment: [...LOCATION_PRESETS.find((l) => l.id === "home")!.equipment],
  implements: { kettlebell: [{ v: 8, u: "kg" }, { v: 12, u: "kg" }, { v: 16, u: "kg" }] },
};

const context: EngineContext = {
  prefs: { ratings: {}, excluded: [], pinned: [] },
  savedIds: [],
  location: home,
  locations: [home],
  unit: "kg",
  activeProfiles: ["tmj"],
  careProfiles: ["tmj"],
  config: adaptiveConfigSchema.parse({ defaultMinutes: 30, careProfiles: ["tmj"] }),
};

/** 200 plausible sessions: the engine plans each day's session and a log of it is kept, about 4 days a week. */
function synthesize(): { history: HistorySession[]; block: Block } {
  const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });
  const rng = Rng.create("bench-history");
  const history: HistorySession[] = [];
  let block: Block | null = null;
  for (let d = 0; history.length < HISTORY_SESSIONS; d++) {
    const date = addDays("2025-10-01", d);
    if (rng() > 0.6) continue;
    const pre = Math.floor(rng() * 4);
    const { view } = Planner.planToday(
      data,
      { today: date, day: { date, checks: { tmj: { pre, post: null, feelingOff: false } }, override: {}, swaps: {} } },
      {
        programId: "bench",
        settings: { unit: "kg", weeklyGoal: 4, blockWeeks: 5, defaultMinutes: [15, 30, 30, 40][d % 4]!, location: "home" },
        locations: [home],
        prefs: context.prefs,
        savedIds: [],
        block,
        sessions: history,
      },
    );
    block = view.block;
    history.push({
      id: `s${history.length}`,
      date,
      startedAt: `${date}T18:00:00.000Z`,
      mode: view.mode,
      theme: view.theme?.id ?? null,
      blockNumber: view.block.number,
      checks: { tmj: { pre, post: Math.max(0, pre - 1 + (rng() < 0.1 ? 3 : 0)), feelingOff: false } },
      done: view.plan.items.map((it) => ({ id: it.exercise.id, secs: 60 })),
      entries: view.plan.items
        .filter((it) => it.target)
        .map((it) => ({
          id: it.exercise.id,
          implement: null,
          perSide: false,
          format: it.format,
          flags: rng() < 0.05 ? ["clenched"] : [],
          sets: Array.from({ length: Math.max(1, it.sets) }, () => ({ w: it.target!.w, reps: it.target!.reps, secs: it.target!.secs })),
        })),
    });
  }
  return { history, block: block! };
}

let history: HistorySession[];
let block: Block;
let inputs: ComposeInput[];
let buildTimes: number[];
let calibration: number;
let slowReason: string | null;

beforeAll(() => {
  ({ history, block } = synthesize());
  const next = addDays(history[history.length - 1]!.date, 1);
  // 10 distinct requests (5 days × 30/40 minutes), each built twice.
  inputs = Array.from({ length: MEASURED }, (_, i) => ({
    date: addDays(next, i % 5),
    programId: "bench",
    context,
    block,
    history,
    checks: { tmj: { pre: 1, feelingOff: false } },
    overrides: { minutes: i % 2 === 0 ? 30 : 40 },
    swaps: {},
  }));
  const before = medianMs(calibrationLoop, 7);
  for (let i = 0; i < WARMUP; i++) composeBuild(inputs[i % inputs.length]!);
  buildTimes = inputs.map((input) => {
    const t = performance.now();
    composeBuild(input);
    return performance.now() - t;
  });
  const after = medianMs(calibrationLoop, 7);
  calibration = (before + after) / 2;
  const ratio = calibration / REFERENCE_CALIBRATION_MS;
  // Before and after must agree too: a runner whose speed changed mid-measurement cannot be scaled.
  const drift = Math.max(before, after) / Math.min(before, after);
  slowReason =
    ratio > MAX_RUNNER_RATIO || ratio < 1 / MAX_RUNNER_RATIO || drift > MAX_RUNNER_RATIO
      ? `runner at ${ratio.toFixed(2)}× the reference machine's speed (calibration ${before.toFixed(1)} / ` +
        `${after.toFixed(1)} ms before / after vs ${REFERENCE_CALIBRATION_MS} ms): a CPU timing here would measure ` +
        `the runner, not the build`
      : null;
  console.log(
    `[build CPU] ${HISTORY_SESSIONS}-session history, ${MEASURED} warm builds: p50 ${percentile(buildTimes, 50).toFixed(2)} ms, ` +
      `p95 ${percentile(buildTimes, 95).toFixed(2)} ms; scaled to the reference: p50 ${scaledP50().toFixed(2)} ms ` +
      `(calibration ${calibration.toFixed(2)} ms; reference ${REFERENCE_CALIBRATION_MS} ms)`,
  );
}, 120_000);

/** The p50 on the reference machine: the measured p50 scaled by how fast this runner ran the calibration loop. */
const scaledP50 = () => percentile(buildTimes, 50) * (REFERENCE_CALIBRATION_MS / calibration);

describe("build CPU over a 200-session history", () => {
  it("every build succeeds and fits its minutes", () => {
    for (const input of inputs.slice(0, 2)) {
      const { build } = composeBuild(input);
      expect(build.steps.length).toBeGreaterThan(0);
      expect(build.plannedSeconds).toBeLessThanOrEqual((input.overrides.minutes ?? 30) * 60);
    }
  });

  it(`does not get slower than measured (scaled p50 < ${REGRESSION_CEILING_P50_MS} ms)`, (ctx) => {
    ctx.skip(slowReason !== null, slowReason ?? "");
    expect(scaledP50()).toBeLessThan(REGRESSION_CEILING_P50_MS);
  });

  it(`stays under the Workers free-plan CPU limit (scaled p50 < ${WORKERS_CPU_LIMIT_MS} ms)`, (ctx) => {
    ctx.skip(slowReason !== null, slowReason ?? "");
    expect(scaledP50()).toBeLessThan(WORKERS_CPU_LIMIT_MS);
  });

  it(`meets the spec's budget (scaled p50 < ${SPEC_BUDGET_P50_MS} ms)`, (ctx) => {
    ctx.skip(slowReason !== null, slowReason ?? "");
    expect(scaledP50()).toBeLessThan(SPEC_BUDGET_P50_MS);
  });

  it("reports the parts around the build: the inputs hash and reading the history", async () => {
    const hashMs = medianMs(() => createHash("sha256").update(JSON.stringify(history)).digest("hex"), 11);
    // History as the worker reads it: 200 sessions with their sets, from the database (better-sqlite3 here; D1 in
    // production — this is the mapping's cost plus the local driver's, not the Workers figure).
    const db = makeTestDb({ boundVariableCap: 100 });
    const { userId } = await makeTestUser(db);
    const now = "2026-10-01T00:00:00.000Z";
    for (const s of history) {
      await db.insert(schema.performedSessions).values({
        id: s.id, userId, workoutId: null, activityId: null, buildId: null, source: "app", sourceRef: null,
        localDate: s.date, startedAt: s.startedAt, endedAt: null, seconds: 1800, plannedSeconds: 1800, minutes: 30,
        mode: s.mode, theme: s.theme, locationId: null, blockRef: null, blockNumber: s.blockNumber, completed: true,
        stepsTotal: null, stepsDone: null, movesDone: s.done.map((m) => ({ exerciseId: m.id, seconds: m.secs })), note: null,
        newMove: null, payloadHash: "h", createdAt: now, updatedAt: now,
      });
      const sets = s.entries.flatMap((e, entryIndex) =>
        e.sets.map((set, setIndex) => ({
          id: newId(), performedSessionId: s.id, entryIndex, exerciseId: e.id, implement: e.implement, format: e.format,
          perSide: e.perSide, setIndex, side: null, reps: set.reps, seconds: set.secs, loadValue: set.w?.v ?? null,
          loadUnit: set.w?.u ?? null, loadKg: null, done: true, flags: [...e.flags],
        })),
      );
      for (let i = 0; i < sets.length; i += 5) await db.insert(schema.performedSets).values(sets.slice(i, i + 5));
    }
    await loadHistory(db, userId);
    const reads: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      const loaded = await loadHistory(db, userId);
      reads.push(performance.now() - t);
      expect(loaded).toHaveLength(HISTORY_SESSIONS);
    }
    const setCount = history.reduce((n, s) => n + s.entries.reduce((m, e) => m + e.sets.length, 0), 0);
    console.log(
      `[build CPU] around the build: inputs hash ${hashMs.toFixed(2)} ms (history JSON ${JSON.stringify(history).length} B); ` +
        `loadHistory (${HISTORY_SESSIONS} sessions, ${setCount} sets, better-sqlite3) p50 ${percentile(reads, 50).toFixed(1)} ms`,
    );
    expect(hashMs).toBeGreaterThan(0);
  }, 60_000);

  it(`a 40-minute build's stored payload stays within ${PAYLOAD_BUDGET_BYTES.toLocaleString("en-US")} bytes`, () => {
    const sizes = (["consistent", "build"] as const).map((mode) => {
      const { build, view } = composeBuild({ ...inputs[0]!, overrides: { minutes: 40, mode } });
      return JSON.stringify({ build, view }).length;
    });
    const thirty = JSON.stringify(composeBuild(inputs[0]!)).length;
    console.log(`[payload] 40-minute builds: ${sizes.join(", ")} B; a 30-minute build: ${thirty} B`);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(PAYLOAD_BUDGET_BYTES);
  });
});
