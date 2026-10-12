/**
 * MAKING AND REVISING A DOCUMENT WORKOUT ANSWER WITHIN ONE FREE-PLAN INVOCATION (Stage 2 spec §10; ruling 3-R11).
 *
 * Measured the way coach-approve-budget.test.ts measures an approve: every D1 statement and every fetch the request
 * costs, its waitUntil work included — here the calendar's one bounded sync step — against a Google Calendar that is
 * connected and settled, with a history and a busy week on the account. Synthetic fixtures only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema } from "@rg/database";
import { addDays, newId, nowInstant, todayInZone, type UserPreferences } from "@rg/domain";
import type { Env } from "../src/env.js";
import type { Db } from "../src/services/db.js";
import { createSession, SESSION_COOKIE } from "../src/auth/sessions.js";
import { encryptSecret } from "../src/auth/crypto.js";
import { workoutRoutes } from "../src/routes/workouts.js";
import { loadPreferences, savePreferences, syncCalendar } from "../src/services/calendar-sync.js";
import { makeTestDb, makeTestUser, mountRoutes } from "./helpers.js";
import { activateTmj, calmDoc, landingsDoc } from "./doc-workout-fixture.js";

const BUDGET = 45;
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function makeEnv(): Env {
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

/** Google Calendar's events endpoint, just enough for a settled mirror: list, insert, patch, delete. */
function fakeGoogle() {
  let n = 0;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  return async (url: URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const m = url.pathname.match(/\/calendars\/[^/]+\/events(?:\/([^/]+))?$/);
    if (!m) return json({}, 404);
    const id = m[1] ? decodeURIComponent(m[1]) : undefined;
    if (method === "GET") return json({ items: [], nextSyncToken: String(n) });
    if (method === "POST") return json({ id: `ev${++n}` });
    if (id && method === "PATCH") return json({ id });
    if (id && method === "DELETE") return new Response(null, { status: 204 });
    return json({}, 400);
  };
}

let db: Db;
let userId: string;
let prefs: UserPreferences;
let today: string;
let statements = 0;
let fetches = 0;

beforeEach(async () => {
  statements = 0;
  db = makeTestDb({ boundVariableCap: 100, onStatement: () => (statements += 1) });
  ({ userId } = await makeTestUser(db));
  await savePreferences(db, userId, { ...(await loadPreferences(db, userId)), calendarId: "cal" });
  prefs = await loadPreferences(db, userId);
  today = todayInZone(prefs.timezone);
  await db.insert(schema.providerConnections).values({
    id: newId(),
    userId,
    provider: "google_calendar",
    status: "connected",
    encryptedRefreshToken: await encryptSecret("refresh", TEST_KEY),
    encryptedAccessToken: await encryptSecret("access", TEST_KEY),
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    createdAt: nowInstant(),
    updatedAt: nowInstant(),
  });
  const google = fakeGoogle();
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    fetches += 1;
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "www.googleapis.com") return google(url, init);
    return new Response("{}", { status: 404 });
  }) as typeof fetch);
  await activateTmj(db, userId);
  await busyAccount();
  // The mirror is settled before the request.
  await syncCalendar(db, makeEnv(), userId);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fortnight of planned sessions (two a day on some days) and a month of logged ones. */
async function busyAccount(): Promise<void> {
  for (let i = 0; i < 14; i++) {
    const date = addDays(today, i);
    for (const slot of i % 3 === 0 ? ["07:00", "18:00"] : ["07:00"]) {
      const id = `w-${i}-${slot}`;
      await db.insert(schema.plannedWorkouts).values({
        id, userId, planId: "plan-1", sourceWorkoutId: id, title: "Easy run", category: "easy", sport: "run",
        originalPlanDate: date, lastVerifiedCorosDate: "", effectiveDate: date, effectiveTime: slot,
        sourceContentFingerprint: "fp", calendarBlockDurationSeconds: 1800, fallbackEstimatedDurationSeconds: 1800,
        createdAt: nowInstant(), updatedAt: nowInstant(),
      });
    }
  }
  for (let i = 1; i <= 30; i++) {
    const id = `p-${i}`;
    const date = addDays(today, -i);
    const at = `${date}T17:00:00.000Z`;
    await db.insert(schema.performedSessions).values({
      id, userId, workoutId: null, activityId: null, buildId: null, source: "app", sourceRef: null, localDate: date,
      startedAt: at, endedAt: null, seconds: 1200, plannedSeconds: 1200, minutes: 20, mode: "consistent", theme: null,
      locationId: null, blockRef: null, blockNumber: null, completed: true, stepsTotal: null, stepsDone: null,
      movesDone: [], note: null, newMove: null, payloadHash: "h", createdAt: at, updatedAt: at,
    });
    await db.insert(schema.performedSets).values({
      id: `${id}-s0`, performedSessionId: id, entryIndex: 0, exerciseId: i % 2 ? "bwSplitSquat" : "snapDown", implement: null,
      format: "straight", perSide: false, setIndex: 0, side: null, reps: 5, seconds: null, loadValue: null, loadUnit: null,
      loadKg: null, done: true, flags: i % 4 ? [] : ["clenched"],
    });
  }
}

/** One request, its waitUntil work included: status, JSON and the D1 statements + fetches it cost. */
async function invoke(method: string, path: string, body: unknown) {
  const app = mountRoutes(db, "/api/workouts", workoutRoutes);
  const cookie = `${SESSION_COOKIE}=${await createSession(db, userId)}`;
  const pending: Promise<unknown>[] = [];
  const executionCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => undefined, props: {} };
  statements = 0;
  fetches = 0;
  const res = await app.request(
    path,
    { method, headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) },
    makeEnv(),
    executionCtx as never,
  );
  const waited = pending.length;
  await Promise.all(pending);
  return { status: res.status, json: (await res.json()) as Record<string, any>, total: statements + fetches, waited };
}

describe("document workouts within one invocation (≤ 45 D1 statements + fetches, the calendar's step included)", () => {
  it("POST /api/workouts on a busy day, with a calendar to book", async () => {
    await (await import("./doc-workout-fixture.js")).clientFor(db, userId).then((call) =>
      call("POST", "/api/conditions/checks", { profileId: "tmj", value: 1, feelingOff: false }),
    );
    const res = await invoke("POST", "/api/workouts", { date: today, doc: landingsDoc() });
    expect(res.status).toBe(201);
    expect(res.waited).toBe(1);
    expect(res.total).toBeLessThanOrEqual(BUDGET);
  });

  it("PUT /api/workouts/:id/doc, renamed (the calendar follows)", async () => {
    const created = await invoke("POST", "/api/workouts", { date: addDays(today, 3), doc: calmDoc() });
    expect(created.status).toBe(201);
    await syncCalendar(db, makeEnv(), userId);
    const res = await invoke("PUT", `/api/workouts/${created.json.workout.id}/doc`, { doc: calmDoc({ title: "Renamed" }), baseRev: 1 });
    expect(res.status).toBe(200);
    expect(res.waited).toBe(1);
    expect(res.total).toBeLessThanOrEqual(BUDGET);
  });
});
