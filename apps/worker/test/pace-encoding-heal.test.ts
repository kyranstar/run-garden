/**
 * THE COACH RUNS ALREADY ON THE WATCH WITH THE OLD PACE ENCODING ARE REWRITTEN (owner-approved 2026-10-10).
 *
 * Live 2026-10-09: a coach run's threshold reps read "78'59 – 722'43" per mile on the watch. `buildRunProgram` sent
 * the bounds in ms/km with intensityMultiplier 0, so the watch took them as SECONDS per km (fixed in 2c1ee96). The
 * program fingerprint covers neither field the fix added, so the import sees no change on the old copies: they stay
 * wrong on the watch until rewritten. Eight upcoming coach runs in prod carry the old encoding.
 *
 * The evidence is exact, not a date guess: the lane stamps every run build it verifies with the wire's pace encoding
 * version (`paceWire`), so a verified paced write WITHOUT it is the old encoding. The hourly cron rewrites one such row
 * a run, soonest first, until none are left.
 *
 * Synthetic fixtures only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import { corosProgramFingerprint, normalizeCorosSchedule, type RawCorosProgram } from "@rg/providers";
import { RUN_PACE_WIRE } from "@rg/coros";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { renormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { applyOps } from "../src/services/coach-apply.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { importPlanSnapshot } from "../src/services/import-plan.js";
import { activeSyncNotes } from "../src/services/sync-notes.js";
import { stampName } from "../src/services/coros-stamp.js";
import {
  convergeDivergedContent,
  countDivergedContent,
  healOutdatedPaceEncoding,
} from "../src/services/content-converge.js";
import { hourly } from "../src/index.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const THRESHOLD = 289;
/** The first entry of the mock COROS server's sportType=4 catalog. */
const SQUAT = "425898928110747648";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

const THRESHOLD_REPS = {
  category: "quality",
  title: "Threshold 4×6",
  durationMinutes: 50,
  run: {
    blocks: [
      { kind: "duration", value: 15, intensity: "easy" },
      { kind: "duration", value: 6, intensity: "threshold" },
      { kind: "duration", value: 2, intensity: "rest" },
      { kind: "duration", value: 10, intensity: "easy" },
    ],
  },
};
const LONG_RUN = {
  category: "long",
  title: "Long run",
  durationMinutes: 90,
  run: { blocks: [{ kind: "duration", value: 90, intensity: "easy" }] },
};
/** A run with no pace targets at all: no block names an intensity. */
const BY_FEEL = {
  category: "easy",
  title: "Easy by feel",
  durationMinutes: 40,
  run: { blocks: [{ kind: "duration", value: 40 }] },
};
const TWO_SIDED_LIFT = {
  category: "strength",
  title: "Split squats",
  durationMinutes: 30,
  lift: { exercises: [{ name: "Split squat", originId: SQUAT, sets: 3, reps: 8, perSide: true }] },
};
const TWO_SIDED_YOGA = {
  category: "yoga",
  title: "Hips",
  durationMinutes: 20,
  mobility: { exercises: [{ name: "Couch stretch", originId: SQUAT, sets: 2, holdSeconds: 60, perSide: true }] },
};

async function setup(server: MockCorosServer = mockCorosServer()) {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  const res = await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl);
  expect(res.status).toBe("connected");
  const today = todayInZone(prefs.timezone);
  await db.insert(schema.dailyHealth).values({
    id: `${userId}:${today}`,
    userId,
    date: today,
    thresholdPaceSecPerKm: THRESHOLD,
    provider: "coros",
    contentFingerprint: "test",
    updatedAt: nowInstant(),
  });
  await db.insert(schema.corosExercises).values({ id: SQUAT, name: "Back Squat", raw: {}, updatedAt: nowInstant() });
  return { db, userId, prefs, server, today };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** A coach session added and pushed for real: the row carries a genuine COROS address and wire fingerprint. */
async function pushCoach(ctx: Ctx, date: string, session: unknown): Promise<string> {
  const added = await applyOps(ctx.db, ctx.userId, ctx.prefs, `p-${date}-${(session as { title: string }).title}`, [
    coachOpSchema.parse({ kind: "add", date, session }),
  ]);
  const workoutId = added.created[0]!;
  await executeCloudJobs(ctx.db, makeEnv(), ctx.userId, ctx.prefs, { fetchImpl: ctx.server.fetchImpl });
  const [job] = await jobsOf(ctx.db, workoutId);
  expect(job!.status, job!.lastErrorCategory ?? "").toBe("verified");
  return workoutId;
}

const jobsOf = (db: Db, workoutId: string) =>
  db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.workoutId, workoutId));
const rowOf = async (db: Db, workoutId: string) =>
  (await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, workoutId)))[0]!;
const programOf = (ctx: Ctx, title: string, date: string): RawCorosProgram | undefined =>
  (ctx.server.state.schedule.programs ?? []).find((p) => p.name === stampName(title, date));

/**
 * The state the eight prod rows are in: the push verified before the lane stamped `paceWire`, and the watch holds
 * the bounds as the old builder sent them — intensityMultiplier 0 and no display unit.
 */
async function asWrittenBeforeTheFix(ctx: Ctx, workoutId: string, title: string, date: string): Promise<void> {
  for (const job of await jobsOf(ctx.db, workoutId)) {
    const { paceWire: _gone, ...old } = job.payload as Record<string, unknown>;
    await ctx.db
      .update(schema.corosWriteJobs)
      .set({ payload: { ...old, thresholdPaceSecPerKm: THRESHOLD } })
      .where(eq(schema.corosWriteJobs.id, job.id));
  }
  const program = programOf(ctx, title, date);
  for (const e of program?.exercises ?? []) {
    if (Number(e.intensityType) === 3) {
      e.intensityMultiplier = 0;
      delete e.intensityDisplayUnit;
    }
  }
}

const updateJobsOf = async (db: Db, userId: string) =>
  db
    .select()
    .from(schema.corosWriteJobs)
    .where(and(eq(schema.corosWriteJobs.userId, userId), eq(schema.corosWriteJobs.kind, "coach_update_workout")));

describe("the lane records the pace encoding it wrote", () => {
  it("a verified coach run build carries paceWire on its job; a lift build does not claim one", async () => {
    const ctx = await setup();
    const run = await pushCoach(ctx, addDays(ctx.today, 3), THRESHOLD_REPS);
    const lift = await pushCoach(ctx, addDays(ctx.today, 4), TWO_SIDED_LIFT);
    const [runJob] = await jobsOf(ctx.db, run);
    expect((runJob!.payload as { paceWire?: number }).paceWire).toBe(RUN_PACE_WIRE);
    expect(RUN_PACE_WIRE).toBe(2);
    const [liftJob] = await jobsOf(ctx.db, lift);
    expect((liftJob!.payload as { paceWire?: number }).paceWire).toBeUndefined();
    // A freshly written run is not evidence of anything.
    expect((await countDivergedContent(ctx.db, ctx.userId)).candidates).toBe(0);
  });
});

describe("pace_encoding_outdated", () => {
  it("names an upcoming verified paced coach run written without paceWire, and only that", async () => {
    const ctx = await setup();
    const day = addDays(ctx.today, 2);
    const paced = await pushCoach(ctx, day, THRESHOLD_REPS);
    const byFeel = await pushCoach(ctx, addDays(ctx.today, 3), BY_FEEL);
    const lift = await pushCoach(ctx, addDays(ctx.today, 4), TWO_SIDED_LIFT);
    const yoga = await pushCoach(ctx, addDays(ctx.today, 5), TWO_SIDED_YOGA);
    await asWrittenBeforeTheFix(ctx, paced, THRESHOLD_REPS.title, day);
    await asWrittenBeforeTheFix(ctx, byFeel, BY_FEEL.title, addDays(ctx.today, 3));
    await asWrittenBeforeTheFix(ctx, lift, TWO_SIDED_LIFT.title, addDays(ctx.today, 4));
    await asWrittenBeforeTheFix(ctx, yoga, TWO_SIDED_YOGA.title, addDays(ctx.today, 5));

    const census = await countDivergedContent(ctx.db, ctx.userId);
    expect(census.candidates).toBe(1);
    expect(census.rewrites).toBe(1);
    const dry = await convergeDivergedContent(ctx.db, ctx.userId, { dryRun: true });
    expect(dry.rows.map((r) => [r.workoutId, r.evidence])).toEqual([[paced, ["pace_encoding_outdated"]]]);
  });

  it("a past row is not evidence — its watch copy is history", async () => {
    const ctx = await setup();
    const day = addDays(ctx.today, 2);
    const paced = await pushCoach(ctx, day, THRESHOLD_REPS);
    await asWrittenBeforeTheFix(ctx, paced, THRESHOLD_REPS.title, day);
    await ctx.db
      .update(schema.plannedWorkouts)
      .set({ effectiveDate: addDays(ctx.today, -1) })
      .where(eq(schema.plannedWorkouts.id, paced));
    expect((await countDivergedContent(ctx.db, ctx.userId)).candidates).toBe(0);
  });

  it("a row taken off the watch since is not evidence — the watch holds nothing to fix", async () => {
    const ctx = await setup();
    const day = addDays(ctx.today, 2);
    const paced = await pushCoach(ctx, day, THRESHOLD_REPS);
    await asWrittenBeforeTheFix(ctx, paced, THRESHOLD_REPS.title, day);
    expect((await countDivergedContent(ctx.db, ctx.userId)).candidates).toBe(1);
    const [create] = await jobsOf(ctx.db, paced);
    await ctx.db.insert(schema.corosWriteJobs).values({
      ...create!,
      id: `${paced}-unpush`,
      kind: "coach_delete_workout",
      payload: { workoutId: paced },
      verifiedAt: new Date(Date.now() + 60_000).toISOString(), // after the create
    });
    expect((await countDivergedContent(ctx.db, ctx.userId)).candidates).toBe(0);
  });
});

describe("the hourly heal", () => {
  it("rewrites one row a run, soonest first, onto the new encoding — and stops when none are left", { timeout: 60_000 }, async () => {
    const ctx = await setup();
    vi.stubGlobal("fetch", ctx.server.fetchImpl);
    // Pushed out of date order, so "soonest" cannot be insertion order.
    const later = addDays(ctx.today, 5);
    const sooner = addDays(ctx.today, 1);
    const quality = await pushCoach(ctx, later, THRESHOLD_REPS);
    const long = await pushCoach(ctx, sooner, LONG_RUN);
    await asWrittenBeforeTheFix(ctx, quality, THRESHOLD_REPS.title, later);
    await asWrittenBeforeTheFix(ctx, long, LONG_RUN.title, sooner);
    expect(programOf(ctx, LONG_RUN.title, sooner)!.exercises![0]!.intensityMultiplier).toBe(0);
    expect((await countDivergedContent(ctx.db, ctx.userId)).rewrites).toBe(2);

    // Run 1: exactly one rewrite, the soonest, written and verified in the same run.
    await hourly(ctx.db, makeEnv());
    let jobs = await updateJobsOf(ctx.db, ctx.userId);
    expect(jobs.map((j) => j.workoutId)).toEqual([long]);
    expect(jobs[0]!.status, jobs[0]!.lastErrorCategory ?? "").toBe("verified");
    expect((jobs[0]!.payload as { paceWire?: number }).paceWire).toBe(RUN_PACE_WIRE);
    const step = programOf(ctx, LONG_RUN.title, sooner)!.exercises![0]!;
    expect(step.intensityType).toBe(3);
    expect(step.intensityMultiplier).toBe(1000);
    expect(step.intensityDisplayUnit).toBe(2);
    expect((await countDivergedContent(ctx.db, ctx.userId)).rewrites).toBe(1);

    // Run 2: the other one.
    await hourly(ctx.db, makeEnv());
    jobs = await updateJobsOf(ctx.db, ctx.userId);
    expect(jobs.map((j) => j.workoutId).sort()).toEqual([long, quality].sort());
    expect(jobs.every((j) => j.status === "verified")).toBe(true);
    const reps = programOf(ctx, THRESHOLD_REPS.title, later)!.exercises!.filter((e) => Number(e.intensityType) === 3);
    expect(reps.length).toBeGreaterThan(0);
    expect(reps.every((e) => e.intensityMultiplier === 1000 && e.intensityDisplayUnit === 2)).toBe(true);
    expect((await countDivergedContent(ctx.db, ctx.userId)).candidates).toBe(0);

    // Run 3: nothing left, nothing written.
    await hourly(ctx.db, makeEnv());
    expect(await updateJobsOf(ctx.db, ctx.userId)).toHaveLength(2);
  });

  it("never touches a past, completed or archived row, nor anything while COROS writes are off", async () => {
    const ctx = await setup();
    const days = [1, 2, 3, 4].map((n) => addDays(ctx.today, n));
    const ids: string[] = [];
    for (const d of days) {
      const id = await pushCoach(ctx, d, { ...THRESHOLD_REPS, title: `Reps ${d}` });
      await asWrittenBeforeTheFix(ctx, id, `Reps ${d}`, d);
      ids.push(id);
    }
    const [past, completed, archived, open] = ids as [string, string, string, string];
    const set = (id: string, v: Partial<typeof schema.plannedWorkouts.$inferInsert>) =>
      ctx.db.update(schema.plannedWorkouts).set(v).where(eq(schema.plannedWorkouts.id, id));
    await set(past, { effectiveDate: addDays(ctx.today, -1) });
    await set(completed, { completionState: "completed" });
    await set(archived, { archivedAt: nowInstant() });

    // Writes off: the heal queues nothing at all, not even the open row's.
    const off: UserPreferences = { ...ctx.prefs, corosWritesEnabled: false };
    await savePreferences(ctx.db, ctx.userId, off);
    expect(await healOutdatedPaceEncoding(ctx.db, ctx.userId, off)).toBeNull();
    expect(await updateJobsOf(ctx.db, ctx.userId)).toHaveLength(0);

    // Writes on: only the open row, and then nothing more.
    expect(await healOutdatedPaceEncoding(ctx.db, ctx.userId, ctx.prefs)).not.toBeNull();
    let jobs = await updateJobsOf(ctx.db, ctx.userId);
    expect(jobs.map((j) => j.workoutId)).toEqual([open]);
    // While its rewrite is in flight the row is not picked again (a second enqueue would supersede it).
    expect(await healOutdatedPaceEncoding(ctx.db, ctx.userId, ctx.prefs)).toBeNull();
    await executeCloudJobs(ctx.db, makeEnv(), ctx.userId, ctx.prefs, { fetchImpl: ctx.server.fetchImpl });
    expect(await healOutdatedPaceEncoding(ctx.db, ctx.userId, ctx.prefs)).toBeNull();
    jobs = await updateJobsOf(ctx.db, ctx.userId);
    expect(jobs.map((j) => [j.workoutId, j.status])).toEqual([[open, "verified"]]);
  });

  it("a row whose latest write was an old-encoded REWRITE of the same content still gets a rewrite that runs", async () => {
    const ctx = await setup();
    const day = addDays(ctx.today, 2);
    const id = await pushCoach(ctx, day, THRESHOLD_REPS);
    await asWrittenBeforeTheFix(ctx, id, THRESHOLD_REPS.title, day);
    const first = await healOutdatedPaceEncoding(ctx.db, ctx.userId, ctx.prefs);
    const [queued] = await updateJobsOf(ctx.db, ctx.userId);
    // History as prod holds it: that same rewrite verified BEFORE the lane stamped paceWire, under the untagged id
    // the enqueue used to give it. Unchanged content keeps `from`/`to`, so an untagged heal would collide with it.
    const { paceWire: _gone, ...old } = queued!.payload as Record<string, unknown>;
    await ctx.db.delete(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, first!));
    await ctx.db.insert(schema.corosWriteJobs).values({
      ...queued!,
      id: first!.replace(/-pace\d+$/, ""),
      payload: old,
      status: "verified",
      verifiedAt: nowInstant(),
      completedAt: nowInstant(),
    });

    const healed = await healOutdatedPaceEncoding(ctx.db, ctx.userId, ctx.prefs);
    expect(healed).not.toBeNull();
    await executeCloudJobs(ctx.db, makeEnv(), ctx.userId, ctx.prefs, { fetchImpl: ctx.server.fetchImpl });
    const [job] = (await updateJobsOf(ctx.db, ctx.userId)).filter((j) => j.id === healed);
    expect(job!.status, "the heal collided with the old rewrite and ran nothing").toBe("verified");
    expect((job!.payload as { paceWire?: number }).paceWire).toBe(RUN_PACE_WIRE);
    expect((await countDivergedContent(ctx.db, ctx.userId)).candidates).toBe(0);
  });

  it("stays inside the free plan's statement budget: one read when nothing is left, a bounded few when one is queued", async () => {
    let counting = false;
    let statements = 0;
    const server = mockCorosServer();
    const db = makeTestDb({ onStatement: () => (counting ? (statements += 1) : undefined) });
    const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
    const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
    await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl);
    const today = todayInZone(prefs.timezone);
    await db.insert(schema.dailyHealth).values({
      id: `${userId}:${today}`, userId, date: today, thresholdPaceSecPerKm: THRESHOLD, provider: "coros",
      contentFingerprint: "test", updatedAt: nowInstant(),
    });
    const ctx: Ctx = { db, userId, prefs, server, today };
    const day = addDays(today, 2);
    const id = await pushCoach(ctx, day, THRESHOLD_REPS);

    const measure = async () => {
      statements = 0;
      counting = true;
      const out = await healOutdatedPaceEncoding(db, userId, prefs);
      counting = false;
      return { out, statements };
    };
    const none = await measure();
    expect(none.out).toBeNull();
    expect(none.statements).toBe(1);

    await asWrittenBeforeTheFix(ctx, id, THRESHOLD_REPS.title, day);
    const one = await measure();
    expect(one.out).not.toBeNull();
    expect(one.statements).toBeLessThanOrEqual(8);
  });
});

describe("the rewrite puts the new encoding on the wire", () => {
  it("even though the fingerprint cannot tell the old copy from the corrected one", async () => {
    const ctx = await setup();
    const day = addDays(ctx.today, 2);
    const id = await pushCoach(ctx, day, THRESHOLD_REPS);
    await asWrittenBeforeTheFix(ctx, id, THRESHOLD_REPS.title, day);
    const old = programOf(ctx, THRESHOLD_REPS.title, day)!;
    // The trap: the old copy hashes exactly like the corrected one, so "already current" would send nothing.
    expect(corosProgramFingerprint(old)).toBe((await rowOf(ctx.db, id)).sourceContentFingerprint);

    await convergeDivergedContent(ctx.db, ctx.userId, { dryRun: false });
    await executeCloudJobs(ctx.db, makeEnv(), ctx.userId, ctx.prefs, { fetchImpl: ctx.server.fetchImpl });
    const [job] = await updateJobsOf(ctx.db, ctx.userId);
    expect(job!.status, job!.lastErrorCategory ?? "").toBe("verified");
    const paced = programOf(ctx, THRESHOLD_REPS.title, day)!.exercises!.filter((e) => Number(e.intensityType) === 3);
    expect(paced.length).toBeGreaterThan(0);
    expect(paced.every((e) => e.intensityMultiplier === 1000 && e.intensityDisplayUnit === 2)).toBe(true);
    expect((await countDivergedContent(ctx.db, ctx.userId)).candidates).toBe(0);
  });

  it("against a COROS that re-encodes what it stores: it verifies, and the next read sees no change in COROS", async () => {
    const ctx = await setup(renormalizingCoros());
    const day = addDays(ctx.today, 2);
    const id = await pushCoach(ctx, day, THRESHOLD_REPS);
    await asWrittenBeforeTheFix(ctx, id, THRESHOLD_REPS.title, day);

    const report = await convergeDivergedContent(ctx.db, ctx.userId, { dryRun: false });
    expect(report.rows.map((r) => [r.action, r.evidence])).toEqual([["rewrite", ["pace_encoding_outdated"]]]);
    await executeCloudJobs(ctx.db, makeEnv(), ctx.userId, ctx.prefs, { fetchImpl: ctx.server.fetchImpl });
    const [job] = await updateJobsOf(ctx.db, ctx.userId);
    expect(job!.status, `${job!.lastErrorCategory ?? ""} ${job!.lastErrorDetail ?? ""}`).toBe("verified");
    const program = programOf(ctx, THRESHOLD_REPS.title, day)!;
    const paced = program.exercises!.filter((e) => Number(e.intensityType) === 3);
    expect(paced.length).toBeGreaterThan(0);
    expect(paced.every((e) => Number(e.intensityMultiplier) === 1000 && Number(e.intensityDisplayUnit) === 2)).toBe(true);
    const before = await rowOf(ctx.db, id);
    expect(before.sourceContentFingerprint).toBe(corosProgramFingerprint(program));

    // The production import over what COROS now holds: no "Changed in COROS", nothing adopted, still synced.
    const n = normalizeCorosSchedule(ctx.server.state.schedule);
    await importPlanSnapshot(
      ctx.db,
      {
        userId: ctx.userId,
        plan: { sourcePlanId: n.planId, name: "Container" },
        workouts: n.workouts,
        rangeStart: addDays(ctx.today, -7),
        rangeEnd: addDays(ctx.today, 30),
        fullSchedule: true,
        source: "fixture",
      },
      ctx.prefs,
    );
    expect((await activeSyncNotes(ctx.db, ctx.userId)).filter((note) => note.workoutId === id)).toEqual([]);
    const after = await rowOf(ctx.db, id);
    expect(after.corosSyncState).toBe("synced");
    expect(after.sourceContentFingerprint).toBe(before.sourceContentFingerprint);
    expect(after.stageSummary).toBe(before.stageSummary);
    expect((await countDivergedContent(ctx.db, ctx.userId)).candidates).toBe(0);
  });
});
