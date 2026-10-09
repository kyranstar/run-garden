/**
 * WHAT ONE HOURLY INVOCATION SPENDS, step by step (cron reliability, part 2).
 *
 * On the Workers free plan 26 of 177 hourly `reconcile` runs were killed part-way (left `running`, no error row),
 * in clusters that follow new activities. This measures every step of `hourly()` on a realistic account
 * (`realistic-account.ts`) in the state right after new activities landed — two queued coach reads, a garden two
 * days behind — and again in the steady state an hour later: CPU (node, and node minus SQLite's own time — D1 runs
 * the SQL outside the Worker, so the remainder is the Worker's share), D1 statements, rows handed back, fetches.
 *
 * Timings are printed, never asserted here: node runs this several times faster than workerd. The bounds the fixes
 * pin are counts, in their own suites.
 */
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { desc, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { isWrite, makeTestDb } from "./helpers.js";
import { seedRealisticAccount } from "./realistic-account.js";
import { buildEffortPackage } from "../src/services/coach-effort.js";
import { chatCompletion } from "../src/services/studio-llm.js";
import { Rng } from "@rg/session-engine";

/** session-build-bench's calibration loop: its median is 6.2 ms on the reference machine (Apple silicon, Node 21). */
const REFERENCE_CALIBRATION_MS = 6.2;
function calibrationLoop(): number {
  const rng = Rng.create("calibration");
  const items = Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}`, score: rng(), tags: [i % 7, i % 11] }));
  items.sort((a, b) => b.score - a.score);
  let total = 0;
  for (const it of items) total += it.tags[0]! * it.score + (it.id.length > 4 ? 1 : 0);
  return total + JSON.stringify(items.slice(0, 2000)).length;
}
function calibrationMs(): number {
  const xs: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    calibrationLoop();
    xs.push(performance.now() - t);
  }
  return xs.sort((a, b) => a - b)[3]!;
}

interface StepRecord {
  name: string;
  cpuMs: number;
  sqliteMs: number;
  wallMs: number;
  statements: number;
  writes: number;
  rows: number;
  fetches: number;
  heapMb: number;
}

const meter = vi.hoisted(() => {
  const m = {
    on: false,
    statements: 0,
    writes: 0,
    rows: 0,
    sqliteMs: 0,
    fetches: () => 0,
    steps: [] as Array<Record<string, number | string>>,
    depth: 0,
    snap() {
      const cpu = process.cpuUsage();
      return {
        cpu: (cpu.user + cpu.system) / 1000,
        wall: performance.now(),
        statements: m.statements,
        writes: m.writes,
        rows: m.rows,
        sqliteMs: m.sqliteMs,
        fetches: m.fetches(),
        heap: process.memoryUsage().heapUsed / 1048576,
      };
    },
    wrap<A extends unknown[], R>(name: string, fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
      return async (...a: A) => {
        if (!m.on || m.depth > 0) return fn(...a);
        m.depth += 1;
        const b = m.snap();
        try {
          return await fn(...a);
        } finally {
          const e = m.snap();
          m.depth -= 1;
          m.steps.push({
            name,
            cpuMs: e.cpu - b.cpu,
            sqliteMs: e.sqliteMs - b.sqliteMs,
            wallMs: e.wall - b.wall,
            statements: e.statements - b.statements,
            writes: e.writes - b.writes,
            rows: e.rows - b.rows,
            fetches: e.fetches - b.fetches,
            heapMb: e.heap - b.heap,
          });
        }
      };
    },
  };
  return m;
});

vi.mock("../src/services/program-slots.js", async (orig) => {
  const real = await orig<typeof import("../src/services/program-slots.js")>();
  return { ...real, placeSlotsForAllPrograms: meter.wrap("placeSlotsForAllPrograms", real.placeSlotsForAllPrograms) };
});
vi.mock("../src/services/reconcile-daily.js", async (orig) => {
  const real = await orig<typeof import("../src/services/reconcile-daily.js")>();
  return { ...real, reconcileCompletionStates: meter.wrap("reconcileCompletionStates", real.reconcileCompletionStates) };
});
vi.mock("../src/services/garden-sync.js", async (orig) => {
  const real = await orig<typeof import("../src/services/garden-sync.js")>();
  return {
    ...real,
    advanceGarden: meter.wrap("advanceGarden", real.advanceGarden),
    resimulateFrom: meter.wrap("resimulateFrom", real.resimulateFrom),
  };
});
vi.mock("../src/services/heal-legacy-sync.js", async (orig) => {
  const real = await orig<typeof import("../src/services/heal-legacy-sync.js")>();
  return { ...real, healLegacySyncState: meter.wrap("healLegacySyncState", real.healLegacySyncState) };
});
vi.mock("../src/services/coach-triggers.js", async (orig) => {
  const real = await orig<typeof import("../src/services/coach-triggers.js")>();
  return { ...real, evaluateTriggers: meter.wrap("evaluateTriggers", real.evaluateTriggers) };
});
vi.mock("../src/routes/coach.js", async (orig) => {
  const real = await orig<typeof import("../src/routes/coach.js")>();
  return { ...real, sweepUserProposals: meter.wrap("sweepUserProposals", real.sweepUserProposals) };
});
vi.mock("../src/services/coach-reads.js", async (orig) => {
  const real = await orig<typeof import("../src/services/coach-reads.js")>();
  return {
    ...real,
    processCoachReads: meter.wrap("processCoachReads", real.processCoachReads),
    enqueueCoachReads: meter.wrap("enqueueCoachReads", real.enqueueCoachReads),
  };
});
vi.mock("../src/services/coros-write-cloud.js", async (orig) => {
  const real = await orig<typeof import("../src/services/coros-write-cloud.js")>();
  return { ...real, executeCloudJobs: meter.wrap("executeCloudJobs", real.executeCloudJobs) };
});

vi.mock("../src/services/completion.js", async (orig) => {
  const real = await orig<typeof import("../src/services/completion.js")>();
  return { ...real, ingestActivities: meter.wrap("ingestActivities", real.ingestActivities) };
});
vi.mock("../src/services/import-plan.js", async (orig) => {
  const real = await orig<typeof import("../src/services/import-plan.js")>();
  return { ...real, importPlanSnapshot: meter.wrap("importPlanSnapshot", real.importPlanSnapshot) };
});
vi.mock("../src/services/health-ingest.js", async (orig) => {
  const real = await orig<typeof import("../src/services/health-ingest.js")>();
  return { ...real, ingestDailyHealth: meter.wrap("ingestDailyHealth", real.ingestDailyHealth) };
});

import { hourly } from "../src/index.js";
import { corosReadSweep } from "../src/services/coros-read.js";
import { addDays, startOfIsoWeek, todayInZone } from "@rg/domain";

afterEach(() => {
  vi.unstubAllGlobals();
  meter.on = false;
});

const f = (n: number, d = 1) => n.toFixed(d).padStart(8);

function table(
  title: string,
  steps: StepRecord[],
  total: StepRecord,
  labels: { rest: string; total: string } = { rest: "(loop: runs, prefs, marker)", total: "TOTAL hourly()" },
): string {
  const head = `${"step".padEnd(28)} ${"cpu ms".padStart(8)} ${"sql ms".padStart(8)} ${"js ms".padStart(8)} ${"wall".padStart(8)} ${"stmts".padStart(6)} ${"writes".padStart(6)} ${"rows".padStart(7)} ${"fetch".padStart(5)} ${"heap MB".padStart(8)}`;
  const line = (s: StepRecord) =>
    `${s.name.padEnd(28)} ${f(s.cpuMs)} ${f(s.sqliteMs)} ${f(s.cpuMs - s.sqliteMs)} ${f(s.wallMs)} ${String(s.statements).padStart(6)} ${String(s.writes).padStart(6)} ${String(s.rows).padStart(7)} ${String(s.fetches).padStart(5)} ${f(s.heapMb)}`;
  const accounted = steps.reduce(
    (a, s) => ({ ...a, cpuMs: a.cpuMs + s.cpuMs, sqliteMs: a.sqliteMs + s.sqliteMs, wallMs: a.wallMs + s.wallMs, statements: a.statements + s.statements, writes: a.writes + s.writes, rows: a.rows + s.rows, fetches: a.fetches + s.fetches, heapMb: 0 }),
    { name: "", cpuMs: 0, sqliteMs: 0, wallMs: 0, statements: 0, writes: 0, rows: 0, fetches: 0, heapMb: 0 },
  );
  const rest: StepRecord = {
    name: labels.rest,
    cpuMs: total.cpuMs - accounted.cpuMs,
    sqliteMs: total.sqliteMs - accounted.sqliteMs,
    wallMs: total.wallMs - accounted.wallMs,
    statements: total.statements - accounted.statements,
    writes: total.writes - accounted.writes,
    rows: total.rows - accounted.rows,
    fetches: total.fetches - accounted.fetches,
    heapMb: 0,
  };
  return [title, head, ...steps.map(line), line(rest), line({ ...total, name: labels.total })].join("\n");
}

const SWEEP_LABELS = { rest: "(rest: client, wire, parse)", total: "TOTAL corosReadSweep()" };

async function measureHourly(run: () => Promise<void>): Promise<{ steps: StepRecord[]; total: StepRecord }> {
  meter.steps = [];
  meter.on = true;
  const b = meter.snap();
  await run();
  const e = meter.snap();
  meter.on = false;
  return {
    steps: meter.steps as unknown as StepRecord[],
    total: {
      name: "total",
      cpuMs: e.cpu - b.cpu,
      sqliteMs: e.sqliteMs - b.sqliteMs,
      wallMs: e.wall - b.wall,
      statements: e.statements - b.statements,
      writes: e.writes - b.writes,
      rows: e.rows - b.rows,
      fetches: e.fetches - b.fetches,
      heapMb: e.heap - b.heap,
    },
  };
}

function hookedDb() {
  return makeTestDb({
    boundVariableCap: 100,
    onStatement: (sql) => {
      meter.statements += 1;
      if (isWrite(sql)) meter.writes += 1;
    },
    onRows: (_sql, n) => {
      meter.rows += n;
    },
    onExec: (_sql, ms) => {
      meter.sqliteMs += ms;
    },
  });
}

function cpuMedian(fn: () => Promise<unknown>, runs: number): Promise<number> {
  return (async () => {
    const xs: number[] = [];
    for (let i = 0; i < runs; i++) {
      const b = process.cpuUsage();
      await fn();
      const e = process.cpuUsage(b);
      xs.push((e.user + e.system) / 1000);
    }
    return xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  })();
}

describe("hourly() per step on a realistic account", () => {
  it("prints what each step spends after new activities land, and an hour later", { timeout: 120_000 }, async () => {
    // A first account JITs every path (what a cold isolate pays); the second is measured warm.
    const calibration = calibrationMs();
    const first = hookedDb();
    const firstAcct = await seedRealisticAccount(first);
    vi.stubGlobal("fetch", firstAcct.fetchImpl);
    meter.fetches = () => firstAcct.fetches.coros + firstAcct.fetches.llm;
    const cold = await measureHourly(() => hourly(first, firstAcct.env));

    const db = hookedDb();
    const seedStart = performance.now();
    const acct = await seedRealisticAccount(db);
    const seedMs = performance.now() - seedStart;
    vi.stubGlobal("fetch", acct.fetchImpl);
    meter.fetches = () => acct.fetches.coros + acct.fetches.llm;

    const counts = {
      activities: (await db.select({ id: schema.activities.id }).from(schema.activities).where(eq(schema.activities.userId, acct.userId))).length,
      workouts: (await db.select({ id: schema.plannedWorkouts.id }).from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.userId, acct.userId))).length,
      coachReads: (await db.select({ id: schema.coachReads.id }).from(schema.coachReads).where(eq(schema.coachReads.userId, acct.userId))).length,
      plants: (await db.select({ id: schema.gardenPlants.id }).from(schema.gardenPlants).where(eq(schema.gardenPlants.userId, acct.userId))).length,
      events: (await db.select({ id: schema.gardenEvents.id }).from(schema.gardenEvents).where(eq(schema.gardenEvents.userId, acct.userId))).length,
      snapshotBytes: JSON.stringify((await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, acct.userId)))[0]?.snapshot ?? {}).length,
      lastSimulated: (await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, acct.userId)))[0]?.lastSimulatedDate,
    };

    const fresh = await measureHourly(() => hourly(db, acct.env));
    // The runs after it, until nothing is left to do (what each one spent its heavy step on), then a steady one.
    const nextHours: string[] = [];
    let next = await measureHourly(() => hourly(db, acct.env));
    for (let i = 0; i < 6; i++) {
      const [run] = await db
        .select()
        .from(schema.syncRuns)
        .where(eq(schema.syncRuns.kind, "reconcile"))
        .orderBy(desc(schema.syncRuns.startedAt), desc(schema.syncRuns.id))
        .limit(1);
      const heavy = (run?.stats as { heavyStep?: string | null } | null)?.heavyStep;
      nextHours.push(`${heavy ?? "none"} (${next.total.cpuMs.toFixed(1)} ms, ${next.total.statements} stmts, ${next.total.fetches} fetches)`);
      if (heavy === null) break;
      next = await measureHourly(() => hourly(db, acct.env));
    }
    const steady = await measureHourly(() => hourly(db, acct.env));

    // Inside a coach read, warm: the package, and the streamed answer.
    const effortMs = await cpuMedian(() => buildEffortPackage(db, acct.userId, acct.newActivityIds[0]!), 7);
    const effortText = (await buildEffortPackage(db, acct.userId, acct.newActivityIds[0]!))?.text ?? "";
    const streamMs = await cpuMedian(
      () => chatCompletion(acct.env, acct.fetchImpl, "m", 8000, [{ role: "user", content: effortText }]),
      7,
    );

    // A garden weeks behind (a dormant account, a version upgrade, a restore's catch-up): what the garden step costs.
    const behind = hookedDb();
    const behindAcct = await seedRealisticAccount(behind, { gardenBehindDays: 45, newActivities: false });
    vi.stubGlobal("fetch", behindAcct.fetchImpl);
    meter.fetches = () => behindAcct.fetches.coros + behindAcct.fetches.llm;
    const weeksBehind = await measureHourly(() => hourly(behind, behindAcct.env));
    vi.stubGlobal("fetch", acct.fetchImpl);

    const reads = await db.select().from(schema.coachReads).where(eq(schema.coachReads.userId, acct.userId));
    const runs = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.kind, "reconcile"));
    console.log(
      [
        `runner: calibration ${calibration.toFixed(2)} ms (reference ${REFERENCE_CALIBRATION_MS} ms: this runner at ` +
          `${(REFERENCE_CALIBRATION_MS / calibration).toFixed(2)}x the reference's speed)`,
        `account: ${JSON.stringify(counts)} (seeded in ${seedMs.toFixed(0)} ms)`,
        table("── hourly() right after the new activities, COLD (first account: every path JIT-compiled here) ──", cold.steps, cold.total),
        table("── hourly() right after the new activities, warm (second account) ──", fresh.steps, fresh.total),
        `the runs after it (heavy step, warm): ${nextHours.join(" → ")}`,
        table("── hourly() once nothing is left (steady, warm) ──", steady.steps, steady.total),
        table("── hourly() with the garden 45 days behind (warm) ──", weeksBehind.steps, weeksBehind.total),
        `inside one coach read (warm, median of 7): effort package ${effortMs.toFixed(2)} ms CPU (${effortText.length} chars); ` +
          `streamed answer (320 SSE events) ${streamMs.toFixed(2)} ms CPU`,
        `coach reads: ${reads.filter((r) => r.status === "done").length} done, ${reads.filter((r) => r.status === "queued").length} queued; ` +
          `reconcile runs: ${runs.map((r) => r.status).join(",")}; llm fetches ${acct.fetches.llm}, coros fetches ${acct.fetches.coros}`,
      ].join("\n\n"),
    );
    expect(runs.every((r) => r.status === "ok")).toBe(true);
    expect(acct.newActivityIds.length).toBe(2);
  });

  it("prints what the half-hourly COROS sweep spends when it ingests new activities (it runs after the calendar run row is closed)", { timeout: 120_000 }, async () => {
    // Warm every path on a first account, then measure a second. The mock's activities (a run with its detail, a
    // ride, a strength session) land on the Tuesday of last week — inside the read's 14-day window.
    const lastMonday = addDays(startOfIsoWeek(todayInZone("America/Los_Angeles")), -7);
    let measured: Awaited<ReturnType<typeof measureHourly>> | null = null;
    let cold: Awaited<ReturnType<typeof measureHourly>> | null = null;
    for (const pass of ["cold", "warm"] as const) {
      const db = hookedDb();
      const acct = await seedRealisticAccount(db, { newActivities: false, gardenBehindDays: 2, corosBaseMonday: lastMonday });
      vi.stubGlobal("fetch", acct.fetchImpl);
      meter.fetches = () => acct.fetches.coros + acct.fetches.llm;
      const m = await measureHourly(() => corosReadSweep(db, acct.env));
      if (pass === "cold") cold = m;
      else measured = m;
    }
    console.log(
      [
        table("── corosReadSweep ingesting the mock's new activities, COLD ──", cold!.steps, cold!.total, SWEEP_LABELS),
        table("── corosReadSweep ingesting the mock's new activities, warm ──", measured!.steps, measured!.total, SWEEP_LABELS),
      ].join("\n\n"),
    );
    expect(measured!.total.statements).toBeGreaterThan(0);
  });

  it("prints the sweep that ingests, and the two sweeps after it, as medians over several accounts (cron reliability, part 3)", { timeout: 120_000 }, async () => {
    // Medians over warm accounts, with the runner's calibration printed: single runs on a busy machine swing 2x.
    // The sweeps after the ingest re-read the mock's activities (their stored telemetry is list-grade, so every read
    // heals them) — what a steady half hour costs while that is so.
    const lastMonday = addDays(startOfIsoWeek(todayInZone("America/Los_Angeles")), -7);
    const calibration = calibrationMs();
    const runs: Array<Array<{ steps: StepRecord[]; total: StepRecord }>> = [];
    for (let pass = 0; pass < 6; pass++) {
      const db = hookedDb();
      const acct = await seedRealisticAccount(db, { newActivities: false, gardenBehindDays: 2, corosBaseMonday: lastMonday });
      vi.stubGlobal("fetch", acct.fetchImpl);
      meter.fetches = () => acct.fetches.coros + acct.fetches.llm;
      const sweeps = [];
      for (let k = 0; k < 6; k++) sweeps.push(await measureHourly(() => corosReadSweep(db, acct.env)));
      if (pass > 0) runs.push(sweeps); // the first account only warms every path
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const medianTable = (k: number, title: string) => {
      const names = [...new Set(runs.flatMap((r) => r[k]!.steps.map((s) => s.name)))];
      const stepOf = (r: (typeof runs)[number], name: string): StepRecord => {
        const hits = r[k]!.steps.filter((s) => s.name === name);
        return hits.reduce(
          (a, s) => ({ ...a, cpuMs: a.cpuMs + s.cpuMs, sqliteMs: a.sqliteMs + s.sqliteMs, wallMs: a.wallMs + s.wallMs, statements: a.statements + s.statements, writes: a.writes + s.writes, rows: a.rows + s.rows, fetches: a.fetches + s.fetches }),
          { name, cpuMs: 0, sqliteMs: 0, wallMs: 0, statements: 0, writes: 0, rows: 0, fetches: 0, heapMb: 0 },
        );
      };
      const med = (pick: (r: (typeof runs)[number]) => StepRecord): StepRecord => {
        const xs = runs.map(pick);
        return {
          name: xs[0]!.name,
          cpuMs: median(xs.map((x) => x.cpuMs)),
          sqliteMs: median(xs.map((x) => x.sqliteMs)),
          wallMs: median(xs.map((x) => x.wallMs)),
          statements: median(xs.map((x) => x.statements)),
          writes: median(xs.map((x) => x.writes)),
          rows: median(xs.map((x) => x.rows)),
          fetches: median(xs.map((x) => x.fetches)),
          heapMb: 0,
        };
      };
      return table(title, names.map((n) => med((r) => stepOf(r, n))), med((r) => r[k]!.total), SWEEP_LABELS);
    };
    console.log(
      [
        `runner: calibration ${calibration.toFixed(2)} ms (reference ${REFERENCE_CALIBRATION_MS} ms); medians of ${runs.length} warm accounts`,
        medianTable(0, "── the sweep that ingests the mock's new activities (median) ──"),
        medianTable(1, "── the next sweep (median) ──"),
        medianTable(2, "── the sweep after that (median) ──"),
        medianTable(5, "── the sixth sweep: the replay long finished (median) ──"),
      ].join("\n\n"),
    );
    expect(runs.length).toBe(5);
  });
});
