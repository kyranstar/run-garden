/**
 * A RETIRE CUT SHORT CAN RUN AGAIN (Stage 2 Task 9, fix round 3). The plan is marked retired LAST: a request that dies
 * after its removals are queued and before the mark leaves the plan listed, and its Retire runs again — the retire push
 * supersedes the removals already queued and queues them anew, then marks it. Here the request dies where the notes are
 * dismissed, the step just before the mark. Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant, type LiftingPlan, type PlanBrief } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { studioRoutes } from "../src/routes/studio.js";
import { coachRoutes } from "../src/routes/coach.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const cut = vi.hoisted(() => ({ on: false }));
vi.mock("../src/services/sync-notes.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/sync-notes.js")>();
  return {
    ...real,
    dismissStudioPlanNotes: async (...args: Parameters<typeof real.dismissStudioPlanNotes>) => {
      if (cut.on) throw new Error("cut short");
      return real.dismissStudioPlanNotes(...args);
    },
  };
});

const { corosWriteJobs, studioPlanPushes, studioPlans } = schema;
const SQUAT = "425898928110747648";

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: "k",
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

let db: Db;
let userId: string;
let cookie: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T19:00:00Z"));
  cut.on = false;
  db = makeTestDb();
  ({ userId } = await makeTestUser(db, { corosWritesEnabled: true }));
  cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
});

afterEach(() => {
  vi.useRealTimers();
});

/** A two-week plan pushed to COROS: week 1 (Sep 7) behind the day, week 2 (Sep 14, 15) ahead. */
async function pushedPlan(): Promise<string> {
  await db.insert(schema.corosExercises).values({ id: SQUAT, name: "Back Squat", raw: {}, updatedAt: nowInstant() });
  const brief: PlanBrief = {
    goal: "strength",
    durationWeeks: 2,
    sessionsPerWeek: 1,
    preferredDays: [1],
    sessionMinutes: 45,
    equipment: "full gym",
    constraints: "",
    notes: "",
    startDate: "2026-09-07",
  };
  const session = { title: "Full Body", weekday: 1, exercises: [{ originId: SQUAT, name: "Back Squat", sets: 3, reps: 10, weight: { type: "bodyweight" as const }, restSeconds: 60 }] };
  const plan: LiftingPlan = { name: "Autumn Strength", brief, weeks: [{ sessions: [session] }, { sessions: [session] }] };
  const planId = newId();
  await db.insert(studioPlans).values({ id: planId, userId, brief: brief as never, plan: plan as never, version: 1, createdAt: nowInstant(), updatedAt: nowInstant() });
  for (const [day, title, slot] of [
    ["2026-09-07", "Full Body — wk 1", "21"],
    ["2026-09-14", "Full Body — wk 2", "22"],
    ["2026-09-15", "Full Body — wk 2b", "23"],
  ] as const) {
    await db.insert(studioPlanPushes).values({
      id: newId(),
      planId,
      planVersion: 1,
      happenDay: day,
      sessionTitle: title,
      corosIdInPlan: slot,
      corosProgramId: slot,
      corosPlanId: "coros-plan",
      sessionFingerprint: "fp",
      status: "verified",
      error: null,
      updatedAt: nowInstant(),
    });
  }
  return planId;
}

const retire = (planId: string) =>
  mountRoutes(db, "/api/studio", studioRoutes).request(`/api/studio/plans/${planId}/retire`, { method: "POST", headers: { Cookie: cookie } }, makeEnv());
const listed = async () => {
  const res = await mountRoutes(db, "/api/coach", coachRoutes).request("/api/coach/plans", { headers: { Cookie: cookie } }, makeEnv());
  return ((await res.json()) as { plans: Array<{ id: string; source?: string }> }).plans.filter((p) => p.source === "studio").map((p) => p.id);
};
const removals = () => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.userId, userId));

describe("a retire cut short before its mark", () => {
  it("leaves the plan listed; Retire runs again, re-queues the removals once, and marks it", async () => {
    const planId = await pushedPlan();
    cut.on = true;
    const first = await retire(planId);
    expect(first.status).toBe(500);
    // Its removals were queued, but the plan was never marked: it is still there to retire.
    expect((await removals()).filter((j) => j.status === "queued")).toHaveLength(2);
    expect(await listed()).toEqual([planId]);

    cut.on = false;
    const again = await retire(planId);
    expect(again.status).toBe(200);
    // The first request's removals were superseded and queued anew: one live removal a session ahead, no more.
    const jobs = await removals();
    expect(jobs.filter((j) => j.status === "queued")).toHaveLength(2);
    expect(jobs.filter((j) => j.status === "superseded")).toHaveLength(2);
    expect(await listed()).toEqual([]);
    expect((await retire(planId)).status).toBe(409);
  });
});
