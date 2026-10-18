/**
 * A DESIGNED RUN COROS STORES DIFFERENTLY, ALL THE WAY TO ITS REMOVAL (review-2 N1). The create read back differently
 * (`watch_copy_differs`); the body check eased it (a single easy block, which COROS stores as sent); its Undo rewrote
 * the designed run back under a new stamp, and COROS stored that differently too. The Undo's write landed and is ours,
 * so it is verified like the create, and ownership follows its stamp: removing the run takes the Undo's copy off the
 * watch. (Marked failed, the stamp stayed the ease's, the delete found nothing, counted itself done, and left the
 * designed copy on the watch.) Every write against the mock COROS, through the real lane; synthetic data.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, runWatchSessionOf, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { answerBodyCheck, undoBodyCheck } from "../src/services/body-check.js";
import { enqueueWatchCreate } from "../src/services/coach-apply.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { designedRunStages } from "../src/services/designed-runs.js";
import { enqueueUnpushIfOurs } from "../src/services/plan-mutations.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { DAY, NOON } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkoutStages, plannedWorkouts } = schema;
vi.setConfig({ testTimeout: 60_000 });

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const env = (): Env =>
  ({
    DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s", TOKEN_ENCRYPTION_KEY: TEST_KEY, ALLOWED_GOOGLE_EMAIL: "runner@example.com", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "c",
  }) as Env;

const DOC: WorkoutDoc = {
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    { purpose: "run", format: "intervals", rounds: 3, items: [{ kind: "run", effort: "tempo", target: { durationSec: 480 } }, { kind: "run", effort: "recovery", target: { durationSec: 120 } }] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
  ],
  source: { kind: "coach", ref: "run:r-1" },
  basedOn: { kind: "proposal", id: "dp-r-1", opId: "r-1" },
};
const SESSION = (() => {
  const made = runWatchSessionOf(DOC);
  if (!("session" in made)) throw new Error(made.refused);
  return made.session;
})();

let db: Db;
let userId: string;
let prefs: UserPreferences;
let server: MockCorosServer;
let fetchImpl: typeof fetch;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  server = mockCorosServer();
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, env(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
  // A COROS that files a program's first recovery as work: the designed run's every write reads back differently;
  // the ease's single easy block is stored as sent.
  const inner = server.fetchImpl;
  fetchImpl = async function (input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/training/schedule/update" && typeof init?.body === "string") {
      const body = JSON.parse(init.body) as { programs?: Array<{ exercises?: Array<Record<string, unknown>> }> };
      for (const p of body.programs ?? []) if (p.exercises?.[2]?.exerciseType === 4) p.exercises[2]!.exerciseType = 2;
      return inner(input, { ...init, body: JSON.stringify(body) });
    }
    return inner(input, init);
  } as typeof fetch;
});
afterEach(() => vi.useRealTimers());

const ctx = () => ({ today: DAY, now: NOON, prefs });
const drain = () => executeCloudJobs(db, env(), userId, prefs, { fetchImpl });
const job = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0]!;
/** The run's rewrite in the given state (the ease's, then the Undo's, each queued in turn). */
const rewrite = async (id: string, status: string) =>
  (await db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.workoutId, id), eq(corosWriteJobs.kind, "coach_update_workout")))).find((j) => j.status === status);
/** The programs COROS holds on the run's day. */
const onTheDay = () => {
  const day = Number(DAY.replaceAll("-", ""));
  const ids = new Set((server.state.schedule.entities ?? []).filter((e) => Number(e.happenDay) === day).map((e) => String(e.idInPlan)));
  return (server.state.schedule.programs ?? []).filter((p) => ids.has(String(p.idInPlan)));
};

describe("a designed run COROS stores differently: create, ease, Undo, removal", () => {
  it("the Undo's differing write is verified and owned, and removing the run takes the Undo's copy off the watch", async () => {
    const id = newId();
    await db.insert(plannedWorkouts).values({
      id, userId, planId: `studio-${userId}`, sourceWorkoutId: id, title: "Tempo blocks", category: "quality", qualitySubtype: "tempo", sport: "run",
      originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "18:00", sourceContentFingerprint: "seed",
      fallbackEstimatedDurationSeconds: 3000, calendarBlockDurationSeconds: 3000, stageSummary: "10 min easy · 3 × 8 min tempo / 2 min recovery · 10 min easy",
      corosSyncState: "calendar_only", completionState: "scheduled", origin: null, workoutDoc: JSON.stringify(DOC), workoutDocRev: 1, createdAt: NOON, updatedAt: NOON,
    });
    await db.insert(plannedWorkoutStages).values(designedRunStages(id, DOC, 289));
    await db.insert(schema.dailyHealth).values({ id: `${userId}:t`, userId, date: DAY, thresholdPaceSecPerKm: 289, contentFingerprint: "h", updatedAt: NOON });

    // 1. The create: verified, read back differently.
    expect(await enqueueWatchCreate(db, userId, id, DAY, SESSION, NOON, 289)).toBe(`${id}-push`);
    await drain();
    expect(await job(`${id}-push`)).toMatchObject({ status: "verified", lastErrorCategory: "watch_copy_differs" });

    // 2. The ease: one easy block, stored as sent.
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const ease = (await rewrite(id, "queued"))!;
    await drain();
    expect(await job(ease.id)).toMatchObject({ status: "verified", lastErrorCategory: null });

    // 3. The Undo, a minute on: the designed run again, under a new stamp, stored differently — landed, and ours.
    vi.setSystemTime(new Date(Date.parse(NOON) + 60_000));
    await undoBodyCheck(db, userId, id, ctx());
    const undo = (await rewrite(id, "queued"))!;
    expect((undo.payload as { session: unknown }).session).toEqual(SESSION);
    // The premise: the Undo writes under a stamp of its own, not the ease's.
    expect((undo.payload as { name: string }).name).not.toBe((ease.payload as { name: string }).name);
    await drain();
    const undone = await job(undo.id);
    expect(undone).toMatchObject({ status: "verified", lastErrorCategory: "watch_copy_differs" });
    expect(undone.lastErrorDetail).toContain("ex[2].exerciseType 4→2");
    const [row] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id));
    expect(row!.corosSyncState).toBe("synced");
    expect(onTheDay().map((p) => p.name)).toEqual([(undo.payload as { name: string }).name]);

    // 4. Removed from the plan: the delete is addressed by the Undo's stamp, and the watch holds nothing on the day.
    await db.update(plannedWorkouts).set({ archivedAt: NOON }).where(eq(plannedWorkouts.id, id));
    const [archived] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id));
    await enqueueUnpushIfOurs(db, userId, archived!, NOON, prefs);
    expect(((await job(`${id}-unpush`)).payload as { name: string }).name).toBe((undo.payload as { name: string }).name);
    await drain();
    expect(onTheDay()).toEqual([]);
  });
});
