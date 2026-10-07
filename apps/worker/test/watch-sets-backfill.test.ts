/**
 * The watch-sets backfill (Phase 2a+): strength activities stored before the
 * ingest kept sets have their laps but no session, and the read-now never
 * re-reads a stored activity's detail. `backfillWatchSets` is the bounded,
 * idempotent pass that fills them: newest first, a few details per call
 * (Workers Free allows 50 external subrequests and 10 ms of CPU), walking
 * back by a cursor, read-only on COROS, never inside a restore.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { newId, nowInstant } from "@rg/domain";
import { mockCorosServer } from "../../../packages/coros/test/mock-coros-server.js";
import { connectCoros } from "../src/services/coros-connection.js";
import { backfillWatchSets, WATCH_BACKFILL_BATCH } from "../src/services/watch-sets.js";
import { corosRoutes } from "../src/routes/coros.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { isWrite, makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { detailOf, makeEnv, workView } from "./watch-sets-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Server = ReturnType<typeof mockCorosServer>;

/** The mock server behind a path recorder. */
function recording(server: Server) {
  const paths: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
    return server.fetchImpl(input, init);
  }) as typeof fetch;
  return { paths, impl };
}

/** `failOnce`: the first statement it matches throws, as a transient D1 error would. */
async function setup(opts: { failOnce?: RegExp } = {}) {
  const statements: string[] = [];
  let armed = opts.failOnce !== undefined;
  const db = makeTestDb({
    onStatement: (sql) => {
      statements.push(sql);
      if (armed && opts.failOnce!.test(sql)) {
        armed = false;
        throw new Error("D1_ERROR: transient");
      }
    },
  });
  const { userId } = await makeTestUser(db);
  const server = mockCorosServer();
  const pwdMd5 = createHash("md5").update(server.password, "utf8").digest("hex");
  expect((await connectCoros(db, makeEnv(), userId, { email: server.email, pwdMd5, region: "us" }, server.fetchImpl)).status).toBe(
    "connected",
  );
  const rec = recording(server);
  return { db, userId, server, statements, rec };
}

/** A stored COROS activity as an earlier ingest left it: the row, its source link, and (by default) a lap. */
async function stored(
  db: Db,
  userId: string,
  server: Server,
  labelId: string,
  startTime: string,
  opts: { sport?: string; laps?: boolean; detail?: boolean } = {},
): Promise<string> {
  const id = newId();
  await db.insert(schema.activities).values({
    id,
    userId,
    corosActivityId: labelId,
    startTime,
    startTimeLocal: startTime.slice(0, 19),
    sport: opts.sport ?? "strength",
    durationSeconds: 2400,
    telemetry: { avgCadenceSpm: 1 },
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  await db.insert(schema.activitySourceLinks).values({
    id: newId(),
    activityId: id,
    provider: "coros",
    providerActivityId: labelId,
    firstSeenAt: nowInstant(),
    lastSeenAt: nowInstant(),
    contentFingerprint: "fp",
    normalizerVersion: "1.0.0",
  });
  if (opts.laps !== false) {
    await db.insert(schema.activityLaps).values({
      id: `${id}:workout:1`,
      activityId: id,
      lapIndex: 1,
      durationSeconds: 45,
      splitType: "workout",
      exerciseNameKey: "T1041",
    });
  }
  if (opts.detail !== false) server.state.details[labelId] = detailOf(workView());
  return id;
}

const sessionsOf = (db: Db, userId: string) =>
  db.select().from(schema.performedSessions).where(eq(schema.performedSessions.userId, userId));
const detailCalls = (paths: string[]) => paths.filter((p) => p.endsWith("/activity/detail/query"));

describe("backfillWatchSets", () => {
  it("logs a stored strength activity's sets from its detail, reading COROS only", async () => {
    const { db, userId, server, rec } = await setup();
    const id = await stored(db, userId, server, "lbl-a", "2026-09-20T13:00:00.000Z");
    const res = await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl });
    expect(res).toMatchObject({ status: "ok", filled: 1, next: null });
    const [s] = await sessionsOf(db, userId);
    expect(s).toMatchObject({ source: "watch", sourceRef: "lbl-a", activityId: id, localDate: "2026-09-20" });
    expect(await db.select().from(schema.performedSets)).toHaveLength(6);
    // Reads only: the detail call (and at most a login), never a write endpoint.
    expect(rec.paths.every((p) => p.endsWith("/activity/detail/query") || p.endsWith("/account/login"))).toBe(true);
    expect(detailCalls(rec.paths)).toHaveLength(1);
  });

  it("leaves alone what has nothing to fill: other sports, lap-less lifts, app-logged and already-logged activities", async () => {
    const { db, userId, server, rec, statements } = await setup();
    await stored(db, userId, server, "lbl-run", "2026-09-21T13:00:00.000Z", { sport: "run" });
    await stored(db, userId, server, "lbl-yoga", "2026-09-21T15:00:00.000Z", { sport: "yoga" });
    await stored(db, userId, server, "lbl-bare", "2026-09-22T13:00:00.000Z", { laps: false });
    const appOwned = await stored(db, userId, server, "lbl-app", "2026-09-23T13:00:00.000Z");
    await db.insert(schema.performedSessions).values({
      id: newId(),
      userId,
      activityId: appOwned,
      source: "app",
      localDate: "2026-09-23",
      payloadHash: "h",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    await stored(db, userId, server, "lbl-done", "2026-09-24T13:00:00.000Z");
    expect((await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl })).status).toBe("ok");
    expect(detailCalls(rec.paths)).toEqual(["POST /activity/detail/query"]); // lbl-done only

    // Run again: nothing left, no COROS call, no write but the lock's own bookkeeping.
    rec.paths.length = 0;
    statements.length = 0;
    const again = await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl });
    expect(again).toMatchObject({ status: "ok", filled: 0, next: null });
    expect(rec.paths).toEqual([]);
    expect(statements.filter(isWrite).filter((sql) => !/"coach_locks"/.test(sql))).toEqual([]);
    expect((await sessionsOf(db, userId)).map((s) => s.source).sort()).toEqual(["app", "watch"]);
  });

  it("picks up a session whose sets never landed", async () => {
    const { db, userId, server, rec } = await setup();
    const id = await stored(db, userId, server, "lbl-p", "2026-09-25T13:00:00.000Z");
    await db.insert(schema.performedSessions).values({
      id: `watch:${userId}:lbl-p`,
      userId,
      activityId: id,
      source: "watch",
      sourceRef: "lbl-p",
      localDate: "2026-09-25",
      payloadHash: "pending",
      createdAt: nowInstant(),
      updatedAt: nowInstant(),
    });
    const res = await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl });
    expect(res).toMatchObject({ status: "ok", filled: 1 });
    expect(await db.select().from(schema.performedSets)).toHaveLength(6);
  });

  it("does a bounded batch per call, newest first, and walks back by its cursor", async () => {
    const { db, userId, server, rec } = await setup();
    const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
    const ids = new Map<string, string>();
    for (const d of days) ids.set(d, await stored(db, userId, server, `lbl-${d}`, `${d}T13:00:00.000Z`));
    expect(WATCH_BACKFILL_BATCH).toBeLessThan(days.length);

    const first = await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.filled).toBe(WATCH_BACKFILL_BATCH);
    expect(detailCalls(rec.paths)).toHaveLength(WATCH_BACKFILL_BATCH);
    const newest = days.slice(-WATCH_BACKFILL_BATCH).map((d) => `lbl-${d}`);
    expect((await sessionsOf(db, userId)).map((s) => s.sourceRef).sort()).toEqual(newest.sort());
    // The last activity handled, as `<start>~<id>`.
    const edge = days[days.length - WATCH_BACKFILL_BATCH]!;
    expect(first.next).toBe(`${edge}T13:00:00.000Z~${ids.get(edge)}`);

    const second = await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl, before: first.next! });
    expect(second).toMatchObject({ status: "ok", filled: days.length - WATCH_BACKFILL_BATCH, next: null });
    expect(await sessionsOf(db, userId)).toHaveLength(days.length);
  });

  it("walks past two activities that share a start time across a batch boundary, filling both (audit M-6)", async () => {
    const { db, userId, server, rec } = await setup();
    // Newer ones fill all but the last place of the first batch; the tied pair straddles its edge.
    for (let i = 0; i < WATCH_BACKFILL_BATCH - 1; i++) {
      await stored(db, userId, server, `lbl-new-${i}`, `2026-09-${String(20 - i).padStart(2, "0")}T13:00:00.000Z`);
    }
    await stored(db, userId, server, "lbl-tie-1", "2026-09-07T13:00:00.000Z");
    await stored(db, userId, server, "lbl-tie-2", "2026-09-07T13:00:00.000Z");
    let next: string | null = null;
    for (let calls = 0; calls < 10; calls++) {
      const r = await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl, ...(next ? { before: next } : {}) });
      expect(r.status).toBe("ok");
      next = r.status === "ok" ? r.next : null;
      if (!next) break;
    }
    expect((await sessionsOf(db, userId)).map((s) => s.sourceRef)).toEqual(
      expect.arrayContaining(["lbl-tie-1", "lbl-tie-2"]),
    );
    expect(await sessionsOf(db, userId)).toHaveLength(WATCH_BACKFILL_BATCH + 1);
  });

  it("counts an activity that fails to store and walks on to the next (audit M-5)", async () => {
    const { db, userId, server, rec } = await setup({ failOnce: /^\s*insert into "performed_sessions"/i });
    await stored(db, userId, server, "lbl-broken", "2026-09-12T13:00:00.000Z"); // newest: its write fails
    await stored(db, userId, server, "lbl-fine", "2026-09-11T13:00:00.000Z");
    let next: string | null = null;
    let failures = 0;
    for (let calls = 0; calls < 10; calls++) {
      const r = await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl, ...(next ? { before: next } : {}) });
      expect(r.status).toBe("ok");
      if (r.status !== "ok") break;
      failures += r.failures;
      next = r.next;
      if (!next) break;
    }
    expect(failures).toBe(1);
    expect((await sessionsOf(db, userId)).map((s) => [s.sourceRef, s.payloadHash === "pending"])).toEqual([
      ["lbl-fine", false],
    ]);
  });

  it("reports a failure of our own as `error`, never as COROS's (audit M-5)", async () => {
    const { db, userId, server, rec } = await setup();
    await stored(db, userId, server, "lbl-k", "2026-09-12T13:00:00.000Z");
    // The stored credentials no longer decrypt: our fault, not COROS's.
    const env = makeEnv({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") });
    expect(await backfillWatchSets(db, env, userId, { fetchImpl: rec.impl })).toEqual({ status: "error" });
    expect(rec.paths).toEqual([]);
    // The lock was let go.
    expect((await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl })).status).toBe("ok");
  });

  it("counts a detail with nothing to log and goes on", async () => {
    const { db, userId, server, rec } = await setup();
    await stored(db, userId, server, "lbl-ok", "2026-09-10T13:00:00.000Z");
    await stored(db, userId, server, "lbl-empty", "2026-09-11T13:00:00.000Z", { detail: false });
    const res = await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl });
    expect(res).toMatchObject({ status: "ok", filled: 1, nothingToLog: 1 });
  });

  it("writes nothing and calls nothing during a restore, in fixture mode, or without a connection", async () => {
    const { db, userId, server, rec, statements } = await setup();
    await stored(db, userId, server, "lbl-r", "2026-09-12T13:00:00.000Z");
    expect((await backfillWatchSets(db, makeEnv({ FIXTURE_MODE: "1" }), userId, { fetchImpl: rec.impl })).status).toBe(
      "fixture_mode",
    );
    await db.insert(schema.accountState).values({ userId, restoreId: newId(), restoreStartedAt: nowInstant(), updatedAt: nowInstant() });
    statements.length = 0;
    expect((await backfillWatchSets(db, makeEnv(), userId, { fetchImpl: rec.impl })).status).toBe("restoring");
    expect(statements.filter(isWrite)).toEqual([]);
    expect(rec.paths).toEqual([]);
    expect(await sessionsOf(db, userId)).toEqual([]);

    const other = await makeTestUser(db);
    expect((await backfillWatchSets(db, makeEnv(), other.userId, { fetchImpl: rec.impl })).status).toBe("not_connected");
  });
});

describe("POST /api/coros/watch-sets/backfill", () => {
  it("runs one batch for the signed-in athlete and hands back the cursor", async () => {
    const { db, userId, server, rec } = await setup();
    vi.stubGlobal("fetch", rec.impl);
    await stored(db, userId, server, "lbl-route", "2026-09-15T13:00:00.000Z");
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const app = mountRoutes(db, "/api/coros", corosRoutes);
    const res = await app.request("/api/coros/watch-sets/backfill", { method: "POST", headers: { Cookie: cookie } }, makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", filled: 1, next: null });

    const anon = await app.request("/api/coros/watch-sets/backfill", { method: "POST" }, makeEnv());
    expect(anon.status).toBe(401);
  });

  it("refuses a cursor that is not an instant", async () => {
    const { db, userId } = await setup();
    const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
    const app = mountRoutes(db, "/api/coros", corosRoutes);
    const res = await app.request(
      "/api/coros/watch-sets/backfill?before=yesterday",
      { method: "POST", headers: { Cookie: cookie } },
      makeEnv() as Env,
    );
    expect(res.status).toBe(400);
    const empty = await app.request(
      "/api/coros/watch-sets/backfill?before=2026-09-15T13:00:00.000Z~",
      { method: "POST", headers: { Cookie: cookie } },
      makeEnv() as Env,
    );
    expect(empty.status).toBe(400);
    // The cursor `next` hands back: an instant and the activity id after it.
    const handed = await app.request(
      `/api/coros/watch-sets/backfill?before=${encodeURIComponent("2026-09-15T13:00:00.000Z~act-1")}`,
      { method: "POST", headers: { Cookie: cookie } },
      makeEnv() as Env,
    );
    expect(handed.status).toBe(200);
  });
});
