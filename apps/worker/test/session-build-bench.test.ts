/**
 * BUILD CPU (Phase 2 spec §2a "CPU budget"; rulings P1-R8, 2a-R6): Workers on the free plan allow 10 ms of CPU per
 * request, and the spec budgets a build at p50 < 5 ms after warm-up over a 200-session history, alternatives
 * computed in the same pass. This times `composeBuild` — the engine's proposal, block upkeep, plan and
 * alternatives plus the payload and view — over a synthetic 200-session history (made with the engine itself,
 * TMJ active and cared for: the heavier case) as the worker passes it: what `loadBuildHistory` reads of it (the
 * sessions the build reads one by one, and the all-time summary of the rest). It also times the request's other
 * history work — reading it (the JS side: mapping rows; the database's own work is not the Worker's CPU) and the
 * inputs hash — and checks the cost does not grow with the history. And it times the whole `buildSession` request
 * (ruling 2a-R8): context, checks, history, hash, build, the writes and the response, on a cache miss and a hit.
 *
 * Timing on a shared runner measures the runner, so a fixed calibration loop runs before and after the builds and
 * the p50 is scaled to the reference machine the budgets were measured on (`× reference / calibration`). When the
 * runner is far from the reference (busy, or much faster), scaling is not trustworthy and every timing assertion
 * skips with the reason — never silently.
 *
 * History (ruling 2a-R6): the build cost ~11.5 ms p50 here at 200 sessions, linear in history, because every
 * module rescanned every session for every candidate; the request read and hashed the whole history too. The
 * engine now indexes the history once per build (`HistIndex`) and the worker reads only what a build reads, so the
 * build costs ~1.3–2 ms here on the reference machine whatever the history's length. The regression ceiling is
 * 1.5× the measurement.
 */
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { adaptiveConfigSchema, addDays, newId, type UserPreferences } from "@rg/domain";
import { LOCATION_PRESETS, makeEngineData, EXERCISES } from "@rg/exercise-library";
import { Hist, Planner, Rng, type Block, type EngineLocation, type HistorySession } from "@rg/session-engine";
import { schema } from "@rg/database";
import type { Db } from "../src/services/db.js";
import { buildSession, composeBuild, sessionCurrency, type ComposeInput } from "../src/services/session-build.js";
import { slotId } from "../src/services/program-slots.js";
import { loadBuildHistory, loadHistory, type BuildHistory, type EngineContext } from "../src/services/engine-inputs.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

/** The calibration loop's median on the reference machine (Apple silicon, Node 21; measured 5.9–6.4 ms). */
const REFERENCE_CALIBRATION_MS = 6.2;
/** A runner this far from the reference (either way) is not scaled: the timing tests skip. */
const MAX_RUNNER_RATIO = 1.5;
const SPEC_BUDGET_P50_MS = 5;
const WORKERS_CPU_LIMIT_MS = 10;
/**
 * The whole build request (ruling 2a-R8): measured 5.7–7.0 ms scaled p50 (p95 8–11 ms) on a cache miss and 2.8–3.6 ms on
 * a cache hit, after the build stopped reading its own writes back — so the spec's 5 ms is met by the build itself,
 * not by the request around it, and the honest ceiling is the Workers limit. On Workers, D1 result deserialization,
 * the auth middleware and a calendar sync (now only when the event changes) come on top: the real invocation is
 * measured on staging before programs ship (the 2a-R8 gate).
 */
const REQUEST_CEILING_P50_MS = WORKERS_CPU_LIMIT_MS;
/** The build measured 1.3–2 ms p50 on the reference machine (trimmed, indexed history); 1.5× that means something got slower. */
const REGRESSION_CEILING_P50_MS = 3;
/** How much more a build may cost at 400 sessions than at 100 (it grew 4× when it read every session). */
const MAX_GROWTH_100_TO_400 = 1.3;
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

function times(f: () => unknown, runs: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    f();
    out.push(performance.now() - t);
  }
  return out;
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

/** Plausible sessions: the engine plans each day's session and a log of it is kept, about 4 days a week. */
function synthesize(n: number): { history: HistorySession[]; blocks: Block[] } {
  const data = makeEngineData({ activeProfiles: ["tmj"], careProfiles: ["tmj"], exercises: EXERCISES });
  const rng = Rng.create("bench-history");
  const history: HistorySession[] = [];
  const blocks: Block[] = [];
  let block: Block | null = null;
  for (let d = 0; history.length < n; d++) {
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
    blocks.push(block);
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
  return { history, blocks };
}

/** The history as the save writes it: sessions, their sets, their pre and post checks. */
async function store(db: Db, userId: string, history: readonly HistorySession[]): Promise<void> {
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
    for (const [profileId, c] of Object.entries(s.checks)) {
      for (const kind of ["pre", "post"] as const) {
        await db.insert(schema.conditionChecks).values({
          id: newId(), userId, profileId, kind, value: c[kind], feelingOff: false, localDate: s.date, at: s.startedAt!,
          performedSessionId: s.id, workoutId: null,
        });
      }
    }
  }
}

/** Time spent inside SQLite (running statements, building rows): on Workers that is D1's work, not the Worker's CPU. */
function sqliteClock(db: Db): { reset(): void; ms(): number; statements(): number } {
  const client = (db as unknown as { $client: Database.Database }).$client;
  let spent = 0;
  let count = 0;
  const prepare = client.prepare.bind(client);
  (client as unknown as { prepare: (src: string) => unknown }).prepare = (src: string) => {
    const stmt = prepare(src) as unknown as Record<string, unknown>;
    for (const method of ["all", "get", "run", "values"]) {
      const f = stmt[method];
      if (typeof f !== "function") continue;
      const bound = (f as (...a: unknown[]) => unknown).bind(stmt);
      stmt[method] = (...a: unknown[]) => {
        const t = performance.now();
        count += 1;
        try {
          return bound(...a);
        } finally {
          spent += performance.now() - t;
        }
      };
    }
    return stmt;
  };
  return { reset: () => { spent = 0; count = 0; }, ms: () => spent, statements: () => count };
}

let all: { history: HistorySession[]; blocks: Block[] };
let history: HistorySession[];
let db: Db;
let userId: string;
let prefs: UserPreferences;
let clock: ReturnType<typeof sqliteClock>;
let loaded: Map<string, BuildHistory>;
let inputs: ComposeInput[];
let buildTimes: number[];
let calibration: number;
let slowReason: string | null;

const blockAt = (n: number) => all.blocks[n - 1]!;
const firstDay = () => addDays(history[history.length - 1]!.date, 1);

beforeAll(async () => {
  all = synthesize(2 * HISTORY_SESSIONS);
  history = all.history.slice(0, HISTORY_SESSIONS);
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db));
  await store(db, userId, history);
  clock = sqliteClock(db);
  // 10 distinct requests (5 days × 30/40 minutes), each built twice, from what the worker reads for its day.
  const block = blockAt(HISTORY_SESSIONS);
  loaded = new Map();
  for (let i = 0; i < 5; i++) {
    const date = addDays(firstDay(), i);
    loaded.set(date, await loadBuildHistory(db, userId, date, block));
  }
  inputs = Array.from({ length: MEASURED }, (_, i) => {
    const date = addDays(firstDay(), i % 5);
    const h = loaded.get(date)!;
    return {
      date, programId: "bench", context, block, history: h.sessions, summary: h.summary,
      checks: { tmj: { pre: 1, feelingOff: false } }, overrides: { minutes: i % 2 === 0 ? 30 : 40 }, swaps: {},
    };
  });
  const before = percentile(times(calibrationLoop, 7), 50);
  for (let i = 0; i < WARMUP; i++) composeBuild(inputs[i % inputs.length]!);
  buildTimes = inputs.map((input) => times(() => composeBuild(input), 1)[0]!);
  const after = percentile(times(calibrationLoop, 7), 50);
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
    `[build CPU] ${HISTORY_SESSIONS}-session history (the build reads ${inputs[0]!.history.length} sessions + a summary of ` +
      `${Object.keys(inputs[0]!.summary!.moves).length} moves), ${MEASURED} warm builds: p50 ${percentile(buildTimes, 50).toFixed(2)} ms, ` +
      `p95 ${percentile(buildTimes, 95).toFixed(2)} ms; scaled to the reference: p50 ${scaled(percentile(buildTimes, 50)).toFixed(2)} ms ` +
      `(calibration ${calibration.toFixed(2)} ms; reference ${REFERENCE_CALIBRATION_MS} ms)`,
  );
}, 180_000);

/** A time on this runner scaled to the reference machine by how fast it ran the calibration loop. */
const scaled = (ms: number) => ms * (REFERENCE_CALIBRATION_MS / calibration);
const scaledP50 = () => scaled(percentile(buildTimes, 50));

/** The request's own CPU around the build: read the history (minus SQLite's work), hash it with the inputs. */
async function requestPath(date: string, block: Block | null): Promise<{ read: number; sqlite: number; hash: number; history: BuildHistory }> {
  let h: BuildHistory | null = null;
  const reads: number[] = [];
  const sqlite: number[] = [];
  for (let i = 0; i < 9; i++) {
    clock.reset();
    const t = performance.now();
    h = await loadBuildHistory(db, userId, date, block);
    const total = performance.now() - t;
    reads.push(total - clock.ms());
    sqlite.push(clock.ms());
  }
  const hash = percentile(times(() => createHash("sha256").update(JSON.stringify(h)).digest("hex"), 11), 50);
  return { read: percentile(reads.slice(2), 50), sqlite: percentile(sqlite.slice(2), 50), hash, history: h! };
}

describe("build CPU over a 200-session history", () => {
  it("every build succeeds and fits its minutes", () => {
    for (const input of inputs.slice(0, 2)) {
      const { build } = composeBuild(input);
      expect(build.steps.length).toBeGreaterThan(0);
      expect(build.plannedSeconds).toBeLessThanOrEqual((input.overrides.minutes ?? 30) * 60);
    }
  });

  it("the build from what the worker reads is the build from the whole history", () => {
    const strip = (c: ReturnType<typeof composeBuild>) => JSON.stringify(c);
    for (const input of inputs.slice(0, 10)) expect(strip(composeBuild(input)) === strip(composeBuild({ ...input, history, summary: undefined }))).toBe(true);
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

  it(`does not grow with the history (400 sessions cost under ${MAX_GROWTH_100_TO_400}× 100)`, (ctx) => {
    ctx.skip(slowReason !== null, slowReason ?? "");
    const p50At = (n: number) => {
      const whole = all.history.slice(0, n);
      const date = addDays(whole[whole.length - 1]!.date, 1);
      const block = blockAt(n);
      const input: ComposeInput = {
        date, programId: "bench", context, block, history: Hist.trim(whole, date, block), summary: Hist.summarize(whole, date),
        checks: { tmj: { pre: 1, feelingOff: false } }, overrides: {}, swaps: {},
      };
      for (let i = 0; i < WARMUP; i++) composeBuild(input);
      return percentile(times(() => composeBuild(input), 15), 50);
    };
    const at = Object.fromEntries([100, 200, 400].map((n) => [n, p50At(n)]));
    console.log(`[build CPU] growth: p50 ${Object.entries(at).map(([n, ms]) => `${n} sessions ${ms.toFixed(2)} ms`).join(", ")}`);
    expect(at[400]! / at[100]!).toBeLessThan(MAX_GROWTH_100_TO_400);
  });

  it(`the request around the build — reading the history, the inputs hash — stays well inside the CPU limit`, async (ctx) => {
    const path = await requestPath(firstDay(), blockAt(HISTORY_SESSIONS));
    // For comparison: the whole history, as every build read and hashed it before ruling 2a-R6.
    clock.reset();
    const t = performance.now();
    const whole = await loadHistory(db, userId);
    const wholeRead = performance.now() - t - clock.ms();
    const wholeHash = percentile(times(() => createHash("sha256").update(JSON.stringify(whole)).digest("hex"), 11), 50);
    const build = percentile(buildTimes, 50);
    console.log(
      `[request CPU] read ${path.read.toFixed(2)} ms (JS; SQLite's own work ${path.sqlite.toFixed(2)} ms, D1's on Workers) for ` +
        `${path.history.sessions.length} sessions + ${Object.keys(path.history.summary.moves).length} moves; inputs hash ` +
        `${path.hash.toFixed(2)} ms (${JSON.stringify(path.history).length} B); build ${build.toFixed(2)} ms → ` +
        `${(path.read + path.hash + build).toFixed(2)} ms. Before: read ${wholeRead.toFixed(2)} ms (JS) + hash ${wholeHash.toFixed(2)} ms ` +
        `(${JSON.stringify(whole).length} B) for ${whole.length} sessions.`,
    );
    expect(path.history.sessions.length).toBeLessThan(whole.length / 2);
    ctx.skip(slowReason !== null, slowReason ?? "");
    expect(scaled(path.read + path.hash + build)).toBeLessThan(WORKERS_CPU_LIMIT_MS / 2);
  }, 60_000);

  it(`the whole build request — inputs, hash, build, writes, response — stays under ${REQUEST_CEILING_P50_MS} ms scaled p50 (ruling 2a-R8)`, async (ctx) => {
    // A program slot on the day after the history, its block running, TMJ active and cared for, a place with bells.
    const now = "2026-10-01T12:00:00.000Z";
    const programId = "bench-program";
    await db.insert(schema.programs).values({
      id: programId, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"],
      startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ defaultMinutes: 30, careProfiles: ["tmj"] }), createdAt: now, updatedAt: now, archivedAt: null,
    });
    await db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2025-01-01", settings: {} });
    await db.insert(schema.locations).values({
      id: "home", userId, name: "Home", equipment: [...home.equipment], implements: { kettlebell: "8, 12, 16 kg" }, isDefault: true, createdAt: now, updatedAt: now,
    });
    const block = blockAt(HISTORY_SESSIONS);
    await db.insert(schema.programBlocks).values({
      id: "bench-block", programId, number: block.number, kind: "core_block", startDate: block.startedAt, weeks: block.weeks,
      intent: { core: block.core, rotations: [...block.rotations] }, createdAt: now, updatedAt: now,
    });
    const today = firstDay();
    const workoutId = slotId(programId, today);
    await db.insert(schema.plannedWorkouts).values({
      id: workoutId, userId, planId: programId, sourceWorkoutId: workoutId, title: "Mobility", category: "yoga", sport: "yoga",
      originalPlanDate: today, lastVerifiedCorosDate: "", effectiveDate: today, effectiveTime: "18:00",
      sourceContentFingerprint: "program", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
      corosSyncState: "calendar_only", completionState: "scheduled", origin: "program", contentState: "outline", createdAt: now, updatedAt: now,
    });
    const at = (i: number) => new Date(Date.parse(now) + i * 1000).toISOString();
    // Every request differs from the one before (30 / 40 minutes), so each one builds and writes: the cache-miss path.
    const miss = (i: number) => buildSession(db, userId, workoutId, { overrides: { minutes: i % 2 === 0 ? 30 : 40 } }, { today, now: at(i), prefs });
    const sample = async (run: () => Promise<unknown>) => {
      clock.reset();
      const t = performance.now();
      await run();
      return { js: performance.now() - t - clock.ms(), sqlite: clock.ms() };
    };
    for (let i = 0; i < WARMUP; i++) await miss(i);
    const before = percentile(times(calibrationLoop, 7), 50);
    const misses: Array<{ js: number; sqlite: number }> = [];
    for (let i = 0; i < MEASURED; i++) misses.push(await sample(() => miss(WARMUP + i)));
    const hits: Array<{ js: number; sqlite: number }> = [];
    for (let i = 0; i < 10; i++) hits.push(await sample(() => miss(WARMUP + MEASURED - 1)));
    const after = percentile(times(calibrationLoop, 7), 50);
    const cal = (before + after) / 2;
    const k = REFERENCE_CALIBRATION_MS / cal;
    const p = (xs: Array<{ js: number }>, q: number) => percentile(xs.map((x) => x.js), q);
    console.log(
      `[request CPU] whole build request (cache miss), ${MEASURED} warm requests: JS p50 ${p(misses, 50).toFixed(2)} ms, p95 ` +
        `${p(misses, 95).toFixed(2)} ms (SQLite's own work p50 ${percentile(misses.map((x) => x.sqlite), 50).toFixed(2)} ms, D1's on Workers); ` +
        `scaled to the reference: p50 ${(p(misses, 50) * k).toFixed(2)} ms, p95 ${(p(misses, 95) * k).toFixed(2)} ms. Cache hit: JS p50 ` +
        `${p(hits, 50).toFixed(2)} ms, scaled ${(p(hits, 50) * k).toFixed(2)} ms (calibration ${before.toFixed(1)} / ${after.toFixed(1)} ms; ` +
        `reference ${REFERENCE_CALIBRATION_MS} ms)`,
    );
    const ratio = cal / REFERENCE_CALIBRATION_MS;
    const drift = Math.max(before, after) / Math.min(before, after);
    const unscalable = ratio > MAX_RUNNER_RATIO || ratio < 1 / MAX_RUNNER_RATIO || drift > MAX_RUNNER_RATIO;
    ctx.skip(
      unscalable,
      `runner at ${ratio.toFixed(2)}× the reference machine's speed (calibration ${before.toFixed(1)} / ${after.toFixed(1)} ms): ` +
        `a CPU timing here would measure the runner, not the request`,
    );
    expect(p(misses, 50) * k).toBeLessThan(REQUEST_CEILING_P50_MS);
    expect(p(hits, 50) * k).toBeLessThan(REQUEST_CEILING_P50_MS);
  }, 120_000);

  it(`a 40-minute build's stored payload stays within ${PAYLOAD_BUDGET_BYTES.toLocaleString("en-US")} bytes`, () => {
    const sizes = (["consistent", "build"] as const).map((mode) => {
      const { build, view } = composeBuild({ ...inputs[0]!, overrides: { minutes: 40, mode } });
      return JSON.stringify({ build, view }).length;
    });
    const thirty = JSON.stringify(composeBuild(inputs[0]!)).length;
    console.log(`[payload] 40-minute builds: ${sizes.join(", ")} B; a 30-minute build: ${thirty} B`);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(PAYLOAD_BUDGET_BYTES);
  });

  it("asking whether the stored build is current (GET …/current) answers in bytes what a build request that finds it stored answers in ~100 KB", async () => {
    // Its own program and slot on the day after the history, TMJ active and cared for, a place with bells.
    const now = "2026-10-01T12:00:00.000Z";
    const programId = "bench-current";
    await db.insert(schema.programs).values({
      id: programId, userId, kind: "adaptive", name: "Mobility", status: "active", disciplines: ["yoga", "strength"],
      startDate: null, endDate: null, raceDate: null, source: null,
      config: adaptiveConfigSchema.parse({ defaultMinutes: 30, careProfiles: ["tmj"] }), createdAt: now, updatedAt: now, archivedAt: null,
    });
    await db.insert(schema.userConditions).values({ id: `${userId}:tmj`, userId, profileId: "tmj", active: true, since: "2025-01-01", settings: {} }).onConflictDoNothing();
    const block = blockAt(HISTORY_SESSIONS);
    await db.insert(schema.programBlocks).values({
      id: "bench-current-block", programId, number: block.number, kind: "core_block", startDate: block.startedAt, weeks: block.weeks,
      intent: { core: block.core, rotations: [...block.rotations] }, createdAt: now, updatedAt: now,
    });
    const today = firstDay();
    const workoutId = slotId(programId, today);
    await db.insert(schema.plannedWorkouts).values({
      id: workoutId, userId, planId: programId, sourceWorkoutId: workoutId, title: "Mobility", category: "yoga", sport: "yoga",
      originalPlanDate: today, lastVerifiedCorosDate: "", effectiveDate: today, effectiveTime: "18:00",
      sourceContentFingerprint: "program", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
      corosSyncState: "calendar_only", completionState: "scheduled", origin: "program", contentState: "outline", createdAt: now, updatedAt: now,
    });
    const ctx = { today, now, prefs };
    await buildSession(db, userId, workoutId, {}, ctx);
    // The route serialises what the service returns (`c.json`): that is in the request's CPU too.
    const sample = async (run: () => Promise<unknown>) => {
      clock.reset();
      const t = performance.now();
      const bytes = JSON.stringify(await run()).length;
      return { js: performance.now() - t - clock.ms(), sqlite: clock.ms(), statements: clock.statements(), bytes };
    };
    const hit = () => buildSession(db, userId, workoutId, {}, ctx);
    const ask = () => sessionCurrency(db, userId, workoutId, ctx);
    expect((await ask() as { current: boolean }).current).toBe(true);
    for (let i = 0; i < WARMUP; i++) {
      await hit();
      await ask();
    }
    type Sample = { js: number; sqlite: number; statements: number; bytes: number };
    const hits: Sample[] = [];
    const asks: Sample[] = [];
    for (let i = 0; i < MEASURED; i++) {
      hits.push(await sample(hit));
      asks.push(await sample(ask));
    }
    const p50 = (xs: Array<{ js: number }>) => percentile(xs.map((x) => x.js), 50);
    const sq = (xs: Array<{ sqlite: number }>) => percentile(xs.map((x) => x.sqlite), 50);
    console.log(
      `[current] GET …/current: JS p50 ${p50(asks).toFixed(2)} ms (scaled ${scaled(p50(asks)).toFixed(2)} ms), ${asks[0]!.statements} ` +
        `statements, SQLite's own work p50 ${sq(asks).toFixed(2)} ms, ${asks[0]!.bytes} B; POST …/build finding the build ` +
        `stored: JS p50 ${p50(hits).toFixed(2)} ms (scaled ${scaled(p50(hits)).toFixed(2)} ms), ${hits[0]!.statements} statements, ` +
        `SQLite ${sq(hits).toFixed(2)} ms, ${hits[0]!.bytes} B (${HISTORY_SESSIONS}-session history)`,
    );
    // Both read and hash the day's inputs (that is most of either's cost); the question answers in bytes, never
    // writes, and reads no more than the build request does. CPU is logged, not asserted: the two are within noise.
    expect(asks[0]!.statements).toBeLessThanOrEqual(hits[0]!.statements);
    expect(asks[0]!.bytes).toBeLessThan(200);
    expect(hits[0]!.bytes).toBeGreaterThan(50_000);
  }, 120_000);
});
