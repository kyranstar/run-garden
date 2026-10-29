/**
 * SEND TODAY'S SESSION TO THE WATCH — the switch and the routes (Phase 3 Task 5; spec §4.1–§4.4, §6; rulings 3-R2,
 * 3-R4, 3-R5).
 *
 *   GET  /api/sessions/:workoutId/watch-preview   the steps as the watch will hold them, read off the wire program
 *   POST /api/sessions/:workoutId/send-to-watch   {buildId, digest} → lock the build (content stays `built`), queue push:<buildId>
 *   POST /api/sessions/:workoutId/take-off-watch  supersede a queued push, or queue unpush:<buildId> for a pushed one
 *                                                 (for one release: Keep off, below)
 *   POST /api/sessions/:workoutId/keep-off-watch  the copy off, and `watch_off` set: the mirror leaves the session off
 *   POST /api/sessions/:workoutId/put-on-watch    `watch_off` cleared, the session owed to the mirror again
 *
 * The switch (`WATCH_PUSH_ENABLED`, a Worker var, only "1" is on) off: every watch route is 404 and every session
 * response carries `watch: null`. On: Send has Start's preconditions plus writes on and COROS connected; every refusal
 * writes no job and locks no build.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, lt } from "drizzle-orm";
import { schema } from "@rg/database";
import { adaptiveConfigSchema, addDays, newId, programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { buildSession, isProvisionalBuild, sentBuildIdOf } from "../src/services/session-build.js";
import { markMirrorOwed, mirrorSweep, queueProvisionalPush } from "../src/services/mirror.js";
import { programStamp } from "../src/services/watch-push.js";
import { connectTestCoros, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { calmDoc } from "./doc-workout-fixture.js";
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

const { corosWriteJobs, sessionBuilds, plannedWorkouts, syncIntents } = schema;

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
    // Another answer to the pre-check since the build: the build the athlete saw is not the day's any more. (Made where
    // the mirror does not follow it: the build route's day build now goes to the watch on its own, the watch mirrors the
    // plan §3.3 — mirror-day.test.ts — and Send's refusal of a stale build is what this pins.)
    await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 7, feelingOff: false } } }, { today: DAY, now: NOON, prefs });
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
    // A longer default since the build makes the day's build stale. Whether it also changes the build's LENGTH depends
    // on the mode the engine picks (seeded by the program's random id), so the slot's block is set to a length no build
    // makes: the fresh build always moves the calendar block, deterministically.
    const blockBefore = 600;
    await db.update(schema.plannedWorkouts).set({ calendarBlockDurationSeconds: blockBefore }).where(eq(schema.plannedWorkouts.id, workoutId));
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
    // The preview says so — and still lists every step, as the watch would have had them (owner call 8, 2026-10-08:
    // "Too long for the watch" takes Send's place at the preview's foot, under the steps).
    const preview = (await (await call("GET", `${workoutId}/watch-preview`)).json()) as {
      refusal: string;
      steps: Array<{ name: string; freeText: boolean; target: unknown; overview: string; restSeconds: number }>;
    };
    expect(preview.refusal).toBe("too_long");
    expect(preview.steps.length).toBeGreaterThan(200);
    for (const step of preview.steps) {
      expect(step).toMatchObject({ name: expect.any(String), freeText: expect.any(Boolean), overview: expect.any(String) });
      expect(step.name.length).toBeGreaterThan(0);
    }
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

describe("POST watch/drain — what is left to drain (`pending`, the watch mirrors the plan §3.7)", () => {
  it("drain answers pending=N: this account's queued watch jobs — program pushes (provisional too), `unpush:` and `-unpush-copy` deletes — and nothing else; ran is false when no job could run", async () => {
    const job = (id: string, kind: string, over: Partial<typeof corosWriteJobs.$inferInsert> = {}) => ({
      id, userId, workoutId: "w-any", kind, expectedContentFingerprint: "", originalDate: TOMORROW, destinationDate: TOMORROW,
      payload: { workoutId: "w-any", happenDay: TOMORROW, name: `x — ${TOMORROW}` }, requestedAt: NOON, status: "queued", updatedAt: NOON, ...over,
    });
    const { userId: other } = await makeTestUser(db, {});
    for (const row of [
      job("push:b1", "program_session_push"),
      job("push:b2", "program_session_push", { payload: { workoutId: "w-any", happenDay: TOMORROW, name: "y", provisional: true } }),
      job("unpush:b0", "coach_delete_workout"),
      job("w-any-unpush-copy", "coach_delete_workout"),
      // Not the drain's: an address-path delete, a coach create, a push already verified or claimed, another account's.
      job("w-any-unpush", "coach_delete_workout"),
      job("coach-x", "coach_create_workout"),
      job("push:b3", "program_session_push", { status: "verified" }),
      job("push:b4", "program_session_push", { status: "claimed", claimedAt: NOON }),
      job("push:o1", "program_session_push", { userId: other }),
    ])
      await db.insert(corosWriteJobs).values(row);
    // The account's COROS connection holds no credentials here: nothing can run, and what is left is said.
    const res = await call("POST", "watch/drain", { body: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ran: false, pending: 4 });
  });
});

describe("Keep off my watch / Put on my watch (the watch mirrors the plan §3.6; builder check A8, M4)", () => {
  let seq = 0;
  /** A Studio workout as the Studio stores one: its document at revision 1, an outline until its day. */
  async function seedDocRow(date: string, over: Partial<typeof plannedWorkouts.$inferInsert> = {}): Promise<string> {
    const doc = calmDoc();
    const id = over.id ?? `studio-${date}-${(seq += 1)}`;
    await db.insert(plannedWorkouts).values({
      id, userId, planId: programId, sourceWorkoutId: id, title: doc.title, category: "strength", sport: "strength",
      originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: "18:00", sourceContentFingerprint: "studio",
      calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800, corosSyncState: "calendar_only",
      completionState: "scheduled", origin: "studio", contentState: "outline", workoutDoc: JSON.stringify(doc), workoutDocRev: 1,
      createdAt: NOON, updatedAt: NOON, ...over,
    });
    return id;
  }
  const mirrorCtx = () => ({ today: DAY, now: NOON, prefs });
  const queue = async (id: string) => queueProvisionalPush(db, switchOn(), userId, await rowOf(db, id), mirrorCtx());
  const sweep = () => mirrorSweep(db, switchOn(), userId, prefs, mirrorCtx(), { cap: 1 });
  const recordsOf = (id: string) =>
    db.select().from(sessionBuilds).where(and(eq(sessionBuilds.workoutId, id), lt(sessionBuilds.version, 0))).orderBy(sessionBuilds.version);
  const markOf = async (id: string) => (await db.select().from(syncIntents).where(eq(syncIntents.id, `mirror-${id}`)))[0];
  const keepOff = (id: string, opts: { who?: string } = {}) => call("POST", `${id}/keep-off-watch`, { ...opts, body: {} });
  const putOn = (id: string, opts: { who?: string } = {}) => call("POST", `${id}/put-on-watch`, { ...opts, body: {} });

  it("keep-off takes the copy off and sets watch_off; the sweep and the drain skip the row; put-on clears it and the push comes back", async () => {
    const day = addDays(DAY, 2);
    const id = await seedDocRow(day);
    expect(await queue(id)).toBe("queued");
    const [record] = await recordsOf(id);
    const stamp = programSessionPushJobSchema.parse((await jobsOf(id))[0]!.payload).name;
    // The lane put the provisional copy on the watch; a later change marked the session owed.
    await db.update(corosWriteJobs).set({ status: "verified", verifiedAt: NOON }).where(eq(corosWriteJobs.id, `push:${record!.id}`));
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: "4738:91", sourceIdInPlan: "91", sourceProgramId: "91", lastVerifiedCorosDate: day, corosSyncState: "synced" })
      .where(eq(plannedWorkouts.id, id));
    await markMirrorOwed(db, userId, id, NOON);

    const res = await keepOff(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ workoutId: id, watch: expect.anything() });
    expect((await rowOf(db, id)).watchOff).toBe(true);
    const [unpush] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `unpush:${record!.id}`));
    expect(unpush).toMatchObject({ kind: "coach_delete_workout", status: "queued", workoutId: id });
    expect(unpush!.payload).toEqual({ workoutId: id, happenDay: day, name: stamp, idInPlan: "91", programId: "91", corosPlanId: "4738" });
    // No longer the copy on the watch (its record's marker cleared), and nothing owed to the mirror.
    expect(isProvisionalBuild((await recordsOf(id))[0]!)).toBe(false);
    expect(await sentBuildIdOf(db, id)).toBeNull();
    expect((await markOf(id))!.resolvedAt).toBe(NOON);

    // The mirror honours it: the drain's queue answers kept off, and the sweep pushes nothing — even owed.
    expect(await queue(id)).toBe("skipped:kept_off");
    await markMirrorOwed(db, userId, id, NOON);
    expect((await sweep()).queued).toBe(0);
    expect(await recordsOf(id)).toHaveLength(1);
    expect((await jobsOf(id)).map((j) => j.id).sort()).toEqual([`push:${record!.id}`, `unpush:${record!.id}`].sort());

    // The delete verified, as the lane leaves it: the copy gone, its push superseded, the address reset.
    await db.update(corosWriteJobs).set({ status: "verified" }).where(eq(corosWriteJobs.id, `unpush:${record!.id}`));
    await db.update(corosWriteJobs).set({ status: "superseded" }).where(eq(corosWriteJobs.id, `push:${record!.id}`));
    await db
      .update(plannedWorkouts)
      .set({ sourceWorkoutId: id, sourceIdInPlan: null, sourceProgramId: null, lastVerifiedCorosDate: "", corosSyncState: "calendar_only" })
      .where(eq(plannedWorkouts.id, id));

    const on = await putOn(id);
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({ workoutId: id, watch: expect.anything() });
    expect((await rowOf(db, id)).watchOff).toBe(false);
    expect((await markOf(id))!.resolvedAt, "owed to the mirror again").toBeNull();
    expect((await sweep()).queued).toBe(1);
    const [second] = await recordsOf(id);
    expect(second!.version).toBe(-2);
    expect(isProvisionalBuild(second!)).toBe(true);
    const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, `push:${second!.id}`));
    expect(push).toMatchObject({ kind: "program_session_push", status: "queued" });
    expect(programSessionPushJobSchema.parse(push!.payload)).toMatchObject({ provisional: true, happenDay: day });
  });

  it("keep-off refused on a done session (409 done): nothing written, its copy stays; 404 for another account's", async () => {
    const done = await seedDocRow(DAY, { contentState: "done" });
    const completed = await seedDocRow(addDays(DAY, -1), { completionState: "completed" });
    for (const id of [done, completed]) {
      const res = await keepOff(id);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "done" });
      expect((await rowOf(db, id)).watchOff).toBe(false);
      expect(await jobsOf(id)).toEqual([]);
    }
    const ahead = await seedDocRow(addDays(DAY, 2));
    const { userId: other } = await makeTestUser(db, {});
    expect((await keepOff(ahead, { who: other })).status).toBe(404);
    expect((await putOn(ahead, { who: other })).status).toBe(404);
    expect((await rowOf(db, ahead)).watchOff).toBe(false);
  });

  it("with a provisional push on its way: a queued one superseded and its record's marker cleared, a claimed one left to the lane — never refused `sending`", async () => {
    const queued = await seedDocRow(addDays(DAY, 2));
    const claimed = await seedDocRow(addDays(DAY, 3));
    expect(await queue(queued)).toBe("queued");
    expect(await queue(claimed)).toBe("queued");
    const [q] = await recordsOf(queued);
    const [c] = await recordsOf(claimed);
    await db.update(corosWriteJobs).set({ status: "claimed", claimedAt: NOON }).where(eq(corosWriteJobs.id, `push:${c!.id}`));

    expect((await keepOff(queued)).status).toBe(200);
    expect((await jobsOf(queued)).map((j) => [j.id, j.status])).toEqual([[`push:${q!.id}`, "superseded"]]);
    expect(isProvisionalBuild((await recordsOf(queued))[0]!)).toBe(false);

    // The claim's own checks supersede it (kept off; no longer the sent copy) — or, landed, its verify queues the delete.
    expect((await keepOff(claimed)).status).toBe(200);
    expect((await jobsOf(claimed)).map((j) => [j.id, j.status])).toEqual([[`push:${c!.id}`, "claimed"]]);
    expect(isProvisionalBuild((await recordsOf(claimed))[0]!)).toBe(false);
    expect(await sentBuildIdOf(db, claimed)).toBeNull();
    expect((await rowOf(db, claimed)).watchOff).toBe(true);
  });

  it("on the day: kept off, the day's next build leaves it off (no re-push); put on, the next build pushes it", async () => {
    const workoutId = await seedSlot(db, userId, programId, DAY);
    const checks = { tmj: { pre: 2, feelingOff: false } };
    const build = () => call("POST", `${workoutId}/build`, { body: { checks } });
    const live = async () => (await jobsOf(workoutId)).filter((j) => j.kind === "program_session_push" && j.status === "queued");
    expect((await build()).status).toBe(200);
    expect(await live(), "the mirror follows the day's build").toHaveLength(1);

    expect((await keepOff(workoutId)).status).toBe(200);
    expect(await live()).toEqual([]);
    expect((await build()).status).toBe(200);
    expect(await live(), "kept off: the day's build is not pushed again").toEqual([]);

    expect((await putOn(workoutId)).status).toBe(200);
    expect((await build()).status).toBe(200);
    expect(await live()).toHaveLength(1);
  });

  it("take-off-watch answers as Keep off for one release (an older client's Take off)", async () => {
    const { workoutId, buildId } = await builtSlot();
    await send(workoutId, buildId);
    const res = await takeOff(workoutId);
    expect(res.status).toBe(200);
    expect((await rowOf(db, workoutId)).watchOff).toBe(true);
    expect((await jobsOf(workoutId)).map((j) => [j.id, j.status])).toEqual([[`push:${buildId}`, "superseded"]]);
  });
});
