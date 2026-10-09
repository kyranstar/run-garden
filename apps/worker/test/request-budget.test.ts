/**
 * WHAT ONE REQUEST SPENDS ON THE GARDEN while a long replay is pending (cron reliability, part 4).
 *
 * Parts 2–3 capped the garden walk and replay in the crons, but the requests that walk the garden — the garden page,
 * the plan routes' skip/match/…, the coach's approve — ran it uncapped. With a 69-day replay on record (what the
 * owner approved, to rewrite a stale checkpoint) any of them ran the whole replay in one invocation; and matching an
 * activity from three weeks back replayed three-odd weeks in the request. This measures those requests on a
 * realistic account (`realistic-account.ts`): CPU (node; and node minus SQLite's own time — D1 runs the SQL outside
 * the Worker), D1 statements, the garden days the request walked (day-input writes), and whether the rendered
 * garden (`garden_state`) moved. Also the coach-read drain the sweep runs when it ingested nothing (item 2).
 *
 * Timings are printed, never asserted: node runs this several times faster than workerd. The bounds are pinned, as
 * counts, in request-replay-bounds.test.ts.
 */
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone } from "@rg/domain";
import { Rng } from "@rg/session-engine";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { gardenRoutes } from "../src/routes/garden.js";
import { planRoutes } from "../src/routes/plan.js";
import { coachRoutes } from "../src/routes/coach.js";
import { advanceGarden, recordReplayFrom } from "../src/services/garden-sync.js";
import { processCoachReads } from "../src/services/coach-reads.js";
import { cloneTestDb, isWrite, makeTestDb, mountRoutes } from "./helpers.js";
import { seedRealisticAccount, type RealisticAccount } from "./realistic-account.js";

const REFERENCE_CALIBRATION_MS = 6.2;
function calibrationMs(): number {
  const xs: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    const rng = Rng.create("calibration");
    const items = Array.from({ length: 20_000 }, (_, k) => ({ id: `x${k}`, score: rng(), tags: [k % 7, k % 11] }));
    items.sort((a, b) => b.score - a.score);
    let total = 0;
    for (const it of items) total += it.tags[0]! * it.score + (it.id.length > 4 ? 1 : 0);
    void (total + JSON.stringify(items.slice(0, 2000)).length);
    xs.push(performance.now() - t);
  }
  return xs.sort((a, b) => a - b)[3]!;
}

interface Meter {
  statements: number;
  writes: number;
  dayInputs: number;
  sqliteMs: number;
}
interface Measured {
  name: string;
  cpuMs: number;
  sqliteMs: number;
  statements: number;
  writes: number;
  /** Garden days walked: one day-input write per simulated day. */
  days: number;
  /** garden_state's day before → after, and whether its snapshot changed. */
  shown: string;
}

function hooked(base: Db): { db: Db; meter: Meter } {
  const meter: Meter = { statements: 0, writes: 0, dayInputs: 0, sqliteMs: 0 };
  const db = cloneTestDb(base, {
    boundVariableCap: 100,
    onStatement: (sql) => {
      meter.statements += 1;
      if (isWrite(sql)) meter.writes += 1;
      if (/^insert into "garden_day_inputs"/i.test(sql)) meter.dayInputs += 1;
    },
    onExec: (_sql, ms) => {
      meter.sqliteMs += ms;
    },
  });
  return { db, meter };
}

async function shownOf(db: Db, userId: string): Promise<{ day: string; snapshot: string }> {
  const [s] = await db.select().from(schema.gardenState).where(eq(schema.gardenState.userId, userId));
  return { day: s!.lastSimulatedDate, snapshot: JSON.stringify(s!.snapshot) };
}

async function measure(name: string, db: Db, meter: Meter, userId: string, run: () => unknown): Promise<Measured> {
  const before = await shownOf(db, userId);
  Object.assign(meter, { statements: 0, writes: 0, dayInputs: 0, sqliteMs: 0 });
  const b = process.cpuUsage();
  await run();
  const e = process.cpuUsage(b);
  const m = { ...meter };
  const after = await shownOf(db, userId);
  return {
    name,
    cpuMs: (e.user + e.system) / 1000,
    sqliteMs: m.sqliteMs,
    statements: m.statements,
    writes: m.writes,
    days: m.dayInputs,
    shown: `${before.day} → ${after.day}${after.snapshot === before.snapshot ? " (unchanged)" : " (moved)"}`,
  };
}

const ENV_FOR_ROUTES = (acct: RealisticAccount) => acct.env;

/** The account, its garden walked as far as it goes, a session, and the rows the requests act on. */
async function prepare(): Promise<{ base: Db; acct: RealisticAccount; cookie: string; today: string; matchWorkout: string; matchActivity: string; todayWorkout: string }> {
  const base = makeTestDb({ boundVariableCap: 100 });
  const acct = await seedRealisticAccount(base, { newActivities: false, gardenBehindDays: 2 });
  const today = todayInZone(acct.prefs.timezone);
  await advanceGarden(base, acct.userId, acct.prefs);
  // Nothing queued for the watch: the approve's background job run would otherwise race the measurement.
  await base.delete(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.userId, acct.userId));
  const cookie = `${SESSION_COOKIE}=${await createSession(base, acct.userId)}`;
  const workout = async (date: string, state: "scheduled" | "unresolved") => {
    const id = newId();
    await base.insert(schema.plannedWorkouts).values({
      id, userId: acct.userId, planId: "p-measure", sourceWorkoutId: `4738:${id.slice(0, 8)}`, title: "Tempo", category: "quality", sport: "run",
      originalPlanDate: date, lastVerifiedCorosDate: date, effectiveDate: date, effectiveTime: "07:00", completionState: state,
      sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3600, createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    return id;
  };
  // A run three weeks back the garden never credited, and the session it belongs to: what the match route replays.
  const matchDay = addDays(today, -21);
  const matchActivity = newId();
  await base.insert(schema.activities).values({
    id: matchActivity, userId: acct.userId, startTime: `${matchDay}T13:30:00Z`, startTimeLocal: `${matchDay}T06:30:00`, sport: "run",
    durationSeconds: 3000, distanceMeters: 9000, sourceMergeConfidence: 1, createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  const matchWorkout = await workout(matchDay, "unresolved");
  const todayWorkout = await workout(today, "scheduled");
  return { base, acct, cookie, today, matchWorkout, matchActivity, todayWorkout };
}

async function runAll(p: Awaited<ReturnType<typeof prepare>>): Promise<Measured[]> {
  const { base, acct, cookie, today } = p;
  const userId = acct.userId;
  const env = ENV_FOR_ROUTES(acct);
  const out: Measured[] = [];
  const replayFrom = addDays(today, -69);
  const pending = async () => {
    const h = hooked(base);
    await recordReplayFrom(h.db, userId, replayFrom);
    return h;
  };

  {
    const { db, meter } = hooked(base);
    const app = mountRoutes(db, "/api/garden", gardenRoutes);
    out.push(await measure("GET /api/garden, nothing pending", db, meter, userId, () => app.request("/api/garden", { headers: { Cookie: cookie } }, env)));
  }
  {
    const { db, meter } = await pending();
    const app = mountRoutes(db, "/api/garden", gardenRoutes);
    out.push(await measure("GET /api/garden, 69-day replay", db, meter, userId, () => app.request("/api/garden", { headers: { Cookie: cookie } }, env)));
    out.push(await measure("  the next GET /api/garden", db, meter, userId, () => app.request("/api/garden", { headers: { Cookie: cookie } }, env)));
  }
  {
    const { db, meter } = hooked(base);
    const app = mountRoutes(db, "/api/plan", planRoutes);
    out.push(
      await measure("POST match, a run 3 weeks back", db, meter, userId, () =>
        app.request(`/api/plan/workouts/${p.matchWorkout}/match`, { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ activityId: p.matchActivity }) }, env),
      ),
    );
  }
  {
    const { db, meter } = await pending();
    const app = mountRoutes(db, "/api/plan", planRoutes);
    out.push(await measure("POST skip today, 69-day replay", db, meter, userId, () => app.request(`/api/plan/workouts/${p.todayWorkout}/skip`, { method: "POST", headers: { Cookie: cookie } }, env)));
  }
  {
    const { db, meter } = await pending();
    const id = newId();
    await db.insert(schema.coachProposals).values({
      id, userId, title: "Proposal", evidence: "e", rationale: "r", flags: [], status: "pending", createdAt: nowInstant(), expiresAt: today,
      ops: [{ kind: "skip", workoutId: p.todayWorkout, reason: "tired" }],
    });
    const app = mountRoutes(db, "/api/coach", coachRoutes);
    out.push(await measure("POST approve (skip), 69-day replay", db, meter, userId, () => app.request(`/api/coach/proposals/${id}/approve`, { method: "POST", headers: { Cookie: cookie } }, env)));
  }
  for (const days of [3, 7, 10]) {
    const { db, meter } = await pending();
    out.push(await measure(`one replay step of ${days} days`, db, meter, userId, () => advanceGarden(db, userId, acct.prefs, new Date(), { maxResimDays: days, maxWalkDays: days })));
  }
  // Item 2: the drain a sweep that ingested nothing runs — six queued reads (default cap) vs one.
  for (const cap of [undefined, 1]) {
    const { db, meter } = hooked(base);
    const older = await db
      .select({ id: schema.activities.id })
      .from(schema.activities)
      .where(eq(schema.activities.userId, userId))
      .limit(6);
    for (const a of older) {
      await db
        .update(schema.coachReads)
        .set({ status: "queued", attempt: 0, completedAt: null, nextAttemptAt: nowInstant() })
        .where(and(eq(schema.coachReads.userId, userId), eq(schema.coachReads.activityId, a.id)));
    }
    out.push(
      await measure(`coach drain, 6 queued, cap ${cap ?? "default"}`, db, meter, userId, () =>
        processCoachReads(db, env, userId, acct.prefs, cap === undefined ? { fetchImpl: acct.fetchImpl } : { cap, fetchImpl: acct.fetchImpl }),
      ),
    );
  }
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("what a request spends on the garden while a long replay is pending", () => {
  it("prints each request's CPU, statements and garden days walked (medians of warm accounts)", { timeout: 300_000 }, async () => {
    const calibration = calibrationMs();
    const passes: Measured[][] = [];
    for (let pass = 0; pass < 4; pass++) {
      const p = await prepare();
      vi.stubGlobal("fetch", p.acct.fetchImpl);
      const m = await runAll(p);
      if (pass > 0) passes.push(m); // the first account only warms every path
      else console.log(`cold pass: ${m.map((x) => `${x.name.trim()} ${x.cpuMs.toFixed(1)} ms`).join("; ")}`);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const rows = passes[0]!.map((first, i) => ({
      ...first,
      cpuMs: median(passes.map((p) => p[i]!.cpuMs)),
      sqliteMs: median(passes.map((p) => p[i]!.sqliteMs)),
      statements: median(passes.map((p) => p[i]!.statements)),
      writes: median(passes.map((p) => p[i]!.writes)),
      days: median(passes.map((p) => p[i]!.days)),
    }));
    const f = (n: number) => n.toFixed(1).padStart(7);
    console.log(
      [
        `runner: calibration ${calibration.toFixed(2)} ms (reference ${REFERENCE_CALIBRATION_MS} ms); medians of ${passes.length} warm accounts`,
        `${"request".padEnd(38)} ${"cpu ms".padStart(7)} ${"sql ms".padStart(7)} ${"js ms".padStart(7)} ${"stmts".padStart(6)} ${"writes".padStart(6)} ${"days".padStart(5)}  garden_state`,
        ...rows.map((r) => `${r.name.padEnd(38)} ${f(r.cpuMs)} ${f(r.sqliteMs)} ${f(r.cpuMs - r.sqliteMs)} ${String(r.statements).padStart(6)} ${String(r.writes).padStart(6)} ${String(r.days).padStart(5)}  ${r.shown}`),
      ].join("\n"),
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});
