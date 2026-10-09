/**
 * A CREATE WHOSE WRITE LANDED BUT WHOSE RESPONSE WAS LOST ADOPTS ITS OWN COPY (re-review A-1 NEW, from 2813c74).
 *
 * Ruling 3-R12 refuses to adopt a copy another session holds. Its row clause counted ANY other row recording the
 * address — an absence-archived row at a recycled COROS slot, or the import's own mirror row of this very copy (made
 * when a read ran between the lost response and the retry) — so the retry was refused "held by another session", the
 * job failed for good, the session never recorded its address and its copy was unowned on the watch. A holder is a
 * LIVE row of another identity (app-built, or with a stamping job of its own) or a live job of another identity. The
 * refusals the rule exists for stay pinned in watch-push-stamp-collision.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, nowInstant, type UserPreferences } from "@rg/domain";
import { COROS_LOCALE_URL } from "@rg/coros";
import type { Db } from "../src/services/db.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { corosReadNow } from "../src/services/coros-read.js";
import { applyOps } from "../src/services/coach-apply.js";
import { buildSession } from "../src/services/session-build.js";
import { sendToWatch } from "../src/services/watch-push.js";
import { coachRoutes } from "../src/routes/coach.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { connectMock, DAY, makeEnv, NOON, PROGRAM_NAME, rowOf, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, providerConnections } = schema;
vi.setConfig({ testTimeout: 30_000 });
vi.mock("../src/services/calendar-sync.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/calendar-sync.js")>()),
  syncCalendar: vi.fn(async () => ({})),
}));

let db: Db;
let userId: string;
let prefs: UserPreferences;
let programId: string;
let server: MockCorosServer;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOON));
  db = makeTestDb({ boundVariableCap: 100 });
  ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
  await seedTmj(db, userId);
  await seedCatalog(db);
  programId = await seedProgram(db, userId);
  server = mockCorosServer({ baseMonday: "2026-10-12" });
  await connectMock(db, userId, server);
  vi.stubGlobal("fetch", server.fetchImpl);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const ctx = () => ({ today: DAY, now: NOON, prefs });
const BASE = `${PROGRAM_NAME} — ${DAY}`;
const OFF = makeEnv();
const programsNamed = (name: string) => (server.state.schedule.programs ?? []).filter((p) => p.name === name);
const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0]!;
const nameOf = (job: { payload: unknown }) => (job.payload as { name: string }).name;
const liveRows = async () => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.userId, userId))).filter((r) => !r.archivedAt);

const LOCALE = { T1120: "Warm Up", T1122: "Cool Down", T1123: "Recover", T3001: "Run", sid_run_training: "Run training" };
const readFetch = (): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === COROS_LOCALE_URL) return new Response(`window.en_US=${JSON.stringify(LOCALE)};`, { status: 200 });
    return server.fetchImpl(input, init);
  }) as typeof fetch;
async function readNow(span: "full" | "short" = "full") {
  const [conn] = await db.select().from(providerConnections).where(eq(providerConnections.userId, userId));
  const meta = { ...((conn!.meta ?? {}) as Record<string, unknown>) };
  if (span === "full") delete meta.lastFullScheduleAt;
  else meta.lastFullScheduleAt = new Date().toISOString();
  await db.update(providerConnections).set({ meta }).where(eq(providerConnections.id, conn!.id));
  expect((await corosReadNow(db, OFF, userId, prefs, { force: true, fetchImpl: readFetch() })).status).toBe("ok");
}

/** A fetch whose first status:1 create LANDS on the mock and then loses its response (a timeout / dropped socket). */
function landsThenLosesResponse(): typeof fetch {
  let armed = true;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const res = await server.fetchImpl(input, init);
    if (armed && url.pathname === "/training/schedule/update") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { versionObjects?: Array<{ status?: number }> };
      if (body.versionObjects?.[0]?.status === 1) {
        armed = false;
        throw new TypeError("fetch failed");
      }
    }
    return res;
  }) as typeof fetch;
}

async function approve(proposalId: string, ops: unknown[], env = makeEnv()) {
  await db.insert(schema.coachProposals).values({
    id: proposalId, userId, title: "t", evidence: "e", rationale: "r", flags: [], ops: ops as never,
    status: "pending", createdAt: nowInstant(), expiresAt: addDays(DAY, 1),
  });
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  const res = await mountRoutes(db, "/api/coach", coachRoutes).request(
    `/api/coach/proposals/${proposalId}/approve`,
    { method: "POST", headers: { Cookie: cookie } },
    env,
    executionCtx as never,
  );
  await Promise.all(pending);
  expect(res.status).toBe(200);
  return (await res.json()) as { applied: { created: string[] } };
}

const run30 = (title: string) => ({ category: "easy", title, durationMinutes: 30, run: { blocks: [{ kind: "duration", value: 30, intensity: "easy" }] } });

async function sendSlot() {
  const workoutId = await seedSlot(db, userId, programId, DAY);
  const built = await buildSession(db, userId, workoutId, { checks: { tmj: { pre: 2, feelingOff: false } } }, ctx());
  await sendToWatch(db, switchOn(), userId, workoutId, built.build!.buildId, ctx());
  return { workoutId, buildId: built.build!.buildId };
}

describe("coach lane: a lost response, then the retry", () => {
  async function landedUnrecorded(): Promise<string> {
    const coachId = (await applyOps(db, userId, prefs, "p-x", [{ kind: "add", date: DAY, session: run30("Easy run") } as never])).created[0]!;
    await executeCloudJobs(db, OFF, userId, prefs, { fetchImpl: landsThenLosesResponse(), cap: 1 });
    const job = await jobOf(`${coachId}-push`);
    expect(job.status).toBe("queued"); // retryable: requeued, nothing recorded
    expect(programsNamed(`Easy run — ${DAY}`)).toHaveLength(1); // ...but the copy landed
    expect((await rowOf(db, coachId)).sourceWorkoutId).toBe(coachId);
    return coachId;
  }

  it("T1 the retry adopts its own copy (no import in between)", async () => {
    const coachId = await landedUnrecorded();
    await executeCloudJobs(db, OFF, userId, prefs, { fetchImpl: server.fetchImpl });
    expect((await jobOf(`${coachId}-push`)).status).toBe("verified");
    expect((await rowOf(db, coachId)).sourceWorkoutId).not.toBe(coachId);
    expect(programsNamed(`Easy run — ${DAY}`)).toHaveLength(1);
  });

  it("T2 the cron import runs between the lost response and the retry: the retry still adopts, one live session on the day", async () => {
    const coachId = await landedUnrecorded();
    // The read comes later than the approve (the hourly cron): real clocks never tie the two rows' createdAt.
    vi.setSystemTime(new Date(`${DAY}T19:20:00.000Z`));
    await readNow();
    vi.setSystemTime(new Date(`${DAY}T19:40:00.000Z`));
    await executeCloudJobs(db, OFF, userId, prefs, { fetchImpl: server.fetchImpl });
    await readNow();
    const job = await jobOf(`${coachId}-push`);
    const onDay = (await liveRows()).filter((r) => r.effectiveDate === DAY).map((r) => `${r.id === coachId ? "coach" : "imported"}:${r.title}`);
    expect({ status: job.status, detail: job.lastErrorDetail, onDay }).toEqual({ status: "verified", detail: null, onDay: ["coach:Easy run"] });
  });

  it("T2b the import's own row for the copy is still LIVE at the retry: it is not another session, the retry adopts", async () => {
    const coachId = await landedUnrecorded();
    const copy = programsNamed(`Easy run — ${DAY}`)[0]!;
    const address = `${server.state.schedule.id}:${copy.idInPlan}`;
    // What a read makes of a stamped copy it cannot yet tie to a session: an imported row, no app identity of its own.
    await db.insert(plannedWorkouts).values({
      id: "imported-twin", userId, planId: "coros-plan", sourceWorkoutId: address, sourceIdInPlan: String(copy.idInPlan), title: "Easy run",
      category: "easy", sport: "run", originalPlanDate: DAY, lastVerifiedCorosDate: DAY, effectiveDate: DAY, effectiveTime: "07:00",
      sourceContentFingerprint: "imported", calendarBlockDurationSeconds: 1800, corosSyncState: "synced", completionState: "scheduled",
      createdAt: `${DAY}T19:20:00.000Z`, updatedAt: `${DAY}T19:20:00.000Z`,
    });
    vi.setSystemTime(new Date(`${DAY}T19:40:00.000Z`));
    await executeCloudJobs(db, OFF, userId, prefs, { fetchImpl: server.fetchImpl });
    const job = await jobOf(`${coachId}-push`);
    expect({ status: job.status, detail: job.lastErrorDetail, address: (await rowOf(db, coachId)).sourceWorkoutId }).toEqual({
      status: "verified",
      detail: null,
      address,
    });
    await readNow();
    const onDay = (await liveRows()).filter((r) => r.effectiveDate === DAY).map((r) => `${r.id === coachId ? "coach" : r.id}:${r.title}`);
    expect(onDay).toEqual(["coach:Easy run"]);
    expect(programsNamed(`Easy run — ${DAY}`)).toHaveLength(1);
  });

  it("T3c the recycled address is still named by an ARCHIVED programme slot (its own identity): the retry adopts", async () => {
    const coachId = await landedUnrecorded();
    const copy = programsNamed(`Easy run — ${DAY}`)[0]!;
    const address = `${server.state.schedule.id}:${copy.idInPlan}`;
    // A slot of a replaced programme, archived while COROS writes were off (its unpush never ran), its copy since
    // deleted by hand in the COROS app — and COROS handed that idInPlan to this copy.
    await db.insert(plannedWorkouts).values({
      id: "old-slot", userId, planId: "old-program", sourceWorkoutId: address, sourceIdInPlan: String(copy.idInPlan), title: "Old programme",
      category: "strength", sport: "strength", originalPlanDate: "2026-09-01", lastVerifiedCorosDate: "2026-09-01", effectiveDate: "2026-09-01",
      effectiveTime: "07:00", sourceContentFingerprint: "program", calendarBlockDurationSeconds: 1800, corosSyncState: "synced",
      completionState: "scheduled", origin: "program", archivedAt: "2026-09-03T00:00:00.000Z", archiveReason: "program_replaced",
      createdAt: "2026-08-25T00:00:00.000Z", updatedAt: NOON,
    });
    await executeCloudJobs(db, OFF, userId, prefs, { fetchImpl: server.fetchImpl, cap: 1 });
    const job = await jobOf(`${coachId}-push`);
    expect({ status: job.status, detail: job.lastErrorDetail, address: (await rowOf(db, coachId)).sourceWorkoutId }).toEqual({
      status: "verified",
      detail: null,
      address,
    });
  });

  it("a LIVE coach session recording the address is still another holder: refused, nothing recorded", async () => {
    const coachId = await landedUnrecorded();
    const copy = programsNamed(`Easy run — ${DAY}`)[0]!;
    const address = `${server.state.schedule.id}:${copy.idInPlan}`;
    // Another coach session (its own stamping job) already claims that copy — two rows must never claim one workout.
    const otherId = (await applyOps(db, userId, prefs, "p-y", [{ kind: "add", date: addDays(DAY, 1), session: run30("Tempo") } as never])).created[0]!;
    await db.update(plannedWorkouts).set({ sourceWorkoutId: address, sourceIdInPlan: String(copy.idInPlan), lastVerifiedCorosDate: DAY }).where(eq(plannedWorkouts.id, otherId));
    await db.update(corosWriteJobs).set({ status: "superseded" }).where(eq(corosWriteJobs.id, `${otherId}-push`));
    await executeCloudJobs(db, OFF, userId, prefs, { fetchImpl: server.fetchImpl, cap: 1 });
    expect(await jobOf(`${coachId}-push`)).toMatchObject({ status: "failed", lastErrorCategory: "error" });
    expect((await rowOf(db, coachId)).sourceWorkoutId).toBe(coachId);
  });

  it("T3 the copy landed at a recycled address an absence-archived row still names: the retry still adopts its own copy", async () => {
    const coachId = await landedUnrecorded();
    const copy = programsNamed(`Easy run — ${DAY}`)[0]!;
    const address = `${server.state.schedule.id}:${copy.idInPlan}`;
    // A run the athlete deleted in COROS weeks ago, archived by absence: its row keeps the address it last held.
    await db.insert(plannedWorkouts).values({
      id: "old-run", userId, planId: "coros-plan", sourceWorkoutId: address, sourceIdInPlan: String(copy.idInPlan), title: "Old run",
      category: "easy", sport: "run", originalPlanDate: "2026-09-01", lastVerifiedCorosDate: "2026-09-01", effectiveDate: "2026-09-01",
      effectiveTime: "07:00", sourceContentFingerprint: "old", calendarBlockDurationSeconds: 1800, corosSyncState: "synced",
      completionState: "scheduled", archivedAt: "2026-09-03T00:00:00.000Z", archiveReason: "absence_confirmed", createdAt: NOON, updatedAt: NOON,
    });
    await executeCloudJobs(db, OFF, userId, prefs, { fetchImpl: server.fetchImpl });
    const job = await jobOf(`${coachId}-push`);
    expect({ status: job.status, detail: job.lastErrorDetail, address: (await rowOf(db, coachId)).sourceWorkoutId }).toEqual({
      status: "verified",
      detail: null,
      address,
    });
  });
});

describe("coach lane: what the athlete sees afterwards", () => {
  it("T3b after the adoption and a read, removing the session takes its copy off the watch", async () => {
    const coachId = (await applyOps(db, userId, prefs, "p-x", [{ kind: "add", date: DAY, session: run30("Easy run") } as never])).created[0]!;
    await executeCloudJobs(db, OFF, userId, prefs, { fetchImpl: landsThenLosesResponse(), cap: 1 });
    const copy = programsNamed(`Easy run — ${DAY}`)[0]!;
    const address = `${server.state.schedule.id}:${copy.idInPlan}`;
    await db.insert(plannedWorkouts).values({
      id: "old-run", userId, planId: "coros-plan", sourceWorkoutId: address, sourceIdInPlan: String(copy.idInPlan), title: "Old run",
      category: "easy", sport: "run", originalPlanDate: "2026-09-01", lastVerifiedCorosDate: "2026-09-01", effectiveDate: "2026-09-01",
      effectiveTime: "07:00", sourceContentFingerprint: "old", calendarBlockDurationSeconds: 1800, corosSyncState: "synced",
      completionState: "scheduled", archivedAt: "2026-09-03T00:00:00.000Z", archiveReason: "absence_confirmed", createdAt: "2026-09-01T00:00:00.000Z", updatedAt: NOON,
    });
    await executeCloudJobs(db, OFF, userId, prefs, { fetchImpl: server.fetchImpl });
    vi.setSystemTime(new Date(`${DAY}T19:20:00.000Z`));
    await readNow();
    // The athlete (or the coach) removes the session: the watch must follow.
    await approve("p-rm", [{ kind: "remove", workoutId: coachId }]);
    await executeCloudJobs(db, OFF, userId, prefs, { fetchImpl: server.fetchImpl });
    const live = (await liveRows()).filter((r) => r.effectiveDate === DAY).map((r) => `${r.id}:${r.title}`);
    expect({ live, copiesOnWatch: programsNamed(`Easy run — ${DAY}`).length }).toEqual({ live: [], copiesOnWatch: 0 });
  });
});

describe("program lane: a lost response, then the retry", () => {
  it("T4 a push whose write landed and lost its response, at a recycled address an archived row still names: Retry adopts it", async () => {
    const { workoutId, buildId } = await sendSlot();
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: landsThenLosesResponse(), cap: 1 });
    expect((await jobOf(`push:${buildId}`)).status).toBe("queued");
    const copy = programsNamed(BASE)[0]!;
    const address = `${server.state.schedule.id}:${copy.idInPlan}`;
    await db.insert(plannedWorkouts).values({
      id: "old-run", userId, planId: "coros-plan", sourceWorkoutId: address, sourceIdInPlan: String(copy.idInPlan), title: "Old run",
      category: "easy", sport: "run", originalPlanDate: "2026-09-01", lastVerifiedCorosDate: "2026-09-01", effectiveDate: "2026-09-01",
      effectiveTime: "07:00", sourceContentFingerprint: "old", calendarBlockDurationSeconds: 1800, corosSyncState: "synced",
      completionState: "scheduled", archivedAt: "2026-09-03T00:00:00.000Z", archiveReason: "absence_confirmed", createdAt: NOON, updatedAt: NOON,
    });
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
    const job = await jobOf(`push:${buildId}`);
    expect({ status: job.status, detail: job.lastErrorDetail, address: (await rowOf(db, workoutId)).sourceWorkoutId }).toEqual({
      status: "verified",
      detail: null,
      address,
    });
  });
});
