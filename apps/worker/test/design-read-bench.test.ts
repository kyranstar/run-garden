/**
 * THE READ TOOLS' CPU (Stage 3 Task 4, fix round 2, item 5). A tool call runs inside a step, and on the Workers free
 * plan a request has 10 ms of CPU — shared with the step's own state work (coach-runs-bench.test.ts) and the model
 * call's stream parsing. The heaviest reads are measured on the rich fixture: search_library over the whole library
 * (every move judged for today's fit, ranked, its history tallied), read_history over 92 days, read_balance over 92
 * days (derivePerformed per session and activity).
 *
 * The Worker's CPU is the call's time minus SQLite's own (running statements, building rows): on Workers that work is
 * D1's, not the Worker's (session-build-bench.test.ts). Timed like coach-runs-bench.test.ts: a fixed calibration loop
 * before and after, the p50 scaled to the reference machine (`× reference / calibration`); a runner far from the
 * reference, or CI, prints and skips with the reason. Synthetic data only.
 */
import type Database from "better-sqlite3";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import { Rng } from "@rg/session-engine";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { READ_TOOLS } from "../src/services/design-tools/index.js";
import { isToolErr } from "../src/services/design-tools/types.js";
import { day, NOW, seedRichAthlete, TODAY } from "./design-read-fixture.js";
import { makeTestDb } from "./helpers.js";

const ON_CI = process.env.CI === "true";
/** The calibration loop's median on the reference machine (session-build-bench.test.ts: Apple silicon, Node 21). */
const REFERENCE_CALIBRATION_MS = 6.2;
const MAX_RUNNER_RATIO = 1.5;
const WORKERS_CPU_LIMIT_MS = 10;
/** Each call's ceiling: half the request's CPU, leaving the step's own work and the model call's parsing the rest. */
const READ_CPU_CEILING_MS = WORKERS_CPU_LIMIT_MS / 2;
const RUNS = 21;

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

const p50 = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Time spent inside SQLite (running statements, building rows): on Workers that is D1's work, not the Worker's CPU. */
function sqliteClock(db: Db): { reset(): void; ms(): number } {
  const client = (db as unknown as { $client: Database.Database }).$client;
  let spent = 0;
  const prepare = client.prepare.bind(client);
  (client as unknown as { prepare: (src: string) => unknown }).prepare = (src: string) => {
    const stmt = prepare(src) as unknown as Record<string, unknown>;
    for (const method of ["all", "get", "run", "values"]) {
      const f = stmt[method];
      if (typeof f !== "function") continue;
      const bound = (f as (...a: unknown[]) => unknown).bind(stmt);
      stmt[method] = (...a: unknown[]) => {
        const t = performance.now();
        try {
          return bound(...a);
        } finally {
          spent += performance.now() - t;
        }
      };
    }
    return stmt;
  };
  return { reset: () => void (spent = 0), ms: () => spent };
}

const CALLS: Array<{ label: string; tool: string; input: Record<string, unknown> }> = [
  { label: "search_library, the whole library", tool: "search_library", input: {} },
  { label: "search_library, a query at the most rows", tool: "search_library", input: { query: "squat", limit: 30 } },
  { label: "read_history, 92 days at the most rows", tool: "read_history", input: { from: day(91), to: TODAY, limit: 30 } },
  { label: "read_balance, 92 days", tool: "read_balance", input: { from: day(91), to: TODAY } },
];

const results = new Map<string, { worker: number; sqlite: number }>();
let calibration = 0;

beforeAll(async () => {
  const db = makeTestDb();
  const { userId } = await seedRichAthlete(db);
  const clock = sqliteClock(db);
  const before = p50(times(calibrationLoop, 7));
  for (const call of CALLS) {
    const tool = READ_TOOLS.find((t) => t.name === call.tool)!;
    const ctx = { db, env: {} as Env, userId, run: { id: "bench", role: "main" as const, scope: { kind: "now" as const }, parentId: null, rehearsal: false }, now: NOW };
    const worker: number[] = [];
    const sqlite: number[] = [];
    for (let i = 0; i < RUNS + 3; i++) {
      clock.reset();
      const t = performance.now();
      const r = await tool.run(ctx, call.input);
      const total = performance.now() - t;
      if (isToolErr(r)) throw new Error(`${call.tool}: ${r.why}`);
      if (i < 3) continue; // warm-up
      worker.push(total - clock.ms());
      sqlite.push(clock.ms());
    }
    results.set(call.label, { worker: p50(worker), sqlite: p50(sqlite) });
  }
  const after = p50(times(calibrationLoop, 7));
  calibration = (before + after) / 2;
  for (const [label, r] of results) {
    console.log(
      `[read CPU] ${label}: Worker p50 ${r.worker.toFixed(2)} ms raw, ${scaled(r.worker).toFixed(2)} ms scaled; SQLite (D1's work) ${r.sqlite.toFixed(2)} ms ` +
        `(calibration ${before.toFixed(1)} / ${after.toFixed(1)} ms vs ${REFERENCE_CALIBRATION_MS})`,
    );
  }
}, 120_000);

const scaled = (ms: number) => ms * (REFERENCE_CALIBRATION_MS / (calibration || REFERENCE_CALIBRATION_MS));

describe("the heaviest read tools' CPU on a rich account", () => {
  for (const call of CALLS) {
    it(`${call.label}: under ${READ_CPU_CEILING_MS} ms scaled p50 (Workers free: ${WORKERS_CPU_LIMIT_MS} ms a request)`, (ctx) => {
      const ratio = calibration / REFERENCE_CALIBRATION_MS;
      if (ON_CI) ctx.skip("on CI: timings printed, not asserted");
      if (ratio > MAX_RUNNER_RATIO || ratio < 1 / MAX_RUNNER_RATIO) {
        ctx.skip(`runner at ${ratio.toFixed(2)}× the reference machine's speed: a CPU timing here would measure the runner`);
      }
      expect(scaled(results.get(call.label)!.worker)).toBeLessThan(READ_CPU_CEILING_MS);
    });
  }
});
