/**
 * SEND TODAY'S SESSION TO THE WATCH — the switch and the routes (Phase 3 Task 5; spec §4.1–§4.4, §6; rulings 3-R2,
 * 3-R4, 3-R5).
 *
 *   GET  /api/sessions/:workoutId/watch-preview   the steps as the watch will hold them, read off the wire program
 *   POST /api/sessions/:workoutId/send-to-watch   {buildId, digest} → lock the build (content stays `built`), queue push:<buildId>
 *   POST /api/sessions/:workoutId/take-off-watch  supersede a queued push, or queue unpush:<buildId> for a pushed one
 *
 * The switch (`WATCH_PUSH_ENABLED`, a Worker var, only "1" is on) off: every watch route is 404 and every session
 * response carries `watch: null`. On: Send has Start's preconditions plus writes on and COROS connected; every refusal
 * writes no job and locks no build.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, newId, programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { programStamp } from "../src/services/watch-push.js";
import { connectTestCoros, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import {
  buildToday,
  DAY,
  makeEnv,
  NOON,
  PROGRAM_NAME,
  rowOf,
  seedCatalog,
  seedProgram,
  seedSlot,
  seedTmj,
  switchOn,
  TOMORROW,
} from "./watch-push-fixture.js";

const { corosWriteJobs, sessionBuilds, plannedWorkouts } = schema;

vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await connectTestCoros(db, userId);
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
});

afterEach(() => {
  vi.useRealTimers();
});

const call = async (method: "GET" | "POST", path: string, opts: { env?: Env; body?: unknown; who?: string } = {}) => {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, opts.who ?? userId, "test")}`;
  return mountRoutes(db, "/api/sessions", sessionRoutes).request(
    `/api/sessions/${path}`,
    {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    },
    opts.env ?? switchOn(),
  );
};
/**
 * Send as the sheet does: with the digest of the preview it showed (audit W-2 / W-8). A preview that is refused has
 * none; Send is then asked with a placeholder, and answers its own refusal first.
 */
const send = async (workoutId: string, buildId: string, opts: { env?: Env; who?: string } = {}) => {
  const preview = await call("GET", `${workoutId}/watch-preview`, opts);
  const digest = preview.status === 200 ? ((await preview.json()) as { digest: string }).digest : "no-preview";
  return call("POST", `${workoutId}/send-to-watch`, { ...opts, body: { buildId, digest } });
};
const takeOff = (workoutId: string, opts: { env?: Env } = {}) => call("POST", `${workoutId}/take-off-watch`, { ...opts, body: {} });

const jobsOf = (workoutId: string) => db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, workoutId));
const buildsOf = (workoutId: string) => db.select().from(sessionBuilds).where(eq(sessionBuilds.workoutId, workoutId));
const lockedOf = async (workoutId: string) => (await buildsOf(workoutId)).filter((b) => b.lockedAt !== null);

async function builtSlot(date = DAY, id?: string): Promise<{ workoutId: string; buildId: string }> {
  const workoutId = await seedSlot(db, userId, programId, date, id);
  const session = await buildToday(db, userId, prefs, workoutId);
  return { workoutId, buildId: session.build!.buildId };
}

describe("the switch off (absent, or anything but \"1\")", () => {
  it.each([undefined, "0", "true"])("WATCH_PUSH_ENABLED=%s: the watch routes are 404, sessions carry watch: null, no job", async (value) => {
    const env = makeEnv(value === undefined ? {} : { WATCH_PUSH_ENABLED: value });
    const { workoutId, buildId } = await builtSlot();
    expect((await call("GET", `${workoutId}/watch-preview`, { env })).status).toBe(404);
    expect((await send(workoutId, buildId, { env })).status).toBe(404);
    expect((await takeOff(workoutId, { env })).status).toBe(404);
    const got = await call("GET", workoutId, { env });
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ workoutId, watch: null });
    expect(await jobsOf(workoutId)).toEqual([]);
    expect(await lockedOf(workoutId)).toEqual([]);
  });

  it("every session route's response carries watch (null off, a state on)", async () => {
    const { workoutId, buildId } = await builtSlot();
    for (const env of [makeEnv(), switchOn()]) {
      const want = env.WATCH_PUSH_ENABLED === "1" ? expect.objectContaining({ state: expect.any(String) }) : null;
      const responses = [
        await call("GET", workoutId, { env }),
        await call("POST", `${workoutId}/build`, { env, body: {} }),
        await call("POST", `${workoutId}/start`, { env, body: { buildId } }),
        await call("POST", `${workoutId}/unstart`, { env, body: {} }),
      ];
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect((await res.json()) as { watch: unknown }).toMatchObject({ watch: want });
      }
    }
  });
});

describe("POST send-to-watch — refusals write nothing", () => {
  const nothingWritten = async (workoutId: string) => {
    expect(await jobsOf(workoutId)).toEqual([]);
    expect(await lockedOf(workoutId)).toEqual([]);
  };

  it("409 writes_off when COROS writes are off", async () => {
    const { workoutId, buildId } = await builtSlot();
    await savePreferences(db, userId, { ...prefs, corosWritesEnabled: false });
    const res = await send(workoutId, buildId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "writes_off" });
    await nothingWritten(workoutId);
  });

  it("409 not_connected without a COROS connection", async () => {
    const { workoutId, buildId } = await builtSlot();
    await db.delete(schema.providerConnections).where(eq(schema.providerConnections.userId, userId));
    const res = await send(workoutId, buildId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_connected" });
    await nothingWritten(workoutId);
  });

  it("409 not_today for a slot dated tomorrow (its preview is never sent)", async () => {
    const workoutId = await seedSlot(db, userId, programId, TOMORROW);
    const preview = await buildToday(db, userId, prefs, workoutId);
    const res = await send(workoutId, preview.build!.buildId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_today" });
    await nothingWritten(workoutId);
  });

  it("409 precheck when a switched-on profile has no answer for the day", async () => {
    const workoutId = await seedSlot(db, userId, programId, DAY);
    const res0 = await call("POST", `${workoutId}/build`, { body: {} });
    const { build } = (await res0.json()) as { build: { buildId: string } };
    const res = await send(workoutId, build.buildId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "precheck" });
    await nothingWritten(workoutId);
  });

  it("409 not_built for an outline", async () => {
    const workoutId = await seedSlot(db, userId, programId, DAY);
    const res = await send(workoutId, "no-build");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_built" });
    await nothingWritten(workoutId);
  });

  it("409 stale with the fresh session when the day's inputs no longer make the named build", async () => {
    const { workoutId, buildId } = await builtSlot();
    // Another answer to the pre-check since the build: the build the athlete saw is not the day's any more.
    await call("POST", `${workoutId}/build`, { body: { checks: { tmj: { pre: 7, feelingOff: false } } } });
    const res = await send(workoutId, buildId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; session: { build: { buildId: string }; watch: unknown } };
    expect(body.error).toBe("stale");
    expect(body.session.build.buildId).not.toBe(buildId);
    expect(body.session.watch).toMatchObject({ state: "ready" });
    await nothingWritten(workoutId);
  });

  // Re-review B-N2 (ruling 3-R11): a whole-account calendar sync handed to the 409's waitUntil ran in Send's own
  // invocation — 45 combined with the calendar settled, 69 with this half-hour's inserts pending. The fresh build's
  // block is the half-hourly reconcile's (the link's fingerprint no longer matches), as any build's is.
  it("409 stale when the fresh build changes the calendar block: no calendar sync in Send's invocation", async () => {
    const { workoutId, buildId } = await builtSlot();
    const preview = (await (await call("GET", `${workoutId}/watch-preview`)).json()) as { digest: string };
    const blockBefore = (await rowOf(db, workoutId)).calendarBlockDurationSeconds;
    // A longer default since the build: the day's build is now a different length — a new calendar block.
    await db.update(schema.programs).set({ config: adaptiveConfigSchema.parse({ defaultMinutes: 60 }) }).where(eq(schema.programs.id, programId));
    vi.mocked(syncCalendar).mockClear();
    const res = await call("POST", `${workoutId}/send-to-watch`, { body: { buildId, digest: preview.digest } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("stale");
    expect((await rowOf(db, workoutId)).calendarBlockDurationSeconds).not.toBe(blockBefore);
    expect(vi.mocked(syncCalendar).mock.calls.length).toBe(0);
  });

  it("409 too_long for a build of more than 200 steps", async () => {
    const { workoutId, buildId } = await builtSlot();
    const [b] = await buildsOf(workoutId);
    const payload = b!.payload as { build: { steps: Array<Record<string, unknown>> } };
    const work = payload.build.steps.find((s) => s.kind !== "rest")!;
    payload.build.steps = Array.from({ length: 201 }, () => work);
    await db.update(sessionBuilds).set({ payload: payload as unknown as Record<string, unknown> }).where(eq(sessionBuilds.id, buildId));
    const res = await send(workoutId, buildId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "too_long" });
    await nothingWritten(workoutId);
    // The preview says so, and lists nothing to send.
    const preview = (await (await call("GET", `${workoutId}/watch-preview`)).json()) as { refusal: string; steps: unknown[] };
    expect(preview).toMatchObject({ refusal: "too_long", steps: [] });
  });

  it("404 for another user's slot", async () => {
    const { workoutId, buildId } = await builtSlot();
    const other = await makeTestUser(db, { corosWritesEnabled: true });
    expect((await send(workoutId, buildId, { who: other.userId })).status).toBe(404);
    expect((await call("GET", `${workoutId}/watch-preview`, { who: other.userId })).status).toBe(404);
    expect((await takeOff(workoutId, { who: other.userId } as never)).status).toBe(404);
    await nothingWritten(workoutId);
  });
});

describe("POST send-to-watch — success", () => {
  it("queues one push:<buildId>, locks the build, leaves the slot built, and answers sending", async () => {
    const { workoutId, buildId } = await builtSlot();
    const preview = (await (await call("GET", `${workoutId}/watch-preview`)).json()) as { buildId: string; stamp: string; steps: unknown[]; refusal: null };
    expect(preview).toMatchObject({ buildId, stamp: `${PROGRAM_NAME} — ${DAY}`, refusal: null });
    expect(preview.steps.length).toBeGreaterThan(0);

    const res = await send(workoutId, buildId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workoutId, contentState: "built", locked: true, watch: { state: "sending" } });
    const jobs = await jobsOf(workoutId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: `push:${buildId}`, kind: "program_session_push", status: "queued" });
    const payload = programSessionPushJobSchema.parse(jobs[0]!.payload);
    expect(payload).toMatchObject({ workoutId, buildId, happenDay: DAY, name: programStamp(PROGRAM_NAME, DAY, new Set()) });
    expect(payload.session.steps.length).toBe(preview.steps.length);
    expect((await lockedOf(workoutId)).map((b) => b.id)).toEqual([buildId]);
    expect((await rowOf(db, workoutId)).contentState).toBe("built");
  });

  it("sending twice is one job", async () => {
    const { workoutId, buildId } = await builtSlot();
    expect((await send(workoutId, buildId)).status).toBe(200);
    expect((await send(workoutId, buildId)).status).toBe(200);
    expect(await jobsOf(workoutId)).toHaveLength(1);
  });

  it.each(["failed", "superseded"])("a %s push sent again is queued afresh: attempts 0, observed cleared", async (status) => {
    const { workoutId, buildId } = await builtSlot();
    await send(workoutId, buildId);
    const [job] = await jobsOf(workoutId);
    await db
      .update(corosWriteJobs)
      .set({ status, lastErrorCategory: "error", payload: { ...(job!.payload as object), attempts: 3, observed: { wire: "w", text: "t" } } })
      .where(eq(corosWriteJobs.id, job!.id));
    if (status === "superseded") {
      // A superseded push's build was unlocked (taken off before it ran).
      await db.update(sessionBuilds).set({ lockedAt: null }).where(eq(sessionBuilds.id, buildId));
    }
    const res = await send(workoutId, buildId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ watch: { state: "sending" } });
    const [again] = await jobsOf(workoutId);
    expect(again).toMatchObject({ id: `push:${buildId}`, status: "queued", lastErrorCategory: null });
    const payload = programSessionPushJobSchema.parse(again!.payload);
    expect(payload.attempts ?? 0).toBe(0);
    expect(payload.observed).toBeUndefined();
  });

  it("a verified push whose row still holds the address: Send is a no-op", async () => {
    const { workoutId, buildId } = await builtSlot();
    await send(workoutId, buildId);
    await db.update(corosWriteJobs).set({ status: "verified" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "4738:91", sourceIdInPlan: "91", sourceProgramId: "91", lastVerifiedCorosDate: DAY, corosSyncState: "synced" })
      .where(eq(plannedWorkouts.id, workoutId));
    const before = await jobsOf(workoutId);
    const res = await send(workoutId, buildId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ watch: { state: "on_watch" } });
    expect(await jobsOf(workoutId)).toEqual(before);
  });
});

describe("two program sessions on one day, both sent (Review Focus 1)", () => {
  it("each gets its own stamp; a coach session of the same title that day counts as taken", async () => {
    const a = await builtSlot(DAY);
    const b = await builtSlot(DAY, `${a.workoutId}-second`);
    await send(a.workoutId, a.buildId);
    await send(b.workoutId, b.buildId);
    const name = async (w: string) => programSessionPushJobSchema.parse((await jobsOf(w))[0]!.payload).name;
    expect(await name(a.workoutId)).toBe(`${PROGRAM_NAME} — ${DAY}`);
    expect(await name(b.workoutId)).toBe(`${PROGRAM_NAME} — ${DAY} (2)`);

    // A coach create already holding the base stamp that day.
    const coachId = newId();
    await db.insert(corosWriteJobs).values({
      id: `${coachId}-push`, userId, workoutId: coachId, kind: "coach_create_workout", expectedContentFingerprint: "",
      originalDate: TOMORROW, destinationDate: TOMORROW, requestedAt: NOON, status: "verified", updatedAt: NOON,
      payload: { workoutId: coachId, happenDay: TOMORROW, name: `${PROGRAM_NAME} — ${TOMORROW}`, session: { title: PROGRAM_NAME } },
    });
    expect(programStamp(PROGRAM_NAME, TOMORROW, new Set([`${PROGRAM_NAME} — ${TOMORROW}`]))).toBe(`${PROGRAM_NAME} — ${TOMORROW} (2)`);
    vi.setSystemTime(new Date(`${TOMORROW}T19:00:00.000Z`));
    const c = await seedSlot(db, userId, programId, TOMORROW);
    const built = await call("POST", `${c}/build`, { body: { checks: { tmj: { pre: 2, feelingOff: false } } } });
    const { build } = (await built.json()) as { build: { buildId: string } };
    expect((await send(c, build.buildId)).status).toBe(200);
    expect(await name(c)).toBe(`${PROGRAM_NAME} — ${TOMORROW} (2)`);
  });
});

describe("POST take-off-watch", () => {
  it("before the push ran: the push is superseded, no unpush, the build unlocked — ready to send again", async () => {
    const { workoutId, buildId } = await builtSlot();
    await send(workoutId, buildId);
    const res = await takeOff(workoutId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ locked: false, watch: { state: "ready" } });
    const jobs = await jobsOf(workoutId);
    expect(jobs.map((j) => [j.id, j.status])).toEqual([[`push:${buildId}`, "superseded"]]);
    const [b] = (await buildsOf(workoutId)).filter((x) => x.id === buildId);
    expect(b!.lockedAt).toBeNull();
    expect((b!.payload as { unsentAt?: string }).unsentAt).toBe(NOON);
  });

  it("after it verified: unpush:<buildId> carries the recorded stamp and the address; Send waits (taking_off) until it settles", async () => {
    const { workoutId, buildId } = await builtSlot();
    await send(workoutId, buildId);
    const stamp = programSessionPushJobSchema.parse((await jobsOf(workoutId))[0]!.payload).name;
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "4738:91", sourceIdInPlan: "91", sourceProgramId: "91", lastVerifiedCorosDate: DAY, corosSyncState: "synced" })
      .where(eq(plannedWorkouts.id, workoutId));

    const res = await takeOff(workoutId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ locked: false, watch: { state: "unavailable", reason: "taking_off" } });
    const [unpush] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `unpush:${buildId}`));
    expect(unpush).toMatchObject({ kind: "coach_delete_workout", status: "queued", workoutId });
    expect(unpush!.payload).toEqual({ workoutId, happenDay: DAY, name: stamp, idInPlan: "91", programId: "91", corosPlanId: "4738" });
    // The build is unlocked at once: a moved slot must build on its new day.
    expect(await lockedOf(workoutId)).toEqual([]);

    const again = await send(workoutId, buildId);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "taking_off" });
    expect((await jobsOf(workoutId)).find((j) => j.id === `push:${buildId}`)?.status).toBe("verified");

    // Settled: the unpush verified (and the push was superseded by it, Task 7). Send is offered again.
    await db.update(corosWriteJobs).set({ status: "verified" }).where(eq(corosWriteJobs.id, `unpush:${buildId}`));
    await db.update(corosWriteJobs).set({ status: "superseded" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    const got = (await (await call("GET", workoutId)).json()) as { watch: unknown };
    expect(got.watch).toEqual({ state: "ready" });
  });

  it("is a no-op for a slot that was never sent", async () => {
    const { workoutId } = await builtSlot();
    const res = await takeOff(workoutId);
    expect(res.status).toBe(200);
    expect(await jobsOf(workoutId)).toEqual([]);
    expect(
      await db.select().from(sessionBuilds).where(and(eq(sessionBuilds.workoutId, workoutId), eq(sessionBuilds.userId, userId))),
    ).toHaveLength(1);
  });
});
