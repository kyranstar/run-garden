/**
 * A STRENGTH REWRITE MARKED FAILED THOUGH COROS TOOK IT CAN BE RETRIED, AND VERIFIES (2026-10-10).
 *
 * The owner approved a coach rewrite of a strength session (Oct 14). COROS answered 0000 and stored it; the
 * read-after-write compared what it sent with what COROS stores by raw ids and server-computed figures, and the job
 * failed `verification_failed` — "ex[0].targetValue 60→78; ex[1].intensityValue →absent; ex[1].groupId 1→…". The row
 * reads `sync_issue`, the banner counts it, and the content intent stays open. Four September strength/yoga rewrites
 * are the same class.
 *
 * The comparator now compares what is ours (normalize.ts), so a re-run verifies — but nothing re-ran it: the banner's
 * Retry (`POST /api/sync/retry`) re-armed failed MOVES and studio pushes only, so a failed rewrite was a badge no tap
 * could clear. This file reproduces the prod state exactly — the rewrite LANDS on a COROS that renormalizes what it
 * stores, and the job records the old comparator's verdict — then taps Retry and drains.
 *
 * Synthetic fixtures only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, coachOpSchema, nowInstant, todayInZone } from "@rg/domain";
import type { UpdateContentResult } from "@rg/coros";
import { renormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { applyOps } from "../src/services/coach-apply.js";
import { computeSyncStatus } from "../src/services/sync-status.js";
import { openIntentFor } from "../src/services/sync-intents.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

/** When set, the next rewrite lands for real and is then judged as the old comparator judged it (the prod state). */
const oldVerdict = vi.hoisted(() => ({ next: false }));
vi.mock("@rg/coros", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rg/coros")>();
  return {
    ...real,
    updateWorkoutContent: async (...args: Parameters<typeof real.updateWorkoutContent>): Promise<UpdateContentResult> => {
      const result = await real.updateWorkoutContent(...args);
      if (!oldVerdict.next || !result.ok) return result;
      oldVerdict.next = false;
      return {
        ok: false,
        code: "0000",
        reason: "verification_failed",
        error:
          "the rewrite returned 0000 but the program on the day is not what was sent — ex[0].targetValue 60→78;" +
          " ex[1].intensityValue →absent; ex[1].groupId 1→900000000000000751",
        serverIdInPlan: result.serverIdInPlan,
        serverProgramId: result.serverProgramId,
        serverPlanId: result.serverPlanId,
        wireFingerprint: result.wireFingerprint,
        observedFingerprint: result.observedFingerprint,
      };
    },
  };
});

const { syncRoutes } = await import("../src/routes/sync.js");

afterEach(() => {
  vi.unstubAllGlobals();
  oldVerdict.next = false;
});

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const SQUAT = "425898928110747648";
const PUSHUP = "426109589008859137";

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

/** Shaped like the Oct 14 session: three straight-set blocks, two of them bodyweight. */
const STRENGTH = {
  category: "strength",
  title: "Strength A",
  durationMinutes: 35,
  lift: {
    exercises: [
      { name: "Push-up", originId: PUSHUP, sets: 3, reps: 10, weight: { type: "bodyweight" }, restSeconds: 60 },
      { name: "Air squat", originId: SQUAT, sets: 3, reps: 15, weight: { type: "bodyweight" }, restSeconds: 60 },
      { name: "Goblet squat", originId: SQUAT, sets: 4, reps: 8, weight: { type: "kg", value: 20 }, restSeconds: 90 },
    ],
  },
};
const EASED = {
  ...STRENGTH,
  lift: {
    exercises: [
      { name: "Push-up", originId: PUSHUP, sets: 3, reps: 12, weight: { type: "bodyweight" }, restSeconds: 60 },
      { name: "Air squat", originId: SQUAT, sets: 3, reps: 12, weight: { type: "bodyweight" }, restSeconds: 60 },
      { name: "Goblet squat", originId: SQUAT, sets: 4, reps: 8, weight: { type: "kg", value: 24 }, restSeconds: 90 },
    ],
  },
};

async function setup() {
  const server = renormalizingCoros();
  const db = makeTestDb();
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  const res = await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl);
  expect(res.status).toBe("connected");
  await db.insert(schema.corosExercises).values([
    { id: SQUAT, name: "Back Squat", raw: {}, updatedAt: nowInstant() },
    { id: PUSHUP, name: "Push-up", raw: {}, updatedAt: nowInstant() },
  ]);
  const today = todayInZone(prefs.timezone);
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  return { server, db, userId, prefs, today, cookie };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

const lane = (ctx: Ctx) => executeCloudJobs(ctx.db, makeEnv(), ctx.userId, ctx.prefs, { fetchImpl: ctx.server.fetchImpl });
const rewritesOf = (db: Db, workoutId: string) =>
  db
    .select()
    .from(schema.corosWriteJobs)
    .where(and(eq(schema.corosWriteJobs.workoutId, workoutId), eq(schema.corosWriteJobs.kind, "coach_update_workout")));
const rowOf = async (db: Db, workoutId: string) =>
  (await db.select().from(schema.plannedWorkouts).where(eq(schema.plannedWorkouts.id, workoutId)))[0]!;

/** A strength session pushed for real, then eased; the rewrite LANDS and is recorded as the old comparator saw it. */
async function failedButLanded(ctx: Ctx, date: string, tag = date): Promise<string> {
  const added = await applyOps(ctx.db, ctx.userId, ctx.prefs, `p-add-${tag}`, [coachOpSchema.parse({ kind: "add", date, session: STRENGTH })]);
  const workoutId = added.created[0]!;
  await lane(ctx);
  expect((await rowOf(ctx.db, workoutId)).corosSyncState).toBe("synced");
  await applyOps(ctx.db, ctx.userId, ctx.prefs, `p-ease-${tag}`, [coachOpSchema.parse({ kind: "ease", workoutId, session: EASED })]);
  oldVerdict.next = true;
  await lane(ctx);
  const [job] = await rewritesOf(ctx.db, workoutId);
  expect(job!.status).toBe("failed");
  expect(job!.lastErrorCategory).toBe("verification_failed");
  return workoutId;
}

async function tapRetry(ctx: Ctx) {
  const app = mountRoutes(ctx.db, "/api/sync", syncRoutes);
  const res = await app.request("/api/sync/retry", { method: "POST", headers: { Cookie: ctx.cookie } }, makeEnv());
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

describe("Retry re-runs a strength rewrite that landed but was marked failed", () => {
  it("revives the failed rewrite; the drain re-runs it against the renormalizing COROS and it verifies", async () => {
    const ctx = await setup();
    const workoutId = await failedButLanded(ctx, addDays(ctx.today, 5));
    expect((await rowOf(ctx.db, workoutId)).corosSyncState).toBe("sync_issue");
    expect((await computeSyncStatus(ctx.db, ctx.userId, ctx.prefs)).issueCount).toBe(1);
    expect(await openIntentFor(ctx.db, ctx.userId, workoutId, "content")).toBeTruthy();

    const answer = await tapRetry(ctx);

    expect(answer.rewritesRetried).toBe(1);
    const [revived] = await rewritesOf(ctx.db, workoutId);
    expect(revived!.status).toBe("queued");
    expect(revived!.lastErrorCategory).toBeNull();
    expect((revived!.payload as { attempts?: number }).attempts ?? 0).toBe(0);

    await lane(ctx);

    const [done] = await rewritesOf(ctx.db, workoutId);
    expect(done!.status, done!.lastErrorDetail ?? "").toBe("verified");
    const row = await rowOf(ctx.db, workoutId);
    expect(row.corosSyncState).toBe("synced");
    expect(await openIntentFor(ctx.db, ctx.userId, workoutId, "content")).toBeFalsy();
    expect((await computeSyncStatus(ctx.db, ctx.userId, ctx.prefs)).issueCount).toBe(0);
  });

  it("leaves a past session's failed rewrite alone: its watch copy is history", async () => {
    const ctx = await setup();
    const workoutId = await failedButLanded(ctx, addDays(ctx.today, 2));
    // The day passes.
    await ctx.db
      .update(schema.plannedWorkouts)
      .set({ effectiveDate: addDays(ctx.today, -2) })
      .where(eq(schema.plannedWorkouts.id, workoutId));

    const answer = await tapRetry(ctx);

    expect(answer.rewritesRetried).toBe(0);
    expect((await rewritesOf(ctx.db, workoutId))[0]!.status).toBe("failed");
  });

  it("never revives a rewrite a later one replaced — it would put the older content back on the watch", async () => {
    const ctx = await setup();
    const workoutId = await failedButLanded(ctx, addDays(ctx.today, 6));
    // The athlete approves another change to the same session, and it verifies.
    await applyOps(ctx.db, ctx.userId, ctx.prefs, "p-ease-again", [coachOpSchema.parse({ kind: "ease", workoutId, session: STRENGTH })]);
    await lane(ctx);
    const jobs = await rewritesOf(ctx.db, workoutId);
    expect(jobs.map((j) => j.status).sort()).toEqual(["failed", "verified"]);

    const answer = await tapRetry(ctx);

    expect(answer.rewritesRetried).toBe(0);
    expect((await rewritesOf(ctx.db, workoutId)).map((j) => j.status).sort()).toEqual(["failed", "verified"]);
  });
});
