/**
 * A RE-TIMED RUN WHOSE CREATE WAS STILL QUEUED (review-L re-review I1). The re-time brings the queued create up to the
 * new session and records the app's content claim (`coach_adjust`); the create then lands that very session. A
 * create's verify closes an open content claim whose fingerprint is the session it carried — so the row is synced, not
 * "Older on watch" while the watch holds the current version. A claim on another session (the create carried an older
 * one: the drain read it before the re-time) stays open, and the row still says so. Driven through the real lane against
 * the mock COROS; every statement and fetch of the drain counted. Synthetic data only.
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone, type UserPreferences } from "@rg/domain";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { planRoutes } from "../src/routes/plan.js";
import { retimeOfRow } from "../src/services/adjust-retime.js";
import { applyOps } from "../src/services/coach-apply.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { openIntentFor, recordIntent } from "../src/services/sync-intents.js";
import { watchEarlierVersions } from "../src/services/watch-version.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";

const { plannedWorkouts, plannedWorkoutStages, corosWriteJobs } = schema;
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
/** The drain's budget: one job a request, statements and fetches alike (the suites budget 45 of the free plan's 50). */
const BUDGET = 45;

function makeEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"], ASSETS: {} as unknown as Env["ASSETS"], APP_URL: "https://app.test", FIXTURE_MODE: "0", AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s", TOKEN_ENCRYPTION_KEY: TEST_KEY, ALLOWED_GOOGLE_EMAIL: "runner@example.com", GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

/** 5 min easy · 5 × 5 min threshold · 5 min easy: the thread coach's tempo, on the plan with its create queued. */
const tempo35 = {
  category: "quality" as const,
  title: "Tempo",
  durationMinutes: 35,
  run: {
    blocks: [
      { kind: "duration" as const, value: 5, intensity: "easy" as const },
      ...Array.from({ length: 5 }, () => ({ kind: "duration" as const, value: 5, intensity: "threshold" as const })),
      { kind: "duration" as const, value: 5, intensity: "easy" as const },
    ],
  },
};

let counting = false;
let statements = 0;

async function account(): Promise<{ db: Db; userId: string; prefs: UserPreferences; server: ReturnType<typeof mockCorosServer>; id: string; today: string }> {
  const db = makeTestDb({ boundVariableCap: 100, onStatement: () => (counting ? (statements += 1) : undefined) });
  const { userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true });
  const server = mockCorosServer();
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe("connected");
  const today = todayInZone(prefs.timezone);
  const added = await applyOps(db, userId, prefs, "tp-1", [{ kind: "add", date: addDays(today, 3), session: tempo35 }]);
  return { db, userId, prefs, server, id: added.created[0]!, today };
}

/** The lane drains the queued create: every statement and fetch it costs. */
async function drain(a: Awaited<ReturnType<typeof account>>): Promise<number> {
  let fetches = 0;
  const fetchImpl = ((...args: Parameters<typeof fetch>) => {
    fetches += 1;
    return a.server.fetchImpl(...args);
  }) as typeof fetch;
  statements = 0;
  counting = true;
  try {
    await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl });
  } finally {
    counting = false;
  }
  return statements + fetches;
}

async function viewOf(a: Awaited<ReturnType<typeof account>>): Promise<string> {
  const cookie = `${SESSION_COOKIE}=${await createSession(a.db, a.userId)}`;
  const res = await mountRoutes(a.db, "/api/plan", planRoutes).request(`/api/plan/workouts/${a.id}`, { headers: { Cookie: cookie } }, makeEnv());
  return ((await res.json()) as { workout: { corosSyncView: string } }).workout.corosSyncView;
}

afterEach(() => {
  counting = false;
});

describe("a re-timed run's queued create lands the new session: its claim closes", () => {
  it("the reviewer's probe — the tempo re-timed 35 → 25, its create verified: the claim closed, the row synced, not listed as older on the watch", async () => {
    const a = await account();
    const row = (await a.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, a.id)))[0]!;
    const stages = await a.db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, a.id));
    const r = retimeOfRow(row, stages, 25, { thresholdSecPerKm: null, runWire: "v1" });
    if (r.kind !== "retimed") throw new Error("not re-timed");
    await applyOps(a.db, a.userId, a.prefs, "dp-2", [{ kind: "adjust", workoutId: a.id, durationMinutes: 25 }], { retimes: new Map([[a.id, r.expect]]) });
    expect((await openIntentFor(a.db, a.userId, a.id, "content"))?.source).toBe("coach_adjust");

    const cost = await drain(a);
    const [create] = await a.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `${a.id}-push`));
    expect(create!.status).toBe("verified");
    // The watch holds the three-rep tempo: the app's claim on it is answered.
    const program = a.server.programByIdInPlan((await a.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, a.id)))[0]!.sourceIdInPlan!)!;
    expect(program.exercises!.length).toBe(5);
    expect(await openIntentFor(a.db, a.userId, a.id, "content")).toBeNull();
    expect(await viewOf(a)).toBe("synced");
    expect((await watchEarlierVersions(a.db, a.userId, a.today)).map((w) => w.workoutId)).not.toContain(a.id);
    // Pinned: 28 statements and fetches — 27 before the claim's close, which is one statement.
    expect(cost, `the create's drain: ${cost} statements and fetches`).toBe(28);
    expect(cost).toBeLessThanOrEqual(BUDGET);
  });

  it("A2: a create whose first attempt LANDED (its answer lost), re-timed while its retry waits — the retry finds the older session there and closes nothing", async () => {
    const a = await account();
    // Attempt 1: the write reaches COROS, its answer is lost — the lane records a transient error and requeues it.
    let lost = false;
    const lossy = (async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0] instanceof Request ? args[0].url : args[0]);
      const res = await a.server.fetchImpl(...args);
      if (!lost && url.includes("/training/schedule/update")) {
        lost = true;
        throw new TypeError("fetch failed");
      }
      return res;
    }) as typeof fetch;
    await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: lossy, cap: 1 });
    const [first] = await a.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `${a.id}-push`));
    expect(first!.status, "requeued for its retry").toBe("queued");
    const landed = (a.server.state.schedule.programs ?? []).filter((p) => String(p.name ?? "").startsWith("Tempo"));
    expect(landed.map((p) => p.exercises?.length), "the 35-minute tempo is on the watch").toEqual([7]);

    // The coach re-times it 35 → 25 while the retry waits: the queued create is brought up to the new session.
    const row = (await a.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, a.id)))[0]!;
    const stages = await a.db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, a.id));
    const r = retimeOfRow(row, stages, 25, { thresholdSecPerKm: null, runWire: "v1" });
    if (r.kind !== "retimed") throw new Error("not re-timed");
    await applyOps(a.db, a.userId, a.prefs, "dp-2", [{ kind: "adjust", workoutId: a.id, durationMinutes: 25 }], { retimes: new Map([[a.id, r.expect]]) });

    await drain(a);
    const [create] = await a.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `${a.id}-push`));
    expect(create!.status, "the stamp is ours, on its day: verified").toBe("verified");
    const after = (await a.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, a.id)))[0]!;
    expect(a.server.programByIdInPlan(after.sourceIdInPlan!)!.exercises!.length, "the watch still holds the 35-minute tempo").toBe(7);
    // The app's claim on the 25-minute one is not answered by a copy this create never wrote.
    expect((await openIntentFor(a.db, a.userId, a.id, "content"))?.source).toBe("coach_adjust");
    expect(await viewOf(a)).toBe("content_stale");
    expect((await watchEarlierVersions(a.db, a.userId, a.today)).map((w) => w.workoutId)).toContain(a.id);
  });

  it("A2: when the copy an earlier attempt landed IS the new session, the row says so only until Send — whose rewrite verifies it and closes the claim", async () => {
    const a = await account();
    const row = (await a.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, a.id)))[0]!;
    const stages = await a.db.select().from(plannedWorkoutStages).where(eq(plannedWorkoutStages.workoutId, a.id));
    const r = retimeOfRow(row, stages, 25, { thresholdSecPerKm: null, runWire: "v1" });
    if (r.kind !== "retimed") throw new Error("not re-timed");
    await applyOps(a.db, a.userId, a.prefs, "dp-2", [{ kind: "adjust", workoutId: a.id, durationMinutes: 25 }], { retimes: new Map([[a.id, r.expect]]) });
    let lost = false;
    const lossy = (async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0] instanceof Request ? args[0].url : args[0]);
      const res = await a.server.fetchImpl(...args);
      if (!lost && url.includes("/training/schedule/update")) {
        lost = true;
        throw new TypeError("fetch failed");
      }
      return res;
    }) as typeof fetch;
    await executeCloudJobs(a.db, makeEnv(), a.userId, a.prefs, { fetchImpl: lossy, cap: 1 });
    await drain(a);
    expect((await a.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `${a.id}-push`)))[0]!.status).toBe("verified");
    expect(await viewOf(a), "a copy this create never wrote proves nothing").toBe("content_stale");

    const cookie = `${SESSION_COOKIE}=${await createSession(a.db, a.userId)}`;
    const sent = await mountRoutes(a.db, "/api/plan", planRoutes).request(`/api/plan/workouts/${a.id}/watch-version/send`, { method: "POST", headers: { Cookie: cookie } }, makeEnv());
    expect(sent.status).toBe(200);
    await drain(a);
    expect(await openIntentFor(a.db, a.userId, a.id, "content")).toBeNull();
    expect(await viewOf(a)).toBe("synced");
    const after = (await a.db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, a.id)))[0]!;
    expect(a.server.programByIdInPlan(after.sourceIdInPlan!)!.exercises!.length, "the 25-minute tempo").toBe(5);
  });

  it("a claim on another session than the one the create carried stays open — the row still says the watch holds an older one", async () => {
    // The race the review names: the drain read the create's session before the re-time brought it up to date, so the
    // create lands the older session while the claim is on the newer.
    const a = await account();
    await recordIntent(a.db, { userId: a.userId, targetKind: "workout", targetId: a.id, kind: "content", payload: { fingerprint: "coach-0badc0de" }, source: "coach_adjust" });
    await drain(a);
    expect((await a.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `${a.id}-push`)))[0]!.status).toBe("verified");
    expect((await openIntentFor(a.db, a.userId, a.id, "content"))?.source).toBe("coach_adjust");
    expect(await viewOf(a)).toBe("content_stale");
    expect((await watchEarlierVersions(a.db, a.userId, a.today)).map((w) => w.workoutId)).toContain(a.id);
  });

  it("only this row's content claim is answered: another row's on the same session, and this row's claim of another kind, stay open", async () => {
    const a = await account();
    const [create] = await a.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `${a.id}-push`));
    const carried = { fingerprint: create!.expectedContentFingerprint };
    await recordIntent(a.db, { userId: a.userId, targetKind: "workout", targetId: "cw-another-0-0", kind: "content", payload: carried, source: "coach_adjust" });
    await recordIntent(a.db, { userId: a.userId, targetKind: "workout", targetId: a.id, kind: "move", payload: carried, source: "user_move" });
    await drain(a);
    expect(await openIntentFor(a.db, a.userId, "cw-another-0-0", "content")).not.toBeNull();
    expect(await openIntentFor(a.db, a.userId, a.id, "move")).not.toBeNull();
  });

  it("a claim that names no session (the watch-version reclaim's) is no answer either: it stays open", async () => {
    const a = await account();
    await recordIntent(a.db, { userId: a.userId, targetKind: "workout", targetId: a.id, kind: "content", source: "coach_adjust" });
    await drain(a);
    expect(await openIntentFor(a.db, a.userId, a.id, "content")).not.toBeNull();
  });

  it("a create with no claim at all costs what it did, and closes nothing", async () => {
    const a = await account();
    const cost = await drain(a);
    expect((await a.db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `${a.id}-push`)))[0]!.status).toBe("verified");
    expect(await openIntentFor(a.db, a.userId, a.id, "content")).toBeNull();
    expect(cost).toBeLessThanOrEqual(BUDGET);
  });
});
