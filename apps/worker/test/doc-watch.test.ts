/**
 * A document workout on the watch (Stage 2 spec §10; fix round 1): EVERY watch path re-gates its build with the day's
 * reading — a first Send, a Retry of a failed push, a Send after Start — and refuses `gated` when the day keeps a move
 * of it out; the sheet's watch state says so. Its stamp is its own title. Send stays within the free plan's budget.
 * Synthetic data only; the clock pinned to noon on the fixture's day.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { workoutDocSchema, type UserPreferences, type WorkoutDoc } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { createDocWorkout } from "../src/services/doc-workouts.js";
import { buildSession, recordCheck, startSession } from "../src/services/session-build.js";
import { savePreferences } from "../src/services/calendar-sync.js";
import { connectTestCoros, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { calmDoc, landingsDoc } from "./doc-workout-fixture.js";
import { DAY, NOON, seedCatalog, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, sessionBuilds } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

/** A few minutes after noon: a check given now is the day's latest. */
const LATER = "2026-10-09T19:05:00.000Z";
const BUDGET = 45;

let db: Db;
let statements = 0;
let userId: string;
let prefs: UserPreferences;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  await seedTmj(db, userId);
  await seedCatalog(db);
});

afterEach(() => {
  vi.useRealTimers();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });

/** A document workout for today, built with a calm jaw (the jump open). */
async function builtDoc(doc: WorkoutDoc = landingsDoc()): Promise<{ workoutId: string; buildId: string }> {
  await recordCheck(db, userId, { profileId: "tmj", value: 1, feelingOff: false }, ctx());
  const { workout } = await createDocWorkout(db, userId, { date: DAY, time: "18:00", doc }, ctx());
  const built = await buildSession(db, userId, workout.id, { checks: { tmj: { pre: 1, feelingOff: false } } }, ctx());
  expect(built.build!.fromDoc!.swaps).toEqual([]);
  return { workoutId: workout.id, buildId: built.build!.buildId };
}

/** The jaw rises after the build and the athlete feels off: the day's latest reading closes the jump (since 2026-10-23 a high number alone no longer does). */
const flare = () => recordCheck(db, userId, { profileId: "tmj", value: 6, feelingOff: true }, { today: DAY, now: LATER });

const call = async (method: "GET" | "POST", path: string, body?: unknown, env: Env = switchOn()) => {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const res = await mountRoutes(db, "/api/sessions", sessionRoutes).request(
    `/api/sessions/${path}`,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    env,
  );
  return { status: res.status, body: (await res.json()) as any };
};

/** Send as the sheet does: with the digest of the preview it showed (a refused preview has none). */
async function send(workoutId: string, buildId: string) {
  const preview = await call("GET", `${workoutId}/watch-preview`);
  const digest = preview.status === 200 ? (preview.body.digest as string) : "no-preview";
  return call("POST", `${workoutId}/send-to-watch`, { buildId, digest });
}

const pushOf = async (buildId: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${buildId}`)))[0];

describe("a document workout's watch paths re-gate with the day's reading", () => {
  it("a first Send of a calm build queues it, stamped with the workout's own title", async () => {
    const { workoutId, buildId } = await builtDoc();
    const preview = await call("GET", `${workoutId}/watch-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.stamp).toBe(`Legs and landings — ${DAY}`);
    const sent = await send(workoutId, buildId);
    expect(sent.status).toBe(200);
    expect(sent.body.watch).toEqual({ state: "sending" });
    expect((await pushOf(buildId))!.status).toBe("queued");
  });

  it("Start on the build sent at a calm reading, still calm: started", async () => {
    const { workoutId, buildId } = await builtDoc();
    expect((await send(workoutId, buildId)).status).toBe(200);
    const started = await call("POST", `${workoutId}/start`, { buildId });
    expect(started.status).toBe(200);
    expect(started.body.contentState).toBe("started");
  });

  it("Retry of a failed push once the reading has risen: 409 gated, nothing queued again", async () => {
    const { workoutId, buildId } = await builtDoc();
    expect((await send(workoutId, buildId)).status).toBe(200);
    await db.update(corosWriteJobs).set({ status: "failed" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    await flare();
    const preview = await call("GET", `${workoutId}/watch-preview`);
    expect(preview).toEqual({ status: 409, body: { error: "gated" } });
    const retry = await call("POST", `${workoutId}/send-to-watch`, { buildId, digest: "no-preview" });
    expect(retry).toEqual({ status: 409, body: { error: "gated" } });
    expect((await pushOf(buildId))!.status).toBe("failed");
    // The sheet says why Send is not offered: gated, not "Couldn't send" with a Retry that would be refused.
    expect((await call("GET", workoutId)).body.watch).toEqual({ state: "unavailable", reason: "gated" });
  });

  it("a failed push the day closed, with COROS writes since turned off: the sheet gives Retry's own reason, in Retry's order", async () => {
    const { workoutId, buildId } = await builtDoc();
    expect((await send(workoutId, buildId)).status).toBe(200);
    await db.update(corosWriteJobs).set({ status: "failed" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    await flare();
    await savePreferences(db, userId, { ...prefs, corosWritesEnabled: false });
    const retry = await call("POST", `${workoutId}/send-to-watch`, { buildId, digest: "no-preview" });
    expect(retry).toEqual({ status: 409, body: { error: "writes_off" } });
    expect((await call("GET", workoutId)).body.watch).toEqual({ state: "unavailable", reason: "writes_off" });
  });

  it("a failed push the day still allows is offered Retry, and Retry queues it", async () => {
    const { workoutId, buildId } = await builtDoc();
    expect((await send(workoutId, buildId)).status).toBe(200);
    await db.update(corosWriteJobs).set({ status: "failed" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    expect((await call("GET", workoutId)).body.watch).toEqual({ state: "failed" });
    expect((await send(workoutId, buildId)).status).toBe(200);
    expect((await pushOf(buildId))!.status).toBe("queued");
  });

  it("Send after Start once the reading has risen: 409 gated, no push", async () => {
    const { workoutId, buildId } = await builtDoc();
    await startSession(db, userId, workoutId, buildId, NOON);
    await flare();
    expect((await call("GET", workoutId)).body.watch).toEqual({ state: "unavailable", reason: "gated" });
    const refused = await send(workoutId, buildId);
    expect(refused).toEqual({ status: 409, body: { error: "gated" } });
    expect(await pushOf(buildId)).toBeUndefined();
  });

  it("a first Send of a build the reading closed: refused, nothing locked", async () => {
    const { workoutId, buildId } = await builtDoc(landingsDoc({ alternates: false }));
    await flare();
    const refused = await send(workoutId, buildId);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("gated");
    expect((await db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, workoutId))).filter((b) => b.lockedAt !== null)).toEqual([]);
  });

  it("a calm document is sent whatever the reading", async () => {
    const { workoutId, buildId } = await builtDoc(calmDoc());
    await startSession(db, userId, workoutId, buildId, NOON);
    await flare();
    expect((await send(workoutId, buildId)).status).toBe(200);
  });
});

describe("a document longer than a watch takes (Stage 2 batch end: one bound for the app, one for the watch)", () => {
  /** 15 timed moves, 14 rounds: 210 steps — past the watch's 200, well within what the app plays. */
  const longDoc = (): WorkoutDoc =>
    workoutDocSchema.parse({
      version: 1, title: "Long flow", intent: { summary: "A long, easy flow.", goals: [], focus: [], effort: "maintain" }, source: { kind: "studio" },
      parts: [{
        purpose: "main", format: "holds", rounds: 14,
        items: Array.from({ length: 15 }, (_, i) => ({ kind: "exercise", libraryId: ["catCow", "deadBug", "birdDog"][i % 3], dose: { sets: 1, holdSec: 5 } })),
      }],
    });

  it("is made and plays every step in the app; the watch refuses it whole, the preview and Send saying why", async () => {
    const { workoutId, buildId } = await builtDoc(longDoc());
    const session = await call("GET", workoutId);
    expect(session.body.build.steps.filter((s: { kind: string }) => s.kind !== "rest")).toHaveLength(210);
    expect(session.body.watch).toEqual({ state: "unavailable", reason: "too_long" });
    const preview = await call("GET", `${workoutId}/watch-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.refusal).toBe("too_long");
    expect(preview.body.steps).toHaveLength(210);
    expect(await call("POST", `${workoutId}/send-to-watch`, { buildId, digest: preview.body.digest })).toEqual({ status: 409, body: { error: "too_long" } });
    expect(await pushOf(buildId)).toBeUndefined();
  });

  it("free-text moves never go to the watch: 240 steps played, 160 sent — the watch takes it, and the document is not warned", async () => {
    const mixed = workoutDocSchema.parse({
      ...longDoc(),
      parts: [{
        purpose: "main", format: "holds", rounds: 40,
        items: [
          ...["catCow", "deadBug", "birdDog", "bridge"].map((libraryId) => ({ kind: "exercise", libraryId, dose: { sets: 1, holdSec: 5 } })),
          { kind: "free_exercise", name: "Wall angels", dose: { sets: 1, holdSec: 5 } },
          { kind: "free_exercise", name: "Toe yoga", dose: { sets: 1, holdSec: 5 } },
        ],
      }],
    });
    const { workout, warnings } = await createDocWorkout(db, userId, { date: DAY, time: "07:00", doc: mixed }, ctx());
    expect(warnings.filter((w) => w.code === "too_long_for_watch")).toEqual([]);
    const built = await buildSession(db, userId, workout.id, { checks: { tmj: { pre: 1, feelingOff: false } } }, ctx());
    expect(built.build!.steps.filter((s) => s.kind !== "rest")).toHaveLength(240);
    const preview = await call("GET", `${workout.id}/watch-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.refusal).toBeNull();
    expect(preview.body.steps).toHaveLength(160);
  });
});

describe("the budget", () => {
  it("Send of a document workout: within 45 D1 statements (no lane runs, no fetch)", async () => {
    const { workoutId, buildId } = await builtDoc();
    const preview = await call("GET", `${workoutId}/watch-preview`);
    statements = 0;
    const sent = await call("POST", `${workoutId}/send-to-watch`, { buildId, digest: preview.body.digest });
    expect(sent.status).toBe(200);
    expect(statements).toBeLessThanOrEqual(BUDGET);
    statements = 0;
    expect((await call("GET", `${workoutId}/watch-preview`)).status).toBe(200);
    expect(statements).toBeLessThanOrEqual(BUDGET);
  });
});
