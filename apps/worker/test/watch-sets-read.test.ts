/**
 * Watch sets arrive through the real read paths (Phase 2a+ Task 2): the
 * cloud read-now pulls a new strength activity's detail and logs its sets;
 * the deep backfill's chunk does the same for history. Read-only on COROS:
 * the only calls are the list and detail reads the paths already made.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, todayInZone } from "@rg/domain";
import type { RawCorosActivityListItem, RawCorosLapItem } from "@rg/providers";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { corosReadNow } from "../src/services/coros-read.js";
import { recordChunk } from "../src/services/backfill.js";
import { buildActivityBackfill, CorosClient } from "@rg/coros";
import type { Db } from "../src/services/db.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { detailOf, makeEnv, workView } from "./watch-sets-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Server = ReturnType<typeof mockCorosServer>;

async function connect(db: Db, userId: string, server: Server): Promise<void> {
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  const res = await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl);
  expect(res.status).toBe("connected");
}

const corosDay = (iso: string): number => Number(iso.replaceAll("-", ""));

/** A strength activity and a run on the given day; both details carry the same lap items. */
function seedLift(server: Server, day: string, labelId = "lbl-lift-41", laps: RawCorosLapItem[] = workView()) {
  const start = Math.floor(Date.parse(`${day}T13:00:00Z`) / 1000);
  const items: RawCorosActivityListItem[] = [
    // avgHr as the detail's summary has it, so a list-only read fingerprints them as the detail read did.
    { labelId, date: corosDay(day), name: "Synthetic Upper", sportType: 402, startTime: start, totalTime: 2400, workoutTime: 2400, avgHr: 101 },
    { labelId: `${labelId}-run`, date: corosDay(day), name: "Synthetic Easy", sportType: 100, startTime: start + 9_000, totalTime: 1800, avgHr: 140 },
  ];
  server.state.activities = [...server.state.activities, ...items];
  const detail = detailOf(laps);
  // A summary with a detail-only field: the stored rows read as detail-grade, so no read re-fetches them for the
  // 2026-08-12 list-grade heal.
  server.state.details = {
    ...server.state.details,
    [labelId]: { ...detail, summary: { name: "Synthetic Upper", workoutTime: 240_000, totalTime: 260_000, avgHr: 101, aerobicEffect: 1.8 } },
    [`${labelId}-run`]: { ...detail, summary: { name: "Synthetic Easy", workoutTime: 180_000, totalTime: 180_000, avgHr: 140, aerobicEffect: 2.4 } },
  };
}

const watchSessions = (db: Db, userId: string) =>
  db.select().from(schema.performedSessions).where(eq(schema.performedSessions.userId, userId));

/** A database whose first statement matching `pattern` throws, as a transient D1 error would. */
function failOnce(pattern: RegExp): Db {
  let armed = true;
  return makeTestDb({
    onStatement: (sql) => {
      if (armed && pattern.test(sql)) {
        armed = false;
        throw new Error("D1_ERROR: transient");
      }
    },
  });
}

/**
 * The mock server, recording the labelId of every detail read of the activities seeded here. (The mock's own
 * stock activities have no detail, so their list-grade rows are re-read every time by the 2026-08-12 heal.)
 */
function detailRecorder(server: Server) {
  const details: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const labelId = url.pathname.endsWith("/activity/detail/query") ? new URLSearchParams(String(init?.body ?? "")).get("labelId") : null;
    if (labelId?.startsWith("lbl-")) details.push(labelId);
    return server.fetchImpl(input, init);
  }) as typeof fetch;
  return { details, impl };
}

/** A connected account with strength activities (and a run each) whose first read-now left their sets unlogged. */
async function readLeavingSetsUnlogged(pattern: RegExp, days: number[]) {
  const db = failOnce(pattern);
  const { userId, prefs } = await makeTestUser(db);
  const server = mockCorosServer();
  vi.stubGlobal("fetch", server.fetchImpl);
  await connect(db, userId, server);
  const today = todayInZone(prefs.timezone);
  for (const d of days) seedLift(server, addDays(today, d), `lbl-lift${d}`);
  expect((await corosReadNow(db, makeEnv(), userId, prefs, { force: true, fetchImpl: server.fetchImpl })).status).toBe("ok");
  return { db, userId, prefs, server };
}

/** The seeded strength activities' stored laps, in id order. */
async function liftLaps(db: Db) {
  const lifts = new Set((await db.select().from(schema.activities)).filter((a) => a.sport === "strength").map((a) => a.id));
  return (await db.select().from(schema.activityLaps)).filter((l) => lifts.has(l.activityId)).sort((a, b) => a.id.localeCompare(b.id));
}

/** The seeded activities' stored fingerprints (the mock's stock rows are list-grade, re-read and re-stamped by every read). */
const linkFingerprints = async (db: Db) =>
  (await db.select().from(schema.activitySourceLinks))
    .filter((l) => l.providerActivityId.startsWith("lbl-"))
    .map((l) => [l.providerActivityId, l.contentFingerprint])
    .sort();

describe("watch sets through the read paths", () => {
  it("the cloud read-now logs a new strength activity's sets, and nothing for the run", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const server = mockCorosServer();
    vi.stubGlobal("fetch", server.fetchImpl);
    await connect(db, userId, server);
    seedLift(server, addDays(todayInZone(prefs.timezone), -2));

    const res = await corosReadNow(db, makeEnv(), userId, prefs, { force: true, fetchImpl: server.fetchImpl });
    expect(res.status).toBe("ok");
    const sessions = await watchSessions(db, userId);
    expect(sessions.map((s) => [s.source, s.sourceRef])).toEqual([["watch", "lbl-lift-41"]]);
    const sets = await db.select().from(schema.performedSets);
    expect(sets).toHaveLength(6);
  });

  it("the next read-now logs the sets of a strength activity whose first write failed, re-reading only its detail (audit M-3)", async () => {
    const { db, userId, prefs, server } = await readLeavingSetsUnlogged(/^\s*insert into "performed_sessions"/i, [-2]);
    expect(await watchSessions(db, userId)).toEqual([]); // the swallowed failure: the activity landed, its sets did not
    const before = await linkFingerprints(db);
    const laps = await liftLaps(db);
    expect(laps).not.toEqual([]);

    const rec = detailRecorder(server);
    const res = await corosReadNow(db, makeEnv(), userId, prefs, { force: true, fetchImpl: rec.impl });
    expect(res).toEqual({ status: "ok", ingested: 0 });
    expect(rec.details).toEqual(["lbl-lift-2"]); // the lift's detail only, never the run's
    const [s] = await watchSessions(db, userId);
    expect(s).toMatchObject({ source: "watch", sourceRef: "lbl-lift-2" });
    expect(s!.payloadHash).not.toBe("pending");
    expect(await db.select().from(schema.performedSets)).toHaveLength(6);
    // The activity itself is untouched: same fingerprints, same laps.
    expect(await linkFingerprints(db)).toEqual(before);
    expect(await liftLaps(db)).toEqual(laps);

    // Healed: the read after that reads no detail at all.
    const quiet = detailRecorder(server);
    await corosReadNow(db, makeEnv(), userId, prefs, { force: true, fetchImpl: quiet.impl });
    expect(quiet.details).toEqual([]);
  });

  it("the next read-now completes a half-written session (audit M-3)", async () => {
    // The commit marker never lands: the session row stays `pending`.
    const { db, userId, prefs, server } = await readLeavingSetsUnlogged(/^\s*update "performed_sessions" set "payload_hash"/i, [-3]);
    expect((await watchSessions(db, userId)).map((s) => s.payloadHash)).toEqual(["pending"]);
    // Even when its laps name no exercise (laps stored before the key was kept): the half-written session is the sign.
    await db.update(schema.activityLaps).set({ exerciseNameKey: null });
    const rec = detailRecorder(server);
    await corosReadNow(db, makeEnv(), userId, prefs, { force: true, fetchImpl: rec.impl });
    expect(rec.details).toEqual(["lbl-lift-3"]);
    const [s] = await watchSessions(db, userId);
    expect(s!.payloadHash).not.toBe("pending");
  });

  it("re-reads one such detail per read, so a read's CPU stays near one new lift's (audit M-3, I-1)", async () => {
    const { db, userId, prefs, server } = await readLeavingSetsUnlogged(/^\s*insert into "performed_sessions"/i, [-2, -4]);
    // One lift's write failed on the first read; drop the other's to leave two to heal.
    await db.delete(schema.performedSets);
    await db.delete(schema.performedSessions);
    const first = detailRecorder(server);
    await corosReadNow(db, makeEnv(), userId, prefs, { force: true, fetchImpl: first.impl });
    expect(first.details).toHaveLength(1);
    const second = detailRecorder(server);
    await corosReadNow(db, makeEnv(), userId, prefs, { force: true, fetchImpl: second.impl });
    expect(second.details).toHaveLength(1);
    expect([...first.details, ...second.details].sort()).toEqual(["lbl-lift-2", "lbl-lift-4"]);
    expect((await watchSessions(db, userId)).map((s) => s.sourceRef).sort()).toEqual(["lbl-lift-2", "lbl-lift-4"]);
  });

  it("never re-reads a lift logged without exercises: it has nothing to log (audit M-7)", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const server = mockCorosServer();
    vi.stubGlobal("fetch", server.fetchImpl);
    await connect(db, userId, server);
    const unnamed = workView().map(({ exerciseNameKey: _key, ...rest }) => rest);
    seedLift(server, addDays(todayInZone(prefs.timezone), -2), "lbl-free", unnamed);
    await corosReadNow(db, makeEnv(), userId, prefs, { force: true, fetchImpl: server.fetchImpl });
    expect(await liftLaps(db)).not.toEqual([]); // its laps are stored…
    expect(await watchSessions(db, userId)).toEqual([]); // …and there is nothing to log
    const rec = detailRecorder(server);
    await corosReadNow(db, makeEnv(), userId, prefs, { force: true, fetchImpl: rec.impl });
    expect(rec.details).toEqual([]);
  });

  it("the deep backfill's chunk logs history's sets", async () => {
    const db = makeTestDb();
    const { userId, prefs } = await makeTestUser(db);
    const server = mockCorosServer();
    const day = addDays(todayInZone(prefs.timezone), -40);
    seedLift(server, day, "lbl-old-lift");
    const client = new CorosClient({ region: "us", fetchImpl: server.fetchImpl, logger: () => undefined });
    await client.loginWithHash(server.email, createHash("md5").update(server.password, "utf8").digest("hex"));
    const chunk = await buildActivityBackfill(client, addDays(day, -5), addDays(day, 5), undefined, { delayMs: 0 });

    await recordChunk(db, userId, {
      chunkStart: addDays(day, -5),
      chunkEnd: addDays(day, 5),
      activities: chunk.activities,
      lapsByProviderId: chunk.lapsByProviderId as never,
      strengthDetailsByProviderId: chunk.strengthDetailsByProviderId,
      skippedSportTypes: chunk.skippedSportTypes,
    });
    expect((await watchSessions(db, userId)).map((s) => s.sourceRef)).toEqual(["lbl-old-lift"]);
  });
});
