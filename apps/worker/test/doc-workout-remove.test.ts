/**
 * Quick starts are not plan obligations (CUJ red-team R6, the lead's rulings): Start now books no calendar event — only
 * Schedule does; a Studio workout never started can be removed (`DELETE /api/workouts/:id`), its calendar event and its
 * unsent watch work with it; and a workout started at once and abandoned with nothing logged goes when the player
 * discards it, or once its day has ended (the hourly reconcile). A removed workout is gone: nothing reads it as missed.
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { reconcileCompletionStates } from "../src/services/reconcile-daily.js";
import { queueProvisionalPush } from "../src/services/mirror.js";
import { makeTestDb, makeTestUser } from "./helpers.js";
import { calmDoc, clientFor, type Reply } from "./doc-workout-fixture.js";

const { plannedWorkouts, corosWriteJobs, calendarEventLinks } = schema;
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function calendarEnv(): Env {
  return {
    DB: {} as unknown as Env["DB"],
    ASSETS: {} as unknown as Env["ASSETS"],
    APP_URL: "https://app.test",
    FIXTURE_MODE: "0",
    AI_DEFAULT_ENABLED: "1",
    SESSION_SECRET: "s",
    TOKEN_ENCRYPTION_KEY: TEST_KEY,
    ALLOWED_GOOGLE_EMAIL: "runner@example.com",
    GOOGLE_CLIENT_ID: "c",
    GOOGLE_CLIENT_SECRET: "c",
  } as Env;
}

/** Google Calendar's events endpoint, keeping what was inserted and deleted. */
function fakeGoogle() {
  const inserted: Array<{ id: string; workoutId: string | undefined }> = [];
  const deleted: string[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const handle = async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const m = url.pathname.match(/\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
    if (!m) return json({}, 404);
    const id = m[1] ? decodeURIComponent(m[1]) : undefined;
    if (method === "GET") return json({ items: [], nextSyncToken: String(inserted.length) });
    if (method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as { extendedProperties?: { private?: Record<string, string> } };
      const ev = { id: `ev${inserted.length + 1}`, workoutId: body.extendedProperties?.private?.rgWorkoutId };
      inserted.push(ev);
      return json({ id: ev.id });
    }
    if (id && method === "PATCH") return json({ id });
    if (id && method === "DELETE") {
      deleted.push(id);
      return new Response(null, { status: 204 });
    }
    return json({}, 400);
  };
  return { inserted, deleted, handle };
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let call: (method: string, path: string, body?: unknown) => Promise<Reply>;
let google: ReturnType<typeof fakeGoogle>;
/** Runs just before each statement the application executes (a test arms it to land a concurrent write there). */
let beforeStatement: ((sql: string) => void) | null;

beforeEach(async () => {
  beforeStatement = null;
  db = makeTestDb({ boundVariableCap: 100, onStatement: (s) => beforeStatement?.(s) });
  ({ userId } = await makeTestUser(db));
  await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: "cal" });
  prefs = await loadPreferences(db, userId);
  today = todayInZone(prefs.timezone);
  await db.insert(schema.providerConnections).values({
    id: newId(), userId, provider: "google_calendar", status: "connected",
    encryptedRefreshToken: await encryptSecret("refresh", TEST_KEY), encryptedAccessToken: await encryptSecret("access", TEST_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), createdAt: nowInstant(), updatedAt: nowInstant(),
  });
  google = fakeGoogle();
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "www.googleapis.com") return google.handle(url, init);
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  call = await clientFor(db, userId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const rowOf = async (id: string) => (await db.select().from(plannedWorkouts).where(eq(plannedWorkouts.id, id)))[0]!;
const sync = () => syncCalendar(db, calendarEnv(), userId, { fullResync: true });
const eventsFor = (id: string) => google.inserted.filter((e) => e.workoutId === id);

async function made(body: Record<string, unknown>): Promise<string> {
  const res = await call("POST", "/api/workouts", { doc: calmDoc(), ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.workout.id as string;
}

/** An app session of `workoutId` played on `day` (9:16–9:33 AM there), as the player's outbox sends it. */
function saveBody(id: string, workoutId: string, buildId: string | null, day: string) {
  return {
    id, source: "app", sourceRef: null, workoutId, buildId, localDate: day,
    startedAt: `${day}T17:16:00.000Z`, endedAt: `${day}T17:33:00.000Z`, seconds: 1020, plannedSeconds: 1020, minutes: 17,
    mode: "build", theme: null, locationId: null, blockRef: null, blockNumber: null, completed: true,
    stepsTotal: 1, stepsDone: 1, movesDone: [{ exerciseId: "bridge", seconds: 120, slotKey: "core:0" }], note: null, newMove: null,
    entries: [{ exerciseId: "bridge", implement: null, format: "straight", perSide: false, sets: [{ setIndex: 0, side: null, reps: 12, seconds: null, load: null, done: true, flags: [] }] }],
    checks: [],
    review: {},
  };
}

async function started(id: string): Promise<void> {
  const built = await call("POST", `/api/sessions/${id}/build`, {});
  expect(built.status, JSON.stringify(built.body)).toBe(200);
  const start = await call("POST", `/api/sessions/${id}/start`, { buildId: built.body.build.buildId });
  expect(start.status, JSON.stringify(start.body)).toBe(200);
}

describe("Start now books no calendar event; only Schedule does", () => {
  it("a workout started at once is never on the calendar; one scheduled is", async () => {
    const now = await made({ date: today, time: "23:00", startNow: true });
    const later = await made({ date: addDays(today, 1) });
    await sync();
    expect(eventsFor(now)).toEqual([]);
    expect(eventsFor(later)).toHaveLength(1);
    expect((await rowOf(now)).calendarSyncState).toBe("app_only");
    // A second sync books it no more than the first.
    await sync();
    expect(eventsFor(now)).toEqual([]);
  });

  it("moved to a day of the plan's, it is planned now: booked", async () => {
    const now = await made({ date: today, time: "23:00", startNow: true });
    const { applyMove } = await import("../src/services/jobs.js");
    await applyMove(db, { userId, workoutId: now, toDate: addDays(today, 2), toTime: "18:00", source: "app", corosWritesEnabled: false });
    await sync();
    expect(eventsFor(now)).toHaveLength(1);
  });
});

describe("DELETE /api/workouts/:id: a Studio workout never started", () => {
  it("is removed: archived, its calendar event taken off, its queued watch work cancelled — and never read as missed", async () => {
    const id = await made({ date: addDays(today, 1) });
    await sync();
    const [event] = eventsFor(id);
    expect(event).toBeDefined();
    await db.insert(corosWriteJobs).values({
      id: "push:queued", userId, workoutId: id, kind: "program_session_push", expectedContentFingerprint: "fp",
      originalDate: addDays(today, 1), destinationDate: addDays(today, 1), requestedAt: nowInstant(), status: "queued", updatedAt: nowInstant(),
    });
    expect(await call("DELETE", `/api/workouts/${id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await rowOf(id)).archivedAt).not.toBeNull();
    expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, "push:queued")))[0]!.status).toBe("superseded");
    await sync();
    expect(google.deleted).toContain(event!.id);
    expect(await db.select().from(calendarEventLinks).where(eq(calendarEventLinks.workoutId, id))).toEqual([]);
    // Its day passes: nothing reads a removed workout as missed or needing attention.
    await db.update(plannedWorkouts).set({ effectiveDate: addDays(today, -2) }).where(eq(plannedWorkouts.id, id));
    await reconcileCompletionStates(db, userId, prefs);
    expect((await rowOf(id)).completionState).toBe("scheduled");
    // Gone: a second remove finds nothing.
    expect((await call("DELETE", `/api/workouts/${id}`)).status).toBe(404);
  });

  it("refuses one under way, done, saved, on its way to the watch, or a programme's; 404 for another account's", async () => {
    const begun = await made({ date: today, time: "23:00" });
    await started(begun);
    expect(await call("DELETE", `/api/workouts/${begun}`)).toEqual({ status: 409, body: { error: "not_removable", reason: "started" } });

    const done = await made({ date: addDays(today, 1) });
    await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, done));
    expect((await call("DELETE", `/api/workouts/${done}`)).body).toEqual({ error: "not_removable", reason: "done" });

    const saved = await made({ date: addDays(today, 1) });
    await db.insert(schema.performedSessions).values({
      id: "p1", userId, workoutId: saved, activityId: null, buildId: null, source: "app", sourceRef: null, localDate: today,
      startedAt: nowInstant(), endedAt: null, seconds: 600, plannedSeconds: 600, minutes: 10, mode: "consistent", theme: null, locationId: null,
      blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null, movesDone: [], note: null, newMove: null,
      payloadHash: "h", createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    expect((await call("DELETE", `/api/workouts/${saved}`)).body).toEqual({ error: "not_removable", reason: "done" });

    const sending = await made({ date: today, time: "23:00" });
    const built = await call("POST", `/api/sessions/${sending}/build`, {});
    const buildId = built.body.build.buildId as string;
    await db.update(schema.sessionBuilds).set({ lockedAt: nowInstant() }).where(eq(schema.sessionBuilds.id, buildId));
    await db.insert(corosWriteJobs).values({
      id: `push:${buildId}`, userId, workoutId: sending, kind: "program_session_push", expectedContentFingerprint: "fp",
      originalDate: today, destinationDate: today, requestedAt: nowInstant(), status: "claimed", updatedAt: nowInstant(),
    });
    expect((await call("DELETE", `/api/workouts/${sending}`)).body).toEqual({ error: "not_removable", reason: "sending" });

    await db.insert(plannedWorkouts).values({
      id: "slot-1", userId, planId: "prog-1", sourceWorkoutId: "slot-1", title: "Mobility", category: "yoga", sport: "yoga",
      originalPlanDate: addDays(today, 1), lastVerifiedCorosDate: "", effectiveDate: addDays(today, 1), effectiveTime: "07:00",
      sourceContentFingerprint: "program", calendarBlockDurationSeconds: 1800, origin: "program", contentState: "outline",
      createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    expect((await call("DELETE", "/api/workouts/slot-1")).body).toEqual({ error: "not_removable", reason: "not_studio" });

    const { userId: other } = await makeTestUser(db);
    const theirs = await (await clientFor(db, other))("POST", "/api/workouts", { date: addDays(today, 1), doc: calmDoc() });
    expect((await call("DELETE", `/api/workouts/${theirs.body.workout.id}`)).status).toBe(404);
    for (const id of [begun, done, saved, sending, "slot-1", theirs.body.workout.id]) {
      expect((await db.select().from(plannedWorkouts).where(and(eq(plannedWorkouts.id, id))))[0]!.archivedAt, id).toBeNull();
    }
  });
  it("a provisional copy on its way to the watch never stops it (`sending` is a day push's): a claimed one is left to the lane's claim", async () => {
    const id = await made({ date: addDays(today, 2) });
    const watchCtx = { today, now: nowInstant(), prefs: { ...prefs, corosWritesEnabled: true } };
    expect(await queueProvisionalPush(db, { ...calendarEnv(), WATCH_PUSH_ENABLED: "1" }, userId, await rowOf(id), watchCtx)).toBe("queued");
    const [push] = await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.workoutId, id));
    expect(push!.id).toMatch(/^push:/);
    await db.update(corosWriteJobs).set({ status: "claimed", claimedAt: nowInstant() }).where(eq(corosWriteJobs.id, push!.id));
    expect(await call("DELETE", `/api/workouts/${id}`)).toEqual({ status: 200, body: { ok: true } });
    expect((await rowOf(id)).archivedAt).not.toBeNull();
    // The lane's claim reads the row archived and supersedes it — or, landed, its verify queues the copy's delete.
    expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, push!.id)))[0]!.status).toBe("claimed");
  });
});

describe("the player's Discard of a workout started at once, nothing logged", () => {
  it("removes it — never planned, never missed; a planned workout's Discard keeps it, back to built", async () => {
    const now = await made({ date: today, time: "23:00", startNow: true });
    await started(now);
    const discarded = await call("POST", `/api/sessions/${now}/unstart`);
    expect(discarded.status).toBe(200);
    expect(discarded.body.removed).toBe(true);
    expect((await rowOf(now)).archivedAt).not.toBeNull();

    const planned = await made({ date: today, time: "23:30" });
    await started(planned);
    const kept = await call("POST", `/api/sessions/${planned}/unstart`);
    expect(kept.body.removed).toBeUndefined();
    expect(await rowOf(planned)).toMatchObject({ archivedAt: null, contentState: "built" });
  });

  it("closed without Discard: once its day has ended, one never started goes as Discard would; one started waits the outbox's reach — never asked about, never missed (B1)", async () => {
    // Pinned: 5 PM in the test athlete's zone (America/Los_Angeles, UTC-8 in November) on a Wednesday.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-19T01:00:00Z"));
      call = await clientFor(db, userId); // signed in at the pinned time
      const day = todayInZone(prefs.timezone);
      expect(day).toBe("2026-11-18");
      const begun = await made({ date: day, time: "17:00", startNow: true });
      await started(begun);
      // Its watch work, queued: cancelled with it, when it goes.
      await db.insert(corosWriteJobs).values({
        id: "push:abandoned", userId, workoutId: begun, kind: "program_session_push", expectedContentFingerprint: "fp",
        originalDate: day, destinationDate: day, requestedAt: nowInstant(), status: "queued", updatedAt: nowInstant(),
      });
      // Made, never built: left at once.
      const left = await made({ date: day, time: "17:05", startNow: true });
      // Logged: a session saved for it keeps it.
      const logged = await made({ date: day, time: "17:10", startNow: true });
      await started(logged);
      await db.insert(schema.performedSessions).values({
        id: "p-logged", userId, workoutId: logged, activityId: null, buildId: null, source: "app", sourceRef: null, localDate: day,
        startedAt: nowInstant(), endedAt: null, seconds: 600, plannedSeconds: 600, minutes: 10, mode: "consistent", theme: null, locationId: null,
        blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null, movesDone: [], note: null, newMove: null,
        payloadHash: "h", createdAt: nowInstant(), updatedAt: nowInstant(),
      });
      // Planned (Schedule), never done: asked about as ever.
      const planned = await made({ date: day, time: "21:00" });

      // 11:30 PM, the same day: its day has not ended.
      vi.setSystemTime(new Date("2026-11-19T07:30:00Z"));
      await reconcileCompletionStates(db, userId, prefs);
      for (const id of [begun, left, logged, planned]) expect((await rowOf(id)).archivedAt, id).toBeNull();

      // 12:30 AM the next day: the one never started is gone — by the sweep, not by the athlete.
      vi.setSystemTime(new Date("2026-11-19T08:30:00Z"));
      expect(await reconcileCompletionStates(db, userId, prefs)).toMatchObject({ abandonedRemoved: 1, markedUnresolved: 0 });
      expect((await rowOf(left)).archivedAt).not.toBeNull();
      expect((await rowOf(left)).archiveReason).toBe("abandoned_start_now");
      // The one started is kept: its review may still be open on the device, its save in the outbox (B1).
      expect((await rowOf(begun)).archivedAt).toBeNull();
      expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, "push:abandoned")))[0]!.status).toBe("queued");

      // Days on: the planned one needs attention; the started one is still kept.
      vi.setSystemTime(new Date("2026-11-22T20:00:00Z"));
      await reconcileCompletionStates(db, userId, prefs);
      expect((await rowOf(planned)).completionState).toBe("unresolved");
      vi.setSystemTime(new Date("2026-11-25T20:00:00Z"));
      await reconcileCompletionStates(db, userId, prefs);
      expect((await rowOf(begun)).archivedAt).toBeNull();
      // Past the outbox's reach (a week from its start), still with nothing logged: removed, its watch work with it.
      vi.setSystemTime(new Date("2026-11-26T02:00:00Z"));
      expect(await reconcileCompletionStates(db, userId, prefs)).toMatchObject({ abandonedRemoved: 1 });
      expect((await rowOf(begun)).archivedAt).not.toBeNull();
      expect((await rowOf(begun)).archiveReason).toBe("abandoned_start_now");
      expect((await db.select().from(corosWriteJobs).where(eq(corosWriteJobs.id, "push:abandoned")))[0]!.status).toBe("superseded");
      expect((await rowOf(logged)).archivedAt).toBeNull();
      expect((await rowOf(planned)).archivedAt).toBeNull();
      // The calendar's half, as Discard's: never booked again (it was booked on none).
      const barred = await db.select().from(schema.calendarEventSuppressions);
      expect(barred.filter((s) => s.reason === "user_removed").map((s) => s.workoutId).sort()).toEqual([begun, left].sort());

      // Then the planned one is missed; the Start-now ones never read as either.
      vi.setSystemTime(new Date("2026-11-27T20:00:00Z"));
      await reconcileCompletionStates(db, userId, prefs);
      expect((await rowOf(planned)).completionState).toBe("missed");
      for (const id of [begun, left, logged]) expect((await rowOf(id)).completionState, id).toBe("scheduled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a session the outbox delivers after the sweep: the workout comes back, done and matched — never slot_gone (B1)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // 9:16 AM, a Saturday in the athlete's zone: Start now, played to the end.
      vi.setSystemTime(new Date("2026-11-21T17:16:00Z"));
      call = await clientFor(db, userId);
      const day = todayInZone(prefs.timezone);
      expect(day).toBe("2026-11-21");
      const begun = await made({ date: day, time: "09:16", startNow: true });
      const built = await call("POST", `/api/sessions/${begun}/build`, {});
      expect(built.status).toBe(200);
      const buildId = built.body.build.buildId as string;
      expect((await call("POST", `/api/sessions/${begun}/start`, { buildId })).status).toBe(200);
      // Started on a device the server did not hear from (offline): the server holds it built, never started.
      const startedOffline = await made({ date: day, time: "09:20", startNow: true });
      expect((await call("POST", `/api/sessions/${startedOffline}/build`, {})).status).toBe(200);

      // The sweep: the one the server never saw started goes at the day's end; the started one once the week is out.
      vi.setSystemTime(new Date("2026-11-22T08:15:00Z"));
      await reconcileCompletionStates(db, userId, prefs);
      expect((await rowOf(startedOffline)).archivedAt).not.toBeNull();
      expect((await rowOf(begun)).archivedAt).toBeNull();
      vi.setSystemTime(new Date("2026-11-29T08:15:00Z"));
      await reconcileCompletionStates(db, userId, prefs);
      expect((await rowOf(begun)).archivedAt).not.toBeNull();

      // The review screen was left open; the saves arrive now.
      call = await clientFor(db, userId);
      for (const [workoutId, b] of [[begun, buildId], [startedOffline, null]] as const) {
        const saved = await call("PUT", `/api/sessions/performed/${workoutId}-p`, saveBody(`${workoutId}-p`, workoutId, b, day));
        expect(saved.body, workoutId).toMatchObject({ status: "saved", matched: true });
        expect(saved.body.notes, workoutId).not.toContain("slot_gone");
        expect(await rowOf(workoutId), workoutId).toMatchObject({
          archivedAt: null, archiveReason: null, completionState: "completed", contentState: "done", resolutionDate: day,
        });
        // Its suppression goes with the archive it explained.
        expect((await db.select().from(schema.calendarEventSuppressions).where(eq(schema.calendarEventSuppressions.workoutId, workoutId))).length).toBe(0);
        const [match] = await db.select().from(schema.workoutCompletionMatches).where(eq(schema.workoutCompletionMatches.workoutId, workoutId));
        expect(match).toMatchObject({ method: "app_session", undoneAt: null });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a session for a workout the athlete removed keeps today's answer: slot_gone, still removed (B1)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-21T17:16:00Z"));
      call = await clientFor(db, userId);
      const day = todayInZone(prefs.timezone);
      const now = await made({ date: day, time: "09:16", startNow: true });
      const built = await call("POST", `/api/sessions/${now}/build`, {});
      const buildId = built.body.build.buildId as string;
      expect((await call("POST", `/api/sessions/${now}/start`, { buildId })).status).toBe(200);
      // Discarded here; another device's save of it drains later (ruling 2b-R19).
      expect((await call("POST", `/api/sessions/${now}/unstart`)).body.removed).toBe(true);
      expect((await rowOf(now)).archiveReason).toBe("user_removed");
      vi.setSystemTime(new Date("2026-11-22T18:00:00Z"));
      call = await clientFor(db, userId);
      const saved = await call("PUT", `/api/sessions/performed/${now}-p`, saveBody(`${now}-p`, now, buildId, day));
      expect(saved.body).toMatchObject({ status: "saved", matched: false, notes: ["slot_gone"] });
      expect((await rowOf(now)).archivedAt).not.toBeNull();
      expect(await rowOf(now)).toMatchObject({ archiveReason: "user_removed", completionState: "scheduled" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("only what is still left with nothing logged goes: not one an activity answered, one marked done, a programme's, or one done while the pass ran", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-19T01:00:00Z"));
      call = await clientFor(db, userId); // signed in at the pinned time
      const day = todayInZone(prefs.timezone);
      const answered = await made({ date: day, time: "17:00", startNow: true });
      await db.update(plannedWorkouts).set({ completionState: "completed" }).where(eq(plannedWorkouts.id, answered));
      const marked = await made({ date: day, time: "17:05", startNow: true });
      await db.update(plannedWorkouts).set({ contentState: "done" }).where(eq(plannedWorkouts.id, marked));
      const theirs = await made({ date: day, time: "17:10", startNow: true });
      await db.update(plannedWorkouts).set({ origin: "program" }).where(eq(plannedWorkouts.id, theirs));
      const racing = await made({ date: day, time: "17:15", startNow: true });
      // The session is saved between the pass's read and its archive: the archive's own condition keeps the row.
      const sqlite = (db as unknown as { $client: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).$client;
      beforeStatement = (sql) => {
        if (!/^update "planned_workouts" set "archived_at"/.test(sql)) return;
        beforeStatement = null;
        sqlite.prepare(`update planned_workouts set content_state = 'done' where id = ?`).run(racing);
      };
      vi.setSystemTime(new Date("2026-11-19T08:30:00Z"));
      expect((await reconcileCompletionStates(db, userId, prefs)).abandonedRemoved).toBe(0);
      expect(beforeStatement).toBeNull();
      for (const id of [answered, marked, theirs, racing]) expect((await rowOf(id)).archivedAt, id).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("many at once: a pass removes a few, the next the rest — none is asked about meanwhile, rest mode or not", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-11-19T01:00:00Z"));
      call = await clientFor(db, userId); // signed in at the pinned time
      const day = todayInZone(prefs.timezone);
      expect(day).toBe("2026-11-18");
      const ids: string[] = [];
      for (const time of ["17:00", "17:05", "17:10", "17:15"]) ids.push(await made({ date: day, time, startNow: true }));
      // Days on (the hourly did not run): past the day the question would be asked.
      vi.setSystemTime(new Date("2026-11-22T20:00:00Z"));
      const gone = async () => (await Promise.all(ids.map(rowOf))).filter((r) => r.archivedAt !== null).length;
      await reconcileCompletionStates(db, userId, prefs);
      expect(await gone()).toBe(2);
      // The two still here wait for the next pass, never asked about.
      for (const id of ids) expect((await rowOf(id)).completionState, id).toBe("scheduled");
      // Rest mode pauses the missed pipeline, not this: the next pass takes the rest.
      await reconcileCompletionStates(db, userId, { ...prefs, gardenRestMode: true, gardenRestModeUntil: null });
      expect(await gone()).toBe(4);
      for (const id of ids) expect((await rowOf(id)).completionState, id).toBe("scheduled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a session saved for it: Discard is refused as before, and it stays", async () => {
    const now = await made({ date: today, time: "23:00", startNow: true });
    await started(now);
    await db.insert(schema.performedSessions).values({
      id: "p2", userId, workoutId: now, activityId: null, buildId: null, source: "app", sourceRef: null, localDate: today,
      startedAt: nowInstant(), endedAt: null, seconds: 600, plannedSeconds: 600, minutes: 10, mode: "consistent", theme: null, locationId: null,
      blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null, movesDone: [], note: null, newMove: null,
      payloadHash: "h", createdAt: nowInstant(), updatedAt: nowInstant(),
    });
    expect((await call("POST", `/api/sessions/${now}/unstart`)).status).toBe(409);
    expect((await rowOf(now)).archivedAt).toBeNull();
  });
});
