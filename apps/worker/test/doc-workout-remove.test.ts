/**
 * Quick starts are not plan obligations (CUJ red-team R6, the lead's rulings): Start now books no calendar event — only
 * Schedule does; a Studio workout never started can be removed (`DELETE /api/workouts/:id`), its calendar event and its
 * unsent watch work with it; and a workout started at once and abandoned with nothing logged goes when the player
 * discards it. A removed workout is gone: nothing reads it as missed. Synthetic data only.
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

beforeEach(async () => {
  db = makeTestDb({ boundVariableCap: 100 });
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
