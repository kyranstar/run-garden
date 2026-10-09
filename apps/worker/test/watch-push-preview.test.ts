/**
 * THE PREVIEW IS WHAT IS SENT (Audit 3-A wire W-2 / W-8, lane U-3).
 *
 * The preview answers a digest of the very payload it rendered; Send carries it back, and a payload that would differ
 * (another session took the stamp, the catalog synced, the program was renamed) is refused 409 `stale_preview` with
 * the fresh preview — nothing written. A failed or settled push previews what Retry will send, so Retry never loops
 * on 409. An in-flight or on-watch push previews against a catalog made from its own payload, so a catalog row that
 * changed since cannot break it. The stamp is fixed at the build's first Send: a Retry after a rename keeps it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { programSessionPushJobSchema, type UserPreferences } from "@rg/domain";
import { buildProgramWatchProgram, previewOfProgram } from "@rg/coros";
import { COROS_EXERCISE_NAMES, localDateToCorosDay } from "@rg/providers";
import type { Db } from "../src/services/db.js";
import { sessionRoutes } from "../src/routes/sessions.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { exerciseNameMap, upsertExerciseCatalog } from "../src/services/exercise-catalog.js";
import { pushDigest, sendToWatch, watchPreview, type WatchPreviewDto } from "../src/services/watch-push.js";
import { connectTestCoros, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { buildToday, DAY, NOON, PROGRAM_NAME, seedCatalog, seedProgram, seedSlot, seedTmj, switchOn } from "./watch-push-fixture.js";

const { corosWriteJobs, corosExercises, programs, sessionBuilds } = schema;

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
afterEach(() => vi.useRealTimers());

const ctx = () => ({ today: DAY, now: NOON, prefs });
const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId, "test")}`;
  return mountRoutes(db, "/api/sessions", sessionRoutes).request(
    `/api/sessions/${path}`,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
    switchOn(),
  );
};
const preview = async (workoutId: string): Promise<WatchPreviewDto> => {
  const res = await call("GET", `${workoutId}/watch-preview`);
  expect(res.status).toBe(200);
  return (await res.json()) as WatchPreviewDto;
};
const send = (workoutId: string, buildId: string, digest: string) => call("POST", `${workoutId}/send-to-watch`, { buildId, digest });
const jobOf = async (id: string) => (await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, id)))[0];
const payloadOf = async (buildId: string) => programSessionPushJobSchema.parse((await jobOf(`push:${buildId}`))!.payload);

async function builtSlot(id?: string): Promise<{ workoutId: string; buildId: string }> {
  const workoutId = await seedSlot(db, userId, programId, DAY, id);
  const session = await buildToday(db, userId, prefs, workoutId);
  return { workoutId, buildId: session.build!.buildId };
}

/** A T-code the catalog maps once and the build uses, and its catalog id. */
async function aCatalogStep(workoutId: string): Promise<{ key: string; id: string }> {
  const step = (await preview(workoutId)).steps.find((s) => !s.freeText);
  expect(step).toBeDefined();
  const catalog = await exerciseNameMap(db);
  const ids = (key: string) => [...catalog].filter(([, k]) => k === key).map(([id]) => id);
  const key = Object.keys(COROS_EXERCISE_NAMES).find((k) => COROS_EXERCISE_NAMES[k] === step!.name && ids(k).length === 1)!;
  expect(key).toBeDefined();
  return { key, id: ids(key)[0]! };
}

describe("the digest", () => {
  it("the preview carries one, and Send with it queues exactly the payload the preview rendered", async () => {
    const { workoutId, buildId } = await builtSlot();
    const shown = await preview(workoutId);
    expect(shown.digest).toMatch(/^[0-9a-f]{64}$/);
    const res = await send(workoutId, buildId, shown.digest);
    expect(res.status).toBe(200);
    const queued = await payloadOf(buildId);
    expect(await pushDigest(queued)).toBe(shown.digest);
    // The preview IS the wire the lane will write.
    const wire = buildProgramWatchProgram(
      { happenDay: String(localDateToCorosDay(queued.happenDay)), name: queued.name, session: queued.session },
      await exerciseNameMap(db),
    );
    expect(previewOfProgram(wire, (k) => COROS_EXERCISE_NAMES[k])).toEqual(shown.steps.map(({ load: _l, ...s }) => s));
    // Sent: the preview shows that payload, under the same digest.
    expect(await preview(workoutId)).toEqual(shown);
  });

  it("Send without a digest is refused 422, and writes nothing", async () => {
    const { workoutId, buildId } = await builtSlot();
    const res = await call("POST", `${workoutId}/send-to-watch`, { buildId });
    expect(res.status).toBe(422);
    expect(await jobOf(`push:${buildId}`)).toBeUndefined();
  });
});

describe("409 stale_preview: the payload Send would queue is not the one previewed", () => {
  it("another session took the stamp between the preview and Send (W-8b): the fresh preview, nothing written", async () => {
    const a = await builtSlot();
    const before = await preview(a.workoutId);
    expect(before.stamp).toBe(`${PROGRAM_NAME} — ${DAY}`);
    // A second session of the program that day is sent first.
    const b = await builtSlot(`${a.workoutId}-second`);
    expect((await send(b.workoutId, b.buildId, (await preview(b.workoutId)).digest)).status).toBe(200);

    const res = await send(a.workoutId, a.buildId, before.digest);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; preview: WatchPreviewDto };
    expect(body.error).toBe("stale_preview");
    expect(body.preview.stamp).toBe(`${PROGRAM_NAME} — ${DAY} (2)`);
    expect(body.preview.digest).not.toBe(before.digest);
    expect(body.preview).toEqual(await preview(a.workoutId));
    expect(await jobOf(`push:${a.buildId}`)).toBeUndefined();
    expect((await db.select().from(sessionBuilds).where(eq(sessionBuilds.id, a.buildId)))[0]!.lockedAt).toBeNull();

    // Sent with the fresh preview's digest: exactly that is queued.
    expect((await send(a.workoutId, a.buildId, body.preview.digest)).status).toBe(200);
    expect((await payloadOf(a.buildId)).name).toBe(`${PROGRAM_NAME} — ${DAY} (2)`);
  });

  it("the catalog synced between the preview and Send (W-diverge): refused with the fresh preview", async () => {
    const { workoutId, buildId } = await builtSlot();
    const before = await preview(workoutId);
    const { key } = await aCatalogStep(workoutId);
    // COROS now lists a second id for that T-code: the move goes as free text.
    await upsertExerciseCatalog(db, [{ id: "4258276155475999999", name: key }]);
    const res = await send(workoutId, buildId, before.digest);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; preview: WatchPreviewDto };
    expect(body.error).toBe("stale_preview");
    expect(body.preview.freeText).toBeGreaterThan(before.freeText);
    expect(await jobOf(`push:${buildId}`)).toBeUndefined();
  });
});

describe("a failed push previews what Retry will send", () => {
  async function failedPush() {
    const { workoutId, buildId } = await builtSlot();
    expect((await send(workoutId, buildId, (await preview(workoutId)).digest)).status).toBe(200);
    await db.update(corosWriteJobs).set({ status: "failed", lastErrorCategory: "error" }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    return { workoutId, buildId, first: await payloadOf(buildId) };
  }

  it("the program renamed since (W-8a, U-3): the stamp stays the first Send's, and Retry queues what was shown", async () => {
    const { workoutId, buildId, first } = await failedPush();
    await db.update(programs).set({ name: "Upper body and posture block" }).where(eq(programs.id, programId));
    const shown = await preview(workoutId);
    expect(shown.stamp).toBe(first.name);
    const res = await send(workoutId, buildId, shown.digest);
    expect(res.status).toBe(200);
    const queued = await payloadOf(buildId);
    expect(queued.name).toBe(first.name);
    expect(await pushDigest(queued)).toBe(shown.digest);
  });

  it("the catalog changed since: the preview shows the new steps, and Retry with its digest is not refused", async () => {
    const { workoutId, buildId } = await failedPush();
    const { key } = await aCatalogStep(workoutId);
    const failedShown = await preview(workoutId);
    await upsertExerciseCatalog(db, [{ id: "4258276155475999999", name: key }]);
    const shown = await preview(workoutId);
    expect(shown.freeText).toBeGreaterThan(failedShown.freeText);
    const res = await send(workoutId, buildId, shown.digest);
    expect(res.status).toBe(200);
    expect(await pushDigest(await payloadOf(buildId))).toBe(shown.digest);
  });

  it("Retry is refused when the digest is a preview of the failed payload, not of the retry", async () => {
    const { workoutId, buildId, first } = await failedPush();
    await db.update(programs).set({ name: "Upper body and posture block" }).where(eq(programs.id, programId));
    const { key } = await aCatalogStep(workoutId);
    await upsertExerciseCatalog(db, [{ id: "4258276155475999999", name: key }]);
    const res = await send(workoutId, buildId, await pushDigest(first));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("stale_preview");
    expect((await jobOf(`push:${buildId}`))!.status).toBe("failed");
  });
});

describe("an in-flight or on-watch push previews its own payload", () => {
  it.each(["queued", "claimed", "verified"])("%s: a catalog row re-keyed since the send does not break the preview", async (status) => {
    const { workoutId, buildId } = await builtSlot();
    const shown = await preview(workoutId);
    await sendToWatch(db, switchOn(), userId, workoutId, buildId, ctx(), { digest: shown.digest });
    await db.update(corosWriteJobs).set({ status }).where(eq(corosWriteJobs.id, `push:${buildId}`));
    const { id } = await aCatalogStep(workoutId);
    await db.update(corosExercises).set({ name: "T9999" }).where(eq(corosExercises.id, id));
    const after = await preview(workoutId);
    expect(after.steps).toEqual(shown.steps);
    expect(after.digest).toBe(shown.digest);
  });
});

describe("the stamp is fixed at the build's first Send", () => {
  it("sent again after a take-off and a rename: the same stamp — unless another session holds it now", async () => {
    const a = await builtSlot();
    expect((await send(a.workoutId, a.buildId, (await preview(a.workoutId)).digest)).status).toBe(200);
    const first = (await payloadOf(a.buildId)).name;
    expect((await call("POST", `${a.workoutId}/take-off-watch`, {})).status).toBe(200);
    expect((await jobOf(`push:${a.buildId}`))!.status).toBe("superseded");
    await db.update(programs).set({ name: "Upper body and posture block" }).where(eq(programs.id, programId));
    expect((await preview(a.workoutId)).stamp).toBe(first);

    // Another session of the day is sent meanwhile, and takes the stamp the taken-off push gave up.
    await db.update(programs).set({ name: PROGRAM_NAME }).where(eq(programs.id, programId));
    const b = await builtSlot(`${a.workoutId}-second`);
    expect((await send(b.workoutId, b.buildId, (await preview(b.workoutId)).digest)).status).toBe(200);
    expect((await payloadOf(b.buildId)).name).toBe(first);
    const again = await preview(a.workoutId);
    expect(again.stamp).toBe(`${first} (2)`);
    expect((await send(a.workoutId, a.buildId, again.digest)).status).toBe(200);
    expect((await payloadOf(a.buildId)).name).toBe(`${first} (2)`);
  });
});
