/**
 * A DESIGNED RUN ON THE WATCH, THROUGH THE WRITE LANE (§8 §3, phase 1): a `coach_create_workout` job whose session is a
 * `run_watch` runs through the same create + verify core as the thread coach's runs — built at the write by its own
 * builder from the freshest threshold — and lands on the mock COROS with its pace bytes; the push predicate and the
 * coverage disclosure are one decision for it too; a rewrite (its ease's Undo) goes through the same builder. No live
 * call: the mock server only.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, runWatchSessionOf, sessionWatchCoverage, todayInZone, type RunWatchSession, type WorkoutDoc } from "@rg/domain";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { enqueueContentConvergence, enqueueWatchCreate, watchPushable } from "../src/services/coach-apply.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { makeTestDb, makeTestUser } from "./helpers.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const env = (): Env =>
  ({
    DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s", TOKEN_ENCRYPTION_KEY: TEST_KEY, ALLOWED_GOOGLE_EMAIL: "runner@example.com", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "c",
  }) as Env;

const run = (cooldown: Record<string, unknown> = { durationSec: 600 }): WorkoutDoc => ({
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    { purpose: "run", format: "intervals", rounds: 3, items: [{ kind: "run", effort: "tempo", target: { durationSec: 480 } }, { kind: "run", effort: "recovery", target: { durationSec: 120 } }] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: cooldown }] },
  ],
  source: { kind: "coach" },
});
const sessionOf = (doc: WorkoutDoc): RunWatchSession => {
  const made = runWatchSessionOf(doc);
  if (!("session" in made)) throw new Error(made.refused);
  return made.session;
};

async function setup() {
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
  const server = mockCorosServer();
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, env(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
  const date = addDays(todayInZone(prefs.timezone), 5);
  return { db, userId, prefs, server, date };
}

async function row(db: Db, userId: string, id: string, date: string) {
  await db.insert(schema.plannedWorkouts).values({
    id, userId, planId: "p", sourceWorkoutId: id, title: "Tempo blocks", category: "quality", sport: "run", originalPlanDate: date,
    lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "07:00", sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 3000,
    corosSyncState: "calendar_only", completionState: "scheduled", createdAt: nowInstant(), updatedAt: nowInstant(),
  });
}
async function threshold(db: Db, userId: string, date: string, v: number) {
  await db.insert(schema.dailyHealth).values({ id: `${userId}:${date}`, userId, date, thresholdPaceSecPerKm: v, contentFingerprint: "h", updatedAt: nowInstant() });
}

describe("a designed run's create, through the write lane", () => {
  it("lands on the watch with its roles, its times and its pace bands from the threshold at the write", async () => {
    const { db, userId, prefs, server, date } = await setup();
    await row(db, userId, "wo-run", date);
    // Queued with no threshold yet (the payload's), and the threshold read when the lane runs.
    expect(await enqueueWatchCreate(db, userId, "wo-run", date, sessionOf(run({ distanceM: 2000, pace: { fastSecPerKm: 370, slowSecPerKm: 390 } })), nowInstant())).toBe("wo-run-push");
    await threshold(db, userId, todayInZone(prefs.timezone), 289);
    await executeCloudJobs(db, env(), userId, prefs, { fetchImpl: server.fetchImpl });

    const [wo] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "wo-run"));
    expect(wo!.corosSyncState).toBe("synced");
    const program = server.programByIdInPlan(wo!.sourceIdInPlan!)!;
    const steps = program.exercises!.map((e) => e as unknown as Record<string, unknown>);
    expect(steps.map((s) => s.exerciseType)).toEqual([1, 2, 4, 2, 4, 2, 4, 3]);
    // The 2 km cool-down at the pace asked (380 s/km): 760 s.
    expect(steps.map((s) => s.targetValue)).toEqual([600, 480, 120, 480, 120, 480, 120, 760]);
    expect(steps[1]).toMatchObject({ intensityType: 3, intensityValue: 299_000, intensityValueExtend: 314_000, intensityMultiplier: 1000, intensityDisplayUnit: 2 });
    expect(steps[7]).toMatchObject({ intensityType: 3, intensityValue: 370_000, intensityValueExtend: 390_000 });
    const [job] = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, "wo-run-push"));
    expect(job!.status).toBe("verified");
    expect(job!.lastErrorCategory).toBeNull();
    // A run build: the pace encoding it wrote is recorded, as a coach run's is.
    expect((job!.payload as { paceWire?: number }).paceWire).toBe(2);
  });

  it("COROS stores it differently: still verified — it is ours, on that day, and every later move, ease and removal needs that — and the job says what differs (review-2 I2)", async () => {
    const { db, userId, prefs, server, date } = await setup();
    await row(db, userId, "wo-diff", date);
    await threshold(db, userId, todayInZone(prefs.timezone), 289);
    expect(await enqueueWatchCreate(db, userId, "wo-diff", date, sessionOf(run()), nowInstant(), 289)).toBe("wo-diff-push");
    // A COROS that files the first recovery as work.
    const inner = server.fetchImpl;
    const fetchImpl = async function (input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/training/schedule/update" && typeof init?.body === "string") {
        const body = JSON.parse(init.body) as { programs?: Array<{ exercises?: Array<Record<string, unknown>> }> };
        for (const p of body.programs ?? []) p.exercises![2]!.exerciseType = 2;
        return inner(input, { ...init, body: JSON.stringify(body) });
      }
      return inner(input, init);
    } as typeof fetch;
    await executeCloudJobs(db, env(), userId, prefs, { fetchImpl });
    const [job] = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, "wo-diff-push"));
    expect(job).toMatchObject({ status: "verified", lastErrorCategory: "watch_copy_differs" });
    expect(job!.lastErrorDetail).toContain("ex[2].exerciseType 4→2");
    const [wo] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "wo-diff"));
    expect(wo).toMatchObject({ corosSyncState: "synced", lastVerifiedCorosDate: date });
    expect(wo!.sourceIdInPlan).not.toBeNull();
  });

  it("with no threshold anywhere: a timed run goes as bare timers and the debt is recorded", async () => {
    const { db, userId, prefs, server, date } = await setup();
    await row(db, userId, "wo-bare", date);
    expect(await enqueueWatchCreate(db, userId, "wo-bare", date, sessionOf(run()), nowInstant())).toBe("wo-bare-push");
    await executeCloudJobs(db, env(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [job] = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, "wo-bare-push"));
    expect(job!.status).toBe("verified");
    expect(job!.lastErrorCategory).toBe("pace_targets_owed");
  });

  it("a distance no pace can time is never queued", async () => {
    const { db, userId, date } = await setup();
    await row(db, userId, "wo-dist", date);
    expect(await enqueueWatchCreate(db, userId, "wo-dist", date, sessionOf(run({ distanceM: 2000 })), nowInstant())).toBeNull();
    expect(await enqueueWatchCreate(db, userId, "wo-dist", date, sessionOf(run({ distanceM: 2000 })), nowInstant(), 289)).toBe("wo-dist-push");
  });
});

describe("the push and the disclosure are one decision for a designed run", () => {
  const corpus: Array<[string, WorkoutDoc]> = [
    ["timed", run()],
    ["a distance", run({ distanceM: 2000 })],
    ["a distance at a pace asked", run({ distanceM: 2000, pace: { fastSecPerKm: 370, slowSecPerKm: 390 } })],
  ];
  for (const [label, doc] of corpus) {
    for (const t of [289, null]) {
      it(`${label}, threshold ${t ?? "none"}: coverage !== none ⟺ watchPushable`, () => {
        const s = sessionOf(doc);
        expect(sessionWatchCoverage(s, t).coverage !== "none").toBe(watchPushable(s, t));
      });
    }
  }
});

describe("a designed run's rewrite (its ease's Undo) goes through the same builder", () => {
  it("a stamped row's convergence queues the run_watch session, and the lane writes it", async () => {
    const { db, userId, prefs, server, date } = await setup();
    await row(db, userId, "wo-undo", date);
    await threshold(db, userId, todayInZone(prefs.timezone), 289);
    // On the watch first, as the thread coach's eased run would be.
    await enqueueWatchCreate(db, userId, "wo-undo", date, sessionOf(run()), nowInstant(), 289);
    await executeCloudJobs(db, env(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [pushed] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "wo-undo"));
    const back = sessionOf(run({ durationSec: 900 }));
    const out = await enqueueContentConvergence(db, { userId, workout: pushed!, session: back, now: nowInstant(), corosWritesEnabled: true, thresholdPaceSecPerKm: 289 });
    expect(out.kind).toBe("coach_update_workout");
    const [queued] = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, out.jobId!));
    expect((queued!.payload as { session: unknown }).session).toEqual(back);
    await executeCloudJobs(db, env(), userId, prefs, { fetchImpl: server.fetchImpl });
    const [done] = await db.select().from(schema.corosWriteJobs).where(eq(schema.corosWriteJobs.id, out.jobId!));
    expect(done!.status).toBe("verified");
    const [after] = await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, "wo-undo"));
    const program = server.programByIdInPlan(after!.sourceIdInPlan!)!;
    expect(program.exercises!.map((e) => (e as unknown as { targetValue: number }).targetValue).at(-1)).toBe(900);
  });
});
