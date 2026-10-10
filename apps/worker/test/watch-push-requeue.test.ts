/**
 * SEND AND TAKE OFF NEVER ANSWER FOR NOTHING (Audit 3-A lane L-7, lifecycle L-9).
 *
 * A restore neutralises every live job it brings back (`restored`): a push that was queued, or an unpush that was,
 * holds no copy and drives no write until the athlete acts again. Send requeues a restored push, and Take off a
 * restored unpush — the athlete's own act is the "something new". And Send answers 409 when there is nothing it can
 * queue (`already_sent`: the build's copy is on the watch, its removal failed or neutralised) — never a silent 200
 * saying "sending". The sheet shows such a copy as on the watch, so it offers Take off, not a Send that does nothing.
 * A push still running when it was taken off and sent again is what reaches the watch: Send keeps it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import type { Db } from "../src/services/db.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { executeCloudJobs } from "../src/services/coros-write-cloud.js";
import { upsertExerciseCatalog } from "../src/services/exercise-catalog.js";
import { libraryIdsByKey } from "../src/services/coros-exercise-map.js";
import { COROS_EXERCISE_NAMES } from "@rg/providers";
import { sendToWatch, takeOffWatch, watchPreview } from "../src/services/watch-push.js";
import { mockCorosServer, type MockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { buildToday, connectMock, counting, DAY, NOON, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, plannedWorkouts, sessionBuilds } = schema;

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
});
afterEach(() => vi.useRealTimers());

const ctx = () => ({ today: DAY, now: NOON, prefs });
const lane = () => executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: server.fetchImpl });
const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const lockedAt = async (buildId: string) => (await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, buildId)))[0]!.lockedAt;
const copiesNamed = (name: string) => (server.state.schedule.programs ?? []).filter((p) => p.name === name).length;
/** What account-restore's `neutralise` does to a live job. */
const neutralise = (id: string) => db.update(corosWriteJobs).set({ status: "restored", claimedByDeviceId: null, claimedAt: null }).where(eq(corosWriteJobs.id, id));

const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  return mountRoutes(db, "/api/sessions", sessionRoutes).request(
    `/api/sessions/${path}`,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    switchOn(),
  );
};
const watchOf = async (workoutId: string) => ((await (await call("GET", workoutId)).json()) as { watch: unknown }).watch;
/** Send as the sheet does: the preview, then Send with its digest. */
async function send(workoutId: string, buildId: string) {
  const preview = await call("GET", `${workoutId}/watch-preview`);
  expect(preview.status).toBe(200);
  return call("POST", `${workoutId}/send-to-watch`, { buildId, digest: ((await preview.json()) as { digest: string }).digest });
}

async function builtSlot(): Promise<{ workoutId: string; buildId: string }> {
  const workoutId = await seedSlot(db, userId, programId, DAY);
  return { workoutId, buildId: (await buildToday(db, userId, prefs, workoutId)).build!.buildId };
}
async function onWatch() {
  const s = await builtSlot();
  expect((await send(s.workoutId, s.buildId)).status).toBe(200);
  await lane();
  const push = await jobOf(`push:${s.buildId}`);
  expect(push!.status).toBe("verified");
  return { ...s, stamp: programSessionPushJobSchema.parse(push!.payload).name };
}

describe("a push the restore neutralised (L-7, L-9)", () => {
  it("Send requeues it: queued, sending — and the lane puts it on the watch", async () => {
    const { workoutId, buildId } = await builtSlot();
    expect((await send(workoutId, buildId)).status).toBe(200);
    await neutralise(`push:${buildId}`);
    const res = await send(workoutId, buildId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ watch: { state: "sending" } });
    expect((await jobOf(`push:${buildId}`))!.status).toBe("queued");
    await lane();
    const push = await jobOf(`push:${buildId}`);
    expect(push!.status).toBe("verified");
    expect(copiesNamed(programSessionPushJobSchema.parse(push!.payload).name)).toBe(1);
  });
});

describe("an unpush the restore neutralised", () => {
  it("the copy shows on the watch (not ready to send), and Take off requeues its removal", async () => {
    const { workoutId, buildId, stamp } = await onWatch();
    expect((await call("POST", `${workoutId}/take-off-watch`, {})).status).toBe(200);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
    await neutralise(`unpush:${buildId}`);
    expect(await lockedAt(buildId)).toBeNull();
    expect(await watchOf(workoutId)).toEqual({ state: "on_watch" });

    const res = await call("POST", `${workoutId}/take-off-watch`, {});
    expect(res.status).toBe(200);
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
    expect(((await res.json()) as { watch: unknown }).watch).toEqual({ state: "unavailable", reason: "taking_off" });
    await lane();
    expect(copiesNamed(stamp)).toBe(0);
    expect(await watchOf(workoutId)).toEqual({ state: "ready" });
  });

  it("of a started slot (its build stays locked): Take off requeues it too", async () => {
    const { workoutId, buildId, stamp } = await onWatch();
    await db.update(plannedWorkouts).set({ contentState: "started" }).where(eq(plannedWorkouts.id, workoutId));
    await takeOffWatch(db, userId, workoutId, ctx());
    await neutralise(`unpush:${buildId}`);
    expect(await lockedAt(buildId)).not.toBeNull();
    await takeOffWatch(db, userId, workoutId, ctx());
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("queued");
    await lane();
    expect(copiesNamed(stamp)).toBe(0);
  });
});

describe("Send answers 409 when it would queue nothing", () => {
  it("the build's copy is still on the watch (its removal failed for good): 409 already_sent, nothing written", async () => {
    const { workoutId, buildId } = await onWatch();
    await takeOffWatch(db, userId, workoutId, ctx());
    await db.update(corosWriteJobs).set({ status: "failed", lastErrorCategory: "stamp_mismatch" }).where(eq(corosWriteJobs.id, `unpush:${buildId}`));
    expect(await watchOf(workoutId)).toEqual({ state: "on_watch" });
    const shown = await watchPreview(db, switchOn(), userId, workoutId, ctx());
    const res = await call("POST", `${workoutId}/send-to-watch`, { buildId, digest: shown.digest });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_sent" });
    expect(await lockedAt(buildId)).toBeNull();
    expect((await jobOf(`push:${buildId}`))!.status).toBe("verified");
    expect((await jobOf(`unpush:${buildId}`))!.status).toBe("failed");
  });

  it("the push settled by another request between Send's checks and its write: 409 already_sent, not a silent 200", async () => {
    // A database that lets the test act at the instant Send writes the push (another request's write, racing).
    let race: (() => void) | null = null;
    db = makeTestDb({
      boundVariableCap: 100,
      onStatement: (text) => {
        if (race && /^insert into "coros_write_jobs"/i.test(text)) {
          const act = race;
          race = null;
          act();
        }
      },
    });
    ({ userId, prefs } = await makeTestUser(db, { corosWritesEnabled: true }));
    await seedTmj(db, userId);
    await seedCatalog(db);
    programId = await seedProgram(db, userId);
    await connectMock(db, userId, server);
    const { workoutId, buildId } = await builtSlot();
    expect((await send(workoutId, buildId)).status).toBe(200);
    await db.update(corosWriteJobs).set({ status: "failed" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    const shown = await watchPreview(db, switchOn(), userId, workoutId, ctx());
    race = () => {
      (db.update(corosWriteJobs).set({ status: "verified" }).where(eq(corosWriteJobs.id, `push:${buildId}`)) as unknown as { run: () => void }).run();
    };
    await expect(sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx(), { digest: shown.digest })).rejects.toMatchObject({ reason: "already_sent" });
    expect(race).toBeNull();
  });

  it("taken off and sent again while the push runs: Send keeps that push — one copy, on the watch", async () => {
    const { workoutId, buildId } = await builtSlot();
    const shown = await watchPreview(db, switchOn(), userId, workoutId, ctx());
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx(), { digest: shown.digest });
    let answered: unknown;
    const fetches = counting(server, async (url, init) => {
      if (url.pathname !== "/training/schedule/update" || answered) return;
      const body = JSON.parse(String(init?.body)) as { versionObjects?: Array<{ status?: number }> };
      if (body.versionObjects?.[0]?.status !== 1) return;
      await takeOffWatch(db, userId, workoutId, ctx());
      // The catalog syncs meanwhile: a fresh payload would differ, but the push on its way is what the watch gets.
      // The T-code a step depends on: a catalog step's, or a one-sided catalog move's — free text under the catalog's
      // English name since 2026-10-10 (the fixture's builds rarely hold a two-sided catalog move).
      const payload = programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload);
      const english = new Set(payload.session.steps.map((s) => s.name.replace(/ \((L|R)\)$/, "")));
      const key =
        payload.session.steps.find((s) => s.originId !== "0")?.name ??
        [...libraryIdsByKey().keys()].find((k) => english.has(COROS_EXERCISE_NAMES[k] ?? ""));
      expect(key).toBeDefined();
      await upsertExerciseCatalog(db, [{ id: "4258276155475999999", name: key! }]);
      const again = await watchPreview(db, switchOn(), userId, workoutId, ctx());
      expect(again.digest).toBe(shown.digest);
      answered = (await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx(), { digest: again.digest })).watch;
    });
    await executeCloudJobs(db, switchOn(), userId, prefs, { fetchImpl: fetches.fetchImpl, cap: 1 });
    expect(answered).toEqual({ state: "sending" });
    const push = await jobOf(`push:${buildId}`);
    expect(push!.status).toBe("verified");
    expect(await jobOf(`unpush:${buildId}`)).toBeUndefined();
    expect(copiesNamed(programSessionPushJobSchema.parse(push!.payload).name)).toBe(1);
    expect(await lockedAt(buildId)).not.toBeNull();
  });
});
