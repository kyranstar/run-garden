/**
 * A DESIGNED RUN ON THE v2 WIRE, ALL THE WAY TO ITS REMOVAL (§8 phase 2, `RUN_WIRE_V2` on): created as a repeat group
 * with distance steps, eased by the body check (a single easy block), its Undo writing the group back, removed from the
 * plan — through the real lane, against a COROS that re-encodes what it stores (renormalizing-coros.ts: its own ids,
 * links, container targets, duration and distance). Every write verifies by value with nothing to say — the server's own
 * figures set aside — ownership follows each stamp, and the removal takes the Undo's copy off the watch. Synthetic data.
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, runWatchSessionOf, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import { nextMonday } from "../../../packages/coros/test/mock-coros-server.js";
import { renormalizingCoros, type RenormalizingCoros } from "../../../packages/coros/test/renormalizing-coros.js";
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
    RUN_WIRE_V2: "1",
  }) as Env;

const DOC: WorkoutDoc = {
  version: 1,
  title: "Tempo blocks",
  intent: { summary: "Three tempo blocks.", goals: [], focus: [], effort: "develop" },
  parts: [
    { purpose: "warmup", format: "steady", items: [{ kind: "run", effort: "easy", target: { durationSec: 600 } }] },
    { purpose: "run", format: "intervals", rounds: 3, items: [{ kind: "run", effort: "tempo", target: { distanceM: 800 } }, { kind: "run", effort: "recovery", target: { durationSec: 90 } }] },
    { purpose: "cooldown", format: "steady", items: [{ kind: "run", effort: "easy", target: { distanceM: 2000 } }] },
  ],
  source: { kind: "coach", ref: "run:r-1" },
  basedOn: { kind: "proposal", id: "dp-r-1", opId: "r-1" },
};
const SESSION = (() => {
  const made = runWatchSessionOf(DOC, "v2");
  if (!("session" in made)) throw new Error(made.refused);
  return made.session;
})();

let db: Db;
let userId: string;
let prefs: UserPreferences;
let server: RenormalizingCoros;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  server = renormalizingCoros({ baseMonday: nextMonday() });
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, env(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
});
afterEach(() => vi.useRealTimers());

const ctx = () => ({ today: DAY, now: NOON, prefs });
const drain = () => executeCloudJobs(db, env(), userId, prefs, { fetchImpl: server.fetchImpl });
const job = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0]!;
const rewrite = async (id: string, status: string) =>
  (await db.select().from(corosWriteJobs).where(and(eq(corosWriteJobs.workoutId, id), eq(corosWriteJobs.kind, "coach_update_workout")))).find((j) => j.status === status);
/** The programs COROS holds on the run's day. */
const onTheDay = () => {
  const day = Number(DAY.replaceAll("-", ""));
  const ids = new Set((server.state.schedule.entities ?? []).filter((e) => Number(e.happenDay) === day).map((e) => String(e.idInPlan)));
  return (server.state.schedule.programs ?? []).filter((p) => ids.has(String(p.idInPlan)));
};
const shape = () => onTheDay().map((p) => (p.exercises ?? []).map((e) => (e.isGroup ? `group×${e.sets}` : e.targetType === 5 ? `${Number(e.targetValue) / 100} m` : `${e.targetValue} s`)));

describe("a designed run on the v2 wire: create, ease, Undo, removal", () => {
  it("each write lands as written and verifies with nothing to say; the removal takes the Undo's copy off the watch", async () => {
    const id = newId();
    await db.insert(plannedWorkouts).values({
      id, userId, planId: `studio-${userId}`, sourceWorkoutId: id, title: "Tempo blocks", category: "quality", qualitySubtype: "tempo", sport: "run",
      originalPlanDate: DAY, lastVerifiedCorosDate: "", effectiveDate: DAY, effectiveTime: "18:00", sourceContentFingerprint: "seed",
      fallbackEstimatedDurationSeconds: 3000, calendarBlockDurationSeconds: 3000, stageSummary: "10 min easy · 3 × 800 m tempo / 90 s recovery · 2 km easy",
      corosSyncState: "calendar_only", completionState: "scheduled", origin: null, workoutDoc: JSON.stringify(DOC), workoutDocRev: 1, createdAt: NOON, updatedAt: NOON,
    });
    await db.insert(plannedWorkoutStages).values(designedRunStages(id, DOC, 289));
    await db.insert(schema.dailyHealth).values({ id: `${userId}:t`, userId, date: DAY, thresholdPaceSecPerKm: 289, contentFingerprint: "h", updatedAt: NOON });

    // 1. The create: the group and its distances, as v2 writes them.
    expect(await enqueueWatchCreate(db, userId, id, DAY, SESSION, NOON, 289)).toBe(`${id}-push`);
    await drain();
    expect(await job(`${id}-push`)).toMatchObject({ status: "verified", lastErrorCategory: null });
    expect(shape()).toEqual([["600 s", "group×3", "800 m", "90 s", "2000 m"]]);

    // 2. The ease: one easy block.
    await answerBodyCheck(db, userId, id, { feel: "heavy" }, ctx());
    const ease = (await rewrite(id, "queued"))!;
    await drain();
    expect(await job(ease.id)).toMatchObject({ status: "verified", lastErrorCategory: null });
    expect(shape()[0]).toHaveLength(1);

    // 3. The Undo, a minute on: the group back, verified by value, nothing to say.
    vi.setSystemTime(new Date(Date.parse(NOON) + 60_000));
    await undoBodyCheck(db, userId, id, ctx());
    const undo = (await rewrite(id, "queued"))!;
    await drain();
    expect(await job(undo.id)).toMatchObject({ status: "verified", lastErrorCategory: null });
    expect(shape()).toEqual([["600 s", "group×3", "800 m", "90 s", "2000 m"]]);

    // 4. Removed from the plan: the delete under the Undo's stamp, and nothing left on the day.
    await db.update(plannedWorkouts).set({ archivedAt: NOON }).where(eq(plannedWorkouts.id, id));
    const [archived] = await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id));
    await enqueueUnpushIfOurs(db, userId, archived!, NOON, prefs);
    expect(((await job(`${id}-unpush`)).payload as { name: string }).name).toBe((undo.payload as { name: string }).name);
    await drain();
    expect(onTheDay()).toEqual([]);
  });
});
