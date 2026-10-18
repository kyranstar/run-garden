/**
 * A WHOLE PLAN'S CPU, A CHUNK AT A TIME (§8 §4). On the Workers free plan a request has 10 ms of CPU. A plan is
 * applied a chunk a request (`applyStructuralChunk`), so the shapes that matter are one request's:
 *
 *  1. one create chunk: the sessions step of a 40-session createPlan with a thread approve's room
 *     (THREAD_CHUNK_BUDGET) — each session's row, its workout document and revision, its stage rows with their pace
 *     bands, its watch create under its stamp, built and run as one batch;
 *  2. one archive slice: Retire's slice over 36 sessions, a third of them on the watch;
 *  3. `validateOps` over a 40-session createPlan, against a calendar of 60 sessions — the guardrails a plan proposal
 *     is checked by (§8 §5) before it is stored.
 *
 * THE WORKER'S CPU is the call's time less SQLite's own (preparing and running each statement): on Workers that is
 * D1's. The Worker's side of D1's wire — the parameters sent as JSON, the rows parsed back — is counted in. Timed like
 * the other benches (coach-runs-bench.test.ts): a calibration loop before and after, times scaled to the reference
 * machine; on CI, or on a runner far from the reference, the timing assertions skip with the reason. Each run starts
 * from the same database (a copy). Synthetic data only.
 */
import { performance } from "node:perf_hooks";
import type Database from "better-sqlite3";
import { beforeAll, describe, expect, it } from "vitest";
import { addDays, startOfIsoWeek, todayInZone, validateOps, type CoachOp, type CoachSession, type GuardrailCtx, type UserPreferences } from "@rg/domain";
import { Rng } from "@rg/session-engine";
import { schema } from "@rg/database";
import { eq } from "drizzle-orm";
import type { Db } from "../src/services/db.js";
import { applyStructuralChunk, type StructuralProgress } from "../src/services/coach-apply.js";
import { RETIRE_CHUNK_BUDGET, THREAD_CHUNK_BUDGET } from "../src/routes/thread-structural.js";
import { cloneTestDb, makeTestDb, makeTestUser } from "./helpers.js";

const ON_CI = process.env.CI === "true";
const REFERENCE_CALIBRATION_MS = 6.2;
const MAX_RUNNER_RATIO = 1.5;
const RUNS = 21;
const WARMUP = 3;
/**
 * Each shape's ceiling, scaled p50: under the design benches' 6 ms a request (GO_LIVE_BUDGET_MS) with its route's own
 * work on top. Measured at 2026-10-18 (load 3.9, calibration 6.3 / 5.8): a create chunk of 11 five-block runs 3.5 ms,
 * an archive slice of 36 with 12 unpushes 1.7, validateOps over 40 sessions 0.3.
 */
const CEILING_MS = { createChunk: 5, archiveSlice: 3, validateOps40: 1 };

function calibrationLoop(): number {
  const rng = Rng.create("calibration");
  const items = Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}`, score: rng(), tags: [i % 7, i % 11] }));
  items.sort((a, b) => b.score - a.score);
  let total = 0;
  for (const it of items) total += it.tags[0]! * it.score + (it.id.length > 4 ? 1 : 0);
  return total + JSON.stringify(items.slice(0, 2000)).length;
}
const p50 = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
function calibrate(): number {
  const out: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    calibrationLoop();
    out.push(performance.now() - t);
  }
  return p50(out);
}

/** SQLite's own time on a client: every prepare and every run, the wire's JSON left in the Worker's time. */
function sqliteClock(db: Db): { reset(): void; ms(): number } {
  const client = (db as unknown as { $client: Database.Database }).$client;
  let ms = 0;
  const prepare = client.prepare.bind(client);
  (client as unknown as { prepare: (src: string) => unknown }).prepare = (src: string) => {
    const t0 = performance.now();
    const stmt = prepare(src) as unknown as Record<string, unknown>;
    ms += performance.now() - t0;
    for (const method of ["all", "get", "run", "values"]) {
      const f = stmt[method];
      if (typeof f !== "function") continue;
      const bound = (f as (...a: unknown[]) => unknown).bind(stmt);
      stmt[method] = (...a: unknown[]) => {
        JSON.stringify(a);
        const t1 = performance.now();
        const out = bound(...a);
        ms += performance.now() - t1;
        JSON.parse(out === undefined ? "null" : JSON.stringify(out));
        return out;
      };
    }
    return stmt;
  };
  return { reset: () => (ms = 0), ms: () => ms };
}

const run = (title: string, minutes: number, intensity: string): CoachSession =>
  ({
    category: intensity === "easy" ? "easy" : "quality",
    title,
    durationMinutes: minutes,
    run: {
      blocks: [
        { kind: "duration", value: 12, intensity: "easy" },
        { kind: "duration", value: 5, intensity },
        { kind: "duration", value: 2, intensity: "recovery" },
        { kind: "duration", value: 5, intensity },
        { kind: "duration", value: minutes - 24, intensity: "easy" },
      ],
    },
  }) as CoachSession;

interface Base {
  db: Db;
  userId: string;
  prefs: UserPreferences;
  monday: string;
}

async function base(): Promise<Base> {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
  const monday = addDays(startOfIsoWeek(todayInZone(prefs.timezone)), 7);
  // A threshold, so every run's stage rows carry pace bands.
  await db.insert(schema.dailyHealth).values({ id: `${userId}:t`, userId, date: addDays(monday, -8), thresholdPaceSecPerKm: 270, contentFingerprint: "f", updatedAt: new Date().toISOString() });
  return { db, userId, prefs, monday };
}

const plan40 = (monday: string): CoachOp => ({
  kind: "createPlan",
  discipline: "run",
  name: "10K block",
  startDate: monday,
  endDate: addDays(monday, 69),
  firmSessions: Array.from({ length: 40 }, (_, i) => ({ date: addDays(monday, i), session: run(`Session ${i}`, 45 + (i % 4) * 5, i % 3 === 1 ? "threshold" : "steady") })),
  shapeWeeks: [0, 1, 2, 3].map((i) => ({ weekStart: addDays(monday, 42 + 7 * i), volumeTarget: "40 km", keySessions: ["long run", "tempo"] })),
});

/** Time `call` on a fresh copy of `start` each run: the Worker's part (the call less SQLite's). */
async function timeOn(start: Db, call: (db: Db) => Promise<unknown>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < WARMUP + RUNS; i++) {
    const db = cloneTestDb(start);
    const clock = sqliteClock(db);
    clock.reset();
    const t = performance.now();
    await call(db);
    const worker = performance.now() - t - clock.ms();
    if (i >= WARMUP) out.push(worker);
  }
  return out;
}

const measured: Record<keyof typeof CEILING_MS, number[]> = { createChunk: [], archiveSlice: [], validateOps40: [] };
let calibration = 0;
let spent: Record<string, number> = {};

beforeAll(async () => {
  const before = calibrate();

  // 1. One create chunk: the plan row and weeks already written, then the first sessions chunk.
  const a = await base();
  const op = plan40(a.monday);
  const started = await applyStructuralChunk(a.db, { userId: a.userId, proposalId: "bench", opIndex: 0, op, progress: null, budget: 1, now: new Date(), prefs: a.prefs });
  expect(started).toMatchObject({ status: "more", progress: { step: "sessions" } });
  const at = (started as { progress: StructuralProgress }).progress;
  measured.createChunk = await timeOn(a.db, async (db) => {
    const r = await applyStructuralChunk(db, { userId: a.userId, proposalId: "bench", opIndex: 0, op, progress: at, budget: THREAD_CHUNK_BUDGET, now: new Date(), prefs: a.prefs });
    spent.createChunk = r.spent;
    spent.createChunkSessions = (r as { progress: StructuralProgress }).progress.done;
  });

  // 2. One archive slice: a plan of 36 sessions, every third on the watch.
  const b = await base();
  const seed = plan40(b.monday);
  for (let p: StructuralProgress | null = null, i = 0; i < 100; i++) {
    const r = await applyStructuralChunk(b.db, { userId: b.userId, proposalId: "seed", opIndex: 0, op: seed, progress: p, budget: 1000, now: new Date(), prefs: b.prefs });
    if (r.status !== "more") break;
    p = r.progress;
  }
  for (let n = 0; n < 40; n += 3) {
    await b.db
      .update(schema.plannedWorkouts)
      .set({ sourceWorkoutId: `9000:${n + 1}`, sourceIdInPlan: String(n + 1), sourceProgramId: `77${n}`, lastVerifiedCorosDate: addDays(b.monday, n) })
      .where(eq(schema.plannedWorkouts.id, `cw-seed-0-${n}`));
    await b.db.update(schema.corosWriteJobs).set({ status: "verified", verifiedAt: new Date().toISOString() }).where(eq(schema.corosWriteJobs.id, `cw-seed-0-${n}-push`));
  }
  const retire: CoachOp = { kind: "retirePlan", planId: "cp-seed-0" };
  const checked = await applyStructuralChunk(b.db, { userId: b.userId, proposalId: "r", opIndex: 0, op: retire, progress: null, budget: 1, now: new Date(), prefs: b.prefs });
  const atArchive = (checked as { progress: StructuralProgress }).progress;
  measured.archiveSlice = await timeOn(b.db, async (db) => {
    const r = await applyStructuralChunk(db, { userId: b.userId, proposalId: "r", opIndex: 0, op: retire, progress: atArchive, budget: RETIRE_CHUNK_BUDGET, now: new Date(), prefs: b.prefs });
    spent.archiveSlice = r.spent;
  });

  // 3. validateOps over a 40-session plan, against 60 sessions on the calendar and four weeks of history.
  const today = todayInZone("America/Los_Angeles");
  const ctx: GuardrailCtx = {
    today,
    workouts: Array.from({ length: 60 }, (_, i) => ({
      id: `w${i}`, date: addDays(today, i - 10), title: `Session ${i}`, category: i % 3 === 0 ? "quality" : "easy",
      completionState: i < 10 ? "completed" : "scheduled", durationMinutes: 45, discipline: i % 4 === 0 ? "strength" : "run",
    })),
    weeklyMinutesByDiscipline: { run: [180, 200, 210, 220], strength: [60, 60, 90, 60] },
    raceDates: [addDays(today, 70)],
    firmHorizonEnd: addDays(today, 14),
    rules: [{ id: "r1", kind: "anchor_day", category: "long", weekday: 7 }],
    coachPlanIds: ["cp1"],
    datedEvents: [],
  };
  const ops = [plan40(addDays(startOfIsoWeek(today), 7))];
  for (let i = 0; i < WARMUP; i++) validateOps(ops, ctx);
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    validateOps(ops, ctx);
    measured.validateOps40.push(performance.now() - t);
  }

  const after = calibrate();
  calibration = (before + after) / 2;
  const scaled = (ms: number) => ms * (REFERENCE_CALIBRATION_MS / calibration);
  console.log(
    `[plan CPU] calibration ${before.toFixed(1)} / ${after.toFixed(1)} ms vs ${REFERENCE_CALIBRATION_MS}; ` +
      Object.entries(measured)
        .map(([k, xs]) => `${k}: p50 ${p50(xs).toFixed(2)} ms raw, ${scaled(p50(xs)).toFixed(2)} scaled`)
        .join("; ") +
      `; spent ${JSON.stringify(spent)}`,
  );
}, 120_000);

describe("a plan's chunks within the Workers free plan's CPU", () => {
  it("one create chunk fills its room: a dozen sessions, about", () => {
    expect(spent.createChunk).toBeLessThanOrEqual(THREAD_CHUNK_BUDGET);
    expect(spent.createChunkSessions).toBeGreaterThanOrEqual(6);
  });

  for (const shape of Object.keys(CEILING_MS) as (keyof typeof CEILING_MS)[]) {
    it(`${shape}: under ${CEILING_MS[shape]} ms scaled p50`, (ctx) => {
      const ratio = calibration / REFERENCE_CALIBRATION_MS;
      if (ON_CI) ctx.skip("on CI: timings printed, not asserted");
      if (ratio > MAX_RUNNER_RATIO || ratio < 1 / MAX_RUNNER_RATIO) {
        ctx.skip(`runner at ${ratio.toFixed(2)}× the reference machine's speed: a CPU timing here would measure the runner`);
      }
      expect(p50(measured[shape]) * (REFERENCE_CALIBRATION_MS / calibration)).toBeLessThan(CEILING_MS[shape]);
    });
  }
});
